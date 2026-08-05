// Posts a real HTTP request to `POST /unity/setup-probe`
// (`apps/server/src/unity/UnitySetupProbeRoute.ts`'s `unitySetupProbeRouteLayer`)
// — the read-only "what's missing to make Unity work" check (#92 increment
// 1). Modeled closely on `./dispatchCommand.ts`'s `dispatchUnityCommand`:
// same `buildEnvironmentAuthHeaders`/`withEnvironmentCredentials` plumbing,
// same `runtime.runPromise` boundary. Kept as its own file rather than added
// to `dispatchCommand.ts` because the two calls have nothing in common
// beyond the transport — this one sends only an opaque `projectId` (the
// server resolves the canonical root) and returns the full classified
// taxonomy rather than a play/stop/pause outcome.
import {
  type ProjectId,
  UNITY_SETUP_PROBE_PATH,
  UnitySetupProbeResult,
  type UnitySetupProbeSuccess,
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

// Pre-composed once at module scope, same convention as
// `connection/storage.ts`'s `decodeConnectionCatalogDocument` and
// `cloud/dpop.ts`'s `decodeDpopPublicJwk` — the response body is `unknown`
// wire data, not something a compile-time cast can vouch for (#100).
const decodeUnitySetupProbeResult = Schema.decodeUnknownEffect(UnitySetupProbeResult);

export class UnitySetupProbeServerError extends Schema.TaggedErrorClass<UnitySetupProbeServerError>()(
  "UnitySetupProbeServerError",
  { message: Schema.String },
) {}

function fetchEffect(input: {
  readonly projectId: ProjectId;
  readonly httpBaseUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
}) {
  const url = environmentEndpointUrl(input.httpBaseUrl, UNITY_SETUP_PROBE_PATH);
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
    const result = yield* decodeUnitySetupProbeResult(yield* response.json);
    if ("_tag" in result) {
      return yield* new UnitySetupProbeServerError({ message: result.message });
    }
    return result;
  }).pipe(
    // Bounded so a hung connection can never leave a caller's `.then`/
    // `.catch` both un-fired forever — found live (2026-08-04, team-lead +
    // presence-authz) as the second half of the "Checking…" panel bug: an
    // unbounded fetch that never resolves OR rejects is indistinguishable,
    // from the caller's side, from one that's still loading. 20s matches
    // this route's own real observed latency (a live probe run against a
    // real project measured ~200ms; this is generous headroom, not a tight
    // bound tuned to the happy path).
    Effect.timeout("20 seconds"),
    Effect.provide(FetchHttpClient.layer),
  );
}

/**
 * Fetches the current classified Unity setup state (`facts` + one `primary`
 * S0–S13(+variants) state) for the requested server-owned project — see
 * `UnitySetupProbeResult`'s own doc comment. Rejects on transport failure,
 * a `presence:read`-scope refusal, or the contract's typed project-resolution
 * error; a caller that gets a resolved value always has a real classification
 * to render.
 */
export function fetchUnitySetupProbe(input: {
  readonly projectId: ProjectId;
  readonly httpBaseUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
}): Promise<UnitySetupProbeSuccess> {
  return runtime.runPromise(fetchEffect(input));
}
