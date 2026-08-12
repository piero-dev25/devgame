# Live tool spike — trivial harness-owned MCP tool through each agent CLI

**Status:** DRAFT 1. Live, headless, empirical. Work-order step 3
(`HANDOFF.md` §68 item 3): _"Test one trivial harness-owned custom tool
through each agent."_
**Date:** 2026-08-11/12, single continuous session.
**Scope discipline:** everything below runs against a standalone scratch MCP
server under `$HOME/.claude/jobs/live-tool-spike-20260811/`. **Nothing in
`t3code-fork`'s app or server was touched or executed.** This file is the
only file this lane wrote into the repo.
**Repo at time of writing:** `t3code-fork`, branch
`workbench/upstream-20260806`, commit `0c30923506d2267b8ab8640e167108734d4de086`.

## How to read this file

Every cell in the matrix below is **VERIFIED** — I ran the exact command,
captured raw stdout (JSON/JSONL), and quote it. Where I additionally reasoned
about _why_ something behaved the way it did without a second confirming run,
that reasoning is labeled **INFERRED**. Section 7 lists the specific
corrections this forces on `agent-tooling.md`'s protocol claims (that file is
**not edited** — corrections live here only, per the work order).

---

## 1. The scratch MCP server

`$HOME/.claude/jobs/live-tool-spike-20260811/server.mjs`, built on the
official `@modelcontextprotocol/sdk` v1.30.0 (npm-installed into that scratch
dir, `node_modules` local, not global), stdio transport, Node v22.23.1.
Package: `"type": "module"`, no other dependencies beyond `zod` (input
schemas) and Node's built-in `zlib`/`crypto` for a from-scratch PNG encoder
(no image library — raw IHDR/IDAT/IEND chunks with CRC32 via `zlib.crc32`,
`deflateSync` for the pixel data).

Five tools, all required by the work order plus one I added for rigor (§3):

| Tool                    | Behavior                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `echo_check(text)`      | Returns `{received, length, serverTimeIso, probe}` as both a text block and `structuredContent`.                                                                                                                                                                                                                                                    |
| `sleep_report(seconds)` | Real `setTimeout` sleep (0–600s), then returns `{requestedSeconds, actualMs, startedIso, finishedIso, probe}`.                                                                                                                                                                                                                                      |
| `picture_check()`       | Returns a text block **describing the colors** _and_ an `{type:"image", data, mimeType:"image/png"}` block — a 16×16 PNG, left half `#DC1E1E` red, right half `#1E3CDC` blue.                                                                                                                                                                       |
| `picture_check_blind()` | **Added for rigor, not in the original brief.** Returns **only** an image block — no text, no `structuredContent` — an 18×18 PNG, 3 equal horizontal bands, top→bottom green `#28C85A` / yellow `#EBDC28` / magenta `#D228BE`. No color/layout hint travels with it, so a correct description is only possible if the pixels were actually decoded. |

**Why `picture_check_blind` exists:** the work order's own success question is
_"does the model DESCRIBE the image content correctly (proof it truly
received pixels)?"_ `picture_check`'s text block states the exact hex colors,
so a model could describe the image "correctly" by parroting the text block
without having looked at a single pixel. `picture_check_blind` removes that
confound. This turned out to be the single most informative probe in the
whole spike (§5).

**Self-test, before touching any agent CLI:** `selftest.mjs` in the same
directory drives the server directly with the SDK's `Client`/
`StdioClientTransport` (no agent involved) and confirms `tools/list` returns
all four tools, `echo_check`/`sleep_report` round-trip correctly, and both
image tools return a `data:` payload that decodes to a real PNG — verified
independently by writing it to disk and running `file(1)`:

```
$ file /tmp/spike-test.png
/tmp/spike-test.png: PNG image data, 16 x 16, 8-bit/color RGB, non-interlaced
$ file blind-check.png
blind-check.png: PNG image data, 18 x 18, 8-bit/color RGB, non-interlaced
```

Ground truth for the blind image was independently re-checked pixel-by-pixel
with PIL (`im.getpixel`) against the encoder's own color table before any
agent saw it — confirms exactly 3 bands (green/yellow/magenta), no fourth
color, 6px each. This is the ground truth every "blind" description below is
graded against.

