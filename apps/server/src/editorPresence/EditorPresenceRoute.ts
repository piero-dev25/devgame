/**
 * Raw (non-RPC) WebSocket route for the Editor Presence Protocol.
 *
 * `GET /editor-presence?role=publisher|subscriber` — a first-class raw
 * upgrade route via `HttpServerRequest.upgrade`, exactly like
 * `websocketRpcRouteLayer` (`../ws.ts`) but outside the `WsRpcGroup` /
 * `WS_METHODS` machinery entirely: no new RPC method, no `WS_METHODS` entry,
 * no `packages/contracts` change. See
 * docs/workbench/spec-editor-presence.md for why.
 *
 * SECURITY NOTE (step 1 scope): both roles authenticate via the existing
 * `EnvironmentAuth.authenticateWebSocketUpgrade` (bearer token or wsTicket),
 * same as every other connection to this server. What this route does
 * *not* yet do is enforce per-role scopes (`AuthOrchestrationReadScope` for
 * subscriber, `AuthOrchestrationOperateScope` for publisher) or
 * `workspace.root` matching against a thread's cwd — `RPC_REQUIRED_SCOPES`
 * (`../auth/RpcAuthorization.ts`) covers RPC methods only, so a raw upgrade
 * route gets no compile-time scope guarantee. That is deliberately step 3's
 * job ("Scope check and workspace scoping — close the two real holes step 1
 * opens"), not step 1's. Any authenticated session can see presence today.
 *
 * AUTH ORDERING NOTE: the two roles authenticate in a different order
 * relative to the WebSocket upgrade, and that split is deliberate rather
 * than an inconsistency. Subscribers are browsers, so an HTTP 401 refusal
 * before the upgrade is perfectly visible and they authenticate first, same
 * as every other connection to this server. Publishers are engine plugins
 * (Unity, Godot, Unreal); a refused upgrade is indistinguishable from
 * "nothing is listening" to them, because the engine only logs the real
 * refusal reason natively, where no script can read it — measured against a
 * real Godot client, see docs/workbench/godot-probe-findings.md. So the
 * publisher upgrade is accepted unconditionally and authentication happens
 * from inside the publisher's read loop, rejecting on failure with an
 * application close code (>= 4000) and a human-readable reason that the
 * engine *can* see. This slightly widens the pre-auth surface for
 * publishers (an unauthenticated caller can now cause a real upgrade), but
 * rejection is immediate and never allocates a connection token, registers
 * a publisher, or otherwise touches registry state before authentication
 * succeeds — see `runPublisherConnection` below.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../auth/http.ts";
import * as EditorPresenceRegistry from "./EditorPresenceRegistry.ts";
import type { EditorPresenceConnectionToken } from "./EditorPresenceRegistry.ts";
import {
  buildPongFrame,
  describeHelloValidationFailure,
  EDITOR_PRESENCE_CLOSE_CODE,
  parseEditorPresenceInboundFrame,
} from "./protocol.ts";

const EDITOR_PRESENCE_PATH = "/editor-presence";

/**
 * Every application-range code this route ever sends itself, in one place
 * so the read loop's "was this MY deliberate close, not a crash" filter
 * (see `isServerInitiatedCloseCode` below) can't quietly drift out of sync
 * with the codes actually being sent — that mismatch is exactly the shape
 * of bug that would make a routine, correct rejection log like a crash.
 */
const SERVER_INITIATED_CLOSE_CODES: ReadonlySet<number> = new Set(
  Object.values(EDITOR_PRESENCE_CLOSE_CODE),
);
const isServerInitiatedCloseCode = (code: number): boolean =>
  SERVER_INITIATED_CLOSE_CODES.has(code);

function publisherCredentialCloseCode(error: EnvironmentAuth.ServerAuthCredentialError): number {
  return error._tag === "ServerAuthMissingCredentialError"
    ? EDITOR_PRESENCE_CLOSE_CODE.missingCredential
    : EDITOR_PRESENCE_CLOSE_CODE.invalidCredential;
}

