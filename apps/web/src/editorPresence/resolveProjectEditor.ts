// Pure, framework-free matching logic split from any component for the same
// reason `resolveFilesDockPanelView.ts` is: it needs only TYPES from the
// wider app (never a runtime import), so a test can exercise it without
// pulling in the Web Worker chain a component import would drag along.
import { normalizeWorkspaceRoot } from "@t3tools/shared/workspaceRootPath";

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
 *
 * STALE-PUBLISHER GUARD (2026-08-10, unity-playstate-presence.md
 * critique F3): more than one CONNECTED entry can legitimately share the
 * same workspace root at once. A crashed/force-quit editor leaves a
 * half-open registry entry behind — the server never writes `connected`
 * false on its own (no liveness sweep, and no publisher in this repo sends
 * a ping the server could time out on) — and a relaunched editor then
 * registers as a genuinely SECOND publisher (a fresh SessionState-backed
 * session id, so it lands as a distinct entry, not a takeover of the old
 * one). Among same-root connected matches, this now prefers the entry with
 * the newest `lastSeenAt` rather than the first one encountered — otherwise
 * the corpse's stale state (e.g. a stuck "playing") would outrank the live
 * editor forever, purely because of array position. Verified wire shape:
 * `EditorPresenceEntry.lastSeenAt` (this file's `protocol.ts`) is present on
 * every entry — the server stamps a fresh ISO-8601 UTC timestamp on every
 * hello AND on every subsequent selection/playState update
 * (`EditorPresenceRegistry.ts`), so a plain string comparison orders
 * correctly and a crashed publisher's `lastSeenAt` stops advancing the
 * moment it stops sending frames. This is the newest-`lastSeenAt` variant of
 * the guard, not the registration-order fallback the spec names for a wire
 * entry that omits the field entirely — this repo's entries never do. Also
 * fixes the same ambiguity for selection chips, which share this resolver.
 */
export function resolveConnectedEditorForProject(
  editors: ReadonlyArray<EditorPresenceEntry>,
  project: ProjectWorkspaceRef | null,
): EditorPresenceEntry | null {
  if (!project) return null;
  const targetRoot = normalizeWorkspaceRoot(project.workspaceRoot);
  let best: EditorPresenceEntry | null = null;
  for (const entry of editors) {
    if (!entry.connected || normalizeWorkspaceRoot(entry.workspace.root) !== targetRoot) continue;
    // `>=` rather than `>`: on an (unlikely) exact tie, prefer the entry
    // encountered later, which is also this resolver's fallback rule for a
    // publisher whose wire entry has no `lastSeenAt` at all.
    if (best === null || entry.lastSeenAt >= best.lastSeenAt) {
      best = entry;
    }
  }
  return best;
}

/**
 * Re-exported for existing callers (`store.ts`'s
 * `selectEditorPresenceChipsForProject`, task #71) — the real definition
 * now lives in `@t3tools/shared/workspaceRootPath` so a SERVER-side caller
 * (`UnitySetupProbe.ts`) can share the identical rule instead of writing a
 * third, subtly-different comparison site — precisely the class of bug #71
 * already was, just across the client/server boundary this time. See that
 * module's own doc comment for the full reasoning.
 */
export { normalizeWorkspaceRoot };
