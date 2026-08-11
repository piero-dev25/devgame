import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as EditorPresenceRegistry from "./EditorPresenceRegistry.ts";
import type { EditorPresenceCommandOutcome } from "./protocol.ts";

interface ParsedPresenceFrame {
  readonly editors: ReadonlyArray<{
    readonly editor: { readonly id: string; readonly name: string; readonly version: string };
    readonly session: { readonly id: string };
    readonly workspace: { readonly root: string };
    readonly connected: boolean;
    readonly selection: {
      readonly seq: number;
      readonly items: ReadonlyArray<{ readonly label: string }>;
    } | null;
    // Task #49 (spec-unity-play-stop.md): the publisher's own reported
    // play/pause state, or null before it has reported one.
    readonly playState: string | null;
  }>;
}

const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const parseFrame = (raw: string) => decodeUnknownJson(raw) as ParsedPresenceFrame;
const parseCommandFrame = (raw: string) =>
  decodeUnknownJson(raw) as {
    readonly v: 1;
    readonly type: "command";
    readonly id: string;
    readonly at: string;
    readonly action: string;
    readonly params?: unknown;
  };

const HELLO = {
  editor: { id: "unity", name: "Unity Editor", version: "6000.3.14f1" },
  workspace: { root: "/Users/piero/Projects/Deepmind" },
};

function makeRecorder() {
  const frames: string[] = [];
  const send = (frame: string) => {
    frames.push(frame);
    return Effect.void;
  };
  return { frames, send };
}

// `sendCommand` needs `Crypto.Crypto` (for the command id — see
// EditorPresenceRegistry.ts's own doc on why `randomUUIDv4`, not a bare
// `crypto.randomUUID()`) in the CALLER's context, every time it's invoked —
// that's a property of the SERVICE INTERFACE's declared type, not
// something satisfied by how `EditorPresenceRegistry.layer` itself was
// built (its own construction needs no external services at all). So
// `NodeCrypto.layer` — the SAME layer the app's real entrypoint (`bin.ts`,
// via `NodeServices.layer`) provides in production — has to wrap the WHOLE
// `withRegistry` effect, not just the registry layer, so it's in scope
// wherever `f`'s body calls `registry.sendCommand(...)`. Existing
// (non-command) tests are unaffected either way.
const withRegistry = <A, R>(
  f: (
    registry: EditorPresenceRegistry.EditorPresenceRegistry["Service"],
  ) => Effect.Effect<A, never, R>,
) =>
  Effect.gen(function* () {
    const registry = yield* EditorPresenceRegistry.EditorPresenceRegistry;
    return yield* f(registry);
  }).pipe(Effect.provide(Layer.mergeAll(EditorPresenceRegistry.layer, NodeCrypto.layer)));

it.effect("a new subscriber gets an empty presence frame with no publishers connected", () =>
  withRegistry((registry) =>
    Effect.gen(function* () {
      const recorder = makeRecorder();
      const initialFrame = yield* registry.addSubscriber(recorder.send);
      expect(parseFrame(initialFrame)).toEqual({ v: 1, type: "presence", editors: [] });
    }),
  ),
);

it.effect("hello + selection broadcast to every registered subscriber", () =>
  withRegistry((registry) =>
    Effect.gen(function* () {
      const subscriberA = makeRecorder();
      const subscriberB = makeRecorder();
      yield* registry.addSubscriber(subscriberA.send);
      yield* registry.addSubscriber(subscriberB.send);

      const token = registry.newConnectionToken();
      yield* registry.registerPublisher("session-1", token, HELLO, {
        claimantSessionId: undefined,
      });
      yield* registry.updatePublisherSelection("session-1", token, {
        seq: 1,
        at: "2026-08-03T00:00:00.000Z",
        items: [
          { id: "goid-1", kind: "gameobject", label: "PlayerRoot", path: null, detail: null },
        ],
      });

      // hello broadcast + selection broadcast = 2 frames each, plus the
      // initial empty frame from addSubscriber is a direct return value,
      // not a broadcast, so it is not counted here.
      expect(subscriberA.frames).toHaveLength(2);
      expect(subscriberB.frames).toHaveLength(2);

      const latest = parseFrame(subscriberA.frames.at(-1)!);
      expect(latest.editors).toHaveLength(1);
      expect(latest.editors[0]).toMatchObject({
        editor: HELLO.editor,
        session: { id: "session-1" },
        workspace: HELLO.workspace,
        connected: true,
        selection: { seq: 1, items: [{ label: "PlayerRoot" }] },
      });
    }),
  ),
);

