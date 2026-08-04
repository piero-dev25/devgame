/**
 * Which terminal group(s) are open inside the Terminal dock panel, per
 * thread — spec-surfaces-as-dock-panels.md, Part B, third slice (task #53).
 *
 * Mirrors `fileExplorerStore.ts`'s split exactly (which itself mirrors
 * `diffPanelStore.ts`'s): the DOCK owns whether the Terminal panel is
 * visible at all (`chatDockHandle.ts`'s openPanel/togglePanel); this store
 * owns what it's showing once it is. Same structural reason Files gave:
 * `ChatDock`'s dockview layout is not thread-scoped (one shared instance
 * across every thread route), while "which terminals are open" genuinely
 * is per-thread.
 *
 * A "group" here is exactly what used to be a `RightPanelSurface` of kind
 * "terminal" in `rightPanelStore.ts` (one tab in the old `RightPanelTabs`
 * strip, holding one or more SPLIT terminal panes sharing one group id).
 * `TerminalDockPanel.tsx`'s own tab strip switches between GROUPS, mirroring
 * `FilesDockPanel.tsx`'s `FilesTabStrip`; `ThreadTerminalDrawer` (mode=
 * "panel", untouched — same "delete our code, never theirs" rule Diff and
 * Files followed) renders only the ACTIVE group's panes and their splits,
 * exactly as it already did when fed by `rightPanelStore`.
 *
 * DELIBERATELY SEPARATE from `terminalUiStateStore.ts` (the bottom composer
 * drawer's own store, untouched by this task): a terminal session opened in
 * the dock panel must never ALSO render in the drawer, or vice versa — the
 * same exclusion `PersistentThreadTerminalDrawer` (ChatView.tsx) already
 * enforces today against `rightPanelStore`'s old terminal surfaces (its own
 * `panelTerminalIds` filter) is repointed at this store instead. Two
 * independent UI slots, two independent stores — reusing
 * `terminalUiStateStore` directly for the panel would conflate them the way
 * `rightPanelStore` conflated Terminal with every other surface kind before
 * this migration, and that store's own semantics (e.g. "opening with zero
 * terminals seeds one default") are specific to the drawer's own UX, not
 * this panel's.
 *
 * Replaces the "terminal" kind `rightPanelStore.ts` used to carry (see that
 * file's own v10 migration comment: persisted terminal surfaces are
 * STRIPPED, not ported into this store — same non-destructive-strip
 * precedent Diff/Files set. A user's open terminal TABS layout resets on
 * first load after this ships; the underlying PTY sessions themselves are
 * NOT destroyed (`TerminalManager` on the server keeps them alive
 * independent of any client's UI state) — `PersistentThreadTerminalDrawer`'s
 * own `knownTerminalSessions` reconciliation picks up any session no longer
 * excluded by this store and surfaces it in the drawer instead. A one-time
 * tab-position shift, not data loss.
 *
 * Closing behaviour, decided and stated (mirrors the precedent
 * `closeRightPanelSurface`/`cleanupRightPanelSurfaces` already set, not a
 * new invention): closing the WHOLE dock panel (the dockview panel's own
 * tab X) does not touch this store at all — same as the old "collapse the
 * whole right panel" (`useRightPanelStore.close`), which only hid the
 * panel and never destroyed a surface's sessions. Closing an individual
 * terminal GROUP tab inside this panel's own strip (`closeGroup` below) is
 * the direct analog of the old `closeRightPanelSurface` acting on a
 * terminal-kind surface, which DID end those sessions — `TerminalDockPanel`
 * calls `terminalEnvironment.close` for every terminal id in the group
 * being closed, same as `ChatView`'s old `closePanelTerminal`/
 * `cleanupRightPanelSurfaces` did.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { MAX_TERMINALS_PER_GROUP } from "./types";

export interface TerminalDockGroup {
  readonly id: string;
  readonly terminalIds: readonly string[];
  readonly activeTerminalId: string;
  readonly splitDirection?: "vertical";
}

export interface ThreadTerminalDockState {
  readonly groups: readonly TerminalDockGroup[];
  readonly activeGroupId: string | null;
}

interface TerminalDockStoreState {
  byThreadKey: Record<string, ThreadTerminalDockState>;
  /** Opens a brand-new group containing exactly `terminalId`, and activates
   * it — the direct analog of the old `rightPanelStore.openTerminal`. A
   * `terminalId` already present in some other group (shouldn't happen —
   * every caller allocates via `nextTerminalId` against the full known set
   * — but defensive, same as `upsertSurface`'s dedupe-by-id) just activates
   * its existing group rather than duplicating it. */
  openTerminal: (ref: ScopedThreadRef, terminalId: string) => void;
  /** Adds `terminalId` as a new split pane inside `groupId`, makes it the
   * active pane AND the active group. No-ops past `MAX_TERMINALS_PER_GROUP`
   * — `ThreadTerminalDrawer` itself already disables the split affordance
   * at that limit; this is the same defensive backstop the old
   * `rightPanelStore.splitTerminal` call site (`ChatView.splitPanelTerminal`)
   * enforced before ever reaching the store. */
  splitTerminal: (
    ref: ScopedThreadRef,
    groupId: string,
    terminalId: string,
    direction?: "horizontal" | "vertical",
  ) => void;
  /** Sets which pane is active within `groupId`, AND makes that group the
   * active group — mirrors `rightPanelStore.activateTerminal`, which set
   * `activeSurfaceId` unconditionally alongside the pane change. */
  activateTerminal: (ref: ScopedThreadRef, groupId: string, terminalId: string) => void;
  /** Switches the panel's own tab strip to `groupId` without touching any
   * pane's active state inside it — the analog of the old
   * `rightPanelStore.activateSurface`, scoped to terminal groups only. */
  activateGroup: (ref: ScopedThreadRef, groupId: string) => void;
  /** Removes one pane from `groupId`. If the group becomes empty, the group
   * itself is removed and `activeGroupId` falls back to a neighbor by
   * index, same as `rightPanelStore.closeSurface`'s fallback shape. Only
   * updates UI state — same division of responsibility the old
   * `rightPanelStore.closeTerminal` had: the CALLER (`TerminalDockPanel`)
   * issues the actual `terminalEnvironment.close` mutation. */
  closeTerminal: (ref: ScopedThreadRef, groupId: string, terminalId: string) => void;
  /** Removes the whole group. See this file's own top comment for why this
   * — unlike closing the dock panel itself — is the destructive action:
   * it's the direct successor to the old per-tab X in `RightPanelTabs`.
   * Only updates UI state, same division as `closeTerminal` above. */
  closeGroup: (ref: ScopedThreadRef, groupId: string) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_THREAD_STATE: ThreadTerminalDockState = { groups: [], activeGroupId: null };

