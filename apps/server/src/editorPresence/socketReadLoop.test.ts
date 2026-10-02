// The rc.115 read loop that replaced `Socket.runString(handler, { onOpen })`
// for the fork's raw WebSocket routes. Two behaviors matter to the routes:
// `onOpen` (authentication) settles before ANY inbound frame is handled, and
// only the route's own close codes end the loop normally.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Socket from "effect/unstable/socket/Socket";

import { runSocketTextReadLoop } from "./socketReadLoop.ts";

/** A socket whose reader yields `batches` in order, then fails the way a
 * real socket does on close: a `SocketError` wrapping a `SocketCloseError`. */
function makeScriptedSocket(
  batches: ReadonlyArray<readonly [string, ...Array<string>]>,
  closeCode: number,
): Socket.Socket {
  let index = 0;
  const pull = Effect.suspend(
    (): Effect.Effect<readonly [string, ...Array<string>], Socket.SocketError> => {
      const batch = batches[index++];
      if (batch !== undefined) return Effect.succeed(batch);
      return Effect.fail(
        new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: closeCode }) }),
      );
    },
  );
  return Socket.make({
    reader: Effect.succeed({ pull, upgrade: Socket.SocketUpgradeError.unsupported }),
    writer: Effect.succeed({ write: () => Effect.void, writeAll: () => Effect.void }),
  });
}

const isRouteCloseCode = (code: number) => code === 4401;

it.effect("finishes onOpen before handling frames that arrived during it, in order", () =>
  Effect.gen(function* () {
    const log: Array<string> = [];
    yield* runSocketTextReadLoop(makeScriptedSocket([["hello", "ping"], ["selection"]], 4401), {
      onOpen: Effect.gen(function* () {
        // Yield first, so a loop that handled frames concurrently with
        // `onOpen` would interleave them ahead of "authenticated".
        yield* Effect.yieldNow;
        log.push("authenticated");
      }),
      onMessage: (frame) => Effect.sync(() => log.push(frame)),
      isServerInitiatedCloseCode: isRouteCloseCode,
    });

    assert.deepStrictEqual(log, ["authenticated", "hello", "ping", "selection"]);
  }),
);

it.effect("treats the route's own close code as a normal end", () =>
  Effect.gen(function* () {
    const exit = yield* runSocketTextReadLoop(makeScriptedSocket([], 4401), {
      onOpen: Effect.void,
      onMessage: () => Effect.void,
      isServerInitiatedCloseCode: isRouteCloseCode,
    }).pipe(Effect.exit);

    assert.strictEqual(exit._tag, "Success");
  }),
);

it.effect("still fails on any other close, as the old every-close-is-an-error default did", () =>
  Effect.gen(function* () {
    const error = yield* runSocketTextReadLoop(makeScriptedSocket([], 1006), {
      onOpen: Effect.void,
      onMessage: () => Effect.void,
      isServerInitiatedCloseCode: isRouteCloseCode,
    }).pipe(Effect.flip);

    assert.isTrue(Socket.isSocketError(error));
    assert.strictEqual(
      Socket.isSocketError(error) && error.reason._tag === "SocketCloseError"
        ? error.reason.code
        : null,
      1006,
    );
  }),
);
