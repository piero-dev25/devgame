import type { DockviewApi } from "dockview";

import type { PanelRegistry } from "./panelRegistry";
import { TAB_COMPONENT_NO_CLOSE } from "./tabComponents";

/**
 * The core decision behind `DockviewLayout.tsx`'s `openPanel` imperative
 * handle action (spec-surfaces-as-dock-panels.md, Part B) — extracted the
 * same way `handleImportFile`'s core decision lives in `importDecision.ts`,
 * since this repo has no jsdom/mounted-component test infra to drive
 * `DockviewLayout`'s own ref end-to-end (see that file's own module doc, and
 * `DockviewLayoutHandle`'s doc comment on `DockviewLayout.tsx`).
 *
 * Get-or-add-then-setActive: already open anywhere in the live layout ->
 * just activate it; not a registered panel id at all -> silent no-op
 * (nothing to add, nothing to activate — a caller bug, not a timing issue,
 * same reasoning `DockviewLayout.tsx` itself already documents on
 * `openPanel`); otherwise add it (mirroring `tabContextMenu.ts`'s
 * "Add tab" — same `api.addPanel()` shape, same `closeable` handling) and
 * then activate it.
 */
export function openPanelInDock(
  id: string,
  { api, panelRegistry }: { api: DockviewApi; panelRegistry: PanelRegistry },
): void {
  if (!api.getPanel(id)) {
    const definition = panelRegistry.get(id);
    if (!definition) return;
    api.addPanel({
      id,
      component: id,
      title: definition.title,
      // Same reasoning as tabContextMenu.ts's "Add tab": omitting this key
      // entirely for a closeable panel (not assigning `undefined` —
      // `exactOptionalPropertyTypes`) lets `defaultTabComponent` handle it,
      // one behaviour, one place it's decided.
      ...(definition.closeable === false ? { tabComponent: TAB_COMPONENT_NO_CLOSE } : {}),
    });
  }
  api.getPanel(id)?.api.setActive();
}

/**
 * The core decision behind `onToggleDiff`'s Cmd/Ctrl+D shortcut
 * (ChatView.tsx, bound to the `diff.toggle` command) — a genuine toggle,
 * unlike `openPanelInDock` above, which is deliberately open-only (used by
 * `addDiffSurface`/`onOpenTurnDiff`, where "already open" must stay open
 * and focused, never close). Review fix after #56: `onToggleDiff` briefly
 * called `openPanelInDock` directly, which regressed Cmd+D from "toggle" to
 * "open and focus, pressing it again does nothing" — a real behaviour loss
 * for a shortcut literally named after toggling.
 *
 * Already open anywhere in the layout -> close it, via `IDockviewPanel.api`'s
 * own `close()` (dockview-core's real close primitive — the SAME one the
 * tab's × button and the "close" context-menu item already call today for
 * every other closeable panel, so this introduces no new interaction with
 * layout persistence: a save fired by this close stamps `knownPanelIds`
 * from the CURRENT catalog same as any other save — see `persist()` in
 * DockviewLayout.tsx — so a still-registered-but-now-closed panel is
 * correctly read back as "the user closed it on purpose" by
 * `migrateLoadedLayout`, never re-grafted in on reload). Not open -> defers
 * to `openPanelInDock` for the open half, rather than duplicating its
 * add-then-activate logic.
 */
export function togglePanelInDock(
  id: string,
  deps: { api: DockviewApi; panelRegistry: PanelRegistry },
): void {
  const existing = deps.api.getPanel(id);
  if (existing) {
    existing.api.close();
    return;
  }
  openPanelInDock(id, deps);
}

/**
 * dock-chrome-strip.md, Section C: the core decision behind
 * `DockviewLayout.tsx`'s `togglePanelGroupVisibility`/`isPanelGroupVisible`/
 * `subscribePanelGroupVisibility` imperative handle actions — same
 * extraction reason as `openPanelInDock`/`togglePanelInDock` above.
 *
 * This is a GROUP-level visibility toggle (dockview-core's
 * `DockviewGroupPanelApi.setVisible`, a size-to-zero/restore on the group's
 * own splitview slot — verified against dockview-core@7.0.4's
 * `branchNode.js#setChildVisible`, which caches and restores the group's
 * exact prior size/position rather than removing it from the tree), NOT
 * `IDockviewPanel.api.close()`. The distinction is load-bearing: closing a
 * panel unmounts its React content; this never does. For the sidebar panel
 * specifically, staying mounted through a hide/show cycle is required —
 * its window keydown listeners (thread prev/next, Cmd+1..9) live only while
 * mounted (see ChatDock.tsx's `SIDEBAR_PANEL_ID` registration comment,
 * `closeable: false`, and ChatDock.tsx:180-185's own citation of why).
 *
 * All three functions resolve the panel's GROUP via `api.getPanel(id)?.group`
 * rather than a group id, so a caller only ever needs to know the PANEL's
 * id (already the shared vocabulary `openPanelInDock`/`togglePanelInDock`
 * use) — no second "which group is this panel in" constant to keep in sync.
 * No-op (or the documented default) when the panel isn't currently open,
 * matching `openPanelInDock`'s "unknown id -> silent no-op" precedent.
 */
export function isPanelGroupVisible(id: string, { api }: { api: DockviewApi }): boolean {
  return api.getPanel(id)?.group.api.isVisible ?? true;
}

export function togglePanelGroupVisibility(id: string, { api }: { api: DockviewApi }): void {
  const group = api.getPanel(id)?.group;
  if (!group) return;
  group.api.setVisible(!group.api.isVisible);
}

/**
 * `listener` receives the group's live `isVisible` on every dockview
 * `onDidVisibilityChange` event. Returns a no-op unsubscribe (rather than
 * throwing) when the panel isn't open — same "timing issue, not a caller
 * bug" reasoning `DockviewLayout.tsx`'s other ref actions already apply to
 * a not-yet-live `apiRef.current`.
 */
export function subscribePanelGroupVisibility(
  id: string,
  listener: (isVisible: boolean) => void,
  { api }: { api: DockviewApi },
): () => void {
  const group = api.getPanel(id)?.group;
  if (!group) return () => {};
  const disposable = group.api.onDidVisibilityChange((event) => listener(event.isVisible));
  return () => disposable.dispose();
}
