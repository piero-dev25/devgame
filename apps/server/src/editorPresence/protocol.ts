/**
 * Editor Presence Protocol (EPP) v1 — wire types and frame parsing.
 *
 * Transport: WebSocket, one JSON object per text frame. See
 * docs/workbench/spec-editor-presence.md for the one-way (publish/subscribe)
 * protocol writeup and docs/workbench/spec-editor-presence-commands.md
 * (frozen) for the two-way command extension this file also implements:
 * `hello` (now with `capabilities`) / `selection` / `ping` / `commandResult`
 * inbound from a publisher (an editor plugin), and the `presence` fan-out
 * frame plus the `command` frame outbound to it.
 *
 * Deliberately schema-light: this is an external, third-party-extensible
 * protocol (`editor.id`, `items[].kind`, and `command.action` are open
 * strings, not a closed union — see the spec's "Deliberately left out"
 * section), so we validate shape defensively and drop malformed frames
 * rather than failing the whole connection on one bad message from an
 * in-development plugin.
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
 *
 * The outbound `command` frame follows the SAME rule as inbound `selection`,
 * not outbound `presence`: it addresses exactly ONE editor (the connection
 * it's written to), so it is FLAT — `{ v, type: "command", id, at, action,
 * params? }` — no wrapper, same as `selection`, unlike `presence`'s
 * per-editor nesting. See spec-editor-presence-commands.md's "Wire shape".
 */

/** Defensive cap on `items[]` — `GlobalObjectId.GetGlobalObjectIdSlow` is
 * named for its cost, and an unbounded array from a runaway multi-select
 * would otherwise get echoed to every subscriber on every frame. */
export const EDITOR_PRESENCE_MAX_ITEMS = 64;

/**
 * Application-range close codes (RFC 6455 §7.4.2, >= 4000) this route uses
 * to reject a publisher — collected here as the single source of truth so
 * the route and the registry (which needs `sessionSuperseded` to close a
 * connection it doesn't otherwise own) don't duplicate the numbers.
 * `missingCredential`/`invalidCredential` are the Godot client's
 * credential-class set (stop retrying); everything else here is
 * deliberately outside that set so engine clients keep retrying — the
 * server said why, and none of these mean "fix your token."
 *
 * DELIBERATELY NOT extended for commands. This set is SATURATED: every
 * shipped client (Godot, Unity, the web app) treats an unrecognised code
 * >= 4000 as "keep retrying," so a new code cannot be introduced without
 * shipping client updates first — see spec-editor-presence-commands.md's
 * "Rules that are easy to get wrong". A failed or refused command is an
 * in-band `commandResult` with `ok: false`, never a close code.
 */
export const EDITOR_PRESENCE_CLOSE_CODE = {
  missingCredential: 4400,
  invalidCredential: 4401,
  sessionSuperseded: 4402,
  malformedHello: 4403,
  internalError: 4500,
} as const;

/** A publisher's declared capability set (`hello.capabilities`) — see
 * spec-editor-presence-commands.md's "Capability advertisement" table.
 * Open strings, matching `editor.id` / `items[].kind`'s existing
 * open-string philosophy: engines differ in what they can do, and new
 * actions will be added without a protocol version bump. */
export type EditorPresenceCapability = string;

/** Applied when a `hello` frame omits `capabilities` entirely. This is
 * deliberately EMPTY, not `["play", "stop"]` — no shipped plugin (Godot,
 * Unity, Unreal) implements commands yet, so a permissive default would
 * advertise play/stop for every publisher currently in the field, none of
 * which can honour it: an enabled Play button, a ten-second wait, and a
 * timeout — precisely what the capability table exists to prevent. See
 * spec-editor-presence-commands.md's "Capability advertisement": "A `hello`
 * with no `capabilities` key means `[]` — no commands." An older plugin
 * still keeps working under `[]` — it does exactly what it could already
 * do (publish selection); it just doesn't claim a capability it doesn't
 * have. A default that claims a capability is a lie whenever it's wrong; a
 * default that claims none is merely conservative. */
export const DEFAULT_EDITOR_PRESENCE_CAPABILITIES: ReadonlyArray<EditorPresenceCapability> = [];

/** Result of one command round-trip, mirroring the inbound `commandResult`
 * frame shape — used both for the parsed wire frame and for the outcome the
 * server-side dispatcher (`EditorPresenceRoute.ts`'s `dispatchEditorCommand`)
 * resolves with, whether that outcome came from the engine, from a local
 * rejection (missing scope, rate limit, no connected editor), or from a
 * timeout. `error` is a short, machine-readable reason — spec's own words —
 * never a human sentence. */
