/**
 * ProjectWorkspace - Effect service that reads a project's Mr. Mak-compatible
 * workspace registry (`workspace/workspace.json`).
 *
 * READ-ONLY. Nothing here writes to the project. Later writers must not
 * rewrite the registry by re-encoding the decoded schema: unknown keys are
 * dropped on decode and would be lost.
 *
 * Every read is rooted at the given project root. The registry file goes
 * through `WorkspaceFileSystem.readFile` (traversal, symlink containment,
 * non-file, binary and 1 MiB checks). Each step is checked lexically and by
 * realpath against `<root>/workspace`, and is only stat'ed, never opened.
 *
 * @module ProjectWorkspace
 */
import {
  PROJECT_WORKSPACE_DIRECTORY,
  PROJECT_WORKSPACE_MANIFEST_PATH,
  WorkspaceManifest,
  type ResolvedWorkspaceEntity,
  type ResolvedWorkspaceManifest,
  type ResolvedWorkspaceStep,
  type WorkspaceEntity,
  type WorkspaceManifestIssue,
  type WorkspaceStepIssue,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const decodeManifestJson = Schema.decodeUnknownEffect(fromLenientJson(WorkspaceManifest));

export class ProjectWorkspaceManifestError extends Schema.TaggedError<ProjectWorkspaceManifestError>()(
  "ProjectWorkspaceManifestError",
  {
    reason: Schema.Literals(["malformed", "truncated", "escape", "read"]),
    workspaceRoot: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "malformed":
        return `${PROJECT_WORKSPACE_MANIFEST_PATH} is not a valid workspace registry: ${this.detail}`;
      case "truncated":
        return `${PROJECT_WORKSPACE_MANIFEST_PATH} is larger than 1 MiB and was not read.`;
      case "escape":
        return `${PROJECT_WORKSPACE_MANIFEST_PATH} resolves outside the project root.`;
      case "read":
        return `Could not read ${PROJECT_WORKSPACE_MANIFEST_PATH}: ${this.detail}`;
    }
  }
}

export type ProjectWorkspaceReadResult =
  | { readonly _tag: "missing" }
  | { readonly _tag: "ok"; readonly manifest: ResolvedWorkspaceManifest };

/** Service tag for reading a project's workspace registry. */
export class ProjectWorkspace extends Context.Service<
  ProjectWorkspace,
  {
    /**
     * Read and validate `<workspaceRoot>/workspace/workspace.json`.
     *
     * A missing registry is `missing`, not an error. A project root that does
     * not exist or is not a directory fails with reason `read`. Bad paths and
     * missing step files are reported per step and in `issues`; they do not
     * fail the read.
     */
    readonly readManifest: (
      workspaceRoot: string,
    ) => Effect.Effect<ProjectWorkspaceReadResult, ProjectWorkspaceManifestError>;
  }
>()("t3/projectWorkspace/ProjectWorkspace") {}

const errnoCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

/** Only "no such entry" means missing; loops, permissions and bad paths are unreadable. */
const classifyStepFailure = (error: PlatformError.PlatformError) => {
  const code = errnoCode(error.reason.cause);
  return code === "ENOENT" || code === "ENOTDIR" ? ("missing" as const) : ("unreadable" as const);
};

