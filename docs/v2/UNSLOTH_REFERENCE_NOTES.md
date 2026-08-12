# Unsloth Studio — Architectural & UX Reference Notes

## LICENSE BOUNDARY (read first)

**Source inspected:** `github.com/unslothai/unsloth`, the `studio/` subdirectory only (backend, frontend, and Tauri desktop shell for "Unsloth Studio," a local/cloud multimodal model workbench). This is the **real, public repository** — not a hypothetical. The root package (the `unsloth` training library) is Apache-2.0, but every file under `studio/` that this research inspected carries `SPDX-License-Identifier: AGPL-3.0-only` and points at `studio/LICENSE.AGPL-3.0`. That AGPL boundary is exactly what the handoff charter (§8) described, confirmed first-hand rather than assumed.

**How this research was conducted (clean-room discipline):**

- No Unsloth Studio source existed anywhere on this machine before this task; it was located on GitHub and cloned **read-only** into a scratch job directory (`$HOME/.claude/jobs/unsloth-research/repo`), **not** into this repository or any writable project tree, using a blobless partial clone with sparse-checkout scoped to `studio/` plus the top-level license files. Nothing was installed, run, or executed.
- This document contains **no copied source code, no copied comments/docstrings, no copied UI strings, and no near-verbatim paraphrase of implementation code.** Everything below is a behavioral/architectural description in my own words: what a subsystem does, what states it models, and what shape its data takes conceptually. Where a field or endpoint name is mentioned, it is treated as a functional fact (like an index entry), not quoted prose.
- **Do not treat this document as a substitute for the source.** It is a set of derived requirements and design ideas. Building DevGame's generation system means writing our own schemas, our own state machines, and our own code from these requirements — never adapting or transcribing Unsloth's.
- If DevGame ever runs Unsloth (or Unsloth Studio) as an **external local backend process** (per charter §4A/§5), that is a clean process/API boundary and does not implicate AGPL — we'd be a client of its HTTP API, not a distributor of its code. If DevGame ever considered **bundling or vendoring** any AGPL-licensed `studio/` code, that requires separate OSS/legal review before it happens; this document does not authorize that and nothing here should be read as pre-clearing it.

---

## 0. What Unsloth Studio Actually Is

Unsloth Studio is a local-first desktop application (macOS/Windows/Linux, built as a Python/FastAPI backend wrapped in a Tauri/Rust shell with a web frontend) for **running, chatting with, fine-tuning, and exporting** open-weight text, vision, audio/TTS, and image/diffusion models on the user's own hardware — while also being able to reach out to external cloud model providers (OpenAI, Anthropic, and others) from the same interface, and to be reached _as_ an OpenAI/Anthropic-compatible API endpoint by other tools. It is a mature, heavily-tested codebase (hundreds of backend test files) that has clearly been hardened against real multi-platform GPU pain (CUDA, ROCm, Apple Silicon/MLX, Intel XPU, Vulkan fallback), which is precisely why it's a rich reference for the problems DevGame will also hit once "local model" stops being a demo and becomes a real user-facing feature.

The product surface (visible from the frontend's feature-folder layout) spans: chat, image generation, video generation, audio/TTS, training, a model picker _and a separate training-model picker_, a "loaded models" panel, a download/hub manager, credential management, onboarding/tour, an API request monitor, settings, RAG, and data-recipe/dataset tooling. That breadth is itself a signal: a lot of what looks like "just add a chat UI" work is actually these adjacent surfaces (loaded-model visibility, download management, credentials, API monitor) that make the chat UI trustworthy.

---

## 1. Provider Architecture

### What it does

Unsloth Studio cleanly separates three things that are easy to conflate:

1. **A provider registry** — a fixed, built-in catalog of known external provider _types_ (OpenAI, Anthropic, and similar). Each registry entry carries a provider-type id, a human display name, a default API base URL, a default model list, and a small set of **provider-level capability flags** (streaming support, vision support, tool-calling support) plus a mode flag indicating whether that provider's model list is fetched live from the provider ("remote") or drawn from a small curated list Studio ships itself ("curated"). This registry is read-only, exposed as a `/registry`-style listing endpoint, and is what populates a "choose a provider type" dropdown.

2. **Saved provider configurations** — the user's actual connections: one row per "my OpenAI key," "my company's Anthropic key," etc. Each row has an id, references a provider type, has a display name the user chose, an optional custom base URL override (for OpenAI-compatible proxies, self-hosted endpoints, etc.), an enabled/disabled flag, an explicit list of which models from that provider are actually turned on for use versus merely available, and — critically — **never exposes the raw API key**. The saved-config response carries only `has_api_key: bool`. The actual secret lives in a separate, independently-encrypted credential store keyed by a credential "kind" plus a scope id (e.g. "provider api key" + this provider config's id, or "HF token" as its own kind), so deleting/rotating a credential is a distinct operation from editing the provider's display metadata, and a leaked config-list response can never leak a key.

3. **Local models** are _not_ forced through the "provider" abstraction at all. They're discovered from disk (a configured models directory, the Hugging Face cache, even a co-installed LM Studio's model directory) and represented as their own model-detail records with a `source` tag (`models_dir` / `hf_cache` / `lmstudio` / `custom`) rather than pretending to be a "local provider" with a fake API key.

