# Overnight status — DevGame V2 (morning hand-off)

## ✅ #155 RESOLVED — the in-app "agent generates" loop works, proven live

An in-app Claude agent now sees and **calls** the harness's generation/preview
MCP tools. Proven end-to-end on a live authenticated turn — no owner action
needed. Remote tip `0a8940551`.

### The real root cause (finally pinned)
The spawned `claude` CLI validates every `tools/list` response, and **rejects the
entire tool array if even one tool's schema is malformed.** `list_generations`
used a bare `Schema.Struct({})` (an empty Effect struct), which Effect serializes
to a JSON Schema *without* a top-level `type: "object"` — so that one bad schema
took **all 19** DevGame tools dark, for every agent and every session. That's why
nothing worked despite the server clearly serving the tools and the connection
succeeding.

### The fix (`50d0958d8`, + debug affordance `0a8940551`)
- `list_generations`'s input → `Schema.StructWithRest(Schema.Struct({}),
  [Schema.Record(String, Never)])`, which emits a valid `{type:"object"}` while
  staying genuinely no-arg.
- **Startup guard**: the server now fails loud (naming offenders) if any served
  tool's schema lacks `type:"object"` — this class of bug can never silently
  recur.
- **Red-green test**: asserts all 19 tools serve `type:"object"`; proven to fail
  against the old schema, pass after. tsgo clean; `vitest src/mcp/` = 81 passed.

### Live proof (credit-free)
A clean, authenticated in-app agent turn emitted a real tool call:
`tool.started/completed → mcp__devgame__list_generations`, and the CLI's own log:
`Calling MCP tool: list_generations ... completed successfully`, `outcome=ok`.
The pre-fix `tools/list failed (tools.16.inputSchema.type)` error is gone.

### Also shipped (kept, separate from the root cause)
- `374d3ed2b` — MCP isolation: in-app agents no longer inherit your *personal*
  MCP servers (Gmail/Drive/Strava/etc.). A real privacy + correctness fix,
  runtime-proven (the SDK reports only `devgame` connected). Necessary but was
  never the #155 cause.
- `bae21a106` — `[mcp-diag]` server instrumentation.
- `d7abb98da` — 2b.2 frozen design spec (live progress + web Import-to-Unity),
  critic-reviewed, ready to build.

## What's left (optional / next)
- **Gate B — visual E2E (~20 Tripo credits):** a full `generate_3d` on the real
  desktop app via Codex computer-use, showing the Generation panel populate with
  a thumbnail + triangle count. The *core* of #155 is already proven (the agent
  can call harness tools; `generate_3d` runs the identical path) — this is the
  visual seal, not a correctness gate.
- **2b.2 implementation** — the committed design is ready to greenlight.
- The methodology lesson (how to run a clean-but-authenticated in-app agent test
  from a dev backend) is saved so future MCP work doesn't relitigate it.

Thanks for the "I'm logged in" nudge — it broke a false auth wall I'd talked
myself into, which is exactly what surfaced the real bug.
