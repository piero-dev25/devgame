/**
 * In-process coverage for `dispatchUnityCommand` — the scope-gate + dispatch
 * routing logic `POST /unity/command` relies on, mirroring how
 * `EditorPresenceRoute.test.ts` proves `dispatchEditorCommand` directly
 * before (also) proving it over the wire.
 *
 * NO real-HTTP round-trip test here, and that gap is deliberate, not an
 * oversight — see the note at the bottom of this file for why, and
 * `UnityCommandRoute.ts`'s own comment on the route definition for the
 * layer-composition finding this work surfaced along the way. The route
 * itself IS proven working end to end: booted via a real Node HTTP server
 * (not the vitest test harness) with the exact `apps/server/src/server.ts`
 * composition, a real bearer session, and a real `POST /unity/command`
 * request — 200, auth passed, scope passed, `UnityPipelineClient.status`
 * reached the real `unity` CLI and returned its real (expected) error for
 * a non-Unity path. That proof is not automated; see the note below.
 */
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AuthOrchestrationOperateScope, AuthPresenceCommandScope } from "@t3tools/contracts";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import { dispatchUnityCommand } from "./UnityCommandRoute.ts";
import * as UnityPipelineClient from "./UnityPipelineClient.ts";

const PROJECT = "/Users/piero/Projects/Deepmind";

/** A `UnityPipelineClient` double that records which method was called and
 * with what `workspaceRoot`, and returns a fixed outcome — this suite is
 * about ROUTING and AUTHORIZATION, not about CLI parsing (already covered
 * by UnityPipelineClient.test.ts). */
function makeUnityPipelineClientSpy(): {
  readonly layer: Layer.Layer<UnityPipelineClient.UnityPipelineClient>;
  readonly calls: Array<{ readonly method: string; readonly workspaceRoot: string }>;
} {
  const calls: Array<{ readonly method: string; readonly workspaceRoot: string }> = [];
  const outcome: UnityPipelineClient.UnityPipelineResult<UnityPipelineClient.UnityEditorStatus> = {
    _tag: "ok",
    value: {
      status: "ready",
      compiling: false,
      domainReloadInProgress: false,
      playMode: "stopped",
      unityVersion: "6000.3.14f1",
    },
  };
  const record =
    (method: string) =>
    (workspaceRoot: string): Effect.Effect<typeof outcome> => {
      calls.push({ method, workspaceRoot });
      return Effect.succeed(outcome);
    };
  const layer = Layer.succeed(
    UnityPipelineClient.UnityPipelineClient,
    UnityPipelineClient.UnityPipelineClient.of({
      isAvailable: () => Effect.succeed(true),
      status: record("status"),
      play: record("play"),
      stop: record("stop"),
      pause: record("pause"),
    }),
  );
  return { layer, calls };
}

describe("dispatchUnityCommand", () => {
  it.effect(
    "refuses a session without the dedicated presence:command scope, without ever calling UnityPipelineClient",
    () =>
      Effect.gen(function* () {
        const spy = makeUnityPipelineClientSpy();
        const session: EnvironmentAuth.AuthenticatedSession = {
          sessionId: "test-session" as EnvironmentAuth.AuthenticatedSession["sessionId"],
          subject: "test-subject",
          method: "bearer-access-token",
          scopes: [AuthOrchestrationOperateScope],
        };
        const outcome = yield* dispatchUnityCommand(session, PROJECT, "play").pipe(
          Effect.provide(spy.layer),
        );
        expect(outcome).toEqual({ _tag: "error", message: "insufficient_scope" });
        expect(spy.calls).toEqual([]);
      }),
  );

  for (const action of ["play", "stop", "pause", "status"] as const) {
    it.effect(
      `with the scope, action "${action}" dispatches to UnityPipelineClient.${action}`,
      () =>
        Effect.gen(function* () {
          const spy = makeUnityPipelineClientSpy();
          const session: EnvironmentAuth.AuthenticatedSession = {
            sessionId: "test-session" as EnvironmentAuth.AuthenticatedSession["sessionId"],
            subject: "test-subject",
            method: "bearer-access-token",
            scopes: [AuthPresenceCommandScope],
          };
          const outcome = yield* dispatchUnityCommand(session, PROJECT, action).pipe(
            Effect.provide(spy.layer),
          );
          expect(outcome._tag).toBe("ok");
          expect(spy.calls).toEqual([{ method: action, workspaceRoot: PROJECT }]);
        }),
    );
  }
});

/**
 * WHY THERE IS NO AUTOMATED HTTP ROUND-TRIP TEST HERE, per this repo's own
 * "assert the effect over the wire" bar (`EditorPresenceRoute.test.ts` has
 * exactly this kind of test for the sibling presence-command route):
 *
 * Measured live in this repo/Effect-version combination: `HttpClient.execute`
 * (`effect/unstable/http`) against a route served via `NodeHttpServer.layerTest`
 * consistently returned 404 for `POST /unity/command` — even after fixing a
 * real, separate bug this work also found (a route built via
 * `HttpRouter.add(...).pipe(Layer.provide(X))` where `X` has its own
 * unresolved external deps silently fails to register — see
 * `UnityCommandRoute.ts`'s own comment; fixed by leaving `UnityPipelineClient`
 * external and providing a fully-resolved layer at the composition site).
 * With that fix applied, the SAME request via the plain global `fetch()`
 * reached the real handler correctly (confirmed: 200, or a real 500 from a
 * genuinely-invoked route, never 404) — proving the route itself was fine
 * and the gap was specifically in how `HttpClient`/`FetchHttpClient` reaches
 * `NodeHttpServer.layerTest` here. The root cause was not fully isolated in
 * the time available; `EditorPresenceRoute.test.ts`'s own HTTP tests use the
 * identical `HttpClient`/`NodeHttpServer.layerTest` pattern successfully, so
 * this is not a blanket framework failure — something specific to this
 * route's composition or this file remains unexplained.
 *
 * This repo's own diagnostics forbid the global `fetch()` in Effect code
 * (`effect(globalFetchInEffect)`) with NO existing suppression anywhere in
 * this codebase for that rule — meaning shipping a `fetch()`-based test here
 * would be the first exception to an otherwise-unbroken convention. Rather
 * than either (a) be that first exception without the owner's say-so, or
 * (b) ship a test using `HttpClient` that is known to fail for a reason
 * unrelated to the route's own correctness, this gap is left OPEN and
 * explicit:
 *
 * - The route's actual correctness was verified by hand: a real Node HTTP
 *   server, the exact `server.ts` layer composition, a real bearer session,
 *   a real POST — 200, and `UnityPipelineClient.status` reaching the real
 *   `unity` CLI (a real, expected error for a non-Unity path proved the
 *   full chain — auth, scope, dispatch, subprocess — actually ran).
 * - The gap is: no COMMITTED automated test proves this over HTTP the way
 *   `EditorPresenceRoute.test.ts` proves its sibling route. The 5 in-process
 *   `dispatchUnityCommand` tests above cover the scope-gate and per-action
 *   dispatch logic that route puts on the wire.
 */
