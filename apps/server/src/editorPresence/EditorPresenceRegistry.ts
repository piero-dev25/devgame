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
  type EditorPresenceEditorIdentity,
  type EditorPresenceEntry,
  type EditorPresenceSelection,
} from "./protocol.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export type EditorPresenceSubscriberSend = (frame: string) => Effect.Effect<void>;

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

export class EditorPresenceRegistry extends Context.Service<
  EditorPresenceRegistry,
  {
    readonly newConnectionToken: () => EditorPresenceConnectionToken;
    readonly registerPublisher: (
      sessionId: string,
      connectionToken: EditorPresenceConnectionToken,
      hello: {
        readonly editor: EditorPresenceEditorIdentity;
        readonly workspace: { readonly root: string };
      },
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

  const registerPublisher: EditorPresenceRegistry["Service"]["registerPublisher"] = (
    sessionId,
    connectionToken,
    hello,
  ) =>
    Effect.gen(function* () {
      const lastSeenAt = yield* nowIso;
      yield* applyPublisherChange((publishers) => {
        const next = new Map(publishers);
        next.set(sessionId, {
          connectionToken,
          editor: hello.editor,
          session: { id: sessionId },
          workspace: hello.workspace,
          connected: true,
          lastSeenAt,
          selection: null,
        });
        return next;
      });
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
    Ref.modify(stateRef, (current) => {
      const subscribers = new Set(current.subscribers);
      subscribers.add(send);
      const frame = buildPresenceFrame(Array.from(current.publishers.values(), toEntry));
      return [frame, { ...current, subscribers }];
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
