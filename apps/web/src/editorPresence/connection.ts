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
 * The server uses it for reasons worth surfacing to the user verbatim (auth
 * rejected, scope missing) rather than a generic "disconnected", and for
 * not hammering a reconnect that is likely to fail the same way again. A
 * plain transport-level close (browser default on a dropped connection —
 * code < 4000, empty reason) is treated as transient and retried on the
 * normal backoff.
 */
const APPLICATION_CLOSE_CODE_THRESHOLD = 4000;
/** On an application-level close, jump the attempt counter forward so the
 * next retry starts closer to the backoff ceiling instead of the fast base
 * delay — "don't hammer-reconnect on an auth rejection" without giving up
 * on reconnecting altogether (the rejection could be transient, e.g. a
 * revoked session that gets re-granted). */
const APPLICATION_CLOSE_ATTEMPT_FLOOR = 3;
const WS_TICKET_QUERY_PARAM = "wsTicket";
const WS_ROLE_QUERY_PARAM = "role";
const EDITOR_PRESENCE_PATH = "/editor-presence";

export type EditorPresenceConnectionPhase = "disconnected" | "connecting" | "connected";

export interface EditorPresenceConnectionState {
  readonly phase: EditorPresenceConnectionPhase;
  readonly editors: ReadonlyArray<EditorPresenceEntry>;
  /** Verbatim reason from the most recent close that carried one. Cleared
   * on a successful open and on a message; only meaningful while
   * disconnected/reconnecting. */
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

/**
 * Opens (and, on close, reopens with backoff) one subscriber connection.
 * Every state transition — connecting, connected, a new `presence` frame,
 * disconnected — is reported to `onStateChange`. Returns a `dispose()` that
 * tears the connection down and suppresses any further callbacks, safe to
 * call unconditionally from a React effect cleanup (including before the
 * in-flight ticket mint or the socket has even opened).
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

  const scheduleReconnect = (escalate: boolean) => {
    if (disposed) return;
    attempt = escalate ? Math.max(attempt + 1, APPLICATION_CLOSE_ATTEMPT_FLOOR) : attempt + 1;
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
          const reason = event.reason.trim().length > 0 ? event.reason : null;
          emit({ phase: "disconnected", editors: [], disconnectReason: reason });
          scheduleReconnect(event.code >= APPLICATION_CLOSE_CODE_THRESHOLD);
        };
      })
      .catch(() => {
        if (disposed) return;
        emit({ phase: "disconnected", editors: [], disconnectReason: null });
        scheduleReconnect(false);
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
