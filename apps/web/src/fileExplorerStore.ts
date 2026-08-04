/**
 * Which file(s) are open inside the Files dock panel, per thread —
 * spec-surfaces-as-dock-panels.md, Part B, second slice (task #61).
 *
 * Mirrors `diffPanelStore.ts`'s split exactly: the DOCK owns whether the
 * Files panel is visible at all (chatDockHandle.ts's openPanel/togglePanel,
 * same as Diff); this store owns what it's showing once it is. That split
 * is structural, not just a style choice — `ChatDock`'s dockview layout is
 * NOT thread-scoped (one shared instance across every thread route, one
 * opaque `dockview` blob in the persisted layout file), while "which file is
 * open" genuinely is per-thread. A dock panel's own `params`/`updateParams`
 * (dock/lib/types.ts) are per-PANEL-INSTANCE — one Files panel, all threads
 * — so expressing per-thread state there would mean inventing a
 * thread-keyed map inside params: a store with extra serialization
 * ceremony, not a different mechanism.
 *
 * Replaces the "files"/"file" kinds `rightPanelStore.ts` used to carry
 * (`{id:"files",kind:"files"}` for the explorer, `{id:`file:${path}`,
 * kind:"file", relativePath, revealLine, revealRequestId}` per open file) —
 * see that file's own v9 migration comment for why both are stripped from
 * persisted state rather than left to resurrect a tab with nothing behind
 * it.
 *
 * `openPaths`/`activePath` model a DELIBERATELY MINIMAL version of what
 * `RightPanelTabs` used to do for files (per an explicit scope-control
 * ruling: preserve "several files open in parallel," not
 * `RightPanelTabs`'s full reordering/context-menu/split machinery). One
 * simplification from the old behaviour, stated rather than silently
 * carried over: the old model dropped the standalone "files" (explorer) tab
 * the moment any file was opened, only reachable again via the "+" menu's
 * re-add. Here, "explorer" (`activePath: null`) is always available as a
 * fixed first entry in the panel's own internal strip — simpler to reason
 * about, and a live thread's `openPaths` staying populated while browsing
 * matches how the explorer already worked as a SIDEBAR inside
 * `FilePreviewPanel` (`FileBrowserPanel`, shown alongside an open file) —
 * this store doesn't reinvent that, it only owns the OUTER switch between
 * "explorer view" and "which open file is active."
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export interface FileExplorerThreadState {
  /** Ordered — mirrors the old right-panel tab order (append on open, never
   * reordered by this store; a user-facing reorder affordance is explicitly
   * OUT of the minimal-strip scope for this pass). */
  openPaths: string[];
  /** `null` selects the explorer view; otherwise must be a member of
   * `openPaths` — every action below maintains that invariant. */
  activePath: string | null;
  revealLine: number | null;
  revealRequestId: number;
  /** Unsaved-edit indicator per open path — the same "small thing that
   * makes the strip honest" `RightPanelTabs`'s pending dot gave the old
   * tabs, now keyed the same way `openPaths` is (per-thread), replacing
   * ChatView.tsx's old `pendingFileSurfaceIdsByProject` (project-keyed,
   * only because that was cheaper to read at that one call site — not a
   * deliberate "pending is project-scoped" design this store needs to
   * preserve). */
  pendingPaths: string[];
}

const EMPTY_THREAD_STATE: FileExplorerThreadState = {
  openPaths: [],
  activePath: null,
  revealLine: null,
  revealRequestId: 0,
  pendingPaths: [],
};

