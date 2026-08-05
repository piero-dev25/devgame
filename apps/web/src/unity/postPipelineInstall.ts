// Posts a real HTTP request to `POST /unity/pipeline-install`
// (`apps/server/src/unity/UnityPipelineInstallRoute.ts`'s
// `unityPipelineInstallRouteLayer`) — plan §5's increment 4a, the consented
// `unity pipeline install`. Modeled closely on `./fetchSetupProbe.ts`: same
// `buildEnvironmentAuthHeaders`/`withEnvironmentCredentials` plumbing, same
// `runtime.runPromise` boundary, same empty-body convention (the project is
// server-resolved, never caller-supplied — see
// `UnityPipelineInstallInput`'s own doc comment). Kept as its own file for
// the same reason `fetchSetupProbe.ts` is: this call has nothing in common
// with the read-only probe beyond the transport, and it is the one call in
// this whole feature that WRITES to the user's project — worth being able
// to find, read, and reason about on its own.
import { UNITY_PIPELINE_INSTALL_PATH, UnityPipelineInstallResult } from "@t3tools/contracts";
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

// Pre-composed once at module scope — same convention as
// `fetchSetupProbe.ts`'s `decodeUnitySetupProbeResult` (#99).
const decodeUnityPipelineInstallResult = Schema.decodeUnknownEffect(UnityPipelineInstallResult);

function postEffect(input: {
  readonly httpBaseUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
}) {
  const url = environmentEndpointUrl(input.httpBaseUrl, UNITY_PIPELINE_INSTALL_PATH);
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
      // Deliberately empty body — `UnityPipelineInstallInput` is
      // `Schema.Struct({})`. There is nothing for a caller to supply; see
      // that schema's own doc comment.
      HttpClientRequest.bodyJsonUnsafe({}),
    );
    const client = yield* HttpClient.HttpClient;
    const response = yield* withEnvironmentCredentials(
      input.httpAuthorization,
      client.execute(request),
    );
    if (response.status === 403) {
      throw new Error("Forbidden: insufficient scope");
    }
    return yield* decodeUnityPipelineInstallResult(yield* response.json);
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

/**
 * Fires the consented `unity pipeline install` for THIS server process's
 * own project (`ServerConfig.cwd` server-side — see
 * `UnityPipelineInstallInput`'s own doc comment). There is no server-side
 * "did the user consent" flag for this function to check — every caller is
 * responsible for treating its own click as the consent, by construction.
 * Two callers today, two different but equally valid consent shapes:
 * `ConnectionsSettings.tsx`'s `UnityPipelineInstallButton` gates this behind
 * an explicit confirm-dialog click; `EngineToolbar.tsx`'s `Setup Unity
 * Integrations` CTA (owner ruling: the click IS the consent, no dialog) goes
 * straight from a single header click to this call, via
 * `ChatView.tsx`'s `handleSetupUnityIntegrations`. Rejects (a plain thrown
 * value) on a transport-level failure or a `presence:command`-scope refusal
 * (HTTP 403) only — a resolved value always has a real
 * `UnityPipelineInstallResult` to render, same posture `fetchUnitySetupProbe`
 * documents for its own 403 case.
 */
export function postUnityPipelineInstall(input: {
  readonly httpBaseUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
}): Promise<UnityPipelineInstallResult> {
  return runtime.runPromise(postEffect(input));
}
