# Mr. Mak workbench vs DevGame adaptation — comparison

Phase C of the 2026-10-02 plan. It compares the original Mr. Mak workspace
(as run by the custom Mac trial) with DevGame's adaptation on
`codex/devgame-workspace`. Every row states its evidence and whether the
conditions were matched. Unmatched or unrun comparisons are gaps, not scores.

## Conditions

| | Original | DevGame |
| --- | --- | --- |
| Content snapshot | `witnesstodark/mr-mak-workspace` at `6248c9ec` (committed HEAD; the working tree carries uncommitted Mac-trial edits) | The same snapshot imported into `~/Documents/Projects/mr-mak-comparison`: content commit `4e9bfc0`, skills commit `d904584` |
| Host | This Mac (Apple Silicon, macOS 27) | Same Mac |
| App | Custom Mr. Mak Mac trial (AppKit + WKWebView, Node 25 service), uncommitted on `codex/macos-trial` | DevGame dev build, Node 24.21.0. Code at `codex/devgame-workspace`, built on upstream T3 `main` as of `54084ae1` (2026-10-02) |
| Providers | Codex and Claude Code CLIs in its terminal panes | Codex (app-server runtime) and Claude (agent SDK) through DevGame's adapters; the CLIs directly for skill discovery |

The agent-lifecycle evidence below comes from the U2 live gate, which ran on
the sync tip (before the workspace slices merged), with Codex, on a disposable
repository — not on the imported snapshot.

## Results

| Compare | Evidence | Result | Matched? |
| --- | --- | --- | --- |
| Content fidelity | Content receipt: 619 files from the 9 selected roots (`workspace`, `projects`, `context`, `processes`, `knowledge`, `inbox`, `docs`, `public`, `.agents/skills`), 0 conflicts, 0 transforms, 34 exclusions with reasons. A dry-run plan run against the imported project afterwards classifies all 619 as `exists-identical`; links 346 resolved, 125 external, 0 missing. `workspace/workspace.json` SHA-256 `e0972d9d…` equals the source HEAD blob. Cards `my-dream-game`, `creative-mcp`, `make-workspace-yours`, `arachne-character` keep ids, step order (1/2/3/10 steps) and `defaultStep`. | Full fidelity for the 619 committed files in the selected roots. Root instruction files (`AGENTS.md`, `CLAUDE.md`, `README.md`), `.github`, requirement templates (`.codex`, `.mcp.json`, `.env.example`: listed, not copied) and app code are excluded by design. The working-tree-only "Mac trial QA" step is not imported. | Yes (same snapshot) |
| Skill portability | Skills receipt: 20 skills, 391 files in `.agents/skills`, 375 materialized into `.claude/skills`, 16 agents-only files (all in `img2threejs`: 11 under `.github/`, 5 other dotfiles); equivalence verified (0 differences). The ChatGPT-bundled Codex CLI (0.159.2) probed in the project reports all 20 under `.agents/skills`. A real Claude Code session started in the project lists all 20 from `.claude/skills`. No Mr. Mak skill was written to `~/.claude/skills`, `~/.codex/skills` or `~/.agents/skills` (Claude Code refreshed its own `~/.claude/skills/synced` cache during that session). | Both providers discover the full set from the project. | Yes |
| Review workflow (find brief → attach context → inspect diff → reopen) | DevGame: Workspace dock panel lists cards and steps, opens steps through the existing Files/preview surfaces; "Use in chat" adds a bounded (16,000 characters, 64 references), visible context packet to the current thread and refuses threads of another project; the Diff panel shows checkpoint diffs (U2). Original: Workspace window with cards, separate Chats window with terminal panes. | DevGame keeps one window with the dock as the single layout owner; Mr. Mak splits Workspace and Chats into two OS windows. DevGame's packet is visible and bounded; Mr. Mak relies on the agent reading files. | Partly: DevGame's Workspace, Use in chat, Runtime and Import panels are covered by focused tests only, not yet by a real-client pass |
| Agent lifecycle (response, approval, interrupt/resume, reconnect/history) | DevGame: real Codex turn with command and file-change approvals, interrupt, resume after a server restart, rewind (U2 live gate). Claude: approval forwarding, interrupt, resume and rollback covered by integration tests only. Original: the Mac trial stalls during provider startup before Codex or Claude render a prompt (its own QA report). | DevGame works live with Codex; no original baseline exists on this Mac. | No — the original cannot run a turn here |
| Game loop | DevGame: run profiles, owned process lifecycle, runtime panel, evidence registry. One authorized launch of HordeSpike's capture script (`--no-build`; binary SHA-256 `df668be5…`) through the real RunService wrote a 341,459-byte capture and a 13,172-byte game log; the script's final self-check exited 127 because `rg` is not installed here (agent shells see only a Claude Code shell-snapshot function, which non-interactive children do not inherit), and DevGame recorded the run as failed. The binary was built from HordeSpike's uncommitted `horde.c`, not from its HEAD. Original: no game runtime integration. | DevGame's launch → evidence loop runs and does not fake success; a passing capture is still to be recorded. | No counterpart in the original |
| App overhead (cold start, idle memory, input latency, log streaming) | Not measured. A spot reading of the trial's main process after ~12 h idle shows tens of MB (its WKWebView content processes run under system names); DevGame ran only as a dev server. | No usable numbers. | No |

## Gaps

- **Agent lifecycle baseline.** The original Mac trial stalls at provider
  startup. A matched comparison needs it repaired (a separate, bounded task)
  or the upstream Windows build, which is a different platform.
- **Real-client pass of the new panels.** The single authorized browser pass
  ran before the Workspace, Use in chat, Runtime and Import panels existed.
- **Passing Kaigen capture.** The direct-binary profile
  `vfx-capture-fire-front-0.65` now captures into the run directory (fixed in
  `306191c1`) and avoids the `rg` dependency; one more launch needs owner
  approval.
- **Claude live lifecycle.** Only Codex was exercised in a live client.
- **Overhead.** Needs a packaged DevGame build and a freshly started Mr. Mak
  trial measured with the same tool, with and without a running game.

## Recommendation

**Keep**
- DevGame as the workbench: one window, one dock, upstream provider sessions,
  approvals, checkpoints and resume (proven live with Codex; Claude covered
  by integration tests).
- Mr. Mak's file-backed workspace registry, unchanged, as the project layer:
  it imports with full fidelity and reads safely.
- Project-local skills in `.agents/skills` with materialized `.claude/skills`:
  both providers discover them without writing to home skill folders.
- Run profiles with owned processes and evidence that reports failure.

**Change**
- Prefer direct-binary run profiles that keep every output in `{{runDir}}`
  over shell wrappers with undeclared tool dependencies; let profiles declare
  required tools.
- Let evidence log checks target a declared log output, not only the run's
  stdout, so a wrapper's own post-checks are not a single point of failure.
- Decide whether imported projects should carry the source's `AGENTS.md` and
  `CLAUDE.md` (today they are left out by design).
- Run the real-client QA pass over the new panels before calling the
  workspace experience done.

**Drop**
- Mr. Mak's separate terminal/session manager and second OS window: DevGame's
  provider adapters and dock replace them.
- Copying the Mr. Mak application into game projects: only its content and
  skills move.

The original stays available for direct inspection: the untouched checkout at
`~/Documents/Projects/mr-mak-workspace-trial` (HEAD `6248c9ec`, Mac trial
edits preserved) and its running Mac trial app.
