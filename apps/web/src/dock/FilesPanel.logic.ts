import type { VcsStatusResult } from "@t3tools/contracts";

/**
 * "What to show" for FilesPanel.tsx, pulled out as a pure function so it is
 * directly testable without mounting a DockviewApi, subscribing to
 * `vcs.status`, or providing a `ThreadRouteContext`. Same split this repo
 * already uses for `VcsStatusResult`-shaped decisions — see
 * `GitActionsControl.logic.ts` — and the same decide-then-render shape as
 * `dock/lib/importDecision.ts`.
 *
 * Added in the fix round after spec-files-panel.md (commit 5ed29658c) shipped
 * with zero unit coverage — every acceptance check was live E2E only. This
 * closes that gap for the two things most invisible when they regress: a
 * clean tree silently reading as an error (or vice versa), and an error
 * message getting lost between the RPC and the screen. What this file does
 * NOT own: whether a per-file stat renders as "+N/-M" or as an honest
 * "no diff stat" — that decision stays inline in FilesPanel.tsx's rendering,
 * pinned instead by FilesPanel.test.tsx against the actual rendered markup,
 * because the risk there (a fabricated "Added"/"Modified"/"Deleted" label
 * sneaking into the JSX) is a rendering-layer risk, not a decision-layer one.
 */
export type FilesPanelFileView = {
  path: string;
  insertions: number;
  deletions: number;
};

export type FilesPanelView =
  | { kind: "waiting-for-project" }
  | { kind: "error"; message: string }
  | { kind: "loading" }
  | { kind: "not-a-repo"; cwd: string }
  | { kind: "clean"; refName: string | null }
  | {
      kind: "files";
      refName: string | null;
      // readonly: `VcsStatusResult.workingTree.files` (an effect/Schema.Array)
      // comes in as a readonly array, and this passes it through untouched
      // rather than cloning just to satisfy a mutable type.
      files: readonly FilesPanelFileView[];
      totalInsertions: number;
      totalDeletions: number;
    };

export function decideFilesPanelView(input: {
  gitCwd: string | null;
  error: string | null;
  data: VcsStatusResult | null;
}): FilesPanelView {
  // A draft thread with no project chosen yet, or the thread/project atoms
  // simply haven't resolved on this render — genuinely can't tell which from
  // here, so this stays neutral rather than claiming either. Checked first:
  // no cwd means no query was even issued, so `error`/`data` are moot.
  if (input.gitCwd === null) return { kind: "waiting-for-project" };

  if (input.error !== null) return { kind: "error", message: input.error };

  if (input.data === null) return { kind: "loading" };

  // A real, successful RPC response that says "not a repository" is NEITHER
  // an RPC error NOR a clean tree — both would misreport what actually
  // happened. This branch exists so it can never fall through to "clean".
  if (!input.data.isRepo) return { kind: "not-a-repo", cwd: input.gitCwd };

  const { files, insertions, deletions } = input.data.workingTree;
  if (files.length === 0) return { kind: "clean", refName: input.data.refName };

  return {
    kind: "files",
    refName: input.data.refName,
    files,
    totalInsertions: insertions,
    totalDeletions: deletions,
  };
}
