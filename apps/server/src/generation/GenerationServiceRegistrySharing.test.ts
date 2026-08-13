/**
 * THE #1 TRAP, proven (docs/v2/specs/increment-2b1-generation-panel.md):
 * "If a new web route builds its own `GenerationService.layer()`, it gets a
 * SEPARATE, empty in-memory registry and the panel shows nothing forever
 * (no error — it typechecks and renders empty)." `server.ts` fixes this by
 * hoisting ONE `GenerationServiceLive` const and passing that SAME layer
 * reference into both `McpHttpServer.layer(...)` and the new routes'
 * `HttpRouter.provideRequest`.
 *
 * This file proves the MECHANISM that hoist relies on directly, at the
 * `GenerationService`/`dispatchGenerationList` level (no need to stand up
 * the full MCP transport or HTTP server to prove it — the sharing is a
 * property of Effect's own layer memoization, keyed on LAYER REFERENCE
 * identity, and both `generate_3d`'s handler and `dispatchGenerationList`
 * reach the registry through the identical `yield* GenerationService
 * .GenerationService` request):
 *
 *  - WRITE via `GenerationService.GenerationService.createJob(...)` — the
 *    exact effectful call `generate3d`'s MCP handler makes internally
 *    (handlers.ts's `generate3d`, after its own MCP-specific scope/thread
 *    resolution, which is irrelevant to the SHARING mechanism under test).
 *  - READ via `dispatchGenerationList` — this increment's new web route.
 *  - Both draw `GenerationService` from ONE shared layer reference,
 *    provided ONCE — proving that reference, threaded to two different
 *    consumers, resolves to ONE registry.
 *
 * A second test proves this is DISCRIMINATING, not vacuous
 * (mutation-testing doctrine — a proof that can't fail is not a proof):
 * reintroducing the exact bug (two SEPARATE `GenerationService.layer()`
 * calls, one per consumer) makes the write invisible to the read, exactly
 * as the spec's own trap description predicts.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthPresenceReadScope,
  AuthSessionId,
  OrchestrationProjectShell,
  ProjectId,
  ThreadId,
  type GenerationJob,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { dispatchGenerationList } from "./GenerationListRoute.ts";
import {
  layer as generationServiceLayer,
  GenerationService,
  type GenerationServiceShape,
} from "./GenerationService.ts";
import { Model3dProvider, type Model3dProviderShape } from "./providers/Model3dProvider.ts";

const projectId = ProjectId.make("project-registry-sharing");
const threadId = ThreadId.make("thread-registry-sharing");

const PROJECT = Schema.decodeUnknownSync(OrchestrationProjectShell)({
  id: projectId,
  title: "Registry Sharing Project",
  workspaceRoot: "/Users/piero/Projects/RegistrySharingGame",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
});

const projectionSnapshotQueryLayer = Layer.succeed(
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  {
    getCommandReadModel: () => Effect.die("unexpected getCommandReadModel call"),
    getSnapshot: () => Effect.die("unexpected getSnapshot call"),
    getShellSnapshot: () => Effect.die("unexpected getShellSnapshot call"),
    getArchivedShellSnapshot: () => Effect.die("unexpected getArchivedShellSnapshot call"),
    searchThreads: () => Effect.die("unexpected searchThreads call"),
    getSnapshotSequence: () => Effect.die("unexpected getSnapshotSequence call"),
    getCounts: () => Effect.die("unexpected getCounts call"),
    getActiveProjectByWorkspaceRoot: () =>
      Effect.die("unexpected getActiveProjectByWorkspaceRoot call"),
    getProjectShellById: () => Effect.succeed(Option.some(PROJECT)),
    getFirstActiveThreadIdByProjectId: () =>
      Effect.die("unexpected getFirstActiveThreadIdByProjectId call"),
    getActiveSpacesForProject: () => Effect.die("unexpected getActiveSpacesForProject call"),
    getSpaceProjectId: () => Effect.die("unexpected getSpaceProjectId call"),
    getThreadCheckpointContext: () => Effect.die("unexpected getThreadCheckpointContext call"),
    getFullThreadDiffContext: () => Effect.die("unexpected getFullThreadDiffContext call"),
    getThreadShellById: () => Effect.die("unexpected getThreadShellById call"),
    getThreadDetailById: () => Effect.die("unexpected getThreadDetailById call"),
    getThreadDetailSnapshot: () => Effect.die("unexpected getThreadDetailSnapshot call"),
  },
);

const fakeServerSecretStoreLayer = Layer.succeed(
  ServerSecretStore.ServerSecretStore,
  ServerSecretStore.ServerSecretStore.of({
    get: () => Effect.succeed(Option.none()),
    set: () => Effect.void,
    create: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(3)),
    remove: () => Effect.void,
  }),
);

const readSession: EnvironmentAuth.AuthenticatedSession = {
  sessionId: AuthSessionId.make("registry-sharing-session"),
  subject: "test-subject",
  method: "bearer-access-token",
  scopes: [AuthPresenceReadScope],
};

/** Never actually submits/polls anything real — `createJob` forks the poll
 * loop but this test only asserts on the job's initial write, so a
 * die-on-call fake provider is sufficient and keeps the test fast. */
