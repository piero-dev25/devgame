import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

/**
 * Project workspace registry: the Mr. Mak-compatible `workspace/workspace.json`
 * at a project root. A registry lists entities (cards), each owning a folder
 * under `workspace/` and an ordered list of step files relative to that folder.
 *
 * Only `id`, `title`, `folder` and `steps` are required so hand-edited
 * registries still decode. Unknown keys are ignored on decode, which means
 * re-encoding a decoded registry drops them: never rewrite the file from these
 * schemas.
 */

/** Project-root-relative path of the registry file. */
export const PROJECT_WORKSPACE_MANIFEST_PATH = "workspace/workspace.json";

/** Project-root-relative directory that entity folders live under. */
export const PROJECT_WORKSPACE_DIRECTORY = "workspace";

export const WorkspaceStep = Schema.Struct({
  name: Schema.String,
  /** Relative to `workspace/<folder>/`. */
  path: Schema.String,
});
export type WorkspaceStep = typeof WorkspaceStep.Type;

export const WorkspaceEntity = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  /** Relative to `workspace/`. */
  folder: Schema.String,
  steps: Schema.Array(WorkspaceStep),
  type: Schema.optionalKey(Schema.String),
  category: Schema.optionalKey(Schema.String),
  defaultStep: Schema.optionalKey(Schema.Number),
  description: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  pinned: Schema.optionalKey(Schema.Boolean),
  sample: Schema.optionalKey(Schema.Boolean),
  created: Schema.optionalKey(Schema.String),
  updated: Schema.optionalKey(Schema.String),
});
export type WorkspaceEntity = typeof WorkspaceEntity.Type;

export const WorkspaceManifest = Schema.Struct({
  entities: Schema.Array(WorkspaceEntity),
});
export type WorkspaceManifest = typeof WorkspaceManifest.Type;

/**
 * Why a step cannot be shown:
 * - `escape`: the folder or step path is absolute, climbs out of `workspace/`,
 *   or is a symlink whose target lies outside `workspace/`. Never read.
 * - `missing`: nothing exists at the path.
 * - `not-file`: something exists but is not a regular file.
 * - `unreadable`: the path could not be checked, for example a symlink loop,
 *   a permission error or an invalid path.
 */
export const WorkspaceStepIssue = Schema.Literals(["escape", "missing", "not-file", "unreadable"]);
export type WorkspaceStepIssue = typeof WorkspaceStepIssue.Type;

export const ResolvedWorkspaceStep = Schema.Struct({
  ...WorkspaceStep.fields,
  /** Project-root-relative POSIX path, or null when the path escapes. */
  relativePath: Schema.NullOr(Schema.String),
  exists: Schema.Boolean,
  issue: Schema.optionalKey(WorkspaceStepIssue),
});
export type ResolvedWorkspaceStep = typeof ResolvedWorkspaceStep.Type;

export const ResolvedWorkspaceEntity = Schema.Struct({
  ...WorkspaceEntity.fields,
  steps: Schema.Array(ResolvedWorkspaceStep),
});
export type ResolvedWorkspaceEntity = typeof ResolvedWorkspaceEntity.Type;

/**
 * Problems found in a registry that decoded. Entities are still returned:
 * - `duplicate-id`, `empty-id`, `empty-title`: the id or title cannot identify
 *   or label the card on its own (blank means empty after trimming).
 * - `default-step-out-of-range`: `defaultStep` is not an integer index into
 *   `steps`.
 * - `folder-escape` and `step-*`: see {@link WorkspaceStepIssue}.
 */
export const WorkspaceManifestIssue = Schema.Struct({
  kind: Schema.Literals([
    "duplicate-id",
    "empty-id",
    "empty-title",
    "default-step-out-of-range",
    "folder-escape",
    "step-escape",
    "step-missing",
    "step-not-file",
    "step-unreadable",
  ]),
  entityId: Schema.String,
  /** Set for step issues: index into the entity's `steps`. */
  stepIndex: Schema.optionalKey(Schema.Number),
  message: Schema.String,
});
export type WorkspaceManifestIssue = typeof WorkspaceManifestIssue.Type;

/** A registry that decoded, with every step checked against the filesystem. */
export const ResolvedWorkspaceManifest = Schema.Struct({
  entities: Schema.Array(ResolvedWorkspaceEntity),
  issues: Schema.Array(WorkspaceManifestIssue),
});
export type ResolvedWorkspaceManifest = typeof ResolvedWorkspaceManifest.Type;

// ---------------------------------------------------------------------------
// `POST /api/project-workspace/read`: the browser reads a project's registry.
// Same Input/Result/PATH trio as `GenerationListInput`. The client sends only
// the opaque projectId; the server resolves the project's canonical root.
// ---------------------------------------------------------------------------

export const ProjectWorkspaceReadInput = Schema.Struct({ projectId: ProjectId });
export type ProjectWorkspaceReadInput = typeof ProjectWorkspaceReadInput.Type;

/** `manifest` is null when the project has no `workspace/workspace.json`. */
export const ProjectWorkspaceReadSuccess = Schema.Struct({
  manifest: Schema.NullOr(ResolvedWorkspaceManifest),
});
export type ProjectWorkspaceReadSuccess = typeof ProjectWorkspaceReadSuccess.Type;

/**
 * A read registry (or none), or a typed failure: an unresolved project, or a
 * registry that exists but cannot be used (malformed, too large, escaping).
 */
export const ProjectWorkspaceReadResult = Schema.Union([
  ProjectWorkspaceReadSuccess,
  Schema.TaggedStruct("error", { message: Schema.String }),
]);
export type ProjectWorkspaceReadResult = typeof ProjectWorkspaceReadResult.Type;

/** Under `/api` so single-origin dev already proxies it (see devProxy.ts). */
export const PROJECT_WORKSPACE_READ_PATH = "/api/project-workspace/read";
