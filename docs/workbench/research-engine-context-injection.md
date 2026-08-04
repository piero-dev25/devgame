# How context reaches the model in DevGame — and the right shape for engine context

Research pass, read-only, on `/Users/pieroherrera/Projects/t3code-fork`
(branch `workbench/dock-port`, working tree dirty from four concurrent lanes —
line numbers below were read from the working tree, not from HEAD).

**Every claim is labelled.**

- **VERIFIED** — I read the code at the cited `path:line`, or executed something and
  read the output. Executed measurements name the script.
- **DOCUMENTED** — quoted from a document in the repo, with its path. I did no web
  fetching in this pass (another lane owns web research), so there are no external
  URLs in this document.
- **ASSUMPTION** — reasoning, inference, or prior knowledge. Not checked this session.
  Treat as a hypothesis with a stated confidence.

Measurement scripts live at `/Users/pieroherrera/.claude/jobs/d1eda764/tmp/measure-mcp.ts`
and `/Users/pieroherrera/.claude/jobs/d1eda764/tmp/measure-blocks.ts`. Both import the
real repo modules and were run with
`node --experimental-strip-types` from `/Users/pieroherrera/Projects/t3code-fork/apps/server`.
Token figures are `chars / 4`, which is an **ASSUMPTION** (standard rough English/code
ratio) — the character counts themselves are VERIFIED.

---

## 0. The one-paragraph answer

This codebase has exactly **two** shapes for getting non-typed content to the model, and
it has already committed hard to one of them. The dominant shape is a **trailing
XML-ish text block appended to the outgoing user message** — there are five of them
today, a sixth is being built right now in another lane, and `<editor_selection>` (engine
selection) is already one of the five. The other shape is a **per-thread authenticated
MCP HTTP server** that every one of the five providers is wired to, which today exposes
exactly one capability (`preview`, 14 browser tools) and costs a measured **4,270 tokens
per session, always, on every provider, used or not**. There is no third shape: the
system prompt is a locked preset for Claude, `devgame.json` has no instructions field,
and nothing in the harness reads AGENTS.md/CLAUDE.md itself. For engine context, the
right answer is **both, split by signal**: a one-line always-on headline that makes the
engine's existence and level-state visible, and MCP tools for everything with a payload.
Pushing console logs as text would be the single worst decision available here.

---

# PART 1 — This codebase

## 1.1 The census

| #   | Mechanism                                              | Push/Pull           | Per-turn / per-session                     | Who pays                         | Survives compaction           |
| --- | ------------------------------------------------------ | ------------------- | ------------------------------------------ | -------------------------------- | ----------------------------- |
| 1   | `<terminal_context>` block                             | push                | per-turn (one-shot gesture)                | user's context window            | no (see §1.9)                 |
| 2   | `<element_context>` block                              | push                | per-turn (one-shot gesture)                | user's context window            | no                            |
| 3   | `<preview_annotation>` block                           | push                | per-turn (one-shot gesture)                | user's context window            | no                            |
| 4   | `<review_comment>` block                               | push                | per-turn (one-shot gesture)                | user's context window            | no                            |
| 5   | `<editor_selection>` block                             | push                | **per-turn, unconditional**                | user's context window            | no                            |
| 6   | `<third_party_source>` block (in flight, another lane) | push                | per-turn (one-shot gesture)                | user's context window            | no                            |
| 7   | `Ultrathink:` prompt prefix                            | push                | per-turn, conditional                      | user's context window            | no                            |
| 8   | Image attachments                                      | push                | per-turn, one-shot                         | user's context window            | no                            |
| 9   | `devgame` MCP HTTP server (`preview_*`, 14 tools)      | **pull**            | **per-session**                            | tool-list overhead every request | **yes** (structurally — §1.9) |
| 10  | Codex `developer_instructions`                         | push                | **per-turn** (Codex only)                  | user's context window            | ASSUMPTION: likely yes (§1.6) |
| 11  | Claude `systemPrompt` preset + `settingSources`        | pull-ish, delegated | per-session                                | provider-side                    | provider-side                 |
| 12  | `@path` mentions                                       | push (literal text) | per-turn                                   | user's context window            | no                            |
| 13  | `devgame.json`                                         | —                   | **carries no agent-facing content at all** | —                                | —                             |

**VERIFIED**: rows 1–9, 11, 12, 13. Row 10 push/per-turn is VERIFIED; its compaction
behaviour is ASSUMPTION.

## 1.2 System prompt / instruction assembly

**There is no DevGame-authored system prompt for Claude.** VERIFIED:

- `apps/server/src/provider/Layers/ClaudeAdapter.ts:3528` —
  `systemPrompt: { type: "preset", preset: "claude_code" }`. There is no `append`, no
  custom string, and no other `systemPrompt` assignment anywhere in `apps/server/src` or
  `packages/` (VERIFIED by exhaustive grep for `systemPrompt|system_prompt|customSystemPrompt|appendSystemPrompt`
  — that single line is the only hit).
- `apps/server/src/provider/Layers/ClaudeAdapter.ts:3529` + `:884-888` —
  `settingSources: ["user", "project", "local"]`. This is the harness _opting the spawned
  Claude Code CLI into reading its own config layers_, which is the channel by which
  `CLAUDE.md`, project settings, hooks and skills reach the model. **DevGame delegates
  rather than assembles.** It never reads those files to build a prompt; it only tells
  the CLI it is allowed to.