const inertProvider: Model3dProviderShape = {
  submitTextTo3d: () => Effect.never,
  pollTask: () => Effect.never,
  deriveFbx: () => Effect.die("deriveFbx is not exercised by this test"),
};
const inertProviderLayer = Layer.succeed(Model3dProvider, inertProvider);

const inertHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
  ),
);

const InfraLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-registry-sharing-test-" }),
  inertHttpClientLayer,
).pipe(Layer.provideMerge(NodeServices.layer));

describe("GenerationService registry sharing (the increment's #1 trap)", () => {
  it.effect(
    "a job written via GenerationService.createJob is visible to dispatchGenerationList when BOTH share the same layer reference",
    () =>
      Effect.gen(function* () {
        const service = yield* GenerationService;
        const job = yield* service.createJob({
          projectId,
          threadId,
          prompt: "registry sharing barrel",
          parameters: {},
        });

        const outcome = yield* dispatchGenerationList(readSession, projectId).pipe(
          Effect.provide(Layer.mergeAll(projectionSnapshotQueryLayer, fakeServerSecretStoreLayer)),
        );

        expect(outcome._tag).toBe("ok");
        if (outcome._tag !== "ok" || "_tag" in outcome.value) {
          throw new Error("Expected a successful GenerationListSuccess.");
        }
        expect(outcome.value.entries.map((entry) => entry.job.id)).toContain(job.id);
      }).pipe(
        // ONE shared layer reference, provided ONCE — the exact mechanism
        // server.ts's hoist relies on (Effect memoizes per LAYER REFERENCE
        // within one provided graph, not per underlying service).
        Effect.provide(
          generationServiceLayer({ pollIntervalMs: 50_000 }).pipe(
            Layer.provide(inertProviderLayer),
          ),
        ),
        Effect.provide(InfraLayer),
      ),
  );

  it.effect(
    "MUTATION GUARD: reintroducing the trap (two SEPARATE GenerationService.layer() calls) makes the write invisible to the read",
    () =>
      Effect.gen(function* () {
        // Deliberately builds TWO DIFFERENT layer instances from two
        // SEPARATE `generationServiceLayer(...)` calls — exactly the bug
        // the spec's own "#1 trap" describes, reintroduced here on purpose
        // to prove this test file's OWN positive test above is
        // discriminating (would have gone red against this regression),
        // not vacuously green regardless of the wiring.
        const writeLayer = generationServiceLayer({ pollIntervalMs: 50_000 }).pipe(
          Layer.provide(inertProviderLayer),
        );
        const readLayer = generationServiceLayer({ pollIntervalMs: 50_000 }).pipe(
          Layer.provide(inertProviderLayer),
        );

        const job = yield* Effect.gen(function* () {
          const service = yield* GenerationService;
          return yield* service.createJob({
            projectId,
            threadId,
            prompt: "registry sharing barrel (should be invisible)",
            parameters: {},
          });
        }).pipe(Effect.provide(writeLayer), Effect.provide(InfraLayer));

        const outcome = yield* dispatchGenerationList(readSession, projectId).pipe(
          Effect.provide(
            Layer.mergeAll(readLayer, projectionSnapshotQueryLayer, fakeServerSecretStoreLayer),
          ),
          Effect.provide(InfraLayer),
        );

        expect(outcome._tag).toBe("ok");
        if (outcome._tag !== "ok" || "_tag" in outcome.value) {
          throw new Error("Expected a successful (if empty) GenerationListSuccess.");
        }
        // The job written to `writeLayer`'s registry is NOT visible through
        // `readLayer`'s own, separate, empty registry.
        expect(outcome.value.entries.map((entry) => entry.job.id)).not.toContain(job.id);
        expect(outcome.value.entries).toEqual([]);
      }),
  );
});