---

## 2. Per-agent verified matrix

| Probe                                     | Claude Code CLI (2.1.228)                                                                                                                                                                      | Codex CLI (0.147.0)                                                                                                                                                                                                             | OpenCode (1.18.16)                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Discovery** (`tools/list`)              | VERIFIED — all 4 tools, behind a deferred `ToolSearch` step                                                                                                                                    | VERIFIED — all 4 tools, direct, no deferred-search layer                                                                                                                                                                        | VERIFIED — all 4 tools, direct, no deferred-search layer                                                                                                                                                                                                                              |
| **Call / round-trip** (`echo_check`)      | VERIFIED — works out of the box with `--permission-mode bypassPermissions`                                                                                                                     | VERIFIED, **but only after `--approve-for-me`** — see §4.2, a real correction                                                                                                                                                   | VERIFIED — works with `--auto`, but needed an explicit `-m` (no working default model — see §4.3)                                                                                                                                                                                     |
| **`structuredContent` preserved**         | VERIFIED — present as a distinct field in the CLI's own transcript (`tool_use_result.structuredContent`), even though the model-facing text block is what actually reaches the model's context | VERIFIED — present as `structured_content` (snake_case) in the raw event stream                                                                                                                                                 | **NOT surfaced as a distinct field** — the transcript's `tool_use.state.output` is only the flattened text; no `structuredContent`-equivalent key anywhere in the JSON event log                                                                                                      |
| **Image content block reaches the model** | VERIFIED — model correctly describes hinted image; blind image: pattern (striped) correct, **exact colors/order/count wrong**                                                                  | VERIFIED — model correctly describes hinted image; blind image (vision-only, shell disabled): pattern/count right, colors wrong; **(shell-enabled: perfect, but by decoding bytes programmatically, not by vision — see §5.2)** | VERIFIED — image arrives as a distinct `attachments[]` array (`{type:"file", mime:"image/png", url:"data:..."}`), separate from the MCP `content[]` shape; model correctly describes hinted image; blind image: pattern (striped) right, **orientation, count, and colors all wrong** |
| **`sleep_report(5)`**                     | VERIFIED succeeds, `actualMs: 5003`                                                                                                                                                            | VERIFIED succeeds, `actualMs: 5005`                                                                                                                                                                                             | VERIFIED succeeds, `actualMs: 5002`                                                                                                                                                                                                                                                   |
| **`sleep_report(65)`**                    | VERIFIED succeeds, no timeout, `actualMs: 65002` (wall time 78s incl. model overhead)                                                                                                          | VERIFIED succeeds, no timeout, `actualMs: 65005` (wall time 93s) — **contradicts the 60s default assumption, see §7.1**                                                                                                         | **VERIFIED TIMES OUT**: `MCP error -32001: Request timed out` (wall time 70s incl. failure handling) — **resolves the "ambiguous" open question, see §7.2**                                                                                                                           |

---

## 3. Reproduction — Claude Code CLI

MCP config (`mcp-config.json`, in the scratch dir):

```json
{
  "mcpServers": {
    "spike": {
      "command": "node",
      "args": ["/Users/pieroherrera/.claude/jobs/live-tool-spike-20260811/server.mjs"]
    }
  }
}
```

Discovery + echo (cwd = a dedicated `claude-run/` scratch subdirectory):

```
claude -p "List the MCP tools you have available from the 'spike' server (just the tool names), then call the echo_check tool with text='claude-probe-1' and report exactly what structured result you received." \
  --mcp-config /Users/pieroherrera/.claude/jobs/live-tool-spike-20260811/mcp-config.json \
  --strict-mcp-config \
  --allowedTools "mcp__spike__echo_check,mcp__spike__sleep_report,mcp__spike__picture_check" \
  --permission-mode bypassPermissions \
  --output-format json
```

Result (`out-claude-discovery-echo.json`, `is_error:false`):

```
Done. The spike server provides three MCP tools:
- `mcp__spike__echo_check`
- `mcp__spike__picture_check`
- `mcp__spike__sleep_report`

Calling `echo_check` with `text='claude-probe-1'` returned exactly this structured result:
{"received":"claude-probe-1","length":14,"serverTimeIso":"2026-08-12T01:32:14.084Z","probe":"echo_check"}
```