const stepIssue = (issue: WorkspaceStepIssue, stepPath: string) => {
  switch (issue) {
    case "escape":
      return {
        kind: "step-escape" as const,
        message: `Step "${stepPath}" resolves outside ${PROJECT_WORKSPACE_DIRECTORY}/.`,
      };
    case "missing":
      return { kind: "step-missing" as const, message: `Step "${stepPath}" does not exist.` };
    case "not-file":
      return { kind: "step-not-file" as const, message: `Step "${stepPath}" is not a file.` };
    case "unreadable":
      return {
        kind: "step-unreadable" as const,
        message: `Step "${stepPath}" could not be checked (symlink loop, permissions or invalid path).`,
      };
  }
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;

  const readRegistryText = (workspaceRoot: string) =>
    workspaceFileSystem
      // Always the literal relative path: an absolute path would skip the root check.
      .readFile({ cwd: workspaceRoot, relativePath: PROJECT_WORKSPACE_MANIFEST_PATH })
      .pipe(
        Effect.catchTags({
          WorkspaceFileSystemOperationError: (error) => {
            const code = errnoCode(error.cause);
            return error.operation === "realpath-target" &&
              (code === "ENOENT" || code === "ENOTDIR")
              ? Effect.succeed(null)
              : Effect.fail(
                  new ProjectWorkspaceManifestError({
                    reason: "read",
                    workspaceRoot,
                    detail: code ?? error.operation,
                  }),
                );
          },
          WorkspaceFilePathEscapeError: () =>
            Effect.fail(
              new ProjectWorkspaceManifestError({ reason: "escape", workspaceRoot, detail: "" }),
            ),
          WorkspacePathOutsideRootError: () =>
            Effect.fail(
              new ProjectWorkspaceManifestError({ reason: "escape", workspaceRoot, detail: "" }),
            ),
          WorkspacePathNotFileError: () =>
            Effect.fail(
              new ProjectWorkspaceManifestError({
                reason: "malformed",
                workspaceRoot,
                detail: "not a regular file",
              }),
            ),
          WorkspaceBinaryFileError: () =>
            Effect.fail(
              new ProjectWorkspaceManifestError({
                reason: "malformed",
                workspaceRoot,
                detail: "binary content",
              }),
            ),
        }),
      );

  const isOutside = (realRoot: string, realTarget: string) => {
    const relative = path.relative(realRoot, realTarget);
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  };

  const resolveStep = Effect.fn("ProjectWorkspace.resolveStep")(function* (input: {
    workspaceRoot: string;
    realWorkspaceDirectory: string;
    folder: string;
    stepPath: string;
  }) {
    const escaped = { relativePath: null, exists: false, issue: "escape" as const };
    if (path.isAbsolute(input.stepPath.trim())) return escaped;

    const workspaceDirectory = path.join(input.workspaceRoot, PROJECT_WORKSPACE_DIRECTORY);
    const lexical = yield* workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: workspaceDirectory,
        relativePath: `${input.folder.trim()}/${input.stepPath.trim()}`,
      })
      .pipe(Effect.option);
    if (lexical._tag === "None") return escaped;

    const relativePath = `${PROJECT_WORKSPACE_DIRECTORY}/${lexical.value.relativePath}`;
    const realTarget = yield* fileSystem.realPath(lexical.value.absolutePath).pipe(Effect.result);
    if (realTarget._tag === "Failure") {
      return { relativePath, exists: false, issue: classifyStepFailure(realTarget.failure) };
    }
    // Symlinks must stay inside workspace/, not just the project root (which can hold .env files).
    if (isOutside(input.realWorkspaceDirectory, realTarget.success)) return escaped;

    const stat = yield* fileSystem.stat(realTarget.success).pipe(Effect.result);
    if (stat._tag === "Failure") {
      return { relativePath, exists: false, issue: classifyStepFailure(stat.failure) };
    }
    if (stat.success.type !== "File") {
      return { relativePath, exists: false, issue: "not-file" as const };
    }
    return { relativePath, exists: true };
  });

  /** A folder must name a directory strictly inside `workspace/`. */
  const isFolderEscape = (folder: string) => {
    const trimmed = folder.trim();
    if (trimmed.length === 0 || path.isAbsolute(trimmed)) return true;
    const relative = path.relative(".", path.join(".", trimmed));
    return relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`);
  };

  /** Fields the registry decodes but that no card can use as written. */
  const fieldIssues = (entity: WorkspaceEntity): Array<WorkspaceManifestIssue> => {
    const issues: Array<WorkspaceManifestIssue> = [];
    if (entity.id.trim().length === 0) {
      issues.push({ kind: "empty-id", entityId: entity.id, message: "An entity has an empty id." });
    }
    if (entity.title.trim().length === 0) {
      issues.push({
        kind: "empty-title",
        entityId: entity.id,
        message: `Entity "${entity.id}" has an empty title.`,
      });
    }
    const { defaultStep } = entity;
    if (
      defaultStep !== undefined &&
      !(Number.isInteger(defaultStep) && defaultStep >= 0 && defaultStep < entity.steps.length)
    ) {
      issues.push({
        kind: "default-step-out-of-range",
        entityId: entity.id,
        message: `Entity "${entity.id}" has defaultStep ${defaultStep} but ${entity.steps.length} step(s).`,
      });
    }
    return issues;
  };

  const resolveEntity = Effect.fn("ProjectWorkspace.resolveEntity")(function* (
    entity: WorkspaceEntity,
    context: { workspaceRoot: string; realWorkspaceDirectory: string },
    issues: Array<WorkspaceManifestIssue>,
  ) {
    issues.push(...fieldIssues(entity));
    const folderEscapes = isFolderEscape(entity.folder);
    if (folderEscapes) {
      issues.push({
        kind: "folder-escape",
        entityId: entity.id,
        message: `Folder "${entity.folder}" is not inside ${PROJECT_WORKSPACE_DIRECTORY}/.`,
      });
    }
    const steps: Array<ResolvedWorkspaceStep> = [];
    for (const [stepIndex, step] of entity.steps.entries()) {
      const resolved = folderEscapes
        ? { relativePath: null, exists: false, issue: "escape" as const }
        : yield* resolveStep({ ...context, folder: entity.folder, stepPath: step.path });
      steps.push({ ...step, ...resolved });
      if (folderEscapes || resolved.issue === undefined) continue;
      issues.push({ ...stepIssue(resolved.issue, step.path), entityId: entity.id, stepIndex });
    }
    return { ...entity, steps } satisfies ResolvedWorkspaceEntity;
  });

  const readManifest: ProjectWorkspace["Service"]["readManifest"] = Effect.fn(
    "ProjectWorkspace.readManifest",
  )(function* (workspaceRoot) {
    // A root that is missing or not a directory is a broken project, not "no registry".
    const rootStat = yield* fileSystem.stat(workspaceRoot).pipe(
      Effect.mapError(
        (error) =>
          new ProjectWorkspaceManifestError({
            reason: "read",
            workspaceRoot,
            detail: errnoCode(error.reason.cause) ?? error.message,
          }),
      ),
    );
    if (rootStat.type !== "Directory") {
      return yield* new ProjectWorkspaceManifestError({
        reason: "read",
        workspaceRoot,
        detail: "project root is not a directory",
      });
    }

    const file = yield* readRegistryText(workspaceRoot);
    if (file === null) return { _tag: "missing" as const };
    if (file.truncated) {
      return yield* new ProjectWorkspaceManifestError({
        reason: "truncated",
        workspaceRoot,
        detail: `${file.byteLength} bytes`,
      });
    }
    const manifest = yield* decodeManifestJson(file.contents).pipe(
      Effect.mapError(
        (error) =>
          new ProjectWorkspaceManifestError({
            reason: "malformed",
            workspaceRoot,
            detail: error.message,
          }),
      ),
    );

    // readFile already resolved both paths, so these only fail on a race.
    const realPathOrFail = (target: string) =>
      fileSystem
        .realPath(target)
        .pipe(
          Effect.mapError(
            (error) =>
              new ProjectWorkspaceManifestError({
                reason: "read",
                workspaceRoot,
                detail: error.message,
              }),
          ),
        );
    const realWorkspaceRoot = yield* realPathOrFail(workspaceRoot);
    const realWorkspaceDirectory = yield* realPathOrFail(
      path.join(workspaceRoot, PROJECT_WORKSPACE_DIRECTORY),
    );
    // The registry can resolve inside the root while workspace/ itself links elsewhere.
    if (isOutside(realWorkspaceRoot, realWorkspaceDirectory)) {
      return yield* new ProjectWorkspaceManifestError({
        reason: "escape",
        workspaceRoot,
        detail: "",
      });
    }

    const issues: Array<WorkspaceManifestIssue> = [];
    const seenIds = new Set<string>();
    const entities: Array<ResolvedWorkspaceEntity> = [];
    for (const entity of manifest.entities) {
      if (seenIds.has(entity.id)) {
        issues.push({
          kind: "duplicate-id",
          entityId: entity.id,
          message: `Entity id "${entity.id}" appears more than once.`,
        });
      }
      seenIds.add(entity.id);
      entities.push(
        yield* resolveEntity(entity, { workspaceRoot, realWorkspaceDirectory }, issues),
      );
    }
    return { _tag: "ok" as const, manifest: { entities, issues } };
  });

  return ProjectWorkspace.of({ readManifest });
});

export const layer = Layer.effect(ProjectWorkspace, make);
