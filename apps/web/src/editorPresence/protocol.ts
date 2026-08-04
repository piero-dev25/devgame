// Editor Presence Protocol (EPP) v1 — subscriber-side wire types.
//
// See docs/workbench/spec-editor-presence.md and
// apps/server/src/editorPresence/protocol.ts (the server-side twin of this
// file — kept in sync by hand since this route deliberately has no
// packages/contracts entry). The web client only ever receives `presence`
// frames; it never publishes.

export interface EditorPresenceItem {
  readonly id: string | null;
  readonly kind: string;
  readonly label: string;
  readonly path: string | null;
  readonly detail: string | null;
}

export interface EditorPresenceSelection {
  readonly seq: number;
  readonly at: string;
  readonly items: ReadonlyArray<EditorPresenceItem>;
}

/**
 * A publisher's declared capability set (`hello.capabilities`) — see
 * spec-editor-presence-commands.md's "Capability advertisement" table. Open
 * strings, matching `editor.id`/`items[].kind`'s existing open-string
 * philosophy — mirrors the server's own `EditorPresenceCapability` (also
 * `string`).
 *
 * Absent or malformed on the wire means `[]`, never a guessed default — see
 * `parseCapabilities` below. A default that claims a capability is a lie
 * whenever it's wrong; a default that claims none is merely conservative
 * (server-side doc comment, restated here since this file is this route's
 * hand-maintained twin, not a shared package).
 */
export type EditorPresenceCapability = string;

/**
 * Play/pause/stop state a publisher reports about itself — see
 * spec-unity-play-stop.md's ruling ("acceptance is an edge, play state is a
 * level"). The toolbar (#52) drives its Play/Pause/Stop button states off
 * THIS field, never off a command reply: a domain reload (Unity entering or
 * exiting play mode) can kill the connection before any commandResult is
 * sent, but presence is a level, republished in full on every reconnect, so
 * the true state always arrives here regardless.
 *
 * Deliberately a CLOSED union, unlike `capabilities`/`editor.id`/
 * `items[].kind` — mirrors the server's own `EditorPresencePlayState`: play
 * state is a physical concept every publisher in this repo computes from
 * its own engine API, with no third-party-extensibility case for a fourth
 * value, so the toolbar can switch on it exhaustively.
 */
export type EditorPresencePlayState = "stopped" | "playing" | "paused";

const EDITOR_PRESENCE_PLAY_STATES: ReadonlySet<string> = new Set<EditorPresencePlayState>([
  "stopped",
  "playing",
  "paused",
]);

function isEditorPresencePlayState(value: unknown): value is EditorPresencePlayState {
  return typeof value === "string" && EDITOR_PRESENCE_PLAY_STATES.has(value);
}

export interface EditorPresenceEntry {
  readonly editor: { readonly id: string; readonly name: string; readonly version: string };
  readonly session: { readonly id: string };
  readonly workspace: { readonly root: string };
  readonly connected: boolean;
  readonly lastSeenAt: string;
  readonly selection: EditorPresenceSelection | null;
  readonly capabilities: ReadonlyArray<EditorPresenceCapability>;
  /**
   * The publisher's own most recently reported play/pause state, or `null`
   * when it has never reported one — an older publisher that predates this
   * field, or a fresh registration that hasn't sent its first `playState`
   * frame yet. Also the correct steady state for a publisher whose
   * `capabilities` don't include `"play"`/`"stop"` at all — there is
   * nothing to report, so the toolbar should show no play-state control
   * rather than guessing "stopped".
   */
  readonly playState: EditorPresencePlayState | null;
}

export interface EditorPresenceFrame {
  readonly v: 1;
  readonly type: "presence";
  readonly editors: ReadonlyArray<EditorPresenceEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseItem(value: unknown): EditorPresenceItem | null {
  if (!isRecord(value) || !isNonEmptyString(value.label)) return null;
  return {
    id: isNonEmptyString(value.id) ? value.id : null,
    kind: isNonEmptyString(value.kind) ? value.kind : "unknown",
    label: value.label,
    path: isNonEmptyString(value.path) ? value.path : null,
    detail: isNonEmptyString(value.detail) ? value.detail : null,
  };
}

function parseSelection(value: unknown): EditorPresenceSelection | null {
  if (!isRecord(value)) return null;
  if (typeof value.seq !== "number") return null;
  if (!isNonEmptyString(value.at)) return null;
  if (!Array.isArray(value.items)) return null;
  const items: EditorPresenceItem[] = [];
  for (const raw of value.items) {
    const item = parseItem(raw);
    if (item) items.push(item);
  }
  return { seq: value.seq, at: value.at, items };
}

/**
 * Defensive, not strict: an entry with a missing or malformed
 * `capabilities` field still parses (as `[]`), mirroring the server's own
 * "absent means unknown, not a lie" default rather than dropping the whole
 * entry over one optional field. Non-string items are dropped individually
 * — the same per-item tolerance `parseItem`'s caller already uses for
 * `selection.items`.
 */
function parseCapabilities(value: unknown): ReadonlyArray<EditorPresenceCapability> {
  if (!Array.isArray(value)) return [];
  const capabilities: string[] = [];
  for (const item of value) {
    if (isNonEmptyString(item)) capabilities.push(item);
  }
  return capabilities;
}

function parseEntry(value: unknown): EditorPresenceEntry | null {
  if (!isRecord(value)) return null;
  const editor = value.editor;
  const session = value.session;
  const workspace = value.workspace;
  if (
    !isRecord(editor) ||
    !isNonEmptyString(editor.id) ||
    !isNonEmptyString(editor.name) ||
    !isNonEmptyString(editor.version)
  ) {
    return null;
  }
  if (!isRecord(session) || !isNonEmptyString(session.id)) return null;
  if (!isRecord(workspace) || !isNonEmptyString(workspace.root)) return null;
  return {
    editor: { id: editor.id, name: editor.name, version: editor.version },
    session: { id: session.id },
    workspace: { root: workspace.root },
    connected: value.connected === true,
    lastSeenAt: isNonEmptyString(value.lastSeenAt) ? value.lastSeenAt : "",
    selection: parseSelection(value.selection),
    capabilities: parseCapabilities(value.capabilities),
    playState: isEditorPresencePlayState(value.playState) ? value.playState : null,
  };
}

/**
 * Parses a `presence` frame from the server. Returns `null` for anything
 * malformed or of a different `type` — the caller should ignore the frame
 * and keep waiting for the next one rather than tearing down the socket.
 */
export function parseEditorPresenceFrame(raw: string): EditorPresenceFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || parsed.type !== "presence") return null;
  if (!Array.isArray(parsed.editors)) return null;
  const editors: EditorPresenceEntry[] = [];
  for (const raw of parsed.editors) {
    const entry = parseEntry(raw);
    if (entry) editors.push(entry);
  }
  return { v: 1, type: "presence", editors };
}
