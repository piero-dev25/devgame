/**
 * `POST /unity/setup-probe` — the browser -> server leg for `UnitySetupProbe`
 * (read-only Unity CLI/package/pairing state; see `UnitySetupProbe.ts` and
 * docs/workbench/plan-setup-integration.md). Mirrors `UnityCommandRoute.ts`'s
 * shape (same auth pattern, same "route authenticates WHO, the dispatch
 * function decides WHAT" split) with two deliberate differences:
 *
 * - Gated by `AuthPresenceReadScope`, NOT `AuthPresenceCommandScope` — this
 *   route executes no code and mutates no project; plan §1's F6 decided a
 *   dedicated, broadly-granted read scope precisely so the web app's own
 *   session (which never holds `presence:command`) can call its own
 *   settings panel's probe.
 * - Takes NO caller-supplied project path at all — see `UnitySetupProbe.ts`'s
 *   own module doc for why "server-resolved, never caller-supplied" needs
 *   no per-request validation here: there is nothing in the request body
 *   to validate in the first place.
 */
import {
  AuthPresenceReadScope,
  type UnitySetupProbeResult,
  UNITY_SETUP_PROBE_PATH,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../auth/http.ts";

import * as UnitySetupProbe from "./UnitySetupProbe.ts";

export type UnitySetupProbeDispatchOutcome =
  | { readonly _tag: "ok"; readonly value: UnitySetupProbeResult }
  | { readonly _tag: "insufficientScope" };

/**
 * Checks `AuthPresenceReadScope`, then runs the probe — same "route
 * authenticates WHO, this function decides WHAT" split
 * `dispatchUnityCommand` uses, so a missing scope is an ordinary result
 * value this layer chooses how to render (below), not an HTTP-layer
 * rejection that would make this check unreachable dead code.
 *
 * Exported (not just used by the route below) for the same reason
 * `dispatchUnityCommand` is: testable directly, without a real HTTP
 * request.
 */
export const dispatchUnitySetupProbe = (
  session: EnvironmentAuth.AuthenticatedSession,
): Effect.Effect<UnitySetupProbeDispatchOutcome, never, UnitySetupProbe.UnitySetupProbe> =>
  Effect.gen(function* () {
    if (!session.scopes.includes(AuthPresenceReadScope)) {
      return { _tag: "insufficientScope" } as const;
    }
    const service = yield* UnitySetupProbe.UnitySetupProbe;
    const value = yield* service.probe();
    return { _tag: "ok", value } as const;
  });

// Deliberately NOT `.pipe(Layer.provide(UnitySetupProbe.layer))` here — see
// `UnityCommandRoute.ts`'s own comment at its identical call site for the
// full writeup of why `HttpRouter.add(...)`'s branded `Request.From<
// "Requires", X>` marker requires `HttpRouter.provideRequest`, not ordinary
// `Layer.provide`, to discharge a route's own requirements.
export const unitySetupProbeRouteLayer = HttpRouter.add(
  "POST",
  UNITY_SETUP_PROBE_PATH,
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

    const outcome = yield* dispatchUnitySetupProbe(session);
    if (outcome._tag === "insufficientScope") {
      return yield* HttpServerResponse.text("Forbidden: insufficient scope", { status: 403 });
    }
    return yield* HttpServerResponse.json(outcome.value);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  ),
);