- Corroborating: `apps/server/src/provider/Drivers/ClaudeSkills.ts:1-12` scans
  `<config dir>/skills` and `<cwd>/.claude/skills` **for the `$` picker UI only** —
  DOCUMENTED, from that file's own module docstring: _"The Agent SDK init handshake
  surfaces skills only as slash commands without their filesystem paths, so the provider
  snapshot scans the same locations directly."_ This is a read for display, not an
  injection path.

**Codex is the one exception, and it is the only per-turn instruction seam in the fork.**
VERIFIED:

- `apps/server/src/provider/CodexDeveloperInstructions.ts:161-172` —
  `buildCodexDeveloperInstructions(interactionMode, runtime)` composes a
  `<collaboration_mode>` block plus a `<runtime_info>` block.
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts:353`, inside
  `buildCodexCollaborationMode`, which is called from `buildTurnStartParams`
  (`:361`, and the only call site is `:1295`). `buildTurnStartParams` takes `prompt` and
  `attachments` — it is **per turn**. So Codex receives a freshly-built instruction block
  on every single turn.
- That block already contains DevGame product prose. DOCUMENTED, from
  `CodexDeveloperInstructions.ts:3-13`: _"You are running inside DevGame. The `devgame`
  MCP server is the product-native collaborative browser shared with the user. When it
  exposes `preview\__` tools, prefer those tools..."\*
- **Measured cost** (VERIFIED, `measure-blocks.ts`): 2,284 chars ≈ **571 tokens** in
  default mode, 8,395 chars ≈ **2,099 tokens** in plan mode — every turn.

**This asymmetry is the single most important constraint on any instruction-shaped
proposal.** Codex has a per-turn instruction seam; Claude has none at all; Cursor, Grok
and OpenCode go through ACP/SDK session creation and were not observed to have one
(ASSUMPTION, medium confidence — I did not exhaustively audit those three for an
instruction field). Any design that depends on telling the model something out-of-band
either only works on Codex, or has to be re-expressed as message text (making it a push
block) or as tool descriptions (making it a pull affordance).

**Can it change mid-session?** For Codex, yes — it is rebuilt per turn and could vary.
For Claude, the `systemPrompt` is fixed at `createQuery` time
(`ClaudeAdapter.ts:3524-3562` is inside the query-options object passed to `createQuery`
at `:3591`), i.e. per session. VERIFIED.

## 1.3 The `<preview_annotation>` precedent — precisely

This is the mechanism the brief asked me to document exactly, because a new mechanism
either extends it or deliberately differs from it.

**Build side** — `apps/web/src/lib/previewAnnotation.ts`:

- `buildPreviewAnnotationPrompt(annotation)` at `:21-59` produces a newline-joined
  `<preview_annotation>…</preview_annotation>` block. Body is `Key: value` lines
  (`Id:`, `Page:`, `Comment:`, `Targets:`), an optional `Requested visual changes:`
  heading with `- prop: old → new` bullets, an optional screenshot sentence, and an
  optionally _nested_ `<element_context>` block via `buildElementContextBlock` (`:53-57`).
- `appendPreviewAnnotationPrompt(prompt, annotation)` at `:61-68` — trims the prompt,
  joins with `\n\n`, returns the annotation alone if the prompt was empty. VERIFIED.
- The screenshot does **not** travel in the text. `previewAnnotationScreenshotFile`
  (`:102-111`) converts the data URL into a `File`, which then rides the normal image
  attachment path (§1.5). The text block only says _"The attached screenshot is the
  annotated preview crop."_ (`:51`). VERIFIED. This is a real design lesson: **binary
  payload goes through attachments, the text block carries only a pointer to it.**

**Read side** — `extractTrailingPreviewAnnotation` at `:70-100`, anchored with
`/\n*<preview_annotation>\n(…)\n<\/preview_annotation>\s*$/` (`:4-5`) so the transcript
strips the block and renders a chip instead of raw markup. VERIFIED.

**Send-path integration** — `apps/web/src/components/ChatView.tsx:4756`:

```
const messageTextWithPreviewAnnotations = composerPreviewAnnotationsSnapshot.reduce(
  (text, annotation) => appendPreviewAnnotationPrompt(text, annotation),
  messageTextWithContexts,
);
```

VERIFIED.

**The full composition chain** — `ChatView.tsx:4751-4772`, VERIFIED. Read outward-in:

1. `promptForSend` (the user's typed text)
2. `appendTerminalContextsToPrompt(...)` → `<terminal_context>`
3. `appendElementContextsToPrompt(...)` → `<element_context>`
4. `.reduce(appendPreviewAnnotationPrompt)` → `<preview_annotation>` (n times)
5. `appendReviewCommentsToPrompt(...)` → `<review_comment>`
6. `appendEditorSelectionToPrompt(..., getCurrentEditorPresenceChips())` → `<editor_selection>`
7. `formatOutgoingPrompt(...)` → optional `Ultrathink:\n` prefix

The ordering is deliberate and documented in-code. DOCUMENTED, `ChatView.tsx:4760-4764`:
_"Appended outermost (after review comments too), not interleaved with the
terminal/element chain above: that keeps it the one, unconditional trailing block on the
read side, so MessagesTimeline.tsx can strip it before any of the existing
terminal/element/preview-annotation extraction runs."_

Note the phrase **"the one, unconditional trailing block."** That is the author of the
editor-selection lane stating in a code comment that `<editor_selection>` is
categorically different from the four blocks before it: the others fire on a user
gesture, this one fires always.

**Every block in the family shares one contract** (VERIFIED across
`previewAnnotation.ts:61-68`, `elementContext.ts:190-198`, `terminalContext.ts:211-220`,
`editorSelectionContext.ts:80-88`, `reviewCommentContext.ts:205`): empty input ⇒ empty
block ⇒ prompt returned **unchanged**. No empty tag pair is ever emitted. Any new
mechanism must honour this or it pollutes every message forever.

## 1.4 Editor presence chips — what actually reaches the model

The brief asked: when a user pins a selection chip, what reaches the model? Text? An
attachment? Nothing until they type?

**Answer: text, and not only the pinned ones — every live chip too, on every send, whether
or not the user pinned anything.** VERIFIED, by this chain:

1. `apps/web/src/editorPresence/EditorPresenceChips.tsx:30-36` — the component computes
   `mergeEditorPresenceChips(liveChips, pinned)` and pushes the merged list into a
   module-level snapshot via `publishCurrentEditorPresenceChips(chips)` on every render.
2. `apps/web/src/editorPresence/store.ts:133-143` — `currentChipsSnapshot` is a plain
   module variable; `getCurrentEditorPresenceChips()` reads it synchronously.
   DOCUMENTED, from that file's own comment at `:126-132`: _"so ChatView.tsx's send path
   … can read 'what would attach right now' with a single synchronous call."_
3. `ChatView.tsx:4765` calls `appendEditorSelectionToPrompt(..., getCurrentEditorPresenceChips())`
   with **no filter and no conditional**.
4. `apps/web/src/editorPresence/editorSelectionContext.ts:60-88` serialises them.

The serialised shape (VERIFIED by executing `buildEditorSelectionBlock` in
`measure-blocks.ts`):

```
<editor_selection>
- EnemySpawner_0 (gameObject) [pinned]:
  id: GameObject:100000
  path: Assets/Scenes/Level01.unity/Spawners/EnemySpawner_0
  detail: Transform, EnemySpawner, BoxCollider
