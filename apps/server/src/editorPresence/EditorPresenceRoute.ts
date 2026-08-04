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
 * SECURITY NOTE: both roles authenticate via the existing
 * `EnvironmentAuth.authenticateWebSocketUpgrade` (bearer token or wsTicket),
 * same as every other connection to this server, and now also enforce
 * per-role scopes — `AuthOrchestrationReadScope` for subscriber,
 * `AuthOrchestrationOperateScope` for publisher — reusing the exact scope
 * vocabulary `RPC_REQUIRED_SCOPES` (`../auth/RpcAuthorization.ts`) uses for
 * RPC methods, not a new scheme. This route is a raw upgrade outside
 * `WsRpcGroup` / `WS_METHODS`, so it gets no compile-time coverage from
 * `RPC_REQUIRED_SCOPES` — the checks below are this route's own hand-written
 * equivalent.
 *
 * Both roles' SCOPE check — and, since task #57, both roles' CREDENTIAL
 * check too, see the AUTH ORDERING NOTE below — is enforced the SAME way:
 * accept the upgrade, then close post-upgrade with
 * `EDITOR_PRESENCE_CLOSE_CODE.invalidCredential` (4401), the SAME code as a
 * bad token, not a new one, because retrying with a valid-but-unscoped
 * token can't self-heal any more than retrying with a bad one can. This
 * ordering choice is load-bearing, not cosmetic: a WebSocket close code
 * (unlike an HTTP status on a failed handshake) is something a raw browser
 * `WebSocket` can actually observe. Rejecting a subscriber's scope failure
 * pre-upgrade (an HTTP 403) was tried first and reverted — it is the
 * difference between a rejection the client can act on and one that
 * degrades into "server unreachable," retried forever with a fresh ws
 * ticket minted on every attempt: a request storm, not just a socket retry.
 * This choice has a cost worth disclosing the same way the publisher's own
 * ordering choice does (see the AUTH ORDERING NOTE below): an
 * authenticated-but-unscoped subscriber now causes a REAL upgrade — a held
 * socket and a live fiber — where it previously got a cheap pre-upgrade
 * 403. `EditorPresenceRegistry`'s `MAX_SUBSCRIBERS` cap only counts
 * REGISTERED subscribers (`addSubscriber` runs strictly after the scope
 * check passes — see `runSubscriberConnection` below), so a stream of
 * valid-but-unscoped connections is uncapped. Not a hole on its own — it
 * still requires a genuine, authenticated token — but the same class of
 * widening the publisher path already discloses, not a new one.
 *
 * Still NOT done: `workspace.root` matching against a thread's cwd. That
 * remains a real hole, deliberately out of scope for this pass — any
 * session with the right role-scope can see (subscriber) or publish as
 * (publisher) presence for every workspace, not just its own. See
 * docs/workbench/OPEN-GATE-presence-authz.md for the full gate history.
 *
 * AUTH ORDERING NOTE: BOTH roles' credential checks run AFTER the upgrade —
 * accept, then authenticate from inside the read loop, then reject with an
 * application close code (>= 4000) plus a human-readable reason. They were
 * asymmetric until task #57, on the premise that a browser could see the
 * subscriber's pre-upgrade HTTP 401. It cannot, and that is measured, not
 * argued from the spec: driving a real Chrome `new WebSocket()` against
 * this real route (harness on a real port, not `layerTest`) produced
 *
 *   subscriber + bad ticket -> server HTTP 401 -> browser sees
 *       code 1006, reason "", wasClean false
 *   NOTHING LISTENING AT ALL -> browser sees
 *       code 1006, reason "", wasClean false      <- byte-identical
 *   publisher + no credential -> server accepts, closes 4400 -> browser sees
 *       code 4400, reason "missing_credential", wasClean true
 *
 * A refused upgrade and a dead port are the same event to a browser. That
 * is why the old shape made a permanent credential failure render as
 * "cannot reach Workbench at <url>" and retry forever on a 30s-capped
 * curve — and worse than a bare socket retry, because `ticket.ts` mints a
 * fresh ws ticket per attempt, so each retry was an HTTP request too.
 *
 * Engines are blind the same way for their own reason: the engine logs the
 * real refusal natively, where no script can read it — measured against a
 * real Godot client, see docs/workbench/godot-probe-findings.md.
 *
 * The cost, disclosed rather than buried: an unauthenticated caller of
 * EITHER role can now cause a real upgrade. Rejection is immediate and
 * neither role touches registry state before authentication succeeds — no
 * connection token is allocated, no publisher registered, and
 * `addSubscriber` runs strictly after both checks pass (see
 * `runSubscriberConnection` / `runPublisherConnection`). The pre-auth
 * surface this widens is the same class the publisher path already
 * disclosed, now shared by both roles rather than a new one.
 *
 * NO NEW CLOSE CODE was introduced for this. The taxonomy is a fixed named
 * set — 4400/4401/4402/4403/4500 — and every deployed client treats an
 * unrecognized code >= 4000 as keep-retrying, so a new code would put
 * shipped plugins into exactly the infinite loop this fixes. The subscriber
 * reuses 4400 (missing) / 4401 (invalid) via the shared
 * `credentialCloseCode` helper the publisher already used.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPresenceCommandScope,
  EDITOR_PRESENCE_DISPATCH_COMMAND_PATH,
  EditorPresenceDispatchCommandInput,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
  type EditorPresenceCommandOutcome,
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

