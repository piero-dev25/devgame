# Provider Matrix — Asset-Generation Backends

**Scope:** Meshy, Tripo, Unsloth (as local backend), ComfyUI, ElevenLabs.
**Research date:** 2026-08-11. **Researcher:** single web-research lane, sequential (one provider at a
time, official docs first), no parallel fan-out per task discipline.

---

## 0. Method note — charter mismatch, flagged before the content

The dispatch pointed at `docs/v2/HANDOFF.md` §38-41 as the charter for this table. **That file does
not exist in this checkout.** `docs/v2/` contains exactly one prior artifact,
`docs/v2/notes/agent-tooling.md`, which hit the identical mismatch three hours earlier and recorded it
in its own §0: the repo's only charter-shaped document is `HANDOFF.md` at the repo root (26 sections,
dated 2026-07-31, about substrate selection for the agent-client layer — T3 vs ACP vs Codeg — and
contains no mention of Meshy, Tripo, Unsloth, ComfyUI, ElevenLabs, or any asset-generation vertical).
`/usr/bin/grep -rn "38\." docs/v2` and a repo-wide search for `PROVIDER_MATRIX`, `generate_3d`, `asset
generation` turned up nothing pre-existing except that one prior note, which independently arrived at
a `generate_3d`/`generation_status` job-handle tool design (its §5) while investigating MCP tool
delivery across Claude Code, Codex, and OpenCode.

**This document does not depend on the missing charter.** The task brief that dispatched this lane was
fully self-contained (five named providers, an explicit capability list, an explicit ergonomics/
pricing/licensing/SDK rubric, an explicit VERIFIED/UNCERTAIN discipline, and two explicit closing
recommendations), so the work below follows that brief directly. The charter-mismatch is recorded here
only so the orchestrator can reconcile it — flagging a gap is not the same as blocking on it.

**Evidence standard**, matching the repo's own convention from `docs/v2/notes/agent-tooling.md` §0:
**VERIFIED** = quoted or closely paraphrased from an official vendor doc/pricing/terms page fetched
during this research pass (URL given inline). **UNCERTAIN** = the claim could not be pinned to an
official first-party source — either no official page states it, official pages contradicted each
other, or the only sources found were third-party resellers/wrappers/summarizers. An UNCERTAIN cell is
not a guess dressed up; it is a flag for the live spike to resolve by actually calling the API.

---

## 1. Meshy

Official docs: `docs.meshy.ai` · Pricing: `www.meshy.ai/pricing` · Terms/ownership: `help.meshy.ai`.

### 1.1 Capabilities

