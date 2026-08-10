/**
 * A module-scope handle to the live ChatDock's `DockviewLayout` — spec-
 * surfaces-as-dock-panels.md, Part B. Exists because a caller that needs to
 * open a dock panel programmatically (ChatView's `addDiffSurface`,
 * `onOpenTurnDiff`) is a DESCENDANT of the dock (`ChatDock` -> `ChatPanel`
 * -> `ChatView`), not a sibling or an ancestor — the actual problem is
 * structural REACHABILITY, not import cyclicity: the dock's
 * `DockviewLayout` ref lives inside `ChatDock`'s own `useRef`, scoped to
 * that ONE component instance, with no prop threading it down through
 * `ChatPanel` to `ChatView` today. There is no module-level "the ref" a
 * lower file could import even if it wanted to — refs are per-instance, not
 * exported values. (A naive fix of having `ChatView.tsx` import
 * `ChatDock.tsx` directly would ALSO hit a real import cycle — `ChatDock` ->
 * `ChatPanel` -> `ChatView` -> `ChatDock` — but that's a consequence of
 * reaching for the wrong mechanism, not the reason this module exists.)
 * This module sits outside that ancestor/descendant chain entirely —
 * `ChatDock` WRITES to it, `ChatView` (or anything else that needs to open a
 * panel) READS from it, and neither imports the other.
 *
 * One dock, module-scope singleton — the same convention
 * `chatDockPanelRegistry`/`chatDockPresetRegistry` already use in
 * ChatDock.tsx, for the same "exactly one instance of this dock exists in
 * the whole app" reason. A Zustand store for one nullable handle would be
 * more machinery than this problem needs.
 *
 * `registerChatDockHandle` is called from `ChatDock.tsx`'s own effect: SET
 * when the dock's `DockviewLayout` ref becomes available, and CLEARED
 * (`null`) on unmount — a stale handle pointing at a torn-down dock is worse
 * than a null one, since the dockview API it would call into no longer
 * exists.
 *
 * `openChatDockPanel` fails loudly-but-safely when the handle isn't ready:
 * returns without acting, AND logs. A Diff (or, later, Play/Files/Terminal)
 * button that silently does nothing because the dock hadn't registered its
 * handle yet is exactly the "looks wired, does nothing" class of bug this
 * repo has already shipped twice.
 */
/**
 * Panel ids shared across the same reachability boundary this module exists
 * to route around: `ChatDock.tsx` registers the panel under this id (single
 * source of truth for the registration), `ChatView.tsx`'s `addDiffSurface`/
 * `onOpenTurnDiff` pass it to `openChatDockPanel` below. Defined HERE rather
 * than in `ChatDock.tsx` (this fork's usual place for a panel id constant —
 * see `dock/lib/index.ts`'s own comment on why this repo has no generic
 * `panelIds.ts`) specifically because this ONE id needs to be readable from
 * both sides of the boundary; a future Files/Terminal/Browser promotion that
 * needs the same thing should add its id here too, not duplicate the
 * literal string at each call site.
 */
export const DIFF_PANEL_ID = "diff";
/** Task #61, following the same pattern: `ChatView.tsx`'s `addFilesSurface`
 * needs this id to call `openChatDockPanel` after Files moved to the dock. */
export const FILES_PANEL_ID = "files";
/** Task #53, third slice, same pattern again: `ChatView.tsx`'s
 * `addTerminalSurface` needs this id to call `openChatDockPanel` after
 * Terminal moved to the dock. */
export const TERMINAL_PANEL_ID = "terminal";
/** Task #53, fourth and final slice: every "open a preview" entry point
 * (chat markdown links, script auto-open, terminal links, discovered
 * ports, the mini-player's "restore") needs this id to call
 * `openChatDockPanel` after Browser moved to the dock. */
export const BROWSER_PANEL_ID = "browser";

export interface ChatDockHandle {
  /** Activates the panel if it's already open anywhere in the live layout;
   * otherwise adds it (see `DockviewLayout.tsx`'s `openPanel`) and then
   * activates it. No-ops if `id` isn't a registered panel. */
  openPanel: (id: string) => void;
  /** Review fix after #56: a GENUINE toggle, for a caller like a keyboard
   * shortcut named after toggling (ChatView.tsx's `onToggleDiff`, bound to
   * Cmd/Ctrl+D) — closes an already-open panel instead of just re-focusing
   * it. See `DockviewLayout.tsx`'s `togglePanel` for the open-vs-close
   * decision. No-ops if `id` isn't a registered panel. */
  togglePanel: (id: string) => void;
  /** dock-chrome-strip.md, Section C: toggles the sidebar panel's GROUP-level
   * dockview visibility (size-to-zero / restore) via
   * `DockviewLayout.tsx`'s generic `togglePanelGroupVisibility`, applied
   * here specifically to `SIDEBAR_PANEL_ID`. Deliberately NOT
   * `togglePanel` above — the sidebar panel's `closeable: false` is
   * load-bearing (its window keydown listeners — thread prev/next,
   * Cmd+1..9 — live only while mounted, see ChatDock.tsx's own
   * `SIDEBAR_PANEL_ID` registration comment, ChatDock.tsx:180-185), so a
   * real `close()` would tear that down; `setVisible` never does. */
  toggleSidebarVisibility: () => void;
}

