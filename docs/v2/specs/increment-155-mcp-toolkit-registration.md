# Increment #155 — fix + guard: harness /mcp must expose its tools to agents (FROZEN SPEC)

Status: frozen 2026-08-15. A partial fix is ALREADY COMMITTED (8681e57b1) — your
job is to VERIFY it with a production-topology test, apply the deeper fix if the
test reveals one, and leave a permanent guard. Repo:
`/Users/pieroherrera/Projects/t3code-fork`, branch `workbench/upstream-20260806`.

## The bug (root-caused, confirmed at effect source)

The fork's harness `/mcp` HTTP server (`apps/server/src/mcp/McpHttpServer.ts`)
connects + authenticates for agents but serves an EMPTY tools/list — so NO
harness tool (preview OR generation, incl `generate_3d`) reaches any in-app
agent. Cause: effect's `McpServer.toolkit(x)` (node_modules effect
`McpServer.js:951`) is `Layer.effectDiscard(registerToolkit(x)).pipe(Layer.
provide(McpServer.layer))` — it SELF-PROVIDES its own `McpServer.layer`, so
declarative toolkit registrations register into a THROWAWAY McpServer instance,
not the one `McpServer.layerHttp` (McpTransportLive) builds and serves.

The committed partial fix (8681e57b1) already changed the two declarative
registrations (`PreviewStandardToolkitRegistrationLive`,
`GenerationStandardToolkitRegistrationLive`) from `McpServer.toolkit(X)` to
`Layer.effectDiscard(McpServer.registerToolkit(X))` (leaves `McpServer` an OUTER
requirement, discharged from the transport's served instance via the existing
`Layer.provideMerge(McpTransportLive)` at the bottom of `layer`).

## Why the existing test did NOT catch it (critical — do not repeat)

`McpHttpServer.test.ts` asserts `server.tools` includes preview\_\* BUT builds an
ANCESTOR-McpServer topology: `Layer.provideMerge(McpServer.McpServer.layer)` with
the SAME `McpServer.layer` reference the `toolkit` helper self-provides →
Effect memoizes them to ONE instance → tools appear. That is NOT the production
topology. In production, `McpTransportLive` = `McpServer.layerHttp(...)` builds
its served McpServer via `layerWithProtocolState` — a DIFFERENT construction from
the bare `McpServer.layer` — so the self-provided instance ≠ the served instance
→ empty. The guard MUST use the real `McpHttpServer.layer` (which uses
`McpTransportLive`), not a bare `McpServer.McpServer.layer` ancestor.

## Scope (IN)

1. **Production-topology test** (new test in `apps/server/src/mcp/McpHttpServer.
test.ts` or a sibling): build the REAL exported `McpHttpServer.layer(
fakeGenerationServiceLive)` (the same function server.ts calls), provide its
   real dependencies (see below), then read the SERVED McpServer and assert its
   tool list includes ALL of: `generate_3d`, `generation_status`,
   `list_generations`, `import_generated_asset`, `inspect_generation`,
   `preview_status`, `preview_snapshot`. Preferred mechanism: after
   `Effect.provide(McpHttpServer.layer(fakeGen).pipe(<deps>))`, do
   `const server = yield* McpServer.McpServer; const names = server.tools.map(
({tool}) => tool.name)` and assert `expect(names).toEqual(expect.array
containing([...]))`. Reuse the existing test file's fakes
   (`fakeGenerationService`, `fakeProjectionSnapshotQuery`, the
   PreviewAutomationBroker test layer, HttpClient.make stub, McpSessionRegistry/
   auth test layers) — grep the file, they're all already there for the other
   tests. If `McpHttpServer.layer`'s `McpTransportLive` requires an HTTP server
   binding to BUILD, provide `NodeHttpServer.layerTest` (the DELETE-session test
   at line ~169 shows the pattern). Do NOT drive real HTTP/auth if reading
   `McpServer.McpServer.tools` from the built layer suffices.
2. **Red-prove it**: temporarily revert ONE registration to `McpServer.toolkit`
   (the pre-fix form), run the new test, CONFIRM it FAILS (served tool list is
   missing that toolkit's tools), then restore. Paste both outputs. If the test
   does NOT go red on revert, the test is not exercising the production topology
   — fix the test (it's probably falling into the ancestor-McpServer false-green;
   ensure it uses McpHttpServer.layer/McpTransportLive, not a bare McpServer
   ancestor).
3. **If the committed fix is INSUFFICIENT** (test still RED even with
   registerToolkit): apply the ancestor-provide variant — ensure ONE McpServer
   instance is shared across `McpTransportLive` AND all registrations. Mirror the
   proven ancestor-provide pattern used for the shared GenerationService (server.
   ts) and 2b.1: build/hoist a single McpServer and `Layer.provide` it as a true
   ancestor wrapping both the merged toolkits and the transport, so
   `registerToolkit`'s outer-McpServer requirement resolves to the served
   instance deterministically. Keep the change minimal + commented.

## Scope (OUT)

The per-turn harness-connection FLAKINESS (agent turns where NO harness server
connects at all, even unity-mcp) is a SEPARATE runtime issue — note it, do not
chase it here. No live desktop/agent E2E (the orchestrator runs that).

## Acceptance

1. The new production-topology test PASSES with the current committed fix (or
   with your ancestor-provide addition), and PROVABLY goes RED when a
   registration is reverted to `McpServer.toolkit` (paste both).
2. tsgo clean for `apps/server` (ANSI-strip: `pnpm typecheck 2>&1 | perl -pe
's/\e\[[0-9;]*m//g' | grep -E "error TS[0-9]"` → 0). Full `pnpm vitest run
src/mcp/` green; ideally full server suite green.
3. Report: the exact new test + its pass output; the red-prove output; whether
   the committed registerToolkit fix was sufficient or you needed the
   ancestor-provide (and what you added); files changed. Do NOT commit (the
   orchestrator commits after review). Leave the tree dirty.

## Doctrine

Effect v4 idioms. New test mirrors the existing McpHttpServer.test.ts patterns

- fakes. The test's whole point is to exercise the PRODUCTION provideMerge(
  layerHttp) topology — if it can't go red, it's worthless. /usr/bin/grep. No git
  mutations.
