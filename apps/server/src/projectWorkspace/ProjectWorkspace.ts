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
 * non-file, binary and 1 MiB checks). Each step is checked lexically against
 * `<root>/workspace` and by realpath against the project root, and is only
 * stat'ed, never opened.
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
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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
     * A missing registry is `missing`, not an error. Bad paths and missing step
     * files are reported per step and in `issues`; they do not fail the read.
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
            return error.operation === "realpath-target" && (code === "ENOENT" || code === "ENOTDIR")
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
    realWorkspaceRoot: string;
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
    const realTarget = yield* fileSystem.realPath(lexical.value.absolutePath).pipe(Effect.option);
    if (realTarget._tag === "None") {
      return { relativePath, exists: false, issue: "missing" as const };
    }
    if (isOutside(input.realWorkspaceRoot, realTarget.value)) return escaped;

    const stat = yield* fileSystem.stat(realTarget.value).pipe(Effect.option);
    if (stat._tag === "None") return { relativePath, exists: false, issue: "missing" as const };
    if (stat.value.type !== "File") {
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

  const resolveEntity = Effect.fn("ProjectWorkspace.resolveEntity")(function* (
    entity: WorkspaceEntity,
    context: { workspaceRoot: string; realWorkspaceRoot: string },
    issues: Array<WorkspaceManifestIssue>,
  ) {
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
      issues.push({
        kind:
          resolved.issue === "escape"
            ? "step-escape"
            : resolved.issue === "missing"
              ? "step-missing"
              : "step-not-file",
        entityId: entity.id,
        stepIndex,
        message:
          resolved.issue === "escape"
            ? `Step "${step.path}" resolves outside the project workspace.`
            : resolved.issue === "missing"
              ? `Step "${step.path}" does not exist.`
              : `Step "${step.path}" is not a file.`,
      });
    }
    return { ...entity, steps } satisfies ResolvedWorkspaceEntity;
  });

  const readManifest: ProjectWorkspace["Service"]["readManifest"] = Effect.fn(
    "ProjectWorkspace.readManifest",
  )(function* (workspaceRoot) {
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

    // readFile already realpath'd the root successfully, so this only fails on a race.
    const realWorkspaceRoot = yield* fileSystem.realPath(workspaceRoot).pipe(
      Effect.mapError(
        (error) =>
          new ProjectWorkspaceManifestError({ reason: "read", workspaceRoot, detail: error.message }),
      ),
    );
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
      entities.push(yield* resolveEntity(entity, { workspaceRoot, realWorkspaceRoot }, issues));
    }
    return { _tag: "ok" as const, manifest: { entities, issues } };
  });

  return ProjectWorkspace.of({ readManifest });
});

export const layer = Layer.effect(ProjectWorkspace, make);
