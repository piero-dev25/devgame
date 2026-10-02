/**
 * `POST /api/project-runtime/{start,stop,status}` - the browser launches,
 * stops and watches a project's run profiles. Mirrors
 * `ProjectWorkspaceRoute.ts`: the route authenticates who is asking, the
 * `dispatchRun*` functions decide what they get, so a missing scope is a
 * result value the route turns into 403.
 *
 * Start and stop need `terminal:operate`: a terminal can already run anything,
 * and it is in the standard client scopes, so remote and mobile clients can
 * launch too (`presence:command` is desktop-owner only). Status needs
 * `orchestration:read`, like reading project files.
 *
 * The client sends only the opaque `projectId`. The server resolves it to the
 * project's canonical root, never a thread worktree, so an id from another
 * project or environment can neither launch nor stop anything here.
 */
import {
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
  PROJECT_RUNTIME_START_PATH,
  PROJECT_RUNTIME_STATUS_PATH,
  PROJECT_RUNTIME_STOP_PATH,
  type ProjectId,
  RunStartInput,
  type RunStartResult,
  RunStatusInput,
  type RunStatusResult,
  RunStopInput,
  type RunStopResult,
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

import * as RunService from "./RunService.ts";

const errorValue = (message: string) => ({ _tag: "error", message }) as const;

type RunDispatchOutcome<A> =
  | { readonly _tag: "ok"; readonly value: A | ReturnType<typeof errorValue> }
  | { readonly _tag: "insufficientScope" };

type RunDispatchRequirements =
  | RunService.RunService
  | ProjectionSnapshotQuery.ProjectionSnapshotQuery;

/** The project's canonical root, or the wire error to return instead. */
const resolveProjectRoot = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const lookup = yield* snapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.map((project) => project.workspaceRoot)), Effect.result);
    if (lookup._tag === "Failure") {
      // Log before collapsing, so a SQL or decode failure is not mistaken for an unknown id.
      yield* Effect.logError("project runtime: project lookup failed", { cause: lookup.failure });
      return { _tag: "error", value: errorValue("Could not resolve project.") } as const;
    }
    if (Option.isNone(lookup.success)) {
      return { _tag: "error", value: errorValue("Project not found.") } as const;
    }
    return { _tag: "ok", workspaceRoot: lookup.success.value } as const;
  });

/** Scope gate, then the body; any typed service failure becomes `{_tag:'error'}`. */
const dispatch = <A, E extends { readonly message: string }>(
  session: EnvironmentAuth.AuthenticatedSession,
  scope: AuthEnvironmentScope,
  body: Effect.Effect<A, E, RunDispatchRequirements>,
): Effect.Effect<RunDispatchOutcome<A>, never, RunDispatchRequirements> =>
  session.scopes.includes(scope)
    ? body.pipe(
        Effect.catch((error) => Effect.succeed(errorValue(error.message))),
        Effect.map((value) => ({ _tag: "ok", value }) as const),
      )
    : Effect.succeed({ _tag: "insufficientScope" } as const);

export const dispatchRunStart = (
  session: EnvironmentAuth.AuthenticatedSession,
  input: RunStartInput,
): Effect.Effect<RunDispatchOutcome<RunStartResult>, never, RunDispatchRequirements> =>
  dispatch(
    session,
    AuthTerminalOperateScope,
    Effect.gen(function* () {
      const project = yield* resolveProjectRoot(input.projectId);
      if (project._tag === "error") return project.value;
      const runService = yield* RunService.RunService;
      // The service checks that the thread belongs to the project.
      return yield* runService.start({
        projectId: input.projectId,
        workspaceRoot: project.workspaceRoot,
        profileId: input.profileId,
        threadId: input.threadId ?? null,
      });
    }),
  );

export const dispatchRunStop = (
  session: EnvironmentAuth.AuthenticatedSession,
  input: RunStopInput,
): Effect.Effect<RunDispatchOutcome<RunStopResult>, never, RunDispatchRequirements> =>
  dispatch(
    session,
    AuthTerminalOperateScope,
    Effect.gen(function* () {
      // Resolved only to refuse ids this environment does not know; stop never needs the root.
      const project = yield* resolveProjectRoot(input.projectId);
      if (project._tag === "error") return project.value;
      const runService = yield* RunService.RunService;
      const run = yield* runService.stop({ projectId: input.projectId, runId: input.runId });
      return { run };
    }),
  );

export const dispatchRunStatus = (
  session: EnvironmentAuth.AuthenticatedSession,
  input: RunStatusInput,
): Effect.Effect<RunDispatchOutcome<RunStatusResult>, never, RunDispatchRequirements> =>
  dispatch(
    session,
    AuthOrchestrationReadScope,
    Effect.gen(function* () {
      const project = yield* resolveProjectRoot(input.projectId);
      if (project._tag === "error") return project.value;
      const runService = yield* RunService.RunService;
      return yield* runService.status({
        projectId: input.projectId,
        workspaceRoot: project.workspaceRoot,
      });
    }),
  );

const makeRunRoute = <S extends Schema.Top, A>(
  path: HttpRouter.PathInput,
  inputSchema: S,
  dispatchInput: (
    session: EnvironmentAuth.AuthenticatedSession,
    input: S["Type"],
  ) => Effect.Effect<RunDispatchOutcome<A>, never, RunDispatchRequirements>,
) =>
  HttpRouter.add(
    "POST",
    path,
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
        Effect.flatMap(Schema.decodeUnknownEffect(inputSchema)),
        Effect.option,
      );
      if (Option.isNone(input)) {
        return HttpServerResponse.text("Bad Request: malformed project runtime request", {
          status: 400,
        });
      }

      const outcome = yield* dispatchInput(session, input.value);
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

export const runStartRouteLayer = makeRunRoute(
  PROJECT_RUNTIME_START_PATH,
  RunStartInput,
  dispatchRunStart,
);
export const runStopRouteLayer = makeRunRoute(
  PROJECT_RUNTIME_STOP_PATH,
  RunStopInput,
  dispatchRunStop,
);
export const runStatusRouteLayer = makeRunRoute(
  PROJECT_RUNTIME_STATUS_PATH,
  RunStatusInput,
  dispatchRunStatus,
);
