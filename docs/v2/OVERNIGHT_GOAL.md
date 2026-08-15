# /goal — Overnight V2 loop: close the in-app generation loop

## Objective (DONE =)

The DevGame **desktop app** runs the full generation loop end-to-end, **visually
verified via Codex computer-use**: a human types a prompt in chat → the in-app
agent calls `generate_3d` → the Generation dock panel shows the job go
running→succeeded → a finished textured asset with a **thumbnail + triangle
count** renders in the panel. Then 2b.2 (live progress push + one-click
Import-to-Unity) if credits/time allow. Everything committed + pushed + reviewed.

If #155 proves unsolvable after a thorough instrumented investigation, DONE
degrades to: #155 root-caused with server-log evidence + a written fix plan, and
a crisp morning hand-off — never a false "fixed".

## Premise ledger (true as of session start)

- Repo `~/Projects/t3code-fork`, branch `workbench/upstream-20260806`, remote
  `piero-dev25/devgame` (PUBLIC), origin @ `5cd79aefc`. Upstream is
  `pingdotgg/t3code` — merge FROM it only, **NEVER push toward it, no upstream
  PRs ever.**
- SHIPPED + live-verified: increment 1 (GenerationService + MCP tools), 2a
  (import textured→Unity), 2b.1 (read-only Generation panel — renders live in
  the desktop app), and the CORS fork-rename fix (revived the whole app).
- **THE BLOCKER — #155 (keystone):** the fork's harness `/mcp` HTTP server
  connects + authenticates for agents but its tools (`generate_3d`, preview…)
  don't reliably reach in-app agents — so no agent can create a generation from
  inside the app. Simple `McpServer.toolkit` self-provide theory DISPROVEN by a
  production-topology test (memoized by reference → toolkit≡registerToolkit in
  that composition). Real cause unpinned-live: flaky SDK-mediated injection
  (ClaudeAdapter passes `mcpServers` via the Claude Agent SDK `query()` option,
  4201-4213) + empty-tools symptom, intertwined. `registerToolkit` change +
  production-topology guard test already committed/pushed (8681e57b1 / 5cd79aefc).
- Git tracking-ref hazard: in this shared checkout `git log origin/…` /
  `merge-base` can read a STALE local ref — use `git ls-remote` for remote truth.

## Sequenced increments — keystone-first, gate each (do NOT proceed past a red gate)

### Increment A — FIX #155 (nothing else unblocks without it)

- **A1 (instrument):** minimal server-side logging in `apps/server/src/mcp/
McpHttpServer.ts` (or the transport wiring) — per `/mcp` session log: the
  `tools/list` result (tool-name COUNT + names), initialize/connection events,
  and any auth/capability rejection. REDACT bearer/secrets. tsgo-clean, MCP
  tests green. Implementer builds it; orchestrator reviews + commits.
- **A2 (measure LIVE):** rebuild `dev:desktop`, drive ONE agent turn via **Codex
  computer-use** (select a Claude model, "use the generate_3d MCP tool"), read
  the server log. Decisively CLASSIFY the cause:
  (a) `/mcp` returns an EMPTY tools/list → full-graph memo/wiring bug;
  (b) `/mcp` returns `generate_3d` but the SDK client never completes
  connect/handshake → connection/protocol bug (Accept header / protocol
  version / session);
  (c) intermittent — some turns no harness connects at all → injection
  flakiness (McpProviderSession set/clear lifecycle).
- **A3 (fix):** implement the fix for the CLASSIFIED cause (not a guess).
  Extend the production-topology test / add a regression guard that would catch
  it. Independent FRESH Opus review (foundational + security-touching) +
  adversarial critic; verify findings before acting.
- **A4 (verify LIVE):** `/mcp tools/list` returns `generate_3d` during a real
  turn AND an in-app agent successfully CALLS `generate_3d` (creates a job).
- **GATE A:** A4 green + review approved before B.

### Increment B — close 2b.1's E2E visual

