# Increment 1 — Generation half, productized (FROZEN SPEC)

Status: frozen 2026-08-12. Grounds: `docs/v2/GENERATION_ARCHITECTURE.md`,
`notes/t3-architecture-seams.md`, `SPIKE_RESULTS.md` (spikes 0+1 proved
the mechanisms live). Read those for rationale; this is the build contract.

## Goal

An agent inside DevGame (Claude Code / Codex / OpenCode) can, via harness
MCP tools, generate a 3D asset, watch it progress, and inspect it — with
the result becoming **project-owned state** the human can also see. This
is charter §69's generate→review half. **Unity import + the Generation
web panel are Increment 2** (mechanisms already proven in spike 1).

## Scope (IN)

1. **Contracts** (fork-owned, in `packages/contracts/src/generation/` — do
   NOT edit vendor unions): `GenerationJob`, `GeneratedAsset`, and the four
   tool I/O schemas.
2. **GenerationService** (`apps/server/src/generation/`): in-memory,
   project-keyed registry shaped like `SpaceEventsRegistry`/
   `EditorPresenceRegistry` (seams note: fork's own additions all decline
   persistence). Owns jobs, the provider poll loop, and the GeneratedAsset
   records for the current server session. NO event-sourcing, NO new
   aggregate, NO migration (all deferred to Increment 2 — the seams study
   priced a new aggregate at 22 files).
3. **Provider interface + TripoProvider** (`apps/server/src/generation/
providers/`): a `Model3dProvider` interface (`submitTextTo3d`,
   `pollTask`, `deriveFbx`), and a Tripo implementation against **API v2**
   (validated in spike 0; v3 migration is a filed fast-follow — v2 retires
   2026-10-01). Key read from `ServerSecretStore` under a fixed name (see
   Credentials).
4. **MCP toolkit** (`apps/server/src/mcp/toolkits/generation/`): tools
   `generate_3d`, `generation_status`, `list_generations`,
   `inspect_generation`. Registered in `McpHttpServer.ts` exactly like the
   preview toolkit (`PreviewToolkitRegistrationLive` pattern); gated on the
   `"generation"` capability (already exists post-#116).
5. **Capability grant**: `McpSessionRegistry.ts:131` — grant
   `new Set(["preview","generation"])` (D2 default: broad grant for the
   single-user product now; PAID-provider gating lives in the service, not
   here — leave the `docs/v2/OWNER_DOCKET.md D2` comment updated).
6. **Asset storage + human visibility**: GeneratedAsset files written under
   a project-scoped dir (`<stateDir>/generated/<projectId>/<assetId>/`).
   Human-facing preview URL minted via the EXISTING `AssetAccess`
   signed-URL mechanism through a **fork-owned** asset variant/route (D5
   default) — do NOT edit the vendor `AssetResource` union; add a
   fork-owned signed route mirroring `AssetAccess` (seams note has the
   HMAC/TTL pattern).

## Scope (OUT — Increment 2+)

Unity import (`import_generated_asset`), the Generation dock panel, inline
chat cards, event-sourced persistence, cost tracking, image/audio
modalities, provider #2, cross-provider composition, the human
review/approve UX.

## Contracts (minimum viable — no giant schemas)

```
GenerationJob {
  id: GenerationJobId            // fork-minted, e.g. "gen_" + uuid
  projectId: ProjectId
  threadId: ThreadId             // who requested (for context, not ownership)
  modality: "model3d"            // literal for now
  provider: "tripo"
  providerTaskId: string | null
  status: "created" | "running" | "succeeded" | "failed" | "cancelled"
  progress: number               // 0-100
  prompt: string
  parameters: { faceLimit?: number; ... }
  assetId: GeneratedAssetId | null   // set on success
  error: string | null
  createdAt / startedAt / completedAt: epoch ms | null
}

GeneratedAsset {
  id: GeneratedAssetId
  projectId: ProjectId
  generationJobId: GenerationJobId
  modality: "model3d"
  provider: "tripo"
  files: { glb: string }         // absolute path under the generated dir
  preview: { imageUrl: string | null }   // Tripo rendered_image, signed
  metadata: { triangles: number; materials: number; images: number;
              boundsMeters?: [number,number,number]; fileBytes: number }
  createdAt: epoch ms
}
```

`inspect_generation` computes `metadata.triangles/materials/images/
fileBytes` **server-side from the GLB** (glTF accessor counts — spike 0
proved this needs no Unity) and returns it plus the preview image as an
MCP image content block (the `registerPreviewSnapshot` image-block idiom).

## Tool contracts (MCP)

- `generate_3d({ prompt, faceLimit? })` → returns `{ jobId, status:"running" }`
  IMMEDIATELY (async — Codex/OpenCode timeouts; server owns the poll).
- `generation_status({ jobId })` → the GenerationJob (status/progress/assetId/error).
- `list_generations({})` → GenerationJobs for the caller's project, newest first.
- `inspect_generation({ jobId | assetId })` → GeneratedAsset metadata + a
  preview image content block. Fails cleanly if not yet succeeded.

Resolve caller's projectId/workspaceRoot inside handlers from
`threadId → projection_threads.project_id` via `ProjectionSnapshotQuery`
(the Diff-panel precedent; the invocation scope carries threadId, not
projectId — seams note "MCP invocation scope gap").

## Credentials

Seed a `ServerSecretStore` entry `generation-provider-tripo` from the
owner's existing key file `~/.config/devgame/tripo-api-key` on first run
if the secret is absent (dev convenience; production = the provider-env
pattern). NEVER read the file on every call; materialize once. NEVER log
or return the key; redact at every client-facing exit.

## Async model (non-negotiable — verified)

`generate_3d` returns a job handle in <1s; the SERVER runs the Tripo poll
loop (submit → poll `GET /task/{id}` every ~5s → on success download GLB

- store asset). Survives the agent turn ending. OpenCode's 65s tool
  timeout (verified) makes any synchronous shape wrong.

## Acceptance (this increment is DONE when)

1. Unit: GenerationService job lifecycle with a MOCK provider (created→
   running→succeeded, progress monotonic, asset recorded); GLB inspection
   returns correct triangle count against a committed tiny test GLB
   fixture; capability gate refuses `generation` without the grant
   (red-first); tool handlers resolve projectId from threadId. All
   red-proven per repo doctrine (a green test must be able to go red).
2. Typecheck server + contracts clean; full server suite green; NO
   `packages/contracts` vendor-union edits (provably empty diff there
   except the new fork-owned `generation/` files).
3. LIVE (orchestrator-run, not a lane): through a real agent in the
   packaged/dev app, `generate_3d("wooden barrel")` returns a job,
   `generation_status` shows progress → success, `inspect_generation`
   returns ~real triangle count + preview. (The orchestrator drives this
   with the real Tripo key; ~20 credits.)

## Doctrine reminders for implementers

New features → new files; touch upstream-hot/vendor files via one narrow
seam only (McpHttpServer registration + McpSessionRegistry grant are the
only two existing-file edits expected — both fork-owned). Effect v4 beta
idioms (no `tapErrorCause`; `it.live` not `it.effect` for anything timing;
captured-logger for log assertions). Match the preview toolkit's structure
(`tools.ts` schema + `handlers.ts` logic + tests) exactly.
