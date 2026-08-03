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
