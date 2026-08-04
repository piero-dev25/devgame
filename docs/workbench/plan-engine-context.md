# Plan: engine context for agents

Implementation plan following two research passes, both preserved in-repo:
`research-engine-context-injection.md` and `research-code-and-asset-indexing.md`.
Every number below is measured, not estimated — see those documents for method.

## The decision

**Push the pointer, pull the payload.**

A ~18-token ambient headline every turn, plus a small `engine` MCP capability.
The headline is not there to inform the model; it is there to make the model
_ask_. Pull's weakness is that the model must know a tool exists, and the only
per-turn instruction seam in this codebase is Codex-specific — Claude gets a
preset system prompt DevGame does not author at all. One line of ambient state
in the message stream tells every provider, uniformly, that an engine is
present and live.

```
<engine>
Unity 6000.3.14f1 · Level01.unity · playing · 3 objects selected
</engine>
```

This is the same split ACP already encodes as `resource_link` vs `resource`,
and the same one `buildPreviewAnnotationPrompt` uses today: the text says a
screenshot is attached, the bytes travel elsewhere.

## Why not one mechanism for everything

| Signal             | Size            | Volatility   | Shape                                  |
| ------------------ | --------------- | ------------ | -------------------------------------- |
| Active scene       | one line        | minutes      | push                                   |
| Play state         | one word        | **mid-turn** | push + pull tool                       |
| Selection          | 52–2,647 tokens | constant     | push (gated) + pull tool               |
| Console errors     | unbounded       | bursty       | **pull only**                          |
| Asset dependencies | n/a             | n/a          | **pull only — push cannot express it** |

Push carries _state_. A dependency query takes an _argument the agent forms
mid-turn_, after the block was already composed. That one is a tool or it is
nothing.

## Measured facts that drove this

- **Pull latency: ~235 ms** (`unity command editor_status`, five runs against a
  live Editor, 230–246 ms). Fast enough that agents will actually call tools
  rather than relying on stale pushed state. This was the single biggest
  unknown in the recommendation.
- **The existing `devgame` MCP toolkit already costs ~4,270 tokens per session**,
  on every provider, whether used or not — dominated by parameter schemas, not
  descriptions. A ~30-token headline across a 40-turn session (~1,200 tokens) is
  under a third of that.
- **`<editor_selection>` costs 52 tokens for one chip and 2,647 at its 64-item
  cap** — and today it is pushed unconditionally on every send.
- **The asset index does not need to persist.** Building a full GUID→path map
  for the owner's real project — 25,863 `.meta` files — takes **523 ms**, all
  resolved. Build, answer, discard: no invalidation, no watcher, no staleness.
  That is precisely what made this tractable where a code index was not.
- **The context saving is 50–94×.** A reverse query answers in **117 bytes**;
  the same question answered by an agent grepping costs **5,796 bytes** of
  intermediates that then sit in the transcript forever.

## Order of work

**1. Fix the wrong-project bug first (#71).** Chips are environment-wide, so a
thread rooted at project A can already ship project B's selection to the model.
`resolveProjectEditor.ts` exists and does exactly the right thing; the send path
never calls it. Every proposal here depends on picking the right editor, so
nothing else should land first.

**2. Ship `engine_asset_refs` before anything else.** If only one thing gets
built, build this. It is the largest measured context saving available, and the
forward direction (what does this asset depend on?) is _not expressible_ as
agent grep at all — reading a prefab yields GUIDs, and GUIDs are meaningless
without the reverse map.

Constraints, all of which exist to preserve the saving that justifies the tool:

- Return **paths only, never matching YAML lines** — the raw lines are the 50×
  amplification the tool exists to avoid.
- Bound results and say explicitly when truncated.
- Mark unresolvable GUIDs `<external>` rather than dropping them: on a sampled
  prefab, two of three forward GUIDs were builtin or package assets.

**3. The `<engine>` headline.** Cheap, and it is what makes the tools
discoverable across all five providers.

**4. `engine_status` and `engine_console` as tools.** Console output is
unbounded and must never be pushed — see the append-chain defect below.

## Not building

- **No code index.** The evidence runs against embedding retrieval for coding
  agents, and GDScript coverage eliminates nearly every structural-index tool
  regardless. If exact answers are ever needed, wire the language servers that
  already exist — Godot ships its own, OmniSharp covers Unity C#.
- **No per-turn instructions block for all providers.** The only precedent is
  Codex-specific and costs 571–2,099 tokens per turn. Guidance belongs in tool
  descriptions (~50 tokens each) where all five providers see it.
- **No `instructions` field in `devgame.json`.**
- **No seventh trailing text block** beyond the headline.

## Two defects that gate this

**#71 — chips send the wrong project's selection.** Fix first, as above.

**#72 — nothing budgets the total appended message.** Six appenders each cap
themselves; the 120,000-char limit is enforced only at the provider boundary,
and `apps/web` never references it. Console logs are exactly the payload that
would blow it, which is a direct reason console output must be pull-only.
Reproduce before fixing.

## The owner decision this plan does not make

The research recommends gating the `<editor_selection>` push on **pinned chips
only**, on the grounds that pushing a continuously-changing level into an
append-only transcript manufactures contradictions the model resolves by
recency — and recency is wrong exactly when a user selects something and then
asks a question that is not about it. The repo reached the same conclusion
itself in `spec-editor-presence.md` before the attachment layer landed.

**This contradicts the owner's auto-attach ruling** and is flagged rather than
assumed. If auto-attach stays, the fallback is to cap the auto-attached set at
~5 and let pins carry the rest.

## What would change this plan

- If pull latency were seconds rather than ~235 ms, agents would stop calling
  tools and pushed state would win despite the accumulation cost.
- If asset-index build time grew non-linearly well beyond 25,863 assets, the
  build-and-discard model would need caching after all.
- If a provider other than Codex gained a per-turn instruction seam, the
  headline's discovery role would weaken and it could shrink further.