</editor_selection>
```

**Measured cost** (VERIFIED, `measure-blocks.ts`, realistic Unity-shaped fields):

| chips        | chars  | ≈ tokens |
| ------------ | ------ | -------- |
| 1            | 209    | 52       |
| 3            | 535    | 134      |
| 10           | 1,676  | 419      |
| 64 (the cap) | 10,586 | 2,647    |

Pinning does exactly two things and neither is "cause attachment": it keeps a chip
visible after it leaves the live selection (`store.ts:103-118`, snapshot-based), and it
wins the truncation priority ordering at the 64-item cap
(`editorSelectionContext.ts:29-35`, `:21`). VERIFIED.

`playState` is **not** serialised. The block only emits `label`, `kind`, `[pinned]`, `id`,
`path`, `detail` (`editorSelectionContext.ts:37-47`). Play state exists on the wire
(`apps/web/src/editorPresence/protocol.ts:53`, `:82`) and drives the toolbar
(`apps/web/src/components/EngineToolbar.logic.ts:129`, `:213-214`) but **never reaches the
model today**. VERIFIED. Same for `workspace.root`, `editor.version`, `capabilities`, and
`connected` — all present in `EditorPresenceEntry` (`protocol.ts:65-83`), none serialised.

### Defect found in passing — chips are environment-wide, not project-scoped

**VERIFIED.** `deriveLiveEditorPresenceChips(editors)` (`store.ts:45-62`) flattens **every**
connected publisher in the environment. `EditorPresenceChips` is mounted with only an
`environmentId` (`EditorPresenceChips.tsx:20-26`). The send path uses that unfiltered
snapshot. Meanwhile `apps/web/src/editorPresence/resolveProjectEditor.ts:35-47` exists
and does exactly the right thing — matches a publisher to a project by normalised
`workspace.root` — and the send path does not call it.

Consequence: with two engine editors open on two projects, a thread rooted at project A
can silently ship project B's selected objects to the model as `<editor_selection>`.
Whether that is reachable in the shipped UI I did not test (**ASSUMPTION**: it is, since
presence is explicitly environment-scoped by owner ruling — DOCUMENTED, `store.ts:9-10`:
_"Global, not per-thread (owner ruling — presence is a property of the connected editor,
not of a conversation)"_). Worth a separate ticket regardless of what happens with engine
context.

## 1.5 Attachments

**VERIFIED.** Attachments are **images only** — `ChatAttachment = Schema.Union([ChatImageAttachment])`
(`packages/contracts/src/orchestration.ts:180`), and `mimeType` is checked against
`/^image\//i` (`:164`). There is no file, text, or JSON attachment variant. Caps
(`orchestration.ts:145-148`): 8 attachments, 10 MB each, 14M-char data URL, and
`PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000` for the text.

Adapter conversion, all VERIFIED:

