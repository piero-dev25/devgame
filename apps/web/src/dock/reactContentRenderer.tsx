// Ported verbatim (extension stripped) from gamedev-workbench's
// app/web/src/components/layout/reactContentRenderer.tsx. No app coupling.
import type { GroupPanelPartInitParameters, IContentRenderer, PanelUpdateEvent } from "dockview";

import type { PanelPortalStore } from "./panelPortalStore";

/**
 * Bridges dockview-core's framework-agnostic panel factory
 * (`DockviewFrameworkOptions.createComponent`) to React. The `dockview`
 * package ships only the vanilla core — its entire `index.d.ts` is
 * `export * from 'dockview-core'`, with no React bindings and no
 * `peerDependencies` on react — so the adapter is ours to write.
 *
 * It writes it as REGISTRATION, not rendering. This function creates the
 * `HTMLElement` dockview asks for and records it in the portal store; the
 * actual React tree is rendered by `DockviewLayout` itself, via
 * `createPortal`, from inside the app's own tree. That ordering is the whole
 * point: mounting a panel in its own `createRoot` inherits no context, so
 * any panel calling a hook that needs one (`ChatPanel`'s thread-route
 * context) would throw. Every panel is a genuine child of `DockviewLayout` —
 * context, error boundaries and React event bubbling all behave as if the
 * panel were written inline; only its DOM lands in dockview's container.
 *
 * `panelId` is `CreateComponentOptions.id` (the unique panel INSTANCE) and is
 * the store key; `componentId` is `CreateComponentOptions.name` (the catalog
 * id) and is what `DockviewLayout` looks up in the `PanelRegistry`. They are
 * equal for both of step 1's panels (chat is a singleton, placeholder has no
 * mechanism to add a second instance), but keying by instance id is what
 * would let two instances of one panel type coexist if that ever changes.
 */
export function createReactContentRenderer(
  panelId: string,
  componentId: string,
  store: PanelPortalStore,
): IContentRenderer {
  const element = document.createElement("div");
  element.className = "wb-panel-content";
  element.style.height = "100%";
  element.style.width = "100%";
  // A panel given less height than its content needs must SCROLL, not silently
  // truncate. This is a floor, not a substitute for sizing groups correctly:
  // a preset whose default allocation makes a panel scroll on first open is
  // still a layout bug. It just stops that bug from destroying information.
  element.style.overflow = "auto";

  return {
    element,
    init(parameters: GroupPanelPartInitParameters) {
      // `parameters.api` is the PANEL's api (not the container's), so
      // updateParameters writes this instance's params — which dockview then
      // serializes into the persisted layout. This is the only place a
      // dockview object is touched on the params-writeback path; everything
      // above the store sees a plain callback.
      const api = (
        parameters as { api?: { updateParameters?: (p: Record<string, unknown>) => void } }
      ).api;
      store.register({
        panelId,
        componentId,
        element,
        params: parameters.params ?? {},
        updateParams: api?.updateParameters ? (next) => api.updateParameters?.(next) : undefined,
      });
    },
    update(event: PanelUpdateEvent) {
      store.updateParams(panelId, (event.params ?? {}) as Record<string, unknown>);
    },
    dispose() {
      store.unregister(panelId);
    },
  };
}
