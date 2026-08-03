// Ported verbatim (extension stripped) from gamedev-workbench's
// app/web/src/components/layout/tabContextMenu.ts. Required in step 1 —
// DockviewLayout.tsx imports and calls this inside `createDockview()`;
// omitting it fails the build (spec-dock-step-1.md, correction 1).
//
// Fix round after the "app bricks in 3 clicks" critique (findings #2/#3):
// this file used to push `"close"` unconditionally and call `api.addPanel()`
// with no `tabComponent`, both ignoring whether the panel's catalog entry
// (`PanelDefinition.closeable`) says it must never be closed. Both are fixed
// below — see `lib/types.ts`'s `closeable` doc for the full history.
import type { ContextMenuItem, DockviewApi, DockviewGroupPanel, IDockviewPanel } from "dockview";

import type { PanelRegistry } from "./lib/panelRegistry";
import { TAB_COMPONENT_NO_CLOSE } from "./lib/tabComponents";

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
  ];

  // Finding #2: `"close"` is dockview's own BUILT-IN menu item — it calls
  // the panel's close action directly, with no awareness of this catalog's
  // `closeable` flag at all. The visible × (reactTabRenderer.tsx's
  // `showClose`) was never the only way to close a tab; this menu item was
  // a second, unguarded door to the exact same action. Registry lookup
  // defaults to closeable when a panel id isn't found at all (e.g. a
  // quarantined/unknown panel) — refusing to close something we can't even
  // identify would be a worse failure mode than allowing it.
  const openPanelDefinition = registry.get(panel.id);
  if (openPanelDefinition?.closeable !== false) {
    items.push("close");
  }

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
            // Finding #3: omitting this used to mean re-adding a panel via
            // "Add tab" silently fell through to `DockviewLayout.tsx`'s
            // `defaultTabComponent` (`TAB_COMPONENT_WITH_CLOSE`) even for a
            // permanently-protected panel — one close-then-reopen round trip
            // downgraded it forever. Key omitted entirely (not
            // `exactOptionalPropertyTypes`-legal to assign `undefined`) for
            // a closeable panel: matches the "let the real default handle
            // it" convention `buildChatDockPreset()`'s own panels map
            // already uses, one behaviour, one place it's decided.
            ...(definition.closeable === false ? { tabComponent: TAB_COMPONENT_NO_CLOSE } : {}),
          });
        },
      });
    }
  }

  return items;
}