- **Claude** — `ClaudeAdapter.ts:920-931` `buildClaudeImageContentBlock` emits
  `{type:"image", source:{type:"base64", media_type, data}}`; assembled at `:933-990`,
  MIME-allowlisted to gif/jpeg/png/webp at `:876-883`, non-image attachments skipped at
  `:950-952`.
- **Cursor** — `CursorAdapter.ts:963-996`: builds an ACP `ContentBlock[]` of
  `{type:"text"}` then `{type:"image", data, mimeType}`.
- **Grok** — `GrokAdapter.ts:981` — same ACP shape.
- **Codex** — attachments become `{type:"image", url}` turn inputs
  (`CodexSessionRuntime.ts:361-386`).

**The relevant negative finding:** ACP defines five content-block variants —
`text`, `image`, `audio`, `resource_link`, `resource`
(`packages/effect-acp/src/_generated/schema.gen.ts:1462-1500`, VERIFIED). The fork uses
**two**. `resource` is ACP's protocol-native "one-shot structured context attached to this
message" primitive; DOCUMENTED, from the generated schema at `:2068`: _"Agent supports
embedded context in `session/prompt` requests. When enabled, the Client is allowed to
include [`ContentBlock::Resource`] in prompt requests for pieces of context that are
referenced in the message."_ `resource_link` is the cheap-pointer variant, and DOCUMENTED
at `:2080` it is **baseline-required**, not opt-in: _"Baseline agent functionality
requires support for [`ContentBlock::Text`] and [`ContentBlock::ResourceLink`]."_

So there is an unused, protocol-blessed structured-context seam for the two ACP providers.
It does **not** exist for Claude (SDK content blocks) or Codex. **ASSUMPTION** (high
confidence): using it would mean engine context arrives structured on Cursor/Grok and as
text everywhere else — two code paths and two truths. That is a reason not to reach for
it first, not a reason it is bad.

## 1.6 MCP — the pull mechanism, already built and already paid for

This is the most under-appreciated finding in the codebase.

**All five providers already receive a per-thread, authenticated, HTTP MCP server named
`devgame`.** VERIFIED at every site:

| Provider | Site                           | Wire form                                                                |
| -------- | ------------------------------ | ------------------------------------------------------------------------ |
| Claude   | `ClaudeAdapter.ts:3550-3561`   | `mcpServers: { devgame: { type:"http", url, headers:{Authorization} } }` |
| Cursor   | `CursorAdapter.ts:534-558`     | ACP `mcpServers: [{type:"http", name:"devgame", url, headers:[…]}]`      |
| Grok     | `GrokAdapter.ts:572-596`       | same ACP array shape                                                     |
| Codex    | `CodexAdapter.ts:1397-1430`    | `-c mcp_servers.devgame.url=…` + `DEVGAME_MCP_BEARER_TOKEN` env var      |
| OpenCode | `OpenCodeAdapter.ts:1217-1227` | `client.mcp.add({ url, headers:{Authorization} })`                       |

The brief described `ClaudeAdapter.ts:3551` as "a one-entry map today". Correct — and the
same one entry is wired identically into four other adapters. **The seam is not
Claude-specific and it is not hypothetical.**

Lifecycle, VERIFIED:

- Credential issued at session start — `ProviderService.ts:217-224`
  (`prepareMcpSession` → `issueActiveMcpCredential` → `setMcpProviderSession`).
- Stored in a plain per-thread module map — `apps/server/src/mcp/McpProviderSession.ts`.
- Token is a 32-byte random, stored SHA-256-hashed —
  `McpSessionRegistry.ts:120-150`.
- Scope carries `environmentId`, `threadId`, `providerSessionId`, `providerInstanceId`,
  and **`capabilities: new Set(["preview"])` — hardcoded** at `McpSessionRegistry.ts:131`.
- Bearer auth middleware resolves the scope and provides it as
  `McpInvocationContext` — `McpHttpServer.ts:66-90`.
- Per-tool capability gate — `McpInvocationContext.ts:26-39` `requireMcpCapability`.
  `McpCapability` is `"preview"` (`:11`) — a one-member union with an obvious extension
  point.
- Liveness window 24 h (`McpSessionRegistry.ts:73`), refreshed each turn
  (`ProviderService.ts:687`). Not a practical expiry risk.
- **Tools are registered statically at server boot** —
  `McpHttpServer.ts:206-225`, `McpServer.toolkit(PreviewStandardToolkit)` inside a Layer.
  There is no per-session tool filtering. **Every session on every provider sees the full
  tool list; the capability check only fires at call time.** VERIFIED.

### Measured cost of the pull mechanism

**VERIFIED** by `measure-mcp.ts`, which imports the real `PreviewToolkit` and calls
`Tool.getJsonSchema` — the exact function `McpServer.js:559` uses to answer `tools/list`:

```
tools: 14
tools/list JSON chars: 17,078   ≈ 4,270 tokens
```

Per-tool, largest first: `preview_navigate` 3,050 chars, `preview_resize` 2,381,
`preview_open` 1,525, `preview_click` 1,427, `preview_evaluate` 1,316,
`preview_type`/`preview_wait_for` 1,267, `preview_scroll` 1,082, `preview_press` 1,024,
`preview_set_appearance` 858, `preview_status` 526, `preview_snapshot` 490,
`preview_recording_stop` 440, `preview_recording_start` 400.

