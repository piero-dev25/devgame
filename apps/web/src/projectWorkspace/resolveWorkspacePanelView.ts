/**
 * Every decision behind the Workspace dock panel, as plain data, so the panel
 * component stays a thin renderer (apps/web has no DOM test environment).
 *
 * The panel never browses files itself: a step opens in the Files panel
 * through `openFileInDock`, which needs a server thread. A draft has no
 * thread files yet, so its cards render but opening is disabled with a
 * reason instead of a dead button.
 */
import type {
  ProjectWorkspaceReadSuccess,
  ResolvedWorkspaceEntity,
  ResolvedWorkspaceStep,
  ScopedThreadRef,
  WorkspaceManifestIssue,
  WorkspaceStepIssue,
} from "@t3tools/contracts";

export interface WorkspaceStepView {
  readonly key: string;
  readonly name: string;
  /** Project-relative path the Files panel opens, or null when the path escapes. */
  readonly relativePath: string | null;
  readonly isDefault: boolean;
  /** Why the file cannot be shown, or null when it exists. */
  readonly problem: string | null;
  readonly openable: boolean;
}

export interface WorkspaceCardView {
  readonly key: string;
  readonly title: string;
  readonly category: string | null;
  readonly status: string | null;
  readonly description: string | null;
  readonly pinned: boolean;
  readonly steps: ReadonlyArray<WorkspaceStepView>;
}

export type WorkspacePanelView =
  | { readonly kind: "no-project" }
  | { readonly kind: "loading" }
  /** Project has no `workspace/workspace.json`. */
  | { readonly kind: "missing" }
  /**
   * The read failed: transport, auth, or a registry the server refused
   * (malformed, too large, escaping). `staleCards` holds the last good cards
   * when there are any, shown under the error, never as live.
   */
  | {
      readonly kind: "error";
      readonly message: string;
      readonly staleCards: ReadonlyArray<WorkspaceCardView> | null;
    }
  | {
      readonly kind: "ready";
      readonly cards: ReadonlyArray<WorkspaceCardView>;
      /** Registry-level problems (duplicate ids, a folder outside `workspace/`, ...). */
      readonly issues: ReadonlyArray<string>;
      /** Set on drafts: why no step can be opened yet. */
      readonly openBlockedReason: string | null;
      /**
       * Set when the thread runs in a git worktree: steps open in the Files
       * panel from that worktree, while the cards and their "File not found"
       * badges describe the project root.
       */
      readonly openNotice: string | null;
      /** The thread the Files panel opens steps for; null on drafts. */
      readonly threadRef: ScopedThreadRef | null;
    };

const DRAFT_OPEN_BLOCKED_REASON =
  "Send the first message to open workspace files. A draft thread has no files panel yet.";

const WORKTREE_OPEN_NOTICE =
  "This thread runs in a git worktree. Steps open from the worktree, so a file that only exists at the project root, or differs there, may not match its card.";

const STEP_PROBLEMS: Readonly<Record<WorkspaceStepIssue, string>> = {
  missing: "File not found",
  "not-file": "Not a file",
  escape: "Outside the workspace folder",
  unreadable: "Could not be read",
};

/** Step issues are shown on their step; everything else is listed above the cards. */
const STEP_ISSUE_KINDS: ReadonlySet<WorkspaceManifestIssue["kind"]> = new Set([
  "step-escape",
  "step-missing",
  "step-not-file",
  "step-unreadable",
]);

function stepProblem(step: ResolvedWorkspaceStep): string | null {
  if (step.relativePath === null) return STEP_PROBLEMS.escape;
  if (step.exists) return null;
  return STEP_PROBLEMS[step.issue ?? "missing"];
}

function toCard(
  entity: ResolvedWorkspaceEntity,
  index: number,
  canOpen: boolean,
): WorkspaceCardView {
  const title = entity.title.trim() || entity.id.trim() || "Untitled";
  return {
    key: `${index}:${entity.id}`,
    title,
    category: entity.category ?? entity.type ?? null,
    status: entity.status ?? null,
    description: entity.description ?? null,
    pinned: entity.pinned === true,
    steps: entity.steps.map((step, stepIndex) => {
      const problem = stepProblem(step);
      return {
        key: `${stepIndex}:${step.path}`,
        name: step.name.trim() || step.path,
        relativePath: step.relativePath,
        isDefault: entity.defaultStep === stepIndex,
        problem,
        openable: canOpen && problem === null && step.relativePath !== null,
      };
    }),
  };
}

/** Pinned cards first; otherwise the registry's own order. */
function toCards(
  manifest: NonNullable<ProjectWorkspaceReadSuccess["manifest"]>,
  canOpen: boolean,
): ReadonlyArray<WorkspaceCardView> {
  const cards = manifest.entities.map((entity, index) => toCard(entity, index, canOpen));
  return [...cards.filter((card) => card.pinned), ...cards.filter((card) => !card.pinned)];
}

export function resolveWorkspacePanelView(input: {
  /**
   * null when there is no route thread. `pending` when there is one but its
   * project is not resolved yet (a cold load or deep link before the thread
   * shell arrives, or a draft with no project yet).
   */
  readonly target:
    | {
        readonly kind: "server";
        readonly threadRef: ScopedThreadRef;
        /** The thread's git worktree, or null when it runs on the project root. */
        readonly worktreePath: string | null;
        /** The project root the registry was read from, or null while unknown. */
        readonly projectRoot: string | null;
      }
    | { readonly kind: "draft" }
    | { readonly kind: "pending" }
    | null;
  /** `useEnvironmentQuery` output. `data` keeps the last success after a failure. */
  readonly query: {
    readonly data: ProjectWorkspaceReadSuccess | null;
    readonly error: string | null;
  };
}): WorkspacePanelView {
  const { target, query } = input;
  if (target === null) return { kind: "no-project" };
  if (target.kind === "pending") return { kind: "loading" };
  const canOpen = target.kind === "server";

  // Error first: after a failure `data` still holds the previous success.
  if (query.error !== null) {
    const manifest = query.data?.manifest ?? null;
    return {
      kind: "error",
      message: query.error,
      staleCards:
        manifest !== null && manifest.entities.length > 0 ? toCards(manifest, false) : null,
    };
  }
  if (query.data === null) return { kind: "loading" };

  const manifest = query.data.manifest;
  if (manifest === null) return { kind: "missing" };

  return {
    kind: "ready",
    cards: toCards(manifest, canOpen),
    // Deduplicated: an identical message repeats nothing, and the text keys the list.
    issues: [
      ...new Set(
        manifest.issues
          .filter((issue) => !STEP_ISSUE_KINDS.has(issue.kind))
          .map((issue) => issue.message),
      ),
    ],
    openBlockedReason: canOpen ? null : DRAFT_OPEN_BLOCKED_REASON,
    openNotice:
      target.kind === "server" &&
      target.worktreePath !== null &&
      target.worktreePath !== target.projectRoot
        ? WORKTREE_OPEN_NOTICE
        : null,
    threadRef: target.kind === "server" ? target.threadRef : null,
  };
}
