// Pure, framework-free matching logic split from any component for the same
// reason `resolveFilesDockPanelView.ts` is: it needs only TYPES from the
// wider app (never a runtime import), so a test can exercise it without
// pulling in the Web Worker chain a component import would drag along.
import type { EditorPresenceEntry } from "./protocol";

/**
 * The subset of a project's own fields this matcher actually needs — a
 * structural type, not `EnvironmentProject` itself, so this file (and its
 * test) never has to construct one of that type's many unrelated required
 * fields just to exercise matching logic.
 */
export interface ProjectWorkspaceRef {
  readonly workspaceRoot: string;
}

/**
 * Finds the connected editor publishing for a given project, by matching
 * `workspace.root` — the only identity Editor Presence publishers carry
 * that a project also has (see `spec-editor-presence.md`: a publisher's
 * `hello.workspace.root` is its own working directory, not any app-level
 * project id, since a third-party editor has no notion of a T3 project).
 *
 * Returns `null` when no editor is connected for this project's workspace
 * root — a normal, common state (no editor open), not an error — and the
 * toolbar's correct response is to show the engine selector with disabled
 * Play/Stop controls, not to hide the whole toolbar (the project's
 * `engineType` may still be known even with nothing connected right now).
 *
 * A trailing slash difference (`/repo` vs `/repo/`) is normalized away —
 * both this app and the plugins construct these paths independently and a
 * single stray separator must not silently produce "no editor connected"
 * for a project that plainly has one.
 */
export function resolveConnectedEditorForProject(
  editors: ReadonlyArray<EditorPresenceEntry>,
  project: ProjectWorkspaceRef | null,
): EditorPresenceEntry | null {
  if (!project) return null;
  const targetRoot = normalizeWorkspaceRoot(project.workspaceRoot);
  for (const entry of editors) {
    if (entry.connected && normalizeWorkspaceRoot(entry.workspace.root) === targetRoot) {
      return entry;
    }
  }
  return null;
}

function normalizeWorkspaceRoot(root: string): string {
  return root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root;
}
