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
