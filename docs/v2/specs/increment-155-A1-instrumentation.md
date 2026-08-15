# #155 A1 — instrument the harness /mcp for a decisive live measurement (FROZEN SPEC)

Status: frozen 2026-08-15. Goal: add MINIMAL, redacted server-side logging so
that ONE live agent turn (A2, orchestrator-run) decisively classifies why the
fork's harness `/mcp` tools don't reach in-app agents:
(a) the SERVED McpServer has an empty/short tool list → wiring bug;
(b) it has generate_3d but the client never completes the handshake → protocol/
session bug; (c) some turns no harness connects → injection flakiness.
Repo `/Users/pieroherrera/Projects/t3code-fork`, branch
`workbench/upstream-20260806`. Effect v4. Read
`apps/server/src/mcp/McpHttpServer.ts` + `docs/v2/specs/increment-155-mcp-toolkit-
registration.md` first.

## Scope (IN) — add three redacted INFO logs, all prefixed `[mcp-diag]`

1. **SERVED tool list at build (THE decisive log).** In
   `apps/server/src/mcp/McpHttpServer.ts`, inside the exported `layer(...)`
   composition, merge a startup effect that yields the served `McpServer.McpServer`
   and logs its registered tools — e.g.
   `Effect.logInfo("[mcp-diag] served McpServer tools", { count: server.tools.length, names: server.tools.map(({tool}) => tool.name) })`.
   It MUST read the SAME McpServer instance the HTTP transport serves (merge it
   into the same graph as `McpTransportLive` via the existing `provideMerge`, so
   it resolves the served instance — NOT a fresh `McpServer.McpServer.layer`
   ancestor, which would read a different instance and defeat the purpose). This
   log fires once when the /mcp server builds and tells us definitively whether
   generate_3d + preview tools are on the served instance.
2. **Per-/mcp-request log.** In the /mcp auth middleware
   (`McpAuthMiddlewareLive` / wherever a /mcp request is authenticated in
   McpHttpServer.ts), log each request's method/path + resolved session id +
   auth outcome (ok / rejected + reason). REDACT the bearer token entirely (log
   only its presence + length, never the value). This shows whether the agent's
   `initialize`/`tools/list` requests actually ARRIVE and authenticate.
3. **Injection lifecycle log.** In `apps/server/src/provider/Layers/
   ProviderService.ts` around `issueActiveMcpCredential` /
   `McpProviderSession.setMcpProviderSession` (~line 218) and the clear (~226),
   log `[mcp-diag] mcp session set/clear` with `{ threadId, providerInstanceId,
   endpoint, hasConfig: boolean }`. REDACT the authorization header value
   (log presence+length only). This shows whether the harness config is injected
   for the agent's thread at all (injection flakiness).

## Redaction (non-negotiable)

Never log a bearer/authorization value, the Tripo key, or any secret. Log only
presence + length for credentials. If unsure whether a field is sensitive, log
its presence/type, not its value.

## Scope (OUT)

No behavior change, no fix attempt (A3 does the fix once A2 classifies the
cause). Do not touch the registerToolkit registrations (already committed). No
new logging framework — use the repo's existing `Effect.logInfo`/`logWarning`.

## Acceptance

1. tsgo clean for `apps/server` (ANSI-strip: `pnpm typecheck 2>&1 | perl -pe
   's/\e\[[0-9;]*m//g' | grep -E "error TS[0-9]"` → 0).
2. `pnpm vitest run src/mcp/` green (the existing production-topology test +
   MCP tests still pass — the startup log must not break the layer build).
3. Report: files changed (one line each), the exact log lines added (with the
   `[mcp-diag]` prefix + redaction confirmed), and the tsgo + test output. Do
   NOT commit (orchestrator reviews + commits). Leave the tree dirty.

## Doctrine

Effect v4 idioms. New logs only, minimal footprint. REDACT secrets. /usr/bin/grep
(shell grep is aliased). No git mutations.
