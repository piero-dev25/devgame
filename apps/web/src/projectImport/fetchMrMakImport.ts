// The Mr. Mak import routes (apps/server/src/projectImport/MrMakImportRoute.ts)
// through `postForkEnvironmentRoute`, so no origin is hardcoded and a remote
// environment imports between its own projects the same way. Only opaque
// project ids, the reviewed plan's id and the user's choices are sent; the
// server resolves every path. Responses are decoded against the contract.
//
// Web only: mobile does not call fork routes yet.
import {
  MRMAK_IMPORT_APPLY_PATH,
  MRMAK_IMPORT_PLAN_PATH,
  MRMAK_IMPORT_STATUS_PATH,
  type MrMakImportApplyInput,
  MrMakImportApplyResult,
  type MrMakImportApplySuccess,
  MrMakImportPlanResult,
  type MrMakImportPlanSummary,
  MrMakImportStatusResult,
  type MrMakImportStatusSuccess,
  type ProjectId,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import {
  classifyForkRouteFailure,
  type ForkRouteFailure,
  postForkEnvironmentRoute,
} from "../lib/forkEnvironmentRoute";
import { runtime } from "../lib/runtime";

/** The dry run reads the committed tree and hashes the destination; generous, not tuned. */
const IMPORT_PLAN_TIMEOUT_MS = 120_000;
/** Apply copies every file (tens of MB of media) and makes the baseline commit. */
const IMPORT_APPLY_TIMEOUT_MS = 600_000;
const IMPORT_STATUS_TIMEOUT_MS = 60_000;

/** What the dialog shows for a dry run or an apply: the result, the server's refusal, or why there was none. */
export type ImportRequestOutcome<A> =
  | { readonly _tag: "ok"; readonly value: A }
  | { readonly _tag: "refused"; readonly message: string }
  | ForkRouteFailure;

const ok = <A>(value: A): ImportRequestOutcome<A> => ({ _tag: "ok", value });
const refused = <A>(message: string): ImportRequestOutcome<A> => ({ _tag: "refused", message });

const decodePlanResult = Schema.decodeUnknownEffect(MrMakImportPlanResult);
const decodeApplyResult = Schema.decodeUnknownEffect(MrMakImportApplyResult);
const decodeStatusResult = Schema.decodeUnknownEffect(MrMakImportStatusResult);

function post<A>(input: {
  readonly prepared: PreparedConnection;
  readonly path: string;
  readonly body: unknown;
  readonly timeoutMs: number;
  /** Decodes the body and turns the server's `{_tag: "error"}` into `refused`. */
  readonly decode: (body: unknown) => Effect.Effect<ImportRequestOutcome<A>, Schema.SchemaError>;
}): Promise<ImportRequestOutcome<A>> {
  return runtime.runPromise(
    Effect.gen(function* () {
      const body = yield* postForkEnvironmentRoute(input);
      return yield* input.decode(body);
    }).pipe(
      Effect.catch((error): Effect.Effect<ImportRequestOutcome<A>> =>
        Effect.succeed(classifyForkRouteFailure(error)),
      ),
      Effect.provide(FetchHttpClient.layer),
    ),
  );
}

/** The dry run: writes nothing anywhere. */
export function postImportPlan(input: {
  readonly prepared: PreparedConnection;
  readonly sourceProjectId: ProjectId;
  readonly destinationProjectId: ProjectId;
}): Promise<ImportRequestOutcome<MrMakImportPlanSummary>> {
  return post({
    prepared: input.prepared,
    path: MRMAK_IMPORT_PLAN_PATH,
    body: {
      sourceProjectId: input.sourceProjectId,
      destinationProjectId: input.destinationProjectId,
    },
    timeoutMs: IMPORT_PLAN_TIMEOUT_MS,
    decode: (body) =>
      decodePlanResult(body).pipe(
        Effect.map((result) => ("_tag" in result ? refused(result.message) : ok(result))),
      ),
  });
}

/** Imports the reviewed plan; the server refuses it if anything moved since the dry run. */
export function postImportApply(input: {
  readonly prepared: PreparedConnection;
  readonly request: MrMakImportApplyInput;
}): Promise<ImportRequestOutcome<MrMakImportApplySuccess>> {
  return post({
    prepared: input.prepared,
    path: MRMAK_IMPORT_APPLY_PATH,
    body: input.request,
    timeoutMs: IMPORT_APPLY_TIMEOUT_MS,
    decode: (body) =>
      decodeApplyResult(body).pipe(
        Effect.map((result) => ("_tag" in result ? refused(result.message) : ok(result))),
      ),
  });
}

/** The server's typed refusal or a failed request, as the status query's failure. */
export class MrMakImportStatusError extends Schema.TaggedError<MrMakImportStatusError>()(
  "MrMakImportStatusError",
  { message: Schema.String },
) {}

/**
 * A project's import, read from its receipt (`import: null` when it has none).
 * Rejects when there is no result, with a message the panel shows.
 */
export async function fetchImportStatus(input: {
  readonly prepared: PreparedConnection;
  readonly projectId: ProjectId;
}): Promise<MrMakImportStatusSuccess> {
  const outcome = await post<MrMakImportStatusSuccess>({
    prepared: input.prepared,
    path: MRMAK_IMPORT_STATUS_PATH,
    body: { projectId: input.projectId },
    timeoutMs: IMPORT_STATUS_TIMEOUT_MS,
    decode: (body) =>
      decodeStatusResult(body).pipe(
        Effect.map((result) => ("_tag" in result ? refused(result.message) : ok(result))),
      ),
  });
  switch (outcome._tag) {
    case "ok":
      return outcome.value;
    case "notPermitted":
      throw new MrMakImportStatusError({
        message: "This connection may not read project files on this environment.",
      });
    default:
      throw new MrMakImportStatusError({ message: outcome.message });
  }
}