it.effect("a later subscriber immediately sees already-connected publishers", () =>
  withRegistry((registry) =>
    Effect.gen(function* () {
      const token = registry.newConnectionToken();
      yield* registry.registerPublisher("session-1", token, HELLO, {
        claimantSessionId: undefined,
      });

      const lateSubscriber = makeRecorder();
      const initialFrame = yield* registry.addSubscriber(lateSubscriber.send);
      const parsed = parseFrame(initialFrame);
      expect(parsed.editors).toHaveLength(1);
      expect(parsed.editors[0]!.session.id).toBe("session-1");
    }),
  ),
);

it.effect("an out-of-order (<=last seen) seq is dropped, not broadcast", () =>
  withRegistry((registry) =>
    Effect.gen(function* () {
      const token = registry.newConnectionToken();
      yield* registry.registerPublisher("session-1", token, HELLO, {
        claimantSessionId: undefined,
      });

      const subscriber = makeRecorder();
      yield* registry.addSubscriber(subscriber.send);

      yield* registry.updatePublisherSelection("session-1", token, {
        seq: 5,
        at: "t1",
        items: [],
      });
      const framesAfterFirst = subscriber.frames.length;

      // seq 3 <= last seen (5): must be a silent no-op, not a broadcast.
      yield* registry.updatePublisherSelection("session-1", token, {
        seq: 3,
        at: "t2",
        items: [
          { id: null, kind: "gameobject", label: "ShouldNotAppear", path: null, detail: null },
        ],
      });
      expect(subscriber.frames.length).toBe(framesAfterFirst);

      const latest = parseFrame(subscriber.frames.at(-1)!);
      expect(latest.editors[0]!.selection!.seq).toBe(5);
    }),
  ),
);

// Task #49 (spec-unity-play-stop.md's ruling): play state is a LEVEL,
// reported through presence, independent of any one command's
// commandResult — these tests exercise the same connectionToken-guarded
// update path `updatePublisherSelection` already has, but for `playState`.
it.effect("a fresh registration reports playState: null until the publisher reports one", () =>
  withRegistry((registry) =>
    Effect.gen(function* () {
      const token = registry.newConnectionToken();
      yield* registry.registerPublisher("session-1", token, HELLO, {
        claimantSessionId: undefined,
      });

      const subscriber = makeRecorder();
      const initialFrame = yield* registry.addSubscriber(subscriber.send);
      const parsed = parseFrame(initialFrame);
      expect(parsed.editors[0]!.playState).toBeNull();
    }),
  ),
);

it.effect("updatePublisherPlayState broadcasts the new state to every subscriber", () =>
  withRegistry((registry) =>
    Effect.gen(function* () {
      const token = registry.newConnectionToken();
      yield* registry.registerPublisher("session-1", token, HELLO, {
        claimantSessionId: undefined,
      });

      const subscriber = makeRecorder();
      yield* registry.addSubscriber(subscriber.send);

      yield* registry.updatePublisherPlayState("session-1", token, "playing");
      const afterPlaying = parseFrame(subscriber.frames.at(-1)!);
      expect(afterPlaying.editors[0]!.playState).toBe("playing");

      // Unlike selection's seq guard, playState has no monotonic ordering —
      // every report replaces the last one, including going "backwards"
      // (paused -> playing is a legitimate resume, not a stale frame).
      yield* registry.updatePublisherPlayState("session-1", token, "paused");
      const afterPaused = parseFrame(subscriber.frames.at(-1)!);
      expect(afterPaused.editors[0]!.playState).toBe("paused");
    }),
  ),
);

