/**
 * `POST /generation/list` — the browser -> server leg for the read-only
 * Generation dock panel (docs/v2/specs/increment-2b1-generation-panel.md).
 * Mirrors `unity/UnitySetupProbeRoute.ts` exactly: same auth pattern (
 * `EnvironmentAuth.authenticateHttpRequest` then an explicit
 * `AuthPresenceReadScope` check — "route authenticates WHO, this function
 * decides WHAT," so a missing scope is an ordinary result value this layer
 * renders, not an HTTP-layer rejection), same opaque-`projectId`-in shape
 * resolved through `ProjectionSnapshotQuery`, same
 * success-or-typed-`"error"` result union.
 *
 * `dispatchGenerationList` is exported and kept separate from the HTTP
 * wrapper below for the same reason `dispatchUnitySetupProbe` is: directly
 * unit-testable without a real HTTP request — including the shared-registry
 * proof this increment's spec calls out as the #1 trap (see that test's own
 * comment for the mechanism).
 */
import {
  AuthPresenceReadScope,
  GenerationListInput,
  type GenerationListEntry,
  type GenerationListResult,
  GENERATION_LIST_PATH,
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
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../auth/http.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { toClientSafeGeneratedAsset } from "../mcp/toolkits/generation/handlers.ts";

import * as GenerationService from "./GenerationService.ts";
import { issueGenerationAssetUrl } from "./GenerationAssetAccess.ts";

export type GenerationListDispatchOutcome =
  | { readonly _tag: "ok"; readonly value: GenerationListResult }
  | { readonly _tag: "insufficientScope" };

/**
 * Checks `AuthPresenceReadScope`, resolves the opaque `projectId` (never a
 * filesystem path crossing the wire), then reads the SHARED
 * `GenerationService` — the exact same instance `generate_3d`/
 * `generation_status`/`import_generated_asset` write through on the MCP
 * side, once `server.ts` hoists one `GenerationService.layer(...)` const
 * and threads that SAME reference into both this route's own
 * `HttpRouter.provideRequest` and `McpHttpServer.layer`'s parameter (this
 * file's spec's own "#1 trap": a second `GenerationService.layer()` call
 * here would build a separate, empty registry that renders forever-empty
 * with no error).
 */
export const dispatchGenerationList = (
  session: EnvironmentAuth.AuthenticatedSession,
  projectId: GenerationListInput["projectId"],
): Effect.Effect<
  GenerationListDispatchOutcome,
  never,
  | GenerationService.GenerationService
  | ProjectionSnapshotQuery.ProjectionSnapshotQuery
  | ServerSecretStore.ServerSecretStore
> =>
  Effect.gen(function* () {
    if (!session.scopes.includes(AuthPresenceReadScope)) {
      return { _tag: "insufficientScope" } as const;
    }

    const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const lookup = yield* snapshotQuery.getProjectShellById(projectId).pipe(
      Effect.map((project) => ({ _tag: "ok", project }) as const),
      // Same F2 fix `dispatchUnitySetupProbe` already applies: a swallowed
      // cause makes a SQL/decode failure indistinguishable from a genuine
      // unknown id — log before collapsing to the typed result.
      Effect.tapError((cause) =>
        Effect.logError("generation list: project lookup failed", { cause }),
      ),
      Effect.orElseSucceed(
        () => ({ _tag: "error", message: "Could not resolve project." }) as const,
      ),
    );
    if (lookup._tag === "error") {
      return { _tag: "ok", value: lookup } as const;
    }
    if (Option.isNone(lookup.project)) {
      return { _tag: "ok", value: { _tag: "error", message: "Project not found." } } as const;
    }

    const generationService = yield* GenerationService.GenerationService;
    const jobs = yield* generationService.listJobs(projectId);
    const entries = yield* Effect.forEach(jobs, (job) =>
      Effect.gen(function* () {
        if (job.assetId === null) {
          return { job, asset: null, previewMediaUrl: null } satisfies GenerationListEntry;
        }
        // `getAsset` is NOT project-scoped (spec's own cross-project
        // invariant) — re-apply the check, same merge-gate P1 #2 pattern
        // every MCP handler in handlers.ts already does by hand.
        const assetOption = yield* generationService.getAsset(job.assetId);
        if (Option.isNone(assetOption) || assetOption.value.projectId !== projectId) {
          return { job, asset: null, previewMediaUrl: null } satisfies GenerationListEntry;
        }
        const rawAsset = assetOption.value;
        const previewMediaUrl =
          rawAsset.preview.imageUrl === null
            ? null
            : (yield* issueGenerationAssetUrl({
                projectId,
                assetId: rawAsset.id,
                kind: "preview",
              })).relativeUrl;
        return {
          job,
          asset: toClientSafeGeneratedAsset(rawAsset),
          previewMediaUrl,
        } satisfies GenerationListEntry;
      }),
    );

    return { _tag: "ok", value: { entries } } as const;
  });

export const generationListRouteLayer = HttpRouter.add(
  "POST",
  GENERATION_LIST_PATH,
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
      Effect.flatMap(Schema.decodeUnknownEffect(GenerationListInput)),
      Effect.orElseSucceed(() => null),
    );
    if (input === null) {
      return HttpServerResponse.text("Bad Request: malformed generation list request", {
        status: 400,
      });
    }

    const outcome = yield* dispatchGenerationList(session, input.projectId);
    if (outcome._tag === "insufficientScope") {
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
