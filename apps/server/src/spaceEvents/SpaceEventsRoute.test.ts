/**
 * Proves two things about SpaceEventsRoute, both against a real HTTP+WS
 * server and a real orchestration engine — not by asserting the layer
 * constructs, but by asserting the effect: a `space.create` dispatched on
 * one path produces a frame on a live, separately-connected WebSocket.
 *
 * 1. Auth ordering (reused from EditorPresenceRoute's publisher ruling, see
 *    the route's module doc): a bad credential still lets the upgrade
 *    succeed, then closes with an application-range code and a non-empty
 *    reason.
 * 2. The actual liveness fix: a `space.create` dispatched through the real
 *    orchestration engine reaches every connection currently subscribed to
 *    that space's project — proven with two independent probe
 *    connections, not one echoing its own dispatch — and a `space.delete`
 *    afterward correctly drops back to an empty list. A third connection
 *    subscribed to a *different* project must see neither, proving the
 *    project-scoped broadcast (see the route's module doc on why
 *    `getActiveSpacesForProject` exists) doesn't leak across projects.
 *
 * NOTE on `it.effect` and time: `@effect/vitest`'s `it.effect` provides a
 * virtual `TestClock` by default, so `Effect.sleep` never advances on its
 * own — it just hangs. The "did the other project's connection stay quiet"
 * check below waits on a real `setTimeout` bridged through `Effect.promise`
 * instead, deliberately bypassing Effect's Clock for that one real-time
 * wait.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { CommandId, ProjectId, ProviderInstanceId, SpaceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";

import { spaceEventsRouteLayer } from "./SpaceEventsRoute.ts";

// Everything spaceEventsRouteLayer needs — EnvironmentAuth for the upgrade,
// the real production orchestration composition (see
// orchestration/runtimeLayer.ts) for OrchestrationEngineService and
// ProjectionSnapshotQuery — plus their shared remaining dependencies, all as
// one flat provideMerge stack over one shared in-memory SQLite instance
// (matching how the real server backs both auth and orchestration off the
// same database). provideMerge throughout, not just provide: the test body
// dispatches commands directly through `OrchestrationEngineService` and
// mints sessions directly through `EnvironmentAuth`, so both have to stay
// exposed to the test, not just satisfy the route (mounted separately, see
// each test's `HttpRouter.serve(spaceEventsRouteLayer, ...)` call).
const makeSpaceEventsDependenciesLayer = () =>
  Layer.mergeAll(EnvironmentAuth.layer, OrchestrationLayerLive).pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-space-events-route-test-" }),
    ),
  );

const getSpaceEventsWsUrl = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `ws://127.0.0.1:${address.port}/space-events?projectId=${encodeURIComponent(projectId)}`;
  });

function rawDataToString(data: NodeSocket.NodeWS.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

interface SpacesFrame {
  readonly v: 1;
  readonly type: "spaces";
  readonly projectId: string;
  readonly spaces: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  }>;
}

const decodeSpacesFrame = (raw: string): SpacesFrame => JSON.parse(raw) as SpacesFrame;

/** Real-time delay, deliberately outside Effect's (virtualized-in-tests)
 * Clock — see the module doc's NOTE. `Effect.sleep` would hang forever here
 * since `it.effect` provides a virtual `TestClock` that nothing advances. */
const realDelay = (ms: number) =>
  // @effect-diagnostics-next-line globalTimers:off - deliberately real time, not TestClock's virtual clock; see comment above.
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

interface UpgradeOutcome {
  readonly opened: boolean;
  readonly closeCode: number | null;
  readonly closeReason: string | null;
}

/** Connects a raw `ws` client and resolves once the connection reaches a
 * terminal state — used for the two auth-rejection tests, where the
 * connection is expected to close itself. */
const probeRejectedUpgrade = (
  url: string,
  headers: Record<string, string>,
): Effect.Effect<UpgradeOutcome> =>
  Effect.callback<UpgradeOutcome>((resume) => {
    let opened = false;
    const socket = new NodeSocket.NodeWS.WebSocket(url, { headers });
    socket.on("open", () => {
      opened = true;
    });
    socket.on("close", (code, reason) => {
      resume(Effect.succeed({ opened, closeCode: code, closeReason: rawDataToString(reason) }));
    });
    socket.on("unexpected-response", (request, response) => {
      response.resume();
      request.destroy();
      resume(
        Effect.succeed({ opened, closeCode: null, closeReason: `http ${response.statusCode}` }),
      );
    });
    socket.on("error", () => {});
  });

/** Connects an authenticated probe client that stays open, collecting every
 * `spaces` frame it receives into `frames`. The caller is responsible for
 * closing it (`close()`) once done. */
const openSpacesProbe = (url: string, token: string) =>
  Effect.callback<{
    readonly frames: Array<SpacesFrame>;
    readonly close: () => void;
    readonly waitForFrame: (count: number) => Promise<void>;
  }>((resume) => {
    const frames: Array<SpacesFrame> = [];
    const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
    const socket = new NodeSocket.NodeWS.WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    socket.on("message", (data) => {
      frames.push(decodeSpacesFrame(rawDataToString(data)));
      const stillWaiting = waiters.filter((waiter) => {
        if (frames.length < waiter.count) return true;
        waiter.resolve();
        return false;
      });
      waiters.length = 0;
      waiters.push(...stillWaiting);
    });
    socket.on("open", () => {
      resume(
        Effect.succeed({
          frames,
          close: () => socket.close(),
          waitForFrame: (count) =>
            frames.length >= count
              ? Promise.resolve()
              : new Promise<void>((resolve) => {
                  waiters.push({ count, resolve });
                }),
        }),
      );
    });
    socket.on("unexpected-response", (request, response) => {
      response.resume();
      request.destroy();
      resume(
        Effect.die(
          new Error(
            `Expected the space-events upgrade to succeed, got HTTP ${response.statusCode}`,
          ),
        ),
      );
    });
  });

