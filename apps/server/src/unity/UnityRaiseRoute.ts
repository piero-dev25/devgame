/**
 * `POST /unity/raise` resolves an opaque project id to its canonical root,
 * then delegates liveness and cold-start behavior to the existing
 * `dispatchUnityColdStartLaunchForWorkspace` path. A live Editor is raised
 * through Launch Services; an absent Editor is launched with its project.
 *
 * SCOPE CHOICE: `AuthPresenceCommandScope`, identical to Play/Stop and
 * cold-start. `UnityColdStartRoute.ts`'s own scope comment classifies
 * spawning or changing the Editor as "make the user's editor execute code
 * or change what it's doing"; raising or launching it is the same risk
 * family and does not justify another scope.
 */
import {
  AuthPresenceCommandScope,
  type UnityRaiseInput,
  type UnityRaiseResult,
  UNITY_RAISE_PATH,
  UnityRaiseInput as UnityRaiseInputSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../auth/http.ts";
import { dispatchUnityColdStartLaunchForWorkspace } from "../editorPresence/UnityColdStartRoute.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as UnityPipelineClient from "./UnityPipelineClient.ts";

export type UnityRaiseDispatchOutcome =
  | { readonly _tag: "ok"; readonly value: UnityRaiseResult }
  | { readonly _tag: "insufficientScope" };

export const unityRaiseForbiddenResponse = () =>
  HttpServerResponse.text("Forbidden: insufficient scope", { status: 403 });

export const dispatchUnityRaise = (
  session: EnvironmentAuth.AuthenticatedSession,
  projectId: UnityRaiseInput["projectId"],
): Effect.Effect<
  UnityRaiseDispatchOutcome,
  never,
  | ExternalLauncher.ExternalLauncher
  | ProjectionSnapshotQuery.ProjectionSnapshotQuery
  | UnityPipelineClient.UnityPipelineClient
> =>
  Effect.gen(function* () {
    if (!session.scopes.includes(AuthPresenceCommandScope)) {
      return { _tag: "insufficientScope" } as const;
    }

    const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const lookup = yield* snapshotQuery.getProjectShellById(projectId).pipe(
      Effect.map((project) => ({ _tag: "ok", project }) as const),
      Effect.tapError((cause) => Effect.logError("unity raise: project lookup failed", { cause })),
      Effect.orElseSucceed(
        () => ({ _tag: "error", message: "Could not resolve project." }) as const,
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

    const coldStart = yield* dispatchUnityColdStartLaunchForWorkspace(
      session,
      lookup.project.value.workspaceRoot,
    );
    if (coldStart._tag === "insufficientScope") {
      return coldStart;
    }
    if (coldStart.value._tag === "launchIssued") {
      return { _tag: "ok", value: { _tag: "coldStartStarted" } } as const;
    }
    if (coldStart.value._tag === "alreadyOpen") {
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      // `open -a "Unity"` deliberately targets by application name. Launch
      // Services raises the Editor with no Automation/TCC grant, but cannot
      // disambiguate multiple running Editors; pid-precise focus would buy a
      // permission prompt the owner explicitly declined.
      return yield* launcher.launchApplication("Unity").pipe(
        Effect.as({ _tag: "ok", value: { _tag: "raised" } } as const),
        Effect.catch((cause) =>
          Effect.logError("unity raise: external launcher failed", { cause }).pipe(
            Effect.as({
              _tag: "ok",
              value: { _tag: "error", message: "Could not bring Unity to the front." },
            } as const),
          ),
        ),
      );
    }
    return {
      _tag: "ok",
      value:
        coldStart.value._tag === "error"
          ? coldStart.value
          : {
              _tag: "error",
              message:
                coldStart.value._tag === "cliUnavailable"
                  ? "The Unity CLI isn't available."
                  : "Unity isn't ready.",
            },
    } as const;
  });

export const unityRaiseRouteLayer = HttpRouter.add(
  "POST",
  UNITY_RAISE_PATH,
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
      Effect.flatMap(Schema.decodeUnknownEffect(UnityRaiseInputSchema)),
      Effect.orElseSucceed(() => null),
    );
    if (input === null) {
      return HttpServerResponse.text("Bad Request: malformed Unity raise", { status: 400 });
    }
    const outcome = yield* dispatchUnityRaise(session, input.projectId);
    if (outcome._tag === "insufficientScope") {
      return unityRaiseForbiddenResponse();
    }
    return yield* HttpServerResponse.json(outcome.value);
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  ),
);
