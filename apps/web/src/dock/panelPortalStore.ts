// Ported verbatim from gamedev-workbench's
// app/web/src/components/layout/panelPortalStore.ts. No app coupling.
/**
 * The list of live dock panels, as an external store `DockviewLayout`
 * subscribes to with `useSyncExternalStore`.
 *
 * Dockview owns panel lifecycle imperatively; React owns rendering. This
 * store is the seam between them: the content renderer (reactContentRenderer.tsx)
 * only REGISTERS the DOM node dockview handed it, and `DockviewLayout` renders
 * every registered panel through `createPortal` from its OWN tree. That is what
 * keeps panels inside the app's React tree — a panel mounted in an independent
 * `createRoot` inherits no context and throws the moment it calls a hook that
 * needs one (e.g. `ChatPanel`'s thread-route context — see ChatPanel.tsx).
 *
 * A factory, not a module-level singleton, for the same reason as
 * `createPanelRegistry` (lib/panelRegistry.ts): tests and multiple mounts
 * must not share state.
 *
 * `getSnapshot` returns a cached array rebuilt only on mutation. It must never
 * build a fresh array per call — `useSyncExternalStore` requires a
 * referentially stable snapshot between notifications or it warns
 * ("The result of getSnapshot should be cached") and can loop.
 *
 * No `getServerSnapshot` is provided at the call site — this route renders
 * client-side only (no SSR/hydration path for the dock), so there is no
 * server-rendering path that would need one.
 */
export interface PanelPortalEntry {
  /** dockview's unique panel INSTANCE id — `CreateComponentOptions.id`. */
  panelId: string;
  /** the catalog id — `CreateComponentOptions.name`, looked up in the PanelRegistry. */
  componentId: string;
  element: HTMLElement;
  params: Record<string, unknown>;
  /**
   * Writes params back through dockview's own panel api, so the change lands in
   * `api.toJSON()` and therefore in the persisted layout. Captured at `init()` from
   * the parameters dockview hands the renderer — the store never reaches for a
   * dockview object itself.
   */
  // `| undefined` spelled out explicitly — see lib/types.ts's `PanelProps`
  // doc comment for why (`exactOptionalPropertyTypes`, target-only).
  updateParams?: ((next: Record<string, unknown>) => void) | undefined;
}

type Listener = () => void;

export interface PanelPortalStore {
  subscribe(listener: Listener): () => void;
  getSnapshot(): readonly PanelPortalEntry[];
  register(entry: PanelPortalEntry): void;
  updateParams(panelId: string, params: Record<string, unknown>): void;
  unregister(panelId: string): void;
}

export function createPanelPortalStore(): PanelPortalStore {
  const entries = new Map<string, PanelPortalEntry>();
  const listeners = new Set<Listener>();
  let snapshot: readonly PanelPortalEntry[] = [];

  function emit() {
    snapshot = Array.from(entries.values());
    for (const listener of [...listeners]) listener();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
    register(entry) {
      entries.set(entry.panelId, entry);
      emit();
    },
    updateParams(panelId, params) {
      const existing = entries.get(panelId);
      if (!existing) return;
      entries.set(panelId, { ...existing, params });
      emit();
    },
    unregister(panelId) {
      if (!entries.delete(panelId)) return;
      emit();
    },
  };
}