it.effect("a stale (superseded) connection's playState update is a silent no-op", () =>
  withRegistry((registry) =>
    Effect.gen(function* () {
      const staleToken = registry.newConnectionToken();
      yield* registry.registerPublisher("session-1", staleToken, HELLO, {
        claimantSessionId: undefined,
      });

      const freshToken = registry.newConnectionToken();
      yield* registry.registerPublisher("session-1", freshToken, HELLO, {
        claimantSessionId: undefined,
      });

      const subscriber = makeRecorder();
      yield* registry.addSubscriber(subscriber.send);
      const framesBefore = subscriber.frames.length;

      // The stale connection's late playState frame (e.g. a report that
      // was already in flight when the reconnect/takeover happened) must
      // not resurrect state onto the record its own connection no longer
      // owns.
      yield* registry.updatePublisherPlayState("session-1", staleToken, "playing");
      expect(subscriber.frames.length).toBe(framesBefore);

      const stillNull = yield* registry.addSubscriber(makeRecorder().send);
      const parsed = parseFrame(stillNull);
      expect(parsed.editors[0]!.playState).toBeNull();
    }),
  ),
);

it.effect(
  "a reconnect (session takeover) resets playState to null until the fresh connection reports one",
  () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        const staleToken = registry.newConnectionToken();
        yield* registry.registerPublisher("session-1", staleToken, HELLO, {
          claimantSessionId: undefined,
        });
        yield* registry.updatePublisherPlayState("session-1", staleToken, "playing");

        // A Unity domain reload: the OLD connection dies and a NEW one
        // takes over the same session id — self-healing per protocol.ts's
        // doc on `playState: null`, not a lasting regression, since the
        // fresh connection sends its own playState frame right after hello.
        const freshToken = registry.newConnectionToken();
        yield* registry.registerPublisher("session-1", freshToken, HELLO, {
          claimantSessionId: undefined,
        });

        const subscriber = makeRecorder();
        const initialFrame = yield* registry.addSubscriber(subscriber.send);
        const parsed = parseFrame(initialFrame);
        expect(parsed.editors[0]!.playState).toBeNull();
      }),
    ),
);

it.effect(
  "reconnect with the same session id replaces the stale connection instead of duplicating it",
  () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        const subscriber = makeRecorder();
        yield* registry.addSubscriber(subscriber.send);

        const staleToken = registry.newConnectionToken();
        yield* registry.registerPublisher("session-1", staleToken, HELLO, {
          claimantSessionId: undefined,
        });

        const freshToken = registry.newConnectionToken();
        yield* registry.registerPublisher(
          "session-1",
          freshToken,
          {
            ...HELLO,
            editor: { ...HELLO.editor, name: "Unity Editor (reconnected)" },
          },
          { claimantSessionId: undefined },
        );

        const latest = parseFrame(subscriber.frames.at(-1)!);
        expect(latest.editors).toHaveLength(1);
        expect(latest.editors[0]!.editor.name).toBe("Unity Editor (reconnected)");

        // The stale connection's belated cleanup (e.g. its finalizer running
        // after the reconnect already replaced it) must not delete the
        // fresh publisher out from under it.
        yield* registry.removePublisher("session-1", staleToken);
        const afterStaleCleanup = parseFrame(subscriber.frames.at(-1)!);
        expect(afterStaleCleanup.editors).toHaveLength(1);

        yield* registry.removePublisher("session-1", freshToken);
        const afterRealCleanup = parseFrame(subscriber.frames.at(-1)!);
        expect(afterRealCleanup.editors).toHaveLength(0);
      }),
    ),
);

it.effect("removeSubscriber stops future broadcasts from reaching it", () =>
  withRegistry((registry) =>
    Effect.gen(function* () {
      const subscriber = makeRecorder();
      yield* registry.addSubscriber(subscriber.send);
      yield* registry.removeSubscriber(subscriber.send);

      const token = registry.newConnectionToken();
      yield* registry.registerPublisher("session-1", token, HELLO, {
        claimantSessionId: undefined,
      });

      expect(subscriber.frames).toHaveLength(0);
    }),
  ),
);

