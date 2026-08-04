/**
 * Proves the publisher path's accept-then-authenticate ordering (see the
 * "AUTH ORDERING NOTE" in EditorPresenceRoute.ts): a bad credential must
 * still let the WebSocket upgrade succeed, then close with an
 * application-range code and a non-empty reason — an HTTP 401 refused
 * before the upgrade is invisible to engine clients, see
 * docs/workbench/godot-probe-findings.md. A good credential must still
 * yield a working session.
 *
 * Exercises the route over a real WebSocket against a real HTTP server
 * (`NodeHttpServer.layerTest`) rather than calling the route's internals
 * directly, because the thing under test is what actually arrives on the
 * wire — exactly what an engine's WebSocket client observes.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

import { editorPresenceRouteLayer, runPublisherConnection } from "./EditorPresenceRoute.ts";
import * as EditorPresenceRegistry from "./EditorPresenceRegistry.ts";
import { buildPongFrame } from "./protocol.ts";

const makeEnvironmentAuthLayer = () =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-editor-presence-route-test-" }),
    ),
  );

const getPublisherWsUrl = () =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `ws://127.0.0.1:${address.port}/editor-presence?role=publisher`;
  });

const getSubscriberWsUrl = () =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `ws://127.0.0.1:${address.port}/editor-presence?role=subscriber`;
  });

interface PresenceFrame {
  readonly editors: ReadonlyArray<{ readonly session: { readonly id: string } }>;
}

/** Connects a fresh subscriber and resolves with the FIRST `presence`
 * frame it receives — the same thing a fresh subscriber process observes,
 * which is exactly how bug #1 (a second `hello` orphaning the first
 * registration) was originally measured: not by inspecting the registry's
 * internals, but by a fresh subscriber seeing (or not seeing) a ghost. */
const connectSubscriberAndReadFirstFrame = (
  url: string,
  bearerToken: string,
): Effect.Effect<PresenceFrame> =>
  Effect.callback<PresenceFrame>((resume) => {
    const socket = new NodeSocket.NodeWS.WebSocket(url, {
      headers: { authorization: `Bearer ${bearerToken}` },
    });
    socket.on("message", (data) => {
      resume(Effect.succeed(JSON.parse(rawDataToString(data)) as PresenceFrame));
      socket.close();
    });
    socket.on("close", () => {});
    socket.on("unexpected-response", (request, response) => {
      response.resume();
      request.destroy();
      resume(Effect.die(new Error(`subscriber upgrade failed: HTTP ${response.statusCode}`)));
    });
    socket.on("error", () => {});
  });

/** Reads a `ws` `RawData` payload (Buffer | ArrayBuffer | Buffer[]) as utf8,
 * matching how the protocol always sends single text frames. */
