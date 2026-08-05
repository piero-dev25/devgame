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
 * - Takes only an opaque `projectId`; the canonical filesystem root is
 *   resolved from the server's projection store and never crosses the wire.
 */
import {
  AuthPresenceReadScope,
  UnitySetupProbeInput,
  type UnitySetupProbeResult,
  UNITY_SETUP_PROBE_PATH,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../auth/http.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

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
  projectId: UnitySetupProbeInput["projectId"],
): Effect.Effect<
  UnitySetupProbeDispatchOutcome,
  never,
  UnitySetupProbe.UnitySetupProbe | ProjectionSnapshotQuery.ProjectionSnapshotQuery
> =>
  Effect.gen(function* () {
    if (!session.scopes.includes(AuthPresenceReadScope)) {
      return { _tag: "insufficientScope" } as const;
    }
    const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const lookup = yield* snapshotQuery.getProjectShellById(projectId).pipe(
      Effect.map((project) => ({ _tag: "ok", project }) as const),
      // Merge-gate F2: the swallowed cause made a SQL/decode failure
      // indistinguishable from a genuine unknown id in triage — the client
      // renders only the message, so the server log is the ONLY place the
      // real error can survive. Log before collapsing to the typed result.
      Effect.tapError((cause) =>
        Effect.logError("unity setup probe: project lookup failed", { cause }),
      ),
      Effect.orElseSucceed(
        () =>
          ({
            _tag: "error",
            message: "Could not resolve project.",
          }) as const,
      ),
    );
    if (lookup._tag === "error") {
      return { _tag: "ok", value: lookup } as const;
    }
    if (Option.isNone(lookup.project)) {
      return {
        _tag: "ok",
        value: { _tag: "error", message: "Project not found." },
      } as const;
    }
    const service = yield* UnitySetupProbe.UnitySetupProbe;
    // Unity Editor binds to the canonical project root. Deliberately do not
    // substitute a thread worktree: installing/probing a copy no Editor has
    // open would target the wrong project.
    const value = yield* service.probe(lookup.project.value.workspaceRoot);
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

    const input = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(UnitySetupProbeInput)),
      Effect.orElseSucceed(() => null),
    );
    if (input === null) {
      return HttpServerResponse.text("Bad Request: malformed setup probe", { status: 400 });
    }

    const outcome = yield* dispatchUnitySetupProbe(session, input.projectId);
    if (outcome._tag === "insufficientScope") {
      // `HttpServerResponse.text` returns a bare `HttpServerResponse`, NOT
      // an Effect — unlike `.json` below, which can fail with
      // `HttpBodyError` encoding the body and is genuinely an Effect.
      // `yield*`-ing this one was a real type error (`HttpServerResponse`
      // has no `Symbol.iterator`), caught by running plain `tsc --noEmit`
      // on this package rather than only the lint-inclusive `vp run ...
      // typecheck`.
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