const terminalGroupId = (terminalId: string): string => `terminal:${terminalId}`;

const updateThread = (
  byThreadKey: Record<string, ThreadTerminalDockState>,
  threadKey: string,
  updater: (current: ThreadTerminalDockState) => ThreadTerminalDockState,
): Record<string, ThreadTerminalDockState> => {
  const current = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const next = updater(current);
  if (next === current) return byThreadKey;
  if (next.groups.length === 0 && next.activeGroupId === null) {
    if (!(threadKey in byThreadKey)) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  return { ...byThreadKey, [threadKey]: next };
};

export const useTerminalDockStore = create<TerminalDockStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      openTerminal: (ref, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const existing = current.groups.find((group) => group.terminalIds.includes(terminalId));
            if (existing) {
              return current.activeGroupId === existing.id
                ? current
                : { ...current, activeGroupId: existing.id };
            }
            const group: TerminalDockGroup = {
              id: terminalGroupId(terminalId),
              terminalIds: [terminalId],
              activeTerminalId: terminalId,
            };
            return { groups: [...current.groups, group], activeGroupId: group.id };
          }),
        })),
      splitTerminal: (ref, groupId, terminalId, direction = "horizontal") =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const groups = current.groups.map((group) => {
              if (group.id !== groupId) return group;
              if (
                !group.terminalIds.includes(terminalId) &&
                group.terminalIds.length >= MAX_TERMINALS_PER_GROUP
              ) {
                return group;
              }
              return {
                id: group.id,
                terminalIds: group.terminalIds.includes(terminalId)
                  ? group.terminalIds
                  : [...group.terminalIds, terminalId],
                activeTerminalId: terminalId,
                ...(direction === "vertical" ? { splitDirection: "vertical" as const } : {}),
              };
            });
            if (groups === current.groups || !groups.some((group) => group.id === groupId)) {
              return current;
            }
            return { groups, activeGroupId: groupId };
          }),
        })),
      activateTerminal: (ref, groupId, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => ({
            groups: current.groups.map((group) =>
              group.id === groupId && group.terminalIds.includes(terminalId)
                ? { ...group, activeTerminalId: terminalId }
                : group,
            ),
            activeGroupId: groupId,
          })),
        })),
      activateGroup: (ref, groupId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.groups.some((group) => group.id === groupId)
              ? { ...current, activeGroupId: groupId }
              : current,
          ),
        })),
      closeTerminal: (ref, groupId, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const group = current.groups.find((entry) => entry.id === groupId);
            if (!group || !group.terminalIds.includes(terminalId)) return current;
            const terminalIds = group.terminalIds.filter((id) => id !== terminalId);
            if (terminalIds.length === 0) {
              const index = current.groups.findIndex((entry) => entry.id === groupId);
              const groups = current.groups.filter((entry) => entry.id !== groupId);
              const fallback = groups[Math.min(index, groups.length - 1)] ?? null;
              return {
                groups,
                activeGroupId:
                  current.activeGroupId === groupId
                    ? (fallback?.id ?? null)
                    : current.activeGroupId,
              };
            }
            return {
              ...current,
              groups: current.groups.map((entry) =>
                entry.id === groupId
                  ? {
                      ...entry,
                      terminalIds,
                      activeTerminalId:
                        entry.activeTerminalId === terminalId
                          ? (terminalIds.at(-1) ?? terminalIds[0]!)
                          : entry.activeTerminalId,
                    }
                  : entry,
              ),
            };
          }),
        })),
      closeGroup: (ref, groupId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const index = current.groups.findIndex((entry) => entry.id === groupId);
            if (index < 0) return current;
            const groups = current.groups.filter((entry) => entry.id !== groupId);
            const fallback = groups[Math.min(index, groups.length - 1)] ?? null;
            return {
              groups,
              activeGroupId:
                current.activeGroupId === groupId ? (fallback?.id ?? null) : current.activeGroupId,
            };
          }),
        })),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey)) return state;
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
    }),
    {
      name: "t3code:terminal-dock-state:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
    },
  ),
);

export function selectThreadTerminalDockState(
  byThreadKey: Record<string, ThreadTerminalDockState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadTerminalDockState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
}

export function selectTerminalDockPanelTerminalIds(
  byThreadKey: Record<string, ThreadTerminalDockState>,
  ref: ScopedThreadRef | null | undefined,
): ReadonlySet<string> {
  const state = selectThreadTerminalDockState(byThreadKey, ref);
  return new Set(state.groups.flatMap((group) => group.terminalIds));
}
