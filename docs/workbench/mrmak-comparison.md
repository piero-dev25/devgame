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
| Review workflow (find brief → attach context → inspect diff → reopen) | DevGame: Workspace dock panel lists cards and steps, opens steps through the existing Files/preview surfaces; "Use in chat" adds a bounded (16,000 characters, 64 references), visible context packet to the current thread and refuses threads of another project; the Diff panel shows checkpoint diffs (U2). Original: Workspace window with cards, separate Chats window with terminal panes. | DevGame keeps one window with the dock as the single layout owner; Mr. Mak splits Workspace and Chats into two OS windows. DevGame's packet is visible and bounded; Mr. Mak relies on the agent reading files. A real-client pass confirmed the Workspace cards and provenance, the Use in chat chip (removable, nothing sent), the Import dry run (619 already identical, 0 conflicts) and the Run panel guidance; it found and fixed overlapping collection labels and a draft-thread polling loop. DevGame's default layout is nine narrow columns. | Partly: same content and host, but the steps were exercised once each, not timed |
| Agent lifecycle (response, approval, interrupt/resume, reconnect/history) | DevGame: real Codex turn with command and file-change approvals, interrupt, resume after a server restart, rewind (U2 live gate). Claude: approval forwarding, interrupt, resume and rollback covered by integration tests only. Original: the Mac trial stalls during provider startup before Codex or Claude render a prompt (its own QA report). | DevGame works live with Codex; no original baseline exists on this Mac. | No — the original cannot run a turn here |
| Game loop | DevGame: run profiles, owned process lifecycle, runtime panel, evidence registry. Passing run of the direct-binary profile `vfx-capture-fire-front-0.65` (`--no-build`, binary SHA-256 `df668be5…`) through the real RunService: exit 0, capture probe at effect age 0.65, 2880×1682 screenshot (`ba35ddf3…`) collected from the run directory, build provenance recorded, evidence `passed`. Earlier runs were recorded as failed for real reasons: the capture script's `rg` dependency (not installed here) and a capture schedule too early for the game's slow first second after a restart. The binary was built from HordeSpike's uncommitted `horde.c`, not its HEAD; source provenance reads `unknown` for the disposable clone. Original: no game runtime integration. | DevGame launches the existing build, captures, and records evidence that passes or fails honestly. | No counterpart in the original |
| App overhead (cold start, idle memory, input latency, log streaming) | Not measured. A spot reading of the trial's main process after ~12 h idle shows tens of MB (its WKWebView content processes run under system names); DevGame ran only as a dev server. | No usable numbers. | No |

## Gaps

- **Agent lifecycle baseline.** The original Mac trial stalls at provider
  startup. A matched comparison needs it repaired (a separate, bounded task)
  or the upstream Windows build, which is a different platform.
- **Claude live lifecycle.** Only Codex was exercised in a live client.
- **Dock density.** Nine single-panel columns are narrow on a laptop screen;
  grouping panels as tabs needs a layout-migration change.
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
- Schedule game captures after the engine's startup settles, or have the
  game signal readiness, instead of relying on wall-clock offsets.
- Group the dock's panels into tabs by default (needs a layout-migration
  change) so the Workspace panel is usable on a laptop screen.

**Drop**
- Mr. Mak's separate terminal/session manager and second OS window: DevGame's
  provider adapters and dock replace them.
- Copying the Mr. Mak application into game projects: only its content and
  skills move.

The original stays available for direct inspection: the untouched checkout at
`~/Documents/Projects/mr-mak-workspace-trial` (HEAD `6248c9ec`, Mac trial
edits preserved) and its running Mac trial app.