let chatDockHandle: ChatDockHandle | null = null;

export function registerChatDockHandle(handle: ChatDockHandle | null): void {
  chatDockHandle = handle;
}

export function openChatDockPanel(id: string): void {
  if (!chatDockHandle) {
    console.warn(
      `openChatDockPanel("${id}") called before the chat dock registered its handle — no-op.`,
      { operation: "open-chat-dock-panel", panelId: id },
    );
    return;
  }
  chatDockHandle.openPanel(id);
}

export function toggleChatDockPanel(id: string): void {
  if (!chatDockHandle) {
    console.warn(
      `toggleChatDockPanel("${id}") called before the chat dock registered its handle — no-op.`,
      { operation: "toggle-chat-dock-panel", panelId: id },
    );
    return;
  }
  chatDockHandle.togglePanel(id);
}

/**
 * dock-chrome-strip.md, Section C: `_chat.tsx`'s hoisted chrome strip (a
 * SIBLING of the dock, not a descendant — same structural-reachability
 * reason this whole module exists, see the top-of-file doc) needs to READ
 * the sidebar's live visibility reactively (for the toggle button's pressed
 * state) as well as TOGGLE it. Mirrored here into a plain module-scope
 * boolean + listener set — independent of `chatDockHandle`'s own lifecycle
 * — rather than routed through the handle object itself, so a subscriber
 * that mounts BEFORE the dock (e.g. the strip renders above `<Outlet/>`,
 * the dock mounts as part of the route content under it) doesn't miss the
 * dock's eventual registration: `ChatDock.tsx`'s mount effect calls
 * `reportChatDockSidebarVisibleChange` once, synchronously, right after
 * registering its handle, seeding this store's snapshot correctly whenever
 * the dock (re)mounts, regardless of subscriber mount order.
 *
 * `sidebarVisible` defaults to `true` — the sidebar panel is
 * `singleton: true, closeable: false` and always present in the default
 * preset, so "visible" is the correct assumption both before the dock has
 * mounted (index-route loading/empty states, critique M6) and for the
 * ordinary case where nothing has ever hidden it.
 */
let sidebarVisible = true;
const sidebarVisibilityListeners = new Set<() => void>();

function setSidebarVisibleSnapshot(next: boolean): void {
  if (sidebarVisible === next) return;
  sidebarVisible = next;
  sidebarVisibilityListeners.forEach((listener) => listener());
}

/** `useSyncExternalStore`'s `getSnapshot` — a plain boolean read, no dock
 * access required (see this store's own doc above for why it's independent
 * of `chatDockHandle`'s lifecycle). */
export function getChatDockSidebarVisible(): boolean {
  return sidebarVisible;
}

/** `useSyncExternalStore`'s `subscribe`. */
export function subscribeChatDockSidebarVisible(listener: () => void): () => void {
  sidebarVisibilityListeners.add(listener);
  return () => sidebarVisibilityListeners.delete(listener);
}

/**
 * The ONE place this store's snapshot is written — called by `ChatDock.tsx`'s
 * mount effect, both once synchronously (seeding the initial live value) and
 * on every subsequent `DockviewLayout.tsx#subscribePanelGroupVisibility`
 * event for the sidebar panel, so this mirror always reflects live dockview
 * truth regardless of what triggered the change (the strip button, the
 * `sidebar.toggle` keybinding, or — hypothetically — anything else that
 * might call the group's own `setVisible` in the future).
 */
export function reportChatDockSidebarVisibleChange(isVisible: boolean): void {
  setSidebarVisibleSnapshot(isVisible);
}

export function toggleChatDockSidebarVisibility(): void {
  if (!chatDockHandle) {
    console.warn(
      "toggleChatDockSidebarVisibility() called before the chat dock registered its handle — no-op.",
      { operation: "toggle-chat-dock-sidebar-visibility" },
    );
    return;
  }
  chatDockHandle.toggleSidebarVisibility();
}
