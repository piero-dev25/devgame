// Posts a real HTTP request to `POST /generation/list`
// (`apps/server/src/generation/GenerationListRoute.ts`'s
// `generationListRouteLayer`) — Increment 2b.1's read-only Generation dock
// panel (docs/v2/specs/increment-2b1-generation-panel.md). Modeled directly
// on `../unity/fetchSetupProbe.ts`'s `fetchUnitySetupProbe`: both post
// through `../lib/forkEnvironmentRoute.ts` (upstream's
// `executeAuthenticatedEnvironmentHttpRequest`) at the same
// `runtime.runPromise` boundary, with the same "DECODE the response, never
// cast it" posture (#99/#100's own fix — a claim about wire data with
// nothing verifying it at runtime).
import {
  GENERATION_LIST_PATH,
  GenerationListResult,
  type GenerationListSuccess,
  type ProjectId,
} from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import { postForkEnvironmentRoute } from "../lib/forkEnvironmentRoute";
import { runtime } from "../lib/runtime";

// Pre-composed once at module scope — same convention `fetchSetupProbe.ts`'s
// own `decodeUnitySetupProbeResult` uses (#100).
const decodeGenerationListResult = Schema.decodeUnknownEffect(GenerationListResult);

/** Same 20s bound `fetchSetupProbe.ts` uses — generous headroom over the
 * real observed latency of an in-memory job-registry read, not a tight bound
 * tuned to the happy path. */
const GENERATION_LIST_TIMEOUT_MS = 20_000;

export class GenerationListServerError extends Schema.TaggedError<GenerationListServerError>()(
  "GenerationListServerError",
  { message: Schema.String },
) {}

function fetchEffect(input: {
  readonly projectId: ProjectId;
  readonly prepared: PreparedConnection;
}) {
  return Effect.gen(function* () {
    const body = yield* postForkEnvironmentRoute({
      prepared: input.prepared,
      path: GENERATION_LIST_PATH,
      body: { projectId: input.projectId },
      timeoutMs: GENERATION_LIST_TIMEOUT_MS,
    });
    const result = yield* decodeGenerationListResult(body);
    if ("_tag" in result) {
      return yield* new GenerationListServerError({ message: result.message });
    }
    return result;
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

/**
 * Fetches the current project-scoped generation jobs+assets list. Rejects
 * on transport failure, an environment-level refusal (a rejected credential,
 * or the `presence:read`-scope 403), a timeout, or the contract's typed
 * project-resolution error; a caller that gets a resolved value always has a
 * real list to render (possibly empty — the registry is in-memory and dies on
 * server restart, so "empty" is normal here, not a failure).
 */
export function fetchGenerationList(input: {
  readonly projectId: ProjectId;
  readonly prepared: PreparedConnection;
}): Promise<GenerationListSuccess> {
  return runtime.runPromise(fetchEffect(input));
}
