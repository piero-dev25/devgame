// Ported verbatim (extension stripped) from gamedev-workbench's
// app/web/src/components/layout/tabContextMenu.ts. Required in step 1 —
// DockviewLayout.tsx imports and calls this inside `createDockview()`;
// omitting it fails the build (spec-dock-step-1.md, correction 1).
import type { ContextMenuItem, DockviewApi, DockviewGroupPanel, IDockviewPanel } from "dockview";

import type { PanelRegistry } from "./lib/panelRegistry";

export interface BuildTabContextMenuParams {
  panel: IDockviewPanel;
  group: DockviewGroupPanel;
  api: DockviewApi;
  registry: PanelRegistry;
}

/**
 * The dock's own right-click tab menu, restated as testable behaviour:
 * "maximize / close / add tab". `getTabContextMenuItems` (dockview's own
 * hook — no custom context-menu system to build) calls this per right-click.
 */
export function buildTabContextMenuItems({
  panel,
  group,
  api,
  registry,
}: BuildTabContextMenuParams): ContextMenuItem[] {
  const isMaximized = group.api.isMaximized();

  const items: ContextMenuItem[] = [
    {
      label: isMaximized ? "Restore" : "Maximize",
      action: () => {
        if (isMaximized) {
          group.api.exitMaximized();
        } else {
          api.maximizeGroup(panel);
        }
      },
    },
    "close",
  ];

  // A panel id is unique across the whole dockview, so "addable" means
  // "not open anywhere yet" — including elsewhere in this same group.
  const addable = registry.list().filter((definition) => !api.getPanel(definition.id));

  if (addable.length > 0) {
    items.push("separator");
    for (const definition of addable) {
      items.push({
        label: `Add tab: ${definition.title}`,
        action: () => {
          api.addPanel({
            id: definition.id,
            component: definition.id,
            title: definition.title,
            position: { referenceGroup: group },
          });
        },
      });
    }
  }

  return items;
}
