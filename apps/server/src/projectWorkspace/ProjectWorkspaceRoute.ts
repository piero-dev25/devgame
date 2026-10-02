/**
 * `POST /api/project-workspace/read` - the browser reads a project's
 * Mr. Mak-compatible workspace registry. Mirrors `GenerationListRoute.ts`:
 * the route authenticates who is asking, `dispatchProjectWorkspaceRead`
 * decides what they get, so a missing scope is a result value this layer
 * turns into 403.
 *
 * The client sends only the opaque `projectId`. The server resolves it to the
 * project's canonical root, so one project's id can never read another
 * project's files, and an id from another environment is "Project not found.".
 */
import {
  AuthOrchestrationReadScope,
  ProjectWorkspaceReadInput,
  type ProjectWorkspaceReadResult,
  PROJECT_WORKSPACE_READ_PATH,
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

import * as ProjectWorkspace from "./ProjectWorkspace.ts";

type ProjectWorkspaceReadDispatchOutcome =
  | { readonly _tag: "ok"; readonly value: ProjectWorkspaceReadResult }
  | { readonly _tag: "insufficientScope" };

/**
 * Checks `orchestration:read` (the scope `projects.readFile` uses), resolves
 * the project, then reads its registry. A missing registry is
 * `{manifest: null}`; a registry that cannot be used is a typed error carrying
 * the reader's message.
 */
export const dispatchProjectWorkspaceRead = (
  session: EnvironmentAuth.AuthenticatedSession,
  projectId: ProjectWorkspaceReadInput["projectId"],
): Effect.Effect<
  ProjectWorkspaceReadDispatchOutcome,
  never,
  ProjectWorkspace.ProjectWorkspace | ProjectionSnapshotQuery.ProjectionSnapshotQuery
> =>
  Effect.gen(function* () {
    if (!session.scopes.includes(AuthOrchestrationReadScope)) {
      return { _tag: "insufficientScope" } as const;
    }

    const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const lookup = yield* snapshotQuery.getProjectShellById(projectId).pipe(
      Effect.map((project) => ({ _tag: "ok", project }) as const),
      // Log before collapsing, so a SQL or decode failure is not mistaken for an unknown id.
      Effect.tapError((cause) =>
        Effect.logError("project workspace: project lookup failed", { cause }),
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

    const projectWorkspace = yield* ProjectWorkspace.ProjectWorkspace;
    // The registry belongs to the canonical project root. Deliberately not a
    // thread worktree: the workspace is shared by every thread of the project.
    const value = yield* projectWorkspace.readManifest(lookup.project.value.workspaceRoot).pipe(
      Effect.map((read) => ({ manifest: read._tag === "ok" ? read.manifest : null })),
      Effect.catchTag("ProjectWorkspaceManifestError", (error) =>
        Effect.logWarning("project workspace: registry unusable", {
          projectId,
          reason: error.reason,
        }).pipe(Effect.as({ _tag: "error" as const, message: error.message })),
      ),
    );
    return { _tag: "ok", value } as const;
  });

export const projectWorkspaceRouteLayer = HttpRouter.add(
  "POST",
  PROJECT_WORKSPACE_READ_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(
          EnvironmentAuth.serverAuthCredentialReason(error),
          EnvironmentAuth.serverAuthDpopFailureReason(error),
        ),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );

    const input = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ProjectWorkspaceReadInput)),
      Effect.orElseSucceed(() => null),
    );
    if (input === null) {
      return HttpServerResponse.text("Bad Request: malformed project workspace request", {
        status: 400,
      });
    }

    const outcome = yield* dispatchProjectWorkspaceRead(session, input.projectId);
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
