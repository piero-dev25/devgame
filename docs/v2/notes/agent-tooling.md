> [!WARNING]
> RECONCILIATION (2026-08-11): this note was produced against the WRONG codebase
> (the pre-fork gamedev-workbench ACP repo) due to a dispatch path bug. Its
> repo-specific findings — notably "claude/codex sessions receive zero MCP
> servers" — are FALSE for t3code-fork (all five adapters inject the /mcp
> credential; see notes/t3-architecture-seams.md and GENERATION_ARCHITECTURE.md).
> The PROTOCOL-level content (per-CLI timeouts, tool naming, permission
> cardinality, result envelopes) was independently re-verified and remains valid.

# Agent tooling — how Claude Code, Codex, and OpenCode get custom tools

Draft note. Promotes to `AGENT_GENERATION_TOOLING.md` once a live spike executes the recipe in §6
and either confirms or corrects the one finding this note is built around.

**Priority order per the task brief: Claude Code, Codex, OpenCode.** Grok appears only where it
sharpens a contrast; it is out of scope for the generate_3d design question.

## 0. Method note — and a charter mismatch to flag up front

The task pointed at `docs/v2/HANDOFF.md` as the charter and cited §68/§66/§42. **That path does not
exist in this checkout** — `docs/v2/` did not exist before this note created it, and nothing in the
repo (`find . -iname HANDOFF.md`) has section numbers that high. The repo's actual charter is
`HANDOFF.md` at the repo root (26 top-level sections, dated 2026-07-31), which this note read in
full, plus `docs/progress.md` (the live build log), `research/DECISION.md` (GO ACP-native), and
`docs/specs/p2-agent-runtime.md` (the frozen runtime spec). That is the substitute evidence base;
flagging the mismatch rather than silently guessing at what §68/§66/§42 were supposed to say.

**VERIFIED** below means: read from this repo's source/tests/live-captured transcripts, or quoted
from a fetched vendor doc page (URL given). **INFERRED** means: a reasonable extrapolation from
verified evidence, not itself directly observed — most often "the MCP spec allows X" where I did not
find a provider-specific doc statement confirming the client actually exercises X.

---

## 1. The central finding, stated before the detail

**This repo has two different, live-proven mechanisms for giving an agent a custom tool, and as of
the current checkout, only one of the three priority providers still uses the one that was proven to
work end-to-end.**

- `research/DECISION.md` and `docs/specs/p2-agent-runtime.md` (both frozen 2026-07-31) commit to
  **ACP for all four day-one harnesses**, including Claude Code and Codex, specifically _because_ the
  workspace MCP tool (`update_professional_workspace`) — this product's core mechanism — "already runs
  over ACP, proven on both providers, zero repair loops" (`research/field-evidence-seams.md` §6).
  Evidence: `spikes/acp-probe/results/{claude,codex}-mcp-workspace.transcript.json`,
  `app/server/test/fixtures/live/claude-code-workspace-tool.transcript.json`, all captured
  **2026-07-31**, all showing a real `mcpServers` entry in `session/new` and a completed
  `update_professional_workspace` tool call.
- Sometime on **2026-08-02**, `app/server/src/runtime/harness-registry.mjs` was changed to route
  `claude-code` and `codex` through `backend: "sdk"` instead of `backend: "acp"` (lines 68, 128),
  and two new files were added the same day — `claude-sdk-connection.mjs` (16:18) and
  `codex-sdk-connection.mjs` (16:24) — that embed T3's vendored Claude Agent SDK / Codex app-server
  adapters directly, in-process, instead of spawning the `claude-agent-acp` / `codex-acp` npm
  adapters. The stated reason in-file is a **model-catalog gap** (ACP's `claude-agent-acp` exposes 5
  Claude models and rejects the other four; the SDK path exposes all 9) — nothing about MCP.
- **Neither new file accepts, threads, or forwards `mcpServers` anywhere.** `ClaudeSdkConnection
.createSession()` and `CodexSdkConnection.createSession()` destructure `{ cwd, workspaceId, model,
mode }` only (claude-sdk-connection.mjs:345, codex-sdk-connection.mjs:290-292) and never reference
  `input.mcpServers`. The vendored SDK adapters they call _do_ have an MCP injection point —
  `McpProviderSession.readMcpProviderSession(threadId)` (vendor/t3/apps/server/src/mcp
  /McpProviderSession.ts) — but that is an in-memory map populated by **T3's own server routes**,
  which this codebase never runs; `grep -rn setMcpProviderSession` outside `vendor/` and
  `reference/t3code/` returns nothing. `AgentRuntime.createSession()` in `agent-runtime.mjs` still
  unconditionally forwards `mcpServers: input.mcpServers ?? []` into `connection.createSession(...)`
  (lines 223, 367, 395) — the field is not dropped by the runtime layer, it is dropped by silently
  falling off the parameter list of the two new SDK connection classes.
  - Net effect, verified by reading the current source: **a session created today against
    `claude-code` or `codex` gets zero MCP servers, including our own workspace tool.** The tool the
    whole product's live evidence rests on is unreachable on the two highest-priority providers in
    the current checkout, though it demonstrably worked two days earlier on the same providers via a
    different backend.
