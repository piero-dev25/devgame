// Ported (extension stripped) from gamedev-workbench's
// app/web/src/lib/layout/storage.ts. `createServerBackedLayoutStorage` was
// NOT ported: it PUTs/DELETEs against that app's own
// `/api/workspace/layout` route, which doesn't exist in this fork, and step
// 1's acceptance criteria (spec §"Acceptance", check 2) explicitly wants
// persistence provable via a `localStorage` key — so the browser-storage
// backend below is not just the fallback here, it's the whole story for
// step 1.
import { parseLayoutFile } from "./serialization";
import type { ParseLayoutFailureReason } from "./serialization";
import type { LayoutFile } from "./types";

/**
 * Distinguishes "nothing saved yet" from "something was saved but this build
 * can't use it" — the caller needs that distinction to show a dismissible
 * notice only in the latter case, not on a workspace's very first open.
 */
export type LoadLayoutResult =
  | { status: "empty" }
  | { status: "ok"; file: LayoutFile }
  | { status: "invalid"; reason: ParseLayoutFailureReason; message: string };

/**
 * Async on every method, not just the ones a network-backed adapter would
 * obviously need — keeping the interface uniform means `DockviewLayout`
 * doesn't need to know which backend it's holding.
 */
export interface LayoutStorage {
  load(workspaceId: string): Promise<LoadLayoutResult>;
  save(workspaceId: string, file: LayoutFile): Promise<void>;
  clear(workspaceId: string): Promise<void>;
}

const DEFAULT_NAMESPACE = "t3-workbench-dock:layout";

/**
 * `localStorage` is per-browser-origin, not per-workspace-file, but that's
 * exactly what step 1 needs: DockviewLayout's default storage when no
 * `storage` prop is supplied, and what acceptance check 2 inspects directly
 * (`dockview.grid.root` inside the stored JSON). Never throws: a corrupted
 * or version-mismatched stored payload comes back as a typed
 * `{status: "invalid"}` result rather than being thrown or silently
 * swallowed, so the caller can fall back to the default preset AND show the
 * required notice ("never crash on a bad layout").
 *
 * `localStorage` access itself can throw — Safari private browsing, a
 * storage-blocked profile, an exhausted quota — so every access below is
 * guarded. A blocked `getItem` is treated as "no saved layout" (the caller
 * falls back to the default preset, same as a workspace's first open); a
 * blocked `setItem`/`removeItem` is a no-op rather than a crash — the
 * workspace keeps working, it just can't persist right now.
 */
export function createLocalStorageLayoutStorage(
  namespace: string = DEFAULT_NAMESPACE,
): LayoutStorage {
  const keyFor = (workspaceId: string) => `${namespace}:${workspaceId}`;

  return {
    async load(workspaceId) {
      let raw: string | null;
      try {
        raw = window.localStorage.getItem(keyFor(workspaceId));
      } catch {
        return { status: "empty" };
      }
      if (raw === null) return { status: "empty" };

      const result = parseLayoutFile(raw);
      if (result.ok) return { status: "ok", file: result.file };
      return { status: "invalid", reason: result.reason, message: result.message };
    },
    async save(workspaceId, file) {
      try {
        window.localStorage.setItem(keyFor(workspaceId), JSON.stringify(file));
      } catch {
        // Can't persist right now — the in-memory layout is still fine;
        // never let a storage failure crash the workspace.
      }
    },
    async clear(workspaceId) {
      try {
        window.localStorage.removeItem(keyFor(workspaceId));
      } catch {
        // Same as save(): nothing useful to do but not crash.
      }
    },
  };
}

/** `YYYY-MM-DD`, from the UTC calendar date — stable and easy to assert on in tests. */
function isoDate(when: Date): string {
  return when.toISOString().slice(0, 10);
}

/**
 * Export filename for `DockviewLayoutHandle.exportLayout()`. Slugifies the
 * workspace name and stamps the date so exports from different
 * workspaces/days don't collide in a downloads folder.
 */
export function buildLayoutFilename(workspaceName: string, when: Date = new Date()): string {
  const slug = workspaceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug}-layout-${isoDate(when)}.json`;
}