export type EditorPresenceCommandOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

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
      readonly capabilities: ReadonlyArray<EditorPresenceCapability>;
    }
  | { readonly type: "selection"; readonly selection: EditorPresenceSelection }
  | { readonly type: "ping" }
  | ({ readonly type: "commandResult"; readonly id: string } & EditorPresenceCommandOutcome);

export interface EditorPresenceEntry {
  readonly editor: EditorPresenceEditorIdentity;
  readonly session: { readonly id: string };
  readonly workspace: { readonly root: string };
  readonly connected: true;
  readonly lastSeenAt: string;
  readonly selection: EditorPresenceSelection | null;
  readonly capabilities: ReadonlyArray<EditorPresenceCapability>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * `seq` must be a non-negative safe integer, not merely "finite" —
 * `Number.isFinite(1e308)` is true, and the registry's monotonic guard
 * (`seq <= existing.selection.seq`) has no way to recover from a bogus
 * astronomical value once accepted: every subsequent legitimate seq is
 * `<=` it forever, permanently wedging that publisher's selection updates
 * until it sends a fresh `hello` (a new registry record starts `selection:
 * null`). Measured live: seq=1e308 accepted, then seq=1,2,100 all silently
 * dropped afterward. `Number.isSafeInteger` bounds this to +/-2^53-1,
 * which is far more than any real monotonic counter needs.
 */
function isValidSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// KNOWN GAP, deliberately not fixed here (flagged by a live critic pass,
// lower priority than the hello/seq bugs above it): a bad item (missing or
// blank label, non-string fields) is dropped from `items[]` with no
// signal, so a `selection` frame can silently arrive with fewer items than
// the user actually selected — the same "connection looks healthy, data is
// wrong" shape as the malformed-hello bug, just at item granularity rather
// than frame granularity. Not fixed now because a coded close per bad item
// would also kill every OTHER valid item in the same frame, which is a
// worse outcome than a partial frame; this needs its own design (e.g. a
// per-item warning channel) rather than reusing the hello mechanism as-is.
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

/**
 * `undefined` (the key was absent) resolves to
 * `DEFAULT_EDITOR_PRESENCE_CAPABILITIES` — an older plugin that predates
 * commands keeps working instead of appearing capability-less. Anything
 * PRESENT but malformed (not an array, or containing a non-string /
 * blank-string entry) returns `null`, the same "fail loud" treatment every
 * other hello field gets — a publisher that thinks it correctly declared
 * `["play","stop","step"]` deserves to find out its shape was wrong, not
 * have it silently downgraded to the empty default.
 */
function parseCapabilities(value: unknown): ReadonlyArray<EditorPresenceCapability> | null {
  if (value === undefined) return DEFAULT_EDITOR_PRESENCE_CAPABILITIES;
  if (!Array.isArray(value)) return null;
  const capabilities: string[] = [];
  for (const item of value) {
    if (!isNonEmptyString(item)) return null;
    capabilities.push(item);
  }
  return capabilities;
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
  const capabilities = parseCapabilities(value.capabilities);
  if (capabilities === null) return null;
  return {
    type: "hello",
    editor: { id: editor.id, name: editor.name, version: editor.version },
    session: { id: session.id },
    workspace: { root: workspace.root },
    capabilities,
  };
}

/**
 * Distinguishes "this text is not (or is not parseable as) a `hello` frame
 * at all" (`null` — the caller ignores it exactly as before, no behavior
 * change) from "this IS a `v:1 type:'hello'` frame but fails validation"
 * (a human-readable reason). A publisher that thinks it said hello has no
 * other way to find out it never got registered — pinging still works,
 * since ping doesn't require a prior hello, so the connection looks
 * perfectly healthy while no subscriber will ever see it. The caller
 * (EditorPresenceRoute.ts) uses this to reject the connection loudly with
 * a coded close instead of the previous silent drop.
 *
 * Deliberately separate from `parseHello` rather than changing its return
 * type: `parseHello`'s `null` still means the same thing everywhere else
 * it's used, and every OTHER frame type keeps the existing
 * drop-and-say-nothing behavior — only hello gets this treatment, per the
 * scope the owner set.
 */
export function describeHelloValidationFailure(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || parsed.type !== "hello") return null;

