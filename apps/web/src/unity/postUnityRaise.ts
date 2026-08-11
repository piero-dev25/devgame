import {
  type ProjectId,
  type UnityRaiseResult,
  UNITY_RAISE_PATH,
  UnityRaiseResult as UnityRaiseResultSchema,
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

const decodeUnityRaiseResult = Schema.decodeUnknownEffect(UnityRaiseResultSchema);

function postEffect(input: {
  readonly projectId: ProjectId;
  readonly httpBaseUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
}) {
  const url = environmentEndpointUrl(input.httpBaseUrl, UNITY_RAISE_PATH);
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
    if (response.status === 403) {
      throw new Error("Forbidden: insufficient scope");
    }
    return yield* decodeUnityRaiseResult(yield* response.json);
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

export function postUnityRaise(input: {
  readonly projectId: ProjectId;
  readonly httpBaseUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
}): Promise<UnityRaiseResult> {
  return runtime.runPromise(postEffect(input));
}

export interface UnityRaiseFailureReport {
  readonly type: "error";
  readonly title: string;
  readonly description: string;
}

/** Successful raise/launch outcomes intentionally produce no toast. */
export function describeUnityRaiseFailure(
  result: UnityRaiseResult,
): UnityRaiseFailureReport | null {
  return result._tag === "error"
    ? {
        type: "error",
        title: "Could not bring Unity to the front",
        description: result.message,
      }
    : null;
}
