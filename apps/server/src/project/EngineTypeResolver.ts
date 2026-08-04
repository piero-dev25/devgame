/**
 * EngineTypeResolver - Effect service contract for game engine detection.
 *
 * Resolves which game engine (if any) owns a workspace root by checking a
 * small set of engine-specific marker files/paths. Detection always runs
 * LIVE on demand and is never persisted: a few file checks are cheap, and
 * storing the result would require a migration plus touching the event
 * schema, decider, projector, and client contract, then go stale the moment
 * someone adds an engine to (or removes one from) an existing project
 * folder.
 *
 * Detection is best-effort, like T3ProjectFileLoader: a missing workspace
 * root, an unreadable candidate file, or a directory listing failure never
 * fails the caller — the affected check is logged as a warning and treated
 * as "not this engine," so the worst outcome is `null` (unknown engine)
 * rather than a failed effect.
 *
 * @module EngineTypeResolver
 */
import type { EngineType } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

// Marker paths checked to identify each engine, relative to the workspace
// root.
const GODOT_PROJECT_FILE = "project.godot";
const UNITY_PROJECT_VERSION_FILE = "ProjectSettings/ProjectVersion.txt";
const UNREAL_PROJECT_FILE_EXTENSION = ".uproject";
const PACKAGE_JSON_FILE = "package.json";
const THREE_JS_PACKAGE_NAME = "three";

// Mirrors RepositoryIdentityResolver's cache (same capacity/TTL). Detection
// is resolved on every project-snapshot read, which is polled on
// websocket-driven UI refresh — an uncached resolver turns every redraw into
// 2-4 raw filesystem syscalls per unique workspace root, forever, and worse
// on a network-mounted workspace.
const DEFAULT_ENGINE_TYPE_CACHE_CAPACITY = 512;
const DEFAULT_ENGINE_TYPE_CACHE_TTL = Duration.minutes(1);

