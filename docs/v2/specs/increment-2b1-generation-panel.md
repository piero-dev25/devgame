# Increment 2b.1 — read-only Generation dock panel (FROZEN SPEC)

Status: frozen 2026-08-12. The HUMAN half of charter §69 (the loop is the
product: agent AND human views). Grounds: the 2b understand fan-out
(session wf_0a4ac94b-47d — dock/serving/data-path/state findings), increments
1+2a (GenerationService + MCP tools + import_generated_asset, committed
a8696fdfc / 3ffdfb8e9 / bf2e5ccb3).

## Goal

A person opens a **Generation** dock panel and SEES this project's generation
loop: each job's status + progress, and each finished asset's preview thumbnail

- prompt + triangle count. Read-only, poll-refreshed. Live WS-push, an
  "Import to Unity" button, inline chat cards, and a 3D GLB viewer are LATER
  slices (2b.2+).

## The one architectural trap (get this right first)

`GenerationServiceLive` is today a PRIVATE const inside `McpHttpServer.ts`,
reachable only by the MCP tools. If a new web route builds its own
`GenerationService.layer()`, it gets a SEPARATE, empty in-memory registry and
the panel shows nothing forever (no error — it typechecks and renders empty).
**Hoist `GenerationService.layer({...})` to ONE const in `server.ts`** (mirror
`EditorPresenceRegistry.layer` at server.ts:~387-404 — same layer reference ⇒
Effect memoizes one instance across the merged graph), carrying over its
existing options (pollIntervalMs/pollDeadlineMs/maxConcurrentGenerations/
maxGlbBytes) from McpHttpServer.ts, and provide that SAME reference into both
McpHttpServer's composition and the new generation route layer. A unit test
must prove the route and the MCP path read the same registry.

## Scope (IN)

1. **Share the singleton** (above). The hoist in `server.ts` + McpHttpServer.ts
   using the passed-in reference are sanctioned existing-file edits.
2. **Fork-owned web read route** — new `apps/server/src/generation/
GenerationListRoute.ts`: `HttpRouter.add("POST", "/generation/list", …)`.
   Auth via `EnvironmentAuth.authenticateHttpRequest` + an
   `AuthPresenceReadScope` check (the broadly-granted web-read scope the Unity
   probe route reuses — "route authenticates WHO, dispatch decides WHAT", 403
   JSON on insufficient scope). Decode `{ projectId }`; resolve the canonical
   project via `ProjectionSnapshotQuery` (opaque projectId, never a path). Call
   the SHARED `GenerationService.listJobs(projectId)`; for each job's asset,
   return it through `toClientSafeGeneratedAsset` (EXPORT it from handlers.ts;
   do NOT re-implement the redaction) so `files.glb`'s absolute path never
   crosses the wire. Include a signed media URL per asset (step 4). Wire into
   `server.ts` `makeRoutesLayer` via the `HttpRouter.provideRoute` combinator
   (NOT `.pipe(Layer.provide)` — the standing ~290-error cascade). Mirror
   `UnitySetupProbeRoute.ts` exactly.
3. **Client data plane** — new `apps/web/src/generation/fetchGenerationList.ts`
   (mirror `fetchSetupProbe.ts`: `HttpClient` + `buildEnvironmentAuthHeaders`/
   `withEnvironmentCredentials` + `Effect.timeout` + `Schema.decodeUnknownEffect`)
   and `apps/web/src/generation/generationListAtom.ts` (mirror
   `unitySetupProbeAtom.ts`: `Atom.family` keyed on `ScopedProjectRef`, gated on
   `environmentSession.preparedConnectionValueAtom`, poll/refresh on an interval
   - on focus). No new client-runtime `state/` factory needed if the atom fetches
     the route directly like the probe does.