- **B1:** full Codex computer-use E2E on the desktop app (Mafia Game / the
  `wb-e2e` project): agent generates a barrel → Generation panel populates →
  thumbnail + triangle count visible. Screenshot evidence naming the exact
  commit. ~20 Tripo credits.
- **GATE B:** populated-panel visual evidence captured. Mark 2b.1 fully DONE.

### Increment C — 2b.2 (only if credits + time remain after A+B)

- **C1 (design):** me + critics — live WS progress-push (replace the 5s poll,
  mirror the SpaceEvents/EditorPresence live-update precedent) + an
  "Import to Unity" button from the panel. The web→import path does NOT exist
  yet (import is threadId/MCP-gated) — design the web trigger seam. Frozen spec
  FILE.
- **C2:** implement → independent critic → code review (Opus for the web→import
  security path) → live E2E (panel shows live progress; one-click import lands a
  textured asset in Unity, proven via Game View capture).
- **GATE C:** live progress + one-click import both proven.

## Pipeline doctrine (EVERY increment)

- Frozen spec FILE → implementer (Sonnet default / Codex for work-order-shaped;
  **name the model on every dispatch**) → independent FRESH critic (grounded,
  cite file:line, discard ungrounded findings) → code review (Opus for
  foundational/security/merge-gate; Sonnet routine) → live verification →
  orchestrator commits → push. Reviews are ADDED lanes, never substituted.
  Adversarially verify findings before acting. Fix rounds return to the ORIGINAL
  implementer (context preserved); never retry a stuck agent unchanged.
- Use **ultracode Workflow** fan-outs for investigation (multi-lens, adversarial
  verify) and multi-dimension review; single implementers for work-order builds.
- **Computer-use QA = Codex driver ONLY** (owner policy). Perceive via
  `get_app_state`; **PiP + screen-sharing banned**. Item-0 preflight gate. Arm a
  process-liveness WATCHDOG at every dispatch (Codex has died silently ~4min;
  the update helped but keep the watchdog). Mafia Game / `wb-e2e` only.
- Git: **orchestrator commits** (subagents: file edits ONLY, no git mutations —
  a bare commit once swept a sibling lane's `git add`). Commit via `-F`, stage
  FILES not dirs. `git ls-remote` for remote truth. Push to
  `piero-dev25/devgame` only — never force, never upstream.
- Verify ground truth: run the proof yourself; ANSI-strip before grepping tsgo
  (`perl -pe 's/\e\[[0-9;]*m//g'`); a green precondition ≠ done — assert the
  EFFECT and prove the test can go red. `/usr/bin/grep` (shell grep is aliased).

## Loop pacing + stop conditions

- Increment by increment; report at each gate in plain, self-contained language.
- Drive async: each dispatched agent/workflow re-invokes you on completion — take
  the next step then. Long fallback wakeups only if a step could hang.
- **STOP and write `needs input:`** ONLY for: an owner-only grant (e.g. a NEW
  Codex computer-use app-grant), a destructive/irreversible action, or #155
  proving unsolvable after a thorough instrumented pass (hand off with precise
  state + evidence).
- **Budget:** ~560 Tripo credits; each live gen ~20 (convert is free — reuse
  generated assets). Do NOT burn credits on flaky-driver retries — fix the rig
  first. Watch disk (df, not du); keep build scratch in-tree; no worktree farms.
- By morning: the loop should have closed GATE A (and ideally B), with a crisp
  status.

## Owner constraints (verbatim — preserve)

- Codex computer-use for QA; NOT my own computer use.
- NEVER open/list/inspect `~/Projects/Deepmind` — the owner's real work.
- Mafia Game (`~/Projects/Mafia Game`) is the authorized live Unity project;
  never touch CurseJar or other open projects without an explicit OK.
- NO upstream PRs, ever. Windows not promoted on the site.
- Tripo key at `~/.config/devgame/tripo-api-key` — NEVER log, commit, or return
  it; redact at every client-facing exit.
