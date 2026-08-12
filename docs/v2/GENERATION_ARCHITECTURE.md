# Generation Architecture — DRAFT

**Status:** DRAFT 1. First synthesis pass. Nothing here is implemented; several
choices are explicitly marked as spike-only or owner-ruling.
**Date:** 2026-08-11
**Charter:** `docs/v2/HANDOFF.md` §67 (this document's required contents), with
the design constraints from §2, §3, §10–§15, §18–§20, §37, §43–§48, §63–§64,
§70–§74.
**Repo:** `~/Projects/t3code-fork`, branch `workbench/upstream-20260806`, commit
`9075d856d` at time of writing.

## Evidence base and how to read the citations

Four research lanes fed this document. Two landed in this repo, two landed in a
different checkout (see the reconciliation note below):

| Short cite    | File                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| **SEAMS**     | `docs/v2/notes/t3-architecture-seams.md` (this repo)                                                                 |
| **UNSLOTH**   | `docs/v2/UNSLOTH_REFERENCE_NOTES.md` (this repo)                                                                     |
| **TOOLING**   | `docs/v2/notes/agent-tooling.md` (written into `~/Projects/gamedev-workbench/.claude/worktrees/substrate-research/`) |
| **PROVIDERS** | `docs/v2/PROVIDER_MATRIX.md` (same wrong checkout as TOOLING)                                                        |
| **CHARTER**   | `docs/v2/HANDOFF.md` (this repo)                                                                                     |

Every architectural choice below states **why** and points at one of those. A
choice with no citation is a choice with no evidence, and none should be here —
where I could not ground something, it is in §14 (Spike-only) or §15 (Owner
rulings needed) instead of in the body.

### Reconciliation note — read before trusting TOOLING §1

Three of the four research lanes were dispatched against a stale repo pointer
(`undefined/docs/v2/HANDOFF.md`) and two of them physically wrote their output
into `~/Projects/gamedev-workbench/.claude/worktrees/substrate-research/docs/v2/`
— a _different product_, the earlier ACP-native harness. The charter and the
other two notes live here, in `t3code-fork`. **Those two notes should be moved
into this repo** (orchestrator action; this lane's write scope is new files only).

The consequence is not cosmetic. **TOOLING §1's headline finding — that
`claude-code` and `codex` sessions get zero MCP servers because two new
`*-sdk-connection.mjs` files silently drop `input.mcpServers` — is a fact about
the _other_ codebase and does not describe this one.** I verified the opposite
here directly:

```
apps/server/src/provider/Layers/ProviderService.ts:217   prepareMcpSession = (threadId, providerInstanceId) => …
apps/server/src/provider/Layers/ProviderService.ts:221     McpProviderSession.setMcpProviderSession(credential.config)
apps/server/src/provider/Layers/ProviderService.ts:400     yield* prepareMcpSession(input.binding.threadId, bindingInstanceId)
apps/server/src/provider/Layers/ProviderService.ts:596     yield* prepareMcpSession(threadId, resolvedInstanceId)
```

and `readMcpProviderSession` is consumed by **all five** adapters —
`ClaudeAdapter.ts`, `CodexAdapter.ts`, `CursorAdapter.ts`, `GrokAdapter.ts`,
`OpenCodeAdapter.ts` (SEAMS §6.2 lists the per-driver injection sites and
mechanisms). In this repo the seam is wired end to end, not orphaned.

Everything else in TOOLING — the per-CLI timeout table, the tool-naming
divergence, the permission-option cardinality, the result-envelope shapes — is
protocol-level and vendor-doc-level, and carries over unchanged. It is
load-bearing for §7 (async model) below.

---

## 1. System diagram

```text
┌──────────────────────────── CLIENTS (transport only) ───────────────────────────┐
│  web / desktop (Electron) / mobile        dock panel: "Generation"              │
│  render · dispatch · subscribe            SEAMS §5.2 — registry entry + component│
└───────────────┬─────────────────────────────────────────────────┬───────────────┘
                │ WS/RPC + GET /generation-events?projectId=…     │ GET /api/assets/<signed>
                │ (SEAMS §4.3)                                     │ (SEAMS §4.4)
╔═══════════════▼══════════════════ SERVER PROCESS ═══════════════▼═══════════════╗
║  The execution boundary. docs/internals/remote.md:12-14, overview.md:5-8.       ║
║                                                                                 ║
║   ┌─────────────────┐        ┌──────────────────────────────────────────────┐  ║
║   │ ProviderService │        │  MCP HTTP server  /mcp   (McpHttpServer.ts)   │  ║
║   │  Codex Claude   │◀──────▶│  toolkits/preview/   ← exists                 │  ║
║   │  Cursor Grok    │ mcp    │  toolkits/generation/ ← NEW, the whole seam    │  ║
║   │  OpenCode       │Servers │  generate_image · generate_3d · generate_audio │  ║
║   └────────┬────────┘        │  generation_status · generation_cancel         │  ║
║            │                 │  list_generations · inspect_generation         │  ║
║            │ agent turns     │  import_generated_asset                        │  ║
║            │                 └───────────────────┬──────────────────────────┘  ║
║            │                                     │ projectId resolved from     ║
║            │                                     │ threadId (SEAMS §6.4a)      ║
║            │                        ┌────────────▼────────────┐                ║
║            │                        │    GenerationService     │               ║
║            │                        │  owns the job lifecycle  │               ║
║            │                        │  owns the poll loops     │               ║
║            │                        └───┬───────────┬─────────┘                ║
║            │                            │           │                          ║
║   ┌────────▼─────────┐   ┌──────────────▼──┐   ┌────▼──────────────────────┐   ║
║   │ orchestration    │   │ GenerationRegistry│  │ GenerationProviderRegistry│   ║
║   │ event store      │   │ in-memory, per-   │  │  Meshy · Tripo · Eleven-  │   ║
║   │ DECISIONS only   │   │ project, level-   │  │  Labs · ComfyUI(local) ·  │   ║
║   │ (SEAMS §1.5)     │   │ broadcast progress│  │  Unsloth(local)           │   ║
║   └──────────────────┘   └───────────────────┘  └────┬──────────────────────┘   ║
║   ┌──────────────────┐   ┌───────────────────┐       │ HTTP / SDK / local proc  ║
║   │ projection tables│   │ ServerSecretStore │       │ transport is per-provider║
║   │ asset catalog    │   │ <stateDir>/secrets│       │ (CHARTER §20)            ║
║   └──────────────────┘   └───────────────────┘       │                          ║
╚══════════════════════════════════════════════════════│══════════════════════════╝
                                                       ▼
                              ┌────────────────────────────────────────┐
                              │  GeneratedAsset  (GLB / PNG / WAV …)   │
                              │  ONE representation, provider-agnostic │
                              └───────────────┬────────────────────────┘
                                              │ CHARTER §3: no provider×engine matrix
                              ┌───────────────▼────────────────────────┐
                              │  Engine importers                       │
                              │  UnityImporter (first) · UnrealImporter │
                              │  separate approval gate (CHARTER §47)   │
                              └───────────────┬────────────────────────┘
                                              ▼
                                   Unity Editor → Play → Game View
                                   screenshot + technical evidence
                                              │
                                              ▼  back to the agent as an MCP
                                                 image content block
                                                 (SEAMS §6.1, proven idiom)
```

The loop the charter says _is_ the product (§0, §69) closes on the right-hand
edge: generation → asset → import → run → observe → agent evaluates → generate
again.

---

## 2. Service boundaries

**Everything executes in the server process.** Not a design choice — an existing
invariant. `docs/internals/remote.md:12-14`: _"T3 has one runtime boundary … the
server owns orchestration, providers, terminals, git, and filesystem operations.
Remoteness is expressed at the connection layer, never by splitting the
runtime."_ (SEAMS §4.1). This settles CHARTER §44 with zero design work.

Four new server-side units, each with a stated reason to be its own thing:

| Unit                               | Owns                                                            | Why separate                                                                                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GenerationService**              | Job lifecycle, provider poll loops, terminal-state decisions    | The only thing that talks to both the event store and providers; the single place cancellation and retry are authoritative                                                                                  |
| **GenerationProviderRegistry**     | Provider _types_ + their capability flags + saved _connections_ | UNSLOTH §1's three-way split: registry ≠ saved config ≠ locally-detected resource. Conflating them is how secrets end up in a config listing                                                                |
| **GenerationRegistry** (in-memory) | In-flight progress, poll cursors, cancel signals                | SEAMS §1.4: the event store serializes everything through one worker fiber (`OrchestrationEngine.ts:310`). A Meshy poll loop emitting progress percentages would contend with agent streaming on that queue |
| **generation MCP toolkit**         | The agent-facing tool surface                                   | SEAMS §6.1: a sibling of `apps/server/src/mcp/toolkits/preview/`, which is a directory, not a fork of the transport                                                                                         |

**What does NOT become a unit:** a `GameCapabilityService` (`CreateProp`,
`CreateCharacter`). CHARTER §14 says explicitly _"Do NOT build this abstraction
prematurely. Start with explicit tools."_ The composition
`generate_image → generate_3d → inspect → import` is the agent's job in wave one.

**What is explicitly not a T3 `ProviderAdapter`:** CHARTER §2 — T3's provider
contract is `startSession / sendTurn / interruptTurn / respondToRequest /
stopSession / rollbackThread / streamEvents`, which is session-and-turn shaped.
UNSLOTH §1 independently reached the same conclusion from the other direction:
_"Don't build the provider layer as chat-adapter-shaped when the real need is
generation-job-shaped … Borrow the credential/registry split, not the
request/response shape."_

---

## 3. Provider boundary

```ts
interface GenerationProvider {
  readonly id: ProviderTypeId; // "meshy" | "tripo" | "elevenlabs" | "comfyui" | …
  readonly capabilities: GenerationCapabilities; // independent flags, §3.1
  readonly modelListMode: "remote" | "curated"; // UNSLOTH §1

  testConnection(conn: ProviderConnection): Promise<ConnectionTestResult>;

  submit(req: GenerationRequest, conn: ProviderConnection): Promise<ProviderJobHandle>;
  poll(handle: ProviderJobHandle, conn: ProviderConnection): Promise<ProviderJobState>;
  cancel(handle: ProviderJobHandle, conn: ProviderConnection): Promise<CancelOutcome>;
  fetchOutputs(handle: ProviderJobHandle, conn: ProviderConnection): Promise<ProviderOutput[]>;
}
```

Four load-bearing decisions:

**3.1 Capabilities are independent flags, not a type tag.**
`{ textToImage, imageToImage, textTo3d, imageTo3d, multiviewTo3d, texturing,
remesh, rigging, animation, tts, sfx }` — because PROVIDERS §6.1 shows real
providers mix and match arbitrarily (Meshy has rigging+animation but no audio;
ComfyUI has native text→3D _and_ SFX but no rigging; ElevenLabs is audio-only).
UNSLOTH §2 reaches the same shape from Unsloth's own model-capability block. A
provider must be able to report **unknown** rather than guess (UNSLOTH §2:
"design the schema so a provider can honestly report 'unknown'") — PROVIDERS has
UNCERTAIN cells on cancellation for four of five providers, and a boolean that
cannot express UNCERTAIN would launder that into a lie.

**3.2 Transport is per-provider and that is deliberate.** CHARTER §20: _"We do
not require every provider to use the same underlying transport. What matters is
the canonical experience above it."_ Concretely, from PROVIDERS: Meshy/Tripo =
REST + poll; ElevenLabs = synchronous REST; ComfyUI = local HTTP `/prompt` +
`/ws` + `/history` + `/interrupt`, or its official `comfy-mcp` server; Unsloth's
image surface = **no documented public API at all** (PROVIDERS §3.2), which is
precisely why PROVIDERS §8 recommends ComfyUI over Unsloth as the first local
image backend.

**3.3 Synchronous providers are normalized _up_ into the job model, never down.**
ElevenLabs TTS returns audio in the call (PROVIDERS §6.2 shape 2). It still gets
a `GenerationJob` — one that is already `succeeded` when the tool returns. The
alternative (two tool contracts, one blocking and one async) doubles the agent-
facing surface to save one row in a table. See §7.

**3.4 Local backends are not providers-with-a-fake-key.** UNSLOTH §1: local
models are discovered from disk with a `source` tag, not modelled as a provider
config with an empty API key. A local ComfyUI is a _detected resource_ with a
reachability status; the `ConnectionTestResult`/`/test` affordance (UNSLOTH §1)
applies to it too, but its "credential" is a URL and a process, not a secret.

**First provider for the vertical spike: Tripo**, with Meshy as documented
runner-up — PROVIDERS §7: single create-and-poll round trip vs Meshy's mandatory
two-stage preview→refine, plus an official Python SDK `wait_for_task()` helper.
The one UNCERTAIN that could flip it is whether Tripo's free Studio credits apply
to the API (PROVIDERS §7 calls this "the single most decision-relevant UNCERTAIN
in this whole document" and it is a two-minute live check).

---

## 4. Agent tool boundary

**This is the strongest single finding of the research wave, so state it plainly:
CHARTER §17's "strong hypothesis to test" — one canonical tool server across all
our coding agents — is not a hypothesis in this codebase. It is shipped
infrastructure.**

SEAMS §6.1–6.2, verified independently by me above:

- The server already hosts an MCP HTTP server at `/mcp`
  (`McpHttpServer.ts:219-226`, `McpServer.layerHttp({name:"DevGame", path:"/mcp",
protocols:[v2025_06_18]})`), mounted in `server.ts:583`.
- `McpSessionRegistry.issue({threadId, providerInstanceId})` mints a per-thread
  bearer token (32 random bytes, only the SHA-256 hash stored, 24h liveness
  refreshed by both MCP traffic and every provider turn).
- `ProviderService.prepareMcpSession` is called on session create and on turn
  (`:400`, `:596`), publishing config into the module-level
  `McpProviderSession` map.
- All five adapters read it and inject: Claude via the SDK `mcpServers` option;
  Codex via `-c mcp_servers.devgame.url=…` + a bearer env var; Cursor and Grok via
  the ACP `mcpServers` array; OpenCode into its server config.

So the generation work is **a toolkit directory, not a transport**:
`apps/server/src/mcp/toolkits/generation/`, sibling to `toolkits/preview/`.

**Tool surface** (CHARTER §15, unchanged — the charter's list is already minimal):

```text
generate_image   generate_3d   generate_audio
generation_status   generation_cancel   list_generations
inspect_generation
import_generated_asset
```

`create_game_asset` is deliberately absent (CHARTER §14).

**Handing pixels back to the agent is already a solved idiom here.**
`registerPreviewSnapshot` (`McpHttpServer.ts:130-204`) hand-builds a
`CallToolResult` with a `{type:"image", data: Uint8Array, mimeType}` block
alongside structured JSON, using the manual `server.addTool` path rather than the
declarative toolkit path. SEAMS §6.1: _"This is the exact mechanism a
`generate_image` / `inspect_generation` tool needs … and it is already proven
working against real agents."_ That answers CHARTER §22 and §48 for images and
for 3D turntable renders.

**Every tool result carries both a text block and `structuredContent`.** TOOLING
§4 finding 7: image and `structuredContent` richness is a spec-level yes but
confirmed for at most one of three clients — Claude Code's docs discuss image
content explicitly, Codex's live transcript proves the envelope survives
unflattened, OpenCode is untested for output richness entirely. So: text is the
floor everywhere, structured is the ceiling we ship and verify per provider.

**Two known per-provider leaks the tool layer must absorb** (TOOLING §2.4, §4):

1. Tool naming differs — `mcp__devgame__generate_3d` (Claude, and _deferred behind
   an internal `ToolSearch` step_) vs `mcp.devgame.generate_3d` (Codex, with
   `{server, tool}` split in `rawInput`). Never exact-match a tool title.
2. Permission-option vocabularies differ in **cardinality**: Claude offers 3
   (`allow_always`/`allow_once`/`reject_once`), Codex 4 (adds `allow_session`).
   A permission UI must be generic over an option array from day one.

**The `McpCapability` trap — land it as its own PR before any generation tool.**
`McpInvocationContext.ts:10` is literally `export type McpCapability = "preview"`
(verified), and `PreviewAutomationUnavailableError` declares
`capability: Schema.Literal("preview")` in `packages/contracts` — a _vendor_ file
whose error type is the declared `failure` of every preview tool. SEAMS §6.3
walks both fix paths and their costs. Recommendation: a fork-owned
`McpCapabilityUnavailableError`, red-first test, landed alone. Do not let it ride
inside a feature PR.

**`projectId` is resolved inside the handler.** `McpInvocationScope` carries
`environmentId / threadId / providerSessionId / providerInstanceId /
capabilities`, and **not** `projectId` or `workspaceRoot` (SEAMS §6.4). Resolve
`threadId → projection_threads.project_id → projection_projects.workspace_root`
via `ProjectionSnapshotQuery` in the handler — no contract change, and it matches
the Diff-panel precedent exactly. The alternative (add `projectId` at mint time)
needs the same lookup anyway, one layer further from where it is used.

---

## 5. `GenerationJob` — minimum viable

CHARTER §10 says do not over-generalize; UNSLOTH §7 is a documented cautionary
tale about the opposite failure (Unsloth Studio's downloads, training, diffusion
and chat each invented their own status vocabulary, and there is no shared
"is this terminal" helper anywhere). One core status vocabulary; per-modality
detail goes in a `progress` sub-object _alongside_ it, never as a rival enum.

```ts
type GenerationJobId = Branded<string, "GenerationJobId">;

interface GenerationJob {
  id: GenerationJobId;
  projectId: ProjectId; // owner — §6

  modality: "image" | "model3d" | "audio";
  capability: string; // "text-to-3d", "image-to-3d", "tts", …

  providerId: ProviderTypeId;
  providerConnectionId: ProviderConnectionId;
  providerJobId?: string; // opaque, provider's own handle

  status: "created" | "queued" | "running" | "succeeded" | "failed" | "cancelled"; // CHARTER §10 verbatim

  progress?: {
    // optional, modality-shaped — UNSLOTH §4
    fraction?: number; // 0..1 when the provider gives one
    step?: number;
    totalSteps?: number; // diffusion-shaped
    etaSeconds?: number;
    queuePosition?: number; // Meshy exposes preceding_tasks
  };

  input: {
    prompt?: string;
    sourceAssetIds?: GeneratedAssetId[]; // image→3D composition, CHARTER §54
    parameters: Record<string, unknown>; // provider-specific, NOT normalized yet
  };

  outputs: GeneratedAssetId[]; // populated on success

  error?: GenerationError; // §12

  requestedBy?: { threadId?: ThreadId }; // REFERENCE, never ownership — §6
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}
```

**Deliberately excluded from the core record, each with a reason:**

- **cost / credits.** CHARTER §46: _"Do not make pricing part of the core
  contract."_ PROVIDERS §6.3 independently: none of the dated pricing belongs in a
  type. Optional metadata later, sidecar, never a required field.
- **`importStatus` / `engineStatus`.** CHARTER §10 is explicit: keep external
  generation state separate from game-engine state, _"Do not build one enormous
  state enum."_ Import is §9.
- **`GameAssetSpec`.** CHARTER §37: _"Do not create a giant schema. Determine the
  minimum required by real spikes."_ For wave one it is at most
  `{targetPolycount?, maxTextureSize?}` carried inside `input.parameters` and
  echoed into review evidence (§9). Promote it to a real type only when a spike
  needs a second field.
- **A per-modality status enum.** UNSLOTH §7, the cautionary finding above.

**Requested-vs-applied.** UNSLOTH §5 calls the `{value, requested, source,
status, reason}` provenance shape _"the single most reusable idea in this whole
codebase."_ Apply it wherever we auto-resolve something the user could have
chosen: auto-selected provider, auto-downgraded polycount, local-vs-cloud
routing. It lives in `progress`/result metadata, not in the status enum.

---

## 6. `GeneratedAsset` — minimum viable, and who owns it

```ts
interface GeneratedAsset {
  id: GeneratedAssetId;
  projectId: ProjectId; // owner
  modality: "image" | "model3d" | "audio";

  files: Array<{
    path: string;
    role: "primary" | "texture" | "preview";
    bytes?: number;
    format: string;
  }>;

  generationJobId: GenerationJobId;
  providerId: ProviderTypeId;
  sourceAssetIds: GeneratedAssetId[]; // provenance chain — CHARTER §12

  metadata: Record<string, unknown>; // modality-shaped: triangles, materials,
  // textureSize, bounds, durationMs, sampleRate
  preview?: { thumbnail?: string; renders?: string[] };

  createdAt: number;
}
```

`engineImport` is **not** a field on this record. CHARTER §11 sketches it as
optional, but CHARTER §10's "do not build one enormous state enum" and the
repo's own idiom (separate projection tables per concern,
`005_Projections.ts`) both point the other way: a separate `AssetImport` row
keyed by `(assetId, engine)` with `{status, engineObjectRef, importedAt}`. One
asset can be imported into two engines, or re-imported after a re-import; a
nested optional cannot express that without growing. **Flagged as a reversible
call** — if the first spike only ever imports once, the nested field is cheaper.

### 6.1 Project ownership — settled, and non-negotiable

Generation belongs to the **project**, not the thread, agent, or provider
(CHARTER §34, §72, §73). The repo supports this with existing precedent:

- The client sends an **opaque `projectId`**; the server resolves the filesystem
  root from its own projection. `docs/specs/unity-project-scoped-routes.md` is a
  shipped spec that exists solely to ratify this and explicitly **rejects**
  caller-supplied `workspaceRoot` for anything that writes to disk (SEAMS §2.1).
  It was forced by a live defect: the packaged desktop app runs every project
  from one process whose cwd is `$HOME`, producing _"Not a Unity project:
  /Users/pieroherrera"_.
- The `space` aggregate is the exact template for "referenced, never owned" —
  delete never cascades, cross-project references work on purpose, and deletion
  clears the _reference_ (`projection_threads.space_id → NULL`) rather than the
  referring row (SEAMS §2.3, commit `79097c0e3`). A `thread.generation_ref`
  follows this shape.
- Client-side identity is `(environmentId, projectId)`, not `projectId` alone —
  `scopedProjectKey` already exists in `packages/client-runtime`. Keying a
  generation cache on `environmentId` alone makes two projects in one environment
  serve each other's answers (SEAMS §2.2).

**Hard constraint: `GeneratedAsset` must not live in `attachmentsDir`.**
Attachment ids are minted as `<safe-thread-segment>-<uuid>`
(`attachmentStore.ts:36-42`) and pruned by thread
(`ProjectionPipeline.ts:107-110`). Using it would give generated assets
thread-scoped lifetime — exactly what CHARTER §72 forbids (SEAMS §2.3, §7 Q35).
An asset **may additionally** publish a thread attachment for inline chat
rendering; the durable copy lives project-scoped.

Bonus finding worth carrying: **assistant images already render inline in chat
with zero new UI** — `ChatImageAttachment` is in the contract, the server already
persists provider-emitted images
(`AssistantImageAttachmentPersistence.ts:25-70`), and the timeline renders them
role-agnostically (SEAMS §5.5). An image generation result can appear in chat on
day one. A _3D_ result cannot — MCP tool calls render as a compact wrench row
(`MessagesTimeline.tsx:2081-2085`), so UX trial C's inline card must be
deliberately built, following the `proposed-plan` precedent (~3 files).

---

## 7. Persistence — split by mutability rate

**Recommendation (SEAMS §1.5, §7 Q32–33), and the reasoning is a cost measured
in this repo, not an aesthetic preference:**

| What                                                                                                          | Where                                                              | Why                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decisions: `generation.requested`, `generation.settled`, `generated-asset.recorded`, `.imported`, `.selected` | Orchestration event store, on the **existing `project` aggregate** | Low frequency; provenance (CHARTER §12) falls out of the store's causation/correlation ids for free; survives restart                                                  |
| In-flight progress, poll cursors, ETA, byte counts                                                            | **In-memory** `GenerationRegistry`, project-keyed, level-broadcast | The event store runs one worker fiber over one queue (`OrchestrationEngine.ts:97,310`). Provider progress polling is a firehose and would contend with agent streaming |
| Asset catalog needing indexed queries by modality/project                                                     | A **projection table** (the existing idiom, `005_Projections.ts`)  | Reads, not history                                                                                                                                                     |
| Provider API keys                                                                                             | `ServerSecretStore`, never either of the above                     | §11                                                                                                                                                                    |

**Why not a fourth aggregate.** The fork already added a third (`space`), and
commit `79097c0e3` is the honest price list: **22 files, 1,268 insertions**,
including seven closed `project|thread` unions that had to be widened — not the
three the author estimated — one of which (`commandToAggregateRef`) would have
fallen through to a `command.threadId` that does not exist on the new command
shape. Reusing the `project` aggregate for project-scoped `generation.*` events
needs **zero** union widening; the cost is that `projection_projects` replay
grows (SEAMS §1.2, §7 Q32).

**Why in-memory progress is the house style, not a shortcut.** Three fork-added
subsystems already declined persistence for observed/ephemeral state, each with
its reasoning in-file: `EditorPresenceRegistry` (_"Pure in-memory fan-out …
Nothing on disk"_), `SpaceEventsRegistry` (_"See EditorPresenceRegistry for the
same shape"_), and `EngineTypeResolver`, which states the cost model outright —
persisting a cheap derived fact _"would require a migration plus touching the
event schema, decider, projector, and client contract, then go stale"_ (SEAMS
§1.3). A crash recovers in-flight jobs from the terminal events plus a provider
re-poll, not from a replayed progress log.

**Client reconnection: adopt, don't re-issue.** UNSLOTH §3 describes Unsloth's
generation-counter + adoption pattern — the job lives server-side keyed with a
monotonic counter, and any client (reloaded tab, second window, phone) re-attaches
to the authoritative running job instead of losing it or duplicating it; a cancel
is scoped to a generation number so a stale cancel from a reloaded tab cannot kill
a newer retry. This directly answers CHARTER §66 Q13/Q15.

**Migration hygiene:** `Migrations.ts:106-120` records that this fork and upstream
independently minted ids 36–38, and that a database produced by stock T3 Code
would silently skip the fork's space migrations. Generation migrations must append
after 40 and must not assume the fork owns its numeric range (SEAMS §1.2).

---

## 8. Async model — job handle, uniformly

**Decision: `generate_*` returns `{jobId, status}` immediately; the agent (or the
UI on its behalf) calls `generation_status(jobId)`. The _server_ owns the
provider poll loop.**

**Why job-handle and not blocking — the deciding evidence is a timeout table**
(TOOLING §3.4, §5):

|                                      | Claude Code                                               | Codex CLI                    | OpenCode                                                      |
| ------------------------------------ | --------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------- |
| Default tool-call timeout            | ~28h (unset `MCP_TOOL_TIMEOUT`)                           | **60s** (`tool_timeout_sec`) | ambiguous — docs describe `timeout` as connect/discovery-time |
| Client-provided long-running pattern | automatic backgrounding at 2 min → task id + notification | none documented              | none for MCP tool calls (background _subagents_ only)         |

Three consequences:

1. **Codex makes it close to required.** Any real 3D generation runs
   seconds-to-tens-of-minutes (PROVIDERS §6.2). A blocking `generate_3d` fails at
   60s by default. Raising `tool_timeout_sec` means editing the user's own
   `~/.codex/config.toml`, which this product's doctrine forbids (never bundle,
   never auto-configure a vendor CLI).
2. **Claude Code would tolerate blocking — via a Claude-Code-specific client
   feature.** Depending on auto-backgrounding puts our tool contract's semantics
   in someone else's client. Owning the shape ourselves costs nothing extra.
3. **OpenCode's timeout semantics are genuinely unresolved from docs.** Designing
   for "never block past a few seconds" sidesteps the open question rather than
   betting on an unverified reading.

The general rule TOOLING and PROVIDERS reached independently: **design the tool
contract for the least forgiving client and the least forgiving provider, not the
most generous.**

**Who polls the provider: the server, never the agent.** (CHARTER §66 Q9.) The
agent _may_ call `generation_status`, but the authoritative loop is
GenerationService's, because:

- CHARTER §59 wants the agent to keep working while generation runs — that only
  holds if the job's advancement does not depend on the agent looping.
- CHARTER §66 Q14 ("what if the agent session ends") and Q13 ("what if the desktop
  app closes") only have a good answer if the job is server-owned.
- CHARTER §44: a phone client must be able to watch a job it did not start.

**Uniform contract across job shapes.** PROVIDERS §6.2 found three provider
shapes: long-async poll (Meshy, Tripo, ComfyUI), synchronous (ElevenLabs), and
undocumented (Unsloth image). All three produce a `jobId`; a synchronous provider
simply returns a job already in `succeeded`. One agent-facing contract, three
adapter implementations.

**Progress to clients:** a dedicated route `GET /generation-events?projectId=…`,
modelled byte-for-byte on `SpaceEventsRoute` + `SpaceEventsRegistry` (SEAMS §4.3).
Rationale is merge debt, and the fork already wrote it down:
`SpaceEventsRoute.ts:15-30` explains that a new RPC method would force edits to
`packages/contracts` **and** `ws.ts`, both vendor files, because `WsRpcGroup`
mounts all handlers in one object whose router type is the union of all of them.
Level broadcasts (full job list per frame) make reconnect self-healing and make
"what happened while the phone was asleep" a non-question. Auth follows the same
route's pattern: accept the upgrade, authenticate in `onOpen`, close with an
application code ≥4000 (4400/4401 = stop retrying, 4500 = retry).

**Unmeasured:** nobody has measured how much traffic a Meshy-style poll loop adds
to whichever channel carries it (SEAMS §8.5). Spike item.

---

## 9. Engine boundary

**One asset representation, N importers. Never provider × engine.** CHARTER §3 is
unambiguous: `Meshy → GeneratedAsset(GLB)` and `Tripo → GeneratedAsset(GLB)`, then
`UnityImporter` / `UnrealImporter` — not `MeshyUnityProvider`,
`TripoUnrealProvider`. GLB is the pivot format and both first-choice 3D providers
emit it natively (PROVIDERS §6.1).

**Import is a separate tool and a separate approval.** `import_generated_asset` is
not folded into `generate_3d`, because CHARTER §47's permission sketch
distinguishes _"Allow paid cloud generation: ask"_ from _"Allow importing
generated 3D: ask"_ — two different consequences (money vs mutating the project),
so two different gates.

**Review has two consumers with different representations** (CHARTER §26): the
human gets an interactive viewport; the agent gets rendered screenshots plus
technical evidence — triangles, materials, texture size, bounds, rig metadata,
file paths (CHARTER §24, §25). CHARTER §63 argues this technical layer is where a
game harness beats a generic generator, and §64 argues the strongest review is not
standalone inspection at all but _generate → import → place → Play → Game View
screenshot → agent evaluates_. The transport for those pixels already exists (§4:
the image-content `CallToolResult` idiom).

**Unity access follows the existing project-scoped route precedent**
(`UnitySetupProbeRoute.ts`, SEAMS §2.1): opaque `projectId` in, server resolves
the path, unknown id becomes a typed error rather than a cwd fallback, and the
scope gate distinguishes read-only probes (`AuthPresenceReadScope`) from anything
that executes (`AuthPresenceCommandScope`).

**Unresolved and owner-facing: worktree vs canonical root for generated files.**
Unity routes deliberately resolve the _canonical_ `project.workspaceRoot` (an
Editor binds to the canonical root; a worktree copy would target a project no
Editor has open). The Diff panel deliberately prefers `worktreePath ??
workspaceRoot`. Writing a generated asset into the repo is arguably the Diff
case, but importing it into a live Editor is the Unity case. SEAMS §8.1 flags
this as needing an owner ruling; I agree, and note it may not have one answer —
the file write and the Editor import may legitimately resolve differently.

---

## 10. Remote execution

Settled by the existing invariant (§2). Concretely:

- Generation executes on the **environment/project host**. A phone or hosted-web
  client dispatches, subscribes, and renders (SEAMS §4.1; CHARTER §44).
- **Do not copy `PreviewAutomationBroker`.** It inverts the model — the client's
  browser is the execution surface and the server is a broker queueing requests
  to a connected client (`PreviewAutomationBroker.ts:44-58`). That exists because
  browsers can only be driven from inside a browser. Copying it for generation
  would make local generation depend on the remote viewing device, which is
  precisely what CHARTER §44 forbids (SEAMS §4.2).
- **Media delivery** uses the existing signed-URL machinery: `/api/assets`, HMAC
  over base64url claims, key from
  `ServerSecretStore.getOrCreateRandom("asset-access-signing-key", 32)`,
  timing-safe verification, 1h TTL, minted over the `assets.createUrl` RPC
  (SEAMS §4.4). **Open:** extend the closed `AssetResource` union with a
  `generated-asset{assetId}` variant (smaller code, edits two vendor files) or
  stand up a fork-owned signed route (larger code, smaller merge debt). SEAMS
  §8.2 leaves it open; I lean fork-owned route on the "files we must EDIT cannot
  live under vendor/" principle, but this is a real trade and not mine to settle.
- If the harness ever exposes a remote tunnel, UNSLOTH §6 has a cheap safety
  default worth adapting: forced credential rotation gates the public URL, and an
  exposed-but-unconfigured instance self-terminates on a timer — scoped to
  network-exposed launches only, so a purely local user is never nagged.

---

## 11. Credentials

**Copy the existing provider-env-var protocol exactly; do not invent a second
one** (SEAMS §3):

1. Store server-side in `ServerSecretStore` — `<stateDir>/secrets/<name>.bin`,
   directory `0700`, files `0600`, write-temp → chmod → rename → chmod, `flag:"wx"`
   so a concurrent creator loses deterministically. Key namespace mirrors
   `providerEnvironmentSecretName`: `generation-provider-<providerId>-<credential>`.
2. Model it in settings as `{name, value, sensitive: true}` so the existing
   save/redact/materialize path applies unchanged
   (`serverSettings.ts:78-84`, `:316-340`, `:395-445`).
3. Redact at **every** client-facing exit — the existing discipline is four call
   sites (`ws.ts:992, 1477, 1488, 2039`). Add a test asserting the raw value never
   appears in a client-facing payload.
4. Never round-trip the secret through the config API at all. UNSLOTH §1: the
   saved-config response carries `has_api_key: boolean` and nothing else, so a
   leaked config listing cannot leak a key. Pair it with a `testConnection` action
   returning `{success, message, modelsCount}` **before** the config is trusted —
   validate credentials at setup, not three screens later mid-generation.

CHARTER §45's four requirements map cleanly: never in the game project (it is in
`stateDir`, not `workspaceRoot`); protected (0600/0700); environment-specific
(`stateDir` is per-environment); remote-client safe (the key never crosses the
wire — a remote client asks the host to generate).

**Explicitly not this:** the desktop app's Electron `safeStorage` encryption of
saved bearer tokens (`ElectronSafeStorage.ts:54-66`). That is the client's
credential for reaching a server. Putting provider keys there would mean a phone
client needs the Meshy key for the app to work (SEAMS §3.3).

**Unchecked, and worth checking before shipping:** whether `stateDir` is ever
synced/backed up by the desktop app (0600 files would travel), and whether any
diagnostics bundle dumps settings unredacted — SEAMS §3 checked `ws.ts` exits
only.

---

## 12. Errors

A small closed set of normalized failure kinds, with the raw provider payload
preserved alongside for triage:

```ts
type GenerationError =
  | { kind: "auth"; providerId; detail: string } // key invalid/expired
  | { kind: "quota"; providerId; retryAfterMs?: number }
  | { kind: "rate-limited"; providerId; retryAfterMs?: number }
  | { kind: "invalid-input"; field?: string; detail: string }
  | { kind: "provider-failed"; providerId; providerCode?: string; detail: string }
  | { kind: "timeout"; phase: "submit" | "poll" | "fetch" }
  | { kind: "cancelled"; by: "user" | "agent" | "system" }
  | { kind: "unsupported"; capability: string; providerId };
```

Three principles behind it:

- **Normalize the kind, keep the raw.** PROVIDERS shows real divergence worth
  preserving — Meshy distinguishes `RateLimitExceeded` from `NoMoreConcurrentTasks`
  on the same 429, which is actionable (wait vs. reduce concurrency) and would be
  destroyed by flattening to "429".
- **Do not reuse `PreviewAutomationUnavailableError`.** Widening its `capability`
  literal is decode-compatible but makes the _name_ a lie: a generation failure
  would surface to the agent as a preview error (SEAMS §6.3). Fork-owned error
  type instead.
- **Requested-vs-applied is an error-adjacent shape, not only a success shape.**
  UNSLOTH §5: `{value, requested, source, status, reason}` is what lets a UI say
  _"Auto: 4,800 tris (your mobile budget is 5,000; the provider returned 18,300 and
  we remeshed)"_ instead of either silently downgrading or throwing something
  opaque. CHARTER §63 wants exactly this readout.

---

## 13. Cancellation

**Cancel is locally authoritative and upstream best-effort.** The harness marks
the job `cancelled`, stops polling, and refuses to import its outputs
_regardless_ of what the provider does — because provider-side cancellation is
**UNCERTAIN on four of five providers** (PROVIDERS §6.1). Meshy's `DELETE
/openapi/.../{task_id}` is documented as record deletion, and whether an
`IN_PROGRESS` task actually stops compute is unconfirmed. ComfyUI is the one
clear YES (`/interrupt`).

Consequences to design for, not hide:

- A cancelled job may still consume credits. Surface that honestly in the UI
  ("cancelled locally; the provider may still bill this generation") rather than
  implying a clean stop.
- Cancel outcome is its own value: `{ localState: "cancelled", upstream:
"confirmed" | "requested" | "unsupported" | "unknown" }`.

**Cancel by scope, not just globally** (UNSLOTH §4): one job, one project's jobs,
or everything — implemented as "set this signal, let the poll loop tear itself
down" rather than by tracking OS process trees. The cancel signal lives in the
in-memory registry (§7), and is scoped to a job _generation_ number so a stale
cancel from a reloaded client cannot kill a newer retry (UNSLOTH §3).

**Approval gates use the same lightweight machinery.** UNSLOTH §4 documents a
race-safe pattern worth adapting almost directly for CHARTER §47's
Manual/Autonomous/Hybrid modes: register the pending decision _before_ announcing
it (so a fast "always allow" cannot race ahead of the thing it unblocks), resolve
on a separate channel keyed by an unguessable id, **default-deny** on timeout or
cancellation, first-decision-wins with late duplicates dropped. Do **not** copy
Unsloth's one-hour default timeout uncritically — a coding agent blocked for an
hour on a $2 approval is a product decision, not an architecture one.

Related open question: every MCP credential today is minted with
`capabilities: new Set(["preview"])` unconditionally
(`McpSessionRegistry.ts:131`). Whether `generation` is granted the same way or
gated per-thread/per-project is a product decision **with a security
consequence** — if CHARTER §47's "Allow paid cloud generation: ask" is to have
teeth at this layer, it cannot be an unconditional grant (SEAMS §6.3, §8.3).

---

## 14. What only a spike can answer

Ordered by how much downstream design they unblock.

1. **Does a slow tool call actually fail at Codex's 60s default, and is
   OpenCode's `timeout` connect-time or call-time?** A `sleep_and_report(seconds)`
   throwaway tool at 5s / 65s / 130s against each provider converts two INFERRED
   rows into VERIFIED (TOOLING §6.4). This is the evidence §8 rests on.
2. **Does an OpenCode session round-trip a `devgame` tool call at all?** TOOLING
   §2.4: the `mcpServers` array is verifiably wired for OpenCode, but no capture in
   either repo shows a completed tool call through it. "Wired" and "round-tripped"
   are different claims.
3. **Do image content blocks in a tool result actually reach the model on Codex
   and OpenCode?** Confirmed by docs for Claude Code only (TOOLING §4 finding 7).
   The entire 3D-review loop (CHARTER §24, §64) depends on this.
4. **Do Tripo's free Studio credits work against the API?** PROVIDERS §7 —
   the single most decision-relevant UNCERTAIN; a two-minute check on a fresh
   account, and it decides Tripo vs Meshy for the vertical spike.
5. **Does a minimal workflow POSTed to a local ComfyUI `/prompt` come back
   through `/history` + `/view`?** PROVIDERS §8, the local-image-backend decision.
6. **How much traffic does a provider poll loop add** to whichever channel carries
   progress (SEAMS §8.5). Decides whether level-broadcast framing needs throttling.
7. **Does `Migrator` tolerate a migration whose projector needs a backfill pass
   over `orchestration_events`?** Migrations 024/025 appear to backfill but were
   not read (SEAMS §1.5, §8.6).
8. **Does the dock tab renderer support a badge slot** for CHARTER §58's
   "Generation ● 1" (SEAMS §8.4)?
9. **Is Unsloth's image-generation surface a usable internal API or a GUI-only
   dead end?** Devtools network tab during a real Create run (PROVIDERS §8).

---

## 15. Owner rulings needed (not spike-answerable)

1. **Worktree vs canonical workspace root** for writing generated files, and
   whether the file write and the Editor import may resolve differently (§9,
   SEAMS §8.1).
2. **Extend the vendor `AssetResource` union vs. a fork-owned signed asset
   route** — smaller code vs. smaller permanent merge surface (§10, SEAMS §8.2).
3. **Is `generation` granted to every agent session by default, or gated?**
   Security consequence, and it decides whether CHARTER §47's paid-generation
   gate is enforceable at the capability layer (§13, SEAMS §8.3).
4. **Approval-timeout default** for a paused agent turn awaiting human approval
   (§13, UNSLOTH §4).
5. **`AssetImport` as a separate row vs. a nested `engineImport` field** (§6) —
   reversible, but cheaper to decide before the first migration.

---

## 16. What this document does not cover

`AGENT_GENERATION_TOOLING.md` (per-agent detail — TOOLING is its draft input),
`GENERATION_UX_EXPLORATION.md` (the three inline/tab/hybrid prototypes),
`SPIKE_RESULTS.md`, and the final ADR remain unwritten. This draft takes no
position on the ADR's A/B/C/D outcomes beyond observing that nothing in the
research wave produced evidence for option D (a different architecture) — the
existing `/mcp` seam is the single strongest argument that option A/B is right,
and CHARTER §67 requires strong technical evidence before D.