  const editor = parsed.editor;
  if (!isRecord(editor)) return "hello.editor must be an object";
  if (!isNonEmptyString(editor.id)) return "hello.editor.id must be a non-empty string";
  if (!isNonEmptyString(editor.name)) return "hello.editor.name must be a non-empty string";
  if (!isNonEmptyString(editor.version)) return "hello.editor.version must be a non-empty string";

  const session = parsed.session;
  if (!isRecord(session) || !isNonEmptyString(session.id)) {
    return "hello.session.id must be a non-empty string";
  }

  const workspace = parsed.workspace;
  if (!isRecord(workspace) || !isNonEmptyString(workspace.root)) {
    return "hello.workspace.root must be a non-empty string";
  }

  const capabilities = parsed.capabilities;
  if (
    capabilities !== undefined &&
    (!Array.isArray(capabilities) || capabilities.some((item) => !isNonEmptyString(item)))
  ) {
    return "hello.capabilities must be an array of non-empty strings when present";
  }

  return null; // valid hello — nothing to describe
}

// `value` is the inbound frame itself — `seq`/`at`/`items` are read from
// its top level, NOT from a nested `value.selection`. See the module doc
// comment: nesting them (matching the outbound `presence` shape) parses to
// null here and the frame is silently dropped, not rejected loudly.
function parseSelection(value: Record<string, unknown>): EditorPresenceInboundFrame | null {
  if (!isValidSeq(value.seq)) return null;
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
 * `{ id, ok: true }` or `{ id, ok: false, error }` — dropped (not loudly
 * rejected) if malformed, same treatment as `selection`/`ping`: a
 * `commandResult` isn't part of the connection-establishment handshake the
 * way `hello` is, so there's no equivalent "publisher thinks it worked but
 * silently didn't" failure mode to guard against here — the CALLER awaiting
 * this specific command's outcome (see `EditorPresenceRegistry.ts`'s
 * `sendCommand`) simply times out instead, which is already surfaced.
 */
function parseCommandResult(value: Record<string, unknown>): EditorPresenceInboundFrame | null {
  if (!isNonEmptyString(value.id)) return null;
  if (value.ok === true) return { type: "commandResult", id: value.id, ok: true };
  if (value.ok === false) {
    if (!isNonEmptyString(value.error)) return null;
    return { type: "commandResult", id: value.id, ok: false, error: value.error };
  }
  return null;
}

/**
 * Parse one inbound text frame from a publisher. Returns `null` for anything
 * malformed — the caller drops the frame and keeps the connection open,
 * matching the protocol's open/lenient design rather than the strict
 * decode-or-fail style used for our own internal RPC wire.
 *
 * KNOWN GAP, flagged by a live critic pass and deliberately not fixed here
 * (out of scope, not one of the four bugs fixed in this pass): `v !== 1`
 * drops silently, same as any other malformed frame — there is no version
 * negotiation at all. A future v2 publisher would look connected and dead,
 * exactly like the malformed-hello bug this file DOES fix, just keyed on
 * `v` instead of frame shape. Worth its own design pass if/when a v2 ever
 * ships, not a one-line fix to bolt on here.
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
    case "commandResult":
      return parseCommandResult(parsed);
    default:
      return null;
  }
}

/** Server → subscriber `presence` frame: full state of every connected publisher. */
export function buildPresenceFrame(editors: ReadonlyArray<EditorPresenceEntry>): string {
  return JSON.stringify({ v: 1, type: "presence", editors });
}

/**
 * Server → engine `command` frame — FLAT, not nested, per the module doc's
 * wire-shape note: a command addresses exactly ONE editor (the connection
 * it's written to), the same rule that makes inbound `selection` flat.
 * `at` is caller-supplied rather than computed here (`new Date()` inside a
 * "pure" builder is exactly the kind of hidden wall-clock dependency this
 * codebase avoids — see `EditorPresenceRegistry.ts`'s `nowIso`, which goes
 * through Effect's `DateTime.now` so callers stay testable against a
 * controllable clock). `params` is omitted from the frame entirely when
 * absent, rather than serialized as `params: undefined`. */
export function buildCommandFrame(
  id: string,
  at: string,
  action: string,
  params?: Record<string, unknown>,
): string {
  return JSON.stringify({
    v: 1,
    type: "command",
    id,
    at,
    action,
    ...(params !== undefined ? { params } : {}),
  });
}

export function buildPongFrame(): string {
  return JSON.stringify({ v: 1, type: "pong" });
}