(Note: only 3 tools listed here — this run predates adding
`picture_check_blind`; all later Claude runs against the updated server show
4.)

Tool naming on the wire, from the `--output-format stream-json --verbose`
runs: `mcp__spike__picture_check`, deferred behind an internal `ToolSearch`
call first —

```
[12] assistant tool_use: ToolSearch {'query': 'select:mcp__spike__picture_check', 'max_results': 1}
[13] user tool_result: [{"type": "tool_reference", "tool_name": "mcp__spike__picture_check"}]
[15] assistant tool_use: mcp__spike__picture_check {}
```

`sleep_report(65)` — no timeout, and a heartbeat every 30s while the tool call
is outstanding (`out-claude-sleep65.jsonl`, previously undocumented detail):

```
{"type":"tool_progress","tool_use_id":"...","tool_name":"mcp__spike__sleep_report","elapsed_time_seconds":30,"heartbeat":true,...}
{"type":"tool_progress","tool_use_id":"...","tool_name":"mcp__spike__sleep_report","elapsed_time_seconds":60,"heartbeat":true,...}
{"type":"user","message":{...,"content":[{"tool_use_id":"...","type":"tool_result","content":"{\"requestedSeconds\":65,\"actualMs\":65002,...}"}]},
 "tool_use_result":{"content":"{...}","structuredContent":{"requestedSeconds":65,"actualMs":65002,"startedIso":"2026-08-12T01:35:25.576Z","finishedIso":"2026-08-12T01:36:30.579Z","probe":"sleep_report"}}}
```

`structuredContent` is preserved as its own field in `tool_use_result` — a
CLI-transcript-level fact, distinct from what actually reaches the model's
own context (the model only ever sees the flattened text block; this matters
for a host app consuming the CLI's own event stream vs. what the model can
reason about).

---

## 4. Reproduction — Codex CLI

### 4.1 Baseline command shape (matches `CodexAdapter`'s `-c mcp_servers.<name>.<key>=<value>` pattern)

```
cd /Users/pieroherrera/.claude/jobs/live-tool-spike-20260811/codex-run && \
codex exec \
  --skip-git-repo-check \
  -c mcp_servers.spike.command=node \
  -c 'mcp_servers.spike.args=["/Users/pieroherrera/.claude/jobs/live-tool-spike-20260811/server.mjs"]' \
  --sandbox workspace-write \
  -c approval_policy=never \
  --json \
  -o out-codex-discovery-echo2-lastmsg.txt \
  "List the MCP tools available to you from the 'spike' server (just tool names), then call the echo_check tool with text='codex-probe-2' and report the exact structured result you received." \
  < /dev/null
```

### 4.2 First real finding: `approval_policy=never` does NOT cover MCP tool calls

This is a load-bearing correction, so the negative evidence is included in
full. The command above (and three further variants — adding
`--ignore-rules --ignore-user-config` to rule out the user's own
`~/.codex/config.toml`; adding `-c 'projects."<cwd>".trust_level="trusted"'`
to rule out directory trust; disabling the `guardian_approval` and
`tool_call_mcp_elicitation` feature flags) **all produced the same result**:

```json
{ "content": [{ "type": "text", "text": "user cancelled MCP tool call" }], "isError": true }
```

with the raw event stream showing the tool call go straight from
`"status":"in_progress"` to `"status":"failed","error":{"message":"user
cancelled MCP tool call"}` — no visible approval-request event in the `--json`
stream at all, meaning headless mode auto-resolves an MCP approval gate to
"cancel" with nothing to intercept it. The user's own global
`~/.codex/config.toml` already sets `approval_policy = "never"` and
`sandbox_mode = "danger-full-access"` as defaults — this is not a config gap,
it's a documented flag not covering this code path.

