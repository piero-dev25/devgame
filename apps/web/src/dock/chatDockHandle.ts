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