// Bug #2: a live critic pass measured registerPublisher overwriting an
// existing record unconditionally, with no check for whether it belonged
// to a DIFFERENT connection — a total, silent hijack. The victim's socket
// stayed open and kept publishing into a record every write was then
// discarded from. Fixed: the takeover still happens (that's what makes
// reconnect-after-domain-reload work), but the SUPERSEDED connection is now
// told, via its own `close` callback, with a coded reason — never silent
// for either party.
it.effect("a new connection claiming an existing session.id closes the superseded connection", () =>
  withRegistry((registry) =>
    Effect.gen(function* () {
      const closeCalls: Array<{ code: number; reason: string }> = [];
      const victimClose = (code: number, reason: string) => {
        closeCalls.push({ code, reason });
        return Effect.void;
      };

      const victimToken = registry.newConnectionToken();
      yield* registry.registerPublisher("shared-session", victimToken, HELLO, {
        close: victimClose,
        claimantSessionId: undefined,
      });

      const attackerToken = registry.newConnectionToken();
      yield* registry.registerPublisher(
        "shared-session",
        attackerToken,
        {
          editor: { id: "attacker", name: "Attacker Editor", version: "0.0.0" },
          workspace: { root: "/not/the/victims/project" },
        },
        { claimantSessionId: undefined },
      );

      // The victim's own connection must be told — this is the "not
      // silent for either party" half of the fix.
      expect(closeCalls).toHaveLength(1);
      expect(closeCalls[0]!.code).toBeGreaterThanOrEqual(4000);
      expect(closeCalls[0]!.reason.length).toBeGreaterThan(0);

      // The takeover itself is intentional and unchanged: the record now
      // reflects the NEW connection's data.
      const subscriber = makeRecorder();
      const initialFrame = yield* registry.addSubscriber(subscriber.send);
      const parsed = parseFrame(initialFrame);
      expect(parsed.editors).toHaveLength(1);
      expect(parsed.editors[0]!.editor.id).toBe("attacker");
    }),
  ),
);

it.effect(
  "the superseded connection's belated removePublisher does not delete the connection that took over",
  () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        const victimToken = registry.newConnectionToken();
        yield* registry.registerPublisher("shared-session", victimToken, HELLO, {
          claimantSessionId: undefined,
        });

        const attackerToken = registry.newConnectionToken();
        yield* registry.registerPublisher("shared-session", attackerToken, HELLO, {
          claimantSessionId: undefined,
        });

        // The superseded connection's own cleanup finally runs (its
        // read-loop finalizer fires late) — the connectionToken guard
        // must stop it from deleting the entry the new connection owns.
        yield* registry.removePublisher("shared-session", victimToken);

        const subscriber = makeRecorder();
        const initialFrame = yield* registry.addSubscriber(subscriber.send);
        expect(parseFrame(initialFrame).editors).toHaveLength(1);
      }),
    ),
);

// Cheap capacity guard (unbounded maps were the "also, cheap and worth
// doing" note) — a genuinely new session past the cap is refused, logged,
// and does not silently grow the map forever. An existing session being
// taken over never counts against the cap.
it.effect("refuses a new publisher session once at capacity, without touching existing ones", () =>
  withRegistry((registry) =>
    Effect.gen(function* () {
      const CAP = 64; // must match EditorPresenceRegistry.ts's MAX_PUBLISHERS
      for (let i = 0; i < CAP; i++) {
        const token = registry.newConnectionToken();
        yield* registry.registerPublisher(`session-${i}`, token, HELLO, {
          claimantSessionId: undefined,
        });
      }

      const overflowToken = registry.newConnectionToken();
      yield* registry.registerPublisher("session-overflow", overflowToken, HELLO, {
        claimantSessionId: undefined,
      });

      const subscriber = makeRecorder();
      const initialFrame = yield* registry.addSubscriber(subscriber.send);
      const parsed = parseFrame(initialFrame);
      expect(parsed.editors).toHaveLength(CAP);
      expect(parsed.editors.some((e) => e.session.id === "session-overflow")).toBe(false);
    }),
  ),
);