- This also runs against the **frozen** P2 spec, which names exactly one backend (`'acp' |
'opencode-sdk'`, p2-agent-runtime.md:60) and makes the mcpServers-at-`session/new` wiring binding,
  not optional ("Spawned per session, handed to the agent via `mcpServers` at `session/new`... This
  already works; keep it." — p2-agent-runtime.md §10, lines 182–193). Spec deviations require lead
  sign-off (p2-agent-runtime.md:3); nothing found in `docs/progress.md`'s decision log (§4) records a
  sign-off for this one, and nothing in progress.md's dated entries (all `2026-07-31` or `2026-08-01`)
  postdates or acknowledges the `08-02` backend flip.

**This is the #1 thing the live spike in §6 should re-run first** — it is a five-minute
`createSession({harnessId:"claude-code", ...})` call away from being confirmed or overturned by
actually running the current code, which this note did not do (static read only, per the task's
read-only-git / no-pnpm-install constraints).

---

## 2. In-repo: how each provider adapter launches its agent

### 2.1 Where the code lives

```
app/server/src/runtime/
  harness-registry.mjs      — the 5 HarnessDescriptor rows (config, not code)
  agent-runtime.mjs         — AgentRuntimePort impl; the ONLY thing above knows about
  acp-connection.mjs        — generic ACP backend (Grok, OpenCode; formerly Claude/Codex too)
  claude-sdk-connection.mjs — Claude-only, added 2026-08-02, embeds vendored T3 Claude Agent SDK
  codex-sdk-connection.mjs  — Codex-only, added 2026-08-02, embeds vendored T3 Codex app-server client
app/server/src/mcp/
  workspace-mcp-server.mjs  — the ONE canonical tool this product ships (update_professional_workspace)
  tool-server-runtime.mjs   — shared stdio-MCP scaffolding every tool server uses
  discovery-mcp-server.mjs / discovery-channel.mjs — second tool (propose_workspace_discovery), same scaffolding
app/server/src/api/agent-routes.mjs  — where a session's mcpServers array is actually assembled
app/server/src/vendor/t3/            — T3 code, vendored verbatim, DO NOT EDIT (re-pulled by script)
```

### 2.2 The two launch mechanisms, both VERIFIED in this repo

**Mechanism A — ACP backend (`backend: "acp"`, `acp-connection.mjs`).** Currently used for
**OpenCode** and Grok. `harness.spawn` names a literal command (`opencode acp`) that is spawned as a
child process over stdio; `AcpConnection` speaks JSON-RPC ACP v1 to it. `createSession()`
(acp-connection.mjs:217) sends `session/new` with `{ cwd, mcpServers: toWireMcpServers(input
.mcpServers) }`. `toWireMcpServers` (acp-connection.mjs:1055) reshapes each server descriptor to
`{ name, command, args, env: [{name,value}] }` — the ACP wire's own stdio-MCP-server shape. This is
the mechanism `research/DECISION.md` and P2 committed to for **all four** day-one harnesses,
including Claude Code and Codex, on 2026-07-31.

**Mechanism B — native SDK backend (`backend: "sdk"`, `claude-sdk-connection.mjs` /
`codex-sdk-connection.mjs`).** Currently used for **Claude Code and Codex** (harness-registry.mjs:68,
128), added 2026-08-02. `AgentRuntime.#connect()` forks on `harness.backend` (agent-runtime.mjs:581)
and, for `"sdk"`, further forks on `harness.id` (agent-runtime.mjs:707) because Claude and Codex each
get their own connection class over their own vendored T3 provider adapter
(`ClaudeAdapter.ts` / `CodexAdapter.ts`, both under `vendor/t3/…/provider/Layers/`, never spawned as
subprocesses — the SDK/app-server client runs **in the same Node process** as our server, driving the
vendor CLI as a managed subprocess underneath). No ACP wire is used on this path at all; there is no
`claude-agent-acp` or `codex-acp` npm adapter in the loop. This is _why_ the model catalog is richer
here (9 Claude models with per-model effort/context descriptors vs. 5 over ACP,
claude-sdk-connection.mjs:9-13) — it is also why `McpProviderSession`, `mode.settable`, and
`session/set_mode` all behave differently (see §2.4).

**Which mechanism is "the" launch path for Claude Code and Codex is therefore not a fixed fact about
this repo — it changed once already, three days into the same research effort, for a reason (model
completeness) unrelated to tool injection, and broke tool injection as an apparently unnoticed side
effect.** Any answer to "how does Claude Code get custom tools in this repo" has to specify which
commit / which `harness.backend` it means.

### 2.3 The mcpServers injection seam — exact shape, per mechanism

**Where the array is built** (provider-agnostic, `agent-routes.mjs:171-224`): every session request
attaches at minimum the workspace tool server, and a discovery tool server too when the caller asks
for it. Each entry is `{ channel, provisional, spec, url }`; `spec({channelUrl, token})` produces the
actual descriptor. Reading `workspaceMcpServerSpec` (imported into agent-routes.mjs from
`mcp/workspace-channel.mjs`) and the transcripts confirms the produced shape is:

```json
{
  "name": "workbench",
  "command": "/path/to/node",
  "args": ["/path/to/app/server/src/mcp/workspace-mcp-server.mjs"],
  "env": [
    {
      "name": "WORKBENCH_WORKSPACE_URL",
      "value": "http://127.0.0.1:<port>/api/agent/workspace-tool"
    },
    { "name": "WORKBENCH_SESSION_TOKEN", "value": "<uuid>" }
  ]
}
```

This is a **stdio server the harness itself spawns** — `command`/`args` name a `node
workspace-mcp-server.mjs` invocation, not a URL. The two env vars are the entire authentication and
routing mechanism: the spawned process reads `WORKBENCH_WORKSPACE_URL` and posts validated tool-call
payloads back to our own HTTP side-channel (`tool-server-runtime.mjs:71-101`, `POST_TIMEOUT_MS =
15_000`), authenticated by the bearer-shaped `WORKBENCH_SESSION_TOKEN`. **The tool server itself is a
hand-rolled ~120-line MCP implementation** (`tool-server-runtime.mjs`), not built on
`@modelcontextprotocol/sdk` — it answers exactly `initialize`, `notifications/initialized`,
`tools/list`, `tools/call` over newline-delimited JSON-RPC on stdout, and **every `tools/call` success
reply is `{content:[{type:"text", text: describeSuccess(value)}]}` — text only, never
`structuredContent`, never an image or resource block.** That is a design choice in this file today,
not a protocol limit (see §4).

**On Mechanism A (ACP)**: this descriptor is put into `session/new.params.mcpServers[]` verbatim (via
`toWireMcpServers`). VERIFIED live for Claude, Codex, and OpenCode as of 2026-07-31 — see the
transcripts cited in §1. The harness process itself spawns the tool server as its own child, over
which our app has no direct handle; the only proof it started is the `hello` POST the tool server
fires after replying to `initialize` (tool-server-runtime.mjs:106-116; the 10s hello-timeout is a
named requirement in p2-agent-runtime.md §10, "ACP gives no signal that a client-supplied MCP server
actually connected — upstream `claude-agent-acp` #883").

**On Mechanism B (native SDK)**: this descriptor is constructed by `agent-routes.mjs` exactly the
same way, then passed into `agentRuntime.createSession({..., mcpServers: attached.map(...)})`
— and then dropped. `ClaudeSdkConnection.createSession(input)` and `CodexSdkConnection
.createSession(input)` never read `input.mcpServers`. The vendored `ClaudeAdapter.ts` _would_ build
an `mcpServers: {"t3-code": {type:"http", url, headers}}` block for the underlying Agent SDK
`query()` call (ClaudeAdapter.ts:3555-3562) — but only if `McpProviderSession
.readMcpProviderSession(threadId)` returns a value, and nothing in this codebase's call path ever
calls `setMcpProviderSession` for a thread it creates. `CodexAdapter.ts` has the parallel mechanism
one layer lower — it would pass `appServerArgs: ["-c", "mcp_servers.t3-code.url=...", "-c",
"mcp_servers.t3-code.bearer_token_env_var=..."]` to the Codex app-server process (CodexAdapter.ts:
1421-1430) — same gate, same result: never populated from this repo's own code today.

### 2.4 Per-provider wire evidence — naming, permission shape, result envelope

All VERIFIED from live-captured transcripts (2026-07-31, Mechanism A / ACP for all three, before the
backend flip — this is the evidence that exists; it does not currently describe what Mechanism B
would produce, because Mechanism B has no captured live turn with a tool call at all):

|                                    | Claude Code (ACP)                                                                                                                                                                                                                                                             | Codex (ACP)                                                                                                                                                                                                                  | OpenCode (ACP)                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool call name surfaced            | `mcp__workbench__update_professional_workspace` (double underscore)                                                                                                                                                                                                           | `mcp.workbench.update_professional_workspace` (title); `rawInput: {server:"workbench", tool:"update_professional_workspace", arguments:{...}}` (split fields)                                                                | not captured live in this repo (see below)                                                                                                               |
| Tool discovery                     | **Deferred behind `ToolSearch`** — the session's own transcript shows Claude Code calling its internal `ToolSearch` tool with `query: "select:mcp__workbench__update_professional_workspace"` before it can invoke the real tool; response carries `total_deferred_tools: 68` | direct — no equivalent deferred-tool-search layer observed in the transcript                                                                                                                                                 | unknown                                                                                                                                                  |
| Permission gate on our tool        | Yes, when session mode is pinned (`session/request_permission`, options `allow_always` / `allow_once` / `reject_once` — 3 options)                                                                                                                                            | Yes, always observed (`_meta.is_mcp_tool_approval: true`), options `allow_once` / `allow_session` / `allow_always` / `decline` — **4 options**, splitting "this session" from "forever" where Claude's 3-option set does not | none observed (OpenCode's own ACP `configOptions` mode has no separate approve-edits state — p2-agent-runtime.md:78 note, "no approve-edits equivalent") |
| Tool result envelope (`rawOutput`) | flat array: `[{type:"text", text:"Workspace updated…"}]`                                                                                                                                                                                                                      | `{result:{content:[{type:"text",text:"…"}], structuredContent:null, _meta:null}, error:null}` — standard MCP `CallToolResult` wrapper, unflattened                                                                           | unknown — see below                                                                                                                                      |
| Source                             | `spikes/acp-probe/results/claude-mcp-workspace.transcript.json`, `app/server/test/fixtures/live/claude-code-workspace-tool.transcript.json`                                                                                                                                   | `spikes/acp-probe/results/codex-mcp-workspace.transcript.json`                                                                                                                                                               | —                                                                                                                                                        |

**OpenCode gap, stated plainly:** `app/server/test/fixtures/live/opencode.transcript.json` shows a
real `session/new` with the same `mcpServers` array wired, but the captured turn never reaches a
`workbench__*` tool call — it stops at `available_commands_update`. No file in this repo captures a
live OpenCode round-trip through the workspace tool. Given OpenCode is still on Mechanism A (ACP) and
never moved to a native SDK, there is no code-level reason to expect it to fail — but "wired" and
"round-tripped" are different claims, and only the first is evidenced for OpenCode today. **This is
the other thing the live spike in §6 should close.**

**The two tool-naming conventions are a real client-side leak**, already called out and handled in
this repo's own frozen spec: "Tool titles are prefixed differently per adapter (`mcp.workbench.foo`
vs `mcp__workbench__foo`). Never exact-match a tool title. Normalize to `{server, tool}`"
(p2-agent-runtime.md §7, line 146). `app/server/src/runtime/tool-name.mjs` exists specifically to do
this parsing; not re-read in full for this note, but its existence is itself evidence the team
already treats this as a known per-provider seam rather than a hypothetical one.

