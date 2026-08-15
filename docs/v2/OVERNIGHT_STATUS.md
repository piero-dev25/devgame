# Overnight status — DevGame V2 (morning hand-off)

**One action from you finishes everything.** Open a *normal* terminal (not one
running Claude) and either:
- `claude /login` — then tell the loop "logged in"; it runs a credit-free headless
  verify and closes Gate A; **or**
- `cd ~/Projects/t3code-fork && git pull && pnpm dev:desktop` → open Mafia Game →
  ask the in-app agent "generate a 3D barrel" → confirm `generate_3d` fires and the
  Generation panel populates. That closes Gate A **and** the visual Gate B in one go.

Everything below is done and pushed (remote tip `d7abb98da`).

## What shipped tonight
| Commit | What |
|---|---|
| `bae21a106` | #155 A1 — redacted `[mcp-diag]` instrumentation of the harness `/mcp` |
| `374d3ed2b` | **#155 fix** — isolate in-app agents from ambient MCP so harness tools reach them |
| `d7abb98da` | 2b.2 frozen design spec (live progress + web Import-to-Unity) |

## #155 — the keystone (fixed, reviewed, proven as far as auth allows)
**Root cause (evidence-grade, captured from the real `claude` CLI invocation):**
every in-app Claude agent turn loaded *your personal* MCP config — `~/.claude.json`
+ connected claude.ai servers (Gmail/Drive/Strava/…) — alongside DevGame's. Those
leaked into agents **and** crowded out DevGame's `generate_3d`/preview tools. The
capability probe already isolated itself this way; commit `aa5ec8036` (#4015) only
wired that isolation to the probe, never to real turns.

**Fix:** mirror the probe's isolation on the real per-turn query — unconditional
`strictMcpConfig: true` + `ENABLE_CLAUDEAI_MCP_SERVERS=false`, devgame kept as the
sole server with `alwaysLoad`. Also a real **privacy fix** (your personal servers
no longer reach in-app agents).

**Verification:**
- Independent **Opus review**: correct + mergeable (both findings folded in).
- **Red-green guard test** (ClaudeAdapter.test.ts): 70/70, both isolation levers
  proven load-bearing (run + verified directly).
- **Proven live** on a clean backend: the SDK's own `system:init` reports
  `mcp_servers:[{name:"devgame",status:"connected"}]` — only devgame, **zero
  ambient servers**. The isolation works at runtime.
- **CLI wiring confirmed:** the real `claude` argv carries `--strict-mcp-config`
  and `--mcp-config …{"alwaysLoad":true}` — the fork passes exactly the intended
  flags (no SDK-serialization gap, no fork bug).

**Why Gate A4 (agent *calls* generate_3d) is still open:** it needs the model to
actually run, which needs the Claude Agent SDK login. Every backend I can launch
from inside the automated session either inherits a nesting env flag (`CLAUDECODE`,
which hands the agent the wrong toolset — a test artifact real users never have) or
hits the SDK's "Not logged in" wall. There's no auth token in the session env and
no stored credentials file, so I cannot cross it headlessly — hence the `claude
/login` ask. Note: MCP tools are ToolSearch-discoverable in this harness (normal
pattern), so once ambient no longer crowds them out, the agent should find + call
`generate_3d` — the login just lets us watch it happen.

## Gate sequence to finish
1. **A4** (you: login or desktop test) → I confirm the agent calls `generate_3d`.
2. **B** — Codex computer-use E2E on the desktop app: barrel → panel shows
   running→succeeded with thumbnail + triangle count; screenshot naming the commit.
3. **2b.2** — implement the committed design (live progress push + async
   Import-to-Unity), critic → Opus security review of the web→import path → live E2E.

## Notes / follow-ups
- 2b.2 spec already caught real pitfalls (nest the WS route under `/generation` to
  inherit the dev-proxy; make import async to avoid the open #147 false-"failed";
  keep the broadcast cheap to avoid the hard-won GenerationService dep graph;
  import needs the desktop-owner `presence:command` scope — not remote-browser-safe).
- Sibling adapters (Grok/Cursor/Codex/OpenCode) inject devgame without the isolation
  but use ACP explicit arrays (no `settingSources` ambient merge) — assessed
  **likely not a defect**; worth a quick separate check.
- Heavy parallel testing may have churned the machine's Claude Agent SDK login — a
  `claude /login` refreshes it for your own in-app use too.