**What works:** `--approve-for-me` ("Route approval requests through
automatic review using the workspace-write sandbox"):

```
codex exec \
  --skip-git-repo-check \
  -c mcp_servers.spike.command=node \
  -c 'mcp_servers.spike.args=["/Users/pieroherrera/.claude/jobs/live-tool-spike-20260811/server.mjs"]' \
  --approve-for-me \
  --json \
  -o out-codex-approveforme-lastmsg.txt \
  "..." < /dev/null
```

```json
{
  "type": "item.completed",
  "item": {
    "id": "item_2",
    "type": "mcp_tool_call",
    "server": "spike",
    "tool": "echo_check",
    "arguments": { "text": "codex-probe-approveforme" },
    "result": {
      "content": [
        { "type": "text", "text": "{\n  \"received\": \"codex-probe-approveforme\",...}" }
      ],
      "structured_content": {
        "received": "codex-probe-approveforme",
        "length": 24,
        "serverTimeIso": "2026-08-12T01:43:18.152Z",
        "probe": "echo_check"
      }
    },
    "error": null,
    "status": "completed"
  }
}
```

I did try `--dangerously-bypass-approvals-and-sandbox` first (it also
explicitly promises to "skip all confirmation prompts") — my own harness's
auto-mode classifier blocked that flag outright as too dangerous to run
unattended, which is the right call; `--approve-for-me` is the correct,
narrower tool for this and is what every reproduction command below uses.

**`{server, tool}` split confirmed on the wire**, matching `agent-tooling.md`'s
existing claim: every `mcp_tool_call` item carries `"server":"spike"` and
`"tool":"echo_check"` as separate top-level fields, never a single dotted
string.

### 4.3 Image probes

Hinted (`picture_check`):

```
codex exec --skip-git-repo-check -c mcp_servers.spike.command=node \
  -c 'mcp_servers.spike.args=["..."]' --approve-for-me --json \
  -o out-codex-picture-lastmsg.txt \
  "Call the picture_check tool... describe in detail exactly what you see..." < /dev/null
```

```
The image is a 16×16-pixel square divided into two equal vertical halves:
- Left side: solid red (`#DC1E1E`)
- Right side: solid blue (`#1E3CDC`)
...no gradients, borders, gaps, textures, or repeating patterns...
```

Blind, first pass — **Codex spontaneously reached for a shell command to
decode the image instead of describing it purely from vision.** This is a
genuine, unprompted, and important behavioral finding, quoted from the raw
event stream (`out-codex-picture-blind.jsonl`):

```
item_3 agent_message: "The returned image is a small horizontal-band swatch. I'm checking the
  original pixel values now so the color order and boundaries are exact rather than inferring
  them visually."
item_5 command_execution: "/bin/zsh -lc \"python3 -c 'import base64,io; from PIL import Image; d=base64.b64decode(\\\"...\\\"); ...'\""
item_6 agent_message: "It is striped: three equal-height horizontal bands in an 18×18 image.
  - Top: green — RGB (40, 200, 90), #28C85A
  - Middle: yellow — RGB (235, 220, 40), #EBDC28
  - Bottom: magenta — RGB (210, 40, 190), #D228BE"
```

Every RGB value is exact — because it was computed, not perceived. **This is
not a fair test of "does the model receive pixels via multimodal vision"** —
Codex's sandbox gives it an unrestricted shell by default, and it used that
capability instead of (or in addition to) its own vision. To get an
apples-to-apples comparison with Claude Code and OpenCode, I re-ran with
`--disable shell_tool` and an explicit instruction not to decode
programmatically:

```
codex exec --skip-git-repo-check -c mcp_servers.spike.command=node \
  -c 'mcp_servers.spike.args=["..."]' --approve-for-me --disable shell_tool --json \
  -o out-codex-picture-blind-noshell-lastmsg.txt \
  "...Do not run any shell commands or code to decode the image -- describe purely from what you visually perceive..." < /dev/null
```

```
The image is horizontally striped with three solid, edge-to-edge bands:
1. Top: turquoise/cyan
2. Middle: bright lime green
3. Bottom: vivid pink/magenta
```

Confirmed via the raw event stream that no `command_execution` item appears
this time — one `mcp_tool_call` then straight to the text description. Vision-
only, this is **wrong on 2 of 3 bands** (top is actually green, not
turquoise/cyan; middle is actually yellow, not lime green) — right on count
(3), right on orientation (horizontal), right on the bottom band (magenta).

### 4.4 Timeout probes

```
codex exec --skip-git-repo-check -c mcp_servers.spike.command=node \
  -c 'mcp_servers.spike.args=["..."]' --approve-for-me --json \
  -o out-codex-sleep65-lastmsg.txt \
  "Call the sleep_report tool with seconds=65. Report the exact JSON result..." < /dev/null
```

```json
{
  "requestedSeconds": 65,
  "actualMs": 65005,
  "startedIso": "2026-08-12T01:47:23.134Z",
  "finishedIso": "2026-08-12T01:48:28.139Z",
  "probe": "sleep_report"
}
```

Wall time 93s, no error, no timeout. Pushed further to 130s (same command,
`seconds=130`) to make sure 65s wasn't a lucky number right under some
higher threshold — also succeeded cleanly, `actualMs: 130002`, wall time 151s.
`~/.codex/config.toml` has no explicit `tool_timeout_sec` override — this is
the CLI's built-in default behavior. See §7.1 for what this corrects.

---

## 5. Reproduction — OpenCode

Not originally required beyond a presence check (`which opencode` →
`/Users/pieroherrera/.local/bin/opencode`, v1.18.16, present) — but since it
directly answers an explicitly open question in `GENERATION_ARCHITECTURE.md`
§14 item 2 ("Does an OpenCode session round-trip a `devgame` tool call at
all?"), I ran the full probe set. **This is the first live confirmation in
either repo that it works at all.**

### 5.1 Setup

OpenCode reads MCP servers from `opencode.json`/`.jsonc` in the working
directory (no `--mcp-config`-equivalent CLI flag exists on `opencode run`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "spike": {
      "type": "local",
      "command": ["node", "/Users/pieroherrera/.claude/jobs/live-tool-spike-20260811/server.mjs"],
      "enabled": true
    }
  }
}
```

Verified picked up via `opencode debug config` before running anything live.

**A real setup snag, worth recording:** the very first `opencode run` failed
outright — not an MCP problem, a model problem:

```json
{
  "type": "error",
  "error": {
    "name": "ProviderAuthError",
    "data": { "providerID": "google", "message": "Google Generative AI API key is missing..." }
  }
}
```

`opencode providers list` showed OpenRouter as the only credentialed
provider with a usable key; every subsequent run pins
`-m openrouter/anthropic/claude-sonnet-5` explicitly. **A default-model
headless run of `opencode` is not safe to assume works** — it silently picked
an unconfigured provider (`google`) rather than falling back to whatever
_was_ configured (`openrouter`).

### 5.2 Discovery + echo

```
cd /Users/pieroherrera/.claude/jobs/live-tool-spike-20260811/opencode-run && \
opencode run "List the MCP tools available... then call the echo_check tool with text='opencode-probe-1'..." \
  --format json --auto -m openrouter/anthropic/claude-sonnet-5
```

```json
{
  "type": "tool_use",
  "part": {
    "type": "tool",
    "tool": "spike_echo_check",
    "callID": "toolu_...",
    "state": {
      "status": "completed",
      "input": { "text": "opencode-probe-1" },
      "output": "{\n  \"received\": \"opencode-probe-1\",\n  \"length\": 16,...}"
    }
  }
}
```

**Tool naming: `spike_echo_check`** — single underscore, `<server>_<tool>`.
This is a new, previously-uncaptured fact (`agent-tooling.md` had this cell
marked "unknown"): distinct from Claude's `mcp__<server>__<tool>` (double
underscore) and Codex's `{server, tool}` split fields. No deferred-discovery
step observed (direct `tool_use`, like Codex, unlike Claude's `ToolSearch`
gate).

