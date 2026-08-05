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

/**
 * Task #108, round 6 (live QA, diagnostic-build repro, all four windows
 * log-confirmed): T3's thread list is itself an ordinary dock panel —
 * `ChatDock.tsx` registers it as `id: SIDEBAR_PANEL_ID, singleton: true,
 * closeable: false` — not a route-level nav element outside the dock. That
 * means clicking a thread to navigate is, to dockview-core, a genuine click
 * INSIDE that panel's content area, which dockview treats as "this panel
 * becomes active" and fires `onDidActivePanelChange` for it SYNCHRONOUSLY,
 * as part of native DOM click handling — strictly BEFORE React commits the
 * new `activationKey` prop and the effect that updates
 * `activationKeyRef.current` (`DockviewLayout.tsx`) runs. So every single
 * thread switch recorded `panelId: SIDEBAR_PANEL_ID` under the OUTGOING
 * (soon-to-be-stale) thread's key, silently overwriting whatever real
 * Files/Diff selection that thread actually had — root-caused via an
 * instrumented diagnostic build + a computer-use driver replaying a literal
 * 12-step timestamped click sequence, confirmed at all four "return to a
 * thread" windows (every one read back `"sidebar"`, never the panel that
 * was actually clicked).
 *
 * `SIDEBAR_PANEL_ID` is defined HERE, not in `ChatDock.tsx` (where it
 * conceptually belongs), because `ChatDock.tsx` already imports
 * `DockviewLayout.tsx`, which imports THIS module — `ChatDock.tsx` importing
 * this constant back out of here is the only cycle-free direction.
 * `ChatDock.tsx`'s own local `const SIDEBAR_PANEL_ID = "sidebar"` was
 * replaced with an import from here so there's exactly one source of truth,
 * not two string literals that could drift.
 *
 * `CHROME_PANEL_IDS` is the general concept this constant is one member of:
 * navigation/UI CHROME — panels that exist to let you get somewhere, not
 * panels that represent "content the user is looking at for THIS thread" —
 * must never become a per-thread remembered selection, REGARDLESS of
 * whatever caused them to transiently activate. `recordActivePanelForKeyUnlessRestoring`
 * below (the write side) and `restoreActivePanelForKey`
 * (`lib/restoreActivePanel.ts`, the read side) both filter against this same
 * set. Deliberately NOT solved with click-attribution machinery (was
 * "which click caused this activation, and does it also change the
 * thread") — that's genuinely general infrastructure this app doesn't need
 * yet; the chrome-exclusion principle covers the one case that exists today.
 * If a future panel is ALSO navigation chrome rather than thread-scoped
 * content, its id joins this set — that is the intended extension point,
 * not a sign the approach needs to change.
 */
export const SIDEBAR_PANEL_ID = "sidebar";
export const CHROME_PANEL_IDS: ReadonlySet<string> = new Set([SIDEBAR_PANEL_ID]);

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

/**
 * Task #108, round 4 (live QA, merge-gate finding F7): the suppression half
 * of the fix for a transient wrong write during restore. `DockviewLayout.tsx`
 * calls this — not `recordActivePanelForKey` directly — from BOTH its
 * top-level and per-group `onDidActivePanelChange` subscriptions, passing
 * `isRestoringRef.current` (true for the duration of one
 * `restoreActivePanelForCurrentThread` call). See that ref's own doc comment
 * for the traced root cause: `restoreActivePanelForKey`'s
 * `panel.group.api.setActive()` step can transiently re-fire dockview's
 * top-level active-panel event carrying the group's OLD panel, before the
 * following `panel.api.setActive()` corrects it — a headless
 * dockview-core@7.0.4 repro confirmed the transient is real AND that it
 * self-corrects to the right final value within the same synchronous call
 * regardless of this guard. Suppressing here anyway is still correct:
 * restore only ever APPLIES a value the store already holds, so it never
 * legitimately needs to write one back — making it read-only w.r.t. the
 * store by construction removes the whole risk class rather than leaning on
 * dockview-core's own correction timing.
 *
 * A plain `isRestoring: boolean` parameter (not a ref) so this stays a pure,
 * directly testable decision — same reasoning `recordActivePanelForKey`
 * itself already applies; the ref lives in the component, this function
 * doesn't need to know it's a ref to decide what to do with its value.
 *
 * Task #108, round 6: also ignores `CHROME_PANEL_IDS` (`SIDEBAR_PANEL_ID`'s
 * own doc comment above has the traced mechanism this closes). Filtering
 * HERE — the one seam both of `DockviewLayout.tsx`'s subscriptions already
 * funnel through — is deliberate, not incidental: a per-group-subscription-only
 * filter would be insufficient, since the TOP-LEVEL `onDidActivePanelChange`
 * fires for the sidebar's own group-activation independently of whether any
 * per-group subscription also exists for it.
 */
export function recordActivePanelForKeyUnlessRestoring(
  isRestoring: boolean,
  activationKey: string | number | undefined,
  panelId: string | null,
): void {
  if (isRestoring) return;
  if (panelId !== null && CHROME_PANEL_IDS.has(panelId)) return;
  recordActivePanelForKey(activationKey, panelId);
}