function rawDataToString(data: NodeSocket.NodeWS.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/** Builds a `hello` frame's wire text for a given session id — a plain
 * JSON string, matching the raw text this route actually receives on the
 * wire (there is deliberately no packages/contracts schema for this
 * protocol; see EditorPresenceRoute.ts's module doc). */
function helloFrameText(sessionId: string, omitVersion = false): string {
  const editor: Record<string, string> = { id: "unity", name: "Unity Editor" };
  if (!omitVersion) editor.version = "6000.3.14f1";
  return JSON.stringify({
    v: 1,
    type: "hello",
    editor,
    session: { id: sessionId },
    workspace: { root: "/Users/piero/Projects/Deepmind" },
  });
}

interface PublisherUpgradeOutcome {
  /** Whether the WebSocket handshake completed (HTTP 101). */
  readonly opened: boolean;
  /** Set when the server refused the upgrade at the HTTP layer instead of
   * accepting it and closing over the wire — the old (wrong) behaviour. */
  readonly httpStatus: number | null;
  readonly closeCode: number | null;
  readonly closeReason: string | null;
}

/** Connects a raw `ws` client (not effect's `Socket` abstraction) to the
 * publisher route and resolves once the connection reaches a terminal
 * state, so the test observes exactly what an engine's WebSocket client
 * would: whether the upgrade happened at all, and if so, the close code and
 * reason the server sent. */
const probePublisherUpgrade = (
  url: string,
  headers: Record<string, string>,
): Effect.Effect<PublisherUpgradeOutcome> =>
  Effect.callback<PublisherUpgradeOutcome>((resume) => {
    let opened = false;
    const socket = new NodeSocket.NodeWS.WebSocket(url, { headers });
    socket.on("open", () => {
      opened = true;
    });
    socket.on("close", (code, reason) => {
      resume(
        Effect.succeed({
          opened,
          httpStatus: null,
          closeCode: code,
          closeReason: rawDataToString(reason),
        }),
      );
    });
    socket.on("unexpected-response", (request, response) => {
      response.resume();
      request.destroy();
      resume(
        Effect.succeed({
          opened,
          httpStatus: response.statusCode ?? null,
          closeCode: null,
          closeReason: null,
        }),
      );
    });
    socket.on("error", () => {
      // A refused-upgrade or a self-initiated close is always observed via
      // "unexpected-response" or "close" above; a bare transport error here
      // would otherwise leave the probe hanging.
    });
  });

interface SubscriberUpgradeOutcome {
  /** Whether the WebSocket handshake completed (HTTP 101). */
  readonly opened: boolean;
  /** Set when the server refused the upgrade at the HTTP layer — the
   * CREDENTIAL check's rejection shape (see the AUTH ORDERING NOTE:
   * subscribers authenticate before the upgrade). The SCOPE check, by
   * contrast, rejects post-upgrade with a coded close, same as a
   * publisher — see `probePublisherUpgrade`, reused for that case below. */
  readonly httpStatus: number | null;
}

/** For the subscriber CREDENTIAL path only (see the interface doc above) —
 * a rejection here is always an HTTP status returned before the handshake
 * completes. */
const probeSubscriberUpgrade = (
  url: string,
  headers: Record<string, string>,
): Effect.Effect<SubscriberUpgradeOutcome> =>
  Effect.callback<SubscriberUpgradeOutcome>((resume) => {
    const socket = new NodeSocket.NodeWS.WebSocket(url, { headers });
    socket.on("open", () => {
      resume(Effect.succeed({ opened: true, httpStatus: null }));
      socket.close();
    });
    socket.on("close", () => {});
    socket.on("unexpected-response", (request, response) => {
      response.resume();
      request.destroy();
      resume(Effect.succeed({ opened: false, httpStatus: response.statusCode ?? null }));
    });
    socket.on("error", () => {
      // A refused-upgrade is always observed via "unexpected-response"
      // above; a bare transport error here would otherwise leave the probe
      // hanging.
    });
  });

interface SubscriberScopeRejectionOutcome {
  /** Whether the WebSocket handshake completed (HTTP 101). */
  readonly opened: boolean;
  readonly closeCode: number | null;
  readonly closeReason: string | null;
  /**
   * Every text frame received before the connection closed — the entire
   * reason this probe exists. `probePublisherUpgrade` (reused for the
   * subscriber's scope rejection elsewhere in this file) registers no
   * `message` listener, so it cannot tell the difference between "rejected
   * before it ever saw the registry" and "rejected AFTER already receiving
   * a full `presence` frame" — both look identical to a probe that only
   * watches for `open`/`close`. A regression that moved
   * `registry.addSubscriber(send)` above the scope check would still close
   * with 4401 (so every OTHER assertion in this file would stay green) but
   * would ALSO leak a real presence frame — someone else's workspace root
   * and editor identities — to a caller that was never entitled to read
   * any of it. This is the property the scope check exists to guarantee
   * for a subscriber; nothing else in this file asserts it.
   */
  readonly messages: ReadonlyArray<string>;
}

/** Like `probePublisherUpgrade`, but also collects every `message` frame
 * the connection receives before it closes — see the outcome type's doc
 * for why that specifically is the property under test here. */
const probeSubscriberScopeRejection = (
  url: string,
  headers: Record<string, string>,
): Effect.Effect<SubscriberScopeRejectionOutcome> =>
  Effect.callback<SubscriberScopeRejectionOutcome>((resume) => {
    let opened = false;
    const messages: Array<string> = [];
    const socket = new NodeSocket.NodeWS.WebSocket(url, { headers });
    socket.on("open", () => {
      opened = true;
    });
    socket.on("message", (data) => {
      messages.push(rawDataToString(data));
    });
    socket.on("close", (code, reason) => {
      resume(
        Effect.succeed({
          opened,
          closeCode: code,
          closeReason: rawDataToString(reason),
          messages,
        }),
      );
    });
    socket.on("unexpected-response", (request, response) => {
      response.resume();
      request.destroy();
      resume(Effect.die(new Error(`subscriber upgrade failed: HTTP ${response.statusCode}`)));
    });
    socket.on("error", () => {});
  });

it.layer(NodeServices.layer)("EditorPresenceRoute publisher auth ordering", (it) => {
  it.effect("closes a missing-credential publisher upgrade with 4400 after accepting it", () =>
    Effect.gen(function* () {
      yield* HttpRouter.serve(editorPresenceRouteLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);

      const url = yield* getPublisherWsUrl();
      const outcome = yield* probePublisherUpgrade(url, {});

      assert.isNull(outcome.httpStatus);
      assert.isTrue(outcome.opened);
      assert.strictEqual(outcome.closeCode, 4400);
      assert.strictEqual(outcome.closeReason, "missing_credential");
    }).pipe(
      Effect.scoped,
      Effect.provide(makeEnvironmentAuthLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest))),
    ),
  );

  it.effect("closes an invalid-credential publisher upgrade with 4401 after accepting it", () =>
    Effect.gen(function* () {
      yield* HttpRouter.serve(editorPresenceRouteLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);

      const url = yield* getPublisherWsUrl();
      const outcome = yield* probePublisherUpgrade(url, {
        authorization: "Bearer not-a-real-token",
      });

      assert.isNull(outcome.httpStatus);
      assert.isTrue(outcome.opened);
      assert.strictEqual(outcome.closeCode, 4401);
      assert.strictEqual(outcome.closeReason, "invalid_credential");
    }).pipe(
      Effect.scoped,
      Effect.provide(makeEnvironmentAuthLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest))),
    ),
  );

  it.effect("still yields a working publisher session for a valid credential", () =>
    Effect.gen(function* () {
      yield* HttpRouter.serve(editorPresenceRouteLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);

      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* serverAuth.issueSession();
      const url = yield* getPublisherWsUrl();

      const pongFrame = yield* Effect.callback<string>((resume) => {
        const socket = new NodeSocket.NodeWS.WebSocket(url, {
          headers: { authorization: `Bearer ${issued.token}` },
        });
        socket.on("open", () => {
          socket.send(JSON.stringify({ v: 1, type: "ping" }));
        });
        socket.on("message", (data) => {
          resume(Effect.succeed(rawDataToString(data)));
          socket.close();
        });
        socket.on("close", () => {});
        socket.on("unexpected-response", (request, response) => {
          response.resume();
          request.destroy();
          resume(
            Effect.die(
              new Error(
                `Expected the publisher upgrade to succeed, got HTTP ${response.statusCode}`,
              ),
            ),
          );
        });
        socket.on("error", () => {});
      });

      assert.strictEqual(pongFrame, buildPongFrame());
    }).pipe(
      Effect.scoped,
      Effect.provide(makeEnvironmentAuthLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest))),
    ),
  );
});

