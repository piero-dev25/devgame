// Pure-props half of FilesPanel.tsx (fix round after 5ed29658c). Kept in its
// own module — importing nothing from `./ChatPanel` — specifically so
// FilesPanel.test.tsx can render it via `renderToStaticMarkup` without
// pulling in ChatPanel.tsx's transitive graph. That graph reaches
// DiffWorkerPoolProvider.tsx, which imports a `?worker` module that throws
// `ReferenceError: self is not defined` outside a real browser/worker
// context — a real failure hit while writing this file's test, not a
// hypothetical: importing `FilesPanelBody` from `./FilesPanel` itself (before
// this split) failed the whole suite that way.
import { FolderGit2, TriangleAlert } from "lucide-react";

import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

import type { FilesPanelView } from "./FilesPanel.logic";

/**
 * Draws exactly what FilesPanel.logic.ts's module doc documents: a real
 * `+N/-M` stat when `workingTree.files` has one, or an honest "no diff stat"
 * label when the entry is the untracked/status-only zero/zero fallback —
 * never an inferred Added/Modified/Deleted verb. This is the exact line
 * FilesPanel.test.tsx pins directly against the rendered markup, because a
 * fabricated status word is a rendering-layer risk, not a decision-layer one
 * — the decision layer never had a concept of one to begin with.
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
 * one. `state` mirrors `ChangedFilesTree.tsx`'s `data-changed-files-state`
 * convention — a stable, test-friendly marker for which FilesPanelView kind
 * actually rendered, independent of copy that might change. */
function StatusCard({
  state,
  icon: Icon,
  tone,
  title,
  description,
}: {
  state: FilesPanelView["kind"];
  icon: typeof TriangleAlert;
  tone: "neutral" | "error";
  title: string;
  description?: string;
}) {
  return (
    <div
      data-files-panel-state={state}
      className="flex h-full flex-col items-center justify-center gap-2 overflow-auto p-6 text-center"
    >
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

/**
 * Pure props in, JSX out — no hooks, no context, no subscription. Takes the
 * already-decided `FilesPanelView` (see FilesPanel.logic.ts) and draws it.
 */
export function FilesPanelBody({ view }: { view: FilesPanelView }) {
  switch (view.kind) {
    case "waiting-for-project":
      return (
        <StatusCard
          state={view.kind}
          icon={FolderGit2}
          tone="neutral"
          title="Waiting for project information"
          description="This panel needs a project to know which working tree to read."
        />
      );

    case "error":
      return (
        <StatusCard
          state={view.kind}
          icon={TriangleAlert}
          tone="error"
          title="Couldn't load git status"
          description={view.message}
        />
      );

    case "loading":
      return (
        <div
          data-files-panel-state={view.kind}
          className="flex h-full items-center justify-center gap-2 p-6 text-muted-foreground text-xs"
        >
          <Spinner className="size-4" />
          Loading git status…
        </div>
      );

    case "not-a-repo":
      return (
        <StatusCard
          state={view.kind}
          icon={TriangleAlert}
          tone="error"
          title="Not a git repository"
          description={view.cwd}
        />
      );

    case "clean":
      return (
        <StatusCard
          state={view.kind}
          icon={FolderGit2}
          tone="neutral"
          title="No changes"
          description={
            view.refName ? `${view.refName} — working tree is clean.` : "Working tree is clean."
          }
        />
      );

    case "files":
      return (
        <div data-files-panel-state={view.kind} className="flex h-full min-h-0 flex-col">
          <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-muted-foreground">
            <span className="truncate">{view.refName ?? "(detached)"}</span>
            <span className="shrink-0 tabular-nums">
              {view.files.length} {view.files.length === 1 ? "file" : "files"} · +
              {view.totalInsertions} / -{view.totalDeletions}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-1.5">
            {view.files.map((file) => (
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
}
