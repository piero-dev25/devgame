/**
 * Pure in-memory fan-out for the Editor Presence Protocol, with
 * last-known-state retention per publisher session. Nothing on disk, nothing
 * per-thread, no knowledge of what a GameObject is — see
 * docs/workbench/spec-editor-presence.md.
 *
 * Presence is a level, not an edge: every publisher mutation replaces that
 * publisher's full record, and every subscriber broadcast carries the full
 * set of connected publishers. A dropped frame or a mid-broadcast reconnect
 * is self-healing because the next frame — or the next subscriber
 * registration — always carries complete state.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  buildPresenceFrame,
  EDITOR_PRESENCE_CLOSE_CODE,
  type EditorPresenceEditorIdentity,
  type EditorPresenceEntry,
  type EditorPresenceSelection,
} from "./protocol.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** A local, hard cap on connection counts — this is a per-machine local dev
 * feature, not a multi-tenant service, so a handful of editors and a
 * handful of chat clients is the entire expected population. Existing
 * connections (a reconnect that takes over a session, per
 * `registerPublisher` below) never count against this — only a genuinely
 * NEW session id or a genuinely new subscriber can be refused. Refusal is
 * logged, not silent, per the owner's "cap them, and log when you refuse"
 * instruction. */
const MAX_PUBLISHERS = 64;
const MAX_SUBSCRIBERS = 64;

export type EditorPresenceSubscriberSend = (frame: string) => Effect.Effect<void>;

/** Closes the connection this record belongs to with an application close
 * code + human-readable reason — how the registry evicts a connection it
 * doesn't otherwise own a socket for (the route owns the actual write; the
 * registry only gets a callback closed over it). */
export type EditorPresenceCloseConnection = (code: number, reason: string) => Effect.Effect<void>;

const noopClose: EditorPresenceCloseConnection = () => Effect.void;

/**
 * Opaque per-connection identity. Publishers are keyed by their own
 * `session.id` (so a reconnect after a Unity domain reload replaces the
 * stale entry instead of duplicating a chip — see the protocol's `hello`
 * doc), but two different TCP connections can legitimately claim the same
 * `session.id` in flight during a reconnect race. This token guards updates
 * and removal so a slow-closing stale connection's finalizer can never clobber
 * the fresh connection that already replaced it.
 */
export type EditorPresenceConnectionToken = symbol;

interface PublisherRecord extends EditorPresenceEntry {
  readonly connectionToken: EditorPresenceConnectionToken;
  readonly close: EditorPresenceCloseConnection;
}

interface RegistryState {
  readonly publishers: ReadonlyMap<string, PublisherRecord>;
  readonly subscribers: ReadonlySet<EditorPresenceSubscriberSend>;
}

function toEntry(record: PublisherRecord): EditorPresenceEntry {
  return {
    editor: record.editor,
    session: record.session,
    workspace: record.workspace,
    connected: record.connected,
    lastSeenAt: record.lastSeenAt,
    selection: record.selection,
  };
}

/** Explicit result type for registerPublisher's Ref.modify — without this,
 * the two branches' object-literal shapes don't unify into one type TS can
 * infer, since a bare `{ refused: true }` vs `{ refused: false, frame,
 * subscribers, supersededClose }` have structurally different keys. */
type RegisterPublisherResult =
  | { readonly refused: true }
  | {
      readonly refused: false;
      readonly frame: string;
      readonly subscribers: ReadonlySet<EditorPresenceSubscriberSend>;
      readonly supersededClose: EditorPresenceCloseConnection | null;
    };

/** Same reasoning as RegisterPublisherResult, for addSubscriber. */
type AddSubscriberResult = { readonly added: boolean; readonly frame: string };