/**
 * Proves the per-role scope enforcement described in the module doc's
 * SECURITY NOTE: a session that authenticates fine but lacks the role's
 * required scope must still be refused. Deliberately issues sessions with a
 * NARROW, explicit scope list (never the admin-default `issueSession()`
 * used elsewhere in this file) so each test proves the exact scope the
 * route requires, not merely "some scope was present."
 */
it.layer(NodeServices.layer)("EditorPresenceRoute per-role scope enforcement", (it) => {
  it.effect(
    "closes a publisher session that authenticates but lacks the operate scope, credential-class",
    () =>
      Effect.gen(function* () {
        yield* HttpRouter.serve(editorPresenceRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);

        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        // Read-only: a valid, authenticating token that simply was never
        // granted the operate scope a publisher needs.
        const issued = yield* serverAuth.issueSession({ scopes: [AuthOrchestrationReadScope] });
        const url = yield* getPublisherWsUrl();

        const outcome = yield* probePublisherUpgrade(url, {
          authorization: `Bearer ${issued.token}`,
        });

        assert.isNull(outcome.httpStatus);
        assert.isTrue(outcome.opened);
        // Reuses the SAME close code as a bad token (see the module doc):
        // retrying with this token can never self-heal a missing scope, so
        // this must land in the credential-class bucket, not alongside
        // internal_error (4500, transient/keep-retrying).
        assert.strictEqual(outcome.closeCode, 4401);
        assert.isTrue((outcome.closeReason ?? "").includes("insufficient_scope"));
        assert.notStrictEqual(outcome.closeCode, 4500);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          makeEnvironmentAuthLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
        ),
      ),
  );

  it.effect("accepts a publisher session with exactly the operate scope", () =>
    Effect.gen(function* () {
      yield* HttpRouter.serve(editorPresenceRouteLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);

      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* serverAuth.issueSession({ scopes: [AuthOrchestrationOperateScope] });
      const url = yield* getPublisherWsUrl();

      const pongFrame = yield* Effect.callback<string>((resume) => {
        const socket = new NodeSocket.NodeWS.WebSocket(url, {
          headers: { authorization: `Bearer ${issued.token}` },
        });
        socket.on("open", () => {
          socket.send(JSON.stringify({ v: 1, type: "ping" }));
        });
        socket.on("message", (data) => {
          resume(Effect.succeed(rawDataToString(data)));
          socket.close();
        });
        socket.on("close", () => {});
        socket.on("unexpected-response", (request, response) => {
          response.resume();
          request.destroy();
          resume(
            Effect.die(
              new Error(
                `Expected the publisher upgrade to succeed, got HTTP ${response.statusCode}`,
              ),
            ),
          );
        });
        socket.on("error", () => {});
      });

      assert.strictEqual(pongFrame, buildPongFrame());
    }).pipe(
      Effect.scoped,
      Effect.provide(makeEnvironmentAuthLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest))),
    ),
  );

  it.effect(
    "closes a subscriber session that authenticates but lacks the read scope, credential-class, post-upgrade, before any presence frame reaches it",
    () =>
      Effect.gen(function* () {
        yield* HttpRouter.serve(editorPresenceRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);

        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        // Operate-only: a valid, authenticating token that simply was
        // never granted the read scope a subscriber needs.
        const issued = yield* serverAuth.issueSession({ scopes: [AuthOrchestrationOperateScope] });
        const url = yield* getSubscriberWsUrl();

        // Deliberately NOT `probePublisherUpgrade` (reused elsewhere in
        // this file, but it registers no `message` listener) — see
        // `probeSubscriberScopeRejection`'s own doc comment for why that
        // specifically would make this test blind to the property it
        // exists to prove. The subscriber's scope rejection is deliberately
        // NOT an HTTP status (see the module doc's SECURITY NOTE: a
        // pre-upgrade 403 here would be invisible to a real browser
        // `WebSocket`), so this must observe the upgrade completing and
        // THEN a coded close, exactly like a publisher.
        const outcome = yield* probeSubscriberScopeRejection(url, {
          authorization: `Bearer ${issued.token}`,
        });

        assert.isTrue(outcome.opened);
        // SAME close code as a bad token, and as the publisher's own scope
        // rejection — credential-class, never 4500.
        assert.strictEqual(outcome.closeCode, 4401);
        assert.isTrue((outcome.closeReason ?? "").includes("insufficient_scope"));
        assert.notStrictEqual(outcome.closeCode, 4500);
        // The property this check exists for: an unscoped subscriber must
        // never receive so much as one presence frame, not merely "the
        // connection eventually closed with the right code."
        assert.deepStrictEqual(outcome.messages, []);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          makeEnvironmentAuthLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
        ),
      ),
  );

  it.effect("accepts a subscriber session with exactly the read scope", () =>
    Effect.gen(function* () {
      yield* HttpRouter.serve(editorPresenceRouteLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);

      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* serverAuth.issueSession({ scopes: [AuthOrchestrationReadScope] });
      const url = yield* getSubscriberWsUrl();

      const presence = yield* connectSubscriberAndReadFirstFrame(url, issued.token);
      assert.deepStrictEqual(presence.editors, []);
    }).pipe(
      Effect.scoped,
      Effect.provide(makeEnvironmentAuthLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest))),
    ),
  );

  // The credential check runs strictly BEFORE the upgrade and the scope
  // check runs strictly AFTER it — this proves the credential path is
  // untouched by the scope check directly, rather than just by code
  // inspection: a missing credential still never reaches the upgrade at
  // all, and still surfaces as a plain pre-upgrade 401, not the scope
  // check's post-upgrade 4401 close.
  it.effect("still returns a pre-upgrade 401 for a missing-credential subscriber, unchanged", () =>
    Effect.gen(function* () {
      yield* HttpRouter.serve(editorPresenceRouteLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);

      const url = yield* getSubscriberWsUrl();
      const outcome = yield* probeSubscriberUpgrade(url, {});

      assert.isFalse(outcome.opened);
      assert.strictEqual(outcome.httpStatus, 401);
    }).pipe(
      Effect.scoped,
      Effect.provide(makeEnvironmentAuthLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest))),
    ),
  );
});

