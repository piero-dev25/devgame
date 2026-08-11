/**
 * Reads a Unity project's `Packages/packages-lock.json` — the AUTHORITATIVE
 * "is a package installed" source for `UnitySetupProbe.ts`, per
 * docs/workbench/plan-setup-integration.md §1's F1 fix. `manifest.json`
 * holds only direct, non-embedded dependencies; `packages-lock.json`'s
 * `dependencies` map carries every RESOLVED package regardless of how it
 * got there — including embedded/vendored packages that never appear in
 * `manifest.json` at all. In the owner's real `Mafia Game` project, 14 of
 * 59 resolved packages are absent from `manifest.json`, including a
 * depth-0 EMBEDDED package (`com.elringus.naninovel`,
 * `{"version": "file:com.elringus.naninovel", "depth": 0, "source":
 * "embedded"}`). For the embedded case specifically, the lock entry's own
 * presence is already sufficient proof of installation — UPM only writes
 * an embedded lock entry once the directory is actually resolved, so no
 * separate directory stat is needed beyond confirming the entry exists.
 *
 * `manifest.json` is read too (`readManifestDependencyIds` below), but
 * only for §3's future consent-prompt honesty (declared intent — "this
 * project's manifest names these packages directly"), never as the
 * installed-check this module exists to replace.
 */
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

const PACKAGES_LOCK_RELATIVE_PATH = "Packages/packages-lock.json";
const MANIFEST_RELATIVE_PATH = "Packages/manifest.json";

// Mirrors EngineTypeResolver.ts's own cache (same capacity/TTL, same
// reasoning): this probe is meant to run on demand (panel open, Play
// click, explicit refresh — plan §1's own cadence table), not on every
// keystroke, but a user opening the settings panel and immediately hitting
// refresh a few times should not re-read and re-parse the same file
// repeatedly within that short window.
const DEFAULT_LOCK_CACHE_CAPACITY = 512;
const DEFAULT_LOCK_CACHE_TTL = Duration.minutes(1);

export interface UnityPackagesLockEntry {
  readonly version: string | null;
  readonly depth: number | null;
  readonly source: string | null;
}

export type UnityPackagesLockDependencies = ReadonlyMap<string, UnityPackagesLockEntry>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `null` on anything that doesn't parse as JSON, or doesn't have a
 * `dependencies` object at the top level — degrades to "no packages
 * resolved," the SAFE direction for an installed-check: a project this
 * probe can't read never gets falsely reported as having a package it
 * might not. Per-entry fields are read permissively (each defaults to
 * `null` if missing or the wrong type) since only the KEY's presence in
 * the map is load-bearing for `installed`; the fields themselves are
 * reporting-only (increment 3's per-item panel). */
function parsePackagesLock(raw: string): UnityPackagesLockDependencies | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.dependencies)) return null;
  const dependencies = new Map<string, UnityPackagesLockEntry>();
  for (const [packageId, value] of Object.entries(parsed.dependencies)) {
    if (!isRecord(value)) {
      dependencies.set(packageId, { version: null, depth: null, source: null });
      continue;
    }
    dependencies.set(packageId, {
      version: typeof value.version === "string" ? value.version : null,
      depth: typeof value.depth === "number" ? value.depth : null,
      source: typeof value.source === "string" ? value.source : null,
    });
  }
  return dependencies;
}

/** `null` on anything unparseable — same degrade-safe posture as
 * `parsePackagesLock`. Reads BOTH `dependencies` and `devDependencies`
 * (declared-intent reporting only, so being permissive here costs
 * nothing — this is never the installed-check). */
function parseManifestDependencyIds(raw: string): ReadonlySet<string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const ids = new Set<string>();
  for (const key of ["dependencies", "devDependencies"] as const) {
    if (isRecord(parsed[key])) {
      for (const packageId of Object.keys(parsed[key])) ids.add(packageId);
    }
  }
  return ids;
}

function optionOnNotFound<A>(
  effect: Effect.Effect<A, PlatformError.PlatformError>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError> {
  return effect.pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );
}

export class UnityPackageLock extends Context.Service<
  UnityPackageLock,
  {
    /** The authoritative installed-check — see module doc above. An
     * unreadable or missing lock file (including "this isn't a Unity
     * project at all") returns an EMPTY map, not a failure: every caller
     * of this module treats "can't tell" and "genuinely not installed"
     * identically, matching `EngineTypeResolver`'s own best-effort
     * degrade-to-null posture for the same class of I/O problem. */
    readonly readDependencies: (
      workspaceRoot: string,
    ) => Effect.Effect<UnityPackagesLockDependencies>;
    /** Declared-intent only (manifest.json) — see module doc. Never used
     * as an installed-check by this module's own callers. */
    readonly readManifestDependencyIds: (
      workspaceRoot: string,
    ) => Effect.Effect<ReadonlySet<string>>;
  }
>()("t3/unity/UnityPackageLock") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const readDependenciesUncached = Effect.fn("UnityPackageLock.readDependenciesUncached")(
    function* (workspaceRoot: string): Effect.fn.Return<UnityPackagesLockDependencies> {
      const lockPath = path.join(workspaceRoot, PACKAGES_LOCK_RELATIVE_PATH);
      const raw = yield* optionOnNotFound(fileSystem.readFileString(lockPath)).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to read packages-lock.json", { workspaceRoot, cause }).pipe(
            Effect.as(Option.none<string>()),
          ),
        ),
      );
      if (Option.isNone(raw)) return new Map();
      const parsed = parsePackagesLock(raw.value);
      return parsed ?? new Map();
    },
  );

  const dependenciesCache = yield* Cache.makeWith<string, UnityPackagesLockDependencies>(
    readDependenciesUncached,
    {
      capacity: DEFAULT_LOCK_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: () => DEFAULT_LOCK_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );

  const readManifestDependencyIds: UnityPackageLock["Service"]["readManifestDependencyIds"] =
    Effect.fn("UnityPackageLock.readManifestDependencyIds")(function* (workspaceRoot: string) {
      const manifestPath = path.join(workspaceRoot, MANIFEST_RELATIVE_PATH);
      const raw = yield* optionOnNotFound(fileSystem.readFileString(manifestPath)).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to read manifest.json", { workspaceRoot, cause }).pipe(
            Effect.as(Option.none<string>()),
          ),
        ),
      );
      if (Option.isNone(raw)) return new Set();
      return parseManifestDependencyIds(raw.value) ?? new Set();
    });

  return UnityPackageLock.of({
    readDependencies: (workspaceRoot) => Cache.get(dependenciesCache, workspaceRoot),
    readManifestDependencyIds,
  });
});

export const layer = Layer.effect(UnityPackageLock, make);
