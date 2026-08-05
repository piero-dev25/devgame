/**
 * Files as a first-class dock panel — spec-surfaces-as-dock-panels.md, Part
 * B, second slice (task #61). Harder than Diff (`DiffDockPanel.tsx`): Diff
 * already resolved its own thread identity from the URL and needed nothing
 * else from `ChatView`. `FilePreviewPanel` takes twelve-odd things from
 * `ChatView`'s own scope — environmentId, cwd, projectName, threadRef,
 * composerDraftTarget, keybindings, availableEditors, relativePath,
 * revealLine, revealRequestId, onOpenFile, onPendingChange — none of which
 * a dock panel is handed. `FilePreviewPanel` itself is UNTOUCHED, same rule
 * as Diff: we delete our code, never theirs.
 *
 * THREE DECISIONS RULED before this was written (see the task thread for
 * the full reasoning, kept short here):
 *  1. "files" (the browser) and "file" (one opened file) move TOGETHER, as
 *     one panel — they already share a component, and `rightPanelStore`'s
 *     old `openFile` already treated them as one continuum (opening a file
 *     removed the standalone "files" tab).
 *  2. "Which file is open" lives in a DEDICATED STORE (`fileExplorerStore.ts`,
 *     mirroring `diffPanelStore.ts`), not dockview panel params — the dock's
 *     layout is not thread-scoped (one shared instance, one opaque
 *     `dockview` blob) while file selection genuinely is per-thread; params
 *     are per-PANEL-INSTANCE, so per-thread state there would mean a
 *     thread-keyed map inside params, which is just a store with extra
 *     serialization ceremony.
 *  3. The old MULTI-FILE-TAB capability (several files open in parallel,
 *     `RightPanelTabs`' `file:${path}` tabs) is PRESERVED, not dropped — a
 *     migration that quietly costs a workflow capability is a bad
 *     migration. `FilesTabStrip` below is the deliberately MINIMAL version:
 *     open/close/switch, sourced from `fileExplorerStore`'s `openPaths`. No
 *     reordering, no context menus, no split affordances — those are
 *     `RightPanelTabs`' machinery, not reimplemented here per an explicit
 *     scope-control ruling. `FileBrowserPanel` (inside `FilePreviewPanel`,
 *     untouched) remains the NAVIGATOR that opens files in the first place;
 *     this strip is only the "which of the already-open ones is active"
 *     switch, one level up.
 *
 * IDENTITY: uses `ThreadRouteContext` (ChatPanel.tsx), NOT `useParams` +
 * `resolveThreadRouteRef` the way `DiffDockPanel.tsx` does. That's not
 * inconsistency — `DiffPanel` already had its OWN working `useParams`
 * mechanism worth preserving untouched; `FilePreviewPanel` has no existing
 * identity mechanism of its own (it takes `threadRef` as a plain prop), so
 * there's nothing to preserve, and `ThreadRouteContext` is the mechanism
 * this dock already provides its descendants for exactly this. It also
 * gives an explicit `routeKind: "draft" | "server"`, which `useParams` +
 * `resolveThreadRouteRef` does not (that pair just returns `null` for
 * anything non-server, collapsing "draft route" and "no route at all" into
 * one case) — see `resolveFilesDockPanelView` below for why that
 * distinction matters here specifically.
 *
 * DRAFT THREADS: `composerDraftTarget` is `ScopedThreadRef | DraftId` on
 * `FilePreviewPanel`'s own prop type — unlike Diff (gated on
 * `isServerThread` at every one of its call sites), nothing about that type
 * rules out a draft. A wrapper that copied Diff's pattern verbatim (assume
 * "route resolved -> render") would risk trying to browse a draft thread's
 * files — which has no project, no workspace, nothing to browse — as if it
 * were a real thread. `resolveFilesDockPanelView` (its own file — see that
 * file's doc comment for why it's split out, not just extracted) checks
 * `routeKind` EXPLICITLY, first, before anything else, and returns a
 * distinct `"draft-empty"` state for it — see `FilesDockPanel.test.ts` for
 * the red/green proof this doesn't fall through to a crash or stale data.
 */
import { useAtomValue } from "@effect/atom-react";
import { FolderTree, X } from "lucide-react";
import { lazy, Suspense, useCallback, useContext } from "react";

import { selectThreadFileExplorerState, useFileExplorerStore } from "~/fileExplorerStore";
import { cn } from "~/lib/utils";
import { primaryServerAvailableEditorsAtom, primaryServerKeybindingsAtom } from "~/state/server";
import { useProject, useThread } from "~/state/entities";

import { ThreadRouteContext } from "./ChatPanel";
import type { PanelProps } from "./lib/types";
import { resolveFilesDockPanelView } from "./resolveFilesDockPanelView";

const FilePreviewPanel = lazy(() => import("~/components/files/FilePreviewPanel"));

function fileBasename(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf("/") + 1) || relativePath;
}

/**
 * The deliberately minimal tab strip — decision 3 above. Plain row, open/
 * close/switch, no reordering/context-menu/split affordances.
 */