it.layer(NodeServices.layer)("SpaceEventsRoute", (it) => {
  it.effect("closes a missing-credential subscriber upgrade with 4400 after accepting it", () =>
    Effect.gen(function* () {
      yield* HttpRouter.serve(spaceEventsRouteLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);

      const url = yield* getSpaceEventsWsUrl(ProjectId.make("project-missing-credential"));
      const outcome = yield* probeRejectedUpgrade(url, {});

      assert.isTrue(outcome.opened);
      assert.strictEqual(outcome.closeCode, 4400);
      assert.strictEqual(outcome.closeReason, "missing_credential");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        makeSpaceEventsDependenciesLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      ),
    ),
  );

  it.effect("closes an invalid-credential subscriber upgrade with 4401 after accepting it", () =>
    Effect.gen(function* () {
      yield* HttpRouter.serve(spaceEventsRouteLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);

      const url = yield* getSpaceEventsWsUrl(ProjectId.make("project-invalid-credential"));
      const outcome = yield* probeRejectedUpgrade(url, {
        authorization: "Bearer not-a-real-token",
      });

      assert.isTrue(outcome.opened);
      assert.strictEqual(outcome.closeCode, 4401);
      assert.strictEqual(outcome.closeReason, "invalid_credential");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        makeSpaceEventsDependenciesLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
      ),
    ),
  );

  it.effect(
    "broadcasts a live space.create to every connection subscribed to that project, self-heals on delete, and never leaks to a different project",
    () =>
      Effect.gen(function* () {
        yield* HttpRouter.serve(spaceEventsRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);

        const engine = yield* OrchestrationEngineService;
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const issued = yield* serverAuth.issueSession();

        const projectA = ProjectId.make("project-a-space-events");
        const projectB = ProjectId.make("project-b-space-events");
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-space-events-project-a"),
          projectId: projectA,
          title: "Project A",
          workspaceRoot: "/tmp/space-events-project-a",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-space-events-project-b"),
          projectId: projectB,
          title: "Project B",
          workspaceRoot: "/tmp/space-events-project-b",
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        const urlA = yield* getSpaceEventsWsUrl(projectA);
        const urlB = yield* getSpaceEventsWsUrl(projectB);

        // Two independent connections to project A — this is the "reaches
        // another connection" proof, not one client observing its own
        // dispatch echoed back.
        const probeA1 = yield* Effect.acquireRelease(openSpacesProbe(urlA, issued.token), (p) =>
          Effect.sync(p.close),
        );
        const probeA2 = yield* Effect.acquireRelease(openSpacesProbe(urlA, issued.token), (p) =>
          Effect.sync(p.close),
        );
        const probeB = yield* Effect.acquireRelease(openSpacesProbe(urlB, issued.token), (p) =>
          Effect.sync(p.close),
        );

        yield* Effect.promise(() => probeA1.waitForFrame(1));
        yield* Effect.promise(() => probeA2.waitForFrame(1));
        yield* Effect.promise(() => probeB.waitForFrame(1));
        assert.deepStrictEqual(probeA1.frames[0]!.spaces, []);
        assert.deepStrictEqual(probeA2.frames[0]!.spaces, []);
        assert.deepStrictEqual(probeB.frames[0]!.spaces, []);

        const spaceId = SpaceId.make("space-events-space-1");
        yield* engine.dispatch({
          type: "space.create",
          commandId: CommandId.make("cmd-space-events-space-create"),
          spaceId,
          projectId: projectA,
          title: "Live Space",
          createdAt: "2026-01-01T00:00:01.000Z",
        });

        yield* Effect.promise(() => probeA1.waitForFrame(2));
        yield* Effect.promise(() => probeA2.waitForFrame(2));
        const expectedSpace = {
          id: spaceId,
          title: "Live Space",
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        };
        assert.deepStrictEqual(probeA1.frames[1]!.spaces, [expectedSpace]);
        assert.deepStrictEqual(probeA2.frames[1]!.spaces, [expectedSpace]);

        yield* engine.dispatch({
          type: "space.delete",
          commandId: CommandId.make("cmd-space-events-space-delete"),
          spaceId,
        });

        yield* Effect.promise(() => probeA1.waitForFrame(3));
        yield* Effect.promise(() => probeA2.waitForFrame(3));
        assert.deepStrictEqual(probeA1.frames[2]!.spaces, []);
        assert.deepStrictEqual(probeA2.frames[2]!.spaces, []);

        // project B's connection saw only its own initial (empty) frame —
        // neither the create nor the delete for project A reached it.
        yield* realDelay(300);
        assert.strictEqual(probeB.frames.length, 1);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          makeSpaceEventsDependenciesLayer().pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
        ),
      ),
  );
});