4. **Fork-owned signed media route** — new `GenerationAssetRoute.ts` +
   `GenerationAssetAccess.ts`: issue/verify signed URLs (reuse `auth/utils.ts`
   generic sign/verify + a fork-owned `generated-asset` claims shape + a
   separate `ServerSecretStore` key) for a `{projectId, assetId, kind:
"preview"|"glb"}` ref; `GET /api/generation-assets/*` verifies the signed
   claims SERVER-SIDE (never trust a client-supplied path), resolves
   `<stateDir>/generated/<projectId>/<assetId>/{preview.<ext>|model.glb}`, and
   serves it. **Preview lazy-cache**: the preview image is NOT on disk today
   (`preview.imageUrl` is Tripo's remote CDN URL, TTL-limited). On first
   `kind:"preview"` request, if no local `preview.<ext>` exists, download
   Tripo's `imageUrl` to that path (size-capped like the GLB) and serve it;
   thereafter serve the cached file. This keeps GenerationService.ts UNTOUCHED
   (no hot edit to the completion path). Zero edits to vendor
   `assets.ts`/`AssetAccess.ts`. Register in `makeRoutesLayer` like step 2.
5. **The panel** — new `apps/web/src/dock/GenerationDockPanel.tsx` (mirror
   `DiffDockPanel.tsx`): self-resolve project via `useParams` +
   `resolveThreadRouteRef`; read `generationListAtom`; render a list — per JOB:
   prompt, status, a progress bar (0-100); per finished ASSET: the preview
   thumbnail (signed media URL from step 4), prompt, `metadata.triangles`.
   `singleton: true`, ONE panel with an internal scrollable list (not
   multi-instance). Real loading / empty / error states — the registry is
   in-memory and dies on server restart, so "empty" is normal, not a failure.
   Use the `frontend-design` skill for an in-theme, polished panel (match the
   existing dock panels' visual language).
6. **Registration** — register in `ChatDock.tsx` (pattern-copy the Browser
   `register({...})` at ~343-350: id `GENERATION_PANEL_ID`, title "Generation",
   a Lucide icon, `GenerationDockPanel`, `defaultLocation: "right"`,
   `singleton: true`, `closeable: true`) AND add the SAME id → icon to
   `reactTabRenderer.tsx`'s `PANEL_TAB_ICONS` (the `icon:` field on the
   definition is dead for rendering — a missing map entry ships a no-icon tab).
   **Default-visible**: add one single-view leaf + one `panels`-map entry to
   `buildChatDockPreset()` and widen `CONTAINER_WIDTH` accordingly — the loop is
   the product, so the panel should be present, not hidden behind Add-tab.
   Keep it a SINGLE-VIEW leaf (nested/tabbed breaks `layoutMigration.ts`'s
   graft-for-existing-users). Existing users' saved layouts get it appended
   automatically on next load.

## Scope (OUT — 2b.2+)

Live WS progress-push (poll for now); an "Import to Unity" button from the panel
(the web→import path is threadId/MCP-gated and does not exist yet — non-trivial,
its own slice); a 3D GLB viewer (thumbnail image only here); inline chat cards
(the other half of the hybrid UX); persistence across server restart;
multi-provider.

## Cross-project + security invariants (non-negotiable)

- `GenerationService.getJob/getAsset/getAssetByJobId` are NOT project-scoped —
  only `listJobs` is. Any web path that touches a single job/asset by id
  re-applies the `asset.projectId !== requester's projectId → NotFound` check
  (merge-gate P1 #2), exactly as every MCP handler does by hand.
- `files.glb` is an absolute server path — only `toClientSafeGeneratedAsset`'s
  redacted form crosses the wire; the media route resolves the real path
  server-side from SIGNED claims only.
- The media route re-verifies signed claims server-side; a client-supplied or
  redacted path is never trusted to hit the filesystem.

## Acceptance

1. Unit (all red-proven): the read route returns project-scoped jobs+assets with
   client-safe paths (no absolute path; a foreign-project id reads as
   not-found); the signed media route verifies claims and REJECTS
   tampered/unsigned/foreign-project refs; a test proves the route and the MCP
   toolkit share ONE GenerationService instance (write via one, read via the
   other); the client atom decodes the real response shape.
2. tsgo clean BOTH packages (ANSI-stripped: `pnpm typecheck 2>&1 | perl -pe
's/\e\[[0-9;]*m//g' | grep -E "error TS[0-9]"` → 0); full server suite green;
   web typecheck/build green; ZERO vendor-union edits (packages/contracts only
   the fork-owned generation/\* additions; no assets.ts/AssetAccess.ts edits).
3. LIVE (orchestrator-run): in the dev app, an agent generates an asset (MCP),
   the human opens the Generation panel and SEES the job go running→succeeded
   with a rendered thumbnail + triangle count. Screenshot evidence naming the
   commit.

## Doctrine

New files over hot edits — the only sanctioned existing-file edits: the
`server.ts` singleton hoist + route registration, `McpHttpServer.ts` consuming
the passed reference, `ChatDock.tsx` registration, `reactTabRenderer.tsx` icon,
and EXPORTING `toClientSafeGeneratedAsset` from handlers.ts. `HttpRouter.
provideRoute`, never `.pipe(Layer.provide)`. Effect v4 idioms. Match the
UnitySetupProbeRoute + DiffDockPanel + AssetAccess precedents exactly.