/** Connects a publisher, sends every frame in `frameTexts` in order over
 * the SAME socket, then closes it and resolves only once the server has
 * actually observed the close (the 'close' event on the client side) — so
 * a caller can be sure the route's cleanup already ran before it goes on
 * to check the registry's state via a fresh subscriber. */
const publishFramesThenClose = (
  url: string,
  bearerToken: string,
  frameTexts: ReadonlyArray<string>,
): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const socket = new NodeSocket.NodeWS.WebSocket(url, {
      headers: { authorization: `Bearer ${bearerToken}` },
    });
    socket.on("open", () => {
      for (const text of frameTexts) socket.send(text);
      socket.close();
    });
    socket.on("close", () => {
      resume(Effect.void);
    });
    socket.on("unexpected-response", (request, response) => {
      response.resume();
      request.destroy();
      resume(Effect.die(new Error(`publisher upgrade failed: HTTP ${response.statusCode}`)));
    });
    socket.on("error", () => {});
  });

/** Connects a publisher, sends one frame, and resolves with the close code
 * and reason the server sends back — for observing a rejection that
 * happens from inside the read loop (as opposed to `onOpen`, which
 * `probePublisherUpgrade` above already covers for the auth-ordering
 * tests). */
const publishFrameAndObserveClose = (
  url: string,
  bearerToken: string,
  frameText: string,
): Effect.Effect<{ readonly closeCode: number; readonly closeReason: string }> =>
  Effect.callback((resume) => {
    const socket = new NodeSocket.NodeWS.WebSocket(url, {
      headers: { authorization: `Bearer ${bearerToken}` },
    });
    socket.on("open", () => {
      socket.send(frameText);
    });
    socket.on("close", (code, reason) => {
      resume(Effect.succeed({ closeCode: code, closeReason: rawDataToString(reason) }));
    });
    socket.on("unexpected-response", (request, response) => {
      response.resume();
      request.destroy();
      resume(Effect.die(new Error(`publisher upgrade failed: HTTP ${response.statusCode}`)));
    });
    socket.on("error", () => {});
  });

