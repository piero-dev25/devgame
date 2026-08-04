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
import { UNITY_PIPELINE_INSTALL_PATH, type UnityPipelineInstallResult } from "@t3tools/contracts";
import type { PreparedHttpAuthorization } from "@t3tools/client-runtime/connection";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  buildEnvironmentAuthHeaders,
  withEnvironmentCredentials,
} from "@t3tools/client-runtime/state/environmentHttpAuth";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { runtime } from "../lib/runtime";

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
    return (yield* response.json) as UnityPipelineInstallResult;
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

/**
 * Fires the consented `unity pipeline install` for THIS server process's
 * own project (`ServerConfig.cwd` server-side — see
 * `UnityPipelineInstallInput`'s own doc comment). The caller
 * (`ConnectionsSettings.tsx`) is responsible for only ever calling this
 * from inside an explicit consent-dialog confirm handler — there is no
 * server-side "did the user consent" flag for this function to check; the
 * click IS the consent. Rejects (a plain thrown value) on a transport-level
 * failure or a `presence:command`-scope refusal (HTTP 403) only — a
 * resolved value always has a real `UnityPipelineInstallResult` to render,
 * same posture `fetchUnitySetupProbe` documents for its own 403 case.
 */
export function postUnityPipelineInstall(input: {
  readonly httpBaseUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
}): Promise<UnityPipelineInstallResult> {
  return runtime.runPromise(postEffect(input));
}
