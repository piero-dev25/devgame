import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

/**
 * Mr. Mak import plan: a dry-run inventory of what importing a Mr. Mak
 * workspace into a DevGame project would copy. Content is read from the
 * source's committed HEAD, never its working tree, and nothing is written.
 * Paths are POSIX and relative to the source repository root; the planned
 * destination path is the same relative path under the destination project.
 */

/** Source roots a plan may select. `.agents/skills` is the shared skill source. */
export const MRMAK_IMPORT_ROOTS = [
  "workspace",
  "projects",
  "context",
  "processes",
  "knowledge",
  "inbox",
  "docs",
  "public",
  ".agents/skills",
] as const;
export const MrMakImportRoot = Schema.Literals(MRMAK_IMPORT_ROOTS);
export type MrMakImportRoot = typeof MrMakImportRoot.Type;

/** Wire input. Both projects are opaque ids resolved on the server. */
export const MrMakImportPlanInput = Schema.Struct({
  sourceProjectId: ProjectId,
  destinationProjectId: Schema.optionalKey(ProjectId),
  roots: Schema.optionalKey(Schema.Array(MrMakImportRoot)),
});
export type MrMakImportPlanInput = typeof MrMakImportPlanInput.Type;

export const MrMakImportFileKind = Schema.Literals([
  "registry",
  "card",
  "media",
  "skill",
  "script",
  "reference",
  "context",
  "doc",
]);
export type MrMakImportFileKind = typeof MrMakImportFileKind.Type;

/**
 * What already sits at the planned destination. `not-checked` when the plan
 * names no destination.
 */
export const MrMakImportDestinationState = Schema.Literals([
  "new",
  "exists-identical",
  "exists-different",
  "not-checked",
]);
export type MrMakImportDestinationState = typeof MrMakImportDestinationState.Type;

/**
 * A link found in a file (HTML src/href, CSS url(), markdown link) or a
 * registry step:
 * - `resolved`: points at a file this plan includes.
 * - `not-selected`: points at a committed file outside the selected roots.
 * - `missing`: points at nothing in HEAD.
 * - `external`: a URL with a scheme, protocol-relative or absolute path.
 * - `escape`: climbs out of the repository.
 * - `malformed`: a Windows path, backslashes or a template placeholder.
 */
export const MrMakImportLinkStatus = Schema.Literals([
  "resolved",
  "not-selected",
  "missing",
  "external",
  "escape",
  "malformed",
]);
export type MrMakImportLinkStatus = typeof MrMakImportLinkStatus.Type;

export const MrMakImportLink = Schema.Struct({
  href: Schema.String,
  /** Repository-relative target, or null when it cannot be resolved. */
  resolved: Schema.NullOr(Schema.String),
  status: MrMakImportLinkStatus,
});
export type MrMakImportLink = typeof MrMakImportLink.Type;

export const MrMakImportEntry = Schema.Struct({
  root: MrMakImportRoot,
  sourcePath: Schema.String,
  destinationPath: Schema.String,
  bytes: Schema.Number,
  /**
   * sha256 of the committed blob (of the link text, for a symlink). Line
   * endings are as committed; see `crlfCheckout`.
   */
  sha256: Schema.String,
  headBlobOid: Schema.String,
  kind: MrMakImportFileKind,
  /** The working-tree copy differs from HEAD; HEAD is what gets imported. */
  dirtyInWorktree: Schema.Boolean,
  /**
   * Repository-relative target when the committed entry is a symlink, resolved
   * through any committed symlinks on the way.
   */
  symlinkTarget: Schema.NullOr(Schema.String),
  /**
   * Set when HEAD's `.gitattributes` makes a checkout write this file with CRLF
   * line endings (`eol=crlf`): the size and sha256 of those checkout bytes. A
   * destination holding either form counts as identical.
   */
  crlfCheckout: Schema.NullOr(Schema.Struct({ bytes: Schema.Number, sha256: Schema.String })),
  destination: MrMakImportDestinationState,
  links: Schema.Array(MrMakImportLink),
});
export type MrMakImportEntry = typeof MrMakImportEntry.Type;

export const MrMakImportExclusionRule = Schema.Literals([
  "vcs",
  "dependencies",
  "build-output",
  "cache",
  "live-session",
  "app-code",
  "app-tooling",
  "secret",
  "skill-distribution",
  "requirement-template",
  "untracked",
  "submodule",
  "not-selected",
]);
export type MrMakImportExclusionRule = typeof MrMakImportExclusionRule.Type;

export const MrMakImportExclusion = Schema.Struct({
  path: Schema.String,
  rule: MrMakImportExclusionRule,
  reason: Schema.String,
});
export type MrMakImportExclusion = typeof MrMakImportExclusion.Type;