export class EngineTypeDetectionError extends Schema.TaggedErrorClass<EngineTypeDetectionError>()(
  "EngineTypeDetectionError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "resolve-path",
      "stat-candidate",
      "read-directory",
      "read-source",
    ]),
    workspaceRoot: Schema.String,
    relativePath: Schema.optional(Schema.String),
    absolutePath: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to detect project engine type during ${this.operation} for workspace ${this.workspaceRoot}.`;
  }
}

/** Service tag for live game-engine detection. */
export class EngineTypeResolver extends Context.Service<
  EngineTypeResolver,
  {
    /**
     * Detect the game engine that owns the given workspace root.
     *
     * Returns `null` when no known engine marker is found. Never fails: I/O
     * problems degrade to `null` after being logged as a warning. Results
     * are cached (see DEFAULT_ENGINE_TYPE_CACHE_TTL).
     */
    readonly detect: (cwd: string) => Effect.Effect<EngineType | null>;
  }
>()("t3/project/EngineTypeResolver") {}

const logEngineTypeDetectionError = (error: EngineTypeDetectionError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      ...(error.relativePath !== undefined ? { relativePath: error.relativePath } : {}),
      errorTag: error._tag,
    }),
  );

const optionOnNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );

function hasDependency(dependencies: unknown, packageName: string): boolean {
  return typeof dependencies === "object" && dependencies !== null && packageName in dependencies;
}

// Invalid JSON (e.g. a package.json mid-edit) is treated the same as "no
// engine detected" rather than an error, mirroring T3ProjectFileLoader's
// best-effort handling of invalid project files.
function packageJsonDependsOn(raw: string, packageName: string): boolean {
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof manifest !== "object" || manifest === null) {
    return false;
  }
  const record = manifest as Record<string, unknown>;
  return (
    hasDependency(record["dependencies"], packageName) ||
    hasDependency(record["devDependencies"], packageName)
  );
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

  const fileExists = Effect.fn("EngineTypeResolver.fileExists")(function* (
    projectCwd: string,
    relativePath: string,
  ): Effect.fn.Return<boolean> {
    const resolved = yield* workspacePaths
      .resolveRelativePathWithinRoot({ workspaceRoot: projectCwd, relativePath })
      .pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          WorkspacePathOutsideRootError: () =>
            Effect.succeed(
              Option.none<{ readonly absolutePath: string; readonly relativePath: string }>(),
            ),
        }),
      );
    if (Option.isNone(resolved)) {
      return false;
    }
    const stats = yield* optionOnNotFound(fileSystem.stat(resolved.value.absolutePath)).pipe(
      Effect.catch((cause) =>
        logEngineTypeDetectionError(
          new EngineTypeDetectionError({
            operation: "stat-candidate",
            workspaceRoot: projectCwd,
            relativePath,
            absolutePath: resolved.value.absolutePath,
            cause,
          }),
        ).pipe(Effect.as(Option.none<FileSystem.File.Info>())),
      ),
    );
    return Option.isSome(stats) && stats.value.type === "File";
  });

  const hasUnrealProjectFile = Effect.fn("EngineTypeResolver.hasUnrealProjectFile")(function* (
    projectCwd: string,
  ): Effect.fn.Return<boolean> {
    const entries = yield* optionOnNotFound(fileSystem.readDirectory(projectCwd)).pipe(
      Effect.catch((cause) =>
        logEngineTypeDetectionError(
          new EngineTypeDetectionError({
            operation: "read-directory",
            workspaceRoot: projectCwd,
            absolutePath: projectCwd,
            cause,
          }),
        ).pipe(Effect.as(Option.none<ReadonlyArray<string>>())),
      ),
    );
    if (Option.isNone(entries)) {
      return false;
    }
    // A directory listing gives bare entry names, so a "*.uproject" entry
    // could itself be a directory (pathological, but Unreal never rules it
    // out). Reuse fileExists's stat check rather than trusting the name
    // alone — same rigor as every other marker check in this file.
    const candidateNames = entries.value.filter((entry) =>
      entry.endsWith(UNREAL_PROJECT_FILE_EXTENSION),
    );
    for (const candidateName of candidateNames) {
      if (yield* fileExists(projectCwd, candidateName)) {
        return true;
      }
    }
    return false;
  });

  const hasThreeJsDependency = Effect.fn("EngineTypeResolver.hasThreeJsDependency")(function* (
    projectCwd: string,
  ): Effect.fn.Return<boolean> {
    const packageJsonPath = path.join(projectCwd, PACKAGE_JSON_FILE);
    const raw = yield* optionOnNotFound(fileSystem.readFileString(packageJsonPath)).pipe(
      Effect.catch((cause) =>
        logEngineTypeDetectionError(
          new EngineTypeDetectionError({
            operation: "read-source",
            workspaceRoot: projectCwd,
            relativePath: PACKAGE_JSON_FILE,
            absolutePath: packageJsonPath,
            cause,
          }),
        ).pipe(Effect.as(Option.none<string>())),
      ),
    );
    if (Option.isNone(raw)) {
      return false;
    }
    return packageJsonDependsOn(raw.value, THREE_JS_PACKAGE_NAME);
  });

  const detectUncached = Effect.fn("EngineTypeResolver.detectUncached")(function* (
    cwd: string,
  ): Effect.fn.Return<EngineType | null> {
    const normalized = yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.map(Option.some),
      Effect.catch((cause) =>
        logEngineTypeDetectionError(
          new EngineTypeDetectionError({
            operation: "normalize-workspace",
            workspaceRoot: cwd,
            cause,
          }),
        ).pipe(Effect.as(Option.none<string>())),
      ),
    );
    if (Option.isNone(normalized)) {
      return null;
    }
    const projectCwd = normalized.value;

    // PRIORITY ORDER — do not turn this into a first-match loop over an
    // unordered candidate list. A project can trip more than one marker at
    // once (a Unity project commonly ships a package.json for editor
    // tooling, CI scripts, or a companion web build). Native-engine
    // project descriptors are authoritative: `project.godot`,
    // ProjectVersion.txt, and `*.uproject` are files a game engine itself
    // generates specifically to mark project ownership. A `package.json`
    // listing `three` only means *some* directory in the tree depends on
    // the three.js library — that says nothing about project ownership,
    // since Unity/Unreal/Godot projects routinely carry a package.json for
    // asset pipelines, editor plugins, or CI scripts. So every
    // native-engine check must run, and win, before the three.js
    // heuristic is even consulted. Within the native-engine checks, Godot
    // / Unity / Unreal are mutually exclusive by construction (no engine
    // writes another engine's marker file), so their relative order
    // doesn't matter in practice — kept in the order the product brief
    // listed them for readability.
    if (yield* fileExists(projectCwd, GODOT_PROJECT_FILE)) {
      return "godot";
    }
    if (yield* fileExists(projectCwd, UNITY_PROJECT_VERSION_FILE)) {
      return "unity";
    }
    if (yield* hasUnrealProjectFile(projectCwd)) {
      return "unreal";
    }
    if (yield* hasThreeJsDependency(projectCwd)) {
      return "threejs";
    }
    return null;
  });

  const engineTypeCache = yield* Cache.makeWith<string, EngineType | null>(detectUncached, {
    capacity: DEFAULT_ENGINE_TYPE_CACHE_CAPACITY,
    timeToLive: Exit.match({
      onSuccess: () => DEFAULT_ENGINE_TYPE_CACHE_TTL,
      onFailure: () => Duration.zero,
    }),
  });

  const detect: EngineTypeResolver["Service"]["detect"] = Effect.fn("EngineTypeResolver.detect")(
    function* (cwd) {
      return yield* Cache.get(engineTypeCache, cwd);
    },
  );

  return EngineTypeResolver.of({ detect });
});

export const layer = Layer.effect(EngineTypeResolver, make);
