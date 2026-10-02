/**
 * `POST /api/project-import/{plan,apply,status}` - the browser reviews a
 * Mr. Mak import, applies the plan it reviewed, and reads a project's import
 * state. Mirrors `RunRoute.ts`: the route authenticates who is asking, the
 * `dispatchImport*` functions decide what they get, so a missing scope is a
 * result value the route turns into 403.
 *
 * The dry run and status need `orchestration:read` (like reading project
 * files); apply writes files into the destination, so it needs
 * `orchestration:operate` (like `projects.writeFile`). Both are standard
 * client scopes, so remote clients can import too.
 *
 * The client sends the two projects the user picked as opaque ids. The server
 * resolves each to its canonical root, so no host path crosses the wire and an
 * id from another environment is "Project not found.". Imported HTML is never
 * served here; the client opens imported files in its sandboxed Files preview.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  MRMAK_IMPORT_APPLY_PATH,
  MRMAK_IMPORT_PLAN_PATH,
  MRMAK_IMPORT_STATUS_PATH,
  MrMakImportApplyInput,
  type MrMakImportApplyResult,
  MrMakImportPlanInput,
  type MrMakImportPlanResult,
  MrMakImportStatusInput,
  type MrMakImportStatusResult,
  type ProjectId,
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

import * as MrMakImport from "./MrMakImport.ts";

const errorValue = (message: string) => ({ _tag: "error", message }) as const;
type ErrorValue = ReturnType<typeof errorValue>;

type ImportDispatchOutcome<A> =
  | { readonly _tag: "ok"; readonly value: A | ErrorValue }
  | { readonly _tag: "insufficientScope" };

type ImportDispatchRequirements =
  | MrMakImport.MrMakImport
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
      yield* Effect.logError("project import: project lookup failed", { cause: lookup.failure });
      return { _tag: "error", value: errorValue("Could not resolve project.") } as const;
    }
    if (Option.isNone(lookup.success)) {
      return { _tag: "error", value: errorValue("Project not found.") } as const;
    }
    return { _tag: "ok", root: lookup.success.value } as const;
  });

/** Both roots of an import, refusing an import into its own source. */
const resolveImportRoots = (input: MrMakImportPlanInput) =>
  Effect.gen(function* () {
    if (input.sourceProjectId === input.destinationProjectId) {
      return {
        _tag: "error",
        value: errorValue(
          "Choose a different destination: an import never writes into its source.",
        ),
      } as const;
    }
    const source = yield* resolveProjectRoot(input.sourceProjectId);
    if (source._tag === "error") return source;
    const destination = yield* resolveProjectRoot(input.destinationProjectId);
    if (destination._tag === "error") return destination;
    return {
      _tag: "ok",
      roots: {
        sourceRoot: source.root,
        destinationRoot: destination.root,
        ...(input.roots ? { roots: input.roots } : {}),
      },
    } as const;
  });

/** Scope gate, then the body; any typed service failure becomes `{_tag:'error'}`. */
const dispatch = <A, E extends { readonly message: string }>(
  session: EnvironmentAuth.AuthenticatedSession,
  scope: AuthEnvironmentScope,
  body: Effect.Effect<A | ErrorValue, E, ImportDispatchRequirements>,
): Effect.Effect<ImportDispatchOutcome<A>, never, ImportDispatchRequirements> =>
  session.scopes.includes(scope)
    ? body.pipe(
        Effect.catch((error) => Effect.succeed(errorValue(error.message))),
        Effect.map((value) => ({ _tag: "ok", value }) as const),
      )
    : Effect.succeed({ _tag: "insufficientScope" } as const);

export const dispatchImportPlan = (
  session: EnvironmentAuth.AuthenticatedSession,
  input: MrMakImportPlanInput,
): Effect.Effect<ImportDispatchOutcome<MrMakImportPlanResult>, never, ImportDispatchRequirements> =>
  dispatch(
    session,
    AuthOrchestrationReadScope,
    Effect.gen(function* () {
      const resolved = yield* resolveImportRoots(input);
      if (resolved._tag === "error") return resolved.value;
      const service = yield* MrMakImport.MrMakImport;
      return yield* service.review(resolved.roots);
    }),
  );

export const dispatchImportApply = (
  session: EnvironmentAuth.AuthenticatedSession,
  input: MrMakImportApplyInput,
): Effect.Effect<
  ImportDispatchOutcome<MrMakImportApplyResult>,
  never,
  ImportDispatchRequirements
> =>
  dispatch(
    session,
    AuthOrchestrationOperateScope,
    Effect.gen(function* () {
      const resolved = yield* resolveImportRoots(input);
      if (resolved._tag === "error") return resolved.value;
      const service = yield* MrMakImport.MrMakImport;
      return yield* service.apply({
        ...resolved.roots,
        planId: input.planId,
        choices: input.choices,
        skillChoices: input.skillChoices,
        confirmExistingProject: input.confirmExistingProject,
      });
    }),
  );

export const dispatchImportStatus = (
  session: EnvironmentAuth.AuthenticatedSession,
  input: MrMakImportStatusInput,
): Effect.Effect<
  ImportDispatchOutcome<MrMakImportStatusResult>,
  never,
  ImportDispatchRequirements
> =>
  dispatch(
    session,
    AuthOrchestrationReadScope,
    Effect.gen(function* () {
      const project = yield* resolveProjectRoot(input.projectId);
      if (project._tag === "error") return project.value;
      const service = yield* MrMakImport.MrMakImport;
      return yield* service.status({ destinationRoot: project.root });
    }),
  );

const makeImportRoute = <S extends Schema.Top, A>(
  path: HttpRouter.PathInput,
  inputSchema: S,
  dispatchInput: (
    session: EnvironmentAuth.AuthenticatedSession,
    input: S["Type"],
  ) => Effect.Effect<ImportDispatchOutcome<A>, never, ImportDispatchRequirements>,
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
        return HttpServerResponse.text("Bad Request: malformed project import request", {
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

export const importPlanRouteLayer = makeImportRoute(
  MRMAK_IMPORT_PLAN_PATH,
  MrMakImportPlanInput,
  dispatchImportPlan,
);
export const importApplyRouteLayer = makeImportRoute(
  MRMAK_IMPORT_APPLY_PATH,
  MrMakImportApplyInput,
  dispatchImportApply,
);
export const importStatusRouteLayer = makeImportRoute(
  MRMAK_IMPORT_STATUS_PATH,
  MrMakImportStatusInput,
  dispatchImportStatus,
);
