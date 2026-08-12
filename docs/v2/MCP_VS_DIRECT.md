# MCP vs Direct — Comparison Framework — DRAFT

**Status:** DRAFT 1. This is the **framework**, not the verdict. Micro-Spikes A
and B (charter §51, §52) fill in the empty cells; a handful of cells are already
decidable from the research wave and are marked **DECIDED** with their evidence.
**Date:** 2026-08-11
**Charter:** `docs/v2/HANDOFF.md` §53 (this document), with §18–§20 (the three
layers), §51–§52 (the two micro-spikes), and §71/§74 (avoid provider-centric and
single-provider coupling).
**Companion:** `docs/v2/GENERATION_ARCHITECTURE.md` (DRAFT 1) — its §4 and §8
are the architecture this framework is testing.

Citation shorthand is the same as the architecture draft: **SEAMS** =
`docs/v2/notes/t3-architecture-seams.md`, **TOOLING** =
`docs/v2/notes/agent-tooling.md`, **PROVIDERS** = `docs/v2/PROVIDER_MATRIX.md`,
**UNSLOTH** = `docs/v2/UNSLOTH_REFERENCE_NOTES.md`, **CHARTER** =
`docs/v2/HANDOFF.md`. TOOLING and PROVIDERS currently live in the wrong checkout
(`~/Projects/gamedev-workbench/.claude/worktrees/substrate-research/docs/v2/`) and
should be moved here; see GENERATION_ARCHITECTURE.md's reconciliation note for
which of TOOLING's findings do and do not apply to this repo.

---

## 1. The three candidate paths

Charter §53 names three. Stated precisely, because the differences that matter
are about **who holds the job record**, not about which wire protocol is used.

### Path 1 — Agent → Provider MCP

```text
Claude / Codex / OpenCode
        │  provider's own MCP server, injected into the agent's mcpServers slot
        ▼
   Meshy MCP  /  Tripo MCP  /  ElevenLabs MCP  /  comfy-mcp
        ▼
   provider cloud or local runtime
        ▼
   files land wherever the provider MCP puts them
```

The harness is not in the loop. It learns what happened only by reading the
agent's transcript.

### Path 2 — Agent → Harness Tool → GenerationService → provider API

```text
Claude / Codex / OpenCode
        │  our /mcp toolkit, already injected into all five adapters
        ▼
   GenerationService (server process)
        │  REST / SDK / local process
        ▼
   Meshy REST · Tripo SDK · ElevenLabs REST · ComfyUI /prompt
```

The harness holds `GenerationJob` and `GeneratedAsset`.

### Path 3 — Agent → Harness Tool → GenerationService → Provider MCP

```text
Claude / Codex / OpenCode
        │  our /mcp toolkit
        ▼
   GenerationService, acting as an MCP *client*
        ▼
   provider's MCP server (comfy-mcp, meshy-mcp-server, …)
        ▼
   provider runtime
```

Same ownership as Path 2; the harness→provider leg is MCP instead of REST. This
matters where the provider's MCP server is _better_ than its raw API — PROVIDERS
§8 notes `comfy-mcp` ships exactly `run_workflow` / `job_status` / `wait_for_job`
/ `fetch_outputs`, which is our contract already built by Comfy-Org.

**These are not mutually exclusive.** CHARTER §53 closes with _"Do not force one
architecture across every provider."_ The expected outcome is a per-provider
routing table, not a single winner.

---

## 2. Judgment criteria (charter §53, verbatim list)

developer experience · implementation cost · observability · reliability ·
provider portability · UI integration · cost tracking · permissions · asset
history · remote support.

Two additions this framework proposes, because the research surfaced them as
decision-relevant and §53's list does not name them:

- **Merge debt** — how many _vendor_ files (`packages/contracts/`, `apps/server`
  files re-pulled by `vendor-t3.mjs`) each path forces us to edit. The fork's own
  doctrine is that files we must edit cannot live under vendor.
- **Blast radius on failure** — what breaks for the user when the path fails, and
  whether the failure is legible.

---

## 3. The framework matrix

`DECIDED` = settled by the research wave, evidence in the cell.
`SPIKE-A` / `SPIKE-B` = measured by that micro-spike (§5, §6).
`OPEN` = neither decided nor currently scheduled to be measured — flag if it stays
empty.

