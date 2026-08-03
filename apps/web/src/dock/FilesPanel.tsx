// New for spec-files-panel.md — not a port. The first dock panel reading
// this fork's REAL data instead of a fixture.
//
// Explicitly NOT built on gamedev-workbench's `components/panels/FileTree.tsx`:
// that component takes `FileTreeNode[]` with a synthesized `M/A/D/R/?` status
// per file — a shape this fork's real data does not provide. See the module
// doc below for what the real shape (`VcsStatusResult`, `packages/contracts/
// src/git.ts`) actually supports and what that means for what this panel can
// honestly claim.
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { FolderGit2, TriangleAlert } from "lucide-react";
import { useContext, useMemo } from "react";

import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { useProject, useThread } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";

import { ThreadRouteContext } from "./ChatPanel";

/**
 * What `VcsStatusResult.workingTree.files` (packages/contracts/src/git.ts)
 * actually carries per file: `{path, insertions, deletions}` — a diff-stat,
 * never a porcelain status letter. Traced server-side
 * (apps/server/src/vcs/GitVcsDriverCore.ts's `statusDetails`, ~line 1583) to
 * confirm rather than assume:
 *
 *  - The numbers come from `git diff HEAD --numstat` — tracked files with a
 *    real content difference. A file that only ADDS lines (insertions>0,
 *    deletions=0) could be a newly-staged file OR a modification that
 *    happens to add only; a file that only REMOVES lines (deletions>0,
 *    insertions=0) could be a deletion OR a modification that happens to
 *    remove only. Numstat alone cannot tell these apart, and this panel does
 *    not pretend it can — it shows the stat, not a guessed verb.
 *  - Separately, the same code also runs `git status --porcelain=v2 --branch`
 *    and folds in any path THAT lists as changed but numstat had nothing to
 *    say about, as `{insertions: 0, deletions: 0}`. `git diff HEAD` never
 *    sees genuinely untracked files (files never `git add`ed) at all — that
 *    is exactly why this fallback exists — so an untracked file's honest
 *    signature in this data is "present, with a zero/zero stat," not a
 *    fabricated "Added" label. (The claim that a diff can never include an
 *    untracked file is separately false elsewhere in this codebase —
 *    `readUntrackedReviewDiffs` in the same file — but that is a different
 *    code path than `workingTree.files`.)
 *
 * `FileRow` below draws exactly this line: a real `+N/-M` stat when one
 * exists, or an honest "no line-level diff" label when it doesn't — never an
 * inferred Added/Modified/Deleted verb. See the step's report for what was
 * actually observed testing new/modified/deleted files against a real repo.
 */
function FileRow({
  path,
  insertions,
  deletions,
}: {
  path: string;
  insertions: number;
  deletions: number;
}) {
  const hasStat = insertions > 0 || deletions > 0;
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-1.5 font-mono text-xs">
      <span className="min-w-0 flex-1 truncate text-foreground">{path}</span>
      {hasStat ? (
        <span className="shrink-0 tabular-nums">
          <span className="text-success">+{insertions}</span>
          <span className="text-muted-foreground"> / </span>
          <span className="text-destructive">-{deletions}</span>
        </span>
      ) : (
        <span className="shrink-0 text-muted-foreground">no diff stat</span>
      )}
    </div>
  );
}

/** Shared centered-card layout for every non-happy-path state — matches
 * QuarantinePanel.tsx/SingletonBlockedPanel.tsx's visual language so the
 * dock's status cards read as one family regardless of which panel shows
 * one. */
function StatusCard({
  icon: Icon,
  tone,
  title,
  description,
}: {
  icon: typeof TriangleAlert;
  tone: "neutral" | "error";
  title: string;
  description?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 overflow-auto p-6 text-center">
      <span
        className={cn(
          "flex size-10 items-center justify-center rounded-full",
          tone === "error"
            ? "bg-destructive/10 text-destructive"
            : "bg-muted text-muted-foreground",
        )}
      >
        <Icon size={20} strokeWidth={1.75} />
      </span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="max-w-xs text-xs text-muted-foreground">{description}</p> : null}
    </div>
  );
}

export function FilesPanel() {
  const routeValue = useContext(ThreadRouteContext);
  if (!routeValue) {
    throw new Error("FilesPanel rendered outside a ThreadRouteContext.Provider — see ChatDock.tsx");
  }
  const { environmentId, threadId } = routeValue;

  // Same cwd-resolution rule as GitActionsControl.tsx/ThreadRowLeadingStatus
  // (`~/components/ThreadStatusIndicators.tsx`) use for the exact same
  // subscription — worktree path first, project root otherwise — followed
  // rather than invented, so a worktree thread's Files panel shows ITS
  // worktree's status, not the parent project's.
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const thread = useThread(threadRef);
  const projectRef = useMemo(
    () => (thread ? scopeProjectRef(environmentId, thread.projectId) : null),
    [environmentId, thread],
  );
  const project = useProject(projectRef);
  const gitCwd = thread?.worktreePath ?? project?.workspaceRoot ?? null;

  // `vcsEnvironment.status` (packages/client-runtime/src/state/vcs.ts) is a
  // STREAMING subscription atom family (`subscribeVcsStatus` under the
  // hood), not a one-shot request — this is what makes "no manual refresh"
  // true: every consumer of this same atom (GitActionsControl.tsx,
  // ThreadRowLeadingStatus) already gets live updates this way, so this
  // panel does too by construction, not by anything panel-specific.
  const statusQuery = useEnvironmentQuery(
    gitCwd !== null ? vcsEnvironment.status({ environmentId, input: { cwd: gitCwd } }) : null,
  );

  if (gitCwd === null) {
    // A draft thread with no project chosen yet, or the thread/project atoms
    // simply haven't resolved on this render — genuinely can't tell which
    // from here, so this stays neutral rather than claiming either.
    return (
      <StatusCard
        icon={FolderGit2}
        tone="neutral"
        title="Waiting for project information"
        description="This panel needs a project to know which working tree to read."
      />
    );
  }

  if (statusQuery.error !== null) {
    return (
      <StatusCard
        icon={TriangleAlert}
        tone="error"
        title="Couldn't load git status"
        description={statusQuery.error}
      />
    );
  }

  if (statusQuery.data === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-6 text-muted-foreground text-xs">
        <Spinner className="size-4" />
        Loading git status…
      </div>
    );
  }

  const status = statusQuery.data;

  if (!status.isRepo) {
    // Acceptance check 4's case: a real, successful RPC response that says
    // "not a repository" is NOT an RPC error and NOT an empty clean tree —
    // both would misreport what actually happened. Handled as its own
    // explicit branch so it can never fall through to the empty state.
    return (
      <StatusCard
        icon={TriangleAlert}
        tone="error"
        title="Not a git repository"
        description={gitCwd}
      />
    );
  }

  const files = status.workingTree.files;

  if (files.length === 0) {
    return (
      <StatusCard
        icon={FolderGit2}
        tone="neutral"
        title="No changes"
        description={
          status.refName ? `${status.refName} — working tree is clean.` : "Working tree is clean."
        }
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="truncate">{status.refName ?? "(detached)"}</span>
        <span className="shrink-0 tabular-nums">
          {files.length} {files.length === 1 ? "file" : "files"} · +{status.workingTree.insertions}{" "}
          / -{status.workingTree.deletions}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {files.map((file) => (
          <FileRow
            key={file.path}
            path={file.path}
            insertions={file.insertions}
            deletions={file.deletions}
          />
        ))}
      </div>
    </div>
  );
}
