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
import { buildPongFrame, parseEditorPresenceInboundFrame } from "./protocol.ts";

const EDITOR_PRESENCE_PATH = "/editor-presence";

/**
 * Application-range close codes (RFC 6455 §7.4.2, >= 4000) the publisher
 * path uses to reject an unauthenticated upgrade — see the module doc's
 * "AUTH ORDERING NOTE". One code per failure class so an engine client can
 * tell "no credential was sent" from "the credential was rejected" from
 * "the server broke" without parsing the reason string.
 */
const PUBLISHER_MISSING_CREDENTIAL_CLOSE_CODE = 4400;
const PUBLISHER_INVALID_CREDENTIAL_CLOSE_CODE = 4401;
const PUBLISHER_AUTH_INTERNAL_ERROR_CLOSE_CODE = 4500;

const isPublisherAuthCloseCode = (code: number): boolean =>
  code === PUBLISHER_MISSING_CREDENTIAL_CLOSE_CODE ||
  code === PUBLISHER_INVALID_CREDENTIAL_CLOSE_CODE ||
  code === PUBLISHER_AUTH_INTERNAL_ERROR_CLOSE_CODE;

function publisherCredentialCloseCode(error: EnvironmentAuth.ServerAuthCredentialError): number {
  return error._tag === "ServerAuthMissingCredentialError"
    ? PUBLISHER_MISSING_CREDENTIAL_CLOSE_CODE
    : PUBLISHER_INVALID_CREDENTIAL_CLOSE_CODE;
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

    // Set only once authentication succeeds. Every registry mutation below
    // is gated on this so a rejected upgrade never allocates a connection
    // token, registers a publisher, or otherwise touches registry state —
    // moving auth after the upgrade must not widen that surface.
    let connectionToken: EditorPresenceConnectionToken | null = null;
    // sessionId is learned from the publisher's own `hello` frame; frames
    // that arrive before `hello` (or a `selection` from a connection that
    // never said hello) are dropped rather than guessed at.
    let sessionId: string | null = null;

    const cleanup = Effect.suspend(() =>
      sessionId === null || connectionToken === null
        ? Effect.void
        : registry.removePublisher(sessionId, connectionToken),
    );

    const rejectUpgrade = (code: number, reason: string) =>
      write(new Socket.CloseEvent(code, reason)).pipe(Effect.catch(() => Effect.void));

    yield* socket
      .runString(
        (raw) =>
          Effect.gen(function* () {
            // A connection still authenticating, or already rejected, has
            // nothing to process — the close written from `onOpen` below is
            // already on its way out.
            if (connectionToken === null) return;
            const frame = parseEditorPresenceInboundFrame(raw);
            if (!frame) return;
            switch (frame.type) {
              case "hello": {
                sessionId = frame.session.id;
                yield* registry.registerPublisher(frame.session.id, connectionToken, {
                  editor: frame.editor,
                  workspace: frame.workspace,
                });
                return;
              }
              case "selection": {
                if (sessionId === null) return;
                yield* registry.updatePublisherSelection(
                  sessionId,
                  connectionToken,
                  frame.selection,
                );
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
              rejectUpgrade(PUBLISHER_AUTH_INTERNAL_ERROR_CLOSE_CODE, "internal_error"),
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
        // so a routine auth rejection doesn't read as a crash; any other
        // close (peer-initiated, network error) still propagates as-is.
        Effect.catchFilter(
          Socket.SocketCloseError.filterClean(isPublisherAuthCloseCode),
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