interface FileExplorerStoreState {
  byThreadKey: Record<string, FileExplorerThreadState>;
  /** Opens `relativePath` — adds it to `openPaths` if new (appended, so an
   * already-open file keeps its position), makes it active, and always
   * bumps `revealRequestId` (even for an already-open file — reopening the
   * same file with a new `line` must still trigger a scroll-to-line,
   * mirroring the old `rightPanelStore.openFile`'s identical behaviour). */
  openFile: (ref: ScopedThreadRef, relativePath: string, line?: number) => void;
  /** Switches to the explorer view WITHOUT closing any open file tabs —
   * unlike the old `rightPanelStore` model, where the explorer surface was
   * removed the instant a file opened. */
  showExplorer: (ref: ScopedThreadRef) => void;
  /** Removes `relativePath` from `openPaths`. If it was active, activates
   * its nearest remaining neighbor (previous by index, else next, else the
   * explorer) — same neighbor-fallback shape `rightPanelStore.closeSurface`
   * already uses for every other multi-surface kind. */
  closeFile: (ref: ScopedThreadRef, relativePath: string) => void;
  setPending: (ref: ScopedThreadRef, relativePath: string, pending: boolean) => void;
  /** Drops every open/pending path when the thread's workspace becomes
   * unavailable — same trigger and intent as `rightPanelStore`'s old
   * `reconcileFileSurfaces`, relocated here since "which files are open" is
   * now this store's concern, not the right panel's. */
  reconcileFiles: (ref: ScopedThreadRef, workspaceAvailable: boolean) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function normalizeRevealLine(line: number | undefined): number | null {
  if (line === undefined || !Number.isFinite(line)) return null;
  return Math.max(1, Math.trunc(line));
}

const updateThread = (
  byThreadKey: Record<string, FileExplorerThreadState>,
  threadKey: string,
  updater: (current: FileExplorerThreadState) => FileExplorerThreadState,
): Record<string, FileExplorerThreadState> => {
  const current = byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
  const next = updater(current);
  if (next === current) return byThreadKey;
  if (
    next.openPaths.length === 0 &&
    next.activePath === null &&
    next.pendingPaths.length === 0 &&
    next.revealLine === null &&
    next.revealRequestId === 0
  ) {
    if (!(threadKey in byThreadKey)) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  return { ...byThreadKey, [threadKey]: next };
};

export const useFileExplorerStore = create<FileExplorerStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      openFile: (ref, relativePath, line) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => ({
            ...current,
            openPaths: current.openPaths.includes(relativePath)
              ? current.openPaths
              : [...current.openPaths, relativePath],
            activePath: relativePath,
            revealLine: normalizeRevealLine(line),
            revealRequestId: current.revealRequestId + 1,
          })),
        })),
      showExplorer: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.activePath === null ? current : { ...current, activePath: null },
          ),
        })),
      closeFile: (ref, relativePath) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const index = current.openPaths.indexOf(relativePath);
            if (index < 0) return current;
            const openPaths = current.openPaths.filter((path) => path !== relativePath);
            const pendingPaths = current.pendingPaths.filter((path) => path !== relativePath);
            if (current.activePath !== relativePath) {
              return { ...current, openPaths, pendingPaths };
            }
            const fallback = openPaths[Math.min(index, openPaths.length - 1)] ?? null;
            return {
              ...current,
              openPaths,
              pendingPaths,
              activePath: fallback,
              // The closed file's own reveal position is never relevant to
              // whatever becomes active next, whether that's a neighboring
              // open file (no explicit "jump to a line" was requested for
              // it) or the explorer (nothing to reveal a line in).
              revealLine: null,
              // Reset to 0 only when falling all the way back to the
              // explorer — that's what lets `updateThread` prune this
              // thread's entry once every field is back to its default.
              // Left as-is for a neighbor fallback: harmless, since the
              // prune check requires openPaths to ALSO be empty, which it
              // isn't in that branch.
              revealRequestId: fallback === null ? 0 : current.revealRequestId,
            };
          }),
        })),
      setPending: (ref, relativePath, pending) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const has = current.pendingPaths.includes(relativePath);
            if (has === pending) return current;
            return {
              ...current,
              pendingPaths: pending
                ? [...current.pendingPaths, relativePath]
                : current.pendingPaths.filter((path) => path !== relativePath),
            };
          }),
        })),
      reconcileFiles: (ref, workspaceAvailable) =>
        set((state) => {
          if (workspaceAvailable) return state;
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey)) return state;
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey)) return state;
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          return { byThreadKey };
        }),
    }),
    {
      name: "t3code:file-explorer-state:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
    },
  ),
);

export function selectThreadFileExplorerState(
  byThreadKey: Record<string, FileExplorerThreadState>,
  ref: ScopedThreadRef | null | undefined,
): FileExplorerThreadState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
}
