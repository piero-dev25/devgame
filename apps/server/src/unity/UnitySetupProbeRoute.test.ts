/**
 * In-process coverage for `dispatchUnitySetupProbe` — the scope-gate +
 * dispatch logic `POST /unity/setup-probe` relies on, mirroring
 * `UnityCommandRoute.test.ts`'s own identical pattern (that file's own
 * closing comment explains why there is no automated HTTP round-trip test
 * for this route family in this repo yet — the same gap applies here).
 */
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  AuthOrchestrationOperateScope,
  AuthPresenceCommandScope,
  AuthPresenceReadScope,
} from "@t3tools/contracts";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import { dispatchUnitySetupProbe } from "./UnitySetupProbeRoute.ts";
import * as UnitySetupProbe from "./UnitySetupProbe.ts";

function makeUnitySetupProbeSpy(): {
  readonly layer: Layer.Layer<UnitySetupProbe.UnitySetupProbe>;
  readonly calls: number;
  readonly getCalls: () => number;
} {
  let calls = 0;
  const result: UnitySetupProbe.UnitySetupProbe["Service"] = {
    probe: () => {
      calls += 1;
      return Effect.succeed({
        facts: {
          cliAvailable: true,
          cliDiscoveredPath: null,
          lockfilePresent: false,
          pipelinePackage: { installed: true, resolvedVersion: "0.4.0" },
          selectionPackage: { installed: true, resolvedVersion: "0.2.0" },
          selectionPublisherRegistered: true,
          withinPairingGraceWindow: false,
        },
        primary: { state: "S11" },
      });
    },
  };
  const layer = Layer.succeed(
    UnitySetupProbe.UnitySetupProbe,
    UnitySetupProbe.UnitySetupProbe.of(result),
  );
  return { layer, calls, getCalls: () => calls };
}

describe("dispatchUnitySetupProbe", () => {
  it.effect(
    "refuses a session without the dedicated presence:read scope, without ever calling the probe",
    () =>
      Effect.gen(function* () {
        const spy = makeUnitySetupProbeSpy();
        const session: EnvironmentAuth.AuthenticatedSession = {
          sessionId: "test-session" as EnvironmentAuth.AuthenticatedSession["sessionId"],
          subject: "test-subject",
          method: "bearer-access-token",
          scopes: [AuthOrchestrationOperateScope],
        };
        const outcome = yield* dispatchUnitySetupProbe(session).pipe(Effect.provide(spy.layer));
        expect(outcome).toEqual({ _tag: "insufficientScope" });
        expect(spy.getCalls()).toBe(0);
      }),
  );

  it.effect("with the scope, calls the probe and returns its result", () =>
    Effect.gen(function* () {
      const spy = makeUnitySetupProbeSpy();
      const session: EnvironmentAuth.AuthenticatedSession = {
        sessionId: "test-session" as EnvironmentAuth.AuthenticatedSession["sessionId"],
        subject: "test-subject",
        method: "bearer-access-token",
        scopes: [AuthPresenceReadScope],
      };
      const outcome = yield* dispatchUnitySetupProbe(session).pipe(Effect.provide(spy.layer));
      expect(outcome._tag).toBe("ok");
      if (outcome._tag !== "ok") return;
      expect(outcome.value.primary).toEqual({ state: "S11" });
      expect(spy.getCalls()).toBe(1);
    }),
  );

  it.effect(
    "presence:command alone does NOT satisfy presence:read — the scopes are deliberately distinct",
    () =>
      Effect.gen(function* () {
        const spy = makeUnitySetupProbeSpy();
        const session: EnvironmentAuth.AuthenticatedSession = {
          sessionId: "test-session" as EnvironmentAuth.AuthenticatedSession["sessionId"],
          subject: "test-subject",
          method: "bearer-access-token",
          scopes: [AuthPresenceCommandScope],
        };
        const outcome = yield* dispatchUnitySetupProbe(session).pipe(Effect.provide(spy.layer));
        expect(outcome).toEqual({ _tag: "insufficientScope" });
        expect(spy.getCalls()).toBe(0);
      }),
  );
});
