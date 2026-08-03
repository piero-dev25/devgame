// Mints a fresh, single-use WebSocket ticket for the Editor Presence
// subscriber connection.
//
// `PreparedConnection.socketUrl` (apps/web/src/state/session.ts) already has
// a ticket baked in for authenticated connections, but that ticket
// authenticates the app's own primary RPC socket and is single-use to open
// — consumed the instant that socket opens (see the 5-minute-TTL,
// single-use-to-open note on `issueRemoteWebSocketTicket` in
// packages/client-runtime/src/authorization/remote.ts). Reusing it here
// would race the primary socket for the same ticket and fail on every
// reconnect, so every editor-presence connect attempt (including
// reconnects) mints its own via the same `/api/auth/websocket-ticket`
// endpoint the primary socket uses — no refresh timer, just mint-per-connect.
import {
  issueRemoteDpopWebSocketTicket,
  issueRemoteWebSocketTicket,
} from "@t3tools/client-runtime/authorization";
import type { PreparedHttpAuthorization } from "@t3tools/client-runtime/connection";
import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";

import { runtime } from "../lib/runtime";

const WEBSOCKET_TICKET_PATH = "/api/auth/websocket-ticket";

function mintTicketEffect(httpBaseUrl: string, auth: PreparedHttpAuthorization) {
  if (auth._tag === "Bearer") {
    return issueRemoteWebSocketTicket({ httpBaseUrl, bearerToken: auth.token }).pipe(
      Effect.map((issued) => issued.ticket),
    );
  }
  // DPoP (relay/cloud connections): the ticket endpoint is itself DPoP-bound,
  // so minting a ticket first requires a fresh proof over that endpoint —
  // the same two-step the app's own primary socket performs in
  // packages/client-runtime/src/authorization/service.ts's
  // `createDpopSocketUrl`.
  return Effect.gen(function* () {
    const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
    const dpopProof = yield* signer.createProof({
      method: "POST",
      url: environmentEndpointUrl(httpBaseUrl, WEBSOCKET_TICKET_PATH),
      accessToken: auth.accessToken,
    });
    const issued = yield* issueRemoteDpopWebSocketTicket({
      httpBaseUrl,
      accessToken: auth.accessToken,
      dpopProof,
    });
    return issued.ticket;
  });
}

/**
 * Resolves the ws ticket to attach to the subscriber connection URL, or
 * `null` when the connection is unauthenticated (the local, no-auth dev
 * path this machine runs) — no ticket should be minted there; connect
 * plain, exactly like the app's own primary socket does for the same
 * connection.
 */
export function mintEditorPresenceTicket(
  httpBaseUrl: string,
  auth: PreparedHttpAuthorization | null,
): Promise<string | null> {
  if (auth === null) return Promise.resolve(null);
  return runtime.runPromise(mintTicketEffect(httpBaseUrl, auth));
}