// ============================================================================
// Task #47 — commands (server -> engine). See
// docs/workbench/spec-editor-presence-commands.md (frozen).
// ============================================================================

/** A publisher's `send` handle that AUTOMATICALLY answers every command it
 * receives, computing the reply from the parsed frame — sidesteps needing
 * to fork+race `sendCommand` against a manual reply: by the time
 * `sendCommand`'s `yield* decision.send(frame)` returns, `resolveCommand`
 * has already run as a side effect of that same call, so `sendCommand`'s
 * own subsequent `Deferred.await` resolves immediately without ever truly
 * suspending. */
function makeAutoReplyingPublisher(
  registry: EditorPresenceRegistry.EditorPresenceRegistry["Service"],
  token: EditorPresenceRegistry.EditorPresenceConnectionToken,
  reply: (command: {
    readonly id: string;
    readonly action: string;
    readonly params?: unknown;
  }) => EditorPresenceCommandOutcome,
) {
  const frames: string[] = [];
  const send = (frame: string) =>
    Effect.gen(function* () {
      frames.push(frame);
      const command = parseCommandFrame(frame);
      yield* registry.resolveCommand(command.id, token, reply(command));
    });
  return { frames, send };
}

it.effect(
  "sendCommand to a session with no connected publisher fails immediately, never queues",
  () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        const outcome = yield* registry.sendCommand("never-connected", "play");
        expect(outcome).toEqual({ ok: false, error: "editor_not_connected" });
      }),
    ),
);

it.effect(
  "sendCommand writes the REAL command frame to the connected publisher and resolves with its actual reply",
  () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        const token = registry.newConnectionToken();
        const publisher = makeAutoReplyingPublisher(registry, token, () => ({ ok: true }));
        yield* registry.registerPublisher("session-1", token, HELLO, {
          send: publisher.send,
          claimantSessionId: undefined,
        });

        const outcome = yield* registry.sendCommand("session-1", "play", { sceneIndex: 0 });

        // Assert the EFFECT — the exact frame the engine actually
        // received — not merely that `send` was called some number of
        // times.
        expect(outcome).toEqual({ ok: true });
        expect(publisher.frames).toHaveLength(1);
        const sentFrame = parseCommandFrame(publisher.frames[0]!);
        expect(sentFrame).toMatchObject({
          v: 1,
          type: "command",
          action: "play",
          params: { sceneIndex: 0 },
        });
        expect(typeof sentFrame.id).toBe("string");
        expect(sentFrame.id.length).toBeGreaterThan(0);
      }),
    ),
);

it.effect(
  "relays the engine's unsupported_action reply verbatim — the server never validates action names itself",
  () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        const token = registry.newConnectionToken();
        const publisher = makeAutoReplyingPublisher(registry, token, () => ({
          ok: false,
          error: "unsupported_action",
        }));
        yield* registry.registerPublisher("session-1", token, HELLO, {
          send: publisher.send,
          claimantSessionId: undefined,
        });

        const outcome = yield* registry.sendCommand(
          "session-1",
          "an.action.this.fake.engine.does.not.recognise",
        );

        expect(outcome).toEqual({ ok: false, error: "unsupported_action" });
      }),
    ),
);

