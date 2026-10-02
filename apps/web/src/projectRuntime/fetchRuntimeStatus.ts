// Posts to `POST /api/project-runtime/status`
// (apps/server/src/projectRuntime/RunRoute.ts) through
// `postForkEnvironmentRoute`, which resolves the selected environment's own
// URL and credentials, so the same call works locally, remotely and through a
// relay. The response is decoded against the contract, never cast.
//
// Web only: mobile has no dock and does not call fork routes.
import {
  PROJECT_RUNTIME_STATUS_PATH,
  type ProjectId,
  RunStatusResult,
  type RunStatusSuccess,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import { postForkEnvironmentRoute } from "../lib/forkEnvironmentRoute";
import { runtime } from "../lib/runtime";

const decodeRunStatusResult = Schema.decodeUnknownEffect(RunStatusResult);

/** Status reads the manifest plus in-memory runs; 15s is headroom, not a tuned bound. */
const RUNTIME_STATUS_TIMEOUT_MS = 15_000;

/** The server's typed refusal, e.g. an unknown project on this environment. */
export class RuntimeStatusServerError extends Schema.TaggedError<RuntimeStatusServerError>()(
  "RuntimeStatusServerError",
  { message: Schema.String },
) {}

/**
 * The project's run profiles and this environment's runs of them. Rejects on
 * transport failure, a refused credential or scope, a timeout, an
 * undecodable body, or the server's typed error with its message.
 */
export function fetchRuntimeStatus(input: {
  readonly projectId: ProjectId;
  readonly prepared: PreparedConnection;
}): Promise<RunStatusSuccess> {
  return runtime.runPromise(
    Effect.gen(function* () {
      const body = yield* postForkEnvironmentRoute({
        prepared: input.prepared,
        path: PROJECT_RUNTIME_STATUS_PATH,
        body: { projectId: input.projectId },
        timeoutMs: RUNTIME_STATUS_TIMEOUT_MS,
      });
      const result = yield* decodeRunStatusResult(body);
      if ("_tag" in result) {
        return yield* new RuntimeStatusServerError({ message: result.message });
      }
      return result;
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
}