---

## 3. Official docs: MCP/tool support per CLI

Fetched sequentially, one page at a time, per the task's "light web use" instruction. Each claim below
is quoted or closely paraphrased from the cited page; version numbers and defaults are the vendor's
own, current as of the fetch date (this session).

### 3.1 Claude Code

Source: `code.claude.com/docs/en/mcp` (redirected from `docs.claude.com/en/docs/claude-code/mcp`),
plus `code.claude.com/docs/en/common-workflows`.

- **Transports**: stdio (`claude mcp add --transport stdio <name> -- <command> [args]`), HTTP
  (`--transport http`, recommended for remote servers, `type: "streamable-http"` is an accepted alias
  for `"http"` in JSON config), SSE (`--transport sse`, **explicitly deprecated** in favor of HTTP),
  and WebSocket (`type: "ws"`, JSON-config only, no `claude mcp add --transport` flag for it —
  persistent bidirectional, for servers that push events unprompted).
- **Config locations / scopes**: `local` (default, private, `~/.claude.json` under the project path),
  `project` (shared via `.mcp.json` in the repo root, requires an approval prompt in interactive
  sessions — `claude -p` / Agent SDK / cloud sessions load it **without** asking), `user` (all
  projects, `~/.claude.json`, private). Precedence on a name collision: local > project > user >
  plugin > claude.ai connector; whole-entry replace, not field merge.
  - Server names `workspace`, `claude-in-chrome`, `computer-use`, `Claude Preview`, `Claude Browser`
    are **reserved** — a config using one of these is skipped with a warning. `workbench` (this
    repo's tool server name) does not collide.
- **Timeouts**: `MCP_TIMEOUT` env var sets server _startup_ timeout. A per-server `"timeout"` field
  in the `.mcp.json` entry (ms) sets a **hard wall-clock ceiling per tool call**, overriding
  `MCP_TOOL_TIMEOUT` for that server only; values under 1000ms are ignored. `MCP_TOOL_TIMEOUT`'s own
  default, when nothing is set, is **~28 hours** — i.e. Claude Code effectively does not time out a
  tool call by default. Separately, there's an **idle timeout** (no response _and_ no progress
  notification): 5 min for HTTP/SSE/WS/connector servers, 30 min for stdio — configurable via
  `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, `0` disables it.
- **Long-running tools / async**: **automatic backgrounding** — a main-conversation MCP call still
  running after 2 minutes is moved to a background task automatically (`CLAUDE_CODE_MCP_AUTO