function FilesTabStrip(props: {
  openPaths: ReadonlyArray<string>;
  activePath: string | null;
  pendingPaths: ReadonlyArray<string>;
  onSelectExplorer: () => void;
  onSelectFile: (relativePath: string) => void;
  onCloseFile: (relativePath: string) => void;
}) {
  return (
    <div className="flex min-h-0 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/60 px-1 py-1">
      <button
        type="button"
        onClick={props.onSelectExplorer}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-xs",
          props.activePath === null
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        )}
      >
        <FolderTree className="size-3.5 shrink-0" />
        Explorer
      </button>
      {props.openPaths.map((relativePath) => {
        const active = props.activePath === relativePath;
        const pending = props.pendingPaths.includes(relativePath);
        return (
          <div
            key={relativePath}
            className={cn(
              "group flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs",
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => props.onSelectFile(relativePath)}
              className="max-w-40 truncate"
              title={relativePath}
            >
              {fileBasename(relativePath)}
            </button>
            <button
              type="button"
              onClick={() => props.onCloseFile(relativePath)}
              aria-label={`Close ${relativePath}`}
              className="relative flex size-4 shrink-0 items-center justify-center rounded hover:bg-accent"
            >
              {pending ? (
                <>
                  <span className="size-2 rounded-full bg-current group-hover:hidden" aria-hidden />
                  <X className="hidden size-3 group-hover:block" />
                </>
              ) : (
                <X className="size-3" />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default function FilesDockPanel(_props: PanelProps) {
  const routeContext = useContext(ThreadRouteContext);
  const activeThread = useThread(
    routeContext
      ? { environmentId: routeContext.environmentId, threadId: routeContext.threadId }
      : null,
  );
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useProject(
    activeThread && activeProjectId
      ? { environmentId: activeThread.environmentId, projectId: activeProjectId }
      : null,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);

  const view = routeContext
    ? resolveFilesDockPanelView({ routeContext, activeThread, activeProject })
    : { kind: "loading" as const };

  const fileState = useFileExplorerStore((state) =>
    view.kind === "ready"
      ? selectThreadFileExplorerState(state.byThreadKey, view.threadRef)
      : selectThreadFileExplorerState(state.byThreadKey, null),
  );

  const onSelectExplorer = useCallback(() => {
    if (view.kind !== "ready") return;
    useFileExplorerStore.getState().showExplorer(view.threadRef);
  }, [view]);
  const onSelectFile = useCallback(
    (relativePath: string) => {
      if (view.kind !== "ready") return;
      useFileExplorerStore.getState().openFile(view.threadRef, relativePath);
    },
    [view],
  );
  const onCloseFile = useCallback(
    (relativePath: string) => {
      if (view.kind !== "ready") return;
      useFileExplorerStore.getState().closeFile(view.threadRef, relativePath);
    },
    [view],
  );
  const onOpenFile = useCallback(
    (relativePath: string) => {
      if (view.kind !== "ready") return;
      useFileExplorerStore.getState().openFile(view.threadRef, relativePath);
    },
    [view],
  );
  const onPendingChange = useCallback(
    (relativePath: string, pending: boolean) => {
      if (view.kind !== "ready") return;
      useFileExplorerStore.getState().setPending(view.threadRef, relativePath, pending);
    },
    [view],
  );

  if (view.kind === "draft-empty") {
    return (
      <div className="flex h-full min-w-0 flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
        Files aren't available until this thread starts.
      </div>
    );
  }
  if (view.kind === "loading") {
    return <div className="flex h-full min-w-0 flex-1" />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FilesTabStrip
        openPaths={fileState.openPaths}
        activePath={fileState.activePath}
        pendingPaths={fileState.pendingPaths}
        onSelectExplorer={onSelectExplorer}
        onSelectFile={onSelectFile}
        onCloseFile={onCloseFile}
      />
      <div className="min-h-0 flex-1">
        <Suspense fallback={null}>
          <FilePreviewPanel
            // Task #112: was `${view.environmentId}:${view.cwd}` — two
            // threads in the same project share one cwd, so that key never
            // changed on a thread switch and React reused this component
            // INSTANCE instead of remounting it, leaving its own internal
            // state (explorerOpen, handledReveal, etc.) stale from whichever
            // thread was open before. `view.previewPanelKey`
            // (resolveFilesDockPanelView.ts) adds thread identity while
            // keeping cwd, so the original "cwd changed" remount trigger
            // (e.g. a worktree operation) still works too.
            key={view.previewPanelKey}
            environmentId={view.environmentId}
            cwd={view.cwd}
            projectName={view.projectName}
            threadRef={view.threadRef}
            composerDraftTarget={view.composerDraftTarget}
            keybindings={keybindings}
            availableEditors={availableEditors}
            relativePath={fileState.activePath}
            revealLine={fileState.revealLine}
            revealRequestId={fileState.revealRequestId}
            onOpenFile={onOpenFile}
            onPendingChange={onPendingChange}
          />
        </Suspense>
      </div>
    </div>
  );
}
