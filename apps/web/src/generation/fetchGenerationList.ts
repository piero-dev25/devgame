// Posts a real HTTP request to `POST /generation/list`
// (`apps/server/src/generation/GenerationListRoute.ts`'s
// `generationListRouteLayer`) — Increment 2b.1's read-only Generation dock
// panel (docs/v2/specs/increment-2b1-generation-panel.md). Modeled directly
// on `../unity/fetchSetupProbe.ts`'s `fetchUnitySetupProbe`: same
// `buildEnvironmentAuthHeaders`/`withEnvironmentCredentials` plumbing, same
// `runtime.runPromise` boundary, same "DECODE the response, never cast it"
// posture (#99/#100's own fix — a claim about wire data with nothing
// verifying it at runtime).
import {
  GENERATION_LIST_PATH,
  GenerationListResult,
  type GenerationListSuccess,
  type ProjectId,
} from "@t3tools/contracts";
import type { PreparedHttpAuthorization } from "@t3tools/client-runtime/connection";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  buildEnvironmentAuthHeaders,
  withEnvironmentCredentials,
} from "@t3tools/client-runtime/state/environmentHttpAuth";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { runtime } from "../lib/runtime";

// Pre-composed once at module scope — same convention `fetchSetupProbe.ts`'s
// own `decodeUnitySetupProbeResult` uses (#100).
const decodeGenerationListResult = Schema.decodeUnknownEffect(GenerationListResult);

export class GenerationListServerError extends Schema.TaggedErrorClass<GenerationListServerError>()(
  "GenerationListServerError",
  { message: Schema.String },
) {}

function fetchEffect(input: {
  readonly projectId: ProjectId;
  readonly httpBaseUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
}) {
  const url = environmentEndpointUrl(input.httpBaseUrl, GENERATION_LIST_PATH);
  return Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const headers = yield* buildEnvironmentAuthHeaders(
      input.httpAuthorization,
      "POST",
      url,
      signer,
    );
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({ ...headers }),
      HttpClientRequest.bodyJsonUnsafe({ projectId: input.projectId }),
    );
    const client = yield* HttpClient.HttpClient;
    const response = yield* withEnvironmentCredentials(
      input.httpAuthorization,
      client.execute(request),
    );
    const result = yield* decodeGenerationListResult(yield* response.json);
    if ("_tag" in result) {
      return yield* new GenerationListServerError({ message: result.message });
    }
    return result;
  }).pipe(
    // Same 20s bound `fetchSetupProbe.ts` uses — generous headroom over the
    // real observed latency of an in-memory job-registry read, not a tight
    // bound tuned to the happy path.
    Effect.timeout("20 seconds"),
    Effect.provide(FetchHttpClient.layer),
  );
}

/**
 * Fetches the current project-scoped generation jobs+assets list. Rejects
 * on transport failure, a `presence:read`-scope refusal, or the contract's
 * typed project-resolution error; a caller that gets a resolved value
 * always has a real list to render (possibly empty — the registry is
 * in-memory and dies on server restart, so "empty" is normal here, not a
 * failure).
 */
export function fetchGenerationList(input: {
  readonly projectId: ProjectId;
  readonly httpBaseUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
}): Promise<GenerationListSuccess> {
  return runtime.runPromise(fetchEffect(input));
}
