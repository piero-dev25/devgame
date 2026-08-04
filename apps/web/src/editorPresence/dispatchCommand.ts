// Posts a real HTTP request to `POST /editor-presence/command`
// (`apps/server/src/editorPresence/EditorPresenceRoute.ts`'s
// `editorPresenceCommandRouteLayer`) — the toolbar's (#52) one and only
// path for sending a Play/Stop/Pause/Step command to a Godot-class,
// Editor-Presence-backed engine. Unity and three.js never call this; see
// `EngineToolbar.logic.ts`'s `EngineDispatchBackend` doc comment for why.
//
// Modeled closely on `ticket.ts`'s `mintEditorPresenceTicket` — the other
// raw (non-HttpApi-client) authenticated call this same feature already
// makes — rather than the typed `HttpApiClient` pattern `auth.ts` uses:
// this route is deliberately outside that system, matching the WS route it
// sits beside (see `EditorPresenceRoute.ts`'s own module doc for why).
import {
  EDITOR_PRESENCE_DISPATCH_COMMAND_PATH,
  type EditorPresenceDispatchCommandResult,
} from "@t3tools/contracts";
import type { PreparedHttpAuthorization } from "@t3tools/client-runtime/connection";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  buildEnvironmentAuthHeaders,
  withEnvironmentCredentials,
} from "@t3tools/client-runtime/state/environmentHttpAuth";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { runtime } from "../lib/runtime";

function dispatchEffect(input: {
  readonly httpBaseUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
  readonly sessionId: string;
  readonly action: string;
  readonly params?: Record<string, unknown>;
}) {
  const url = environmentEndpointUrl(input.httpBaseUrl, EDITOR_PRESENCE_DISPATCH_COMMAND_PATH);
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
        sessionId: input.sessionId,
        action: input.action,
        ...(input.params ? { params: input.params } : {}),
      }),
    );
    const client = yield* HttpClient.HttpClient;
    const response = yield* withEnvironmentCredentials(
      input.httpAuthorization,
      client.execute(request),
    );
    return (yield* response.json) as EditorPresenceDispatchCommandResult;
  }).pipe(Effect.provide(FetchHttpClient.layer));
}

/**
 * Sends one Play/Stop/Pause/Step command and resolves with the server's
 * outcome — `{ok:true}` means the command reached a plugin that understood
 * it, NEVER that the engine is now playing; see spec-unity-play-stop.md's
 * "acceptance is an edge, play state is a level" ruling. The toolbar's
 * button state is driven by presence (`playState`), never by this
 * function's return value, for exactly that reason.
 *
 * Rejects (a plain thrown value, not `EditorPresenceDispatchCommandResult`)
 * on a transport-level failure — no response at all, an unparseable body —
 * as distinct from a well-formed `{ok:false, error}` the server explicitly
 * sent back. A caller should treat a rejection as "couldn't reach the
 * server," not as a specific engine-side rejection reason.
 */
export function dispatchEditorPresenceCommand(input: {
  readonly httpBaseUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
  readonly sessionId: string;
  readonly action: string;
  readonly params?: Record<string, unknown>;
}): Promise<EditorPresenceDispatchCommandResult> {
  return runtime.runPromise(dispatchEffect(input));
}