/** Shared by BOTH roles' post-upgrade credential rejection (task #57 moved
 *  the subscriber onto this same path), which is why it is no longer named
 *  for the publisher. */
function credentialCloseCode(error: EnvironmentAuth.ServerAuthCredentialError): number {
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

/**
 * Exported ONLY so `EditorPresenceRoute.test.ts` can drive it directly with
 * a fake `Socket` for a deterministic proof of the `connectionToken`
 * invariant (see the test file's "rejected publishers never register"
 * suite) — real-WebSocket timing cannot reliably win that race in this
 * runtime (a review pass's own suggested reproduction was tried against a
 * deliberately reintroduced bug and did not reproduce; see the test file
 * for the full investigation), so the invariant is proven by controlling
 * message-handler invocation order directly instead of racing real network
 * I/O. Every other caller should keep going through `editorPresenceRouteLayer`.
 */
export const runPublisherConnection = (
  socket: Socket.Socket,
  registry: EditorPresenceRegistry.EditorPresenceRegistry["Service"],
  authenticate: Effect.Effect<
    EnvironmentAuth.AuthenticatedSession,
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

    // The authenticated caller's own `AuthenticatedSession.sessionId`
    // (task #60 — DELIBERATELY sessionId, not subject; see
    // `EditorPresenceRegistry.ts`'s `claimantSessionId` doc for why the
    // subject-based version of this fix was reproducibly broken), set
    // alongside `connectionToken` in `onOpen` below and threaded into
    // every `registerPublisher` call so the registry can refuse a
    // same-sessionId takeover claimed by a DIFFERENT identity — see
    // `EditorPresenceRegistry.ts`'s SESSION TAKEOVER doc.
    let claimantSessionId: string | null = null;

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
            const claimantSessionIdForHello = claimantSessionId ?? undefined;

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
                  {
                    editor: frame.editor,
                    workspace: frame.workspace,
                    capabilities: frame.capabilities,
                  },
                  {
                    close: (code, reason) => rejectUpgrade(code, reason),
                    send: (outbound) => write(outbound).pipe(Effect.catch(() => Effect.void)),
                    claimantSessionId: claimantSessionIdForHello,
                  },
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
              case "commandResult": {
                // No `registeredSessionIds` gate, unlike `selection` — this
                // doesn't need a known session id at all. `resolveCommand`
                // looks the pending command up by `frame.id` and checks it
                // against `token` (this connection's own identity, already
                // gated non-null above) directly; a forged or stale id
                // simply misses and is a silent no-op, same as any other
                // unrecognised frame.
                yield* registry.resolveCommand(
                  frame.id,
                  token,
                  frame.ok ? { ok: true } : { ok: false, error: frame.error },
                );
                return;
              }
              case "playState": {
                // Same "applies to whichever session this connection most
                // recently said hello as" semantics as `selection` above —
                // see spec-unity-play-stop.md's ruling: play state is a
                // level reported through presence, not correlated to any
                // one command.
                if (registeredSessionIds.size === 0) return;
                const latestSessionId = Array.from(registeredSessionIds).at(-1)!;
                yield* registry.updatePublisherPlayState(latestSessionId, token, frame.playState);
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
          onOpen: Effect.gen(function* () {
            const session = yield* authenticate;
            // Scope check, not just authentication — see the module doc's
            // SECURITY NOTE. A publisher is about to be able to cause real
            // engine side effects, so it needs the operate-level scope, the
            // same one `RPC_REQUIRED_SCOPES` requires for every other
            // state-changing orchestration RPC. Rejected with the SAME
            // close code as a bad token (`invalidCredential`, 4401): the
            // token authenticated fine, but retrying with it can never
            // self-heal a missing scope, so a well-behaved client must
            // treat this as credential-class and stop, not hammer.
            if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
              yield* rejectUpgrade(
                EDITOR_PRESENCE_CLOSE_CODE.invalidCredential,
                `insufficient_scope: publisher requires ${AuthOrchestrationOperateScope}`,
              );
              return;
            }
            connectionToken = registry.newConnectionToken();
            claimantSessionId = session.sessionId;
          }).pipe(
            Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
              rejectUpgrade(
                credentialCloseCode(error),
                EnvironmentAuth.serverAuthCredentialReason(error),
              ),
            ),
            Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, () =>
              rejectUpgrade(EDITOR_PRESENCE_CLOSE_CODE.internalError, "internal_error"),
            ),
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
  authenticate: Effect.Effect<
    EnvironmentAuth.AuthenticatedSession,
    EnvironmentAuth.ServerAuthCredentialError | EnvironmentAuth.ServerAuthInternalError
  >,
) =>
  Effect.gen(function* () {
    const write = yield* socket.writer;
    const send = (frame: string) => write(frame).pipe(Effect.catch(() => Effect.void));
    const rejectUpgrade = (code: number, reason: string) =>
      write(new Socket.CloseEvent(code, reason)).pipe(Effect.catch(() => Effect.void));

    // The writer is only actually pumped once the read loop is running (see
    // `run*`'s `onOpen` option below) — a write issued before that point
    // sits in an internal queue that nothing ever drains and hangs
    // indefinitely. Sending the initial `presence` frame — or the scope
    // rejection's close, below — from `onOpen` rather than before
    // `runString` is not a style choice, it is required for either write to
    // complete at all.
    //
    // Subscribers don't send anything meaningful themselves; the message
    // handler is a no-op and the read loop only exists to hold the
    // connection open and observe close/error so we can deregister.
    yield* socket
      .runString(() => Effect.void, {
        onOpen: Effect.gen(function* () {
          // CREDENTIAL check, post-upgrade — see the route's AUTH ORDERING
          // NOTE. Identical in shape to the publisher's, and for a measured
          // reason: a browser cannot observe a refused upgrade at all.
          const session = yield* authenticate;
          // Scope check — see the route's SECURITY NOTE and the comment at
          // this function's call site for why this runs here, post-upgrade,
          // instead of as a pre-upgrade HTTP rejection. Mirrors the
          // publisher's own scope check exactly: same required-scope
          // pattern, same reused close code, and the same shape that
          // guarantees nothing is ever registered before the check passes
          // — there is no `connectionToken`-like flag to race here because
          // the check and the registration both happen sequentially inside
          // this one `onOpen`, never split across a separate pipeline
          // stage the way the publisher's used to be (see the "rejected
          // publishers never register" tests for the bug that shape had).
          if (!session.scopes.includes(AuthOrchestrationReadScope)) {
            yield* rejectUpgrade(
              EDITOR_PRESENCE_CLOSE_CODE.invalidCredential,
              `insufficient_scope: subscriber requires ${AuthOrchestrationReadScope}`,
            );
            return;
          }
          const initialFrame = yield* registry.addSubscriber(send);
          yield* send(initialFrame);
        }).pipe(
          // Same two rejection arms as the publisher's `onOpen`, using the
          // same shared `credentialCloseCode` mapping (4400 missing / 4401
          // invalid). A rejected subscriber never reaches `addSubscriber`,
          // so nothing is registered before the credential check passes.
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            rejectUpgrade(
              credentialCloseCode(error),
              EnvironmentAuth.serverAuthCredentialReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, () =>
            rejectUpgrade(EDITOR_PRESENCE_CLOSE_CODE.internalError, "internal_error"),
          ),
        ),
      })
      .pipe(
        // Same reasoning as the publisher's read loop (see
        // `runPublisherConnection` above): a close WE initiate (the scope
        // rejection above) surfaces as a read-loop FAILURE, not a clean
        // completion, unless recognised here — otherwise a routine
        // rejection would log like a crash.
        Effect.catchFilter(
          Socket.SocketCloseError.filterClean(isServerInitiatedCloseCode),
          () => Effect.void,
        ),
        Effect.ensuring(registry.removeSubscriber(send)),
      );
  });

