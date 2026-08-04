/**
 * `POST /unity/pipeline-install` — the browser -> server leg for plan §5's
 * increment 4a: consented `unity pipeline install`. Mirrors
 * `UnitySetupProbeRoute.ts`'s "server-resolved, never caller-supplied"
 * project-path pattern (this server process is scoped to exactly ONE
 * project — see `UnitySetupProbe.ts`'s own module doc for why), NOT
 * `UnityCommandRoute.ts`'s caller-supplied `workspaceRoot` — deliberately:
 * plan §8-6 flags that route's caller-supplied path as needing validation
 * before it's exposed to untrusted callers, and this route has no reason to
 * reproduce that gap when `ServerConfig.cwd` already names the one project
 * this server process knows about.
 *
 * SCOPE CHOICE: gated by `AuthPresenceCommandScope`, the SAME scope
 * `UnityCommandRoute.ts` uses for Play/Stop/Pause — NOT
 * `AuthPresenceReadScope` (the setup-probe route's scope). That scope's own
 * doc comment is explicit about why it's safe to grant broadly: "this scope
 * authorizes no code execution and no project mutation." This route DOES
 * mutate the project (`Packages/manifest.json`, and indirectly
 * `packages-lock.json` once Unity resolves it) — the same risk class
 * `AuthPresenceCommandScope`'s own doc comment already covers
 * (`projectsWriteFile`). A second scope for the same capability reached
 * through a different mechanism (CLI shell-out vs. WS command frame) would
 * fragment the security model for no benefit, the identical reasoning
 * `UnityCommandRoute.ts`'s own doc comment gives for reusing this scope.
 *
 * CONSENT IS ENFORCED CLIENT-SIDE, NOT BY A SERVER-SIDE FLAG: this route has
 * no separate "did the user click confirm" input to check. The consent
 * dialog (`ConnectionsSettings.tsx`) is what stands between a page load and
 * this call ever firing — same posture `UnityCommandRoute.ts`'s Play/Stop/
 * Pause buttons already have (the click IS the consent; the server's own
 * enforcement is the scope check, not a second flag it would have no way to
 * verify was genuine anyway).
 */
import {
  AuthPresenceCommandScope,
  type UnityPipelineInstallResult,
  UNITY_PIPELINE_INSTALL_PATH,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../auth/http.ts";

import * as UnityPipelineClient from "./UnityPipelineClient.ts";

export type UnityPipelineInstallDispatchOutcome =
  | { readonly _tag: "ok"; readonly value: UnityPipelineInstallResult }
  | { readonly _tag: "insufficientScope" };

/**
 * Checks `AuthPresenceCommandScope`, then runs the install against this
 * server process's own `ServerConfig.cwd` — same "route authenticates WHO,
 * this function decides WHAT" split every other route in this family uses,
 * so a missing scope is an ordinary result value this layer chooses how to
 * render (below), not an HTTP-layer rejection that would make this check
 * unreachable dead code.
 *
 * Exported (not just used by the route below) for the same reason
 * `dispatchUnitySetupProbe`/`dispatchUnityCommand` are: testable directly,
 * without a real HTTP request.
 */
export const dispatchUnityPipelineInstall = (
  session: EnvironmentAuth.AuthenticatedSession,
): Effect.Effect<
  UnityPipelineInstallDispatchOutcome,
  never,
  UnityPipelineClient.UnityPipelineClient | ServerConfig.ServerConfig
> =>
  Effect.gen(function* () {
    if (!session.scopes.includes(AuthPresenceCommandScope)) {
      return { _tag: "insufficientScope" } as const;
    }
    const serverConfig = yield* ServerConfig.ServerConfig;
    const client = yield* UnityPipelineClient.UnityPipelineClient;
    const value = yield* client.install(serverConfig.cwd);
    return { _tag: "ok", value } as const;
  });

// Deliberately NOT `.pipe(Layer.provide(UnityPipelineClient.layer))` here —
// see `UnityCommandRoute.ts`'s own comment at its identical call site for
// the full writeup of why `HttpRouter.add(...)`'s branded
// `Request.From<"Requires", X>` marker requires `HttpRouter.provideRequest`,
// not ordinary `Layer.provide`, to discharge a route's own requirements.
export const unityPipelineInstallRouteLayer = HttpRouter.add(
  "POST",
  UNITY_PIPELINE_INSTALL_PATH,
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

    const outcome = yield* dispatchUnityPipelineInstall(session);
    if (outcome._tag === "insufficientScope") {
      // `HttpServerResponse.text` returns a bare `HttpServerResponse`, NOT
      // an Effect — same pitfall `UnitySetupProbeRoute.ts`'s own comment at
      // its identical call site documents.
      return HttpServerResponse.text("Forbidden: insufficient scope", { status: 403 });
    }
    return yield* HttpServerResponse.json(outcome.value);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  ),
);