| Criterion                                     | Path 1 — Provider MCP                                                                                                                                                                                                                                                                                                                                              | Path 2 — Harness → provider API                                                                                                                                                                                          | Path 3 — Harness → provider MCP                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Implementation cost (transport)**           | **DECIDED: higher than it looks.** All five adapters build a _single-entry_ `mcpServers` block naming `devgame` (SEAMS §6.2: `ClaudeAdapter.ts:4200-4212`, `CodexAdapter.ts:1680-1696`, `CursorAdapter.ts:543-558`, `GrokAdapter.ts:581-595`, `OpenCodeAdapter.ts:1217-1227`). A second entry means either displacing ours or editing five vendor injection sites. | **DECIDED: one directory.** `apps/server/src/mcp/toolkits/generation/`, sibling to `toolkits/preview/`. The `/mcp` server, bearer minting, liveness, revocation and per-tool annotations already exist (SEAMS §6.1–6.2). | Same as Path 2 for the agent leg. **SPIKE-B:** cost of an MCP _client_ inside the server — the codebase is an MCP server today; whether `effect/unstable/ai` gives a client cheaply is **OPEN**. |
| **Implementation cost (per provider)**        | ~zero — the provider maintains it                                                                                                                                                                                                                                                                                                                                  | SPIKE-B — Tripo's `wait_for_task()` SDK helper suggests low (PROVIDERS §7)                                                                                                                                               | SPIKE-B — likely lowest for ComfyUI specifically (PROVIDERS §8)                                                                                                                                  |
| **Developer experience (ours)**               | SPIKE-A                                                                                                                                                                                                                                                                                                                                                            | SPIKE-B                                                                                                                                                                                                                  | SPIKE-B                                                                                                                                                                                          |
| **Developer experience (agent's)**            | SPIKE-A — measure repair loops and whether the agent picks correct provider-specific params unaided                                                                                                                                                                                                                                                                | SPIKE-B                                                                                                                                                                                                                  | SPIKE-B                                                                                                                                                                                          |
| **Observability**                             | **DECIDED: fails the charter's own success criterion.** §69 requires the harness to know _what, why, where, provider, status_. On Path 1 the harness sees a `mcp_tool_call` row and nothing else. CHARTER §18 lists this first among Provider-MCP disadvantages.                                                                                                   | **DECIDED: full.** The harness owns `GenerationJob` and the poll loop (GENERATION_ARCHITECTURE §5, §8)                                                                                                                   | **DECIDED: full**, same ownership                                                                                                                                                                |
| **Reliability / timeouts**                    | SPIKE-A — **and we do not control the tool design.** The tightest-ceiling problem is unchanged: Codex defaults to a **60s** `tool_timeout_sec` vs Claude Code's ~28h, and OpenCode's `timeout` may be connect-time only (TOOLING §3.4). If a provider MCP blocks, Codex breaks and we cannot fix it                                                                | SPIKE-B — we choose job-handle, so the ceiling is ours to meet (GENERATION_ARCHITECTURE §8)                                                                                                                              | SPIKE-B — same as Path 2 agent-side; provider-MCP blocking behaviour is absorbed server-side where no 60s ceiling applies                                                                        |
| **Provider portability**                      | **DECIDED: poor, and charter-violating.** The agent learns Meshy's tool names and Tripo's parameters. CHARTER §71/§74 forbid provider-centric design; CHARTER §19: _"the coding agent doesn't need provider-specific knowledge"_                                                                                                                                   | **DECIDED: by construction.** One `generate_3d`, N adapters                                                                                                                                                              | **DECIDED: same**                                                                                                                                                                                |
| **UI integration**                            | **DECIDED: essentially none without scraping.** MCP tool calls render as a compact wrench row (`MessagesTimeline.tsx:2081-2085`, icon map `:2125-2131`); there is no server-side object for a Generation panel to bind to (SEAMS §5.5)                                                                                                                             | **DECIDED: available.** A dock panel is a registry entry plus a component, no layout-engine change and no workspace-id bump (SEAMS §5.2, §5.3); inline cards follow the `proposed-plan` precedent, ~3 files (SEAMS §5.5) | **DECIDED: same as Path 2**                                                                                                                                                                      |
| **Cost tracking**                             | **DECIDED: impossible in-harness.** No job record exists to attach `actualCost` to. (Note: cost stays out of the core contract either way — CHARTER §46)                                                                                                                                                                                                           | Available as optional metadata                                                                                                                                                                                           | Available as optional metadata                                                                                                                                                                   |
| **Permissions**                               | **DECIDED: delegated to the client, and the clients disagree.** Claude offers 3 options, Codex 4 including a session-scoped allow (TOOLING §2.4); whether a tool is gated at all is _mode_-dependent, not a fixed provider fact (TOOLING §4). CHARTER §47's "Allow paid cloud generation: ask" has no enforcement point                                            | Ours to enforce — but note **OPEN**: every MCP credential is minted `capabilities: new Set(["preview"])` unconditionally today (`McpSessionRegistry.ts:131`), so the gate needs building (SEAMS §6.3)                    | Same as Path 2                                                                                                                                                                                   |
| **Asset history / project ownership**         | **DECIDED: absent.** CHARTER §34 requires generation to belong to the project and survive thread deletion; a provider MCP produces files on disk and a transcript entry, neither of which is project-scoped state                                                                                                                                                  | **DECIDED: available.** Project-scoped by the ratified opaque-`projectId` model (SEAMS §2.1)                                                                                                                             | **DECIDED: same**                                                                                                                                                                                |
| **Remote support**                            | Partial — the agent runs server-side so generation still executes on the host (SEAMS §4.1), but a phone client has **nothing to render and nothing to watch**; CHARTER §44's "dispatch, subscribe, render" collapses to "read the chat log"                                                                                                                        | **DECIDED: available** via `GET /generation-events?projectId=…` modelled on `SpaceEventsRoute` (SEAMS §4.3) plus signed asset URLs (SEAMS §4.4)                                                                          | **DECIDED: same**                                                                                                                                                                                |
| **Merge debt** (added criterion)              | **DECIDED: high** — five vendor adapter files, or displacing the `devgame` entry                                                                                                                                                                                                                                                                                   | **DECIDED: low** — one new fork-owned directory; the one unavoidable vendor touch is the `McpCapability` widening (SEAMS §6.3), which is shared by Paths 2 and 3                                                         | **DECIDED: low**, same as Path 2                                                                                                                                                                 |
| **Blast radius on failure** (added criterion) | SPIKE-A — measure what the user sees when the provider MCP fails to start. Note ACP gives no protocol-level signal that a client-supplied MCP server actually started (TOOLING §4 finding 6, upstream `claude-agent-acp` #883)                                                                                                                                     | SPIKE-B                                                                                                                                                                                                                  | SPIKE-B                                                                                                                                                                                          |
| **Credential handling**                       | **DECIDED: worse.** The provider MCP needs the key in the agent's environment. Path 2/3 keep it in `ServerSecretStore`, `0600`, never crossing the wire (SEAMS §3)                                                                                                                                                                                                 | **DECIDED: good**                                                                                                                                                                                                        | **DECIDED: good**                                                                                                                                                                                |

### 3.1 What the already-decidable cells add up to

Nine cells are decided before either spike runs, and eight of them favour
Paths 2/3. That is not a verdict — **Path 1's whole claim is speed, and speed is
measured, not reasoned about.** CHARTER §51 states its purpose exactly: _"understand
how far existing agent tooling gets us for almost free."_ The framework's job is to
put a number on "almost free" and set it against a column of structural losses that
are already known.

The one cell that could still surprise us: if Micro-Spike A shows a provider MCP
reaching a working Unity import in a fraction of Path 2's effort **and** the agent
drives it reliably without repair loops, Path 1 becomes a legitimate _bootstrap_
posture — ship provider MCP for a modality we do not yet own, while Path 2 carries
the modality the product demos. Charter §53's "do not force one architecture" leaves
that door open deliberately.

---

## 4. Per-provider routing (the expected shape of the answer)

Not a conclusion — a hypothesis for the spikes to confirm or overturn, one row per
provider, since §53 explicitly refuses a single global answer.

| Provider            | Hypothesised path                   | Reason                                                                                                                                                                                                                                                    | Confidence                                                           |
| ------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Tripo**           | Path 2 (direct API)                 | Single create-and-poll round trip; official Python SDK with a `wait_for_task()` helper that collapses create+poll+download (PROVIDERS §7)                                                                                                                 | Medium — rests on Tripo winning §7's provider choice                 |
| **Meshy**           | Path 2 (direct API)                 | Well-documented REST, rate-limit table, `progress` + `preceding_tasks`; two-stage preview→refine is more code but maps onto our own propose→validate approval pattern (PROVIDERS §1, §7)                                                                  | Medium                                                               |
| **ComfyUI (local)** | **Path 3** (harness → provider MCP) | `comfy-mcp` ships `run_workflow` / `job_status` / `wait_for_job` / `fetch_outputs` — our contract, already built and first-party (PROVIDERS §8). Also has a real `/interrupt`, the only VERIFIED cancellation in the matrix (PROVIDERS §6.1)              | Medium-low — contingent on the server-side MCP-client cost (SPIKE-B) |
| **ElevenLabs**      | Path 2 (direct API)                 | Synchronous REST; the simplest provider in the set, and forcing MCP between us and it adds a hop for nothing (PROVIDERS §6.2 shape 2)                                                                                                                     | Medium                                                               |
| **Unsloth (local)** | **Neither yet**                     | Its image-generation surface is not documented as a public API at all — only a Desktop GUI workflow (PROVIDERS §3.2). Integrating today means reverse-engineering an internal unversioned interface. PROVIDERS §8 recommends ComfyUI instead, "not close" | High (as a _deferral_)                                               |

---

## 5. Micro-Spike A — Agent → Provider MCP (charter §51)

**Question it answers:** how far does existing agent tooling get us for almost free?

**Setup:** inject one provider's official MCP server into a real session. All of
Meshy, Tripo, ComfyUI and ElevenLabs ship official MCP servers (PROVIDERS §6.1) —
Meshy's is `npx -y @meshy-ai/meshy-mcp-server` and is **plan-gated to Pro or
higher**, which is itself a cost datum. Note the injection problem up front: the
five adapters each build a single-entry `mcpServers` block, so this spike must
either temporarily displace the `devgame` entry or patch one adapter. **Displace,
don't patch** — it is throwaway either way, and displacing keeps the diff to one
file.

**Must measure — one row per item, on both Claude Code and Codex:**

| #   | Measurement                                                                                       | Why it decides something                                                                          |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A1  | Wall-clock and file-count to first successful generation                                          | The only claim Path 1 makes                                                                       |
| A2  | Does the call block? For how long? Does it survive Codex's 60s `tool_timeout_sec`?                | TOOLING §3.4 — if the provider MCP blocks, Path 1 is broken on Codex and we cannot fix it         |
| A3  | Repair loops: how many turns before the agent produces valid provider-specific parameters unaided | CHARTER §51 "agent reliability"; also the direct measure of the §71/§74 portability objection     |
| A4  | What does the harness observe? Enumerate every field visible to the server                        | CHARTER §69 requires _what/why/where/provider/status_. Count how many of the five are recoverable |
| A5  | Where do output files land, and is that path project-scoped?                                      | CHARTER §34/§72 — asset ownership                                                                 |
| A6  | Is progress visible anywhere? Cancellation available?                                             | CHARTER §51 "progress, cancel"                                                                    |
| A7  | Metadata returned: triangles, materials, texture size?                                            | CHARTER §25 — the technical-evidence layer the 3D review loop needs                               |
| A8  | What the user sees when the provider MCP fails to start                                           | TOOLING §4 finding 6 — no protocol signal that a client-supplied MCP server started               |
| A9  | Does an image/preview content block come back, and does the model actually see it?                | Only Claude Code's docs confirm image content in tool results (TOOLING §4 finding 7)              |
| A10 | Credential placement: where did the API key have to live?                                         | SEAMS §3 — anything outside `ServerSecretStore` is a regression                                   |

**Cheap and mandatory precondition** (PROVIDERS §7): create a Tripo API key on a
brand-new account and check whether it starts with a nonzero credit balance. This
single check decides Tripo-vs-Meshy for both spikes and takes two minutes.

---

## 6. Micro-Spike B — Harness-owned GenerationService (charter §52)

**Question it answers:** what does the thinnest possible harness-owned path
actually cost, and does it deliver what Path 1 structurally cannot?

**Setup:** the thinnest thing that persists a `GenerationJob` and a
`GeneratedAsset`. Explicitly _not_ the full architecture — no dock panel, no
event-sourced decisions, no permission gating. One tool, one provider, one
in-memory registry, one file on disk.

**Must measure:**

| #   | Measurement                                                                                                                | Why it decides something                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Wall-clock and file-count to first successful generation, **measured the same way as A1**                                  | The comparison is meaningless unless the workloads match (a discipline this repo's own root `HANDOFF.md` §9.5 already insists on for a different bake-off) |
| B2  | Cost of the `McpCapability` widening, landed as its own PR with a red-first test                                           | SEAMS §6.3 — the one unavoidable vendor touch, shared by Paths 2 and 3. If this is expensive, it is expensive for both harness-owned paths                 |
| B3  | Does `generate_3d` returning `{jobId}` + `generation_status(jobId)` behave identically on Claude Code, Codex and OpenCode? | GENERATION_ARCHITECTURE §8's central bet                                                                                                                   |
| B4  | Does `structuredContent` survive to the model on each of the three?                                                        | TOOLING §4 finding 7 — confirmed for at most one of three today                                                                                            |
| B5  | Does an image content block built via the `registerPreviewSnapshot` idiom (`McpHttpServer.ts:130-204`) reach the model?    | The entire 3D-review loop (CHARTER §24, §64) depends on it                                                                                                 |
| B6  | Server-side MCP-client cost, if Path 3 is attempted for ComfyUI                                                            | The only genuinely **OPEN** implementation-cost cell in §3                                                                                                 |
| B7  | Poll-loop traffic volume on the progress channel                                                                           | SEAMS §8.5 — unmeasured; decides whether level-broadcast framing needs throttling                                                                          |
| B8  | Does the job survive: agent session end · desktop app close · client reconnect?                                            | CHARTER §66 Q13/Q14/Q15; UNSLOTH §3's adopt-don't-reissue pattern is the intended answer                                                                   |
| B9  | Cancellation: local state vs upstream outcome per provider                                                                 | Provider-side cancel is UNCERTAIN on four of five (PROVIDERS §6.1); this converts guesses into a `CancelOutcome` value                                     |
| B10 | Does the same tool work unchanged against a second provider?                                                               | The portability claim, tested rather than asserted                                                                                                         |

**Comparison discipline:** A1 and B1 must use the same provider, the same target
asset, the same agent, and the same prompt. Different workloads produce a
comparison that reads as evidence and is not.

---

## 7. Prerequisites shared by both spikes

Three things must be true before either spike's numbers mean anything. All three
are cheap; two are already flagged in TOOLING §6.

1. **Confirm the `devgame` MCP toolkit actually reaches each agent in _this_
   repo.** SEAMS §6.2 traces the wiring and I verified `prepareMcpSession` is
   called at `ProviderService.ts:400` and `:596` with all five adapters consuming
   `readMcpProviderSession` — but static reading is not a round trip. One live
   turn per provider that invokes an existing preview tool settles it.
   (TOOLING §1's contrary finding is about a different codebase — see
   GENERATION_ARCHITECTURE.md's reconciliation note.)
2. **Close the OpenCode round-trip gap.** No capture anywhere shows OpenCode
   completing a custom-tool call, only that the `mcpServers` array was wired
   (TOOLING §2.4). "Wired" and "round-tripped" are different claims.
3. **Resolve the two timeout-semantics questions** with a throwaway
   `sleep_and_report(seconds)` tool at 5s / 65s / 130s per provider (TOOLING §6.4).
   This converts the single most decision-relevant row in §3 (Reliability /
   timeouts) from inference to measurement, and it must run **before** A2, since
   A2's result is uninterpretable without a known baseline.

---

## 8. How to read the completed matrix

When the spikes fill this in, the decision rule is **not** "count the wins."

- Path 1 wins only if A1 is dramatically better than B1 **and** A3 shows the agent
  driving it reliably **and** the harness can still satisfy CHARTER §69's
  what/why/where/provider/status (A4). Any one of those failing makes Path 1 a
  bootstrap tactic at most, not an architecture.
- Path 2 vs Path 3 is decided per-provider on B6 and on whether the provider's MCP
  server is materially better than its raw API. It is a transport question with no
  product consequence — both own the job record identically.
- A result that says "Path 1 is fast and blind" is the expected result. The value
  of running Micro-Spike A anyway is that "blind" becomes a measured list of
  missing fields rather than an argument, and that the fast path stays available
  for modalities the product does not intend to own.

---

## 9. Open questions this framework cannot close

1. Whether an MCP **client** is cheap inside the server process (blocks Path 3's
   cost cell entirely).
2. Whether `generation` should be an unconditional MCP capability grant or gated
   per-thread/per-project — a security-consequential product decision, and the
   only enforcement point for CHARTER §47's paid-generation gate
   (SEAMS §6.3, §8.3).
3. Whether a provider MCP can be injected _alongside_ `devgame` rather than
   displacing it, without editing five vendor adapters. Not investigated; if a
   shared injection helper exists upstream it would change Path 1's cost cell
   materially.
