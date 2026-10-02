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

/**
 * Wire input of the dry run. Both projects are opaque ids the user picked,
 * resolved to their roots on the server; they must differ.
 */
export const MrMakImportPlanInput = Schema.Struct({
  sourceProjectId: ProjectId,
  destinationProjectId: ProjectId,
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
  /** Committed with mode 100755; the imported copy is made executable too. */
  executable: Schema.Boolean,
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
 * For a source skill whose name a different destination skill already uses:
 * keep the destination's and skip the source's, or import the source's under
 * `newName` (default `<skill>-mrmak`).
 */
export const MrMakSkillConflictChoice = Schema.Struct({
  skill: Schema.String,
  action: Schema.Literals(["keep-existing", "import-renamed"]),
  newName: Schema.optionalKey(Schema.String),
});
export type MrMakSkillConflictChoice = typeof MrMakSkillConflictChoice.Type;

/**
 * A provider, tool, env var or MCP server a skill's SKILL.md or scripts name.
 * Listed only: an import never calls, installs or signs up for any of them.
 */
export const MrMakSkillRequirement = Schema.Struct({
  kind: Schema.Literals(["paid-provider", "tool", "env-var", "mcp-server"]),
  name: Schema.String,
  /** The first source file naming it. */
  source: Schema.String,
});
export type MrMakSkillRequirement = typeof MrMakSkillRequirement.Type;

/**
 * Skills copied into `.agents/skills` (the shared source Codex and Antigravity
 * read) and materialized into `.claude/skills` (all Claude reads) by the
 * sync-skills rule: no dot-entries, `__pycache__`, `node_modules` or compiled Python.
 */
export const MrMakSkillImportSummary = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      original: Schema.String,
      active: Schema.String,
      action: Schema.Literals(["imported", "renamed", "kept-existing"]),
      /** Files of the full tree, dot-entries included. */
      files: Schema.Number,
      /** Files materialized into `.claude/skills`. */
      distributionFiles: Schema.Number,
      requirements: Schema.Array(MrMakSkillRequirement),
    }),
  ),
  /** Original name to active name, for every imported skill. */
  names: Schema.Record(Schema.String, Schema.String),
  /** Every source skill file with its unmodified sha256 at the source revision. */
  baseline: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
  totals: Schema.Struct({
    skills: Schema.Number,
    files: Schema.Number,
    distributionFiles: Schema.Number,
    /** Only in `.agents/skills`: the files the sync rule skips. */
    agentsOnlyFiles: Schema.Number,
  }),
  /** Checked on disk after the copy: both trees hold the expected bytes and SKILL.md links resolve. */
  equivalence: Schema.Struct({
    verified: Schema.Boolean,
    differences: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        problem: Schema.Literals(["missing", "different", "broken-link"]),
      }),
    ),
  }),
});
export type MrMakSkillImportSummary = typeof MrMakSkillImportSummary.Type;

/**
 * Which imported skills a provider's own discovery reports as project skills
 * of the destination. `shadowed`: found, but resolved to a copy outside the
 * project (Claude's user scope wins on a name collision).
 */
export const MrMakSkillDiscoveryReport = Schema.Struct({
  provider: Schema.Literals(["claude", "codex"]),
  status: Schema.Literals(["checked", "unavailable"]),
  projectRoot: Schema.String,
  discovered: Schema.Array(Schema.String),
  missing: Schema.Array(Schema.String),
  shadowed: Schema.Array(Schema.String),
});
export type MrMakSkillDiscoveryReport = typeof MrMakSkillDiscoveryReport.Type;

/**
 * Completion receipt, written into the destination at
 * `.devgame/import/receipt.json` only after every file is in place. Files are
 * copied byte-for-byte from the source's committed HEAD; `transforms` lists the
 * one exception, a renamed skill's references to its own name.
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
  /** Set by a skill import. */
  skills: Schema.optionalKey(MrMakSkillImportSummary),
});
export type MrMakImportReceipt = typeof MrMakImportReceipt.Type;

// ---------------------------------------------------------------------------
// `POST /api/project-import/{plan,apply,status}`: the browser reviews an import
// (dry run), applies exactly the plan it reviewed, and reads a project's import
// state. Same Input/Result/PATH trios as `ProjectWorkspaceReadInput`. Imported
// files are never served through these routes: they open in the Files panel.
// ---------------------------------------------------------------------------

/**
 * What the destination project is before the import:
 * - `empty`: nothing but `.git` and the starter files of a new DevGame project.
 * - `comparison`: an earlier import's destination (it holds a receipt).
 * - `existing`: any other project. Applying needs `confirmExistingProject`.
 */
export const MrMakImportDestinationKind = Schema.Literals(["empty", "comparison", "existing"]);
export type MrMakImportDestinationKind = typeof MrMakImportDestinationKind.Type;

