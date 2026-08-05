/**
 * `POST /unity/pipeline-install` — the browser -> server leg for plan §5's
 * increment 4a: consented `unity pipeline install`. The client supplies an
 * opaque `projectId`; this route resolves the canonical workspace root from
 * the server's projection store. No caller-supplied filesystem path reaches
 * this disk-writing operation.
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
  UnityPipelineInstallInput,
  type UnityPipelineInstallResult,
  UNITY_PIPELINE_INSTALL_PATH,
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

import * as UnityPipelineClient from "./UnityPipelineClient.ts";

export type UnityPipelineInstallDispatchOutcome =
  | { readonly _tag: "ok"; readonly value: UnityPipelineInstallResult }
  | { readonly _tag: "insufficientScope" };

/**
 * Checks `AuthPresenceCommandScope`, resolves the opaque project id through
 * the server projection, then runs the install against that project's
 * canonical root — the same "route authenticates WHO, this function decides
 * WHAT" split every other route in this family uses, so a missing scope is
 * an ordinary result value this layer chooses how to render (below), not an
 * HTTP-layer rejection that would make this check unreachable dead code.
 *
 * Exported (not just used by the route below) for the same reason
 * `dispatchUnitySetupProbe`/`dispatchUnityCommand` are: testable directly,
 * without a real HTTP request.
 */
export const dispatchUnityPipelineInstall = (
  session: EnvironmentAuth.AuthenticatedSession,
  projectId: UnityPipelineInstallInput["projectId"],
): Effect.Effect<
  UnityPipelineInstallDispatchOutcome,
  never,
  UnityPipelineClient.UnityPipelineClient | ProjectionSnapshotQuery.ProjectionSnapshotQuery
> =>
  Effect.gen(function* () {
    if (!session.scopes.includes(AuthPresenceCommandScope)) {
      return { _tag: "insufficientScope" } as const;
    }
    const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const lookup = yield* snapshotQuery.getProjectShellById(projectId).pipe(
      Effect.map((project) => ({ _tag: "ok", project }) as const),
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
    const client = yield* UnityPipelineClient.UnityPipelineClient;
    // The Editor binds to the canonical root. A thread worktree is
    // deliberately not considered here: installing into a copy no Editor
    // has open would mutate the wrong manifest.
    const value = yield* client.install(lookup.project.value.workspaceRoot);
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

    const input = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(UnityPipelineInstallInput)),
      Effect.orElseSucceed(() => null),
    );
    if (input === null) {
      return HttpServerResponse.text("Bad Request: malformed pipeline install", { status: 400 });
    }

    const outcome = yield* dispatchUnityPipelineInstall(session, input.projectId);
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
