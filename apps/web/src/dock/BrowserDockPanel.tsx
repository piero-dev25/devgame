/**
 * Browser (preview) as a first-class dock panel — spec-surfaces-as-dock-
 * panels.md, Part B, fourth and final slice (task #53). Same template
 * Diff/Files/Terminal established: move the surface, then delete its kind
 * from `rightPanelStore.ts`'s union so the compiler enumerates every
 * straggler. This pass's straggler count was the largest of the four — see
 * the accompanying commit for the full list — because "open a preview" has
 * far more entry points than any other surface (chat markdown links, the
 * @-file picker for .html/.pdf files, project search, script auto-open,
 * terminal links, the mini-player's "restore," discovered dev-server ports),
 * every one of which used to call `rightPanelStore.openBrowser` directly.
 *
 * UNLIKE Terminal, this panel needs NO new dedicated store. Files needed
 * `fileExplorerStore.ts` and Terminal needed `terminalDockStore.ts` because
 * neither "which file is open" nor "which terminal groups exist" was
 * tracked anywhere else. Browser is different: `previewStateStore.ts`
 * ALREADY tracks exactly this — `ThreadPreviewState.sessions` (every open
 * tab, keyed by tabId) and `.activeTabId` (which one is focused) are real,
 * already-reactive, already-per-thread state that predates this migration
 * entirely (it's what the mini-player, desktop overlay, and recording
 * pipeline already read). `rightPanelStore`'s OLD "preview" surfaces were
 * therefore redundant bookkeeping that existed only because the old right
 * panel needed ONE unified tab strip across every surface kind at once; now
 * that Browser has its own dock panel, this file's own `BrowserTabStrip`
 * reads `sessions`/`activeTabId` directly — same object-key insertion order
 * `rightPanelStore`'s reconciliation used to preserve, since normal object
 * spread never moves an existing key.
 *
 * DESKTOP-ONLY DEGRADATION: `PreviewPanel.tsx` (rendered here UNCHANGED —
 * same "delete our code, never theirs" rule) already shows a friendly
 * "Preview is only available in the DevGame desktop app" message whenever
 * `isPreviewSupportedInRuntime()` is false, REGARDLESS of which tab is
 * active — that already covers "never an empty frame" for any tab that
 * exists. The one gap that message alone doesn't cover: an EMPTY panel (zero
 * tabs) offering a "New Tab" button that would silently fail in a plain
 * browser tab. `BrowserDockEmptyState` below disables that button with the
 * same reason `RightPanelTabs`' old "Browser" tile used
 * (disabled-with-a-reason, not hidden — same pattern this fork has used
 * twice already tonight for Unity's cliUnavailable/notReady split and the
 * engine toolbar's per-backend gating).
 *
 * DRAFT THREADS: like Terminal, a preview doesn't require a real thread to
 * exist — `previewStateStore` is keyed by `ScopedThreadRef`, which a draft
 * thread has just as much as a server one. No `routeKind === "draft"` gate
 * here, matching Terminal's reasoning, not Files'.
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { Globe2, Plus, X } from "lucide-react";
import { useCallback, useContext, useMemo } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { faviconUrlForOrigin } from "~/lib/favicon";
import {
  isPreviewSupportedInRuntime,
  setActivePreviewTab,
  useThreadPreviewState,
} from "~/previewStateStore";
import { useProject, useThread } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";

import { closePreviewSession } from "../components/preview/closePreviewSession";
import { getConfiguredPreviewUrls } from "../components/preview/previewEmptyStateLogic";
import { addBrowserSurface } from "../components/preview/addBrowserSurface";
import { PreviewPanel } from "../components/preview/PreviewPanel";
import { ThreadRouteContext } from "./ChatPanel";
import type { PanelProps } from "./lib/types";

const BROWSER_UNAVAILABLE_REASON =
  "Browser previews are only available in the DevGame desktop app.";

function BrowserFavicon({ url }: { url: string | null }) {
  const faviconUrl = faviconUrlForOrigin(url, 32);
  if (!faviconUrl) return <Globe2 className="size-3.5 shrink-0" />;
  return (
    <img
      src={faviconUrl}
      alt=""
      aria-hidden
      draggable={false}
      className="size-3.5 shrink-0 rounded-sm"
    />
  );
}

function tabTitle(snapshot: { navStatus: { _tag: string; title?: string; url?: string } }): string {
  if (snapshot.navStatus._tag === "Idle") return "Browser";
  if (snapshot.navStatus.title && snapshot.navStatus.title.trim().length > 0) {
    return snapshot.navStatus.title;
  }
  try {
    return new URL(snapshot.navStatus.url ?? "").host || "Browser";
  } catch {
    return "Browser";
  }
}

/**
 * The deliberately minimal tab strip — same scope Files/Terminal set for
 * their own: open/close/switch, no reordering/context-menu affordances
 * (`RightPanelTabs`' own machinery, not reimplemented here).
 */
