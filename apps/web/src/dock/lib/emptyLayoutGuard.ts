import type { SerializedDockview } from "dockview";

/**
 * Fix round after the "app bricks in 3 clicks" critique (finding #1):
 * right-click each tab → Close, three times, and the dock reaches
 * `{"root":{"type":"branch","data":[],"size":1023},"panels":{}}` — a blank
 * page with nothing left to right-click, that then persists and reloads
 * blank forever, because nothing anywhere checked for this.
 *
 * A dockview tree with zero panels is never a valid state to persist or
 * restore. `DockviewLayout.tsx` checks this in three places (the live
 * mutation stream, the persist path, and the load path) — this is the ONE
 * predicate all three share, so "empty" means the same thing everywhere.
 *
 * Checked against `panels` (the flat map dockview itself treats as the
 * source of truth — the same field `findUnknownPanelIds` already reads),
 * not by walking `grid.root` for views: a floating or popped-out panel
 * wouldn't appear in the grid tree at all, so `panels` is the more complete
 * signal for "is there really nothing open anywhere."
 */
export function isEmptyDockviewTree(tree: SerializedDockview): boolean {
  return Object.keys(tree.panels ?? {}).length === 0;
}
