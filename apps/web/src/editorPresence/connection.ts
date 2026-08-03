// Subscriber-side connection state machine for the Editor Presence
// Protocol — framework-free (no React, no direct dependency on the DOM
// `WebSocket` global) so it can be driven directly in tests with a fake
// socket factory. `useEditorPresence.ts` is the thin React wrapper around
// this; keep it that way rather than folding this logic back into the hook.
import type { PreparedHttpAuthorization } from "@t3tools/client-runtime/connection";

import { parseEditorPresenceFrame, type EditorPresenceEntry } from "./protocol";
import { mintEditorPresenceTicket } from "./ticket";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/**
 * Close codes >= 4000 are the application-specific range (RFC 6455 §7.4.2).
 * The server authenticates AFTER accepting the WebSocket upgrade and rejects
 * by closing with a 4xxx code plus a human-readable reason — it never
 * refuses the upgrade with an HTTP 401 (see
 * docs/workbench/godot-probe-findings.md, measured against a real engine: an
 * HTTP-layer refusal and "nothing listening" are indistinguishable to a
 * WebSocket client, so the server deliberately always completes the
 * handshake before it can say why it's rejecting the connection).
 *
 * Ratified rule for every client (web included): code >= 4000 means the
 * server told us why — show that reason verbatim, and do NOT reconnect (a
 * credential problem cannot be fixed by retrying). Anything else means no
 * WebSocket session was ever established — a plain reachability problem,
 * not a credential one — so show a fixed "cannot reach" message and keep
 * backing off.
 */
const APPLICATION_CLOSE_CODE_THRESHOLD = 4000;
const WS_TICKET_QUERY_PARAM = "wsTicket";
const WS_ROLE_QUERY_PARAM = "role";
const EDITOR_PRESENCE_PATH = "/editor-presence";

export type EditorPresenceConnectionPhase = "disconnected" | "connecting" | "connected";

export interface EditorPresenceConnectionState {
  readonly phase: EditorPresenceConnectionPhase;
  readonly editors: ReadonlyArray<EditorPresenceEntry>;
  /**
   * What to tell the user instead of a generic "disconnected": the
   * server's own verbatim reason for an application-level close (code
   * >= 4000, and retrying has stopped), or a fixed "cannot reach Workbench"
   * message when no session was ever established (still retrying). Cleared
   * on a successful open and on a message; only meaningful while
   * disconnected/reconnecting.
   */
  readonly disconnectReason: string | null;
}

export const EDITOR_PRESENCE_EMPTY_STATE: EditorPresenceConnectionState = {
  phase: "disconnected",
  editors: [],
  disconnectReason: null,
};

/**
 * Minimal WebSocket surface this module depends on. Small enough to hand a
 * test double, wide enough that a real browser `WebSocket` satisfies it
 * unmodified (see `createSocket`'s default below).
 */
export interface EditorPresenceSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
  close(): void;
}

export type EditorPresenceSocketFactory = (url: string) => EditorPresenceSocketLike;
export type EditorPresenceTicketMinter = (
  httpBaseUrl: string,
  auth: PreparedHttpAuthorization | null,
) => Promise<string | null>;

export interface EditorPresenceConnectionConfig {
  readonly httpBaseUrl: string;
  /** A `ws:`/`wss:` URL — only its origin is used; the path and query are
   * this module's own (see `buildSubscriberUrl`). Reusing any ticket
   * embedded in it is exactly the bug `ticket.ts` documents, so it is
   * deliberately not read here. */
  readonly socketUrl: string;
  readonly httpAuthorization: PreparedHttpAuthorization | null;
  readonly onStateChange: (state: EditorPresenceConnectionState) => void;
  /** Defaults to the real `WebSocket` global; overridable for tests. */
  readonly createSocket?: EditorPresenceSocketFactory;
  /** Defaults to `mintEditorPresenceTicket`; overridable for tests so the
   * state machine can be exercised without the app's Effect runtime. */
  readonly mintTicket?: EditorPresenceTicketMinter;
}

