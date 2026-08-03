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
  //
  // This filter is BY EXACT ID (`definition.id`), and every "Add tab" call
  // below reuses that same id verbatim as the new panel's instance id — so
  // today this already can't open a second instance of anything, singleton
  // or not. The real enforcement for `singleton: true` panels lives one
  // level deeper, in `DockviewLayout.tsx`'s render loop
  // (`lib/singletonGuard.ts`), which is the choke point ANY panel-adding
  // path funnels through (this menu, a restored saved layout, or a future
  // caller that mints a fresh instance id rather than reusing the catalog
  // id) — see that file for why this filter alone wouldn't be enough to
  // rely on going forward.
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