export class EditorPresenceRegistry extends Context.Service<
  EditorPresenceRegistry,
  {
    readonly newConnectionToken: () => EditorPresenceConnectionToken;
    /**
     * Registers (or takes over) a publisher session. `close` closes THIS
     * connection later, if some OTHER connection ever claims the same
     * `sessionId` — see the SESSION TAKEOVER doc below. Optional and
     * defaulting to a no-op so existing single-connection callers/tests
     * don't need to thread one through.
     */
    readonly registerPublisher: (
      sessionId: string,
      connectionToken: EditorPresenceConnectionToken,
      hello: {
        readonly editor: EditorPresenceEditorIdentity;
        readonly workspace: { readonly root: string };
      },
      close?: EditorPresenceCloseConnection,
    ) => Effect.Effect<void>;
    readonly updatePublisherSelection: (
      sessionId: string,
      connectionToken: EditorPresenceConnectionToken,
      selection: EditorPresenceSelection,
    ) => Effect.Effect<void>;
    readonly removePublisher: (
      sessionId: string,
      connectionToken: EditorPresenceConnectionToken,
    ) => Effect.Effect<void>;
    /** Adds the subscriber and atomically returns the frame representing
     * current state at the moment of registration — race-free against a
     * concurrent publisher broadcast. */
    readonly addSubscriber: (send: EditorPresenceSubscriberSend) => Effect.Effect<string>;
    readonly removeSubscriber: (send: EditorPresenceSubscriberSend) => Effect.Effect<void>;
  }
>()("t3/editorPresence/EditorPresenceRegistry") {}