/** Minimal fake `AuthenticatedSession` for the deterministic invariant
 * tests below — only `scopes` is ever read by `runPublisherConnection`. */
function makeFakeAuthenticatedSession(
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): EnvironmentAuth.AuthenticatedSession {
  return {
    sessionId: AuthSessionId.make("test-session"),
    subject: "test-subject",
    method: "bearer-access-token",
    scopes,
  };
}

/** A registry double that records `registerPublisher` calls and no-ops
 * everything else — every OTHER test in this file exercises the REAL
 * registry over the wire; this suite is specifically about whether
 * `registerPublisher` gets called at all, so a spy is the right tool. */
function makePublisherRegistrySpy(): {
  readonly registry: EditorPresenceRegistry.EditorPresenceRegistry["Service"];
  readonly registerPublisherCallCount: () => number;
} {
  let calls = 0;
  const registry: EditorPresenceRegistry.EditorPresenceRegistry["Service"] = {
    newConnectionToken: () => Symbol("test-connection-token"),
    registerPublisher: () => {
      calls++;
      return Effect.void;
    },
    updatePublisherSelection: () => Effect.void,
    removePublisher: () => Effect.void,
    addSubscriber: () => Effect.succeed("{}"),
    removeSubscriber: () => Effect.void,
  };
  return { registry, registerPublisherCallCount: () => calls };
}