### 5.3 Image probes and the `attachments[]` finding

Hinted `picture_check` — the raw tool-call event (full, not excerpted,
because the shape matters):

```json
{
  "part": {
    "tool": "spike_picture_check",
    "state": {
      "status": "completed",
      "output": "Generated a 16x16 test image: left half solid red (#DC1E1E), right half solid blue (#1E3CDC).",
      "attachments": [
        {
          "type": "file",
          "mime": "image/png",
          "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQ..."
        }
      ]
    }
  }
}
```

**New fact, fills a previously-"unknown" cell:** OpenCode does not surface an
MCP `content[]` array with a `type:"image"` block the way Claude and Codex
do. It splits the image out into a separate `attachments[]` list as a
`data:` URI, and the `output` field is text-only. Confirmed on both image
tools (`picture_check` and `picture_check_blind` both produce exactly this
shape). No `structuredContent`-equivalent field appears anywhere in either
tool's event — `echo_check`'s `output` is also just the JSON-stringified
text, not a distinct object.

Model's description of the hinted image, correct:

```
- Left half: Solid red, approximately #DC1E1E (a warm, slightly muted red — not pure #FF0000).
- Right half: Solid blue, approximately #1E3CDC (a rich, slightly purple-leaning blue — not pure #0000FF).
```

