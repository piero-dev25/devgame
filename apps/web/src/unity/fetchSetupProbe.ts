// Posts a real HTTP request to `POST /unity/setup-probe`
// (`apps/server/src/unity/UnitySetupProbeRoute.ts`'s `unitySetupProbeRouteLayer`)
// — the read-only "what's missing to make Unity work" check (#92 increment
// 1). Modeled closely on `./dispatchCommand.ts`'s `dispatchUnityCommand`:
// both post through `../lib/forkEnvironmentRoute.ts` (upstream's
// `executeAuthenticatedEnvironmentHttpRequest`) at the same
// `runtime.runPromise` boundary. Kept as its own file rather than added
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
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";

import { postForkEnvironmentRoute } from "../lib/forkEnvironmentRoute";
import { runtime } from "../lib/runtime";

// Pre-composed once at module scope, same convention as
// `connection/storage.ts`'s `decodeConnectionCatalogDocument` and
// `cloud/dpop.ts`'s `decodeDpopPublicJwk` — the response body is `unknown`
// wire data, not something a compile-time cast can vouch for (#100).
const decodeUnitySetupProbeResult = Schema.decodeUnknownEffect(UnitySetupProbeResult);

/** Bounded so a hung connection can never leave a caller's `.then`/`.catch`
 * both un-fired forever — found live (2026-08-04, team-lead +
 * presence-authz) as the second half of the "Checking…" panel bug: an
 * unbounded fetch that never resolves OR rejects is indistinguishable, from
 * the caller's side, from one that's still loading. 20s matches this route's
 * own real observed latency (a live probe run against a real project
 * measured ~200ms; this is generous headroom, not a tight bound tuned to the
 * happy path). Upstream's request helper enforces it as its own timeout. */
const UNITY_SETUP_PROBE_TIMEOUT_MS = 20_000;

export class UnitySetupProbeServerError extends Schema.TaggedError<UnitySetupProbeServerError>()(
  "UnitySetupProbeServerError",
  { message: Schema.String },
) {}

function fetchEffect(input: {
  readonly projectId: ProjectId;
  readonly prepared: PreparedConnection;
}) {
  return Effect.gen(function* () {
    const body = yield* postForkEnvironmentRoute({
      prepared: input.prepared,
      path: UNITY_SETUP_PROBE_PATH,
      body: { projectId: input.projectId },
      timeoutMs: UNITY_SETUP_PROBE_TIMEOUT_MS,
    });
    const result = yield* decodeUnitySetupProbeResult(body);
    if ("_tag" in result) {
      return yield* new UnitySetupProbeServerError({ message: result.message });
    }
    return result;
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

/**
 * Fetches the current classified Unity setup state (`facts` + one `primary`
 * S0–S13(+variants) state) for the requested server-owned project — see
 * `UnitySetupProbeResult`'s own doc comment. Rejects on transport failure,
 * an environment-level refusal (a rejected credential, or the
 * `presence:read`-scope 403), a timeout, or the contract's typed
 * project-resolution error; a caller that gets a resolved value always has a
 * real classification to render.
 */
export function fetchUnitySetupProbe(input: {
  readonly projectId: ProjectId;
  readonly prepared: PreparedConnection;
}): Promise<UnitySetupProbeSuccess> {
  return runtime.runPromise(fetchEffect(input));
}
