// Posts to `POST /api/project-workspace/read`
// (apps/server/src/projectWorkspace/ProjectWorkspaceRoute.ts) through
// `postForkEnvironmentRoute`, which resolves the environment's own URL and
// credentials, so the same call works locally, remotely and through a relay.
// The response is decoded against the contract, never cast.
//
// Web only: mobile does not call fork routes yet.
import {
  PROJECT_WORKSPACE_READ_PATH,
  ProjectWorkspaceReadResult,
  type ProjectWorkspaceReadSuccess,
  type ProjectId,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import { postForkEnvironmentRoute } from "../lib/forkEnvironmentRoute";
import { runtime } from "../lib/runtime";

const decodeProjectWorkspaceReadResult = Schema.decodeUnknownEffect(ProjectWorkspaceReadResult);

/** The registry read is a 1 MiB file plus a stat per step; 20s is headroom, not a tuned bound. */
const PROJECT_WORKSPACE_READ_TIMEOUT_MS = 20_000;

/** The server's typed refusal: an unresolved project or an unusable registry. */
export class ProjectWorkspaceServerError extends Schema.TaggedError<ProjectWorkspaceServerError>()(
  "ProjectWorkspaceServerError",
  { message: Schema.String },
) {}

/**
 * Reads the project's workspace registry. Resolves with `manifest: null` when
 * the project has none. Rejects on transport failure, a refused credential or
 * scope, a timeout, an undecodable body, or the server's typed error (unknown
 * project, malformed or oversized registry) with its message.
 */
export function fetchProjectWorkspace(input: {
  readonly projectId: ProjectId;
  readonly prepared: PreparedConnection;
}): Promise<ProjectWorkspaceReadSuccess> {
  return runtime.runPromise(
    Effect.gen(function* () {
      const body = yield* postForkEnvironmentRoute({
        prepared: input.prepared,
        path: PROJECT_WORKSPACE_READ_PATH,
        body: { projectId: input.projectId },
        timeoutMs: PROJECT_WORKSPACE_READ_TIMEOUT_MS,
      });
      const result = yield* decodeProjectWorkspaceReadResult(body);
      if ("_tag" in result) {
        return yield* new ProjectWorkspaceServerError({ message: result.message });
      }
      return result;
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
}