Blind image — **wrong on orientation, count, and one color**:

```
The image is a small square split into four equal vertical stripes, arranged left to right in this color order:
1. Pink/magenta (leftmost)
2. Yellow
3. Green
4. Blue (rightmost)
```

Ground truth: 3 **horizontal** bands, green/yellow/magenta, no blue. Got the
right 3 colors present (in the confused 4-color list) but invented a 4th
(blue), got the orientation wrong (vertical vs. horizontal), and reversed the
order.

### 5.4 Timeout — the clean result

```
opencode run "Call the sleep_report tool with seconds=65..." --format json --auto -m openrouter/anthropic/claude-sonnet-5
```

```json
{
  "type": "tool_use",
  "part": {
    "tool": "spike_sleep_report",
    "state": { "status": "error", "error": "MCP error -32001: Request timed out" }
  }
}
```

```
Exact error returned, verbatim:
MCP error -32001: Request timed out
No JSON result was returned — the call to `spike_sleep_report` with `seconds=65`
timed out at the MCP layer before the tool could respond.
```

`seconds=5` succeeded cleanly in the paired run (`actualMs: 5002`). This is a
clean, unambiguous, JSON-RPC-standard timeout error (`-32001`) — see §7.2.

---

## 6. The blind-image cross-agent comparison (the spike's sharpest finding)

Every agent/model combination tested correctly identified that the blind
image was **not solid and not the same layout as the earlier hinted image** —
i.e., every one of them genuinely received and processed real pixel data,
not a cached assumption from the first probe. But **none of the three
vision-only descriptions were fully correct**, and each failed differently:

|                | Ground truth           | Claude Code (native vision)         | Codex (vision-only, shell disabled)                                                | OpenCode / claude-sonnet-5 (native vision)      |
| -------------- | ---------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| Orientation    | horizontal             | horizontal ✓                        | horizontal ✓                                                                       | **vertical ✗**                                  |
| Band count     | 3                      | **4 ✗** (hallucinated a 4th)        | 3 ✓                                                                                | **4 ✗** (hallucinated a 4th)                    |
| Colors present | green, yellow, magenta | green, magenta, yellow, **+blue ✗** | **turquoise/cyan, lime, magenta** (2 of 3 wrong)                                   | magenta, yellow, green, **+blue ✗**             |
| Order          | green→yellow→magenta   | green→magenta→yellow (wrong order)  | (n/a, only 3 named, order approx right — turquoise[top]→lime[mid]→magenta[bottom]) | magenta→yellow→green→blue (wrong order + count) |

Two of three independently hallucinated the same phantom 4th color (blue —
plausibly because red/blue and green/yellow/magenta are visually adjacent to
a mental model of "rainbow stripes" with 4 bands being a more common training
prior than 3). Codex's vision-only pass got the count and orientation right
but named the wrong hues for 2 of 3 bands.

