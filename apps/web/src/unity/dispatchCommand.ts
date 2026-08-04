// Posts a real HTTP request to `POST /unity/command`
// (`apps/server/src/unity/UnityCommandRoute.ts`'s `unityCommandRouteLayer`)
// — the toolbar's (#52) path for driving Unity's Play/Stop/Pause via the
// server-side `com.unity.pipeline` CLI shell-out. Unity never goes through
// Editor Presence — no publisher, no session id, no presence WebSocket — so
// this is deliberately a SEPARATE file from `editorPresence/dispatchCommand.ts`,
// not a shared one with an engine switch inside it, mirroring
// `packages/contracts/src/unity.ts`'s own "same overall shape, different
// contents, kept as its own file" choice.
//
// Modeled closely on `editorPresence/dispatchCommand.ts` — same
// `buildEnvironmentAuthHeaders`/`withEnvironmentCredentials` plumbing, same
// `runtime.runPromise` boundary — the two differ only in path, input shape,
// and (critically) in what a caller does with the result: Unity's
// `UnityCommandResult` is a four-tag union (`ok` / `notReady` /
// `cliUnavailable` / `error`), not a two-tag `{ok:boolean}` — see that
// type's own doc comment for why collapsing it would be wrong.
import {
  UNITY_COMMAND_PATH,
  type UnityCommandAction,
  type UnityCommandResult,
} from "@t3tools/contracts";
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

function dispatchEffect(input: {
  readonly httpBaseUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
  readonly workspaceRoot: string;
  readonly action: UnityCommandAction;
}) {
  const url = environmentEndpointUrl(input.httpBaseUrl, UNITY_COMMAND_PATH);
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
      HttpClientRequest.bodyJsonUnsafe({
        workspaceRoot: input.workspaceRoot,
        action: input.action,
      }),
    );
    const client = yield* HttpClient.HttpClient;
    const response = yield* withEnvironmentCredentials(
      input.httpAuthorization,
      client.execute(request),
    );
    return (yield* response.json) as UnityCommandResult;
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

/**
 * Sends one Play/Stop/Pause command (or a `"status"` read) and resolves
 * with the server's four-tag outcome. `notReady` ("no Editor open for this
 * project, or mid domain-reload") and `cliUnavailable` ("the `unity` CLI
 * isn't installed") are NOT errors to fold together — a caller must render
 * them as the different problems they are, per `UnityCommandResult`'s own
 * non-negotiable contract comment. `ok` carries the confirmed
 * `UnityEditorStatus` read back AFTER the action (Unity's own
 * `UnityPipelineClient` re-reads status before returning), so a caller
 * never needs to separately poll to know the resulting play state.
 *
 * Rejects (a plain thrown value) on a transport-level failure only — no
 * response at all, an unparseable body — as distinct from any of the four
 * well-formed tags the server can send back.
 */
export function dispatchUnityCommand(input: {
  readonly httpBaseUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
  readonly workspaceRoot: string;
  readonly action: UnityCommandAction;
}): Promise<UnityCommandResult> {
  return runtime.runPromise(dispatchEffect(input));
}
