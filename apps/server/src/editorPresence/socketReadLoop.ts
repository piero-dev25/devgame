/**
 * The read loop shared by DevGame's raw (non-RPC) WebSocket routes:
 * `EditorPresenceRoute.ts` (publisher + subscriber) and
 * `../spaceEvents/SpaceEventsRoute.ts`.
 *
 * Effect rc.115 removed `Socket.runString`/`runRaw` and their `onOpen`
 * option. A socket is now a scoped `reader` (a `pull` of frame batches) plus
 * a `writer` object (`write`/`writeAll`), and every close, whatever its code,
 * fails `pull` with a `SocketError` wrapping a `SocketCloseError`. Upstream
 * ported its own raw socket (`../device/DeviceHubProxy.ts`) to an explicit
 * pull loop. This does the same for the fork routes:
 *
 * 1. Acquire the reader. For an upgraded server request this performs the
 *    WebSocket handshake and opens the writer's latch: a write issued before
 *    this point waits for it, so `onOpen` runs only afterwards. This is the
 *    same ordering the old `onOpen` option guaranteed.
 * 2. Run `onOpen` (authentication, the scope check, registration, the
 *    initial frame), to completion, before ANY inbound frame is handled.
 *    Frames that arrive meanwhile stay buffered and are handled afterwards,
 *    in order. The old API dispatched them concurrently with `onOpen` and
 *    dropped whatever arrived before it finished.
 * 3. Handle each frame sequentially until the peer closes.
 *
 * Close classification is unchanged from the old `filterClean` call sites.
 * The old default treated every close code as an error, so only the codes the
 * route itself sends are treated as a normal end. Any other close still fails
 * the loop.
 */
import * as Effect from "effect/Effect";
import * as Socket from "effect/unstable/socket/Socket";

/** True for a `SocketError` carrying a close whose code `isClean` accepts. */
export const isCleanSocketClose =
  (isClean: (code: number) => boolean) =>
  (error: unknown): boolean =>
    Socket.isSocketError(error) &&
    error.reason._tag === "SocketCloseError" &&
    isClean(error.reason.code);

export const runSocketTextReadLoop = <E1, R1, E2, R2>(
  socket: Socket.Socket,
  options: {
    readonly onOpen: Effect.Effect<void, E1, R1>;
    readonly onMessage: (frame: string) => Effect.Effect<void, E2, R2>;
    readonly isServerInitiatedCloseCode: (code: number) => boolean;
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const pull = yield* Socket.readerString(socket);
      yield* options.onOpen;
      while (true) {
        const frames = yield* pull;
        for (const frame of frames) {
          yield* options.onMessage(frame);
        }
      }
    }),
  ).pipe(
    Effect.catch((error) =>
      isCleanSocketClose(options.isServerInitiatedCloseCode)(error)
        ? Effect.void
        : Effect.fail(error),
    ),
  );