/**
 * Dispatches ONE command (Play/Stop/Step/Pause) to the editor currently
 * registered under `sessionId`, gated by `AuthPresenceCommandScope` — see
 * `@t3tools/contracts`'s own doc comment on that scope and
 * docs/workbench/spec-editor-presence-commands.md's dedicated-scope
 * decision: `AuthOrchestrationOperateScope` already authorizes
 * `dispatchCommand`/`projectsWriteFile`/`vcsPull`/`sourceControlCloneRepository`
 * and is granted to every standard client by default, so reusing it here
 * would let "make the user's editor execute code" ride on a scope every
 * already-paired client already holds. A missing scope answers
 * `{ ok: false, error: "insufficient_scope" }` — the SAME short,
 * machine-readable shape `EditorPresenceRegistry.ts`'s `sendCommand` uses
 * for every other rejection (not connected, rate limited, timed out), so a
 * caller never needs to special-case "why did this fail" by source.
 *
 * No RPC method calls this yet — task #47's scope is the server + protocol
 * side of commands, not the dock/toolbar trigger that will eventually call
 * it (a later task, per the owner's "server + protocol first" sequencing).
 * Exported so the scope gate can be proven now, before that caller exists,
 * rather than retrofitted once clients are already relying on the
 * unguarded behaviour.
 *
 * `registry` is pulled from EFFECT CONTEXT rather than taken as a
 * parameter — a live-critic finding (this repo's own "looks wired, does
 * nothing" pattern, twice already): a registry passed as a plain argument
 * lets a future RPC handler build or provide a SECOND, independently
 * constructed `EditorPresenceRegistry.layer` instance (an empty one, with
 * no publishers ever registered into it) and pass THAT in instead of the
 * one the live WS route actually populates — every dispatch would then
 * silently and permanently fail `editor_not_connected`, with no error
 * that points at the real cause. Sourcing it from context instead means a
 * caller only has to compose `EditorPresenceRegistry.layer` (the same
 * module-level layer `editorPresenceRouteLayer` itself provides, via
 * `Layer.provideMerge` below so it stays part of that layer's own output)
 * into its own layer graph — Effect's memoization then guarantees the
 * SAME instance, by construction, not by a convention a caller has to
 * remember.
 */