/** A fake `Socket` whose `runRaw` runs `onOpen`, then — deterministically,
 * no timing games — invokes the message handler with `helloText` exactly
 * once, then completes. Proves the SAME thing a real network race would
 * (does a `hello` processed immediately after `onOpen` settles ever reach
 * the registry) without depending on winning an unwinnable real-network
 * race — see the doc comment on the suite below for why a real-wire
 * version of this specific test does not work in this runtime. Records
 * every close the connection under test writes, so a passing test can be
 * confirmed to still be exercising an actual rejection, not one that
 * silently stopped closing the connection at all. */
function makeHandlerAfterOnOpenSocket(helloText: string): {
  readonly socket: Socket.Socket;
  readonly writtenCloses: Array<{ readonly code: number; readonly reason: string }>;
} {
  const writtenCloses: Array<{ readonly code: number; readonly reason: string }> = [];
  const socket = Socket.make({
    runRaw: (handler, opts) =>
      Effect.gen(function* () {
        if (opts?.onOpen) yield* opts.onOpen;
        const result = handler(helloText);
        if (Effect.isEffect(result)) yield* result;
      }),
    writer: Effect.succeed((chunk) => {
      if (Socket.isCloseEvent(chunk)) {
        writtenCloses.push({ code: chunk.code, reason: chunk.reason ?? "" });
      }
      return Effect.void;
    }),
  });
  return { socket, writtenCloses };
}

/**
 * Proves the `connectionToken` invariant fixed alongside the scope check
 * above: `connectionToken` (and therefore `registry.registerPublisher`)
 * must never become reachable on ANY rejected publisher connection — bad
 * credential OR insufficient scope — even if a `hello` frame arrives the
 * instant `onOpen` resolves. A review pass found this reachable: with a
 * naive `authenticate.pipe(catchIf, catchIf, Effect.map(() => connectionToken
 * = ...))` shape, the trailing `Effect.map` runs UNCONDITIONALLY once a
 * `catchIf` recovers a rejection into a successful void — so a `hello`
 * processed right after `onOpen` settles could register an unauthenticated
 * or unscoped editor identity, broadcasting it to every subscriber.
 *
 * NOT proven here over a real WebSocket, unlike every other test in this
 * file — that was tried first and abandoned after a real investigation, not
 * skipped for convenience. `effect`'s `Socket.ts` (`fromWebSocket`) attaches
 * the 'message' listener and opens the write latch BEFORE `onOpen` even
 * runs, so a rejection's `write(CloseEvent)` reaches the real `ws.close()`
 * call within microtasks of the (fast, in-process) auth/scope decision —
 * this was checked directly: at send-time, `ws.readyState` was already
 * CLOSING/CLOSED for every client-side send delay tried (0, 1, 2, 5, 10,
 * 20, 50ms), and separately, artificially slowing the SERVER's own auth
 * decision (5, 20, 50ms, via a decorated `EnvironmentAuth` layer) still
 * produced 0/reproductions, because a `hello` sent immediately on `open`
 * arrives and is dispatched (and, correctly, dropped — `connectionToken`
 * is still null either way) LONG before any realistic auth delay elapses;
 * the message is evaluated exactly once, at whatever moment it arrives, not
 * re-evaluated once auth later resolves. In short: this implementation's
 * close-notification propagation is too fast for real client-side timing to
 * lose the race in either direction — which is good news operationally, but
 * means a real-wire test of this specific invariant would pass with EITHER
 * the buggy or the fixed shape, proving nothing (the sibling scope-rejection
 * tests above already cover the real-wire, close-code-and-reason behavior
 * that publishers/subscribers actually observe; this suite covers the
 * internal invariant a wire-level test structurally cannot).
 *
 * So this drives `runPublisherConnection` (exported for exactly this)
 * directly, with a fake `Socket` that deterministically invokes the message
 * handler with a `hello` frame immediately after `onOpen` settles — no
 * timing games, no flakiness, and it DOES fail against the naive shape
 * above (verified: reintroducing that exact shape turns both tests in this
 * suite red).
 */