it.effect(
  "two commands in flight are each resolved with THEIR OWN reply, even answered out of order",
  () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        const token = registry.newConnectionToken();
        const sentFrames = yield* Queue.unbounded<string>();
        const publisher = { send: (frame: string) => Queue.offer(sentFrames, frame) };
        yield* registry.registerPublisher("session-1", token, HELLO, {
          send: publisher.send,
          claimantSessionId: undefined,
        });

        const fiberA = yield* Effect.forkChild(registry.sendCommand("session-1", "play"));
        const frameA = parseCommandFrame(yield* Queue.take(sentFrames));
        const fiberB = yield* Effect.forkChild(registry.sendCommand("session-1", "stop"));
        const frameB = parseCommandFrame(yield* Queue.take(sentFrames));

        expect(frameA.id).not.toBe(frameB.id);

        // Reply to B FIRST, deliberately out of order — the correlation
        // must be by id, not by dispatch order.
        yield* registry.resolveCommand(frameB.id, token, { ok: true });
        yield* registry.resolveCommand(frameA.id, token, {
          ok: false,
          error: "unsupported_action",
        });

        const outcomeA = yield* Fiber.join(fiberA);
        const outcomeB = yield* Fiber.join(fiberB);

        expect(outcomeA).toEqual({ ok: false, error: "unsupported_action" });
        expect(outcomeB).toEqual({ ok: true });
      }),
    ),
);

it.effect(
  "bounds the command rate per session — a burst beyond the cap is rejected immediately, not queued",
  () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        const token = registry.newConnectionToken();
        const sentFrames = yield* Queue.unbounded<string>();
        // Deliberately never auto-replies — every dispatched command in
        // this test stays pending, so the ONLY way the overflow call can
        // resolve fast is if the rate limit itself short-circuits before
        // ever waiting on a reply.
        const publisher = { send: (frame: string) => Queue.offer(sentFrames, frame) };
        yield* registry.registerPublisher("session-1", token, HELLO, {
          send: publisher.send,
          claimantSessionId: undefined,
        });

        const pendingFibers: Array<Fiber.Fiber<EditorPresenceCommandOutcome>> = [];
        for (let i = 0; i < EditorPresenceRegistry.COMMAND_RATE_LIMIT_MAX; i++) {
          pendingFibers.push(yield* Effect.forkChild(registry.sendCommand("session-1", "play")));
          // Deterministically wait for THIS dispatch's send to have
          // happened (proving its rate-limit timestamp was recorded)
          // before firing the next one — no reliance on scheduler timing.
          yield* Queue.take(sentFrames);
        }

        const overflowOutcome = yield* registry.sendCommand("session-1", "play");
        expect(overflowOutcome).toEqual({ ok: false, error: "rate_limited" });

        // Assert the EFFECT, not just the return value: a mutant that
        // still WRITES the frame and only fakes the rejection in its
        // return value would pass the assertion above but fail this one.
        // The loop above already drained the queue down to empty (one
        // `Queue.take` per accepted dispatch), so a non-blocking poll
        // finding NOTHING here proves the rejected call wrote no frame —
        // `sendCommand` isn't forked, so by the time it has already
        // returned the rejection, any write it might have made is
        // already in the queue, not still in flight.
        expect((yield* Queue.poll(sentFrames))._tag).toBe("None");

        // The window is a SLIDING bound, not a permanent lockout once a
        // session has ever hit the cap — advance the virtual clock past it
        // and confirm a fresh command is dispatched for real (its frame
        // actually reaches the engine). A mutant that dropped the
        // `nowMs - t < WINDOW_MS` filter (rate-limiting every session that
        // ever hit the cap, forever) would stay rejected here too.
        yield* TestClock.adjust(
          Duration.millis(EditorPresenceRegistry.COMMAND_RATE_LIMIT_WINDOW_MS),
        );
        const afterWindowFiber = yield* Effect.forkChild(registry.sendCommand("session-1", "play"));
        yield* Queue.take(sentFrames);

        yield* Effect.forEach(
          [...pendingFibers, afterWindowFiber],
          (fiber) => Fiber.interrupt(fiber),
          {
            discard: true,
          },
        );
      }),
    ).pipe(Effect.provide(TestClock.layer())),
);

