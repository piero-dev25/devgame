/**
 * In-process coverage for `dispatchUnityPipelineInstall` — the scope-gate +
 * dispatch logic `POST /unity/pipeline-install` relies on, mirroring
 * `UnityCommandRoute.test.ts`'s own identical pattern for the SAME scope
 * (`AuthPresenceCommandScope`) and `UnitySetupProbeRoute.test.ts`'s
 * scope-gate shape. That file's own closing comment explains why there is
 * no automated HTTP round-trip test for this route family in this repo yet
 * — the same gap applies here, and was closed the same way it always is in
 * this file family: a real Node HTTP server, the exact `server.ts`
 * composition, a real bearer session, and a real `POST
 * /unity/pipeline-install` request — 200 for an owner-scoped token
 * (real install against a disposable scratch project, real manifest.json
 * line confirmed on disk), 403 for a `presence:read`-only token. Not
 * automated here for the identical reason `UnityCommandRoute.test.ts`
 * gives (this repo's `globalFetchInEffect` diagnostic, no existing
 * suppression to follow as precedent).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  AuthOrchestrationOperateScope,
  AuthPresenceCommandScope,
  AuthPresenceReadScope,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import { dispatchUnityPipelineInstall } from "./UnityPipelineInstallRoute.ts";
import * as UnityPipelineClient from "./UnityPipelineClient.ts";

const PROJECT = "/Users/piero/Projects/Deepmind";

/** A `UnityPipelineClient` double that records which `workspaceRoot`
 * `install` was called with, and returns a fixed outcome — this suite is
 * about ROUTING and AUTHORIZATION, not about CLI parsing (already covered
 * by `UnityPipelineClient.test.ts`'s own `install` describe block). */
function makeUnityPipelineClientSpy(): {
  readonly layer: Layer.Layer<UnityPipelineClient.UnityPipelineClient>;
  readonly calls: Array<{ readonly method: string; readonly workspaceRoot: string }>;
} {
  const calls: Array<{ readonly method: string; readonly workspaceRoot: string }> = [];
  const outcome: UnityPipelineClient.UnityPipelineResult<UnityPipelineClient.UnityPipelineInstallResult> =
    {
      _tag: "ok",
      value: { packageId: "com.unity.pipeline", version: "0.4.0-exp.1", alreadyInstalled: false },
    };
  const layer = Layer.succeed(
    UnityPipelineClient.UnityPipelineClient,
    UnityPipelineClient.UnityPipelineClient.of({
      isAvailable: () => Effect.succeed(true),
      status: () => Effect.die("unexpected status call"),
      play: () => Effect.die("unexpected play call"),
      stop: () => Effect.die("unexpected stop call"),
      pause: () => Effect.die("unexpected pause call"),
      list: () => Effect.die("unexpected list call"),
      install: (workspaceRoot) => {
        calls.push({ method: "install", workspaceRoot });
        return Effect.succeed(outcome);
      },
      open: () => Effect.die("unexpected open call"),
    }),
  );
  return { layer, calls };
}

/** Provides `UnityPipelineClient` and `ServerConfig` around a dispatch
 * call, mirroring `UnitySetupProbe.test.ts`'s exact composition order
 * (`Effect.provide` chained per-layer on the EFFECT, `NodeServices.layer`
 * provided outermost) — `layerTest` is the established convenience layer
 * for a fixed `cwd` in this file family, even though
 * `dispatchUnityPipelineInstall` itself only ever reads `serverConfig.cwd`,
 * never touches the filesystem `layerTest` sets up. */
const runDispatchTest = (
  spy: ReturnType<typeof makeUnityPipelineClientSpy>,
  session: EnvironmentAuth.AuthenticatedSession,
) =>
  dispatchUnityPipelineInstall(session)
    .pipe(
      Effect.provide(spy.layer),
      Effect.provide(
        ServerConfig.layerTest(PROJECT, { prefix: "t3code-unity-pipeline-install-route-" }),
      ),
    )
    .pipe(Effect.provide(NodeServices.layer));

describe("dispatchUnityPipelineInstall", () => {
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
        const outcome = yield* runDispatchTest(spy, session);
        expect(outcome).toEqual({ _tag: "insufficientScope" });
        expect(spy.calls).toEqual([]);
      }),
  );

  it.effect(
    "presence:read alone does NOT satisfy presence:command — this route mutates the project, that scope doesn't authorize mutation",
    () =>
      Effect.gen(function* () {
        const spy = makeUnityPipelineClientSpy();
        const session: EnvironmentAuth.AuthenticatedSession = {
          sessionId: "test-session" as EnvironmentAuth.AuthenticatedSession["sessionId"],
          subject: "test-subject",
          method: "bearer-access-token",
          scopes: [AuthPresenceReadScope],
        };
        const outcome = yield* runDispatchTest(spy, session);
        expect(outcome).toEqual({ _tag: "insufficientScope" });
        expect(spy.calls).toEqual([]);
      }),
  );

  it.effect(
    "with presence:command, calls UnityPipelineClient.install with ServerConfig.cwd — never a caller-supplied path",
    () =>
      Effect.gen(function* () {
        const spy = makeUnityPipelineClientSpy();
        const session: EnvironmentAuth.AuthenticatedSession = {
          sessionId: "test-session" as EnvironmentAuth.AuthenticatedSession["sessionId"],
          subject: "test-subject",
          method: "bearer-access-token",
          scopes: [AuthPresenceCommandScope],
        };
        const outcome = yield* runDispatchTest(spy, session);
        expect(outcome._tag).toBe("ok");
        if (outcome._tag !== "ok") return;
        expect(outcome.value).toEqual({
          _tag: "ok",
          value: {
            packageId: "com.unity.pipeline",
            version: "0.4.0-exp.1",
            alreadyInstalled: false,
          },
        });
        expect(spy.calls).toEqual([{ method: "install", workspaceRoot: PROJECT }]);
      }),
  );
});
