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
 *
 * COMMANDS ARE THE OPPOSITE — see docs/workbench/spec-editor-presence-commands.md
 * (frozen). Each is an edge, delivered once, never queued and never replayed
 * on reconnect: `sendCommand` below looks up the CURRENT publisher record at
 * the moment it's called and fails immediately with `editor_not_connected`
 * if there isn't one — there is no queue to replay from, by construction,
 * not by a check that could be forgotten.
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  buildCommandFrame,
  buildPresenceFrame,
  DEFAULT_EDITOR_PRESENCE_CAPABILITIES,
  EDITOR_PRESENCE_CLOSE_CODE,
  type EditorPresenceCapability,
  type EditorPresenceCommandOutcome,
  type EditorPresenceEditorIdentity,
  type EditorPresenceEntry,
  type EditorPresencePlayState,
  type EditorPresenceSelection,
} from "./protocol.ts";

const nowDateTime = DateTime.now;
const nowIso = Effect.map(nowDateTime, DateTime.formatIso);

/** A modest per-session rate limit, per spec-editor-presence-commands.md's
 * "Bound the command rate" — the same reasoning as `EDITOR_PRESENCE_MAX_ITEMS`
 * (protocol.ts): a runaway caller must not be able to hammer an editor.
 * Exported so tests assert against the real value instead of a
 * hand-duplicated literal that could silently drift out of sync. */
export const COMMAND_RATE_LIMIT_MAX = 5;
export const COMMAND_RATE_LIMIT_WINDOW_MS = 2000;

/** How long `sendCommand` waits for a `commandResult` before giving up and
 * resolving `{ ok: false, error: "timeout" }` on the caller's behalf — a
 * hung or crashed engine must not hang the caller forever. Generous enough
 * for a real engine action (e.g. Unity recompiling before Play). Exported
 * for the same reason as `COMMAND_RATE_LIMIT_MAX` above. */
export const COMMAND_TIMEOUT_MS = 10_000;

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

/** Writes one text frame to a publisher's own connection — the SEND half
 * `registerPublisher` never had until commands needed it (see
 * spec-editor-presence-commands.md's "Registry change": publishers
 * previously got a close-only handle, subscribers a full write handle).
 * Deliberately a SEPARATE type from `EditorPresenceSubscriberSend`, not a
 * reuse — the two are structurally identical `(frame: string) =>
 * Effect.Effect<void>` today, but subscriber sends are always fan-out
 * (every registered subscriber) while publisher sends are always addressed
 * to exactly one connection; keeping the types distinct stops a future
 * refactor from accidentally treating them as interchangeable. */
export type EditorPresencePublisherSend = (frame: string) => Effect.Effect<void>;

const noopSend: EditorPresencePublisherSend = () => Effect.void;

/**
 * Opaque per-connection identity. Publishers are keyed by their own
 * `session.id` (so a reconnect after a Unity domain reload replaces the
 * stale entry instead of duplicating a chip — see the protocol's `hello`
 * doc), but two different TCP connections can legitimately claim the same
 * `session.id` in flight during a reconnect race. This token guards updates
 * and removal so a slow-closing stale connection's finalizer can never clobber
 * the fresh connection that already replaced it.
 *
 * COMMANDS REUSE THIS SAME TOKEN — see `sendCommand`/`resolveCommand` below.
 * A pending command remembers which connection it was dispatched to; a
 * `commandResult` (or a disconnect) is only honored against the SAME token,
 * so a superseded connection can neither resolve a command addressed to its
 * replacement nor have its own in-flight commands silently reassigned to
 * whichever connection currently owns the session id.
 */
export type EditorPresenceConnectionToken = symbol;

interface PublisherRecord extends EditorPresenceEntry {
  readonly connectionToken: EditorPresenceConnectionToken;
  readonly close: EditorPresenceCloseConnection;
  readonly send: EditorPresencePublisherSend;
  /** Epoch-millisecond timestamps of recent `sendCommand` dispatches to
   * THIS record, pruned to the rate-limit window on every check — see
   * `COMMAND_RATE_LIMIT_MAX`/`COMMAND_RATE_LIMIT_WINDOW_MS` above. */
  readonly commandTimestamps: ReadonlyArray<number>;
}