_BACKGROUND_MS` to change the threshold, `0` disables it). Claude gets a task ID immediately and
  keeps working; the result arrives as a task notification when the call settles. The task is visible
  in `/tasks` and stoppable there. **This is exactly a job-handle pattern, but it's the client
  imposing it on an ordinary synchronous tool call — the tool itself doesn't need to design for it**,
  though a tool whose own reply never comes is still bound by the wall-clock/idle limits above even
  while backgrounded. Does not apply to: subagent calls, IDE-server calls, non-interactive (`claude
-p`) calls (unless `CLAUDE_AUTO_BACKGROUND_TASKS=1`), or calls blocked on an open elicitation dialog.
- **Result richness**: MCP `content` blocks — text and **image** are both explicitly discussed (image
  content is "still subject to `MAX_MCP_OUTPUT_TOKENS`", implying it is rendered/counted, not
  dropped). Output warns above 10k tokens, caps at 25k by default (`MAX_MCP_OUTPUT_TOKENS` to raise;
  a per-tool `_meta["anthropic/maxResultSizeChars"]` annotation can raise the ceiling for **text**
  content specifically, up to 500k chars — has no effect on image content). Structured input schemas
  with root-level `anyOf`/`oneOf`/`allOf` are supported (flattened before being sent to the model, as
  of v2.1.195). **`structuredContent` in the reply is not mentioned on this page** — INFERRED
  supported (it's core MCP spec), not VERIFIED from Claude Code's own docs.
  - MCP **resources** are reachable via `@server:protocol://resource/path` mentions, and MCP
    **elicitation** (server asks the user a structured mid-task question) is supported with a Form
    mode and a URL/OAuth mode, auto-dialog by default, hookable via the `Elicitation` hook.
- **Image INPUT to Claude Code**: three paths, all VERIFIED from the docs — drag-and-drop into the
  terminal window, paste (`Ctrl+V`, or `Cmd+V` in iTerm2), or **a plain local file path in the prompt
  text** ("Analyze this image: /path/to/your/image.png"). No URL-fetch-as-image path documented.
- **Native (non-MCP) tool registration**: not available at the CLI-config level — CLI-level extension
  is MCP, [skills](/docs/en/skills) (prompt/markdown, not code tools), hooks, and plugins. The
  **Agent SDK** (the layer T3's `ClaudeAdapter.ts` embeds, and the layer this repo's own
  `claude-sdk-connection.mjs` rides) additionally supports **in-process SDK MCP servers**
  (`createSdkMcpServer`/`tool()` in TypeScript, no subprocess spawned at all) — not confirmed from
  this fetch (not the page fetched), but consistent with the SDK-vs-CLI split already documented in
  this repo's own `research/agent-seam-taxonomy.md` #2, and worth a dedicated doc fetch before the
  spike if the in-process option becomes relevant. Marked INFERRED here for that reason.

