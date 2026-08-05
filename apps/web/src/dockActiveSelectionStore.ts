/**
 * Which dock panel was last active, per dock "activation key" — the other
 * half of the fix for task #108 ("dock tab selection leaks across chats").
 *
 * `DockviewLayout.tsx`'s own persisted layout (`ChatDock.tsx`'s
 * `CHAT_DOCK_WORKSPACE_ID`) is deliberately ONE shared blob across every
 * thread — see that constant's own doc comment for why the SPLIT/arrangement
 * genuinely should be shared (nobody wants their column widths resetting on
 * every thread switch). But that same blob also carries dockview's
 * `activeGroup`/per-group `activeView` — which tab is front-most — and that
 * inherited the same global scope BY ACCIDENT, not by design: layout
 * structure should be shared, which tab you were looking at should not. This
 * store is what gives selection its own per-key answer, so
 * `restoreActivePanel.ts` has something real to restore on a thread switch.
 *
 * `DockviewLayout.tsx` itself stays deliberately thread-agnostic — see its
 * own module doc: "a future second dock with no equivalent 'which thing is
 * the user looking at' concept has no reason to force anything active on its
 * own." So this store is keyed by whatever opaque `activationKey` STRING a
 * caller already passes it (`ChatDock.tsx` builds
 * `${environmentId}:${threadId}` today, the same identity
 * `activateOnChangeId`'s existing effect already keys off) — not a
 * `ScopedThreadRef`, unlike `fileExplorerStore.ts`'s `byThreadKey`. Same
 * persisted-record-per-key shape as that store (and `terminalDockStore.ts`,
 * `previewStateStore.ts`), different key type, so this dock's per-thread
 * persistence layer stays one recognisable pattern rather than two.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

interface DockActiveSelectionStoreState {
  byActivationKey: Record<string, string>;
  /**
   * `panelId: null` clears the remembered selection for this key (e.g. the
   * live layout momentarily has no active panel at all) rather than writing
   * a meaningless entry — mirrors `fileExplorerStore.ts`'s prune-to-absent
   * shape for its own empty-state case.
   */
  setActivePanel: (activationKey: string, panelId: string | null) => void;
}

export const useDockActiveSelectionStore = create<DockActiveSelectionStoreState>()(
  persist(
    (set) => ({
      byActivationKey: {},
      setActivePanel: (activationKey, panelId) =>
        set((state) => {
          if (panelId === null) {
            if (!(activationKey in state.byActivationKey)) return state;
            const { [activationKey]: _removed, ...byActivationKey } = state.byActivationKey;
            return { byActivationKey };
          }
          if (state.byActivationKey[activationKey] === panelId) return state;
          return { byActivationKey: { ...state.byActivationKey, [activationKey]: panelId } };
        }),
    }),
    {
      name: "t3code:dock-active-selection-state:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byActivationKey: state.byActivationKey }),
    },
  ),
);

export function selectActivePanelForKey(
  byActivationKey: Record<string, string>,
  activationKey: string | undefined,
): string | null {
  if (activationKey === undefined) return null;
  return byActivationKey[activationKey] ?? null;
}

/**
 * The WRITE-side counterpart to `selectActivePanelForKey` above — records
 * which panel is now active under a given activation key, silently no-oping
 * when there's no thread yet (`activationKey === undefined`), the same guard
 * `restoreActivePanelForThread` (`lib/restoreActivePanel.ts`) already applies
 * on the read side.
 *
 * Task #108, QA round 3 reopen ("per-thread tab selection leaks when two
 * panels share ONE dock group"): `DockviewLayout.tsx`'s mount effect calls
 * this from TWO places now, not one — the top-level `DockviewApi`'s own
 * `onDidActivePanelChange` (unchanged since the original fix), AND, per
 * group, that group's own `DockviewGroupPanelApi.onDidActivePanelChange`.
 * The second one exists because dockview-core's top-level event only
 * re-broadcasts a group's internal tab flip when that group is ALREADY
 * dockview's own active group (`dockviewComponent.js`'s re-broadcast guard:
 * `if (event.panel !== this.activePanel) return`, where `activePanel` is
 * `activeGroup?.activePanel`) — so two panels sharing one group (Files+Diff)
 * flipping which of them is THAT group's active tab, while some other group
 * is dockview's active one, was invisible to the top-level event alone. Both
 * routes converge here rather than duplicating the "is there a thread to
 * record against, and under which key string" decision inline at each call
 * site — same extraction reasoning `selectActivePanelForKey` already
 * applies, and this function is idempotent by construction (`setActivePanel`
 * no-ops when the value hasn't changed), so both subscriptions firing for
 * the SAME literal tab click is harmless, not a double-write bug.
 */
export function recordActivePanelForKey(
  activationKey: string | number | undefined,
  panelId: string | null,
): void {
  if (activationKey === undefined) return;
  useDockActiveSelectionStore.getState().setActivePanel(String(activationKey), panelId);
}