**Roughly 300 tokens per tool, averaged, dominated by parameter JSON Schema rather than
description prose** (descriptions alone are 2,854 chars ≈ 714 tokens; the other ~3,550
tokens are schemas). Design consequence: **a tool with a small parameter schema is far
cheaper than a tool with a rich one.** `preview_snapshot` costs 490 chars because its
parameters are a bare tab target; `preview_navigate` costs 3,050 because it takes a
discriminated union of navigation targets.

This is the number to hold against any "just add a text block" proposal. 4,270 tokens are
already being spent, per session, on all five providers, for browser tools the user may
never touch.

## 1.7 `devgame.json` — no seat for agent instructions

**VERIFIED.** `packages/contracts/src/t3ProjectFile.ts` defines the whole file: `$schema`,
`iconPath`, and `scripts[]` (each `name`, `command`, `icon`, `runOnWorktreeCreate`,
`previewUrl`, `autoOpenPreview`), capped at 50 scripts. **There is no instructions field,
no rules field, no context field, and nothing agent-facing.** The repo's own
`devgame.json` (root) confirms the shape in practice.

Same for the runtime project record: `OrchestrationProject`
(`packages/contracts/src/orchestration.ts:215-230`) carries `id`, `title`,
`workspaceRoot`, `repositoryIdentity`, `engineType`, `defaultModelSelection`, `scripts`,
timestamps. No instructions field. VERIFIED.

Worth noting because it is directly on-point for engine context — DOCUMENTED, from
`orchestration.ts:220-223`:

> Detected LIVE from workspace marker files on every read (see EngineTypeResolver) —
> never persisted, so it can't go stale when an engine is added to an existing project
> folder.

`EngineType` is `"unity" | "unreal" | "godot" | "threejs"`
(`packages/contracts/src/project.ts:22`). VERIFIED. **The project already knows which
engine it is, freshly, on every read.** Any engine-context design gets that for free.

## 1.8 AGENTS.md / CLAUDE.md

**VERIFIED.** Nothing in `apps/server/src` or `apps/web/src` reads `AGENTS.md`,
`CLAUDE.md`, `.cursorrules` or `GEMINI.md` to build a prompt. The only hits are test
fixtures for `@`-mention parsing and a file-icon lookup
(`apps/web/src/pierre-icons.test.ts:26-27`).

`/Users/pieroherrera/Projects/t3code-fork/CLAUDE.md` is a **symlink to `AGENTS.md`**
(VERIFIED via `ls -la`) — a repo-authoring convenience, not a harness mechanism.

`@path` mentions are **literal text passthrough**. `splitPromptIntoComposerSegments`
(`apps/web/src/composer-editor-mentions.ts:198-222`) is used only by
`ComposerPromptEditor.tsx:830` and `composer-logic.ts` for **rendering and cursor
handling**. The prompt string sent over the wire still contains `@AGENTS.md` verbatim;
the provider CLI resolves it. VERIFIED (no expansion call site exists in the send path).

## 1.9 Compaction — the honest answer

**The fork does not compact and cannot control compaction.** VERIFIED:

- It only _observes_ it. Claude: `compact_boundary` system message handled at
  `ClaudeAdapter.ts:2622-2631`, with `compactsAutomatically` read off the SDK at `:481`.
  Codex: `thread/compacted` at `CodexAdapter.ts:685` and `CodexSessionRuntime.ts:529`.
  OpenCode: a hidden `"compaction"` agent name at `opencodeRuntime.ts:174`.
- The fork never replays conversation history. Each turn sends **one prompt string**
  (`ProviderSendTurnInput.input`, `packages/contracts/src/provider.ts:67-70`) and resumes
  the provider's own session by id (Claude: `resume: existingResumeSessionId`,
  `ClaudeAdapter.ts:3542`; ACP: `session/load` with `sessionId`,
  `AcpSessionRuntime.ts:560-565`).

Therefore, for **every push block** (rows 1–8, 12): once it is in the provider's
conversation, it is the provider's summariser's to keep or discard. The fork gets no
signal about whether a specific `<editor_selection>` block survived, and no way to
re-assert it short of the user sending another turn. **A pushed block does not survive
compaction in any guaranteed sense.**

For **MCP tools** (row 9): tool availability is not conversation state at all. The
provider process holds an MCP client connection and calls `tools/list` against our HTTP
server; our server answers from a Layer registered at boot, gated by a 24-h credential
refreshed each turn. **ASSUMPTION** (high confidence, from the in-repo architecture rather
than from an external spec I fetched): compaction rewrites message history and does not
touch the tool list, so tools survive it structurally. That is a genuine, structural
advantage of pull over push for anything that must remain true late in a long session.

For Codex `developer_instructions` (row 10): **ASSUMPTION** (medium confidence) — it is
rebuilt and re-sent every turn (VERIFIED), so even if compaction dropped it, the next turn
restores it. Self-healing by construction.

### Second defect found in passing — no aggregate budget on the append chain

**VERIFIED**: `PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000`
(`orchestration.ts:145`) is enforced **only** at the server→adapter boundary
(`provider.ts:67-70`). The client-side command schema
`ThreadTurnStartCommand.message.text` is a bare `Schema.String` with **no cap**
(`orchestration.ts:780-799`), and grep finds **no reference to the constant anywhere in
`apps/web`**.

