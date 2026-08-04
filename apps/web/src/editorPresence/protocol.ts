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

// Server-side entries also carry `capabilities: string[]` (task #47's
// spec-editor-presence-commands.md) — deliberately NOT parsed or exposed
// here yet. This client has no command-dispatch UI to gate on it: that is
// task #52 (engine selector + Play/Stop toolbar), which is the surface
// that actually needs to know what an engine can do before offering a
// control for it. Wiring the field through with nothing yet reading it
// would be dead code; adding it lands together with #52.
export interface EditorPresenceEntry {
  readonly editor: { readonly id: string; readonly name: string; readonly version: string };
  readonly session: { readonly id: string };
  readonly workspace: { readonly root: string };
  readonly connected: boolean;
  readonly lastSeenAt: string;
  readonly selection: EditorPresenceSelection | null;
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
