/**
 * Backend paths the web dev server proxies in single-origin browser dev.
 *
 * Two consumers must agree on this list: the Vite proxy map
 * (apps/web/vite.config.ts) that forwards these to the backend, and the
 * server's dev catch-all (apps/server/src/http.ts) that 404s them instead of
 * redirecting back to Vite. Drift is silent and nasty in both directions — a
 * prefix only Vite knows gets answered with index.html; a prefix only the
 * server knows redirect-loops through the proxy.
 */
export const DEV_PROXIED_PATH_PREFIXES = [
  "/api",
  "/oauth",
  "/.well-known",
  "/ws",
  "/editor-presence",
  "/space-events",
] as const;

/**
 * Of the above, the prefixes that carry a WebSocket upgrade rather than plain
 * HTTP. Vite needs `ws: true` per entry, and getting this wrong does not fail
 * loudly: an upgrade to a proxied-but-not-ws path is ACCEPTED and then never
 * answered. The socket hangs rather than closing.
 *
 * That is worse than a missing prefix. A browser retrying such a connection
 * accumulates hung sockets against the dev origin, and Chrome's pending
 * connection limit is per-profile — so enough of them starve every OTHER
 * socket to that origin, including the app's own `/ws`. One missing entry here
 * presents as "the app cannot reach its own backend", which is nowhere near
 * where anyone would look.
 */
export const DEV_PROXIED_WEBSOCKET_PREFIXES = ["/ws", "/editor-presence", "/space-events"] as const;

export function isDevProxiedWebSocketPath(prefix: string): boolean {
  return (DEV_PROXIED_WEBSOCKET_PREFIXES as readonly string[]).includes(prefix);
}

export function isDevProxiedPath(pathname: string): boolean {
  return DEV_PROXIED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
