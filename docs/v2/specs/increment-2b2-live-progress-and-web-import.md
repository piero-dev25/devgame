# Increment 2b.2 — live generation progress + one-click "Import to Unity" from the web (FROZEN SPEC — DESIGN, pre-implementation)

Status: DESIGN drafted 2026-08-15, **ahead of the A4/B gate**, then hardened by a
grounded critic pass (all 5 load-bearing seam/security claims confirmed; 9
findings folded in below). Do NOT implement until Gate A (#155 live) and Gate B
(2b.1 visual E2E) are closed — this is a ready-to-greenlight design, not a work
order to start now. Repo `/Users/pieroherrera/Projects/t3code-fork`, branch
`workbench/upstream-20260806`. All file:line refs verified at HEAD 374d3ed2b.

## Objective

Two user-visible upgrades to the read-only Generation dock panel (2b.1):
- **A. Live progress** — replace the 5s poll with server-pushed job updates so
  running→succeeded (+ progress %) appear immediately.
- **B. One-click import** — an "Import to Unity" button on a succeeded row that
  triggers `import_generated_asset` from the WEB (today import is only reachable
  as an MCP tool inside an agent thread), landing a textured asset in the
  project's Unity editor.

Both mirror shipping precedents. There are **THREE** edits to files prior
increments treated as frozen (Part A publish seam; Part A scope-free list core;
Part B import core) — all additive and convention-matching, but call them out for
owner sign-off before implementing.

## Current state (seams — verified, incl. by an independent critic)

- Panel `apps/web/src/dock/GenerationDockPanel.tsx` (singleton) → `generationListAtom`
  (`apps/web/src/generation/generationListAtom.ts`): poll = 5000ms (line 47) via
  `Atom.makeRefreshOnSignal` (152) + refresh-on-focus (153). Fetch
  `fetchGenerationList.ts` → `POST /generation/list`.
- Read route `apps/server/src/generation/GenerationListRoute.ts`: auth =
  `EnvironmentAuth.authenticateHttpRequest` + `session.scopes.includes(
  AuthPresenceReadScope)` inside `dispatchGenerationList` (60-73, scope check at
  71); `projectId` from body; enriched projection incl. signed preview URLs via
  `GenerationAssetAccess.issueGenerationAssetUrl` (113-117); reads the SHARED
  `GenerationService` registry (its "#1 trap": a 2nd `GenerationService.layer()`
  builds an empty parallel registry — sharing is mandatory).
- Live-push server precedent `apps/server/src/spaceEvents/SpaceEventsRoute.ts` +
  `SpaceEventsRegistry.ts`: raw `GET /space-events` WS route via own
  `HttpRouter.add` merged in server.ts:612; authenticate-in-onOpen (201-234);
  close codes 4400/4401/4500 (75-77); Ref fan-out keyed by projectId with
  `hasSubscribers`. **onOpen registers the subscriber THEN immediately sends a
  freshly-queried LEVEL frame (219-233)** — every frame = full current truth, so
  reconnect/interleaving self-heals (no edge-loss). The publish listener lives in
  the ROUTE and re-queries fresh (106-123) — it does NOT build the payload at the
  mutation site.
- Live-push client precedent (proven browser consumer)
  `apps/web/src/editorPresence/connection.ts` + `useEditorPresence.ts`:
  exponential backoff (185-190), close classification `classifyEditorPresenceClose`
  (76-80: 4400/4401 credential → stop; other → keep retrying).
- Import today `apps/server/src/mcp/toolkits/generation/handlers.ts`
  `importGeneratedAsset` (559-735): gated by MCP-only `requireGenerationScope()`;
  `resolveProjectContext(scope.threadId)` (582) is the ONLY threadId/scope use in
  the whole function (grep-confirmed — no hidden thread deps). Unity targeting is
  thread-FREE: `UnityPipelineClient` stateless shell-out keyed by `workspaceRoot`
  from `getProjectShellById(projectId).workspaceRoot` (607). Cross-project guard
  585-591. On a cache-miss it does a live Tripo round-trip in
  `deriveAndCacheImportFiles` (642). Self-contained runtime deps
  `ImportGeneratedAssetRuntimeDependenciesLive` (756-759).
- Web→Unity WRITE precedent (ships) `apps/server/src/unity/UnityCommandRoute.ts`:
  `POST /unity/command` (Play/Stop), gated by `AuthPresenceCommandScope`, dispatch
  → `UnityPipelineClient` directly, zero MCP/thread.

## Part A — live progress push

New (mirror existing files; NO ws.ts/WsRpcGroup edits):
1. `apps/server/src/generation/GenerationProgressRegistry.ts` — copy
   `SpaceEventsRegistry.ts` shape (Ref fan-out keyed by projectId, `hasSubscribers`).
2. `apps/server/src/generation/GenerationProgressRoute.ts` — copy
   `SpaceEventsRoute.ts`: **route path `GET /generation/events?projectId=...`**
   (NESTED under the existing `/generation` dev-proxy prefix — critic HIGH #1: a
   top-level `/generation-events` does NOT match `devProxy.ts`'s prefix test and a
   browser WS upgrade would be accepted-then-never-answered and hang, worse than a
   missing HTTP prefix; nesting inherits proxying automatically, no new
   `devProxy.ts` entry to drift). Authenticate-in-onOpen, 4400/4401/4500, scope
   `AuthPresenceReadScope` (read-only). onOpen sends the enriched LEVEL frame; on
   each broadcast, re-query + send the enriched frame — the ROUTE builds the
   payload, NOT the mutation site.
3. **Publish seam (HARD PART #1 — GenerationService.ts, frozen file):** wrap
   `updateJob` (170-177) ONCE so every write triggers a CHEAP broadcast (critic
   HIGH #3 + MEDIUM #4): broadcast a bare "project X changed" signal (or the raw
   `listJobs()` array) — NOT the enriched projection. Rationale: the enriched
   projection needs `ProjectionSnapshotQuery` + `GenerationAssetAccess`, which
   `GenerationServiceLive` does NOT currently require (138-149) — adding them flows
   into server.ts:628-671's hard-won ancestor `Layer.provide(GenerationServiceLive)`
   (the fix for a 5/5 registry-sharing race). Keep GenerationService's dep set
   unchanged; let the ROUTE enrich (mirrors SpaceEvents exactly). Wrapping the
   function once (not patching call sites) also covers ALL FIVE failure/terminal
   transitions — 189, 206, 227-232, 311-316, AND the `Effect.catchCause` defect
   handler at 328-338 that a "four sites" list would miss.
   **DEBOUNCE (critic MEDIUM #5):** coalesce broadcasts per-project within a short
   window (e.g. 250ms). Progress ticks fire per running job every ~5s
   (GenerationService.ts:98/206), and each enriched re-query iterates ALL historical
   jobs for the project + mints a signed HMAC preview URL per preview-bearing
   asset (stateRef has no eviction) — up to 4 concurrent jobs × every 5s. Debounce
   caps this regardless of history size. (`hasSubscribers` only helps when nobody
   watches — the opposite of the panel-open case.)
4. **Scope-free list core (HARD PART #2 — GenerationListRoute.ts, critic HIGH #3):**
   `dispatchGenerationList(session, projectId)` takes `session` ONLY for the scope
   check (71). A broadcast has no per-call session (already checked once at
   WS-upgrade). Extract a scope-free `buildGenerationListProjection(projectId)`
   core called by BOTH the HTTP dispatch (after its scope check) and the WS route.
   Same "exported directly-testable core" convention as everywhere else.
5. Client `apps/web/src/generation/generationEventsConnection.ts` +
   `useGenerationEvents.ts` — copy `editorPresence/connection.ts` +
   `useEditorPresence.ts` (reconnect/backoff/close-classification). Panel prefers
   the live atom; **keep the 5s poll as a low-cost reconciliation fallback** for
   the WS-down window (level frames self-heal; critic LOW #9 confirms no
   subscribe/reconnect race).

Acceptance A: panel open → an agent-started generation shows running→succeeded
(+progress) with no 5s lag; WS kill → poll fallback; reconnect resumes live frames.

## Part B — one-click "Import to Unity" (ASYNC)

**Import core (HARD PART #3 — handlers.ts, frozen file):** extract
`importGeneratedAssetCore({ projectId, assetId, ...opts })` doing everything
559-735 EXCEPT the MCP gate + `resolveProjectContext(threadId)` — takes
`projectId`/`assetId` directly, re-derives `workspaceRoot` from
`getProjectShellById(projectId)`, keeps the cross-project guard (585-591) verbatim,
reuses the 2a injection-guarded C# write-eval. The MCP handler becomes a thin
caller. (Alternative — duplicate the Unity sequence — rejected.)

**ASYNC, not synchronous (critic HIGH #2 — avoids reproducing OPEN task #147):**
import chains 7 sequential Unity CLI calls (each bounded by
`COMMAND_TIMEOUT_SEC=35s`, UnityPipelineClient.ts:67) + a possible live Tripo
round-trip on cache-miss (~35-70s measured in 2a). A synchronous POST would hit
#147's exact failure class (no client timeout, >35s reads as false "failed").
Instead:
- `apps/server/src/generation/GenerationImportRoute.ts` — `POST /generation/import`
  body `{ projectId, assetId }`, gated by **`AuthPresenceCommandScope`**, returns
  IMMEDIATELY with an import-handle; runs the Unity sequence in a forked fiber
  (mirror `runGeneration`'s `Effect.forkIn(jobScope)`); report started/succeeded/
  failed over the SAME live-push channel Part A builds (extend the generation
  event frame with an `import` status per asset, OR a sibling import registry).
- **In-flight guard (critic LOW #8):** track in-flight imports by `assetId` (like
  GenerationService tracks in-flight generations) so a double-click / retry does
  NOT launch two concurrent imports racing the same
  `${UNITY_IMPORT_ASSET_DIR_PREFIX}/${assetId}` dir (handlers.ts:651). The async
  job-tracking gives this naturally.
- **Runtime deps:** `GenerationImportRoute` builds its OWN self-contained deps
  layer mirroring `ImportGeneratedAssetRuntimeDependenciesLive` (756-759) — safe
  because `UnityPipelineClient` is STATELESS (grep-confirmed: no Ref/Map/cache).
  Do NOT try to share it. (Contrast: `GenerationService` is a stateful singleton
  where sharing is mandatory — the "#1 trap". Critic LOW #7: don't over-apply the
  sharing lesson here.)
- Client: an "Import to Unity" button on succeeded `GenerationRow`s → the POST;
  button shows a spinner from the import-handle status via the live channel; on
  failure surface the error inline.

### Security (the review focus — Opus, per pipeline)
- **Scope: reuse `AuthPresenceCommandScope`** ("presence:command"), the SAME scope
  Play/Stop uses — import is the identical risk class. Do NOT invent a new scope.
- **CRITICAL grant constraint (verified):** `AuthPresenceCommandScope` (auth.ts:102)
  is EXCLUDED from `AuthStandardClientScopes` (173-180); it lives only in
  `AuthDesktopOwnerScopes` (212-215) — minted at desktop bootstrap or delegated via
  Settings > Connections. So Import works in the DESKTOP-OWNER session (which
  already runs Play) but is NOT safely exposable to a remote paired browser session
  (unlike the read route on `presence:read`). UI must degrade gracefully when the
  session lacks the scope (hide/disable, mirror how the EngineToolbar conditions
  Play), NOT 403 loudly.
- **Project binding:** re-derive `workspaceRoot` from `projectId` server-side; the
  client sends only `projectId` + `assetId`, never a path. Keep the cross-project
  `assetId` recheck (585-591).
- **Injection:** reuse 2a's injection-guarded `buildMaterialBindEval` unchanged via
  the core — no new eval surface.

Acceptance B: from the panel (desktop-owner session), clicking Import on a succeeded
barrel lands a textured asset in the project's Unity editor (material
hasBaseMap/hasBumpMap, Lit shader), proven via a Game View capture; the button
reflects async progress; a session without presence:command sees it hidden/disabled.

## Pipeline (when greenlit, per /goal)
This frozen spec → implementer (Sonnet; the three core-extractions are the delicate
bits) → fresh grounded critic → **Opus review of the web→import security path** →
live E2E (panel shows live progress; one-click import → Game View capture).
Orchestrator commits; push to origin only.

## Risks / owner sign-off
1. THREE edits to increment-"frozen" files: `GenerationService.updateJob` (cheap
   publish seam + debounce), `GenerationListRoute` (scope-free list core),
   `handlers.ts` (import core). All additive + convention-matching; both
   GenerationService.ts AND server.ts:628-671's ancestor-provide are hard-won files
   — the cheap-broadcast design deliberately AVOIDS re-touching the server.ts graph.
2. Import is a DESKTOP-OWNER-scope action (like Play) — confirm that UX (import from
   the owner's own desktop app, not a remote browser).
3. Async import handle: pick the reporting channel (extend generation frames vs a
   sibling import registry) at implementation.
4. Keep vs drop the 5s poll once live push lands (default: keep as fallback).
5. Route headroom (critic LOW #6): server.ts's inner `Layer.mergeAll` is the #58
   20-arg-ceiling fix; it holds 15, +2 new routes = 17, under 20 — fine now,
   finite later.

## Explicit gate note
DESIGN ahead of Gates A4 (#155 live) and B (2b.1 visual). Implements nothing;
does not pass a red gate. Implementation starts only after A4 + B are green.