export const make = Effect.gen(function* EditorPresenceRegistryMake() {
  const stateRef = yield* Ref.make<RegistryState>({
    publishers: new Map(),
    subscribers: new Set(),
  });

  /** Applies a publisher-map mutation, then broadcasts the resulting full
   * state to every currently-registered subscriber. `mutate` returns `null`
   * to signal "no-op" (e.g. a stale connection token, or an out-of-order
   * `seq`) so we skip an unnecessary broadcast. */
  const applyPublisherChange = (
    mutate: (
      publishers: ReadonlyMap<string, PublisherRecord>,
    ) => ReadonlyMap<string, PublisherRecord> | null,
  ) =>
    Effect.gen(function* () {
      const broadcastPlan = yield* Ref.modify(stateRef, (current) => {
        const nextPublishers = mutate(current.publishers);
        if (nextPublishers === null) {
          return [null, current] as const;
        }
        const next = { ...current, publishers: nextPublishers };
        const frame = buildPresenceFrame(Array.from(nextPublishers.values(), toEntry));
        return [{ frame, subscribers: current.subscribers }, next] as const;
      });
      if (broadcastPlan === null) return;
      yield* Effect.forEach(broadcastPlan.subscribers, (send) => send(broadcastPlan.frame), {
        discard: true,
      });
    });

  /**
   * SESSION TAKEOVER, decided deliberately rather than left silent for
   * either party (a live critic pass measured the previous unconditional
   * overwrite as a total, silent hijack: a second connection claiming an
   * existing `session.id` replaced the editor name, workspace root and
   * selection with zero signal to the original connection, which stayed
   * OPEN and kept publishing into a record every one of its writes was now
   * discarded from by the connection-token guard).
   *
   * The take-over itself is intentional and unchanged — it's what makes a
   * reconnect after a Unity domain reload replace the stale chip instead
   * of duplicating it, and rejecting the claim outright would break that.
   * What changes: the connection being superseded is now told, via a
   * coded close on ITS OWN socket (`sessionSuperseded`, outside the
   * credential-close class, so a well-behaved client can retry if it
   * wants to). This is why `PublisherRecord` carries a `close` callback —
   * the registry doesn't own a socket, only a way to ask the route to
   * close the one it superseded.
   */
  const registerPublisher: EditorPresenceRegistry["Service"]["registerPublisher"] = (
    sessionId,
    connectionToken,
    hello,
    close = noopClose,
  ) =>
    Effect.gen(function* () {
      const lastSeenAt = yield* nowIso;
      const result = yield* Ref.modify(
        stateRef,
        (current): readonly [RegisterPublisherResult, RegistryState] => {
          const existing = current.publishers.get(sessionId);
          const isNewSession = existing === undefined;

          if (isNewSession && current.publishers.size >= MAX_PUBLISHERS) {
            return [{ refused: true }, current];
          }

          const supersededClose =
            existing !== undefined && existing.connectionToken !== connectionToken
              ? existing.close
              : null;

          const publishers = new Map(current.publishers);
          publishers.set(sessionId, {
            connectionToken,
            close,
            editor: hello.editor,
            session: { id: sessionId },
            workspace: hello.workspace,
            connected: true,
            lastSeenAt,
            selection: null,
          });
          const next = { ...current, publishers };
          const frame = buildPresenceFrame(Array.from(publishers.values(), toEntry));
          return [
            { refused: false, frame, subscribers: current.subscribers, supersededClose },
            next,
          ];
        },
      );

      if (result.refused) {
        yield* Effect.logWarning(
          "editor-presence: refused a new publisher registration, at capacity",
          { sessionId, cap: MAX_PUBLISHERS },
        );
        return;
      }

      if (result.supersededClose !== null) {
        // EditorPresenceCloseConnection's own type guarantees it never
        // fails (the route's implementation already swallows its own
        // write errors before returning) — no catch needed here.
        yield* result.supersededClose(
          EDITOR_PRESENCE_CLOSE_CODE.sessionSuperseded,
          "session claimed by a new connection",
        );
      }

      yield* Effect.forEach(result.subscribers, (send) => send(result.frame), { discard: true });
    });

  const updatePublisherSelection: EditorPresenceRegistry["Service"]["updatePublisherSelection"] = (
    sessionId,
    connectionToken,
    selection,
  ) =>
    Effect.gen(function* () {
      const lastSeenAt = yield* nowIso;
      yield* applyPublisherChange((publishers) => {
        const existing = publishers.get(sessionId);
        if (!existing || existing.connectionToken !== connectionToken) return null;
        if (existing.selection && selection.seq <= existing.selection.seq) return null;
        const next = new Map(publishers);
        next.set(sessionId, { ...existing, selection, lastSeenAt });
        return next;
      });
    });

  const removePublisher: EditorPresenceRegistry["Service"]["removePublisher"] = (
    sessionId,
    connectionToken,
  ) =>
    applyPublisherChange((publishers) => {
      const existing = publishers.get(sessionId);
      if (!existing || existing.connectionToken !== connectionToken) return null;
      const next = new Map(publishers);
      next.delete(sessionId);
      return next;
    });

  const addSubscriber: EditorPresenceRegistry["Service"]["addSubscriber"] = (send) =>
    Effect.gen(function* () {
      const result = yield* Ref.modify(
        stateRef,
        (current): readonly [AddSubscriberResult, RegistryState] => {
          if (current.subscribers.size >= MAX_SUBSCRIBERS) {
            const frame = buildPresenceFrame(Array.from(current.publishers.values(), toEntry));
            return [{ added: false, frame }, current];
          }
          const subscribers = new Set(current.subscribers);
          subscribers.add(send);
          const frame = buildPresenceFrame(Array.from(current.publishers.values(), toEntry));
          return [
            { added: true, frame },
            { ...current, subscribers },
          ];
        },
      );
      if (!result.added) {
        yield* Effect.logWarning("editor-presence: refused a new subscriber, at capacity", {
          cap: MAX_SUBSCRIBERS,
        });
      }
      return result.frame;
    });

  const removeSubscriber: EditorPresenceRegistry["Service"]["removeSubscriber"] = (send) =>
    Ref.update(stateRef, (current) => {
      if (!current.subscribers.has(send)) return current;
      const subscribers = new Set(current.subscribers);
      subscribers.delete(send);
      return { ...current, subscribers };
    });

  return EditorPresenceRegistry.of({
    newConnectionToken: () => Symbol("editor-presence-connection"),
    registerPublisher,
    updatePublisherSelection,
    removePublisher,
    addSubscriber,
    removeSubscriber,
  });
});

export const layer = Layer.effect(EditorPresenceRegistry, make);