export const dispatchEditorCommand = (
  session: EnvironmentAuth.AuthenticatedSession,
  sessionId: string,
  action: string,
  params?: Record<string, unknown>,
): Effect.Effect<
  EditorPresenceCommandOutcome,
  never,
  Crypto.Crypto | EditorPresenceRegistry.EditorPresenceRegistry
> =>
  Effect.gen(function* () {
    if (!session.scopes.includes(AuthPresenceCommandScope)) {
      return { ok: false, error: "insufficient_scope" } as const;
    }
    const registry = yield* EditorPresenceRegistry.EditorPresenceRegistry;
    return yield* registry.sendCommand(sessionId, action, params);
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

        // Subscribers now match publishers: accept the upgrade
        // unconditionally, then authenticate from inside the read loop and
        // reject with an application close code the client can actually
        // read. See the module doc's AUTH ORDERING NOTE — the old
        // pre-upgrade HTTP 401 was measured, in a real browser against this
        // real route, to be indistinguishable from a dead port (both arrive
        // as code 1006 with an empty reason), which made every permanent
        // credential failure render as "cannot reach Workbench" and retry
        // forever, minting a fresh ws ticket per attempt.
        //
        // BOTH checks are now post-upgrade, in this order: credential
        // first, then scope — see `runSubscriberConnection`.
        const socket = yield* request.upgrade;
        yield* runSubscriberConnection(
          socket,
          registry,
          serverAuth.authenticateWebSocketUpgrade(request),
        );
        return HttpServerResponse.empty();
      }),
      // No `Effect.catchTags({ EnvironmentAuthInvalidError, ... })` here any
      // more: it existed solely to turn the subscriber's pre-upgrade
      // credential failure into an HTTP 401 response. Now that BOTH roles
      // authenticate post-upgrade and reject over the socket, this handler
      // raises neither error, and catching tags nothing produces widened the
      // handler's inferred type to `unknown` — which cascaded type errors
      // out through server.ts and bin.ts, the same shape the marker note at
      // server.ts:313-332 describes.
    );
  }),
  // `provideMerge`, not `provide`: this layer's OWN internal use of
  // `EditorPresenceRegistry.layer` above must stay reachable to whatever
  // composes `editorPresenceRouteLayer` into a bigger graph (a future RPC
  // layer that also needs the registry for `dispatchEditorCommand`, per
  // its own doc comment above) — `provide` would seal the dependency,
  // satisfying it here but hiding it from every sibling layer, which is
  // exactly the setup that lets a sibling accidentally build its own,
  // second, empty registry instead of sharing this one.
).pipe(Layer.provideMerge(EditorPresenceRegistry.layer));