There's also a first-class **connection test** endpoint: given a provider type, base URL, and (unsaved or saved) key, it calls the provider and returns success/failure plus a count of models found — so a user can validate credentials _before_ saving them, not discover a typo three screens later mid-chat.

### Worth independently implementing in DevGame

- **The three-way split** (provider registry vs. saved provider connections vs. local resources) maps almost exactly onto DevGame's generation providers. `Meshy`/`Tripo`/`ElevenLabs`/a cloud image API are "provider types" with a small registry entry each (display name, default base URL, capability flags: text→3D, image→3D, TTS, etc. — this is basically the seed of `PROVIDER_MATRIX.md`, §38). A user's actual Meshy account+key is a saved provider config. A local ComfyUI/Unsloth backend is _not_ a provider config with a fake key — it's a locally-detected resource with its own status.
- **Secrets never round-trip through the config API.** `has_api_key: boolean` (or `has_secret`) on the response, with the real secret behind a separate encrypted store addressed by `(kind, scope_id)`, is a clean, low-risk pattern worth copying conceptually. Combine with DevGame's own credential-handling research (charter §45) rather than inventing a new scheme.
- **A `/test` (or `test_connection`) action on every provider-type registration**, returning `{success, message, modelsCount}` before the config is trusted, should be a first-class part of DevGame's `Setup Integrations` flow for every provider — cloud or local.
- **`model_list_mode: "remote" | "curated"`** is a good idea to borrow directly: some providers let you enumerate models live (OpenAI-style `/models`), others don't have a meaningful list endpoint or you don't want to hit it on every screen load, so you ship a small curated default list instead. DevGame's `ImageProvider`/`Model3DProvider`/`AudioProvider` registrations should each declare which mode they use.

### Do NOT copy

- Don't copy Unsloth's exact Pydantic schema shapes or field names verbatim — write DevGame's own, sized to the generation-provider domain (Meshy/Tripo/ElevenLabs/ComfyUI have different natural fields than an LLM provider does: no "supports_streaming," but "supports_image_reference," "max_polycount," etc.).
- Don't adopt curated-model-list content itself (that's Unsloth's own maintained data, and irrelevant to us — we're not proxying LLM providers).
- Don't build the provider layer as chat-adapter-shaped when DevGame's real need is generation-job-shaped (see §3 below) — Unsloth's provider layer is fundamentally about _conversational_ sessions; ours is fundamentally about _async jobs producing assets_. Borrow the credential/registry split, not the request/response shape.

---

## 2. Capability Discovery

### What it does

Every loaded (or loadable) model in Unsloth Studio carries a shared block of **capability and runtime fields** — used identically whether the active backend is a local GGUF/llama.cpp model, a local MLX model, or (for the "runtime" side specifically) whatever's currently loaded. The meaningful ones, conceptually:

- Modality flags: is this a vision-capable model, a diffusion/image model, an audio/TTS model, a model that accepts audio _input_ (ASR) — these are independent booleans, not a single enum, because a model can combine them.
- Reasoning support is **not just a boolean**. There's a `supports_reasoning` flag, but also a `reasoning_style` describing _how_ reasoning is controlled for this specific model family — a plain on/off toggle, a graded "effort" level (low/medium/high), or a hybrid gate-plus-effort scheme — plus a list of the discrete effort levels that particular model's chat template actually exposes, and a flag for models where reasoning is hardcoded on and can't be toggled at all. This acknowledges that "does it support reasoning" is a family of related-but-different UX affordances, not one checkbox.
- Tool-calling support is its own flag, independent of reasoning and vision.
- Context length is reported at **three different granularities**: the model's native/declared maximum (from its own metadata), the maximum actually usable given this machine's hardware, and the length the currently-active runtime instance was actually loaded with. Those three numbers can legitimately differ, and the UI needs all three to explain _why_ a model got capped.
- For external/cloud providers, capability discovery is coarser: capability flags live on the **provider registry entry** (does this provider generally support vision, tool calling, streaming), not on each individual model the provider offers. A per-model `ProviderModelInfo` for a cloud model only carries an id, display name, context length, and owning org — no per-model capability introspection. Local models get much richer, per-model capability data than remote ones do.