function defaultCreateSocket(url: string): EditorPresenceSocketLike {
  return new WebSocket(url) as unknown as EditorPresenceSocketLike;
}

function buildSubscriberUrl(socketUrl: string, ticket: string | null): string {
  const origin = new URL(socketUrl).origin;
  const url = new URL(EDITOR_PRESENCE_PATH, origin);
  url.searchParams.set(WS_ROLE_QUERY_PARAM, "subscriber");
  if (ticket) url.searchParams.set(WS_TICKET_QUERY_PARAM, ticket);
  return url.toString();
}

function cannotReachMessage(httpBaseUrl: string): string {
  return `cannot reach Workbench at ${httpBaseUrl}`;
}

/**
 * Opens one subscriber connection, and — unless the server rejected it with
 * an application-level close (code >= 4000, not retried; see
 * `APPLICATION_CLOSE_CODE_THRESHOLD` above) — reopens it with backoff on
 * every close. Every state transition — connecting, connected, a new
 * `presence` frame, disconnected — is reported to `onStateChange`. Returns
 * a `dispose()` that tears the connection down and suppresses any further
 * callbacks, safe to call unconditionally from a React effect cleanup
 * (including before the in-flight ticket mint or the socket has even
 * opened).
 */
export function openEditorPresenceConnection(config: EditorPresenceConnectionConfig): {
  readonly dispose: () => void;
} {
  const createSocket = config.createSocket ?? defaultCreateSocket;
  const mintTicket = config.mintTicket ?? mintEditorPresenceTicket;

  let disposed = false;
  let socket: EditorPresenceSocketLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const emit = (state: EditorPresenceConnectionState) => {
    if (!disposed) config.onStateChange(state);
  };

  const scheduleReconnect = () => {
    if (disposed) return;
    attempt += 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(connect, delay);
  };

  const connect = () => {
    if (disposed) return;
    emit({ phase: "connecting", editors: [], disconnectReason: null });

    mintTicket(config.httpBaseUrl, config.httpAuthorization)
      .then((ticket) => {
        if (disposed) return;
        const ws = createSocket(buildSubscriberUrl(config.socketUrl, ticket));
        socket = ws;

        ws.onopen = () => {
          if (disposed) return;
          attempt = 0;
          emit({ phase: "connected", editors: [], disconnectReason: null });
        };

        ws.onmessage = (event) => {
          if (disposed || typeof event.data !== "string") return;
          const frame = parseEditorPresenceFrame(event.data);
          if (!frame) return;
          // Full replace, never a merge — a `presence` frame is a level,
          // not an edge (see apps/server/src/editorPresence/protocol.ts).
          emit({ phase: "connected", editors: frame.editors, disconnectReason: null });
        };

        ws.onerror = () => {
          // The close handler owns reconnect scheduling; a WebSocket error
          // is always followed by a close event.
        };

        ws.onclose = (event) => {
          if (disposed) return;
          if (event.code >= APPLICATION_CLOSE_CODE_THRESHOLD) {
            // The server told us why, and a credential problem cannot be
            // fixed by retrying — stop, rather than hammering a reconnect
            // that will fail the same way again.
            emit({ phase: "disconnected", editors: [], disconnectReason: event.reason });
            return;
          }
          // No WebSocket session was ever meaningfully established — a
          // rejected handshake and a dead port are indistinguishable to a
          // browser client, both surfacing as an early, reasonless close.
          // A plain reachability problem, not a credential one, so keep
          // retrying.
          emit({
            phase: "disconnected",
            editors: [],
            disconnectReason: cannotReachMessage(config.httpBaseUrl),
          });
          scheduleReconnect();
        };
      })
      .catch(() => {
        if (disposed) return;
        emit({
          phase: "disconnected",
          editors: [],
          disconnectReason: cannotReachMessage(config.httpBaseUrl),
        });
        scheduleReconnect();
      });
  };

  connect();

  return {
    dispose: () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      }
    },
  };
}