/**
 * FIX ROUND (adversarial review, 3-lens, all findings verified against
 * effect source): the tests above prove sharing under a FLAT
 * `Effect.provide(sharedLayer)` — trivially true by construction, since
 * nothing forks a memo map. They do NOT exercise the REAL topology
 * server.ts actually ships: `generationListRouteLayer`/
 * `generationAssetRouteLayer` each go through `.pipe(HttpRouter
 * .provideRequest(GenerationServiceLive))`, while `McpHttpServer.layer
 * (GenerationServiceLive)` consumes the SAME reference via ORDINARY
 * structural `Layer.provide`, and ALL of this is merged via
 * `Layer.mergeAll(...)` in `makeRoutesLayer`.
 *
 * Verified line-by-line against `effect/unstable/http/HttpRouter.ts:
 * 1243-1260` and `effect/Layer.ts` (`CurrentMemoMap.forkOrCreate`,
 * `MemoMapImpl.get`/`getOrElseMemoize`, `mergeAllEffect`):
 *
 *  - `HttpRouter.provideRequest(layer)` = `Layer.provide(self, middleware
 *    (Effect.gen(function*() { const services = yield* Layer.build(layer);
 *    return (effect) => Effect.provideContext(effect, services) })).layer)`
 *    — the OPERATIVE call is that bare `yield* Layer.build(layer)` inside
 *    the middleware's OWN build effect.
 *  - `Layer.build` calls `CurrentMemoMap.forkOrCreate(fiber.context)` —
 *    if a `CurrentMemoMap` is ALREADY in the fiber's context (true here,
 *    since this middleware build runs AS PART of the surrounding
 *    `Layer.mergeAll` build, which threads ONE memo map through via
 *    `buildWithMemoMap`'s `provideService(CurrentMemoMap, memoMap)`), it
 *    FORKS A CHILD (`forkMemoMapUnsafe(current)`) rather than reusing the
 *    parent map directly.
 *  - `MemoMapImpl.get` READS THROUGH to the parent chain on a local miss,
 *    but `getOrElseMemoize`'s build-on-miss path (`memoMapBuild`) writes
 *    ONLY into `this.map` — i.e. a forked child's build NEVER writes back
 *    to its parent, and is invisible to sibling forks or the parent's own
 *    later readers.
 *  - `Layer.mergeAll` builds its members via `Effect.forEach(layers, ...,
 *    { concurrency: layers.length })` — genuinely concurrent, not
 *    sequential-with-gaps.
 *
 * Net effect: EVERY `HttpRouter.provideRequest(GenerationServiceLive)`
 * site UNCONDITIONALLY forks its own child memo map (this part is not a
 * race — it always happens). Whether that fork's read-through finds an
 * ALREADY-memoized entry (shared) or nothing (builds its own, invisible,
 * separate instance) depends on whether `McpHttpServer.layer`'s ordinary
 * structural consumption — the ONLY consumer that writes directly into the
 * common ancestor memo map — has already registered the entry by the time
 * each route's fork looks it up. Since `Layer.mergeAll` builds all
 * members concurrently, this is a genuine, source-grounded, build-order
 * question — not something safe to assume from "same layer reference"
 * alone. The tests below build EXACTLY this shape (reproducing
 * `HttpRouter.provideRequest`'s own internal `yield* Layer.build(layer)`
 * call, merged via `Layer.mergeAll` alongside an ordinary
 * `Layer.provide`-based consumer — the DISPATCH mechanics of a real HTTP
 * request are orthogonal to this question, since sharing is fully
 * determined by the Layer/MemoMap graph, not by HTTP routing) and report
 * empirically whether it holds.
 */