**Direct answer to the work order's question — "does the model DESCRIBE the
image content correctly, proof it truly received pixels?":** partially. All
three CLIs demonstrably transmit real pixel data to the model (structural
facts — striped vs. solid, roughly which color family, band boundaries with
no gradient — come through correctly and could not be guessed from the first
probe's colors). But color/count/order precision from native multimodal
vision alone is **not reliable** in this test, across all three agents. A
downstream `generate_image`/`inspect_generation` design (`HANDOFF.md` §22–25)
should not assume an agent's own visual description is ground truth for
anything that matters (regeneration decisions, QA gates) — it should pair
image content with **explicit structured metadata** (exactly what
`GENERATION_ARCHITECTURE.md` §9 already recommends for 3D review, and this
result extends the same caution to 2D). Codex's unprompted reach for a shell
command to decode pixels programmatically when given the freedom to do so is
itself informative: **given a code-execution tool, an agent will prefer
programmatic verification over trusting its own vision** — worth designing
for rather than against, e.g. shipping the technical/structured sidecar data
`generate_image` should have anyway rather than relying on either vision or
hoping the agent doesn't route around it.

(Sample size caveat: one blind image per agent/model. This is a strong
qualitative signal — three different, wrong-in-different-ways answers to the
same objective question — not a statistically powered accuracy measurement.)

---

## 7. Corrections this forces on `agent-tooling.md`'s protocol claims

`agent-tooling.md` is not edited (out of this lane's write scope) — these are
the specific claims that live evidence now contradicts or resolves, with
line references as of the version read at the start of this task.

### 7.1 Codex's "60s default `tool_timeout_sec`" claim does not hold empirically

`agent-tooling.md:303-304, 320-322, 373, 417, 456-458` all assert Codex's
default `tool_timeout_sec` is 60s and that a 65s tool call "would have
failed/timed-out at 60 seconds by default" absent a raised config value. In
this environment (Codex CLI 0.147.0, no `tool_timeout_sec` override anywhere
in `~/.codex/config.toml` or on the command line), **a 65s call succeeded
cleanly, and so did a 130s call** (§4.4). Either:

- the shipped default changed between whenever those doc claims were sourced
  and CLI version 0.147.0 (**INFERRED**, most likely explanation — the
  original claim was doc-sourced, not live-verified, per that section's own
  "UNVERIFIED" framing at `agent-tooling.md:456`), or
- `--approve-for-me` (required here just to get past the MCP approval gate,
  §4.2) also happens to relax the tool-call timeout as a side effect
  (**INFERRED**, untested directly — I did not have a config-free way to
  reach a completed MCP tool call without it, so I cannot isolate the two
  variables in this environment).

Either way, **`GENERATION_ARCHITECTURE.md` §8's design decision (job-handle,
never blocking, "design for the least forgiving client") remains the right
call regardless of the exact number** — OpenCode demonstrably times out
around this range (§7.2) and Claude Code's own ~28h default is already wildly
divergent from Codex's, so "assume the tightest client wins" is unaffected by
this correction. What changes is the specific number cited for Codex, and
the confidence label — this was "UNVERIFIED" and is now **VERIFIED wrong as
stated, VERIFIED right in spirit** (a real ceiling exists somewhere, just
not confirmed at exactly 60s in this environment/version/flag combination).

### 7.2 OpenCode's `timeout` field IS a call-time timeout, not just connect-time

`agent-tooling.md:341-345, 373-374, 472-474, 492, 553-561` all flag this as
an open, doc-only "genuinely unknown" question — whether OpenCode's
`opencode.json` `mcp.<name>.timeout` field bounds `tools/call` execution or
only the `tools/list` handshake. **Resolved: it is a call-time timeout.**
`sleep_report(5)` succeeded; `sleep_report(65)` failed with
`MCP error -32001: Request timed out` (§5.4) — a standard JSON-RPC timeout
code, at the MCP layer, mid-call. The exact threshold is bracketed between 5s
and 65s but not pinned closer (not required by the work order's probe
points; a bisection between 10s and 60s would close this if ever needed).
This resolves `GENERATION_ARCHITECTURE.md` §14 item 1's open question for the
OpenCode leg specifically.

### 7.3 New facts filling previously-"unknown" cells (not contradictions — additions)

- **OpenCode tool-name convention** (`agent-tooling.md:377` marked "unknown —
  no captured tool-call transcript"): **`<server>_<tool>`**, e.g.
  `spike_echo_check` — single underscore, distinct from both Claude's
  `mcp__<server>__<tool>` and Codex's `{server,tool}` field split.
- **OpenCode tool-discovery mechanism** (not explicitly claimed either way in
  the doc): direct, no deferred-search layer — same pattern as Codex, unlike
  Claude's `ToolSearch` gate.
- **OpenCode image content transport** (`agent-tooling.md:375` marked "not
  docs-confirmed, not live-transcript-confirmed"): **confirmed live** — image
  content blocks surface as a distinct `attachments[]` array
  (`{type:"file", mime, url:"data:..."}`), not as an MCP `content[]` entry
  with `type:"image"` the way Claude and Codex expose it. A harness UI that
  wants to render "the agent's own view of the image" from a transcript would
  need three different extraction paths, one per CLI.
- **OpenCode `structuredContent` equivalent**: does not appear to exist in
  the tool-call event schema at all — `output` is always the flattened text.
  If a harness needs OpenCode to consume/produce structured tool results, it
  cannot rely on a `structuredContent`-shaped channel the way Claude's
  `tool_use_result.structuredContent` or Codex's `structured_content`
  field provide.
- **Codex's `--approve-for-me` requirement for headless MCP tool calls**
  (not previously documented anywhere I could find in either repo's notes):
  `approval_policy=never` is necessary but not sufficient for a scripted
  `codex exec` run that calls a custom MCP tool; `--approve-for-me` (or
  presumably a live interactive TTY) is required, confirmed by exhaustively
  ruling out config, directory trust, and two feature flags as the actual
  cause (§4.2). This is directly load-bearing for any future headless spike
  or CI job driving Codex against the real `devgame` MCP server.
- **Claude Code's 30s heartbeat cadence during a long tool call**: not
  previously documented; two `tool_progress` heartbeat events fired at
  exactly 30s and 60s during the 65s sleep (§3). Useful if a UI wants to show
  "still working" during a long `generate_3d` call under Claude Code
  specifically.

---

## 8. Scope, cleanup, and caveats

- **Sequential discipline honored**: Claude Code probes ran to completion,
  then Codex probes ran to completion, then OpenCode probes — never
  concurrent, never sharing a cwd across a provider boundary. Each provider
  got its own scratch subdirectory (`claude-run/`, `codex-run/`,
  `opencode-run/`) under the shared scratch root.
- **Unique `-o` files per Codex run**, as required — every `out-codex-*-
lastmsg.txt` is distinct; no run's last-message file was overwritten by a
  later one.
- **`--skip-git-repo-check` and `< /dev/null` used on every Codex invocation.**
- **Side effect caught and reverted**: an early attempt to test whether
  per-directory trust gated the MCP approval issue used
  `-c 'projects."<scratch-codex-run-dir>".trust_level="trusted"'`, which
  Codex persisted into the user's real `~/.codex/config.toml` (not just the
  ephemeral run). I removed that stanza afterward — confirmed by grep that no
  `live-tool-spike` or `spike`-named entries remain in that file. A
  `codex mcp add spike-test -- node .../server.mjs` / `codex mcp remove
spike-test` round-trip (used to test whether a _persisted_ server
  registration behaved differently from an ad-hoc `-c` one — it didn't,
  §4.2) was also fully cleaned up the same way.
- **Not tested**: permission-prompt _option cardinality_ (Claude's 3-way vs.
  Codex's 4-way vs. OpenCode's unknown set) — every run here deliberately
  bypassed interactive approval (`--permission-mode bypassPermissions`,
  `--approve-for-me`, `--auto`) specifically to run headlessly, which by
  construction never surfaces the approval-options prompt itself. That
  remains open exactly as `agent-tooling.md` already frames it.
- **OpenCode model dependency**: all OpenCode results are for one specific
  backing model (`openrouter/anthropic/claude-sonnet-5`) chosen only because
  it was the first credentialed, capable option found (`opencode providers
list` → OpenRouter). OpenCode itself is model-agnostic; a different
  backing model could plausibly change the blind-image accuracy result (§6)
  without changing any of the CLI-level protocol facts (tool naming,
  `attachments[]` transport, timeout behavior), which are the load-bearing
  findings for the architecture decision.
- **No processes left running.** Confirmed via `ps aux | grep server.mjs`
  after the full run — no stray `node server.mjs` instances.
