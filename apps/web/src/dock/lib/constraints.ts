// Ported verbatim from gamedev-workbench's
// app/web/src/lib/layout/constraints.ts. No app coupling — pure dockview
// geometry math over a `PanelRegistry`.
import type { DockviewGroupPanel } from "dockview";

import type { PanelRegistry } from "./panelRegistry";

export interface FloatingConstraints {
  minimumWidth: number;
  minimumHeight: number;
}

/**
 * `minSize` applies ONLY when floating, never when docked — a docked pane is
 * constrained by its container/splits instead. Docked panels are added
 * without `minimumWidth`/`minimumHeight`, so docked panes are unconstrained
 * by construction; this function supplies the "only when floating" half by
 * computing what a group's floating window should be constrained to once it
 * leaves the grid.
 *
 * A floating window can hold multiple tabs, so the window's floor is the MAX
 * minWidth/minHeight across every panel currently docked in that group — big
 * enough to fit whichever tab is active. Unregistered ids are skipped rather
 * than throwing.
 *
 * Always returns concrete numbers, defaulting to `0` rather than omitting a
 * key when no panel declares a minimum — see `syncFloatingConstraints` for
 * why `0`, specifically, matters.
 */
export function computeFloatingConstraints(
  panelIds: readonly string[],
  registry: PanelRegistry,
): FloatingConstraints {
  let minimumWidth = 0;
  let minimumHeight = 0;

  for (const id of panelIds) {
    const definition = registry.get(id);
    if (!definition) continue;
    if (definition.minWidth !== undefined) {
      minimumWidth = Math.max(minimumWidth, definition.minWidth);
    }
    if (definition.minHeight !== undefined) {
      minimumHeight = Math.max(minimumHeight, definition.minHeight);
    }
  }

  return { minimumWidth, minimumHeight };
}

/**
 * Applies the min-size-only-when-floating rule to one real dockview group.
 * `group.api.setConstraints(...)` only reassigns a dimension when the value
 * is a `number` or `function` — passing `undefined` (or omitting the key) is
 * a silent no-op that leaves whatever constraint the group had before. `0` is
 * dockview-core's own "unconstrained" default, and the only value that
 * actually clears a stale floating minimum once a group re-docks.
 * `computeFloatingConstraints` always returns concrete numbers for exactly
 * this reason — there is no "omit to mean unconstrained" path left to
 * accidentally take.
 */
export function syncFloatingConstraints(group: DockviewGroupPanel, registry: PanelRegistry): void {
  if (group.api.location.type === "floating") {
    group.api.setConstraints(
      computeFloatingConstraints(
        group.panels.map((p) => p.id),
        registry,
      ),
    );
  } else {
    group.api.setConstraints({ minimumWidth: 0, minimumHeight: 0 });
  }
}