/** The dry run as the dialog shows it: the plan without its per-file entries. */
export const MrMakImportPlanSummary = Schema.Struct({
  /** Fingerprint of everything below; apply refuses a plan whose fingerprint moved. */
  planId: Schema.String,
  source: Schema.Struct({
    path: Schema.String,
    revision: Schema.String,
    branch: Schema.NullOr(Schema.String),
    /** Tracked files edited in the source's working tree; their committed copy is imported. */
    dirtyPaths: Schema.Array(Schema.String),
  }),
  destination: Schema.Struct({ path: Schema.String, kind: MrMakImportDestinationKind }),
  roots: Schema.Array(MrMakImportRoot),
  totals: MrMakImportPlan.fields.totals,
  /** Files the destination changed; each needs a choice. Files of conflicting skills are not listed. */
  conflicts: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      files: Schema.Number,
      /** A different destination skill has this name; it needs a `MrMakSkillConflictChoice`. */
      conflict: Schema.Boolean,
    }),
  ),
  skillFiles: MrMakImportPlan.fields.skills,
  exclusions: Schema.Array(MrMakImportExclusion),
  requirements: Schema.Array(MrMakImportRequirement),
  issues: Schema.Array(MrMakImportIssue),
  excludedStores: MrMakImportPlan.fields.excludedStores,
});
export type MrMakImportPlanSummary = typeof MrMakImportPlanSummary.Type;

const MrMakImportRouteError = Schema.TaggedStruct("error", { message: Schema.String });

export const MrMakImportPlanResult = Schema.Union([MrMakImportPlanSummary, MrMakImportRouteError]);
export type MrMakImportPlanResult = typeof MrMakImportPlanResult.Type;

export const MrMakImportApplyInput = Schema.Struct({
  ...MrMakImportPlanInput.fields,
  /** The reviewed plan's `planId`. */
  planId: Schema.String,
  /** Per conflicting destination path. */
  choices: Schema.Record(Schema.String, MrMakImportConflictChoice),
  skillChoices: Schema.Array(MrMakSkillConflictChoice),
  /** The user confirmed importing into a destination of kind `existing`. */
  confirmExistingProject: Schema.Boolean,
});
export type MrMakImportApplyInput = typeof MrMakImportApplyInput.Type;

/** A receipt without its per-file list, as the dialog and the Workspace panel show it. */
export const MrMakImportReceiptSummary = Schema.Struct({
  importId: Schema.String,
  previousImportId: Schema.NullOr(Schema.String),
  source: MrMakImportReceipt.fields.source,
  completedAt: Schema.String,
  /** Files per outcome. */
  outcomes: Schema.Record(MrMakImportFileOutcome, Schema.Number),
  conflicts: MrMakImportReceipt.fields.conflicts,
  changes: Schema.Struct({ added: Schema.Number, modified: Schema.Number, removed: Schema.Number }),
  exclusions: Schema.Number,
  transforms: Schema.Array(Schema.String),
  skills: Schema.NullOr(
    Schema.Struct({
      skills: MrMakSkillImportSummary.fields.skills,
      verified: Schema.Boolean,
    }),
  ),
});
export type MrMakImportReceiptSummary = typeof MrMakImportReceiptSummary.Type;

export const MrMakImportApplySuccess = Schema.Struct({
  status: Schema.Literals(["imported", "unchanged"]),
  /** Destination-relative. */
  receiptPath: Schema.String,
  commit: Schema.Struct({
    status: Schema.Literals(["committed", "skipped", "failed"]),
    detail: Schema.NullOr(Schema.String),
  }),
  receipt: MrMakImportReceiptSummary,
});
export type MrMakImportApplySuccess = typeof MrMakImportApplySuccess.Type;

export const MrMakImportApplyResult = Schema.Union([
  MrMakImportApplySuccess,
  MrMakImportRouteError,
]);
export type MrMakImportApplyResult = typeof MrMakImportApplyResult.Type;

export const MrMakImportStatusInput = Schema.Struct({ projectId: ProjectId });
export type MrMakImportStatusInput = typeof MrMakImportStatusInput.Type;

/**
 * Where a project file comes from, against its import receipt:
 * - `original`: the import placed it and its bytes are unchanged since.
 * - `adapted`: the import placed it (or kept the user's copy) and it differs now.
 * - `removed`: the import placed it and it is gone.
 * - `devgame`: not from the import (listed under `processes`, `context` and the skill trees only).
 */
export const MrMakImportFileOrigin = Schema.Literals(["original", "adapted", "removed", "devgame"]);
export type MrMakImportFileOrigin = typeof MrMakImportFileOrigin.Type;

/** `import` is null when the project holds no import receipt. Read from disk on every call. */
export const MrMakImportStatusSuccess = Schema.Struct({
  import: Schema.NullOr(
    Schema.Struct({
      receipt: MrMakImportReceiptSummary,
      files: Schema.Array(Schema.Struct({ path: Schema.String, origin: MrMakImportFileOrigin })),
    }),
  ),
});
export type MrMakImportStatusSuccess = typeof MrMakImportStatusSuccess.Type;

export const MrMakImportStatusResult = Schema.Union([
  MrMakImportStatusSuccess,
  MrMakImportRouteError,
]);
export type MrMakImportStatusResult = typeof MrMakImportStatusResult.Type;

/** Under `/api` so single-origin dev already proxies them (see devProxy.ts). */
export const MRMAK_IMPORT_PLAN_PATH = "/api/project-import/plan";
export const MRMAK_IMPORT_APPLY_PATH = "/api/project-import/apply";
export const MRMAK_IMPORT_STATUS_PATH = "/api/project-import/status";