### 3.2 Codex CLI

Source: `learn.chatgpt.com/docs/extend/mcp?surface=cli` (redirected from
`developers.openai.com/codex/mcp`) and `learn.chatgpt.com/docs/developer-commands?surface=cli`
(redirected from `developers.openai.com/codex/cli/reference`).

- **Config**: `~/.codex/config.toml` or project-scoped `.codex/config.toml`, one `[mcp_servers
.<name>]` table per server. **Stdio**: `command` (required), `args`, `env`, `env_vars`, `cwd`,
  `experimental_environment = "remote"`. **Streamable HTTP**: `url` (required), `auth` (`oauth`
  default, or `chatgpt` for session auth), `bearer_token_env_var`, `http_headers`,
  `env_http_headers`. **No SSE support documented** — this matches the ACP-level capability matrix
  this repo already captured live (`evidence/harness-acp-handshake/README.md`: Codex `sse: false,
http: true`) and matches the vendored `CodexAdapter.ts` MCP injection, which uses exactly
  `mcp_servers.t3-code.url=` / `mcp_servers.t3-code.bearer_token_env_var=` as `-c` overrides
  (CodexAdapter.ts:1428-1430) — i.e. the native config surface and the ACP-adapter-mediated surface
  agree on transport (HTTP, no SSE), which is a useful cross-check.
  - CLI: `codex mcp add <name> -- <command>` registers a server; `codex mcp login <server-name>` runs
    OAuth for HTTP servers.
- **Timeouts**: `startup_timeout_sec` (default **10s**) for the server process to come up;
  `tool_timeout_sec` (default **60s**) per tool call. **This is dramatically shorter than Claude
  Code's ~28-hour default** and is the single most important asymmetry for the generate_3d question
  in §5 — a Codex-side long-running tool call needs either a raised `tool_timeout_sec` in the
  project's `config.toml` or a non-blocking (job-handle) tool design, or it will simply be treated as
  failed/timed-out at 60 seconds by default.