/**
 * A tool or account the source expects, as a sanitized template: names and
 * keys only, never values.
 */
export const MrMakImportRequirement = Schema.Struct({
  source: Schema.String,
  kind: Schema.Literals(["mcp-server", "mcp-config", "env-var", "skill"]),
  name: Schema.String,
  keys: Schema.Array(Schema.String),
});
export type MrMakImportRequirement = typeof MrMakImportRequirement.Type;

/**
 * Something that would be wrong or broken after import. `escape` is a symlink
 * or registry step leaving its root; the `-link` kinds are file links whose
 * status is not `resolved` or `external`; the `-step` kinds are registry steps.
 */
export const MrMakImportIssue = Schema.Struct({
  kind: Schema.Literals([
    "escape",
    "malformed-path",
    "missing-step",
    "not-selected-step",
    "missing-link",
    "escape-link",
    "malformed-link",
    "not-selected-link",
    "registry-malformed",
  ]),
  path: Schema.String,
  detail: Schema.String,
});
export type MrMakImportIssue = typeof MrMakImportIssue.Type;

export const MrMakImportPlan = Schema.Struct({
  source: Schema.Struct({
    repositoryPath: Schema.String,
    revision: Schema.String,
    /** Null when HEAD is detached. */
    branch: Schema.NullOr(Schema.String),
    /** Tracked paths whose working-tree copy differs from HEAD (repository-wide). */
    dirtyPaths: Schema.Array(Schema.String),
  }),
  destinationPath: Schema.NullOr(Schema.String),
  roots: Schema.Array(MrMakImportRoot),
  entries: Schema.Array(MrMakImportEntry),
  exclusions: Schema.Array(MrMakImportExclusion),
  requirements: Schema.Array(MrMakImportRequirement),
  excludedStores: Schema.Array(Schema.Struct({ name: Schema.String, reason: Schema.String })),
  issues: Schema.Array(MrMakImportIssue),
  /** `.agents/skills` counted twice: the full tree, and the `.claude/skills` sync subset. */
  skills: Schema.Struct({ fullTreeFiles: Schema.Number, distributionFiles: Schema.Number }),
  totals: Schema.Struct({
    files: Schema.Number,
    bytes: Schema.Number,
    new: Schema.Number,
    existsIdentical: Schema.Number,
    existsDifferent: Schema.Number,
    exclusions: Schema.Number,
    issues: Schema.Number,
  }),
});
export type MrMakImportPlan = typeof MrMakImportPlan.Type;

/** What the user picked for a file the destination changed: never overwritten without `take-source`. */
export const MrMakImportConflictChoice = Schema.Literals(["keep-destination", "take-source"]);
export type MrMakImportConflictChoice = typeof MrMakImportConflictChoice.Type;

/**
 * What an import did with one planned file:
 * - `written`: new at the destination.
 * - `identical`: already there with the same bytes.
 * - `updated`: the source changed and the destination still held our previous copy.
 * - `replaced`: the destination differed and the user chose `take-source`.
 * - `kept-local`: unchanged in the source since the last import; the user's edit or deletion stays.
 * - `conflict`: the destination differs; left untouched.
 */
export const MrMakImportFileOutcome = Schema.Literals([
  "written",
  "identical",
  "updated",
  "replaced",
  "kept-local",
  "conflict",
]);
export type MrMakImportFileOutcome = typeof MrMakImportFileOutcome.Type;

/**
 * Completion receipt, written into the destination at
 * `.devgame/import/receipt.json` only after every file is in place. Files are
 * copied byte-for-byte from the source's committed HEAD, so `transforms` is empty.
 */
export const MrMakImportReceipt = Schema.Struct({
  version: Schema.Literal(1),
  /** Derived from the source revision, the planned files and their hashes, and the choices. */
  importId: Schema.String,
  previousImportId: Schema.NullOr(Schema.String),
  source: Schema.Struct({
    repositoryPath: Schema.String,
    revision: Schema.String,
    branch: Schema.NullOr(Schema.String),
  }),
  startedAt: Schema.String,
  completedAt: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      sourceSha256: Schema.String,
      /** What the destination holds after the import; null when absent or not ours. */
      destinationSha256: Schema.NullOr(Schema.String),
      outcome: MrMakImportFileOutcome,
    }),
  ),
  /** Source files changed since the previous import's revision. Removed ones are never deleted. */
  changes: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      change: Schema.Literals(["added", "modified", "removed"]),
      previousSha256: Schema.NullOr(Schema.String),
      sha256: Schema.NullOr(Schema.String),
    }),
  ),
  conflicts: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
  exclusions: Schema.Array(MrMakImportExclusion),
  transforms: Schema.Array(Schema.String),
});
export type MrMakImportReceipt = typeof MrMakImportReceipt.Type;