/**
 * `POST /editor-presence/command` — the browser -> server leg task #52
 * found missing: `dispatchEditorCommand` above existed with nothing
 * client-reachable calling it. This route is deliberately thin: it
 * authenticates the caller and calls `dispatchEditorCommand` UNCHANGED,
 * exactly as ruled — it does not touch `EditorPresenceRegistry.ts`,
 * `sendCommand`, or the WS publisher/subscriber route above.
 *
 * NOT a scope-gated route the way `otlpTracesProxyRouteLayer`
 * (`../http.ts`) is: `dispatchEditorCommand` already performs its own
 * `AuthPresenceCommandScope` check and returns `{ok:false,
 * error:"insufficient_scope"}` as an ordinary result value, not an
 * HTTP-layer rejection. Gating here too would make that internal check
 * unreachable dead code. This route only authenticates WHO is calling;
 * `dispatchEditorCommand` alone decides whether they may.
 *
 * UNPROVEN over the wire as of this change: Godot's Play/Stop was verified
 * by driving `dispatchEditorCommand` in-process (a test harness calling the
 * Effect function directly), never through an actual HTTP request from a
 * browser. This route is the first thing that makes that path real —
 * treat it as unverified until exercised live from apps/web.
 *
 * Inherits, rather than fixes, task #60's open finding: commands are
 * addressed purely by `sessionId` with no `workspace.root` check against
 * the caller's own project, the same gap `EditorPresenceRoute`'s own module
 * doc already discloses for the WS route above. `resolveConnectedEditorForProject`
 * (apps/web/src/editorPresence/resolveProjectEditor.ts) narrows this on the
 * CLIENT side — it only offers a `sessionId` whose `workspace.root` already
 * matches the active project — but that is a UI convenience, not a server-side
 * guarantee; a client could still ask for a foreign `sessionId` today. Left
 * for presence-authz's review and #60, per this route's explicit review
 * requirement — not silently absorbed into "done" here.
 */
