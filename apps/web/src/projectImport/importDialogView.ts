/**
 * Every decision behind the Mr. Mak import dialog, as plain data, so the
 * dialog stays a thin renderer (apps/web has no DOM test environment).
 *
 * The flow is dry run, review, choose, apply, receipt. A dry run belongs to the
 * source and destination it was run on: change either and it no longer counts,
 * nor do the conflict choices and the confirmation made for it.
 * Apply is offered only for the current dry run, with a choice for every
 * conflict, and never twice for one plan. The server checks the same things
 * again (the plan's fingerprint, the choices), so this only avoids requests
 * that would be refused.
 */
import type {
  MrMakImportApplyInput,
  MrMakImportApplySuccess,
  MrMakImportConflictChoice,
  MrMakImportExclusionRule,
  MrMakImportPlanSummary,
  ProjectId,
} from "@t3tools/contracts";

import type { ImportRequestOutcome } from "./fetchMrMakImport";

export type SkillChoice = "keep-existing" | "import-renamed";

export interface ImportDialogState {
  readonly sourceProjectId: ProjectId | null;
  readonly destinationProjectId: ProjectId;
  /** The last dry run and the source/destination pair it was run on. */
  readonly dryRun:
    | { readonly status: "running"; readonly pairKey: string }
    | {
        readonly status: "done";
        readonly pairKey: string;
        readonly outcome: ImportRequestOutcome<MrMakImportPlanSummary>;
      }
    | null;
  /**
   * The source/destination pair the decisions below were made on. They count
   * for that pair only (kept across its re-runs), never for another one.
   */
  readonly decisionsPairKey: string | null;
  /** Per conflicting path; sent only for the current plan's conflicts. */
  readonly choices: Readonly<Record<string, MrMakImportConflictChoice>>;
  readonly skillChoices: Readonly<Record<string, SkillChoice>>;
  readonly confirmExistingProject: boolean;
  readonly apply:
    | { readonly status: "running"; readonly planId: string }
    | {
        readonly status: "done";
        readonly planId: string;
        readonly outcome: ImportRequestOutcome<MrMakImportApplySuccess>;
      }
    | null;
}

export interface ImportPlanView {
  readonly planId: string;
  readonly source: {
    readonly path: string;
    readonly revision: string;
    readonly branch: string | null;
    /** Files edited in the source's working tree; the committed copy is what gets imported. */
    readonly dirtyCount: number;
  };
  readonly destination: {
    readonly path: string;
    readonly warning: string | null;
    /** The user confirmed importing into this existing project, for this pair. */
    readonly confirmed: boolean;
  };
  readonly counts: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly nothingToImport: boolean;
  readonly conflicts: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
    readonly choice: MrMakImportConflictChoice | null;
  }>;
  readonly skillConflicts: ReadonlyArray<{
    readonly name: string;
    readonly files: number;
    readonly choice: SkillChoice | null;
    /** The name `import-renamed` gives it. */
    readonly renamedTo: string;
  }>;
  readonly exclusions: ReadonlyArray<{
    readonly rule: MrMakImportExclusionRule;
    readonly label: string;
    readonly count: number;
    readonly examples: ReadonlyArray<string>;
  }>;
  readonly requirements: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<string>;
  readonly excludedStores: ReadonlyArray<string>;
}

export interface ImportReceiptView {
  readonly headline: string;
  readonly importId: string;
  readonly receiptPath: string;
  readonly rows: ReadonlyArray<{ readonly label: string; readonly value: number }>;
  readonly commit: string;
  readonly conflictsLeft: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
  readonly skills: ReadonlyArray<string>;
  readonly transforms: ReadonlyArray<string>;
}

export interface ImportDialogView {
  /** Why the dry run cannot run now, or null. */
  readonly dryRunBlockedReason: string | null;
  readonly dryRunError: string | null;
  /** The current dry run; null when none ran for this source and destination. */
  readonly plan: ImportPlanView | null;
  readonly applyBlockedReason: string | null;
  /** What Apply sends; null whenever it is blocked. */
  readonly applyRequest: MrMakImportApplyInput | null;
  readonly applyError: string | null;
  readonly receipt: ImportReceiptView | null;
}

const EXCLUSION_LABELS: Readonly<Record<MrMakImportExclusionRule, string>> = {
  vcs: "Version control",
  dependencies: "Dependencies",
  "build-output": "Build output",
  cache: "Caches",
  "live-session": "Live sessions and chat history",
  "app-code": "Mr. Mak app code",
  "app-tooling": "App tooling",
  secret: "Secrets and credentials",
  "skill-distribution": "Claude skill copies (rebuilt from .agents/skills)",
  "requirement-template": "Tool configs (names only, listed under requirements)",
  untracked: "Uncommitted files",
  submodule: "Submodules",
  "not-selected": "Not selected",
};
const EXCLUSION_EXAMPLES = 3;

