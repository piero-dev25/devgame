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
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

import { editorPresenceRouteLayer } from "./EditorPresenceRoute.ts";
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