describe("GenerationService registry sharing — the REAL topology (HttpRouter.provideRequest nested Layer.build, raced via Layer.mergeAll)", () => {
  /** Reproduces `HttpRouter.provideRequest(layer)`'s operative internal
   * call — `yield* Layer.build(layer)` — as its own layer, so it
   * participates in a surrounding `Layer.mergeAll`'s CONCURRENT build
   * exactly the way a real route's `HttpRouter.provideRequest`-wrapped
   * layer does. Captures the resolved `GenerationService` instance into
   * `bucket` for identity comparison; `Layer.effectDiscard` (not
   * `Layer.effectContext`) because this test only needs the SIDE EFFECT of
   * capturing, not to actually route HTTP requests — full HTTP dispatch is
   * orthogonal to the sharing question (sharing is fully determined by the
   * Layer/MemoMap graph, not by anything HTTP-specific), and skipping it
   * avoids needing a real `HttpRouter.HttpRouter` service + auth stack. */
  const captureViaNestedBuild = <R>(
    layer: Layer.Layer<GenerationService, never, R>,
    bucket: { instance: GenerationServiceShape | null },
  ) =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const services = yield* Layer.build(layer);
        bucket.instance = Context.get(services, GenerationService);
      }),
    );

  /**
   * EMPIRICAL RESULT (run 2026-08-12, 5/5 consecutive runs, deterministic —
   * not a flaky race): building EXACTLY this shape (two
   * `HttpRouter.provideRequest(GenerationServiceLive)` sites + an ordinary
   * `Layer.provide(GenerationServiceLive)` MCP consumer, merged via
   * `Layer.mergeAll` with NO ancestor `Layer.provide` — i.e. `server.ts`'s
   * `makeRoutesLayer` BEFORE this fix round) produces THREE SEPARATE
   * `GenerationService` instances: `route1Bucket.instance`,
   * `route2Bucket.instance`, and `mcpBucket.instance` are pairwise
   * DIFFERENT objects. Findings 1+2 (adversarial review, fix round) are
   * CONFIRMED REAL, not a false positive — the original
   * `GenerationServiceRegistrySharing.test.ts` tests above proved sharing
   * only for a FLAT `Effect.provide(sharedLayer)`, which never exercises
   * `HttpRouter.provideRequest`'s nested `Layer.build` fork at all. This
   * MUTATION GUARD keeps that finding alive as a permanent regression
   * check: this exact (unfixed) topology must STAY broken; only the
   * "FIX VERIFIED" test below — which adds the ancestor `Layer.provide` —
   * is the shape `server.ts` now actually ships.
   */
  it.effect(
    "MUTATION GUARD: two HttpRouter.provideRequest(GenerationServiceLive) sites + an ordinary Layer.provide(GenerationServiceLive) MCP consumer, merged via Layer.mergeAll with NO ancestor provide, do NOT reliably share",
    () =>
      Effect.gen(function* () {
        const sharedLayer = generationServiceLayer({ pollIntervalMs: 50_000 }).pipe(
          Layer.provide(inertProviderLayer),
        );

        const route1Bucket: { instance: GenerationServiceShape | null } = {
          instance: null,
        };
        const route2Bucket: { instance: GenerationServiceShape | null } = {
          instance: null,
        };
        const mcpBucket: { instance: GenerationServiceShape | null } = {
          instance: null,
        };

        // MCP side: ORDINARY structural Layer.provide — exactly how
        // `McpHttpServer.layer(generationServiceLive)`'s own
        // `GenerationToolkitRegistrationLive` consumes it (`.pipe(Layer
        // .provide(generationServiceLive))`).
        const mcpSideLayer = Layer.effectDiscard(
          Effect.gen(function* () {
            mcpBucket.instance = yield* GenerationService;
          }),
        ).pipe(Layer.provide(sharedLayer));

        // Two "route" sides — mirrors server.ts's TWO separate
        // `.pipe(HttpRouter.provideRequest(GenerationServiceLive))` call
        // sites (`generationListRouteLayer`, `generationAssetRouteLayer`).
        const route1Layer = captureViaNestedBuild(sharedLayer, route1Bucket);
        const route2Layer = captureViaNestedBuild(sharedLayer, route2Bucket);

        // The PRE-FIX nesting shape: `Layer.mergeAll(Layer.mergeAll(<routes...>),
        // McpHttpServer.layer(...))` with NO ancestor `Layer.provide`.
        const combined = Layer.mergeAll(Layer.mergeAll(route1Layer, route2Layer), mcpSideLayer);

        yield* Effect.scoped(Layer.build(combined));

        expect(route1Bucket.instance).not.toBeNull();
        expect(route2Bucket.instance).not.toBeNull();
        expect(mcpBucket.instance).not.toBeNull();

        // The confirmed-broken outcome for THIS topology.
        expect(route1Bucket.instance).not.toBe(mcpBucket.instance);
      }).pipe(Effect.provide(InfraLayer)),
  );

  it.effect(
    "MUTATION GUARD for the real-topology test: a route given its OWN fresh generationServiceLayer() (not the shared reference) is provably a DIFFERENT instance",
    () =>
      Effect.gen(function* () {
        const sharedLayer = generationServiceLayer({ pollIntervalMs: 50_000 }).pipe(
          Layer.provide(inertProviderLayer),
        );
        // The bug: this route gets its OWN separate layer call instead of
        // the shared reference — exactly the class of mistake the spec's
        // "#1 trap" warns about, reintroduced here to prove the harness
        // itself is discriminating (would catch this if it were the real
        // wiring), not just green regardless of what's plugged in.
        const unsharedLayer = generationServiceLayer({ pollIntervalMs: 50_000 }).pipe(
          Layer.provide(inertProviderLayer),
        );

        const route1Bucket: { instance: GenerationServiceShape | null } = {
          instance: null,
        };
        const mcpBucket: { instance: GenerationServiceShape | null } = {
          instance: null,
        };
        const mcpSideLayer = Layer.effectDiscard(
          Effect.gen(function* () {
            mcpBucket.instance = yield* GenerationService;
          }),
        ).pipe(Layer.provide(sharedLayer));
        const route1Layer = captureViaNestedBuild(unsharedLayer, route1Bucket);

        yield* Effect.scoped(Layer.build(Layer.mergeAll(route1Layer, mcpSideLayer)));

        expect(route1Bucket.instance).not.toBeNull();
        expect(mcpBucket.instance).not.toBeNull();
        expect(route1Bucket.instance).not.toBe(mcpBucket.instance);
      }).pipe(Effect.provide(InfraLayer)),
  );

  it.effect(
    "FIX VERIFIED: wrapping the merged routes+mcp graph with an ANCESTOR Layer.provide(GenerationServiceLive) makes sharing build-order-INDEPENDENT",
    () =>
      Effect.gen(function* () {
        const sharedLayer = generationServiceLayer({ pollIntervalMs: 50_000 }).pipe(
          Layer.provide(inertProviderLayer),
        );

        const route1Bucket: { instance: GenerationServiceShape | null } = {
          instance: null,
        };
        const route2Bucket: { instance: GenerationServiceShape | null } = {
          instance: null,
        };
        const mcpBucket: { instance: GenerationServiceShape | null } = {
          instance: null,
        };
        const jobHolder: { job: GenerationJob | null } = { job: null };

        // Same MCP-shaped consumer as the failing test above (ordinary
        // structural Layer.provide of the SAME reference — this is
        // McpHttpServer.layer's own real, unmodified consumption pattern;
        // the fix does not need to change it).
        const mcpSideLayer = Layer.effectDiscard(
          Effect.gen(function* () {
            const service = yield* GenerationService;
            mcpBucket.instance = service;
            jobHolder.job = yield* service.createJob({
              projectId,
              threadId,
              prompt: "fix-verified registry sharing barrel",
              parameters: {},
            });
          }),
        ).pipe(Layer.provide(sharedLayer));

        // Same TWO route sides, STILL using HttpRouter.provideRequest —
        // this does NOT change (confirmed mandatory: HttpRouter.add wraps a
        // route's own requirement in the branded `Request.From<"Requires",
        // X>` marker — server.ts's own UnityPipelineClientLayerLive comment
        // documents that ordinary Layer.provide is a SILENT NO-OP against
        // that marker, citing `editorPresenceCommandRouteLayer`'s identical
        // bug as the concrete precedent — so dropping provideRequest here
        // is not an option).
        const route1Layer = captureViaNestedBuild(sharedLayer, route1Bucket);
        const route2Layer = captureViaNestedBuild(sharedLayer, route2Bucket);

        // THE FIX: `GenerationServiceLive` provided ONCE more, as a TRUE
        // ANCESTOR wrapping the whole merged routes+mcp graph, via ORDINARY
        // `Layer.provide` — NOT `HttpRouter.provideRequest`. Verified
        // against `Layer.ts`'s `provideWith` (the shared implementation
        // behind both `Layer.provide`/`Layer.provideMerge`):
        // `internalEffect.flatMap(that.build(memoMap, scope), (context) =>
        // self.build(memoMap, scope)...)` — a `flatMap`, meaning `that`
        // (this ancestor `GenerationServiceLive`) is built to COMPLETION
        // FIRST, using the SAME (non-forked) memoMap, before `self`'s build
        // (the mergeAll of routes+mcp) starts at all. By the time either
        // route's `HttpRouter.provideRequest`-forked child looks up
        // `GenerationServiceLive`, the ancestor's entry is ALREADY in the
        // parent map — a deterministic read-through, not a race against a
        // concurrent `Layer.mergeAll` build.
        const combined = Layer.mergeAll(
          Layer.mergeAll(route1Layer, route2Layer),
          mcpSideLayer,
        ).pipe(Layer.provide(sharedLayer));

        yield* Effect.scoped(Layer.build(combined));

        expect(route1Bucket.instance).not.toBeNull();
        expect(route2Bucket.instance).not.toBeNull();
        expect(mcpBucket.instance).not.toBeNull();
        expect(jobHolder.job).not.toBeNull();

        expect(route1Bucket.instance).toBe(mcpBucket.instance);
        expect(route2Bucket.instance).toBe(mcpBucket.instance);

        const outcome = yield* dispatchGenerationList(readSession, projectId).pipe(
          Effect.provideService(GenerationService, route1Bucket.instance!),
          Effect.provide(Layer.mergeAll(projectionSnapshotQueryLayer, fakeServerSecretStoreLayer)),
        );
        expect(outcome._tag).toBe("ok");
        if (outcome._tag !== "ok" || "_tag" in outcome.value) {
          throw new Error("Expected a successful GenerationListSuccess.");
        }
        expect(outcome.value.entries.map((entry) => entry.job.id)).toContain(jobHolder.job!.id);
      }).pipe(Effect.provide(InfraLayer)),
  );
});