type EditorPresenceRole = "publisher" | "subscriber";

function readRole(request: HttpServerRequest.HttpServerRequest): EditorPresenceRole | null {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return null;
  const role = url.value.searchParams.get("role");
  return role === "publisher" || role === "subscriber" ? role : null;
}

const runPublisherConnection = (
  socket: Socket.Socket,
  registry: EditorPresenceRegistry.EditorPresenceRegistry["Service"],
  authenticate: Effect.Effect<
    unknown,
    EnvironmentAuth.ServerAuthCredentialError | EnvironmentAuth.ServerAuthInternalError
  >,
) =>
  Effect.gen(function* () {
    const write = yield* socket.writer;

    const rejectUpgrade = (code: number, reason: string) =>
      write(new Socket.CloseEvent(code, reason)).pipe(Effect.catch(() => Effect.void));

    // Set only once authentication succeeds. Every registry mutation below
    // is gated on this so a rejected upgrade never allocates a connection
    // token, registers a publisher, or otherwise touches registry state —
    // moving auth after the upgrade must not widen that surface.
    let connectionToken: EditorPresenceConnectionToken | null = null;

    // EVERY session id this connection has ever registered, not just the
    // most recent one. A publisher can legitimately say `hello` more than
    // once on the same socket (regenerating its session id without
    // reconnecting is valid per the protocol — nothing forbids it, and a
    // live critic pass measured exactly this: a second hello with a
    // different session.id, then closing the socket, left the FIRST
    // session's registry entry permanently unreachable, because cleanup
    // only ever removed the single last-seen id). `close()` below removes
    // every id this connection ever claimed, each independently guarded by
    // `connectionToken` — so an id already taken over by a LATER, different
    // connection (see EditorPresenceRegistry's session-takeover doc) is
    // correctly left alone rather than deleted out from under its new owner.
    const registeredSessionIds = new Set<string>();

    const cleanup = Effect.suspend(() => {
      if (connectionToken === null || registeredSessionIds.size === 0) return Effect.void;
      const token = connectionToken;
      return Effect.forEach(
        Array.from(registeredSessionIds),
        (id) => registry.removePublisher(id, token),
        { discard: true },
      );
    });

    yield* socket
      .runString(
        (raw) =>
          Effect.gen(function* () {
            // A connection still authenticating, or already rejected, has
            // nothing to process — the close written from `onOpen` below is
            // already on its way out.
            if (connectionToken === null) return;
            const token = connectionToken;

            const frame = parseEditorPresenceInboundFrame(raw);
            if (!frame) {
              // Not parseable as ANY known frame — but it might specifically
              // be a `hello` that fails validation, which needs to be loud:
              // a publisher that thinks it said hello has no other way to
              // learn it was never registered (ping still works, since ping
              // doesn't require a prior hello, so the connection looks
              // perfectly healthy while no subscriber ever sees it — a live
              // critic pass measured exactly this). Any OTHER malformed
              // frame keeps the previous silent-drop behavior; that's a
              // deliberate scope line, not an oversight — see protocol.ts's
              // "KNOWN GAP" notes on item-level drops and `v` mismatches.
              const helloFailure = describeHelloValidationFailure(raw);
              if (helloFailure !== null) {
                yield* rejectUpgrade(EDITOR_PRESENCE_CLOSE_CODE.malformedHello, helloFailure);
              }
              return;
            }

            switch (frame.type) {
              case "hello": {
                registeredSessionIds.add(frame.session.id);
                yield* registry.registerPublisher(
                  frame.session.id,
                  token,
                  { editor: frame.editor, workspace: frame.workspace },
                  (code, reason) => rejectUpgrade(code, reason),
                );
                return;
              }
              case "selection": {
                if (registeredSessionIds.size === 0) return;
                // Selections apply to whichever session this connection
                // most recently said hello as — the same "last hello wins
                // for new frames" semantics as before; only CLEANUP now
                // covers every id, not just the latest.
                const latestSessionId = Array.from(registeredSessionIds).at(-1)!;
                yield* registry.updatePublisherSelection(latestSessionId, token, frame.selection);
                return;
              }
              case "ping": {
                yield* write(buildPongFrame()).pipe(Effect.catch(() => Effect.void));
                return;
              }
            }
          }),
        {
          // The writer is only actually pumped once the read loop is
          // running (see `runSubscriberConnection`'s comment on the same
          // point) — a write issued before that sits in an internal queue
          // that nothing ever drains and hangs indefinitely. So
          // authentication, and the rejecting close write on failure, both
          // have to happen from inside `onOpen` rather than before
          // `runString` is called.
          onOpen: authenticate.pipe(
            Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
              rejectUpgrade(
                publisherCredentialCloseCode(error),
                EnvironmentAuth.serverAuthCredentialReason(error),
              ),
            ),
            Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, () =>
              rejectUpgrade(EDITOR_PRESENCE_CLOSE_CODE.internalError, "internal_error"),
            ),
            Effect.map(() => {
              connectionToken = registry.newConnectionToken();
            }),
          ),
        },
      )
      .pipe(
        // A close we initiate ourselves (one of the codes above) surfaces as
        // a FAILURE of the read loop, not a clean completion —
        // `closeCodeIsError` defaults to treating every close code as an
        // error. Recognise our own deliberate close and treat it as normal
        // so a routine rejection doesn't read as a crash; any other close
        // (peer-initiated, network error) still propagates as-is.
        Effect.catchFilter(
          Socket.SocketCloseError.filterClean(isServerInitiatedCloseCode),
          () => Effect.void,
        ),
        Effect.ensuring(cleanup),
      );
  });

