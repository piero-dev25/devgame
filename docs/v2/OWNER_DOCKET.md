# V2 Owner Docket — decisions only you can make

Compiled 2026-08-11 from research waves 1–2 (evidence in `notes/` and the
draft architecture docs). Ordered by how hard they block the vertical
spike.

> **RESOLVED 2026-08-12:**
> **D1 → APPROVED (option a).** Re-admit `eval` narrowly: harness-authored,
> allowlisted, read-only inspection snippets only, never agent-composed C#.
> **D1-write → APPROVED 2026-08-12 (extends D1 for Increment 2a).** The
> material bind (glTF→URP) has no named-tool path, so it needs a harness-
> authored FIXED WRITE eval. Owner ruling: write-evals are fine "if that's
> something Unity is supporting and how people write custom code for the
> agent↔pipeline" — both hold: `eval` is a first-class Unity pipeline command
> (live 140-tool surface), the idiomatic custom-authoring seam. D1 now reads:
> harness-authored, allowlisted, FIXED snippets — read OR write — NEVER
> agent-composed C#, NEVER interpolating tool/agent input into the snippet.
> **D3 → RESOLVED, no payment needed.** Tripo key "DevGame Generation"
> created + stored 0600 at `~/.config/devgame/tripo-api-key`; the claimable
> **free trial wallet (600 credits, valid to 2026-08-26) IS API-usable** —
> live-verified `balance:600`. ⚠️ Build against **API v3** — v2 retires
> 2026-10-01 (full shutdown 11-01).
> **Spike-scope defaults taken** (flagged for a production ruling later):
> D2 → grant `generation` capability for the single-user spike; gate PAID
> providers inside GenerationService. D4 → write generated files to the
> **canonical** Assets/ (only place the Editor sees them). D6 → nested
> `engineImport` field for the first migration; promote to a separate
> record if re-import demand appears. D5/D7 → not reached by the spike.

## D1 — Re-admit `eval` for technical inspection? (BLOCKS inspect_generation)

The live 140-tool enumeration proved the vertical spike is covered by
named Pipeline tools **except** technical inspection: no named tool
returns computed mesh facts (triangles, materials, texture sizes,
bounds, rig). Only `eval` (real C#) can — and `eval` is excluded from
`UnityPipelineClient` by your explicit earlier ruling (it is unconfined
by `set_authoring_root`).

Options: (a) re-admit `eval` **narrowly** — harness-authored, allowlisted,
read-only inspection snippets only, never agent-composed C#; (b) defer
automated technical review until Unity ships a named inspection tool
(charter §63's "major product moat" waits); (c) inspect the GLB
**before** import with our own parser (no Unity involved — partial
coverage, no scene context). **Recommendation: (a) with hard rails.**

## D2 — Is `generation` an MCP capability every session gets?

**IMPLEMENTED in Increment 1** (spike-scope default from the RESOLVED block
above): `McpSessionRegistry.ts:issue` now mints `capabilities: new
Set(["preview", "generation"])` unconditionally. The capability _type_
widening (#116) is closed; the _grant_ is now broad, matching D2's
spike-scope default. Charter §47's "Allow paid cloud generation → ask" has
NO teeth at this capability layer as shipped — PAID-provider gating is
enforced inside GenerationService/TripoProvider (a valid credential is
required to submit any job at all; there is no cost cap or per-request
approval prompt). Revisit before a multi-user or untrusted-agent
deployment: gate per-thread/project (where the §47 permission model
belongs) is still the option to reach for if this needs teeth later.

## D3 — Tripo account + API key (5-minute owner action, decides the 3D spike)

Research verdict: **Tripo over Meshy** (single-step task API vs mandatory
two-stage; Meshy's free tier has NO API access at all). The one unknown:
whether Tripo's 300 free credits apply to its API. Action: create a
Tripo account + API key, check the credit balance against an API call.
If free credits don't cover API use, the spike needs a small paid
top-up on one of the two (your call which).

## D4 — Where do generated files get written: worktree or canonical root?

Unity routes deliberately resolve the **canonical** root (the Editor
binds there); the Diff panel deliberately prefers `worktreePath ??
workspaceRoot`. A generated .glb must land where the Editor sees it
(canonical Assets/) — but that bypasses worktree isolation for agent
runs. The file write and the Editor import may legitimately need
different answers; needs your ruling before the import step is built.

## D5 — Serving generated media to remote clients

Extend the vendor `AssetResource` union (smaller code, permanent merge
surface in packages/contracts) vs a fork-owned signed asset route
(more code, zero vendor edits). Doctrine leans fork-owned; the seams
note documents both costs.

## D6 — `AssetImport`: separate record vs nested `engineImport` field

Cheap to decide, expensive to re-decide after the first migration.
Separate record matches "one asset, many imports" (re-import after
regeneration; multiple engines later).

## D7 — Approval-timeout default for a paused agent turn

When an agent waits on your §47 approval and you don't answer: Unsloth
defaults to 1h then denies (their own code flags this as questionable).
Options: deny-on-timeout (safe, agent turn continues degraded), park the
turn indefinitely, or configurable-with-a-default.

## Owner actions checklist (not decisions)

- [ ] D3: Tripo account + API key (+ note whether free credits work on the API)
- [ ] Optional: ElevenLabs key if the audio spike should follow immediately
      (free tier forbids commercial use — fine for a spike)

## Already ruled / no action needed

- Windows not promoted on the website (ruled 2026-08-11, applied).
- The canonical tool server question (§17): moot — already shipped.
- Async model: job-handle + server-owned polling (forced by OpenCode's
  verified 65s timeout; Codex's assumed 60s did NOT reproduce).
- First local image backend hypothesis: ComfyUI over Unsloth (Unsloth
  has no programmatic image API).
