import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as EditorPresenceRegistry from "./EditorPresenceRegistry.ts";

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
  }>;
}

const decodeUnknownJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const parseFrame = (raw: string) => decodeUnknownJson(raw) as ParsedPresenceFrame;

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

const withRegistry = <A>(
  f: (registry: EditorPresenceRegistry.EditorPresenceRegistry["Service"]) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const registry = yield* EditorPresenceRegistry.EditorPresenceRegistry;
    return yield* f(registry);
  }).pipe(Effect.provide(EditorPresenceRegistry.layer));

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
      yield* registry.registerPublisher("session-1", token, HELLO);
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
      yield* registry.registerPublisher("session-1", token, HELLO);

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
      yield* registry.registerPublisher("session-1", token, HELLO);

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

it.effect(
  "reconnect with the same session id replaces the stale connection instead of duplicating it",
  () =>
    withRegistry((registry) =>
      Effect.gen(function* () {
        const subscriber = makeRecorder();
        yield* registry.addSubscriber(subscriber.send);

        const staleToken = registry.newConnectionToken();
        yield* registry.registerPublisher("session-1", staleToken, HELLO);

        const freshToken = registry.newConnectionToken();
        yield* registry.registerPublisher("session-1", freshToken, {
          ...HELLO,
          editor: { ...HELLO.editor, name: "Unity Editor (reconnected)" },
        });

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
      yield* registry.registerPublisher("session-1", token, HELLO);

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
      yield* registry.registerPublisher("shared-session", victimToken, HELLO, victimClose);

      const attackerToken = registry.newConnectionToken();
      yield* registry.registerPublisher("shared-session", attackerToken, {
        editor: { id: "attacker", name: "Attacker Editor", version: "0.0.0" },
        workspace: { root: "/not/the/victims/project" },
      });

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
        yield* registry.registerPublisher("shared-session", victimToken, HELLO);

        const attackerToken = registry.newConnectionToken();
        yield* registry.registerPublisher("shared-session", attackerToken, HELLO);

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
        yield* registry.registerPublisher(`session-${i}`, token, HELLO);
      }

      const overflowToken = registry.newConnectionToken();
      yield* registry.registerPublisher("session-overflow", overflowToken, HELLO);

      const subscriber = makeRecorder();
      const initialFrame = yield* registry.addSubscriber(subscriber.send);
      const parsed = parseFrame(initialFrame);
      expect(parsed.editors).toHaveLength(CAP);
      expect(parsed.editors.some((e) => e.session.id === "session-overflow")).toBe(false);
    }),
  ),
);