Each appender caps itself independently — `<editor_selection>` at 64 items ≈ 10,586 chars,
terminal contexts and preview annotations at their own limits — but **nothing budgets the
composed total**. Six appenders can jointly exceed 120,000 chars.

**ASSUMPTION** (medium confidence, not executed): the message is accepted by the WS
command, persisted and shown in the transcript, and then the turn fails at provider
decode — i.e. the user's message appears to send and then the agent silently never
responds. Worth reproducing before acting on. It matters here because **console logs are
exactly the payload that would blow this budget**, and that is a direct input to Part 3.

---

# PART 2 — Comparable harnesses

Kept tight, per the brief. **In-repo primary sources are used where they exist; I did no
web fetching, so external-product claims are labelled ASSUMPTION rather than DOCUMENTED
even where I am fairly confident.**

## The three shapes, stated plainly

**A. Ambient push — injected every turn.** Always fresh, costs tokens unconditionally,
needs no model cooperation. Accumulates: at turn 40 the transcript contains 40 snapshots,
39 of them wrong, and the model resolves the contradiction by recency heuristics you do
not control.

**B. Pull — tools the model calls.** Costs a fixed per-session tool-list overhead
(measured here: ~300 tokens/tool) and nothing more until used. Always correct _at the
moment of the call_, which is the moment that matters. Weakness: the model must know to
ask, and a model that does not ask is a model that is not more capable.

**C. One-shot attach — bound to a specific message.** The user's gesture is the
relevance signal. Staleness is semantically _fine_ because the block means "here is what
I was pointing at when I said this", not "here is what is true now". This is DevGame's
`<terminal_context>` / `<element_context>` / `<preview_annotation>` / `<review_comment>`
family.

The failure mode to name explicitly: **C's machinery applied to A's data.** A block whose
serialisation says "here is what I was pointing at" carrying a value that is actually a
continuously-changing level. That is what `<editor_selection>` is today.

## Per-harness

**ACP (Cursor, Grok — VERIFIED in `packages/effect-acp/`).** Context is per-prompt content
blocks; five variants exist (`schema.gen.ts:1462-1500`), and the protocol distinguishes
the cheap pointer (`resource_link`, baseline-required per `:2080`) from the expensive
payload (`resource`, opt-in per `:2068`). MCP servers are supplied **per session**, at
`session/new` (`AcpSessionRuntime.ts:634-637`) and again at `session/load`
(`:561-565`). There is no ambient per-turn context channel
in the protocol as generated here. **The pointer/payload split is a protocol-level
endorsement of the hybrid recommended in Part 3.**

**Codex (VERIFIED in `packages/effect-codex-app-server/` + the adapter).** Has a real
per-turn instruction channel: `developer_instructions` inside
`collaborationMode.settings`, rebuilt each turn
(`CodexSessionRuntime.ts:338-357`). The generated schema also exposes `baseInstructions`
(`schema.gen.ts:11322`, `:11341`) which the fork does not use. MCP servers arrive via CLI
`-c mcp_servers.*` flags at process launch — per session. So Codex offers **B and A**, and
DevGame already uses both.

**Claude Code (VERIFIED where in-repo).** Fork side: `systemPrompt` is a locked preset and
`settingSources: ["user","project","local"]` delegates config discovery to the CLI
(`ClaudeAdapter.ts:3528-3529`). **ASSUMPTION** (high confidence, prior knowledge, not
verified this session): that delegation is what makes CLAUDE.md, hooks, skills and
project MCP config live for the spawned agent. Shape-wise Claude Code is A (CLAUDE.md,
session-level) + B (MCP, hooks) with no per-turn ambient channel the embedder can drive.

**Cursor as a product** (as distinct from Cursor-via-ACP): **ASSUMPTION** — rules files as
session-level A, `@`-mentions as C, codebase indexing as a B-shaped retrieval the model
invokes. Not verified this session; do not build on this line.

**GitHub Copilot**: **ASSUMPTION** — heavily A-shaped (open editors, cursor neighbourhood,
recent files assembled into each completion request), which is viable precisely because
completion requests are stateless and single-shot, so there is no accumulating transcript
to poison. **That statelessness is why Copilot's approach does not transfer to a
multi-turn chat harness**, and it is the clearest available illustration of why "just
inject the editor state every turn" is a different proposition here than it is there.
Not verified this session.

**Zed**: ACP client; see the ACP row. **ASSUMPTION** that its own context UI maps to
C-shaped per-prompt blocks.

---

# PART 3 — Recommendation

## The short version

**One mechanism is wrong for all four signals. Split them.**

| Signal         | Size                      | Volatility             | Relevance            | Recommended shape                          |
| -------------- | ------------------------- | ---------------------- | -------------------- | ------------------------------------------ |
| Active scene   | ~1 line                   | low (minutes)          | almost always        | **push**, in a one-line headline           |
| Play state     | 1 word                    | **changes mid-turn**   | often                | **push in the headline, and a pull tool**  |
| Selection      | small, 1–10 items typical | **changes constantly** | only while composing | **push, but gesture-gated**, + a pull tool |
| Console errors | unbounded (MBs)           | bursty                 | sometimes            | **pull only. Never push.**                 |