/** One `sendCommand` call awaiting its `commandResult` (or a timeout, or a
 * disconnect). `connectionToken` is captured at DISPATCH time from the
 * record that was current then — see the `EditorPresenceConnectionToken`
 * doc above for why that specific connection, and no other, may resolve it. */
interface PendingCommand {
  readonly sessionId: string;
  readonly connectionToken: EditorPresenceConnectionToken;
  readonly deferred: Deferred.Deferred<EditorPresenceCommandOutcome>;
}

interface RegistryState {
  readonly publishers: ReadonlyMap<string, PublisherRecord>;
  readonly subscribers: ReadonlySet<EditorPresenceSubscriberSend>;
  readonly pendingCommands: ReadonlyMap<string, PendingCommand>;
}

function toEntry(record: PublisherRecord): EditorPresenceEntry {
  return {
    editor: record.editor,
    session: record.session,
    workspace: record.workspace,
    connected: record.connected,
    lastSeenAt: record.lastSeenAt,
    selection: record.selection,
    capabilities: record.capabilities,
    playState: record.playState,
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

/** Same reasoning as RegisterPublisherResult, for sendCommand's rate-limit
 * + connectivity check. */
type SendCommandDecision =
  | { readonly _tag: "not_connected" }
  | { readonly _tag: "rate_limited" }
  | { readonly _tag: "dispatch"; readonly send: EditorPresencePublisherSend };

export class EditorPresenceRegistry extends Context.Service<
  EditorPresenceRegistry,
  {
    readonly newConnectionToken: () => EditorPresenceConnectionToken;
    /**
     * Registers (or takes over) a publisher session. `close` closes THIS
     * connection later, if some OTHER connection ever claims the same
     * `sessionId` — see the SESSION TAKEOVER doc below. `send` writes a
     * `command` frame to THIS connection later, for `sendCommand` below.
     * Both are optional and default to a no-op so existing single-connection
     * callers/tests that only care about presence, not commands, don't need
     * to thread either through.
     */
    readonly registerPublisher: (
      sessionId: string,
      connectionToken: EditorPresenceConnectionToken,
      hello: {
        readonly editor: EditorPresenceEditorIdentity;
        readonly workspace: { readonly root: string };
        readonly capabilities?: ReadonlyArray<EditorPresenceCapability>;
      },
      close?: EditorPresenceCloseConnection,
      send?: EditorPresencePublisherSend,
    ) => Effect.Effect<void>;
    readonly updatePublisherSelection: (
      sessionId: string,
      connectionToken: EditorPresenceConnectionToken,
      selection: EditorPresenceSelection,
    ) => Effect.Effect<void>;
    /**
     * Records a publisher's own reported play/pause state (its `playState`
     * frame — see protocol.ts) and broadcasts the updated presence, same
     * connectionToken-guarded shape as `updatePublisherSelection`. No `seq`
     * to compare against — this is a single WebSocket connection, so TCP
     * already orders frames within it, and `connectionToken` is what guards
     * against a stale, superseded connection's late update clobbering a
     * newer one, the same protection `updatePublisherSelection` relies on.
     * A stale/unknown `sessionId`+`connectionToken` pair (an old connection
     * whose takeover has already happened) is a silent no-op, matching
     * every other guarded mutation in this file.
     */
    readonly updatePublisherPlayState: (
      sessionId: string,
      connectionToken: EditorPresenceConnectionToken,
      playState: EditorPresencePlayState,
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
    /**
     * Dispatches ONE command to the editor CURRENTLY registered under
     * `sessionId` and resolves once that editor replies (`commandResult`),
     * a per-session rate limit rejects it, the editor disconnects while it
     * was pending, or `COMMAND_TIMEOUT_MS` elapses — whichever comes first.
     * NEVER queues: a `sessionId` with no current record fails immediately
     * with `editor_not_connected` rather than waiting for a future
     * reconnect, per spec-editor-presence-commands.md's "commands are edges,
     * not levels."
     */
    readonly sendCommand: (
      sessionId: string,
      action: string,
      params?: Record<string, unknown>,
    ) => Effect.Effect<EditorPresenceCommandOutcome, never, Crypto.Crypto>;
    /**
     * Reported by `EditorPresenceRoute.ts` when a publisher's read loop
     * parses a `commandResult` frame. Resolves the matching pending command
     * ONLY if `connectionToken` matches what was captured at dispatch time —
     * see the `EditorPresenceConnectionToken` doc above. A miss (unknown
     * id, or a token that no longer matches) is a silent no-op: the id may
     * already have resolved, timed out, or belong to a connection that has
     * since been superseded.
     */
    readonly resolveCommand: (
      id: string,
      connectionToken: EditorPresenceConnectionToken,
      outcome: EditorPresenceCommandOutcome,
    ) => Effect.Effect<void>;
  }
>()("t3/editorPresence/EditorPresenceRegistry") {}

export const make = Effect.gen(function* EditorPresenceRegistryMake() {
  const stateRef = yield* Ref.make<RegistryState>({
    publishers: new Map(),
    subscribers: new Set(),
    pendingCommands: new Map(),
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
    send = noopSend,
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
            send,
            commandTimestamps: [],
            editor: hello.editor,
            session: { id: sessionId },
            workspace: hello.workspace,
            connected: true,
            lastSeenAt,
            selection: null,
            capabilities: hello.capabilities ?? DEFAULT_EDITOR_PRESENCE_CAPABILITIES,
            // Reset on every (re)registration, including a reconnect that
            // takes over an existing session — same self-healing shape as
            // `selection: null` above. A `playState` frame follows
            // immediately after `hello` (see EditorPresenceConnection.cs /
            // plugin.gd), so this null window is momentary, not a lasting
            // regression to "unknown" on every domain-reload reconnect.
            playState: null,
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

  const updatePublisherPlayState: EditorPresenceRegistry["Service"]["updatePublisherPlayState"] = (
    sessionId,
    connectionToken,
    playState,
  ) =>
    Effect.gen(function* () {
      const lastSeenAt = yield* nowIso;
      yield* applyPublisherChange((publishers) => {
        const existing = publishers.get(sessionId);
        if (!existing || existing.connectionToken !== connectionToken) return null;
        const next = new Map(publishers);
        next.set(sessionId, { ...existing, playState, lastSeenAt });
        return next;
      });
    });

  const removePublisher: EditorPresenceRegistry["Service"]["removePublisher"] = (
    sessionId,
    connectionToken,
  ) =>
    Effect.gen(function* () {
      yield* applyPublisherChange((publishers) => {
        const existing = publishers.get(sessionId);
        if (!existing || existing.connectionToken !== connectionToken) return null;
        const next = new Map(publishers);
        next.delete(sessionId);
        return next;
      });

      // Commands are edges, never replayed on reconnect — a command still
      // pending when its editor disconnects must surface that to the
      // CALLER immediately, not leave it blocked until COMMAND_TIMEOUT_MS
      // elapses for a reply that will now never arrive. Guarded by the same
      // connectionToken as the removal above: a pending command dispatched
      // to an already-superseded (old) connection is untouched here when
      // its OWN old connection disconnects late — this only resolves
      // commands that belonged to THIS SPECIFIC connectionToken.
      const stillPending = yield* Ref.get(stateRef).pipe(
        Effect.map((current) =>
          Array.from(current.pendingCommands.values()).filter(
            (pending) =>
              pending.sessionId === sessionId && pending.connectionToken === connectionToken,
          ),
        ),
      );
      yield* Effect.forEach(
        stillPending,
        (pending) => Deferred.succeed(pending.deferred, { ok: false, error: "disconnected" }),
        { discard: true },
      );
    });

  const sendCommand: EditorPresenceRegistry["Service"]["sendCommand"] = (
    sessionId,
    action,
    params,
  ) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const now = yield* nowDateTime;
      const nowMs = now.epochMilliseconds;
      // A command id failing to generate is not a recoverable condition a
      // caller could do anything about — treated as a defect (`orDie`),
      // matching how this codebase treats every other `randomUUIDv4` call.
      const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const deferred = yield* Deferred.make<EditorPresenceCommandOutcome>();

      // Rate-limit check, record lookup, and pending-entry registration all
      // happen inside ONE Ref.modify so a burst of concurrent calls can't
      // all read "under the cap" before any of them commits its own
      // timestamp — the classic check-then-act race a separate read+write
      // would have.
      const decision = yield* Ref.modify(
        stateRef,
        (current): readonly [SendCommandDecision, RegistryState] => {
          const record = current.publishers.get(sessionId);
          if (!record) {
            return [{ _tag: "not_connected" }, current];
          }
          const recentTimestamps = record.commandTimestamps.filter(
            (t) => nowMs - t < COMMAND_RATE_LIMIT_WINDOW_MS,
          );
          if (recentTimestamps.length >= COMMAND_RATE_LIMIT_MAX) {
            return [{ _tag: "rate_limited" }, current];
          }
          const publishers = new Map(current.publishers);
          publishers.set(sessionId, {
            ...record,
            commandTimestamps: [...recentTimestamps, nowMs],
          });
          const pendingCommands = new Map(current.pendingCommands);
          pendingCommands.set(id, { sessionId, connectionToken: record.connectionToken, deferred });
          return [
            { _tag: "dispatch", send: record.send },
            { ...current, publishers, pendingCommands },
          ];
        },
      );

      if (decision._tag === "not_connected") {
        return { ok: false, error: "editor_not_connected" } as const;
      }
      if (decision._tag === "rate_limited") {
        return { ok: false, error: "rate_limited" } as const;
      }

      const frame = buildCommandFrame(id, DateTime.formatIso(now), action, params);
      const timeoutOutcome: EditorPresenceCommandOutcome = { ok: false, error: "timeout" };
      const prunePending = Ref.update(stateRef, (current) => {
        if (!current.pendingCommands.has(id)) return current;
        const pendingCommands = new Map(current.pendingCommands);
        pendingCommands.delete(id);
        return { ...current, pendingCommands };
      });

      // The pending entry exists in the map from here on (it was inserted
      // by the Ref.modify above), so EVERYTHING from here through the
      // engine's reply — including the write itself, not just the wait —
      // has to be under both the timeout race and the cleanup guarantee:
      //
      // - The 10s bound is a promise about `sendCommand` as a whole, not
      //   merely about waiting for a reply. `send` writes to the same
      //   connection Route.ts documents as capable of hanging indefinitely
      //   when its write pump isn't running (see its own note on that). A
      //   bound that only wrapped `Deferred.await` would let a stuck WRITE
      //   hang the caller forever while still claiming a 10s bound.
      // - `Effect.ensuring` has to wrap the write too, not just the await,
      //   because interruption (the caller's own fiber being torn down,
      //   e.g. on disconnect) can land at any point after the entry was
      //   inserted — including mid-write, before `Deferred.await` is ever
      //   reached. An `ensuring` that only wrapped the await would leak the
      //   pending entry for every interruption that lands earlier than that.
      //
      // The FIRST of "engine replied" / "write+reply completed" or "the
      // timeout elapsed" wins the race; whichever loses (including a `send`
      // still in flight) is interrupted. Either way, `Effect.ensuring`
      // prunes this command's pending entry exactly once when the race
      // concludes, so a `resolveCommand` that wins doesn't need to know
      // about map cleanup, and a timeout can't leave a stale entry behind
      // for a late `commandResult` to (harmlessly, but needlessly) resolve
      // into the void.
      return yield* Effect.gen(function* () {
        // EditorPresencePublisherSend's own type guarantees it never
        // FAILS (the route's implementation already swallows its own
        // write errors before returning) — but it can still HANG, which
        // is exactly what the race below bounds.
        yield* decision.send(frame);
        return yield* Deferred.await(deferred);
      }).pipe(
        Effect.raceFirst(
          Effect.sleep(Duration.millis(COMMAND_TIMEOUT_MS)).pipe(Effect.as(timeoutOutcome)),
        ),
        Effect.ensuring(prunePending),
      );
    });

  const resolveCommand: EditorPresenceRegistry["Service"]["resolveCommand"] = (
    id,
    connectionToken,
    outcome,
  ) =>
    Effect.gen(function* () {
      const pending = yield* Ref.get(stateRef).pipe(
        Effect.map((current) => current.pendingCommands.get(id)),
      );
      // A miss here is a silent no-op by design: the id may already have
      // resolved or timed out (its entry is gone), or it may belong to a
      // DIFFERENT, superseded connection's stale command that this one has
      // no business resolving — see the connectionToken doc above.
      if (!pending || pending.connectionToken !== connectionToken) return;
      yield* Deferred.succeed(pending.deferred, outcome);
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
    updatePublisherPlayState,
    removePublisher,
    addSubscriber,
    removeSubscriber,
    sendCommand,
    resolveCommand,
  });
});

export const layer = Layer.effect(EditorPresenceRegistry, make);