export const editorPresenceCommandRouteLayer = HttpRouter.add(
  "POST",
  EDITOR_PRESENCE_DISPATCH_COMMAND_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );

    const input = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(EditorPresenceDispatchCommandInput)),
      Effect.orElseSucceed(() => null),
    );
    if (input === null) {
      return HttpServerResponse.text("Bad Request: malformed command", { status: 400 });
    }

    // `dispatchEditorCommand` called UNCHANGED, exactly as ruled.
    const outcome = yield* dispatchEditorCommand(
      session,
      input.sessionId,
      input.action,
      input.params,
    );
    return yield* HttpServerResponse.json(outcome);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  ),
).pipe(HttpRouter.provideRequest(EditorPresenceRegistry.layer));
// `HttpRouter.provideRequest`, NOT `Layer.provide`. `HttpRouter.add(...)`
// does not put a route's requirements in the Layer's bare `R` channel — it
// wraps each one in a nominal, `unique symbol`-branded marker type,
// `Request.From<"Requires", X>` (effect/unstable/http/HttpRouter.ts:496).
// `Layer.provide(layer providing X)` cancels BARE `X` from `R` via a
// structural `Exclude`; it cannot match `Request<"Requires", X>`, a
// different, unrelated type by design. So `.pipe(Layer.provide(...))` here
// type-checks, LOOKS correct, and silently does nothing —
// `EditorPresenceRegistry` stays wrapped and undischarged, only becoming a
// bare requirement again inside `HttpRouter.serve(...)`
// (`Request.Without<R>`), which is why the leak surfaced as a giant
// server-bootstrap cascade far from this route rather than an error here.
// `HttpRouter.provideRequest` is the combinator purpose-built to discharge
// this marker (HttpRouter.ts:1240-1257).
//
// This was tried three ways before landing here, each one a real dead end,
// not a stylistic preference:
// 1. Bare (no provide at all) — type-checks fine WHEN merged alongside
//    `editorPresenceRouteLayer` as a sibling (its own `provideMerge` of the
//    identical `EditorPresenceRegistry.layer` supplies the ambient
//    context), but leaves the requirement genuinely unsatisfied in any
//    composition that doesn't happen to include that sibling — which is
//    exactly what every test file that builds its OWN server composition
//    hit.
// 2. `Layer.provide(EditorPresenceRegistry.layer)` — the bug this comment
//    exists to warn about. It was "verified" once via two real,
//    over-the-wire round-trip tests that both passed — but those tests
//    ALWAYS served this route merged with `editorPresenceRouteLayer`, so
//    they never distinguished "my own provide discharged the requirement"
//    from "the sibling's ambient supply did, and my provide is a no-op
//    either way." Never re-tested in isolation before being reported as
//    fixed.
// 3. `HttpRouter.provideRequest(EditorPresenceRegistry.layer)` (this one) —
//    the only one that discharges the marker type at all, verified by
//    type-checking this layer in isolation (no sibling in scope) and
//    confirming zero remaining requirements, not just by a test that
//    happened to pass for an unrelated reason.
//
// Proof technique for any future case like this: type-check the composed
// route+service layer in TOTAL isolation — no surrounding `mergeAll`, no
// sibling that could be supplying the same service ambiently — before
// trusting a passing test as proof of which combinator did the work.