| Capability         | Status                       | Evidence                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text → image       | **YES** — VERIFIED           | `POST /openapi/v1/text-to-image`, models incl. `nano-banana`, `gpt-image-2` ([docs.meshy.ai/en/api/text-to-image](https://docs.meshy.ai/en/api/text-to-image))                                                                                                                                                                                                        |
| Image → image      | **YES** — VERIFIED           | Image to Image endpoint listed in nav; billed as "text-to-image and image-to-image editing" ([www.meshy.ai/api](https://www.meshy.ai/api))                                                                                                                                                                                                                            |
| Text → 3D          | **YES** — VERIFIED           | `POST /openapi/v2/text-to-3d`, preview+refine two-stage ([docs.meshy.ai/en/api/text-to-3d](https://docs.meshy.ai/en/api/text-to-3d))                                                                                                                                                                                                                                  |
| Image → 3D         | **YES** — VERIFIED           | `POST /openapi/v1/image-to-3d`, single image required ([docs.meshy.ai/en/api/image-to-3d](https://docs.meshy.ai/en/api/image-to-3d))                                                                                                                                                                                                                                  |
| Multiview → 3D     | **YES** — VERIFIED           | "multi-image-to-3D" billed separately ([www.meshy.ai/api](https://www.meshy.ai/api)); `input_task_id` chains a Text/Image-to-Image output into Image-to-3D, and `multi_view_thumbnails:true` renders 4 cardinal views                                                                                                                                                 |
| Texturing          | **YES** — VERIFIED           | Refine-mode `texture_prompt`/`texture_image_url`/`enable_pbr` on Text-to-3D; separate "Retexture" task type appears in the webhooks task-type list                                                                                                                                                                                                                    |
| Remesh             | **YES** — VERIFIED           | Dedicated Remesh API, `docs.meshy.ai/en/api/remesh`                                                                                                                                                                                                                                                                                                                   |
| Rigging            | **YES** — VERIFIED           | Auto-rigging API adds a skeleton to humanoid models ([docs.meshy.ai/en/api/rigging-and-animation](https://docs.meshy.ai/en/api/rigging-and-animation))                                                                                                                                                                                                                |
| Animation          | **YES** — VERIFIED           | `POST /openapi/v1/animations` applies a library action to a rigged character ([docs.meshy.ai/en/api/animation](https://docs.meshy.ai/en/api/animation), library at `.../animation-library`)                                                                                                                                                                           |
| TTS                | **NO**                       | Not offered anywhere in Meshy's product surface                                                                                                                                                                                                                                                                                                                       |
| SFX                | **NO**                       | Not offered                                                                                                                                                                                                                                                                                                                                                           |
| Local runtime      | **NO**                       | Cloud SaaS only. A "ComfyUI nodes" integration exists but it calls the cloud API — it is not a local model                                                                                                                                                                                                                                                            |
| Cloud API          | **YES** — VERIFIED           | REST, `api.meshy.ai/openapi/*`                                                                                                                                                                                                                                                                                                                                        |
| MCP availability   | **YES, official** — VERIFIED | `github.com/meshy-dev/meshy-mcp-server`, installable via `claude mcp add meshy -- npx -y @meshy-ai/meshy-mcp-server`; requires a Pro-or-higher plan since API access is plan-gated ([help.meshy.ai MCP setup article](https://help.meshy.ai/en/articles/16102957-meshy-mcp-server-and-ai-coding-agent-setup))                                                         |
| Progress reporting | **YES** — VERIFIED           | Poll response carries `progress` (0–100) and `preceding_tasks` (queue position); text-to-image additionally supports SSE streaming per the endpoint list                                                                                                                                                                                                              |
| Cancellation       | **UNCERTAIN**                | `DELETE /openapi/.../{task_id}` exists on every task type and "permanently deletes a task, including all associated models and data" — but the docs describe it as record deletion, not a documented graceful-interrupt-of-a-running-generation semantic. Whether an in-flight `IN_PROGRESS` task actually stops compute or just gets its record wiped is unconfirmed |
| Webhooks           | **YES** — VERIFIED           | Account-level (not per-request): configure up to 5 HTTPS webhook URLs in the web app; covers Text-to-3D, Image-to-3D, Multi-Image-to-3D, Remesh, Retexture, Rigging, Animation. No HMAC/signature verification documented ([docs.meshy.ai/en/api/webhooks](https://docs.meshy.ai/en/api/webhooks))                                                                    |

### 1.2 API ergonomics

- **Auth:** Bearer API key, `Authorization: Bearer ${YOUR_API_KEY}`. VERIFIED.
- **Job semantics:** Async, task-ID + poll (`GET .../{id}`) or webhook. Text-to-3D is explicitly
  **two-step** (create `preview` task → poll to `SUCCEEDED` → create `refine` task referencing
  `preview_task_id` → poll again) — more round-trips than Image-to-3D's single create-and-poll.
  Status enum: `PENDING → IN_PROGRESS → SUCCEEDED | FAILED | CANCELED`. VERIFIED.
- **Output formats:** GLB, OBJ, FBX, STL, USDZ, 3MF (3MF only when explicitly requested via
  `target_formats`). GLB is directly present as `model_urls.glb`. VERIFIED.
- **Rate limits (by plan):** Pro/Premium/Studio/Ultra all **20 requests/sec**; queue depth varies —
  Pro 10, Premium 30, Studio 20, Ultra 100 concurrently queued tasks; Enterprise 100 RPS / 50
  (customizable) queued. `429` on breach, distinguishing `RateLimitExceeded` from
  `NoMoreConcurrentTasks`. VERIFIED — [docs.meshy.ai/en/api/rate-limits](https://docs.meshy.ai/en/api/rate-limits).
- **SDK maturity:** Official Python SDK, official Node.js SDK, official MCP server, official ComfyUI
  node pack, and a listed Cursor skill / Claude Code skill. VERIFIED at the existence level (github.com/meshy-dev org); version/release-cadence maturity of the SDKs themselves not independently audited in this pass — **UNCERTAIN** beyond "they exist and are first-party."

### 1.3 Pricing (rough, dated 2026-08-11 — do not hardcode into any contract)

Free plan: $0/mo, 100 credits/mo, **no API access**. Pro: $20/mo (or $240/yr), 1,000 credits/mo, API
included. Premium: $40/mo. Studio: $70/mo base (team seats +$10/mo each) — note a secondary source
gave $60/mo for Studio; the pricing page's own $70/mo figure is the one taken as authoritative since it
was fetched directly. Ultra: $100/mo. Enterprise: custom. Credit costs: image ~3cr, a full 3D mesh
(mesh+texture) 20cr, texturing alone 10–15cr, remesh 5cr, format conversion 1cr, animation ~3cr,
auto-rig 5cr. VERIFIED (`www.meshy.ai/pricing`, `www.meshy.ai/api`) with one internal inconsistency
flagged (Studio $60 vs $70 across two official-looking fetches — re-check before quoting a number to a
user).

### 1.4 Licensing / commercial usage of generated assets

**Paid plans:** full private ownership of generated assets, no attribution required, provided the
model is not published to the public Meshy Community and source materials didn't infringe others'
copyright. **Free plan:** Meshy grants a **CC BY 4.0** license instead of ownership — commercial use
IS permitted, but requires crediting Meshy in the project description. Ownership rights are locked in
at generation time (downgrading later doesn't retroactively strip paid-tier rights from
already-generated assets). VERIFIED — direct quotes from
[help.meshy.ai ownership article](https://help.meshy.ai/en/articles/10137554-what-is-the-ownership-of-the-generated-models)
and [help.meshy.ai commercial-use article](https://help.meshy.ai/en/articles/9992001-can-i-use-my-generated-assets-for-commercial-projects).
**For a shipped game: use a paid plan.** Free-tier CC BY 4.0 attribution is workable for a spike but is
an unusual (and easy-to-forget) obligation to carry into a shipped product's credits screen.

---

## 2. Tripo

Official docs: `docs.tripo3d.ai` (OpenAPI reference), `developers.tripo3d.ai` (developer portal),
`platform.tripo3d.ai` (API console — JS-rendered SPA, largely unscrapable by static fetch in this
pass). Terms: `www.tripo3d.ai/terms`.

### 2.1 Capabilities

| Capability         | Status                                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Text → image       | **YES** — VERIFIED                                       | "Generate image" endpoint listed in the platform docs sidebar; also surfaced as a billed line item ("Text to Image: 5 credits")                                                                                                                                                                                                                                                                                          |
| Image → image      | **UNCERTAIN**                                            | An "Editing" endpoint exists in the platform docs sidebar and image-generation pricing lists "advanced image creation capabilities," but no page was fetched that unambiguously confirms an image-to-image (as opposed to image-edit-in-place) mode distinct from Editing                                                                                                                                                |
| Text → 3D          | **YES** — VERIFIED                                       | `POST /v3/generation/text-to-model` (also referenced as `/v2/openapi/...`), model versions P1/H3/H2/Turbo-v1.0/v1.4                                                                                                                                                                                                                                                                                                      |
| Image → 3D         | **YES** — VERIFIED                                       | Requires exactly one image                                                                                                                                                                                                                                                                                                                                                                                               |
| Multiview → 3D     | **YES** — VERIFIED                                       | Accepts 2–4 images of the same object; paired "Generate multiview image" endpoint to produce the source views                                                                                                                                                                                                                                                                                                            |
| Texturing          | **YES** — VERIFIED                                       | "AI Texture" endpoint, v3.0/v2.5 variants                                                                                                                                                                                                                                                                                                                                                                                |
| Remesh             | **YES** — VERIFIED                                       | "Retopology" and "Smart low poly" mesh operations                                                                                                                                                                                                                                                                                                                                                                        |
| Rigging            | **YES** — VERIFIED                                       | "Auto Rig & Animations," with a documented "pre-rig validation" step                                                                                                                                                                                                                                                                                                                                                     |
| Animation          | **YES** — VERIFIED                                       | Dedicated Animation endpoint + Post Process step                                                                                                                                                                                                                                                                                                                                                                         |
| TTS                | **NO**                                                   | Not offered                                                                                                                                                                                                                                                                                                                                                                                                              |
| SFX                | **NO**                                                   | Not offered                                                                                                                                                                                                                                                                                                                                                                                                              |
| Local runtime      | **NO**                                                   | Cloud SaaS only                                                                                                                                                                                                                                                                                                                                                                                                          |
| Cloud API          | **YES** — VERIFIED                                       | Base `https://api.tripo3d.ai/v2/openapi`                                                                                                                                                                                                                                                                                                                                                                                 |
| MCP availability   | **YES, official** — VERIFIED                             | `github.com/VAST-AI-Research/tripo-mcp` — official, generation tools work standalone; its Blender-import feature additionally needs Blender running locally with an addon listening on `localhost:9876` (a separate, optional dependency, not required for pure generation calls)                                                                                                                                        |
| Progress reporting | **YES** — VERIFIED                                       | Poll response includes `progress` (0–100); a completed task shows `status:"success"`, `progress:100`                                                                                                                                                                                                                                                                                                                     |
| Cancellation       | **UNCERTAIN**                                            | No cancel/delete-task endpoint was found in this pass; the OpenAPI schema page (`platform.tripo3d.ai/docs/schema`) could not be scraped statically to confirm or rule this out                                                                                                                                                                                                                                           |
| Webhooks           | **YES, capability-level VERIFIED / mechanism UNCERTAIN** | `developers.tripo3d.ai` states plainly: "Results are pushed when tasks complete — no polling required." The exact request-body field name to register a callback URL (`callback_url`? `webhook_url`?) could not be confirmed from an official page in this pass — the only sources that named a specific field were third-party API resellers (APIDot, Pixazo, fal.ai), which is not evidence for Tripo's own field name |

### 2.2 API ergonomics

- **Auth:** Bearer API key, `Authorization: Bearer {api_key}`. VERIFIED.
- **Job semantics:** Async, task-ID + poll `GET /v3/tasks/{task_id}` every ~2s (typical generation
  10–120s), OR webhook push (see above). Single-step for Image-to-3D/Text-to-3D (no separate
  preview/refine split the way Meshy has one) — **fewer round-trips than Meshy for an equivalent
  result.** VERIFIED via `developers.tripo3d.ai/en/docs/quick-start`.
- **Output formats:** "GLB, FBX, OBJ, USDZ and other mainstream formats." VERIFIED at the format-list
  level; did not independently confirm every format the way Meshy's docs enumerate `target_formats`.
- **Rate limits:** "Independent concurrency quotas for each task type, so peak loads never compete" —
  VERIFIED at the qualitative level; no numeric RPS/queue-depth table was found in this pass
  (**UNCERTAIN** for exact numbers, unlike Meshy's published table).
- **SDK maturity:** Official Python SDK on PyPI (`tripo3d`), described as having "complete type hints
  and async support" plus a `wait_for_task()` convenience helper that handles create+poll+download in
  one call — VERIFIED (`pypi.org/project/tripo3d`, `github.com/VAST-AI-Research/tripo-python-sdk`).
  This is a materially lower-friction starting point than Meshy's raw-REST-first documentation style.

### 2.3 Pricing (rough, dated 2026-08-11)

Studio/consumer subscriptions (separate line of business from the API): Free "Basic" 300 credits/mo;
Pro $19.90/mo for 3,000 credits (secondary sources also cite a differently-tiered "Max $89.90/Team
$109.90" ladder — **inconsistent across sources, UNCERTAIN which is current**). **API billing is a
separate, credit-based, pay-as-you-go system** (`1 credit = $0.01`), independent of the Studio
subscription: image ~$0.05 (5cr), a 3D model ~$0.10–0.20 (10–20cr), texture pass ~$0.05–0.15 (5–30cr),
auto-rig ~$0.25 (25cr minimum). VERIFIED for the credit-to-dollar rate and the per-service floor;
**UNCERTAIN whether the 300 free Studio credits/month are usable against the API at all** — one search
result explicitly stated the API "operates on a separate usage-based billing system and is not an
add-on to Tripo Studio subscriptions," which argues no free API tier exists, but this was not
confirmed from an official pricing page (the official platform pricing page did not render for static
fetch in this pass).

### 2.4 Licensing / commercial usage of generated assets

**Free tier: no commercial use at all** — "strictly for personal, non-commercial use," cannot sell
prints, distribute files for profit, or use in commercial projects. **Paid tiers:** broad rights —
"use, copy, reproduce, modify, adapt, publish, translate, create derivative works from, distribute, and
license" outputs on a royalty-free, perpetual, worldwide, non-exclusive basis; Tripo commits not to use
Paid Users' inputs/outputs as AI training data. VERIFIED — [www.tripo3d.ai/terms](https://www.tripo3d.ai/terms),
corroborated by [www.tripo3d.ai/blog/who-owns-ai-generated-3d-models](https://www.tripo3d.ai/blog/who-owns-ai-generated-3d-models).
Note this is **stricter than Meshy's free tier**, which at least permits commercial use with
attribution (CC BY 4.0) — Tripo's free tier permits no commercial use whatsoever, full stop.

---

## 3. Unsloth (as local backend)

Official docs: `unsloth.ai/docs` · Repo: `github.com/unslothai/unsloth`.

**Framing note, load-bearing for everything below:** Unsloth is fundamentally an **LLM
fine-tuning/inference framework** that has expanded into a general local-model runtime (Unsloth
Desktop/Studio) covering LLMs, diffusion image/video models, and audio models under one local app —
not a purpose-built game-asset-generation product the way Meshy/Tripo are. Its relevance to this matrix
is specifically as a **candidate local runtime for text-to-image / image-to-image generation**, run
fully on the user's own GPU with no per-call cloud cost.

### 3.1 Capabilities

| Capability                             | Status                                                     | Evidence                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text → image                           | **YES** — VERIFIED                                         | "Create" workflow; supports FLUX, FLUX.1 Kontext, FLUX.2 klein, SDXL, Qwen-Image, Qwen-Image-Edit, Z-Image ([unsloth.ai/docs/basics/diffusion-image](https://unsloth.ai/docs/basics/diffusion-image))                                                                                                                              |
| Image → image                          | **YES** — VERIFIED                                         | "Transform," "Edit," "Inpaint," "Extend," "Reference" workflows on compatible models                                                                                                                                                                                                                                               |
| Text → 3D                              | **NO**                                                     | Not found anywhere in Unsloth's documented model roster                                                                                                                                                                                                                                                                            |
| Image → 3D                             | **NO**                                                     | Not found                                                                                                                                                                                                                                                                                                                          |
| Multiview → 3D                         | **NO**                                                     | Not found                                                                                                                                                                                                                                                                                                                          |
| Texturing (3D sense)                   | **NO**                                                     | N/A — Unsloth has no 3D pipeline                                                                                                                                                                                                                                                                                                   |
| Remesh                                 | **NO**                                                     | N/A                                                                                                                                                                                                                                                                                                                                |
| Rigging                                | **NO**                                                     | N/A                                                                                                                                                                                                                                                                                                                                |
| Animation (skeletal, game-asset sense) | **NO**                                                     | Video-generation models (LTX, Wan) are listed under Desktop's "Diffusion (Image/Video)" support, which is video clip generation, not skeletal rigging/animation — different capability, do not conflate                                                                                                                            |
| TTS                                    | **YES** — VERIFIED                                         | Unsloth Desktop's "Audio" category lists text-to-speech alongside speech-to-text (Whisper, Qwen3-ASR) ([unsloth.ai/docs/desktop](https://unsloth.ai/docs/desktop))                                                                                                                                                                 |
| SFX                                    | **UNCERTAIN**                                              | TTS/STT are confirmed; no dedicated sound-effect or music-generation model was found named in Unsloth's docs (contrast ComfyUI's native ACE-Step)                                                                                                                                                                                  |
| Local runtime                          | **YES** — VERIFIED                                         | The whole point of the product: "Once a model is downloaded, image generation runs on your device," CPU/NVIDIA/Intel/AMD/Mac GPU support                                                                                                                                                                                           |
| Cloud API                              | **NO**                                                     | By design — no hosted Unsloth generation service found; Unsloth is local-only                                                                                                                                                                                                                                                      |
| MCP availability                       | **NO first-party for generation** — VERIFIED as an absence | `unsloth.ai/docs/basics/mcp` documents Unsloth as an **MCP client** — i.e. local models served by Unsloth can call out to _other_ MCP servers — not Unsloth exposing its own image/TTS tools as an MCP server. A third-party unofficial `unsloth-mcp-server` exists but is scoped to fine-tuning/tokenizer tooling, not generation |
| Progress reporting                     | **PARTIAL / UNCERTAIN**                                    | `GET /api/train/status` returns a `TrainingProgress` object (step count, loss, ETA) — but that is for **fine-tuning jobs**, not image-generation calls. No documented progress/job-status endpoint for a diffusion image generation request was found (third-party DeepWiki source, itself flagged uncertain-completeness)         |
| Cancellation                           | **PARTIAL / UNCERTAIN**                                    | `POST /api/train/stop` exists for training jobs (same third-party-sourced caveat); no documented cancel-in-flight-image-generation endpoint found                                                                                                                                                                                  |
| Webhooks                               | **NO**                                                     | Not found anywhere; this is local software with no evidence of a webhook design                                                                                                                                                                                                                                                    |

### 3.2 API ergonomics — the central finding for this provider

**Unsloth's LLM inference has a clean, well-documented OpenAI/Anthropic-compatible HTTP API. Its
image-generation surface does not have an equivalently documented programmatic API.**

- **LLM chat/completions API:** `POST /v1/chat/completions`, `POST /v1/messages` (Anthropic-shaped),
  `GET /v1/models`, served locally via `llama-server` at e.g. `http://localhost:8888`, auth via
  `Authorization: Bearer sk-unsloth-…`. Streaming supported. This part is mature and VERIFIED
  ([unsloth.ai/docs/basics/api](https://unsloth.ai/docs/basics/api)).
- **Image generation:** documented only as a **Desktop GUI workflow** ("select Images from the
  sidebar," click Create/Transform/Inpaint/etc.) or via the `unsloth studio` CLI launcher. No
  `POST /v1/images/generations`-shaped endpoint, and no diffusion-specific REST surface, was found in
  official docs or in a third-party structural audit (DeepWiki's endpoint list for the repo enumerates
  training/export/model/hardware endpoints only — no `/api/images/*`). **This means integrating Unsloth
  as a scriptable local image backend today likely means driving the Desktop app's own internal API
  surface (undocumented, subject to change) rather than a published contract** — a materially different
  ergonomics story than ComfyUI's long-stable `/prompt`+`/ws` pattern. Marked UNCERTAIN rather than "NO"
  because an internal endpoint may well exist and simply isn't publicly documented; the live spike
  should open the Desktop app's network tab against a real image generation and see what it actually
  calls.
- **Rate limits:** none — it's local. VERIFIED (no meaning applies).
- **SDK maturity:** the core `unsloth` Python package is a mature, widely-used fine-tuning library
  (this is Unsloth's original and best-known product). The Desktop/Studio app and its image-generation
  surface are comparatively new additions layered on top, and — per the above — do not yet have the
  same level of documented, stable, programmatic surface. Treat "SDK maturity for fine-tuning" and "SDK
  maturity for local image generation as an embeddable backend" as **two different maturity claims**;
  the first is VERIFIED-mature, the second is UNCERTAIN-immature.

### 3.3 Pricing

**Free** — the framework and Desktop app are open-source and free to run; cost is entirely the user's
own hardware/electricity. No subscription, no credits, no per-generation fee. VERIFIED at the
qualitative level from the GitHub repo framing ("free, open-source app").

### 3.4 Licensing — this is a two-layer question, not one answer

1. **The Unsloth software itself is dual-licensed and the split matters for integration shape:**
   `unsloth/*`, `tests/*`, `scripts/*` (the core training/inference library) are **Apache-2.0**
   (permissive). `studio/*` and `unsloth_cli/*` (the Desktop/Studio GUI and its CLI) are **AGPL-3.0**
   (copyleft, network-use clause). VERIFIED — direct quote from
   [github.com/unslothai/unsloth/blob/main/LICENSE](https://github.com/unslothai/unsloth/blob/main/LICENSE).
   **Practical implication:** if the workbench spawns the user's own separately-installed Unsloth
   Desktop as an arms-length local process and only talks to it over a local HTTP port, this is the
   same "independent tool that only connects" pattern that keeps a GPL/AGPL codebase's terms from
   reaching into ours (see the identical ComfyUI discussion in §4.4) — but if any Unsloth Studio/CLI
   source were vendored or embedded directly into our own repo, AGPL-3.0's network-copyleft clause is a
   real and much stricter obligation than GPL's, and would need explicit legal sign-off before doing
   that.
2. **Licensing/commercial rights over generated images is entirely a function of which model weights
   the user loads** — Unsloth imposes no license of its own on generation outputs (it's a runtime, not
   a content platform). FLUX, SDXL, Qwen-Image, Z-Image etc. each carry their own separate licenses
   (which range from fully permissive to non-commercial-only depending on the specific checkpoint —
   e.g. FLUX.1-schnell vs FLUX.1-dev have historically had different commercial terms). **This was not
   independently re-verified per-model in this pass** — flagged UNCERTAIN and out of scope for a
   provider-level matrix; it has to be re-checked per model checkpoint the workbench actually ships or
   recommends, not assumed from the runtime's own (permissive) license.

---

## 4. ComfyUI

Official docs: `docs.comfy.org` · Repo: `github.com/Comfy-Org/ComfyUI` (formerly `comfyanonymous/ComfyUI`).

### 4.1 Capabilities

| Capability           | Status                                     | Evidence                                                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text → image         | **YES** — VERIFIED                         | Core, native function                                                                                                                                                                                                                                                                                                 |
| Image → image        | **YES** — VERIFIED                         | Core, native (img2img is one of ComfyUI's original supported workflows)                                                                                                                                                                                                                                               |
| Text → 3D            | **YES** — VERIFIED                         | "ComfyUI now natively supports Hunyuan3D-2mv" as of a recent core release — no custom-node install required for the base workflow ([docs.comfy.org/tutorials/3d/hunyuan3D-2](https://docs.comfy.org/tutorials/3d/hunyuan3D-2))                                                                                        |
| Image → 3D           | **YES** — VERIFIED                         | Same native Hunyuan3D-2 support, image-conditioned                                                                                                                                                                                                                                                                    |
| Multiview → 3D       | **YES** — VERIFIED                         | "2mv" = multiview variant of the natively-supported Hunyuan3D-2 pipeline                                                                                                                                                                                                                                              |
| Texturing            | **YES** — VERIFIED                         | The Hunyuan3D pipeline includes PBR texture-map synthesis as its second stage                                                                                                                                                                                                                                         |
| Remesh               | **UNCERTAIN**                              | Community mesh-decimation/retopology nodes exist in the wider node ecosystem; not confirmed as core/native the way Hunyuan3D itself now is                                                                                                                                                                            |
| Rigging              | **NO / not found**                         | No skeletal auto-rigging solution (native or prominent community node) surfaced in this pass                                                                                                                                                                                                                          |
| Animation (skeletal) | **UNCERTAIN**                              | Video-clip generation is well supported; game-asset skeletal/rig animation was not confirmed                                                                                                                                                                                                                          |
| TTS                  | **PARTIAL — community, not native**        | e.g. `ComfyUI_StepAudioTTS` custom node ("can speak, rap, sing, or clone voice") — third-party, not core                                                                                                                                                                                                              |
| SFX                  | **YES, native** — VERIFIED                 | ACE-Step music/sound-generation model has **native** ComfyUI support as of a recent release — official Comfy blog: "ComfyUI now supports Ace-Step natively" ([blog.comfy.org/p/stable-diffusion-moment-of-audio](https://blog.comfy.org/p/stable-diffusion-moment-of-audio)); up to 4 min of audio in ~20s on an A100 |
| Local runtime        | **YES** — VERIFIED                         | The entire product is a local server (default `http://127.0.0.1:8188`)                                                                                                                                                                                                                                                |
| Cloud API            | **YES, official (Comfy Cloud)** — VERIFIED | `comfy.org` hosts a cloud offering with its own MCP server (`comfy-cloud-mcp`)                                                                                                                                                                                                                                        |
| MCP availability     | **YES, official, two flavors** — VERIFIED  | `comfy-mcp` (drives a **local** ComfyUI install; `pip install comfy-mcp`) and `comfy-cloud-mcp` (drives **Comfy Cloud**), both first-party from Comfy-Org ([docs.comfy.org/agent-tools/local](https://docs.comfy.org/agent-tools/local), [comfy.org/mcp](https://comfy.org/mcp/))                                     |
| Progress reporting   | **YES** — VERIFIED                         | Native WebSocket `/ws` pushes `status`/`execution_start`/`executing`/`progress`/`executed` messages during a run; `comfy-mcp` additionally exposes `job_status`/`wait_for_job`/`watch_job` tools on top                                                                                                               |
| Cancellation         | **YES** — VERIFIED                         | `POST /interrupt` stops the currently-executing workflow immediately; `comfy-mcp` likely wraps this (not independently confirmed at the tool-name level)                                                                                                                                                              |
| Webhooks             | **NO, not native**                         | The core HTTP API reference (comms_routes) documents WebSocket push, not webhook push, as the real-time mechanism. Third-party wrapper services (e.g. `SaladTechnologies/comfyui-api`) add webhook/async-storage on top of a stock ComfyUI install, but that is an add-on, not something ComfyUI itself ships         |

### 4.2 API ergonomics

- **Auth:** **None documented** for a stock local install — the API "appears designed for local
  deployment without authentication requirements explicitly mentioned." This is a meaningful gap if the
  workbench ever exposes a ComfyUI instance beyond localhost — UNCERTAIN whether any first-party auth
  layer exists at all (Comfy Cloud presumably has its own separate auth, not investigated here).
- **Job semantics:** Async. `POST /prompt` validates and queues a workflow, returning `prompt_id` +
  queue position, or `error`/`node_errors` on validation failure. Poll `GET /history/{prompt_id}` or
  subscribe over `/ws` for push updates. `comfy-mcp`'s `run_workflow` tool supports "optional
  asynchronous submission" as a stated feature. VERIFIED —
  [docs.comfy.org (comms_routes)](https://docs.comfy.org/development/comfyui-server/comms_routes).
- **Output formats:** Arbitrary per-workflow (it's a node graph) — for the Hunyuan3D-2 pipeline
  specifically, output is `.glb`, written to `ComfyUI/output/mesh`. VERIFIED. For 2D image output,
  standard PNG/etc via `GET /view`.
- **Rate limits:** N/A — local software, no rate limiting layer found (Comfy Cloud may differ, not
  investigated).
- **SDK maturity:** No conventional client SDK in the Meshy/Tripo sense (there is no "call this Python
  function to generate an image" wrapper shipped by Comfy-Org) — the actual interface **is** the raw
  HTTP/WS API plus the JSON workflow-graph format. The official `comfy-cli` (`pip install comfy-cli`,
  `github.com/Comfy-Org/comfy-cli`) manages install/launch/model-download/custom-node-install and can
  run workflows headlessly (`comfy run`), which is the closest first-party equivalent to an SDK.
  VERIFIED. Community wrapper packages (e.g. the SaladTechnologies API server) exist for
  production-hardening but are third-party. **69k+ GitHub stars / 7.5k forks** on the core repo —
  VERIFIED as a maturity/community-size signal, not a functional guarantee.

### 4.3 Pricing

**Free / open-source** to run locally — cost is the user's own GPU. Comfy Cloud (hosted) exists as a
separate paid product; its pricing was not investigated in this pass (out of scope — the task framed
ComfyUI specifically as a **local** backend candidate).

### 4.4 Licensing — software license vs. output license, same shape as Unsloth

**ComfyUI core is GPL-3.0.** VERIFIED —
[github.com/Comfy-Org/ComfyUI/blob/master/LICENSE](https://github.com/Comfy-Org/ComfyUI/blob/master/LICENSE).
Per the project's own maintainers (GitHub Discussion #14346): code that "directly extends or modifies
ComfyUI's local code (anything inside `custom_nodes/`)" is a derivative work and must itself be
GPL-3.0, but "independent tools or remote API services that only connect to ComfyUI... are not bound by
GPL and can use other licenses." **Practical implication, identical in shape to Unsloth's AGPL note
above:** treating ComfyUI as an arms-length local server the workbench spawns and talks to over
HTTP/WS (never vendoring its source, never shipping custom nodes as part of our own repo) is a
GPL-clean integration pattern. Writing and bundling our _own_ custom nodes as part of our shipped
product would need to be released GPL-3.0 itself.

**Generated-output licensing is not set by ComfyUI or its GPL license at all** — outputs of GPL'd
software are not themselves GPL (same principle as GIMP output or GCC-compiled binaries). The real
licensing question for anything ComfyUI produces is **which model checkpoint the user loaded** (SDXL,
FLUX variant, Hunyuan3D, etc.), each with its own separate commercial-use terms. This was not
re-verified per-model in this pass, same caveat as Unsloth §3.4 — **UNCERTAIN, and it has to be
answered per model actually shipped, not assumed from ComfyUI's own license.**

---

## 5. ElevenLabs

Official docs: `elevenlabs.io/docs` · Pricing: `elevenlabs.io/pricing/api` · Terms:
`elevenlabs.io/terms-of-use`.

### 5.1 Capabilities

| Capability                               | Status                       | Evidence                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text → image                             | **NO**                       | Not offered — audio-only company                                                                                                                                                                                                                                                                                                            |
| Image → image                            | **NO**                       | Not offered                                                                                                                                                                                                                                                                                                                                 |
| Text → 3D / Image → 3D / Multiview → 3D  | **NO**                       | Not offered                                                                                                                                                                                                                                                                                                                                 |
| Texturing / Remesh / Rigging / Animation | **NO**                       | Not offered                                                                                                                                                                                                                                                                                                                                 |
| TTS                                      | **YES** — VERIFIED           | Core product; Eleven v3 (70+ languages, most expressive), Flash v2.5 (~75ms latency, lower cost)                                                                                                                                                                                                                                            |
| SFX                                      | **YES** — VERIFIED           | Dedicated Sound Effects product, "cinematic sound effects from text descriptions," billed per-minute                                                                                                                                                                                                                                        |
| Local runtime                            | **NO**                       | Pure cloud SaaS; no on-device model weights offered                                                                                                                                                                                                                                                                                         |
| Cloud API                                | **YES** — VERIFIED           | REST + streaming + WebSocket                                                                                                                                                                                                                                                                                                                |
| MCP availability                         | **YES, official** — VERIFIED | `github.com/elevenlabs/elevenlabs-mcp`, covers TTS, voice cloning, transcription, and more                                                                                                                                                                                                                                                  |
| Progress reporting                       | **N/A by design**            | TTS/SFX calls are synchronous request/response or client-side streamed, not long-running polled jobs — there is no job to report progress on in the normal case. (Dubbing is the one genuinely long-running, poll-shaped job — see below)                                                                                                   |
| Cancellation                             | **UNCERTAIN**                | For sync/streaming calls, the only documented mechanism is the client closing the connection; no formal "cancel this generation" endpoint was found for TTS/SFX specifically                                                                                                                                                                |
| Webhooks                                 | **YES** — VERIFIED           | Workspace-level webhook configuration (admin-only), used for genuinely async operations — batch Speech-to-Text, Dubbing project completion, and Conversational-AI post-call events. Retry queue caps at 100 before dropping. ([elevenlabs.io/docs/eleven-api/resources/webhooks](https://elevenlabs.io/docs/eleven-api/resources/webhooks)) |

### 5.2 API ergonomics

- **Auth:** API key. VERIFIED (exact header format not independently re-confirmed in this pass, but
  standard `xi-api-key` header is the widely-documented convention — **UNCERTAIN on the literal header
  name**, worth a two-minute confirm before wiring it).
- **Job semantics:** the _same_ `POST /v1/text-to-speech/{voice_id}` endpoint is exposed three ways —
  batch (full response), HTTP chunked stream, and a stream-input WebSocket — "each suited to a
  slightly different job." This is **synchronous-shaped**, not the poll-a-task-ID pattern the 3D
  providers use — meaningfully simpler integration for the common case. VERIFIED.
- **Output formats:** MP3 by default (`mp3_<samplerate>_<bitrate>`, e.g. `mp3_44100_128`); PCM and
  μ-law also available. VERIFIED.
- **Rate limits:** modeled as **concurrency**, not RPS — Free 2, Starter 3, Creator 5, Pro 10, Scale
  15, Business 15 concurrent in-flight requests. `too_many_concurrent_requests` error on breach;
  documented remedy is client-side queuing or a tier upgrade, not blind retry. VERIFIED.
- **SDK maturity:** Official Python and TypeScript SDKs. VERIFIED. This is the most mature, most
  conventional SDK story of the five providers in this matrix — synchronous request/response is a much
  smaller surface to wrap well than the async job-polling shape the 3D providers require.

### 5.3 Pricing (rough, dated 2026-08-11)

TTS: ~$0.10/1,000 characters (Multilingual v2/v3) or ~$0.05/1,000 characters (Flash/Turbo). SFX:
~$0.12/minute. Subscription ladder: Starter $6/mo, Creator $22/mo ($11 first month), Pro $99/mo, Scale
$299/mo, Business $990/mo, Enterprise custom — each tier bundling a TTS-character allowance and an STT-
hours allowance that both shrink under the "higher quality" model tier. **Free tier:** pay-as-you-go
framing, ~10,000 credits/month across TTS/STT/SFX/Voice-Design/Music/3 Studio projects. VERIFIED.

### 5.4 Licensing / commercial usage of generated audio

**Free plan: non-commercial only**, by the terms' own explicit language — "you may only use the
Services for non-commercial purposes." **Paid plan: commercial use permitted** — "you may use the
Services for commercial purposes," subject to the separate Prohibited Use Policy. **Output ownership:**
"you retain all rights in and to your Output," except that "Output" explicitly excludes ElevenLabs' own
underlying Voice Models/language models (i.e., you own the audio, not the model that made it — same
distinction most of these providers draw). **ElevenLabs itself retains a broad license** over content
and voices submitted to it (perpetual, irrevocable, worldwide, sublicensable, "to provide the
Services," including reproducing/modifying/creating-derivative-works-from a user's voice) — with one
explicit carve-out: "we will not commercialize your voice on a standalone basis without your
permission." VERIFIED, direct quotes from
[elevenlabs.io/terms-of-use](https://elevenlabs.io/terms-of-use). **For a shipped game needing narration
or SFX: a paid plan is required**, same shape as Meshy/Tripo's free-tier restriction — but note
ElevenLabs' free tier has **zero** commercial carve-out (no CC-BY-style option the way Meshy's free
tier has), so there is no free path to shippable audio at all, only a free path to prototyping.

---

## 6. Cross-provider quick-reference

### 6.1 Capability matrix

|                      | Meshy     | Tripo                     | Unsloth (local)  | ComfyUI                | ElevenLabs |
| -------------------- | --------- | ------------------------- | ---------------- | ---------------------- | ---------- |
| Text→image           | YES       | YES                       | YES              | YES                    | —          |
| Image→image          | YES       | UNCERTAIN                 | YES              | YES                    | —          |
| Text→3D              | YES       | YES                       | NO               | YES (native)           | —          |
| Image→3D             | YES       | YES                       | NO               | YES (native)           | —          |
| Multiview→3D         | YES       | YES                       | NO               | YES (native)           | —          |
| Texturing            | YES       | YES                       | NO               | YES                    | —          |
| Remesh               | YES       | YES                       | NO               | UNCERTAIN              | —          |
| Rigging              | YES       | YES                       | NO               | NO                     | —          |
| Animation (skeletal) | YES       | YES                       | NO               | UNCERTAIN              | —          |
| TTS                  | NO        | NO                        | YES              | community-only         | YES        |
| SFX                  | NO        | NO                        | UNCERTAIN        | YES (native, ACE-Step) | YES        |
| Local runtime        | NO        | NO                        | YES              | YES                    | NO         |
| Cloud API            | YES       | YES                       | NO               | YES (Comfy Cloud)      | YES        |
| MCP, official        | YES       | YES                       | NO (client only) | YES (2 flavors)        | YES        |
| Progress reporting   | YES       | YES                       | UNCERTAIN (gen)  | YES                    | N/A (sync) |
| Cancellation         | UNCERTAIN | UNCERTAIN                 | UNCERTAIN        | YES                    | UNCERTAIN  |
| Webhooks             | YES       | YES (mechanism uncertain) | NO               | NO (native)            | YES        |

### 6.2 Job-semantics shape, the thing that most affects tool design

Three genuinely different shapes showed up, echoing the tightest-ceiling design principle from
`docs/v2/notes/agent-tooling.md` §5 (design the tool contract for the least forgiving member of the
set, not the most generous):

1. **Long async, task-ID + poll/webhook** (Meshy, Tripo, ComfyUI-via-comfy-mcp): the right shape for
   3D generation and any local diffusion job — a `generate_3d(args) → {jobId}` +
   `generation_status(jobId)` pair, exactly as `agent-tooling.md` §5 already concluded independently.
2. **Fire-and-forget synchronous** (ElevenLabs TTS/SFX): a blocking call is fine and idiomatic; forcing
   a job-handle shape onto this would be an unnecessary complication of the simplest provider in the
   set.
3. **Undocumented / GUI-shaped** (Unsloth image generation specifically): neither confirmed async-job
   nor confirmed sync — the honest status is "unknown, needs a live spike," not a guess in either
   direction.

### 6.3 Licensing pattern across all five — one recurring shape

Every provider in this matrix draws the **same free-tier-vs-paid-tier commercial-use line**, with
different strictness:

- Meshy free: commercial OK with attribution (CC BY 4.0) — most permissive free tier.
- Tripo free: no commercial use at all — strictest free tier.
- ElevenLabs free: no commercial use at all, and no CC-BY-style attribution escape hatch either.
- Unsloth / ComfyUI: the runtime itself is free and imposes no output license, but the _actual_
  generated-asset commercial terms come from whatever model checkpoint is loaded — a **per-model**
  question, not a per-provider one, and the one most likely to be silently wrong if someone assumes
  "local = automatically fine to ship."

**None of these pricing or licensing numbers belong in a core contract or type definition** — per the
task brief's own instruction, they are dated snapshots (2026-08-11) that will drift; the
`AgentRuntimePort`-style abstraction this repo already favors (see root `HANDOFF.md` §10) should keep
provider pricing/licensing entirely out of any shared interface and treat it as configuration/policy
data instead.

---

## 7. Recommendation 1 — first 3D provider for the vertical spike

### Decision: **Tripo**, with Meshy as the documented runner-up and the fallback if Tripo's UNCERTAIN

cells resolve unfavorably during the live spike.

**Reasoning, against the brief's own stated criteria (API simplicity + GLB output + progress +
free/cheap tier):**

- **API simplicity favors Tripo.** Tripo's Text-to-3D and Image-to-3D are each a **single**
  create-and-poll round trip. Meshy's Text-to-3D is a mandatory **two-stage** preview→refine flow (two
  separate task creations, two separate poll loops) to reach a textured result — strictly more
  integration code and more failure surface for the same end state. Image-to-3D is single-step on both
  providers, so this specifically favors Tripo when the spike wants **text**-driven generation (closer
  to what an agent-composed prompt would naturally produce) rather than starting from a reference image.
- **SDK simplicity favors Tripo more decisively.** Tripo ships an official Python SDK with a
  `wait_for_task()` helper that collapses create+poll+download into one call — this is the actual
  fastest path to a working spike, not just a marginally faster one. Meshy's documentation is
  raw-REST-first; its SDKs exist but weren't shown to offer the same one-call convenience in this pass.
- **GLB output: tied.** Both explicitly return GLB. Meshy's response shape (`model_urls.glb`) was more
  thoroughly documented and cross-checked in this pass than Tripo's equivalent field, but this is a
  documentation-completeness gap, not a capability gap — both are VERIFIED to output GLB.
- **Progress reporting: tied.** Both expose a `progress` 0–100 field on the poll response.
- **Free/cheap tier is the one place Meshy might actually win, and it's the reason this isn't a
  blowout call:** Meshy's free tier explicitly has **no API access at all** — the floor to call the API
  even once is the $20/mo Pro plan. Tripo's Studio free tier (300 credits/mo) exists, but this pass
  could not confirm from an official page whether those free credits apply to the **API** specifically,
  as opposed to only the Studio web app — one search result explicitly suggested the API is billed
  entirely separately with no free allocation. **If that UNCERTAIN resolves to "no free API tier,"
  Tripo and Meshy are at financial parity for the spike** (both effectively require putting a card down
  before the first API call); **if it resolves to "yes, free credits work against the API," Tripo wins
  this axis outright too.** This is exactly the kind of two-minute live check (create a Tripo API key
  on a brand-new account, see whether it starts with a nonzero credit balance) that should happen before
  writing any spike code, and it is the single most decision-relevant UNCERTAIN in this whole document.
- **MCP and webhook support are both officially present on both** — a wash, not a differentiator.
- **Cancellation is UNCERTAIN on both** — also a wash, and low-stakes for a spike (a spike can just let
  a generation finish or abandon polling client-side).

**What would flip this recommendation to Meshy:** if the live spike finds that (a) Tripo's free
credits do not work against the API and (b) Meshy's more thoroughly-documented rate-limit table and
webhook signature/retry semantics matter more than the extra preview/refine round-trip for the specific
demo being built (e.g., if the spike wants to show the texture-refine step as its own visible workspace
state — which, notably, maps naturally onto this product's own `ChangeProposal`→`ValidationEvidence`
approval pattern from `HANDOFF.md` §9.4, in which case Meshy's two-stage flow might actually be a
better narrative fit for the demo rather than a liability).

---

## 8. Recommendation 2 — first local image backend hypothesis

### Decision: **ComfyUI**, not close, pending the live spike proving otherwise.

**Reasoning:**

- **ComfyUI has a stable, documented, first-party programmatic API** (`/prompt`, `/ws`, `/history`,
  `/interrupt`, `/view`) that has existed and been the de facto standard long enough to have spawned
  an entire third-party production-hardening ecosystem (SaladTechnologies' API server, ViewComfy,
  Runflow, etc.) — a strong revealed-preference signal that other teams already build products on top
  of exactly this surface. **Unsloth's equivalent image-generation surface is not documented as a
  public API at all** — only as a Desktop GUI workflow — which per §3.2 means integrating it
  programmatically today means reverse-engineering an internal, unversioned interface. That is a
  fundamentally different risk profile from "call a documented endpoint."
- **ComfyUI now has an official MCP server built specifically for exactly this integration shape**
  (`comfy-mcp`, local-first, `run_workflow`/`job_status`/`wait_for_job`/`fetch_outputs`) — this is
  Comfy-Org building and shipping the precise tool contract this product already wants
  (`generate_3d`/`generation_status` per `agent-tooling.md` §5, generalized to `generate_image`).
  Unsloth has no equivalent for image generation; its only MCP story is Unsloth-as-MCP-client for LLMs.
- **ComfyUI's capability ceiling is dramatically higher for a game-asset pipeline specifically:** native
  Hunyuan3D-2 (text/image/multiview → GLB, with PBR texturing) and native ACE-Step (SFX/music) mean the
  same local server could plausibly cover image generation, a chunk of the 3D pipeline, and SFX all
  behind one runtime and one MCP surface — meaningfully reducing the number of distinct local backends
  this product would need to stand up, install, and keep updated. Unsloth's roster (image, video, TTS,
  LLM) does not overlap with game-asset 3D or SFX at all.
- **The GPL-3.0 vs AGPL-3.0 licensing question is a wash, not a differentiator**, once the integration
  pattern is "spawn it as an arms-length local process, talk to it over HTTP" for both — see §3.4 and
  §4.4, which independently reach the identical conclusion for both providers. Neither license blocks
  this architecture; both would block vendoring source directly.
- **Where Unsloth would win, and why it's still not enough to flip this today:** Unsloth's core
  fine-tuning library is more mature and better-documented than anything comparable in the ComfyUI
  ecosystem, and if this product's roadmap includes **training custom LoRA style-adapters** on a
  studio's own art direction (explicitly a documented Unsloth workflow — fine-tune on your own images,
  load the LoRA in Create), that is a real Unsloth-specific capability ComfyUI does not natively offer
  in the same turnkey way. That is a **second-wave feature**, not a first-spike blocker, and the first
  spike's job is "get a locally-generated image into the workspace reliably," which ComfyUI's
  documented API answers today and Unsloth's does not yet.

**What the live spike should specifically confirm before this is locked in** (mirroring the discipline
`agent-tooling.md` §6 already established for the MCP-tool-delivery question): (1) actually POST a
minimal workflow to a local ComfyUI's `/prompt` and confirm a `.png`/`.glb` comes back through `/view`
and `/history`; (2) open Unsloth Desktop's browser devtools network tab during a real "Create" image
generation and record what request it actually fires, to convert §3.2's UNCERTAIN into either a
documented internal API worth building against or a confirmed GUI-only dead end for programmatic use.