function BrowserTabStrip(props: {
  tabIds: readonly string[];
  activeTabId: string | null;
  sessions: Readonly<Record<string, { navStatus: { _tag: string; title?: string; url?: string } }>>;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  newTabAvailable: boolean;
}) {
  return (
    <div className="flex min-h-0 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/60 px-1 py-1">
      {props.tabIds.map((tabId) => {
        const snapshot = props.sessions[tabId];
        const active = tabId === props.activeTabId;
        const title = snapshot ? tabTitle(snapshot) : "Browser";
        const url =
          snapshot && snapshot.navStatus._tag !== "Idle" ? (snapshot.navStatus.url ?? null) : null;
        return (
          <div
            key={tabId}
            className={cn(
              "group flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs",
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => props.onSelectTab(tabId)}
              className="flex min-w-0 max-w-40 items-center gap-1.5 truncate"
              title={title}
            >
              <BrowserFavicon url={url} />
              <span className="truncate">{title}</span>
            </button>
            <button
              type="button"
              onClick={() => props.onCloseTab(tabId)}
              aria-label={`Close ${title}`}
              className="relative flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-accent group-hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={props.onNewTab}
        disabled={!props.newTabAvailable}
        title={props.newTabAvailable ? "New tab" : BROWSER_UNAVAILABLE_REASON}
        aria-label="New browser tab"
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

function BrowserDockEmptyState(props: { onNewTab: () => void; available: boolean }) {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
      <Globe2 className="size-6 text-muted-foreground/70" />
      <p className="max-w-sm text-xs text-muted-foreground">
        {props.available ? "Open a local app or URL." : BROWSER_UNAVAILABLE_REASON}
      </p>
      <button
        type="button"
        onClick={props.onNewTab}
        disabled={!props.available}
        title={props.available ? undefined : BROWSER_UNAVAILABLE_REASON}
        className="rounded-md border border-border/80 bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent/60 disabled:pointer-events-none disabled:opacity-40"
      >
        New Tab
      </button>
    </div>
  );
}

export default function BrowserDockPanel(_props: PanelProps) {
  const routeContext = useContext(ThreadRouteContext);
  const threadRef = routeContext
    ? { environmentId: routeContext.environmentId, threadId: routeContext.threadId }
    : null;
  const draftThread = useComposerDraftStore((store) =>
    threadRef ? store.getDraftThreadByRef(threadRef) : null,
  );
  const serverThread = useThread(threadRef, { waitForShell: draftThread !== null });
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useProject(projectRef);
  const configuredPreviewUrls = useMemo(
    () => getConfiguredPreviewUrls(project?.scripts),
    [project?.scripts],
  );

  const previewState = useThreadPreviewState(threadRef);
  const tabIds = useMemo(() => Object.keys(previewState.sessions), [previewState.sessions]);
  const available = isPreviewSupportedInRuntime();

  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");

  const onNewTab = useCallback(() => {
    if (!threadRef || !available) return;
    void addBrowserSurface({ threadRef, openPreview });
  }, [available, openPreview, threadRef]);

  const onSelectTab = useCallback(
    (tabId: string) => {
      if (!threadRef) return;
      setActivePreviewTab(threadRef, tabId);
    },
    [threadRef],
  );

  const onCloseTab = useCallback(
    (tabId: string) => {
      if (!threadRef) return;
      void closePreviewSession({
        closePreview,
        snapshot: previewState.sessions[tabId] ?? null,
        tabId,
        threadRef,
      });
    },
    [closePreview, previewState.sessions, threadRef],
  );

  if (!threadRef) {
    return <div className="flex h-full min-w-0 flex-1" />;
  }

  if (tabIds.length === 0) {
    return <BrowserDockEmptyState onNewTab={onNewTab} available={available} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BrowserTabStrip
        tabIds={tabIds}
        activeTabId={previewState.activeTabId}
        sessions={previewState.sessions}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onNewTab={onNewTab}
        newTabAvailable={available}
      />
      <div className="min-h-0 flex-1">
        <PreviewPanel
          mode="embedded"
          threadRef={threadRef}
          tabId={previewState.activeTabId}
          configuredUrls={configuredPreviewUrls}
          visible
        />
      </div>
    </div>
  );
}