const OUTCOME_LABELS = {
  written: "Copied",
  identical: "Already identical",
  updated: "Updated from the source",
  replaced: "Replaced with the source's copy",
  "kept-local": "Kept your edits",
  conflict: "Left as they were (conflicts)",
} as const;

export const importPairKey = (sourceProjectId: ProjectId, destinationProjectId: ProjectId) =>
  `${sourceProjectId}\u0000${destinationProjectId}`;

const currentPairKey = (state: ImportDialogState) =>
  state.sourceProjectId === null
    ? null
    : importPairKey(state.sourceProjectId, state.destinationProjectId);

type ImportDecisions = Pick<ImportDialogState, "choices" | "skillChoices" | "confirmExistingProject">;

const NO_DECISIONS: ImportDecisions = { choices: {}, skillChoices: {}, confirmExistingProject: false };

/** The decisions that count for the current pair: none when they were made on another. */
function decisionsFor(state: ImportDialogState): ImportDecisions {
  const pairKey = currentPairKey(state);
  return pairKey !== null && state.decisionsPairKey === pairKey ? state : NO_DECISIONS;
}

/**
 * `state` with a conflict choice, skill choice or confirmation changed, made
 * on the current pair. Decisions left from another pair are dropped first.
 */
export function updateDecisions(
  state: ImportDialogState,
  update: (current: ImportDecisions) => Partial<ImportDecisions>,
): ImportDialogState {
  const current = decisionsFor(state);
  const { choices, skillChoices, confirmExistingProject } = current;
  return {
    ...state,
    choices,
    skillChoices,
    confirmExistingProject,
    ...update(current),
    decisionsPairKey: currentPairKey(state),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What to say when a dry run or an import produced no result. */
function describeFailure(
  action: "run the dry run" | "import",
  outcome: Exclude<ImportRequestOutcome<unknown>, { readonly _tag: "ok" }>,
): string {
  switch (outcome._tag) {
    case "refused":
      return outcome.message;
    case "notPermitted":
      return action === "import"
        ? "Not permitted: this connection may not write project files on this environment."
        : "Not permitted: this connection may not read project files on this environment.";
    case "unreachable":
      return `Could not reach the environment to ${action}: ${outcome.message}`;
    case "failed":
      return `The environment answered but did not ${action}: ${outcome.message}`;
  }
}

function toPlanView(decisions: ImportDecisions, summary: MrMakImportPlanSummary): ImportPlanView {
  const byRule = new Map<MrMakImportExclusionRule, Array<string>>();
  for (const exclusion of summary.exclusions) {
    byRule.set(exclusion.rule, [...(byRule.get(exclusion.rule) ?? []), exclusion.path]);
  }
  const skillConflicts = summary.skills.filter((skill) => skill.conflict);
  return {
    planId: summary.planId,
    source: {
      path: summary.source.path,
      revision: summary.source.revision.slice(0, 12),
      branch: summary.source.branch,
      dirtyCount: summary.source.dirtyPaths.length,
    },
    destination: {
      path: summary.destination.path,
      warning:
        summary.destination.kind === "existing"
          ? "This project already has its own files. Import into a new comparison project unless you mean to mix them."
          : null,
      confirmed: decisions.confirmExistingProject,
    },
    counts: [
      { label: "Files", value: String(summary.totals.files) },
      { label: "Size", value: formatBytes(summary.totals.bytes) },
      { label: "New", value: String(summary.totals.new) },
      { label: "Already identical", value: String(summary.totals.existsIdentical) },
      { label: "Conflicts", value: String(summary.conflicts.length + skillConflicts.length) },
      { label: "Skills", value: String(summary.skills.length) },
      { label: "Excluded", value: String(summary.totals.exclusions) },
      { label: "Issues", value: String(summary.totals.issues) },
    ],
    nothingToImport: summary.totals.files === 0,
    conflicts: summary.conflicts.map((conflict) => ({
      ...conflict,
      choice: decisions.choices[conflict.path] ?? null,
    })),
    skillConflicts: skillConflicts.map((skill) => ({
      name: skill.name,
      files: skill.files,
      choice: decisions.skillChoices[skill.name] ?? null,
      renamedTo: `${skill.name}-mrmak`,
    })),
    exclusions: [...byRule].map(([rule, paths]) => ({
      rule,
      label: EXCLUSION_LABELS[rule],
      count: paths.length,
      examples: paths.slice(0, EXCLUSION_EXAMPLES),
    })),
    requirements: summary.requirements.map((requirement) =>
      requirement.keys.length > 0
        ? `${requirement.name} (${requirement.kind}, from ${requirement.source}): ${requirement.keys.join(", ")}`
        : `${requirement.name} (${requirement.kind}, from ${requirement.source})`,
    ),
    issues: summary.issues.map((issue) => `${issue.path}: ${issue.detail}`),
    excludedStores: summary.excludedStores.map((store) => `${store.name}: ${store.reason}`),
  };
}

function toReceiptView(applied: MrMakImportApplySuccess): ImportReceiptView {
  const { receipt } = applied;
  return {
    headline:
      applied.status === "unchanged"
        ? "Nothing changed since the last import."
        : `Imported ${receipt.source.revision.slice(0, 12)} from ${receipt.source.repositoryPath}.`,
    importId: receipt.importId,
    receiptPath: applied.receiptPath,
    rows: (Object.keys(OUTCOME_LABELS) as Array<keyof typeof OUTCOME_LABELS>)
      .map((outcome) => ({ label: OUTCOME_LABELS[outcome], value: receipt.outcomes[outcome] }))
      .filter((row) => row.value > 0),
    commit:
      applied.commit.status === "committed"
        ? "Committed as the comparison baseline."
        : applied.commit.status === "skipped"
          ? (applied.commit.detail ?? "No baseline commit was needed.")
          : `The baseline commit failed: ${applied.commit.detail ?? "no reason given"}. The files are in place, uncommitted.`,
    conflictsLeft: receipt.conflicts,
    skills: (receipt.skills?.skills ?? []).map((skill) =>
      skill.action === "renamed"
        ? `${skill.original} imported as ${skill.active}`
        : skill.action === "kept-existing"
          ? `${skill.original}: kept the project's own skill`
          : skill.original,
    ),
    transforms: receipt.transforms,
  };
}

export function resolveImportDialogView(state: ImportDialogState): ImportDialogView {
  const source = state.sourceProjectId;
  const pairKey = currentPairKey(state);
  // Choices and the confirmation made for another source or destination do not count here.
  const decisions = decisionsFor(state);
  const dryRunBlockedReason =
    source === null
      ? "Choose the Mr. Mak project to import from."
      : source === state.destinationProjectId
        ? "Choose a source other than this project: an import never writes into its source."
        : state.dryRun?.status === "running" && state.dryRun.pairKey === pairKey
          ? "Running the dry run…"
          : null;

  // A dry run counts only for the pair it was run on, and only once it finished.
  const current =
    state.dryRun?.status === "done" && state.dryRun.pairKey === pairKey ? state.dryRun : null;
  const summary = current?.outcome._tag === "ok" ? current.outcome.value : null;
  const dryRunError =
    current && current.outcome._tag !== "ok"
      ? describeFailure("run the dry run", current.outcome)
      : null;
  const plan = summary === null ? null : toPlanView(decisions, summary);

  const applied =
    state.apply?.status === "done" && state.apply.planId === summary?.planId ? state.apply : null;
  const receipt = applied?.outcome._tag === "ok" ? toReceiptView(applied.outcome.value) : null;
  const applyError =
    applied && applied.outcome._tag !== "ok" ? describeFailure("import", applied.outcome) : null;

  const unresolved =
    plan === null
      ? 0
      : plan.conflicts.filter((conflict) => conflict.choice === null).length +
        plan.skillConflicts.filter((skill) => skill.choice === null).length;
  const applyBlockedReason =
    dryRunBlockedReason ??
    (plan === null
      ? "Run the dry run first and review what it would import."
      : state.apply?.status === "running"
        ? "Importing…"
        : receipt !== null
          ? "Imported. Run the dry run again to import later changes."
          : plan.nothingToImport
            ? "Nothing to import: the plan lists no files."
            : unresolved > 0
              ? `Choose what to do with ${unresolved === 1 ? "1 conflict" : `${unresolved} conflicts`} first.`
              : summary?.destination.kind === "existing" && !decisions.confirmExistingProject
                ? "Confirm importing into a project that already has its own files."
                : null);

  const applyRequest: MrMakImportApplyInput | null =
    applyBlockedReason !== null || plan === null || source === null
      ? null
      : {
          sourceProjectId: source,
          destinationProjectId: state.destinationProjectId,
          planId: plan.planId,
          choices: Object.fromEntries(
            plan.conflicts.flatMap((conflict) =>
              conflict.choice === null ? [] : [[conflict.path, conflict.choice]],
            ),
          ),
          skillChoices: plan.skillConflicts.flatMap((skill) =>
            skill.choice === null ? [] : [{ skill: skill.name, action: skill.choice }],
          ),
          confirmExistingProject: decisions.confirmExistingProject,
        };

  return {
    dryRunBlockedReason,
    dryRunError,
    plan,
    applyBlockedReason,
    applyRequest,
    applyError,
    receipt,
  };
}
