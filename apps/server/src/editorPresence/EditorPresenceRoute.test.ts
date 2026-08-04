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
  AuthPresenceCommandScope,
  AuthSessionId,
  EDITOR_PRESENCE_DISPATCH_COMMAND_PATH,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

import {
  dispatchEditorCommand,
  editorPresenceCommandRouteLayer,
  editorPresenceRouteLayer,
  runPublisherConnection,
} from "./EditorPresenceRoute.ts";
import * as EditorPresenceRegistry from "./EditorPresenceRegistry.ts";
import { buildPongFrame, DEFAULT_EDITOR_PRESENCE_CAPABILITIES } from "./protocol.ts";

const decodeUnknownJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

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

/** Posts a real HTTP request to `editorPresenceCommandRouteLayer` — the
 * browser -> server leg task #52 added. Every other test in this file
 * drives `dispatchEditorCommand` in-process; this is the one that proves
 * the wire path itself. */
const postDispatchCommand = (input: {
  readonly bearerToken: string;
  readonly sessionId: string;
  readonly action: string;
  readonly params?: Record<string, unknown>;
}) =>
  Effect.gen(function* () {
    // A RELATIVE path, not `http://127.0.0.1:${port}${path}` — matching
    // server.test.ts's own proven `fetchEffect`/`testRequestUrl` pattern.
    // `NodeHttpServer.layerTest`'s `HttpClient` is an in-process test
    // client wired directly to the router, not a real TCP listener; an
    // absolute host:port URL routes over a REAL socket instead, which this
    // test server never actually accepts connections on — every response
    // came back a fast, empty 404 because the request never reached the
    // router at all. Found by comparing against `server.test.ts`'s working
    // helper after every other theory (layer structure, merge order,
    // route path) was ruled out by testing this route served completely
    // alone and still getting the identical 404.
    const request = HttpClientRequest.post(EDITOR_PRESENCE_DISPATCH_COMMAND_PATH).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${input.bearerToken}`),
      HttpClientRequest.bodyJsonUnsafe({
        sessionId: input.sessionId,
        action: input.action,
        ...(input.params ? { params: input.params } : {}),
      }),
    );
    const response = yield* HttpClient.execute(request);
    return yield* response.json;
  });

interface PresenceFrame {
  readonly editors: ReadonlyArray<{
    readonly session: { readonly id: string };
    readonly capabilities: ReadonlyArray<string>;
  }>;
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
 * protocol; see EditorPresenceRoute.ts's module doc). `capabilities`
 * defaults to omitted (undefined) rather than the protocol's own default —
 * so a caller that wants to exercise the DEFAULTING behavior itself just
 * doesn't pass it, matching how a real pre-commands plugin's hello looks.
 * Typed `unknown` rather than `ReadonlyArray<string>` so a caller can ALSO
 * exercise the malformed-capabilities rejection path with this same
 * helper, instead of hand-building raw JSON. */
function helloFrameText(sessionId: string, omitVersion = false, capabilities?: unknown): string {
  const editor: Record<string, string> = { id: "unity", name: "Unity Editor" };
  if (!omitVersion) editor.version = "6000.3.14f1";
  return JSON.stringify({
    v: 1,
    type: "hello",
    editor,
    session: { id: sessionId },
    workspace: { root: "/Users/piero/Projects/Deepmind" },
    ...(capabilities !== undefined ? { capabilities } : {}),
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
    updatePublisherPlayState: () => Effect.void,
    removePublisher: () => Effect.void,
    addSubscriber: () => Effect.succeed("{}"),
    removeSubscriber: () => Effect.void,
    sendCommand: () => Effect.succeed({ ok: false, error: "not_implemented_in_spy" }),
    resolveCommand: () => Effect.void,
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

  // Missing a `capabilities` array entirely is fine (defaults) — but a
  // PRESENT, malformed one is a hello field fault like any other, per
  // protocol.test.ts's own coverage. This proves it end-to-end over the
  // wire, the same way the other six field faults already are above.
  it.effect(
    "malformed hello.capabilities closes the connection with 4403, same as any other bad field",
    () =>
      Effect.gen(function* () {
        yield* HttpRouter.serve(editorPresenceRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);

        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const issued = yield* serverAuth.issueSession();
        const url = yield* getPublisherWsUrl();

        // "play,stop" — a comma-joined string, not an array — is the fault.
        const badHello = helloFrameText("bad-capabilities-repro", false, "play,stop");
        const outcome = yield* publishFrameAndObserveClose(url, issued.token, badHello);

        assert.strictEqual(outcome.closeCode, 4403);
        assert.isTrue(outcome.closeReason.length > 0);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          makeEnvironmentAuthLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
        ),
      ),
  );
});

/**
 * Task #47 — commands (server -> engine). See
 * docs/workbench/spec-editor-presence-commands.md (frozen). Registry-level
 * dispatch mechanics (rate limiting, correlation, disconnect handling, the
 * connectionToken guard on replies) are covered in
 * EditorPresenceRegistry.test.ts, where they can be proven deterministically
 * without real network timing — see that file's own comment on why. This
 * suite covers what's specific to the ROUTE: `capabilities` actually
 * reaching a subscriber over the wire, the dedicated-scope gate on
 * `dispatchEditorCommand`, and one full real-WebSocket round trip proving
 * the route and registry are actually wired together correctly, not just
 * independently correct.
 */
/**
 * Connects a publisher, sends `hello`, and resolves once registration is
 * CONFIRMED via ping/pong (processed by the same serial per-connection
 * message loop as `hello`) — WITHOUT closing the connection, unlike
 * `publishFramesThenClose`. Every listener is attached in the SAME
 * synchronous callback that constructs the socket, before the event loop
 * gets a chance to run at all — a fast loopback connection can otherwise
 * fire "open" before a listener attached even one macrotask later is there
 * to catch it. (Measured: getting this ordering wrong — constructing the
 * socket, then attaching its "open" listener via a LATER, separate
 * `Effect.callback` — hung two of this suite's tests for the full 60s test
 * timeout on the first attempt.) `onMessage` keeps firing for every frame
 * received AFTER the ready pong, which is how the command tests below
 * observe a `command` frame arriving.
 */
const connectPublisherAndConfirmRegistered = (
  url: string,
  bearerToken: string,
  sessionId: string,
  capabilities: unknown,
  onMessage: (raw: string) => void,
): Effect.Effect<NodeSocket.NodeWS.WebSocket> =>
  Effect.callback<NodeSocket.NodeWS.WebSocket>((resume) => {
    const socket = new NodeSocket.NodeWS.WebSocket(url, {
      headers: { authorization: `Bearer ${bearerToken}` },
    });
    socket.on("open", () => {
      socket.send(helloFrameText(sessionId, false, capabilities));
      socket.send(JSON.stringify({ v: 1, type: "ping" }));
    });
    socket.on("message", (data) => {
      const text = rawDataToString(data);
      if (text === buildPongFrame()) {
        resume(Effect.succeed(socket));
        return;
      }
      onMessage(text);
    });
    socket.on("error", () => {});
  });

it.layer(NodeServices.layer)("EditorPresenceRoute commands", (it) => {
  it.effect(
    "a hello with no capabilities key defaults to no capabilities in what a subscriber sees",
    () =>
      Effect.gen(function* () {
        yield* HttpRouter.serve(editorPresenceRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);

        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const issued = yield* serverAuth.issueSession();
        const publisherUrl = yield* getPublisherWsUrl();
        const subscriberUrl = yield* getSubscriberWsUrl();

        const socket = yield* connectPublisherAndConfirmRegistered(
          publisherUrl,
          issued.token,
          "capabilities-default-repro",
          undefined,
          () => {},
        );

        const presence = yield* connectSubscriberAndReadFirstFrame(subscriberUrl, issued.token);
        assert.deepStrictEqual(
          presence.editors[0]?.capabilities,
          DEFAULT_EDITOR_PRESENCE_CAPABILITIES,
        );
        socket.close();
      }).pipe(
        Effect.scoped,
        Effect.provide(
          makeEnvironmentAuthLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
        ),
      ),
  );

  it.effect(
    "a hello with a declared capability list reflects it exactly in what a subscriber sees",
    () =>
      Effect.gen(function* () {
        yield* HttpRouter.serve(editorPresenceRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);

        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const issued = yield* serverAuth.issueSession();
        const publisherUrl = yield* getPublisherWsUrl();
        const subscriberUrl = yield* getSubscriberWsUrl();

        const socket = yield* connectPublisherAndConfirmRegistered(
          publisherUrl,
          issued.token,
          "capabilities-custom-repro",
          ["play", "stop", "step", "pause"],
          () => {},
        );

        const presence = yield* connectSubscriberAndReadFirstFrame(subscriberUrl, issued.token);
        assert.deepStrictEqual(presence.editors[0]?.capabilities, [
          "play",
          "stop",
          "step",
          "pause",
        ]);
        socket.close();
      }).pipe(
        Effect.scoped,
        Effect.provide(
          makeEnvironmentAuthLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
        ),
      ),
  );

  it.effect(
    "dispatchEditorCommand refuses a session without the dedicated presence:command scope, without ever writing a frame to the connected engine",
    () =>
      Effect.gen(function* () {
        yield* HttpRouter.serve(editorPresenceRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);

        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        // Operate-only: sufficient to CONNECT as a publisher, but
        // deliberately missing the dedicated command scope — the review
        // finding this scope exists to close: orchestration:operate must
        // NOT be enough to make an editor run code.
        const issued = yield* serverAuth.issueSession({ scopes: [AuthOrchestrationOperateScope] });
        const dispatcherSession = makeFakeAuthenticatedSession([AuthOrchestrationOperateScope]);
        const publisherUrl = yield* getPublisherWsUrl();

        const messagesAfterReady: Array<string> = [];
        const socket = yield* connectPublisherAndConfirmRegistered(
          publisherUrl,
          issued.token,
          "scope-gate-repro",
          undefined,
          (raw) => messagesAfterReady.push(raw),
        );

        const outcome = yield* dispatchEditorCommand(dispatcherSession, "scope-gate-repro", "play");

        assert.deepStrictEqual(outcome, { ok: false, error: "insufficient_scope" });
        // The property this check exists for: an unscoped dispatcher must
        // never cause so much as one frame to reach the engine — not just
        // "dispatchEditorCommand returned the right error."
        assert.deepStrictEqual(messagesAfterReady, []);
        socket.close();
      }).pipe(
        Effect.scoped,
        // `EditorPresenceRegistry.layer` provided here too, alongside
        // `editorPresenceRouteLayer`'s own INTERNAL use of the exact same
        // layer reference — Effect memoizes a layer by identity within one
        // resolution, so `dispatchEditorCommand`'s own `yield*
        // EditorPresenceRegistry.EditorPresenceRegistry` resolves to the
        // SAME registry instance the real WS route builds and registers
        // into, not a second, disconnected one that has never heard of
        // the publisher this test just connected.
        Effect.provide(
          makeEnvironmentAuthLayer().pipe(
            Layer.provideMerge(NodeHttpServer.layerTest),
            Layer.provideMerge(EditorPresenceRegistry.layer),
          ),
        ),
      ),
  );

  it.effect(
    "dispatchEditorCommand's frame reaches the real connected engine over the wire, and the engine's real commandResult resolves it",
    () =>
      Effect.gen(function* () {
        yield* HttpRouter.serve(editorPresenceRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);

        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const issued = yield* serverAuth.issueSession({ scopes: [AuthOrchestrationOperateScope] });
        const dispatcherSession = makeFakeAuthenticatedSession([AuthPresenceCommandScope]);
        const publisherUrl = yield* getPublisherWsUrl();

        const receivedCommandFrames: Array<string> = [];
        // The real engine's own job, per spec: parse the command and reply
        // with its OWN outcome. This fake engine always succeeds, proving
        // the happy path; the registry suite's own "unsupported_action"
        // test already proves an engine's failure reply is relayed
        // verbatim, so it isn't repeated here.
        const socket = yield* connectPublisherAndConfirmRegistered(
          publisherUrl,
          issued.token,
          "wire-roundtrip-repro",
          undefined,
          (raw) => {
            receivedCommandFrames.push(raw);
            const command = decodeUnknownJson(raw) as { readonly id: string };
            socket.send(JSON.stringify({ v: 1, type: "commandResult", id: command.id, ok: true }));
          },
        );

        const outcome = yield* dispatchEditorCommand(
          dispatcherSession,
          "wire-roundtrip-repro",
          "play",
          { sceneIndex: 2 },
        );

        assert.deepStrictEqual(outcome, { ok: true });
        assert.strictEqual(receivedCommandFrames.length, 1);
        const receivedCommand = decodeUnknownJson(receivedCommandFrames[0]!) as {
          readonly v: 1;
          readonly type: "command";
          readonly action: string;
          readonly params: unknown;
        };
        assert.strictEqual(receivedCommand.v, 1);
        assert.strictEqual(receivedCommand.type, "command");
        assert.strictEqual(receivedCommand.action, "play");
        assert.deepStrictEqual(receivedCommand.params, { sceneIndex: 2 });
        socket.close();
      }).pipe(
        Effect.scoped,
        // See the sibling scope-gate test above for why
        // `EditorPresenceRegistry.layer` is provided here too.
        Effect.provide(
          makeEnvironmentAuthLayer().pipe(
            Layer.provideMerge(NodeHttpServer.layerTest),
            Layer.provideMerge(EditorPresenceRegistry.layer),
          ),
        ),
      ),
  );

  it.effect(
    "POST /editor-presence/command reaches a real connected engine over the wire, sharing the same registry the WS route registered it into",
    () =>
      Effect.gen(function* () {
        // Both route layers served together, exactly like server.ts's own
        // `Layer.mergeAll(editorPresenceRouteLayer, editorPresenceCommandRouteLayer, ...)`
        // — this is what actually proves `editorPresenceCommandRouteLayer`'s
        // `Layer.provide(EditorPresenceRegistry.layer)` shares ONE registry
        // instance with the WS route's own `provideMerge` of the SAME layer
        // reference, rather than building a second, disconnected, always-empty
        // one that would make every dispatch fail `editor_not_connected`
        // regardless of what a real publisher registered.
        yield* HttpRouter.serve(
          Layer.mergeAll(editorPresenceRouteLayer, editorPresenceCommandRouteLayer),
          { disableListenLog: true, disableLogger: true },
        ).pipe(Layer.build);

        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const publisherIssued = yield* serverAuth.issueSession();
        const dispatcherIssued = yield* serverAuth.issueSession({
          scopes: [AuthPresenceCommandScope],
        });
        const publisherUrl = yield* getPublisherWsUrl();

        const receivedCommandFrames: Array<string> = [];
        const socket = yield* connectPublisherAndConfirmRegistered(
          publisherUrl,
          publisherIssued.token,
          "http-command-repro",
          undefined,
          (raw) => {
            receivedCommandFrames.push(raw);
            const command = decodeUnknownJson(raw) as { readonly id: string };
            socket.send(JSON.stringify({ v: 1, type: "commandResult", id: command.id, ok: true }));
          },
        );
        // A finalizer, not a bare call at the end of the happy path — see
        // the session-id-takeover test's own comment above for why: a
        // thrown assertion below must still close the socket, or
        // `NodeHttpServer.layerTest`'s scope teardown waits on it and a
        // fast, real failure shows up as an uninformative 60s hang instead
        // (this is exactly what happened the first time this test was
        // written, before this fix).
        yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));

        const outcome = yield* postDispatchCommand({
          bearerToken: dispatcherIssued.token,
          sessionId: "http-command-repro",
          action: "play",
          params: { sceneIndex: 2 },
        });

        assert.deepStrictEqual(outcome, { ok: true });
        assert.strictEqual(receivedCommandFrames.length, 1);
        const receivedCommand = decodeUnknownJson(receivedCommandFrames[0]!) as {
          readonly v: 1;
          readonly type: "command";
          readonly action: string;
          readonly params: unknown;
        };
        assert.strictEqual(receivedCommand.v, 1);
        assert.strictEqual(receivedCommand.type, "command");
        assert.strictEqual(receivedCommand.action, "play");
        assert.deepStrictEqual(receivedCommand.params, { sceneIndex: 2 });
      }).pipe(
        Effect.scoped,
        // `EditorPresenceRegistry.layer` provided here too, alongside
        // `editorPresenceRouteLayer`'s own internal use of the exact same
        // layer reference — see the sibling in-process scope-gate test
        // above for why (Effect memoizes a layer by identity within one
        // resolution). Needed explicitly here at the type level even
        // though `editorPresenceCommandRouteLayer` is bare (no
        // self-provide): `Layer.mergeAll`'s TYPE signature is the union of
        // each layer's OWN remaining requirement, not a cross-satisfied
        // one, so TypeScript can't see that `editorPresenceRouteLayer`'s
        // sibling presence already supplies it at runtime.
        Effect.provide(
          makeEnvironmentAuthLayer().pipe(
            Layer.provideMerge(NodeHttpServer.layerTest),
            Layer.provideMerge(FetchHttpClient.layer),
            Layer.provideMerge(EditorPresenceRegistry.layer),
          ),
        ),
      ),
  );

  it.effect(
    "POST /editor-presence/command answers insufficient_scope for a session without presence:command, without reaching the engine",
    () =>
      Effect.gen(function* () {
        yield* HttpRouter.serve(
          Layer.mergeAll(editorPresenceRouteLayer, editorPresenceCommandRouteLayer),
          { disableListenLog: true, disableLogger: true },
        ).pipe(Layer.build);

        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const publisherIssued = yield* serverAuth.issueSession();
        // Operate-only, deliberately missing the dedicated command scope —
        // the same review finding the in-process scope-gate test above
        // covers, exercised here over the ACTUAL route instead of by
        // calling `dispatchEditorCommand` directly.
        const dispatcherIssued = yield* serverAuth.issueSession({
          scopes: [AuthOrchestrationOperateScope],
        });
        const publisherUrl = yield* getPublisherWsUrl();

        const messagesAfterReady: Array<string> = [];
        const socket = yield* connectPublisherAndConfirmRegistered(
          publisherUrl,
          publisherIssued.token,
          "http-scope-gate-repro",
          undefined,
          (raw) => messagesAfterReady.push(raw),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => socket.close()));

        const outcome = yield* postDispatchCommand({
          bearerToken: dispatcherIssued.token,
          sessionId: "http-scope-gate-repro",
          action: "play",
        });

        assert.deepStrictEqual(outcome, { ok: false, error: "insufficient_scope" });
        assert.deepStrictEqual(messagesAfterReady, []);
      }).pipe(
        Effect.scoped,
        // `EditorPresenceRegistry.layer` provided here too, alongside
        // `editorPresenceRouteLayer`'s own internal use of the exact same
        // layer reference — see the sibling in-process scope-gate test
        // above for why (Effect memoizes a layer by identity within one
        // resolution). Needed explicitly here at the type level even
        // though `editorPresenceCommandRouteLayer` is bare (no
        // self-provide): `Layer.mergeAll`'s TYPE signature is the union of
        // each layer's OWN remaining requirement, not a cross-satisfied
        // one, so TypeScript can't see that `editorPresenceRouteLayer`'s
        // sibling presence already supplies it at runtime.
        Effect.provide(
          makeEnvironmentAuthLayer().pipe(
            Layer.provideMerge(NodeHttpServer.layerTest),
            Layer.provideMerge(FetchHttpClient.layer),
            Layer.provideMerge(EditorPresenceRegistry.layer),
          ),
        ),
      ),
  );

  /** Auto-replies to any `command` frame with `commandResult{ok:true}`,
   * exactly like the wire-roundtrip test above's fake engine — needed on
   * the victim socket in the takeover test below: `dispatchEditorCommand`
   * awaits a real `commandResult` with a 10s bound that never elapses
   * under `it.effect`'s virtual clock, so if the command routes to the
   * victim (the correct, fixed behavior) and nothing replies, the test
   * hangs instead of passing.
   *
   * The impostor side originally needed this too, back when a refused
   * takeover left the impostor's connection open but silently ignored —
   * it no longer does: the fix now closes the impostor's connection
   * outright (see the `publishFrameAndObserveClose` call below), so
   * there's no longer a second socket here to attach a replier to.
   *
   * Attached DIRECTLY to the raw `ws` socket's own "message" event
   * (`connectPublisherAndConfirmRegistered`'s own `onMessage` callback is
   * a no-op here, since this needs its own listener on top) — a raw `ws`
   * "message" event hands the listener `RawData` (Buffer/ArrayBuffer/
   * Buffer[]), never a string, so this converts via `rawDataToString`
   * exactly like every other listener in this file does. The first
   * version of this helper skipped that and fed a raw Buffer straight
   * into `decodeUnknownJson`, which throws on anything but a string — a
   * harness bug, not a product bug, caught by running the test and
   * reading the actual error rather than assuming either way. */
  const makeCommandAutoReplier =
    (socket: { send: (data: string) => void }, collected: Array<string>) =>
    (data: NodeSocket.NodeWS.RawData) => {
      const raw = rawDataToString(data);
      collected.push(raw);
      const parsed = decodeUnknownJson(raw) as { readonly type?: string; readonly id?: string };
      if (parsed.type !== "command" || typeof parsed.id !== "string") return;
      socket.send(JSON.stringify({ v: 1, type: "commandResult", id: parsed.id, ok: true }));
    };

  it.effect(
    "a session-id takeover by a DIFFERENT authenticated identity must not let the impostor intercept a command meant for the original publisher (task #60)",
    () =>
      Effect.gen(function* () {
        yield* HttpRouter.serve(editorPresenceRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);

        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        // Both hold the SAME scope any ordinary, non-malicious client
        // already has (orchestration:operate) — this is not a scope
        // bypass. It's two DIFFERENT authenticated identities: an
        // attacker who read a victim's session.id off the (already
        // scope-authorized) presence feed and opens a SECOND publisher
        // connection claiming that same id for itself.
        //
        // SAME `subject` for both, DELIBERATELY (task #60 fix-round 2):
        // this is the exact shape an independent security review
        // reproduced the takeover with against fix-round 1's subject-based
        // guard — every REAL provisioning path in this codebase (`t3
        // pair`, the RPC pairing route) hardcodes `subject:
        // "one-time-token"`, so a real victim and a real attacker,
        // independently paired through the actual documented flow, end up
        // with an IDENTICAL subject. `issueSession` still mints a fresh,
        // unique `sessionId` for each call regardless of subject — this
        // is what the guard actually keys on now — so reusing one subject
        // here isn't a simplification, it's the whole point: proving the
        // fix doesn't quietly depend on subjects differing.
        const sharedSubject = "one-time-token";
        const victimIssued = yield* serverAuth.issueSession({
          scopes: [AuthOrchestrationOperateScope],
          subject: sharedSubject,
        });
        const attackerIssued = yield* serverAuth.issueSession({
          scopes: [AuthOrchestrationOperateScope],
          subject: sharedSubject,
        });
        const dispatcherSession = makeFakeAuthenticatedSession([AuthPresenceCommandScope]);
        const publisherUrl = yield* getPublisherWsUrl();
        const sharedSessionId = "takeover-target-repro";

        const victimMessages: Array<string> = [];
        const victimSocket = yield* connectPublisherAndConfirmRegistered(
          publisherUrl,
          victimIssued.token,
          sharedSessionId,
          undefined,
          () => {},
        );
        victimSocket.on("message", makeCommandAutoReplier(victimSocket, victimMessages));
        // Registered as a SCOPED finalizer, not a bare call at the end of
        // the happy path — a thrown assertion below must still close both
        // sockets. Skipping this was the second bug this test's own
        // authoring surfaced: a failed assertion left both raw `ws`
        // clients open, `NodeHttpServer.layerTest`'s own scope teardown
        // then waited on them, and a real, fast assertion failure showed
        // up as an uninformative 60-120s timeout instead — a finding
        // this test was never trying to make, and one that would have
        // made a genuine RED result look like a hang.
        yield* Effect.addFinalizer(() => Effect.sync(() => victimSocket.close()));

        // The impostor's own connection is expected to be CLOSED by the
        // takeover guard, not left open-but-ignored — so this can't use
        // `connectPublisherAndConfirmRegistered` (it waits for a `pong`
        // that will now never arrive: the server closes the connection
        // instead of finishing the hello/ping/pong sequence). It uses
        // `publishFrameAndObserveClose` instead, which sends one frame and
        // waits for exactly the close the server sends back.
        const attackerOutcome = yield* publishFrameAndObserveClose(
          publisherUrl,
          attackerIssued.token,
          helloFrameText(sharedSessionId),
        );
        // THE property this test exists for: the refused connection must
        // be closed, not silently ignored and not left believing it
        // registered — not "some check rejected the takeover", the actual
        // bytes on the actual wire. Assert the EFFECT, not a precondition.
        //
        // 4402 (sessionSuperseded), NOT 4401 (invalidCredential) — a
        // fix-round-1 mistake, corrected by the SAME independent review:
        // this registration-time guard is first-claim-wins, so the party
        // refused here could be a genuine impostor OR a legitimate editor
        // that lost a race to squat an unclaimed id (see
        // EditorPresenceRegistry.ts's SESSION TAKEOVER doc, "WHAT THIS
        // DOES NOT CLOSE") — the server cannot tell which from here. 4401
        // is credential-class (permanent, human-must-click-retry per
        // epp_client.gd); sending it to whichever party is refused would
        // PERMANENTLY strand a legitimate editor in the squat case. 4402
        // is not credential-class, so a refused party keeps retrying with
        // normal backoff — self-healing once the current holder
        // eventually disconnects, in either scenario.
        assert.strictEqual(attackerOutcome.closeCode, 4402);
        assert.isTrue(attackerOutcome.closeReason.length > 0);

        const outcome = yield* dispatchEditorCommand(dispatcherSession, sharedSessionId, "play");

        // The command must still reach the LEGITIMATE, original
        // publisher — proving this isn't "nobody gets it" (which would
        // trivially satisfy the assertion above without the takeover
        // actually being refused).
        const victimCommandFrames = victimMessages.filter((raw) => {
          const parsed = decodeUnknownJson(raw) as { readonly type?: string };
          return parsed.type === "command";
        });
        assert.strictEqual(victimCommandFrames.length, 1);
        const received = decodeUnknownJson(victimCommandFrames[0]!) as {
          readonly type: string;
          readonly action: string;
        };
        assert.strictEqual(received.type, "command");
        assert.strictEqual(received.action, "play");
        assert.deepStrictEqual(outcome, { ok: true });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          makeEnvironmentAuthLayer().pipe(
            Layer.provideMerge(NodeHttpServer.layerTest),
            Layer.provideMerge(EditorPresenceRegistry.layer),
          ),
        ),
      ),
    // A short explicit timeout, not the 60s default: if the takeover guard
    // ever regresses to silently ALLOW the impostor's claim (instead of
    // closing it), `publishFrameAndObserveClose` above waits for a close
    // that will simply never come — a regression here is hang-shaped, not
    // failure-shaped, and a hang is strictly worse than a fast failure (it
    // was measured directly: mutating the guard away during this fix's own
    // development turned a would-be assertion failure into a 60s timeout).
    8_000,
  );

  it.effect(
    "a session-id reconnect with the SAME token (same auth sessionId) still succeeds and supersedes cleanly — the takeover guard must not over-tighten (task #60 regression guard)",
    () =>
      Effect.gen(function* () {
        yield* HttpRouter.serve(editorPresenceRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);

        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        // The case the takeover guard above must NOT break: a real
        // editor's WebSocket dropping and reconnecting with the SAME
        // persisted, still-valid bearer token (e.g. Godot's addon, which
        // stores its token in EditorSettings and reuses it across
        // reconnects and restarts — see EditorPresenceRegistry.ts's
        // `claimantSessionId` doc for why this is verified, not assumed).
        // `sessions.verify` resolves the SAME token to the SAME persisted
        // session record every time, so this ONE issued token, presented
        // twice, authenticates to the SAME `sessionId` both times — the
        // guard's actual anchor now, not `subject`. `issueSession` with no
        // `scopes` gets the broad default (used elsewhere in this file for
        // both roles off one token) — this test isn't exercising scopes,
        // only identity, so there's no reason to narrow them here.
        const issued = yield* serverAuth.issueSession({ subject: "reconnect-owner" });
        const publisherUrl = yield* getPublisherWsUrl();
        const subscriberUrl = yield* getSubscriberWsUrl();
        const sharedSessionId = "reconnect-same-subject-repro";

        const firstSocket = yield* connectPublisherAndConfirmRegistered(
          publisherUrl,
          issued.token,
          sharedSessionId,
          undefined,
          () => {},
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => firstSocket.close()));

        // THE assertion this test exists for: reconnecting with the SAME
        // token (hence the SAME auth sessionId) must complete
        // hello -> ping -> pong normally — i.e. NOT be refused and closed
        // the way the sibling test above's different-identity takeover is.
        // If the guard were ever over-tightened to treat ANY known
        // claimant as a mismatch (same-identity included), this would
        // hang instead of resolving, since the server would close the
        // connection instead of ever replying to `ping` — which is
        // exactly why this test also carries the short explicit timeout
        // below, not the 60s default.
        const secondSocket = yield* connectPublisherAndConfirmRegistered(
          publisherUrl,
          issued.token,
          sharedSessionId,
          undefined,
          () => {},
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => secondSocket.close()));

        // "Supersedes cleanly," not just "wasn't refused": a fresh
        // subscriber connecting now must see exactly ONE entry for this
        // session id, not two — the same ghost-entry regression this
        // file's very first takeover-adjacent test (`capabilities-default`
        // above) was written to catch via `connectSubscriberAndReadFirstFrame`,
        // re-proven here specifically through the NEW identity-aware code
        // path so a duplicate-entry regression in THAT path doesn't slip
        // through unnoticed.
        const frame = yield* connectSubscriberAndReadFirstFrame(subscriberUrl, issued.token);
        const matching = frame.editors.filter((entry) => entry.session.id === sharedSessionId);
        assert.strictEqual(matching.length, 1);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          makeEnvironmentAuthLayer().pipe(
            Layer.provideMerge(NodeHttpServer.layerTest),
            Layer.provideMerge(EditorPresenceRegistry.layer),
          ),
        ),
      ),
    // Same reasoning as the sibling takeover test's explicit timeout above
    // — a regression in THIS direction (over-tightening) is also
    // hang-shaped, not failure-shaped, via the second `connectPublisherAndConfirmRegistered` call.
    8_000,
  );
});
