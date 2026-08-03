import type { PanelPortalEntry } from "../panelPortalStore";
import type { PanelRegistry } from "./panelRegistry";

/**
 * Fix-round finding #1 (step-1 review): `PanelDefinition.singleton` was
 * DECLARED, SET (on the chat and sidebar panels), and never READ anywhere —
 * `panelRegistry.ts`, `DockviewLayout.tsx`, and `tabContextMenu.ts` never
 * looked at it. Today's single-instance behaviour was accidental:
 * `tabContextMenu.ts`'s "Add tab" filters to panels not currently open BY
 * EXACT id, and every "Add tab" call reuses the catalog id verbatim as the
 * new panel's instance id — so nothing in THIS app currently mints a second
 * instance under a different id. The moment anything does (a future "new
 * session" affordance, a hand-edited/corrupted saved layout referencing the
 * same singleton `contentComponent` twice under two different panel ids),
 * nothing stops it, and `ChatView`'s module-level Zustand stores — the exact
 * hazard the `singleton` field documents — become shared across two live
 * instances.
 *
 * Enforced here rather than only in `tabContextMenu.ts`'s "addable" filter:
 * that filter only protects the one UI path that currently calls
 * `api.addPanel()` in this app. This function is called from
 * `DockviewLayout`'s render loop, which runs over every live panel
 * regardless of HOW it was added — a preset, a restored saved layout, the
 * tab-context-menu, or any future caller — so it is the one choke point a
 * future addable-panel affordance cannot bypass by forgetting to check
 * first.
 *
 * Pure and DOM-free on purpose: it only inspects `{panelId, componentId}`
 * pairs and the registry, so it is testable with plain objects (matching
 * this repo's own testing convention — see lib/storage.test.ts,
 * hooks/useLocalStorage.test.ts — no jsdom/dockview-core instance required).
 *
 * "First" is registration order, which is what `PanelPortalStore` (backed by
 * a `Map`, insertion-ordered) hands back from `getSnapshot()` — whichever
 * instance dockview created first for a given `componentId` stays real;
 * every later one for that same `componentId` is reported as a duplicate.
 */
export function computeDuplicateSingletonPanelIds(
  entries: readonly Pick<PanelPortalEntry, "panelId" | "componentId">[],
  registry: PanelRegistry,
): ReadonlySet<string> {
  const seenComponentIds = new Set<string>();
  const duplicatePanelIds = new Set<string>();

  for (const entry of entries) {
    const definition = registry.get(entry.componentId);
    if (!definition?.singleton) continue;

    if (seenComponentIds.has(entry.componentId)) {
      duplicatePanelIds.add(entry.panelId);
    } else {
      seenComponentIds.add(entry.componentId);
    }
  }

  return duplicatePanelIds;
}
