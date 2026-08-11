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
 * by closing with a 4xxx code plus a human-readable reason.
 *
 * This comment used to assert the server "never refuses the upgrade with an
 * HTTP 401." That was false for this route's subscriber path from the day it
 * shipped until task #57 — the credential check ran pre-upgrade and answered
 * a real HTTP 401, which is invisible here. It is true NOW because that
 * check was moved, not because it was ever true.
 *
 * Why the server has to complete the handshake before it can say why it is
 * rejecting: an HTTP-layer refusal and "nothing listening" are the same
 * event to a WebSocket client. Measured in a real Chrome against the real
 * route — a 401-refused upgrade and a dead port BOTH arrive here as
 * `code 1006`, `reason ""`, `wasClean false`, while an accepted-then-closed
 * rejection arrives as `code 4400`, `reason "missing_credential"`. Same
 * finding as docs/workbench/godot-probe-findings.md measured against a real
 * engine.
 *
 * The practical consequence, and why `classifyEditorPresenceClose` below
 * cannot fix this on its own: 1006 is not in the application range, so it
 * classifies as `no-session` and keeps retrying. That is correct for a dead
 * port and wrong for a permanent credential failure — and from here the two
 * are indistinguishable. Only the server can tell them apart, which is why
 * the fix was server-side.
 */
const APPLICATION_CLOSE_CODE_THRESHOLD = 4000;
/**
 * Close codes the server uses for a *definitive credential rejection* —
 * retrying opens the exact same rejected (or still-missing) token, so it
 * cannot self-heal. Named explicitly, not expressed as a numeric range: a
 * threshold ("code >= 4000 means stop") is exactly what this collapsed back
 * into the first time it was tried, and it was wrong — 4500 (the server's
 * own internal fault) is also >= 4000 but is transient by definition, and
 * belongs with "keep retrying," not with these two. See
 * docs/workbench/godot-probe-findings.md's "Correction: '>= 4000 means stop
 * retrying' was too coarse".
 */
const CREDENTIAL_REJECTION_CLOSE_CODE = {
  missingCredential: 4400,
  invalidCredential: 4401,
} as const;
const CREDENTIAL_REJECTION_CLOSE_CODES: ReadonlySet<number> = new Set(
  Object.values(CREDENTIAL_REJECTION_CLOSE_CODE),
);
/**
 * Ratified rule for every client (web included), credential-class versus
 * everything else:
 * - a credential-rejection code (4400/4401) -> the server told us why; show
 *   that reason verbatim, and do NOT reconnect.
 * - any other application close (4500, or a future code this build doesn't
 *   recognize yet) -> also show the reason verbatim, but an unrecognized or
 *   server-side failure is presumed transient, not the user's fault, so
 *   keep retrying — on the ordinary backoff curve, not an escalated one;
 *   this is still one of exactly two retry behaviors, not three.
 * - anything below the application range (an opaque close, a dead port, a
 *   ticket-mint failure) -> no WebSocket session was ever established, so
 *   show a fixed "cannot reach" message instead of the (nonexistent or
 *   meaningless) close reason, and keep retrying.
 */
type EditorPresenceCloseClassification = "credential-rejected" | "application-other" | "no-session";

function classifyEditorPresenceClose(code: number): EditorPresenceCloseClassification {
  if (CREDENTIAL_REJECTION_CLOSE_CODES.has(code)) return "credential-rejected";
  if (code >= APPLICATION_CLOSE_CODE_THRESHOLD) return "application-other";
  return "no-session";
}
const WS_TICKET_QUERY_PARAM = "wsTicket";
const WS_ROLE_QUERY_PARAM = "role";
const EDITOR_PRESENCE_PATH = "/editor-presence";

export type EditorPresenceConnectionPhase = "disconnected" | "connecting" | "connected";

export interface EditorPresenceConnectionState {
  readonly phase: EditorPresenceConnectionPhase;
  readonly editors: ReadonlyArray<EditorPresenceEntry>;
  /**
   * What to tell the user instead of a generic "disconnected": the
   * server's own verbatim reason for any application-level close (a
   * credential rejection, retrying has stopped; anything else, still
   * retrying), or a fixed "cannot reach Workbench" message when no session
   * was ever established (still retrying). See
   * `classifyEditorPresenceClose` for the exact classification. Cleared on
   * a successful open and on a message; only meaningful while
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
 * a credential-class close (see `classifyEditorPresenceClose` above, not
 * retried) — reopens it with backoff on every close. Every state
 * transition — connecting, connected, a new `presence` frame,
 * disconnected — is reported to `onStateChange`. Returns a `dispose()`
 * that tears the connection down and suppresses any further callbacks,
 * safe to call unconditionally from a React effect cleanup (including
 * before the in-flight ticket mint or the socket has even opened).
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
          const classification = classifyEditorPresenceClose(event.code);
          if (classification === "credential-rejected") {
            // Retrying opens the exact same rejected (or still-missing)
            // token — stop, rather than hammering a reconnect that will
            // fail the same way again.
            emit({ phase: "disconnected", editors: [], disconnectReason: event.reason });
            return;
          }
          if (classification === "application-other") {
            // The server told us why, but it's an application close that
            // isn't a credential rejection — its own internal fault, or a
            // future code this build doesn't recognize — presumed
            // transient rather than the user's fault, so it keeps
            // retrying, on the ordinary backoff curve.
            emit({ phase: "disconnected", editors: [], disconnectReason: event.reason });
            scheduleReconnect();
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