### Worth independently implementing in DevGame

- **Capability flags as independent booleans/enums on the resource, not a single "type" tag.** A generation provider or model should expose something like `{ supportsTextToImage, supportsImageToImage, supportsTextTo3D, supportsImageTo3D, supportsRemesh, supportsRigging, supportsTTS, supportsSFXGeneration, supportsReferenceImage }` — independent flags, because real providers mix and match (this is literally the shape `PROVIDER_MATRIX.md`, §38, already sketches).
- **Multi-granularity limits, not one number.** For DevGame's 3D pipeline this maps directly to charter §25's "technical evidence" idea: report the _provider's_ declared maximum polycount/texture size alongside the _project's_ target budget, the same way Unsloth reports native vs. hardware-capped vs. active context length. Three numbers, one clearly-labeled UI, instead of a single ambiguous "limit."
- **Accept that capability richness will be asymmetric between local and cloud providers**, and design the schema so a provider can honestly report "unknown"/omit a capability rather than being forced to guess. Don't make the UI assume every provider can answer every capability question with the same confidence.

### Do NOT copy

- Don't copy the specific reasoning-style taxonomy (`enable_thinking` / `reasoning_effort` / `enable_thinking_effort`) — that's Unsloth's encoding of specific LLM chat-template quirks (Qwen-style vs. GLM-style) that has no equivalent in an image/3D/audio generation domain. The _lesson_ (some capabilities have graded control schemes, not just on/off) is what transfers, not the vocabulary.
- Don't over-invest in per-model capability granularity for cloud generation providers if the real providers (Meshy, Tripo, ElevenLabs) don't expose that granularity today — match richness to what's actually knowable, the way Unsloth does (rich locally, coarse remotely) rather than fabricating precision.

---

## 3. Model Lifecycle

### What it does

Unsloth Studio actually runs **two parallel lifecycle tracks** that are easy to collapse into one but are kept separate:

**A. Acquisition lifecycle (is the weight data on disk at all).** A background download job has an explicit state machine: `idle → running → (cancelling) → cancelled | complete | error`. Downloads run as a **spawned worker process**, not an in-process async task — this insulates the UI/API server from a stalled or crashed transfer, and lets a stall-watchdog kill and restart a hung transfer independently. Progress is reported as bytes-downloaded vs. bytes-expected plus a derived fraction, and — importantly — a **"generation" counter** is attached to every download job. If the frontend reloads or a second tab opens while a download is in flight, it can _adopt_ the running job by matching the job's key and generation number, rather than either losing track of it or accidentally issuing a duplicate download. A cancel request is itself scoped to a specific generation, so a stale cancel from a reloaded tab can't kill a newer retry of the same job. There's also automatic **transport fallback with an explicit, user-visible reason** (a faster transfer protocol falls back to plain HTTP if it's been failing on this machine, and the response says which transport is _actually_ active versus which one was originally requested).

At the level of an individual downloadable model, Unsloth distinguishes finer-grained states per _variant_ (e.g., per GGUF quantization): fully downloaded, partially downloaded (resumable), a newer version available upstream, and whether a partial download is safe to clean up. This is acquisition status at the artifact level, layered under the job-level state machine above.