Concretely: **one ~30-token ambient headline block per turn, plus a 3–4 tool `engine`
MCP capability.** The push carries the _pointer_; the pull carries the _payload_. That is
the same split ACP encodes as `resource_link` vs `resource`
(`schema.gen.ts:2068`, `:2080` — VERIFIED), and the same split
`buildPreviewAnnotationPrompt` already uses for screenshots (text says "a screenshot is
attached", the bytes ride the attachment path — `previewAnnotation.ts:50-52`, VERIFIED).

## The headline block

```
<engine>
Unity 6000.3.14f1 · Level01.unity · playing · 3 objects selected
</engine>
```

**Measured basis**: ~70 chars ≈ **18 tokens/turn**; budget 30 to be safe. A 40-turn
session costs ~1,200 tokens total — under a third of what the `preview` toolkit already
costs per session for tools the user may never invoke (4,270 tokens, VERIFIED).

Why a headline at all, rather than pure pull: **it is the discovery mechanism.** The
weakness of B is that the model must know to ask, and DevGame's only per-turn place to
tell it is Codex-specific (§1.2). One line of ambient state in the message stream tells
every provider, uniformly, that an engine exists, which engine, and that it is live —
which is precisely the cue that makes `engine_*` tools get called. It is doing the job
that `T3_CODE_BROWSER_TOOL_INSTRUCTIONS` does for the preview tools on Codex, but
portably and at a twentieth of the cost (571 tokens/turn → ~18).

Constraints on it, all inherited from verified in-repo contracts:

- Honour the family's empty-input contract: **no engine connected ⇒ no block**
  (`editorSelectionContext.ts:60-61` pattern). Never an empty tag pair.
- Project-scope it via `resolveConnectedEditorForProject`
  (`resolveProjectEditor.ts:35-47`) — the function already exists and the current send
  path fails to use it (§1.4 defect).
- It must be a **fixed-width headline**, structurally incapable of growing. Counts, not
  contents. The moment someone adds "and the last 3 errors" to it, it has become the
  thing this document is arguing against.
- Emit it as its own trailing block, not folded into `<editor_selection>`, so the
  transcript extractor stays one-block-one-concern like the other five.

## The `engine` MCP capability

Extend `McpCapability` from `"preview"` to `"preview" | "engine"`
(`McpInvocationContext.ts:11`) and add `"engine"` to the issued scope at
`McpSessionRegistry.ts:131`. The plumbing to all five providers already exists and needs
no adapter change. **VERIFIED** that this is the whole seam.

Proposed tools, with cost discipline informed by the measured per-tool spread (a bare
target costs ~500 chars; a rich union costs ~3,000):

1. **`engine_status`** — scene, play state, compile/domain-reload state, engine version,
   selection count. Empty parameter object ⇒ cheap, expect ~500–700 chars. Backed by
   `UnityPipelineClient` `editor_status` (`UnityPipelineClient.ts:259-267`, VERIFIED) for
   Unity and by `EditorPresenceRegistry` for Godot/Unreal
   (`EditorPresenceRegistry.ts:211`, `:294` — VERIFIED, it is a server-side
   `Context.Service` an MCP handler can consume exactly as the preview toolkit consumes
   `PreviewAutomationBroker`).
2. **`engine_console_logs`** — **required** `severity` filter, **required** `limit` with a
   hard ceiling, tail semantics, and a truncation notice in the result. Unity's official
   package already exposes `get_console_logs` — DOCUMENTED, `unity/README.md`: _"…
   `editor_status` (play state, compilation, and domain-reload state in one read),
   `get_selection`, `get_console_logs`, `run_tests`, `capture_game_view`,
   `capture_scene_view`, and roughly 130 tools in total."_
3. **`engine_selection`** — full detail for currently-selected objects, so the agent can
   re-read after asking the user to select something. This is the one that makes the
   push-side selection block _shrinkable_ later.
4. _(optional, later)_ **`engine_scene_tree`** — bounded subtree query. Do not ship in the
   first slice; it invites unbounded results.

**Estimated cost**: ~1,000–1,500 tokens/session for 3 tools, on the measured ~300
tokens/tool average with small parameter schemas. **ASSUMPTION** until the schemas are
written and measured with the same script — and they should be, before merge, because the
schema is where the cost hides.

## Selection: the one place I would change existing behaviour

Today `<editor_selection>` is pushed unconditionally, all live chips plus all pinned
chips, on every send (§1.4, VERIFIED). I recommend **pushing only pinned chips**, and
making unpinned live chips display-only.

The argument is not token cost — at 1–3 chips it is 52–134 tokens, which is nothing. The
argument is that **an unconditional push of a continuously-changing level into an
append-only transcript manufactures contradictions**. Turn 3 says `Player` is selected.
Turn 12 says `EnemySpawner_4`. Turn 30 says nothing was selected. All three are in the
context. None is labelled current. The model has no rule for resolving them beyond
recency, and recency is wrong exactly when the user selects something and then asks a
question that is not about it.

The repo already reached this conclusion once, before the attachment layer was built.
DOCUMENTED, `docs/workbench/spec-editor-presence.md`:

> **Architectural call: presence is a level, not an edge, and it is separate from
> attachment.** … Converting presence into a persisted, prompt-serialized attachment is a
> distinct, later state. This is not expedience; it is what makes staleness impossible by
> construction rather than by an expiry check like `isTerminalContextExpired`.

Pinning is already the gesture that converts the level into an edge. It is built, it is
in the UI, and the send path currently ignores the distinction. Gating on it costs one
`.filter(chip => chip.pinned)` and restores the family's own semantics: **every other
block in the chain fires on a user gesture.**

**This contradicts a prior owner decision** — DOCUMENTED, `editorSelectionContext.ts:1-4`
describes auto-attach as _"the 'auto-attach' half of the owner-decided UX."_ I am flagging
the tension rather than assuming it away. If auto-attach stays, the compensating change
is to **cap the auto-attached set far below 64** — 5 or so — and let pins carry anything
beyond that. A 2,647-token selection dump (VERIFIED at the 64 cap) riding on a turn where
the user asked "what does this shader do?" is the pure form of the failure the brief asked
me to name: more tokens, no more capability.

## Console errors: pull, and I would argue against push even if asked twice

Three independent reasons, each sufficient:

1. **It can break the send.** The composed prompt has a hard 120,000-char ceiling enforced
   at the provider boundary with no client-side guard and no aggregate budget across the
   six appenders (§1.9, VERIFIED). A Unity console after a failed compile is routinely
   larger than that on its own.
2. **Relevance is episodic and the model knows when.** Errors matter right after a Play,
   a compile, or a user saying "it's broken". Every other turn they are noise that
   competes with the conversation for attention, and the same block re-pushed for 30 turns
   is 30 copies of the same stack trace.
3. **The pull already exists.** Unity's `get_console_logs` is there today
   (DOCUMENTED, `unity/README.md`).

If a stale pushed error block ever causes an agent to chase an error the user already
fixed, the mechanism has made the model measurably _less_ capable than having no engine
context at all. That is the plainest "cost with no benefit" case in the four.

## What I would not build

- **A per-turn instructions block for all providers.** The only existing precedent is
  Codex-specific and costs 571–2,099 tokens/turn (VERIFIED). Put the "how to use engine
  tools" guidance in the MCP **tool descriptions**, which all five providers see, at
  measured description-only cost (~700 tokens for 14 tools ⇒ ~50 tokens/tool).
- **An `instructions` field in `devgame.json`.** It does not exist (§1.7, VERIFIED),
  every provider already has its own well-known convention for this
  (AGENTS.md/CLAUDE.md, which the CLIs read themselves via `settingSources` — §1.2), and
  adding a seventh place for a project to state its rules makes the fork the odd one out.
- **ACP `resource` blocks, for now.** Real and unused (§1.5, VERIFIED), but it would give
  Cursor/Grok a structured path and everyone else a text path. Revisit only if a signal
  turns out to need genuinely structured delivery.
- **A seventh trailing text block per signal.** The family is at five, a sixth is in
  flight (`apps/web/src/browser/thirdPartySourceAnnotation.ts`, VERIFIED — untracked, from
  another lane). Each one is an independent, uncoordinated draw on a shared, uncapped
  budget. Engine context should add **one**.

## What would make me wrong

Stated as checks, in the order I would run them:

1. **The headline is ignored.** If agents in a live session never call an `engine_*` tool
   despite the headline being present, the headline is 18 tokens/turn of decoration and
   the discovery problem needs the Codex-style instruction route (accepting that it only
   works on Codex). _Check:_ instrument `tools/call` counts for the `engine` capability
   across ~20 real sessions.
2. **The headline is believed too hard.** If an agent cites the turn-3 scene name at turn
   40, the accumulation problem applies to one-liners too and the honest answer is pure
   pull. _Check:_ grep session transcripts for the model asserting a scene/play state that
   was stale at the moment it said it.
3. **Pull latency makes it useless.** `UnityPipelineClient` shells out to the `unity` CLI
   (`UnityPipelineClient.ts:259-267`, VERIFIED). If `engine_status` takes many seconds, an
   agent will stop calling it and pushed state becomes the pragmatic answer despite the
   accumulation cost. _Check:_ time `unity command editor_status` on a real project. **I
   did not measure this and it is the single biggest hole in this recommendation.**
4. **Pinning is too much friction.** If real users never pin, gating the selection push on
   pins means selection never reaches the model, which is worse than a bit of staleness.
   _Check:_ watch one real session. This is a product judgement the owner is better placed
   to make than I am.
5. **My token model is wrong.** Everything above is `chars / 4` (ASSUMPTION). If the real
   tokenisation of dense JSON schema is materially worse than 4:1, the pull mechanism is
   more expensive than stated and the balance shifts toward the headline carrying more.
   _Check:_ count the `tools/list` payload with a real tokenizer.

## Sequencing, if this is built

1. Fix the project-scoping defect (§1.4) — it is a correctness bug independent of
   everything else here, and every proposal above depends on the right editor being
   selected.
2. Ship the `<engine>` headline alone. It is small, it is reversible, and it establishes
   whether ambient engine state changes agent behaviour at all before any tool work is
   paid for.
3. Add the `engine` MCP capability with `engine_status` + `engine_console_logs`. Measure
   the real `tools/list` delta with `measure-mcp.ts` before merging.
4. Revisit the selection push with the pin-gating question, armed by then with evidence
   about whether agents pull selection when they want it.
5. Add an aggregate prompt budget to the append chain (§1.9) — independent, and it is the
   thing that stops any future block from silently breaking sends.