- **Image input**: `--image` / `-i`, accepts `path[,path...]` (comma-separated or repeated flag),
  attaches to the initial prompt. Works both interactively (`codex --image photo.png "describe
this"`) and in `codex exec --image ...` (non-interactive). No drag-drop or paste path documented
  (Codex CLI is terminal-only, unlike Claude Code's richer TTY image handling).
- **Non-interactive / exec mode**: `codex exec` (alias `codex e`); `--json`/`--experimental-json` for
  newline-delimited JSON events instead of formatted text; `--output-last-message/-o <path>` to
  capture the final assistant message to a file; `codex exec resume [SESSION_ID] [--all|--last]` to
  continue a prior session headlessly.
- **Long-running / background**: the fetched pages name `codex cloud` and "scheduled tasks" as
  product features but **do not document an async job-handle API for the CLI's own MCP tool-calling
  path** — nothing found analogous to Claude Code's automatic-backgrounding mechanism. Given the
  60-second default `tool_timeout_sec`, the honest reading is: **Codex CLI has no documented
  mechanism for a tool call to outlive its own timeout window** — a tool that wants to run longer than
  ~60s (config-raisable) needs to design for that itself, i.e. return a job handle rather than block.
  This is INFERRED from absence-of-documentation, not a positive "Codex has no async tools" statement
  from OpenAI — worth a targeted follow-up fetch (e.g. the app-server protocol reference) before
  treating it as settled.
- **Result richness**: not documented on the fetched pages. This repo's own live transcript
  (`spikes/acp-probe/results/codex-mcp-workspace.transcript.json`, §2.4 above) shows the standard MCP
  `CallToolResult` envelope (`content[]` + `structuredContent` + `_meta`) passed through **unflattened**
  by the `codex-acp` ACP adapter, which is stronger evidence than the docs gave — structured JSON and
  presumably image content blocks are protocol-supported; whether Codex's own model-facing rendering
  of an image content block matches Claude's is UNVERIFIED (INFERRED "yes, per MCP spec" only).

### 3.3 OpenCode

Source: `opencode.ai/docs/mcp-servers/` and `opencode.ai/docs/cli/`.

- **Config**: `opencode.json`/`opencode.jsonc`, `"mcp": { "<name>": {...} }`. **Local (stdio)**:
  `"type": "local"`, `command: [...]` (array, not separate command+args), `cwd`, `environment`,
  `enabled`, `timeout`. **Remote (HTTP/SSE)**: `"type": "remote"`, `url`, `headers`, `timeout`. Both
  types share one `timeout` field.
  - **Important semantic trap, flagged for the spike**: the docs describe this `timeout` as
    _"Timeout in ms for fetching tools from the MCP server. Defaults to 5000 (5 seconds)"_ — i.e. it
    reads as a **handshake/discovery timeout** (the `tools/list` round-trip at connect time), not
    necessarily a per-tool-**call** execution timeout the way Claude's `.mcp.json` `timeout` field or
    Codex's `tool_timeout_sec` are. If that reading is right, OpenCode's documented config has **no
    separate knob for a long-running `tools/call`** at all — which would make it the odd one out of
    the three and matters directly for §5. Not fully resolved from this fetch; flagged as an open
    question for the spike (§6) to settle by timing an actual slow tool call against a real OpenCode
    session.
- **Image / file input**: `opencode run --file/-f <path>` attaches a file to the message. The docs
  fetched did not specify whether this is image-aware (MIME-sniffed and sent as an image content
  block) or generic-attachment-only. Given ACP's own handshake capability matrix already captured
  live in this repo shows OpenCode advertising `promptCapabilities.image: true`
  (`evidence/harness-acp-handshake/README.md`), image input almost certainly works through `--file`,
  but the exact mechanism (does it need to be a recognized image extension? base64-encoded over ACP
  `session/prompt`'s `image` part type, per `acp-connection.mjs`'s `toWirePromptPart`?) is INFERRED,
  not directly quoted from a doc.
- **Non-interactive / headless**: `opencode run [message]` (no TUI), `opencode serve` (HTTP API
  server), `opencode web`. `--format json` on `run` for raw JSON events instead of formatted text.
- **Long-running / background**: two experimental env flags surfaced —
  `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` (bash-tool-specific, not general MCP) and
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` (background **subagent** tasks, not background **tool
  calls**). No general MCP tool-call async/job-handle mechanism found documented.

### 3.4 Cross-provider comparison table

|                                            | Claude Code                                                                         | Codex CLI                                                                                                                                        | OpenCode                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Stdio MCP                                  | yes                                                                                 | yes                                                                                                                                              | yes (`type:"local"`)                                                                             |
| HTTP MCP                                   | yes (`type:"http"`, recommended)                                                    | yes (`type` implicit from `url`; "streamable HTTP")                                                                                              | yes (`type:"remote"`)                                                                            |
| SSE MCP                                    | yes, **deprecated**                                                                 | **no** (not in docs; matches live `sse:false` capture)                                                                                           | yes (folded into `"remote"`, not distinguished from HTTP in the docs fetched)                    |
| WebSocket MCP                              | yes (JSON-config only)                                                              | not documented                                                                                                                                   | not documented                                                                                   |
| Default tool-call timeout                  | ~28h (unset `MCP_TOOL_TIMEOUT`), configurable per-server                            | **60s**, configurable (`tool_timeout_sec`)                                                                                                       | ambiguous — docs describe `timeout` as connect/discovery-time, not call-time (open question, §6) |
| Long-running-tool pattern client provides  | **automatic backgrounding** at 2min → task ID + notification                        | none documented; tool must self-design for it if it needs to outlive `tool_timeout_sec`                                                          | none documented for MCP tool calls specifically (background _subagents_ only)                    |
| Tool result content types (docs-confirmed) | text, **image** (explicitly discussed re: token limits); structuredContent INFERRED | not docs-confirmed; **live-transcript-confirmed** standard `CallToolResult` (`content[]`+`structuredContent`+`_meta`) passed through unflattened | not docs-confirmed, not live-transcript-confirmed in this repo                                   |
| Image INPUT path                           | file path in prompt text, drag-drop, paste                                          | `--image/-i path[,path]` flag (CLI-level, not in-prompt-text)                                                                                    | `run --file/-f path` (image-awareness INFERRED, not doc-confirmed)                               |
| Tool-name convention observed on the wire  | `mcp__<server>__<tool>`, deferred behind `ToolSearch`                               | `mcp.<server>.<tool>` title; `{server,tool}` split in rawInput                                                                                   | unknown — no captured tool-call transcript                                                       |
| Permission options offered for our tool    | 3 (`allow_always`/`allow_once`/`reject_once`)                                       | 4 (`allow_once`/`allow_session`/`allow_always`/`decline`)                                                                                        | none observed                                                                                    |

---

## 4. Central question: can ONE canonical harness tool server (MCP) serve all three?

**Yes, at the transport/protocol level — every priority provider speaks stdio MCP, which is what this
repo's `workspace-mcp-server.mjs` already is.** The evidence for "yes" is strong: the _exact same_
`{name, command, args, env}` descriptor, built once in `agent-routes.mjs`, was handed unmodified to
Claude Code, Codex, and OpenCode over ACP's `session/new.mcpServers` field on 2026-07-31, and two of
the three (Claude, Codex) round-tripped a real tool call end-to-end against it — same server process
shape, same JSON-RPC framing, same env-var-carried auth. One canonical server, zero per-provider
server code, is not a hypothesis here; it is what already happened, once, before Mechanism B existed.

**What leaks through, even in that best case (all three on an ACP-shaped or ACP-equivalent path):**

1. **Tool naming/discovery is not uniform**, and is the leak most likely to bite a naive
   implementation. Claude Code exact-names the tool `mcp__workbench__update_professional_workspace`
   _and_ defers it behind an internal `ToolSearch` step; Codex names it
   `mcp.workbench.update_professional_workspace` with `{server,tool}` split out in `rawInput`, no
   search step observed. Any code that string-matches a tool name, or assumes the tool is immediately
   callable without a discovery step, breaks on at least one provider. (This repo already solved it —
   `tool-name.mjs` + p2-agent-runtime.md §7 — but it is real work, not zero.)
2. **Permission-option vocabularies differ in cardinality, not just labels** — Claude's 3-way
   allow/reject set vs. Codex's 4-way set that separately distinguishes "this session" from
   "forever." A permission UI built against one provider's option list will either drop a legitimate
   choice (Codex's session-scoped allow) or need to be generic over an option array from the start.
3. **Whether the tool is gated by a permission prompt at all is provider- and _mode_-dependent, not a
   fixed provider fact** — `docs/progress.md` §9 documents that this looked like a stable per-provider
   difference until the session mode was pinned, at which point Claude started gating too. A canonical
   server cannot assume its own gating status; the calling app's own policy layer (this repo's
   `permission-policy.mjs`) has to be the actual gate regardless of what the provider does.
   `p2-agent-runtime.md` §6's policy matrix is built on exactly this non-assumption.
4. **Result-envelope shape at the wire the _client_ passes to the app differs** even when the
   underlying MCP `CallToolResult` is identical — Claude's ACP mapping flattens straight to the
   `content` array; Codex's ACP mapping preserves the full `{result:{content,structuredContent,
error}}` wrapper. A client reading `rawOutput` generically (as this repo's raw-envelope events do)
   is fine; a client that assumes one shape is not.
5. **Timeout and output-size defaults are not interchangeable** (§3.4) — the same slow tool that
   comfortably fits Claude's ~28h default fails outright under Codex's 60s default unless the config
   is raised or the tool itself is redesigned as async. A canonical server's _behavior_ has to be
   designed for the tightest ceiling among the target providers, not the loosest.
6. **Connection-establishment observability is asymmetric** — ACP gives no protocol-level signal that
   a client-supplied stdio MCP server actually started (p2-agent-runtime.md §10's cited reason for the
   hello-handshake workaround, `claude-agent-acp` upstream issue #883). A canonical server has to
   self-report its own startup rather than rely on any provider to confirm it.
7. **Image/structured richness is a spec-level "yes" but a client-level "confirmed for at most one of
   three."** Only Claude Code's own docs explicitly discuss image _content in tool results_
   (token-limit interaction). Codex's live transcript proves the envelope _can_ carry
   `structuredContent`, but this repo's own tool server never populates it, so nothing here confirms
   Codex's model-facing rendering of an image block. OpenCode is undocumented and untested for tool
   _output_ richness entirely. **Practically: assume text-only richness is safe everywhere; treat
   image/structuredContent as "ship it, verify per-provider before depending on it."**

**And, separately from the protocol-level "yes": the current repo does not currently exercise that
"yes" for two of the three priority providers**, because Mechanism B (§1–2) bypasses MCP entirely for
Claude Code and Codex. The canonical-server answer and "does this repo's code path deliver it today"
are two different questions with two different answers, and conflating them is exactly the risk this
note exists to head off before the live spike.

---

## 5. Design note: should `generate_3d` block, or return a job id + `generation_status`?

Framed against §3.4's timeout table, because that table _is_ the deciding evidence here.

**Recommendation: return a job handle (`{jobId}`) immediately and expose a separate
`generation_status(jobId)` polling tool, uniformly across all three providers** — not because every
provider strictly requires it (Claude Code's default would tolerate a genuinely blocking multi-minute
call), but because designing one tool contract that already fails safely on the tightest-timeout
provider (Codex) is cheaper than maintaining two different `generate_3d` behaviors, and because the
async shape composes better with this repo's own existing "propose, then apply" approval pattern
(§10 of p2-agent-runtime.md; the workspace tool and discovery tool are both already "hand back a
structured proposal, let the app gate the effect" — a job-handle `generate_3d` is the same pattern
applied to time instead of to mutation-approval).

**Per-provider reasoning:**

- **Codex — job handle is close to required, not optional.** Default `tool_timeout_sec` is 60s.
  Any real 3D-generation backend (most commercial ones: seconds-to-minutes, some tens of minutes) will
  blow past that by default. Raising `tool_timeout_sec` in `config.toml` is possible but is a
  deployment-config change this product doesn't control on the user's machine (`~/.codex/config.toml`
  is the user's own file, and this repo's own doctrine is "never bundle/never auto-configure a vendor
  CLI" — `docs/specs/p2-agent-runtime.md` §3, DECISION §15). A blocking `generate_3d` is fragile by
  construction on this provider unless we're willing to ask the user to hand-edit their Codex config,
  which the product's own principles argue against.
- **Claude Code — job handle is not required, but is free and consistent with the platform's own
  design.** The ~28h default and the automatic-2-minute-backgrounding-with-task-notification feature
  (§3.1) mean a blocking call would _work_ — Claude Code would background it for you and notify on
  completion, which is functionally close to a job handle already, just client-imposed rather than
  tool-designed. Adopting the same job-handle shape ourselves rather than relying on Claude's
  auto-backgrounding keeps behavior uniform across providers and keeps the semantics in our own
  tool contract instead of depending on a Claude-Code-specific client feature that Codex and OpenCode
  don't have an equivalent for.
- **OpenCode — job handle is the safe default given an unresolved timeout question.** §3.3 flagged
  that OpenCode's documented MCP `timeout` field reads as a connect-time (tools/list) timeout, not
  necessarily a call-time timeout — meaning it's genuinely unknown from docs alone whether a slow
  `generate_3d` call would hang the session, time out silently, or work fine. Given the ambiguity,
  designing for "never block past a few seconds" sidesteps the open question entirely rather than
  betting on an interpretation that the live spike hasn't confirmed yet.

**Concrete shape, consistent with this repo's existing tool patterns** (`tool-server-runtime.mjs`,
§2.3): `generate_3d(args) → {content:[{type:"text", text:"Generation started."}], structuredContent:
{jobId, estimatedSeconds}}` immediately; a second tool `generation_status(jobId) →
{status:"pending"|"running"|"done"|"failed", progress?, resultUri?}` the agent (or, more likely, our
own app polling on the agent's behalf and pushing a `workspace.updated` panel change) calls until
`done`. This needs the workspace-tool-server scaffolding extended to support `structuredContent` in a
reply (§2.3's finding that today's implementation is text-only) — that extension is required
regardless of block-vs-async, since even a status poll benefits from structured `{status, progress}`
over a parsed text string.

**What the live spike should specifically measure before this recommendation is locked in** (folds
into §6): actually time a synthetic slow tool call (a `sleep`-based stub, not a real 3D generator)
against Codex at its default 60s `tool_timeout_sec` to confirm it fails the way the docs imply, and
against OpenCode to resolve whether its `timeout` field is connect-time or call-time. Both are cheap,
mechanical, and would convert two INFERRED rows in §3.4 into VERIFIED.

---

## 6. Live-spike recipe — trivial-tool test, per agent

Goal: prove or disprove §1's central finding (does `createSession({harnessId:"claude-code"|"codex",
...})` actually deliver the workspace tool today), resolve OpenCode's round-trip gap (§2.4), and
resolve the two timeout-semantics open questions (§3.3, §5) — in that priority order, because finding
#1 is the one that changes what "works today" means for the other two.

### 6.1 Reuse what already exists — don't rebuild the harness

This repo already has the exact rig: `spikes/acp-probe/probe.mjs` (drives a raw ACP session against a
`mcpServers`-attached test tool server) and the app's own `POST /api/agent/sessions` route
(`agent-routes.mjs`), which already assembles the real `mcpServers` array and calls
`agentRuntime.createSession(...)`. The fastest, most representative test is the **app's own route**,
not a new standalone script, because it's the one that will actually run in production and it's the
one whose behavior §1 is making a claim about.

### 6.2 Step 1 — confirm/deny the Mechanism B regression (highest priority)

For each of `claude-code` and `codex`:

```bash
# from app/server, with the dev server running (see app/server/README or index.mjs)
curl -s -X POST http://127.0.0.1:<port>/api/agent/sessions \
  -H 'content-type: application/json' \
  -d '{"project": "<a registered project root>", "harnessId": "claude-code", "discovery": false}'
```

Then send one prompt that should trigger the tool:

```bash
curl -s -X POST http://127.0.0.1:<port>/api/agent/sessions/<sessionId>/prompt \
  -H 'content-type: application/json' \
  -d '{"parts": [{"type":"text","text":"Call update_professional_workspace with a minimal design-intent panel to prove the tool is reachable."}]}'
```

Watch the session's event stream (whatever this repo's own SSE/WS endpoint is — not fully traced in
this note; check `app/server/src/api/agent-routes.mjs`'s event-emission path, `emit(...)`, for the
subscribe mechanism) for a `raw` event tagged `claude.sdk.message` or `codex.app-server` (Mechanism B)
vs. `acp.session.update` (Mechanism A — `RAW_SOURCES` in `raw-envelope.mjs` names the exact tags to
grep for). **Confirm the finding by checking whether a `tool_call`/`tool.started` event referencing
`update_professional_workspace` (or `workbench`) ever appears.** If it does not, §1's regression is
confirmed live, not just by static read. If it does, this note's central finding needs correcting —
re-check `claude-sdk-connection.mjs`/`codex-sdk-connection.mjs` for whatever changed.

Repeat identically for `harnessId: "opencode"` as the known-good control — Mechanism A never changed,
so this should succeed and gives a working reference transcript to diff Claude/Codex against.

### 6.3 Step 2 — close the OpenCode round-trip gap

Same recipe as 6.2 but for OpenCode specifically, with a prompt that unambiguously forces the tool
call (the existing captures for Claude/Codex used a full "Shield Charge" combat-design scenario —
reuse `examples/workbench-demo/DESIGN-INTENT.md` and the existing scratch-project fixture rather than
inventing a new one, so the result is comparable to the existing transcripts). Save the transcript
next to the existing ones (`app/server/test/fixtures/live/opencode-workspace-tool.transcript.json`)
so it becomes a regression fixture like its Claude/Codex siblings.

### 6.4 Step 3 — resolve the two timeout-semantics questions

Add one throwaway diagnostic tool (do not ship it) to the workspace tool server's sibling scaffolding
— a `sleep_and_report(seconds)` tool built on the same `runToolServer()` helper
(`tool-server-runtime.mjs`), returning after the requested delay. Run it via the same session
mechanism as 6.2, once per provider, at three delays: 5s (baseline), 65s (crosses Codex's 60s
default), and 130s (crosses Claude Code's 2-minute auto-background threshold). For each run, record:
does the call return normally, time out, or (Claude Code specifically) get silently backgrounded —
and for OpenCode, whether the `timeout` config field in `opencode.json` actually bounds this call at
all when set to e.g. 3000ms, which is the direct test of §3.3's open question. This is the cheapest
way to convert §3.4's two "not fully resolved" / "ambiguous" cells into VERIFIED rows.

### 6.5 What "done" looks like

- A one-line verdict per provider: does `POST /api/agent/sessions` today deliver a working custom
  tool, yes or no, with the transcript path as evidence.
- If Claude/Codex are confirmed broken (§1), a decision recorded in `docs/progress.md` (this note's
  finding is not itself an owner ruling — it's evidence for one): either revert the two providers to
  `backend: "acp"` and solve the model-catalog gap a different way (e.g. per-model catalog patch on
  top of the ACP path, or accept 5 of 9 models until `claude-agent-acp` catches up), or wire
  `mcpServers` support into `ClaudeSdkConnection`/`CodexSdkConnection` (populate
  `McpProviderSession`/`appServerArgs` from `input.mcpServers`, mirroring what the vendored adapters
  already do for T3's own "t3-code" server) so Mechanism B keeps the model-catalog win without losing
  tool injection.
- Three resolved timeout numbers (Codex tool_timeout_sec behavior, Claude auto-background behavior,
  OpenCode `timeout` semantics) feeding directly into a final `generate_3d` implementation, replacing
  §5's INFERRED reasoning with measured behavior.
