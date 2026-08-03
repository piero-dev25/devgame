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

/** Reads a `ws` `RawData` payload (Buffer | ArrayBuffer | Buffer[]) as utf8,
 * matching how the protocol always sends single text frames. */
function rawDataToString(data: NodeSocket.NodeWS.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
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