const runSubscriberConnection = (
  socket: Socket.Socket,
  registry: EditorPresenceRegistry.EditorPresenceRegistry["Service"],
) =>
  Effect.gen(function* () {
    const write = yield* socket.writer;
    const send = (frame: string) => write(frame).pipe(Effect.catch(() => Effect.void));

    // The writer is only actually pumped once the read loop is running (see
    // `run*`'s `onOpen` option below) — a write issued before that point
    // sits in an internal queue that nothing ever drains and hangs
    // indefinitely. Sending the initial `presence` frame from `onOpen`
    // rather than before `runString` is not a style choice, it is required
    // for the write to complete at all.
    //
    // Subscribers don't send anything meaningful themselves; the message
    // handler is a no-op and the read loop only exists to hold the
    // connection open and observe close/error so we can deregister.
    yield* socket
      .runString(() => Effect.void, {
        onOpen: Effect.gen(function* () {
          const initialFrame = yield* registry.addSubscriber(send);
          yield* send(initialFrame);
        }),
      })
      .pipe(Effect.ensuring(registry.removeSubscriber(send)));
  });

export const editorPresenceRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* EditorPresenceRegistry.EditorPresenceRegistry;
    return HttpRouter.add(
      "GET",
      EDITOR_PRESENCE_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const role = readRole(request);
        if (role === null) {
          return HttpServerResponse.text("Bad Request: role must be 'publisher' or 'subscriber'", {
            status: 400,
          });
        }

        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

        if (role === "publisher") {
          // See the module doc's "AUTH ORDERING NOTE": accept the upgrade
          // unconditionally, then authenticate from inside the read loop.
          const socket = yield* request.upgrade;
          yield* runPublisherConnection(
            socket,
            registry,
            serverAuth.authenticateWebSocketUpgrade(request),
          );
          return HttpServerResponse.empty();
        }

        // Subscribers are browsers: an HTTP 401 on a bad credential is
        // perfectly visible to them, so authenticate before the upgrade,
        // exactly as every other connection to this server does.
        yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );

        const socket = yield* request.upgrade;
        yield* runSubscriberConnection(socket, registry);
        return HttpServerResponse.empty();
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
).pipe(Layer.provide(EditorPresenceRegistry.layer));