it.effect(
  "a publisher rejected for insufficient scope never registers a hello sent right after onOpen",
  () =>
    Effect.gen(function* () {
      const registrySpy = makePublisherRegistrySpy();
      // Read-only: authenticates fine, but lacks the operate scope a
      // publisher needs — the rejection under test.
      const session = makeFakeAuthenticatedSession([AuthOrchestrationReadScope]);
      const fakeSocket = makeHandlerAfterOnOpenSocket(helloFrameText("scope-race-repro"));

      yield* runPublisherConnection(
        fakeSocket.socket,
        registrySpy.registry,
        Effect.succeed(session),
      ).pipe(
        // The fake socket's `runRaw` always completes normally (never a real
        // close/error) — nothing to catch, this just runs to completion.
        Effect.scoped,
      );

      assert.strictEqual(registrySpy.registerPublisherCallCount(), 0);
      // Also confirm the rejection itself still happened (the connection
      // wasn't just silently left open) — the same 4401 the wire-level tests
      // above assert, so this test isn't ALSO passing for the wrong reason.
      assert.deepStrictEqual(fakeSocket.writtenCloses, [
        {
          code: 4401,
          reason: `insufficient_scope: publisher requires ${AuthOrchestrationOperateScope}`,
        },
      ]);
    }),
);

it.effect(
  "a publisher rejected for a bad credential never registers a hello sent right after onOpen",
  () =>
    Effect.gen(function* () {
      const registrySpy = makePublisherRegistrySpy();
      const fakeSocket = makeHandlerAfterOnOpenSocket(helloFrameText("credential-race-repro"));

      yield* runPublisherConnection(
        fakeSocket.socket,
        registrySpy.registry,
        Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({})),
      ).pipe(Effect.scoped);

      assert.strictEqual(registrySpy.registerPublisherCallCount(), 0);
      assert.deepStrictEqual(fakeSocket.writtenCloses, [
        { code: 4401, reason: "invalid_credential" },
      ]);
    }),
);

it.layer(NodeServices.layer)("EditorPresenceRoute registry bug fixes", (it) => {
  // Bug #1, measured live: a publisher that sends a second `hello` with a
  // different session.id on the SAME socket (valid per the protocol —
  // nothing forbids regenerating a session id without reconnecting) left
  // the FIRST session's registry entry permanently unreachable once the
  // socket closed, because cleanup only ever removed the single
  // last-seen session id. Observed exactly as the original critic pass
  // did: not by inspecting registry internals, but by a FRESH subscriber
  // still seeing a ghost after the publisher fully disconnected.
  it.effect("closing a publisher that sent two hellos leaves no orphaned entry", () =>
    Effect.gen(function* () {
      yield* HttpRouter.serve(editorPresenceRouteLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);

      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* serverAuth.issueSession();
      const publisherUrl = yield* getPublisherWsUrl();
      const subscriberUrl = yield* getSubscriberWsUrl();

      yield* publishFramesThenClose(publisherUrl, issued.token, [
        helloFrameText("orphan-repro-a"),
        helloFrameText("orphan-repro-b"),
      ]);

      const presence = yield* connectSubscriberAndReadFirstFrame(subscriberUrl, issued.token);
      assert.deepStrictEqual(presence.editors, []);
    }).pipe(
      Effect.scoped,
      Effect.provide(makeEnvironmentAuthLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest))),
    ),
  );

  // Bug #3: a malformed hello used to be dropped with zero feedback — the
  // socket stayed open, ping still returned pong, and the connection
  // looked perfectly healthy while no subscriber would ever see it. Now
  // it must close loudly with a coded, human-readable reason, using a
  // code outside the credential class so a well-behaved engine client
  // keeps retrying (the server's fault is "you sent a broken hello," not
  // "your token is bad").
  it.effect("a malformed hello closes the connection with a coded, readable reason", () =>
    Effect.gen(function* () {
      yield* HttpRouter.serve(editorPresenceRouteLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);

      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* serverAuth.issueSession();
      const url = yield* getPublisherWsUrl();

      // Missing editor.version — one of the seven field faults named in
      // the critic pass.
      const outcome = yield* publishFrameAndObserveClose(
        url,
        issued.token,
        helloFrameText("malformed-hello-repro", true),
      );

      assert.strictEqual(outcome.closeCode, 4403);
      assert.isTrue(outcome.closeReason.length > 0);
      // Outside the credential class (4400/4401) — a well-behaved client
      // (see the Godot addon's is_credential_close) keeps retrying on this
      // code rather than giving up.
      assert.notInclude([4400, 4401], outcome.closeCode);
    }).pipe(
      Effect.scoped,
      Effect.provide(makeEnvironmentAuthLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest))),
    ),
  );
});