**B. Runtime lifecycle (is the weight data currently resident and serving requests).** This is entirely separate from acquisition and modeled as: not loaded → loading (with a load phase — weights paging into memory, then "ready" once the serving process reports healthy, reported as bytes-resident vs. bytes-total so a large model's load shows a real progress bar instead of a frozen spinner) → loaded/active → unloaded. The runtime status endpoint reports **lists**, not a single active model — `loading: [...]` and `loaded: [...]` — because more than one model can be mid-load or resident at once (e.g., a chat model and a diffusion model coexisting). Loading a new model doesn't implicitly and silently evict a different in-use model; if an in-flight chat generation would be interrupted by a reload, the load call **refuses with a conflict** unless the caller explicitly opts in to force-cancelling the affected generations.

GPU memory placement is modeled as its own sub-state with an **auto/manual split**: "auto" hands GPU layer count, context length, and device selection entirely to the underlying runtime's own fitting logic; "manual" means the user pins layer counts, tensor split ratios, and MoE-expert CPU-offload counts themselves. A model that had to run on CPU due to an automatic GPU-launch crash carries an explicit `cpu_fallback_reason` rather than silently reporting "no GPU."

### Worth independently implementing in DevGame

- **Keep acquisition and runtime as two separate state tracks**, exactly as the charter's §10 already insists ("Do not build one enormous state enum"). Unsloth is concrete proof this is the right call at scale: `not-installed → downloading → installed` (acquisition) is orthogonal to `unloaded → loading → loaded/running → failed` (runtime), and DevGame's local-backend UX (§41 in the charter) should model both.
- **The generation-counter + adoption pattern** is directly relevant to the charter's async-job questions (§13, §44): "what happens if the desktop app closes, a remote client disconnects, or the agent session ends" — Unsloth's answer is that the job lives server-side, keyed with a monotonic counter, and _any_ client (a reloaded tab, a second window) can re-attach to the authoritative running job instead of the job's identity living in the client that started it. `GenerationJob` in DevGame should adopt this rather than inventing per-client job tracking.
- **Report both requested and applied values, with a reason, whenever an automatic decision could differ from what was asked** (transport fallback reason, CPU-fallback reason, GPU auto-fit vs. manual). This recurs so often in Unsloth's codebase it reads as a house rule, and it's exactly the right instinct for DevGame's own automatic decisions (auto-selected provider, auto-downgraded polycount target, auto-picked GPU) — surface "you asked for X, we did Y, here's why" instead of a bare status.
- **Refuse-with-explicit-override instead of silent eviction** when a state change (loading a new model, in DevGame's world maybe starting a new generation on a busy local backend) would disrupt in-flight work. A 409-style "this would interrupt N active generations, retry with force=true" is a better default than either blocking forever or silently killing work.
- **Variant-level acquisition granularity** (a specific quantization/format of a model can be downloaded, partial, or stale independent of its siblings) is a good model for DevGame if we ever support multiple exported variants of a 3D asset (e.g., different LOD/polycount targets) with independent local caching.

### Do NOT copy

- Don't copy the specific phase vocabulary (`mmap`, `finalizing`) — those name llama.cpp/diffusers internals that have no DevGame equivalent. Define our own load phases around what our own local backends actually report.
- Don't run every long operation as a spawned OS subprocess by default — that's a reasonable choice for Unsloth's very heavy, crash-prone ML runtimes; DevGame's generation calls are mostly outbound HTTP to cloud APIs, where an in-process async task with a timeout is simpler and sufficient. Reserve the "separate process + watchdog" pattern for genuinely heavy, unstable local work (a local diffusion/3D backend), not for calling Meshy's REST API.
- Don't copy the _specific_ status-string spelling choices; see §6 below on status-vocabulary fragmentation — the charter's own instinct (one shared core status enum) is better than what Unsloth actually shipped.

---

## 4. Generation / Task Lifecycle

### What it does

Unsloth Studio does not have one unified "job" concept across every kind of work — it has several related-but-distinct ones, which is itself a finding (see §6):

- **Chat generation** is tracked by an in-memory **active-generation registry**, not a persisted job record. Each in-flight generation is registered under a freshly-minted handle (not the conversation's own id — a handle is minted fresh so a tool-continuation turn starting before the previous turn has finished unregistering can't collide with it), carries the owning conversation id, which model is generating, what "kind" of generation it is, and a start timestamp, plus a threading cancellation signal. This registry answers three questions cheaply: how many generations are active right now, which conversations have one in flight (so a reload/model-switch can warn "this will interrupt thread X"), and — the important one — **cancel by conversation** (stop everything this specific chat thread is doing) versus **cancel everything** (a global stop button), both implemented as "set this signal" rather than force-killing a process, so each stream tears itself down cleanly.

- **Image/diffusion generation** is tracked with per-step progress: an `active` flag, steps-completed vs. total-steps, a derived fraction, and an estimated seconds-remaining. This is a much finer-grained progress signal than "queued/running/done" — it's live denoising-step progress, which is what makes a progress bar feel real instead of indeterminate.

- **Training runs** get their own status vocabulary again: an initial status of pending/queued/error at creation time, then running/completed/stopped/error once actually underway, plus a distinct reason code for whether training artifacts were retained or purged after the run ended.

- **Downloads** get the idle/running/cancelling/cancelled/complete/error vocabulary described in §3.

- **Tool-call execution inside a chat turn** gets its own micro-lifecycle entirely: when a chat session is configured to require human confirmation before running a tool, the generation loop **pauses mid-stream**, emits a "tool about to start" event carrying a freshly-minted, unguessable approval id, and blocks on a per-approval wait slot that a _separate_ HTTP call (the user's Allow/Deny click, arriving on its own connection) resolves. The wait times out (generously, on the order of an hour) and **defaults to deny** if the user never responds or the generation itself gets cancelled first. The registration step happens _before_ the "tool about to start" event is even emitted, specifically so a very fast confirmation (or an "always allow" auto-decision) can never race ahead of the thing it's supposed to unblock. Resolution is race-safe: whichever decision arrives first wins, and a duplicate/late second decision for the same approval id is silently dropped rather than allowed to flip an already-recorded Allow into a Deny.

### Worth independently implementing in DevGame

- **A per-modality progress shape that fits the modality**, not a forced-uniform one. Diffusion's step/total/eta shape is close to what DevGame's `generate_3d`/`generate_image` progress should look like when a provider can report it; when a provider can't (many cloud 3D APIs are closer to opaque "queued → processing → done"), fall back to the coarser `GenerationJob.status` from the charter's own §10 design — don't force fake step-counting onto a provider that can't give you one.
- **The human-approval-gate pattern (§47 in the charter, "Manual/Autonomous/Hybrid") has a working, race-safe reference implementation here worth adapting almost directly:** register the pending decision _before_ announcing it, resolve on a separate channel keyed by an unguessable id, default-deny on timeout or cancellation, first-decision-wins. This is exactly the mechanism DevGame will need for "Allow paid cloud generation → ask" and "Allow importing generated 3D → ask" from the charter's permission-mode sketch — a coding-agent turn calling `generate_3d` should be able to pause exactly the same way, and the UI's Approve/Reject should resolve it exactly the same way.
- **Cancel-by-scope, not just cancel-everything.** DevGame should support cancelling one specific generation, one project's generations, or (rarely) everything — modeled the same lightweight way (a signal per job, a lookup by scope), not by tracking OS process trees.
- **Keep chat-turn tool-execution state ephemeral/in-memory** (it doesn't need to survive a server restart — an interrupted approval should just resolve to "denied" or "the turn errored," not haunt a database forever), while **generation jobs and their outputs are persisted** (they're project state per the charter's §72-73). Unsloth draws that same line: active-generation _tracking_ is in-memory, but its diffusion gallery / download records are persisted. DevGame's `GenerationJob`/`GeneratedAsset` should be persisted; the "who is actively cancelable right now" registry does not need to be.

### Do NOT copy

- Don't copy the specific in-memory registry data structure (a raw dict + lock) verbatim — reimplement to fit DevGame's own concurrency model and persistence layer (the charter's §10 already wants `GenerationJob` to be a real persisted record, which is a stronger foundation than Unsloth's ephemeral chat-generation registry; keep that strength).
- Don't copy the one-hour default approval timeout number uncritically — pick DevGame's own default based on how disruptive a paused agent turn actually is in our product (a coding agent mid-task blocking for an hour on a $2 image generation approval may be the wrong default; that's a product decision, not an architecture one).
- Don't let every subsystem invent its own status vocabulary the way Unsloth's downloads/training/diffusion/chat all did independently (see §6) — that's the one place this reference is a cautionary example, not a template.

---

## 5. Hardware UX

### What it does

This is Unsloth Studio's deepest and most battle-tested subsystem — genuinely thousands of lines devoted to knowing the truth about the machine it's running on, across CUDA, ROCm (AMD, including the Linux-sysfs vs. Windows-perf-counter split), Apple Silicon (both PyTorch-MPS and native MLX stacks, detected as _separate_ capabilities since a machine can have one without the other), and Intel XPU, with an explicit Vulkan fallback path for GPUs that don't support anything more specific.

A few structural ideas stand out:

- **Hardware detection is asynchronous and cached with an invalidation epoch**, not synchronous on every request. Detection kicks off in the background at startup; anything that needs a hardware verdict either waits on the in-flight detection or is handed the last completed result, tagged with an epoch number, so a caller can tell "this is stale, a re-detection is already in progress" from "this is fresh." Detection can be explicitly invalidated (e.g. after a driver-affecting settings change) without blocking whoever's currently mid-request.
- **A GPU "arbiter"** mediates _exclusive_ GPU ownership across the different subsystems that might want it at once — chat inference, diffusion image generation, video generation, and training. Each has its own eviction routine; acquiring the GPU for one consumer politely evicts whichever other consumer currently holds it (unloading its model) rather than the two colliding and crashing or silently corrupting each other's VRAM usage. There's a "who currently owns the GPU" query and a conditional release ("release only if some predicate about my own state still holds," to avoid a stale release racing a newer acquisition).
- **VRAM and utilization reporting is per-GPU**, not just system-wide, including reconciling "unified memory" architectures (Apple Silicon, some AMD APUs) where GPU and system RAM aren't really separate pools — those get a distinct correction path rather than being reported as if they were a normal discrete GPU.
- **The "requested vs. applied, with a reason" pattern from §3 appears here at its richest.** Every advanced hardware knob (device placement, GPU memory strategy, KV-cache quantization bit-width, tensor split, offload policy) is reported back not just as "what's active now" but as a structured `{value, requested, source, status, reason}` tuple: `source` says whether the backend auto-decided this or the user explicitly set it; `status` says whether the request was honored outright, honored partially with a fallback, or flatly unsupported on this hardware/model combination; `reason` is the short human-readable why. This is what lets a UI show an "Auto: Q4_K_M (your GPU can't fit the full-precision cache)" badge instead of either silently downgrading or throwing an opaque error.
- **CPU fallback is explained, not just reported.** If an automatic GPU launch crashed at startup and the system recovered by silently relaunching the same model CPU-only, that fact — and specifically _that it was a Vulkan startup crash_ — is preserved and surfaced, not laundered into a plain "running on CPU."

### Worth independently implementing in DevGame

- **A GPU/VRAM arbiter is directly relevant if DevGame ever runs more than one local generation backend concurrently** (a local image model and a local 3D/mesh model, say, or a local LLM subagent alongside a local image model per charter §5's "local LLM/subagent work" idea) — sharing one GPU without an arbiter is how you get silent OOM crashes mid-generation. Even a minimal version (one mutex-like "who owns the GPU right now" plus an eviction callback per consumer) is worth having before DevGame supports more than one simultaneous local backend.
- **The `{value, requested, source, status, reason}` provenance shape is the single most reusable idea in this whole codebase**, and it directly answers the charter's hardware-UX question ("how are GPU/VRAM/model-fit/CPU-fallback communicated?"). Apply it anywhere DevGame auto-resolves something the user could have overridden: auto-picked generation provider, auto-downgraded 3D polycount target, auto-selected local vs. cloud backend. "Here's what happened and why" beats a bare status every time, and it costs almost nothing to add to a response schema.
- **Async, cached, epoch-tagged hardware detection** — don't probe GPU/VRAM state synchronously on the hot path of every request. Detect once in the background, cache it, invalidate explicitly on relevant changes, and let callers ask "is this still fresh."
- **Treat unified-memory hardware (Apple Silicon, integrated GPUs) as a genuinely distinct case**, not an edge case of discrete-GPU reporting logic. If DevGame's local-backend research (charter §41) targets Apple Silicon users at all, budget real design time for "there's no separate VRAM number to show" rather than bolting it on later.

### Do NOT copy

- Don't attempt to build DevGame's own from-scratch multi-backend (CUDA/ROCm/MLX/XPU/Vulkan) hardware probing layer — that is an enormous, ongoing maintenance burden that Unsloth (and ComfyUI, ollama, LM Studio, etc.) have already sunk years into. If DevGame needs raw GPU/VRAM facts, get them from whatever local backend/runtime we actually integrate with (its own status endpoint), rather than reimplementing platform-specific sensor code. This is squarely in "we are not building a full local-model-manager" territory (charter §70).
- Don't copy the specific sysfs paths, perf-counter names, or vendor-tool invocations — those are exactly the kind of AGPL implementation detail that must not be transcribed, and they're also just not ours to maintain.

---

## 6. Local/Cloud Unification — How It Avoids Feeling Like Two Products

### What it does

Three separate mechanisms combine to make local and cloud model use feel like one product rather than a chat UI bolted onto an unrelated API-key manager:

1. **One conversational contract, multiple backends behind it.** The chat surface talks in terms of a single request/response shape regardless of whether the model behind it is a local GGUF model on this machine or a proxied call to an external provider. The _same_ UI (model picker, chat thread, streaming response, tool-calling, image attachments) works whether "the model" resolves locally or remotely — the provider distinction lives in configuration and routing, not in a fork of the UI.

2. **Studio can also _be_ the compatible endpoint, not just _call_ one.** It exposes OpenAI-compatible Chat Completions and Responses API surfaces, and an Anthropic-Messages-compatible surface, as its own local HTTP API — meaning any tool built against OpenAI's or Anthropic's API shape (including, per its own documentation, coding agents like Claude Code and Codex) can point at a locally-running Studio instance and get served by a local model with zero client-side changes. This is the real mechanism behind "feels like one product": it's not that cloud providers were made to _look_ local, it's that the _local_ server was made to speak the _cloud_ protocol other tools already expect.

3. **Remote reachability without giving up the local-first default.** A locally-running instance can optionally be exposed through a zero-config, no-account tunnel for remote/mobile access, gated behind an authentication step, with a **safety timer**: if the instance is exposed to the network with its bootstrap admin credential still unchanged, it auto-shuts-down after a bounded window unless the operator completes a forced first-login credential change — and that forced-change prompt is specifically required before a public tunnel URL is even handed out. This scoping is deliberate: the safety timer only applies to network-exposed launches (not a pure loopback dev session, not the API-key-only mode, not a hosted-notebook mode where the credential model is different), so it protects the actual risk (an unconfigured instance left reachable from the internet) without nagging a purely local user.

### Worth independently implementing in DevGame

- **Route intent through one contract; let configuration decide the backend.** The charter already states this as a hard rule for the agent tool surface (§4A: the agent calls `generate_image(...)`, never `run_unsloth_image_generation(...)`) — Unsloth's chat UI is concrete proof the same discipline works at the _human_ UI layer too, not just the agent-tool layer. DevGame's Generation tab/inspector (charter §31-33) should look and behave identically regardless of whether the asset came from a local backend or a cloud provider; only a small provenance/badge area should differ.
- **If DevGame ever wants a coding agent (Claude Code, Codex, OpenCode) to treat a local generation backend as a first-class citizen, consider exposing our own generation surface in a protocol those tools already understand (MCP) rather than a bespoke one** — this is the same logic Unsloth applied at the LLM-API layer, generalized: speaking a protocol other tools already parse is cheaper than asking every client to learn a new one. This is a strong argument in favor of the charter's own "Harness MCP" hypothesis (§17, §19) over a bespoke `Game Harness Tool` protocol invented from scratch.
- **A default-deny, safety-timed remote-exposure model is worth adapting if DevGame's harness (per charter §44) ever gets a "remote client / phone" mode.** The specific pairing — forced credential rotation gates the tunnel URL, and an unconfigured-but-exposed instance self-terminates on a timer — is a cheap, high-value safety default for exactly the "project host may be reachable from a remote client" scenario the charter raises.

### Do NOT copy

- Don't copy the specific OpenAI/Anthropic wire-protocol emulation work itself (that's a large, ongoing compatibility-shim effort tightly coupled to those APIs' evolution, and irrelevant to DevGame's actual need, which is coding-agent tool access, not chat-API compatibility). The _transferable_ idea is "speak a protocol your target clients already parse"; for DevGame that protocol is MCP/native agent tools, not OpenAI's chat schema.
- Don't copy the tunnel provider, its branding, or its exact safety-timer thresholds — pick DevGame's own remote-access mechanism and timeout values once the charter's remote-client questions (§44) are actually being implemented, not before.

---

## 7. A Cross-Cutting Finding: Status-Vocabulary Fragmentation (a caution, not a pattern to copy)

Worth calling out on its own because it's a genuine, evidence-based counter-example rather than a pattern to imitate: Unsloth Studio does **not** have one shared job/status vocabulary. Downloads use `idle/running/cancelling/cancelled/complete/error`. Training uses `pending/queued/error` at creation and a _different_ set — `running/completed/stopped/error` — once underway (note: "stopped," not "cancelled," for the same underlying concept a download calls "cancelled"). Diffusion generation tracks progress via an `active` boolean plus step counters rather than a named status at all. Chat generation has no persisted status field whatsoever — presence in the in-memory active-generation registry _is_ the status. Four different subsystems, four different vocabularies for conceptually adjacent things.

This almost certainly reflects each subsystem being built by different people/eras rather than a deliberate design choice, and it's a real cost: a frontend engineer touching a new subsystem has to relearn its status spelling every time, and there's no shared "is this job in a terminal state" helper that works everywhere.

**The charter's own instinct — a single shared `GenerationJob.status` core vocabulary (`created/queued/running/succeeded/failed/cancelled`, §10) — is the better call, and this reference makes the case for sticking with it.** Where a specific modality needs richer detail than the shared status can carry (diffusion's step/total/eta, downloads' bytes/fraction/transport), add a modality-specific **`phase`/`progress` sub-object alongside the shared status**, the way Unsloth's own diffusion-load and download-progress responses already layer a `phase` on top of (rather than instead of) an overall state. Don't let per-modality progress detail leak into inventing a whole new top-level status enum per modality.

---

## 8. Summary Table

| Area                      | Unsloth pattern worth taking                                                                                                                                                        | What to deliberately not do                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Provider architecture     | registry (types) vs. saved configs (connections) vs. local resources, kept as 3 separate concepts; secrets never round-trip through config API; `/test` before save                 | don't copy chat-shaped provider schema onto job-shaped generation providers                                                           |
| Capability discovery      | independent boolean/graded flags per capability; multi-granularity limits (native/hardware-capped/active)                                                                           | don't force cloud-provider capability precision to match local-model precision if the real providers can't back it                    |
| Model lifecycle           | two separate tracks: acquisition (download) vs. runtime (load); generation-counter + job adoption for reconnecting clients; refuse-with-override instead of silent eviction         | don't spawn a subprocess for every long op by default; only for genuinely heavy local work                                            |
| Generation/task lifecycle | per-modality progress shape (steps for diffusion, coarse status for opaque APIs); race-safe human-approval gate (register→announce→wait→resolve, default-deny, first-decision-wins) | don't let every subsystem invent its own status vocabulary (see §7)                                                                   |
| Hardware UX               | requested-vs-applied-with-reason on every auto-decision; async cached hardware detection with invalidation epoch; GPU arbiter for exclusive multi-consumer access                   | don't build a from-scratch multi-vendor GPU sensor layer; source hardware facts from whatever local backend we actually integrate     |
| Local/cloud unification   | one UI contract regardless of backend; _be_ the compatible endpoint other tools expect, don't just consume providers; default-deny safety timer on remote exposure                  | don't copy the specific wire-protocol emulation; the transferable idea is "speak MCP/native agent tools," not "speak OpenAI's schema" |

---

## Appendix: Source Provenance

- Repository: `https://github.com/unslothai/unsloth` (public, organization `unslothai`)
- Subtree studied: `studio/` (backend Python/FastAPI, `studio/frontend/`, `studio/src-tauri/`)
- License of subtree studied: **AGPL-3.0-only**, per `studio/LICENSE.AGPL-3.0` and per-file `SPDX-License-Identifier: AGPL-3.0-only` headers confirmed directly in `studio/backend/models/providers.py`, `studio/backend/routes/providers.py`, `studio/backend/routes/inference.py`, `studio/backend/state/tool_approvals.py`, `studio/backend/mcp_server.py`, `studio/backend/auth/*.py`, and others.
- License of the repository root package (`unsloth` core training library, outside `studio/`): Apache-2.0 — **not** what was studied here; noted only to avoid confusing the two.
- Clone method: read-only, blobless partial clone (`git clone --filter=blob:none --sparse --no-checkout`) with sparse-checkout limited to `studio/`, `LICENSE`, `COPYING`, `README.md`, `pyproject.toml`; performed into a scratch job directory outside any writable project checkout. No code from this clone was copied into this document or into any DevGame source file.
- Files consulted for this analysis (structure, field names, and control flow read for behavioral understanding — not transcribed): `studio/backend/models/{providers,models,inference,training}.py`; `studio/backend/routes/{providers,inference,models}.py`; `studio/backend/state/{active_generations,tool_approvals,tool_policy}.py`; `studio/backend/storage/{providers_db,credential_secrets}.py`; `studio/backend/hub/schemas/downloads.py`; `studio/backend/hub/services/download_lifecycle.py`; `studio/backend/core/inference/gpu_arbiter.py`; `studio/backend/utils/hardware/hardware.py`; `studio/backend/mcp_server.py`; `studio/backend/auth/{authentication,bootstrap_timeout,terminal_prompt}.py`; `studio/backend/cloudflare_tunnel.py`; `studio/frontend/src/` directory structure (folder names only, for product-surface inventory).
- Also consulted: the public Unsloth documentation page for Studio and public search results describing Studio's feature set at a marketing/overview level (used only to sanity-check the high-level framing in §0, not as a source for any architectural claim above — every architectural claim in §1-7 is grounded in the source tree itself).