it.effect(
  "sendCommand resolves { ok: false, error: 'timeout' } when the engine never replies — the 10s bound covers a hung write, not just a hung reply",
  () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        const token = registry.newConnectionToken();
        const sentFrames = yield* Queue.unbounded<string>();
        // Deliberately never replies — deleting the `Effect.raceFirst`
        // timeout race (or narrowing it to wrap only `Deferred.await`,
        // not the write) would leave this test hanging with no other
        // path to resolution, proving the bound is real rather than
        // merely documented.
        const publisher = { send: (frame: string) => Queue.offer(sentFrames, frame) };
        yield* registry.registerPublisher("session-1", token, HELLO, {
          send: publisher.send,
          claimantSessionId: undefined,
        });

        const fiber = yield* Effect.forkChild(registry.sendCommand("session-1", "play"));
        yield* Queue.take(sentFrames); // the write actually reached the engine
        yield* TestClock.adjust(Duration.millis(EditorPresenceRegistry.COMMAND_TIMEOUT_MS));

        const outcome = yield* Fiber.join(fiber);
        expect(outcome).toEqual({ ok: false, error: "timeout" });
      }),
    ).pipe(Effect.provide(TestClock.layer())),
);

it.effect(
  "a command still pending when its editor disconnects resolves as disconnected, not a hang",
  () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        const token = registry.newConnectionToken();
        const sentFrames = yield* Queue.unbounded<string>();
        const publisher = { send: (frame: string) => Queue.offer(sentFrames, frame) };
        yield* registry.registerPublisher("session-1", token, HELLO, {
          send: publisher.send,
          claimantSessionId: undefined,
        });

        const fiber = yield* Effect.forkChild(registry.sendCommand("session-1", "play"));
        yield* Queue.take(sentFrames); // the pending entry now exists

        yield* registry.removePublisher("session-1", token);

        const outcome = yield* Fiber.join(fiber);
        expect(outcome).toEqual({ ok: false, error: "disconnected" });
      }),
    ),
);

it.effect(
  "resolveCommand with the WRONG connectionToken is a silent no-op — a superseded connection cannot resolve a command meant for its replacement",
  () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        const token = registry.newConnectionToken();
        const sentFrames = yield* Queue.unbounded<string>();
        const publisher = { send: (frame: string) => Queue.offer(sentFrames, frame) };
        yield* registry.registerPublisher("session-1", token, HELLO, {
          send: publisher.send,
          claimantSessionId: undefined,
        });

        const fiber = yield* Effect.forkChild(registry.sendCommand("session-1", "play"));
        const sentFrame = parseCommandFrame(yield* Queue.take(sentFrames));

        const wrongToken = registry.newConnectionToken();
        yield* registry.resolveCommand(sentFrame.id, wrongToken, { ok: true });

        // If the wrong-token resolve HAD (incorrectly) succeeded, the
        // Deferred would already be settled as `{ ok: true }`, and this
        // second, CORRECTLY-tokened resolve would be a silent no-op
        // (Effect's Deferred only ever settles once) — so the outcome
        // below proves which one actually won.
        yield* registry.resolveCommand(sentFrame.id, token, {
          ok: false,
          error: "unsupported_action",
        });

        const outcome = yield* Fiber.join(fiber);
        expect(outcome).toEqual({ ok: false, error: "unsupported_action" });
      }),
    ),
);

it.effect(
  "a command dispatched while disconnected never fires when that session reconnects later — commands are edges, not levels",
  () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        // Genuinely never connected at dispatch time.
        const outcome = yield* registry.sendCommand("session-1", "play");
        expect(outcome).toEqual({ ok: false, error: "editor_not_connected" });

        // The "reconnect" — a publisher now claims the SAME session id,
        // well after the command above already failed.
        const token = registry.newConnectionToken();
        const publisher = makeAutoReplyingPublisher(registry, token, () => ({ ok: true }));
        yield* registry.registerPublisher("session-1", token, HELLO, {
          send: publisher.send,
          claimantSessionId: undefined,
        });

        // Give any background fiber a chance to run before asserting
        // nothing arrived — without this, a hypothetical mutant that
        // replayed the dropped command from a FORKED fiber (rather than
        // inline during registerPublisher) could slip past this
        // assertion simply because that fiber hadn't been scheduled yet,
        // not because it never fires at all.
        yield* Effect.yieldNow;

        // No command frame ever arrives — there was never a queue to
        // replay from; the dispatch above is simply gone.
        expect(publisher.frames).toHaveLength(0);
      }),
    ),
);
