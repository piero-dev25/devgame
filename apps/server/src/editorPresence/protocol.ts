/**
 * Editor Presence Protocol (EPP) v1 — wire types and frame parsing.
 *
 * Transport: WebSocket, one JSON object per text frame. See
 * docs/workbench/spec-editor-presence.md for the full protocol writeup; this
 * file implements only what step 1 needs: `hello` / `selection` / `ping` from
 * a publisher (an editor plugin), and the `presence` fan-out frame sent to
 * subscribers (the chat client).
 *
 * Deliberately schema-light: this is an external, third-party-extensible
 * protocol (`editor.id` and `items[].kind` are open strings, not a closed
 * union — see the spec's "Deliberately left out" section), so we validate
 * shape defensively and drop malformed frames rather than failing the whole
 * connection on one bad message from an in-development plugin.
 *
 * THE WIRE SHAPE IS ASYMMETRIC — read this before touching either side.
 * A publisher's inbound `selection` frame is FLAT:
 * `{ v, type: "selection", seq, at, items }` — `seq`/`at`/`items` are
 * top-level, siblings of `type`. The outbound `presence` frame a subscriber
 * receives nests the *same* fields one level deeper, per connected editor:
 * `{ v, type: "presence", editors: [{ ..., selection: { seq, at, items } } ] }`.
 * This is not a typo to "fix" into symmetry: the inbound frame describes one
 * editor's own state (no wrapper needed), the outbound frame is a set of
 * editors (each needs a key to hang its state off of). A publisher that
 * nests its outbound-shaped `{seq,at,items}` under a `selection` key when
 * sending an inbound frame fails *silently* — `parseSelection` below just
 * won't find `seq`/`at`/`items` at the top level and drops the frame, so the
 * connection looks healthy while no selection ever arrives. This has already
 * cost a wrong implementation once (see the "docs: the chain works" commit
 * for the live repro) — get the shape right the first time.
 */

/** Defensive cap on `items[]` — `GlobalObjectId.GetGlobalObjectIdSlow` is
 * named for its cost, and an unbounded array from a runaway multi-select
 * would otherwise get echoed to every subscriber on every frame. */
export const EDITOR_PRESENCE_MAX_ITEMS = 64;

export interface EditorPresenceEditorIdentity {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

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

export type EditorPresenceInboundFrame =
  | {
      readonly type: "hello";
      readonly editor: EditorPresenceEditorIdentity;
      readonly session: { readonly id: string };
      readonly workspace: { readonly root: string };
    }
  | { readonly type: "selection"; readonly selection: EditorPresenceSelection }
  | { readonly type: "ping" };

export interface EditorPresenceEntry {
  readonly editor: EditorPresenceEditorIdentity;
  readonly session: { readonly id: string };
  readonly workspace: { readonly root: string };
  readonly connected: true;
  readonly lastSeenAt: string;
  readonly selection: EditorPresenceSelection | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseItem(value: unknown): EditorPresenceItem | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.label)) return null;
  return {
    id: isNonEmptyString(value.id) ? value.id : null,
    kind: isNonEmptyString(value.kind) ? value.kind : "unknown",
    label: value.label,
    path: isNonEmptyString(value.path) ? value.path : null,
    detail: isNonEmptyString(value.detail) ? value.detail : null,
  };
}

function parseHello(value: Record<string, unknown>): EditorPresenceInboundFrame | null {
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
    type: "hello",
    editor: { id: editor.id, name: editor.name, version: editor.version },
    session: { id: session.id },
    workspace: { root: workspace.root },
  };
}

// `value` is the inbound frame itself — `seq`/`at`/`items` are read from
// its top level, NOT from a nested `value.selection`. See the module doc
// comment: nesting them (matching the outbound `presence` shape) parses to
// null here and the frame is silently dropped, not rejected loudly.
function parseSelection(value: Record<string, unknown>): EditorPresenceInboundFrame | null {
  if (typeof value.seq !== "number" || !Number.isFinite(value.seq)) return null;
  if (!isNonEmptyString(value.at)) return null;
  if (!Array.isArray(value.items)) return null;
  const items: EditorPresenceItem[] = [];
  for (const rawItem of value.items) {
    const item = parseItem(rawItem);
    if (item) items.push(item);
    if (items.length >= EDITOR_PRESENCE_MAX_ITEMS) break;
  }
  return { type: "selection", selection: { seq: value.seq, at: value.at, items } };
}

/**
 * Parse one inbound text frame from a publisher. Returns `null` for anything
 * malformed — the caller drops the frame and keeps the connection open,
 * matching the protocol's open/lenient design rather than the strict
 * decode-or-fail style used for our own internal RPC wire.
 */
export function parseEditorPresenceInboundFrame(raw: string): EditorPresenceInboundFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.type !== "string") return null;
  switch (parsed.type) {
    case "hello":
      return parseHello(parsed);
    case "selection":
      return parseSelection(parsed);
    case "ping":
      return { type: "ping" };
    default:
      return null;
  }
}

/** Server → subscriber `presence` frame: full state of every connected publisher. */
export function buildPresenceFrame(editors: ReadonlyArray<EditorPresenceEntry>): string {
  return JSON.stringify({ v: 1, type: "presence", editors });
}

export function buildPongFrame(): string {
  return JSON.stringify({ v: 1, type: "pong" });
}
