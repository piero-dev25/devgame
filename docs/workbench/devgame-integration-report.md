# DevGame integration — final report (2026-10-03)

Outcome of the 2026-10-02 orchestrator handoff
(`KaigenHordeSpike/docs/plans/2026-10-02-opus-devgame-handoff.md`,
`2026-10-02-devgame-workspace-kaigen.md`). Running state:
[integration-checkpoint.md](./integration-checkpoint.md).

## Pinned SHAs

| Ref | SHA |
| --- | --- |
| Upstream T3 `main` merged (as of 2026-10-02; upstream has since moved on, e.g. `7ff2eabf`) | `54084ae1e6c32809db040e4fa571c80fdf2d8ae4` |
| DevGame product tip `workbench/upstream-20260806` (merged side) | `ed232bc5b9ddd6b05971bfeb462b658fc8e9265a` |
| DevGame `main` | `4219e87189c2f50afadc65d90a21c9e6dbf43a68` — content contained (its tree equals PR head `916a634`, an ancestor of the product tip), but the commit itself is not an ancestor: landing on `main` is a merge, not a fast-forward |
| Merge base | `2c7267ad43a05cf3e30343400c76fd9ac47698e7` |
| Sync merge commit | `b55344d8971c54cec30af3311c58aa6732e15d49` (parents `ed232bc5`, `54084ae1`) |
| Green sync tip `codex/upstream-sync-2026-10-02` | `7e6eb847d` |
| Integration branch `codex/devgame-workspace` | the commit that adds this report |

## Branches (pushed to `piero-dev25/devgame`; no PRs, nothing pushed upstream)

| Slice | Branch @ head | Merge into `codex/devgame-workspace` |
| --- | --- | --- |
| Phase U sync + docs | `codex/upstream-sync-2026-10-02` @ `7e6eb847d` | base of the integration branch |
| PR1 workspace reader | `codex/workspace-reader` @ `26edcfd32` | `e58795a67` |
| PR2 workspace route | `codex/workspace-route` @ `9083dc0b8` | `fea15d5b4` |
| PR5 run profiles | `codex/kaigen-profiles` @ `eb0777fe6` | `c0591188f` |
| PR3 Workspace panel | `codex/workspace-panel` @ `8d3f9ac26` | `6bf7e6ee3` |
| PR6 run service | `codex/kaigen-runner` @ `812e5d8fe` | `47d3d405c` |
| PR4 Use in chat | `codex/workspace-context` @ `e98aed35f` | `a824cb513` |
| PR7 Runtime panel | `codex/kaigen-panel` @ `61045fd4e` | `6eda8777d` |
| PR8 run evidence | `codex/kaigen-evidence` @ `e81602e77` | `9eafe40f3` |
| M1 import plan | `codex/mrmak-import-plan` @ `16032fff0` | `befa0e8e6` |
| M2 content import | `codex/mrmak-content-import` @ `802bcd35e` | `867c40403` |
| M3 skill import | `codex/mrmak-skill-import` @ `4432c2956` | `b759d7bbd` |
| M4 import UI | `codex/mrmak-import-ui` @ `4ef60db77` | `c12272058` |
| Kaigen live-loop test | `codex/kaigen-live-demo` @ `ceaabb4a6` | `c451f442f` |

Follow-up commits that live only on the integration branch (not through the
slice review loop; each checked by its own focused tests plus the live runs
and QA pass described below):

- `db683cd12` — `KAIGEN_STATE_DIR` for the live test.
- `306191c17` — the direct capture profile writes into `{{runDir}}` and names its build.
- `d87d295b4` — the capture schedule starts after the game's startup settles.
- `496bd9b81` — Workspace collection labels truncate instead of overlapping.
- `59cffdf13` — the Files dock panel stops polling a draft thread's snapshot.

Every slice in the table was built against the post-sync mount map
([devgame-workspace-slices.md](./devgame-workspace-slices.md)) with focused
behavior tests and went through implement → adversarial review → fix → merge.
The reviews found 11 major defects, all fixed with regression tests before
merging: PR5 output-path escape through a dangling symlink; PR6 process-group
leftovers after a clean leader exit; PR8 log-pattern prefix logic and an
evidence-registry overwrite on read error; M1 symlink-chain escape; M2
destination creation through a symlinked parent, non-idempotent reruns and
glob pathspecs in the import commit; M3 case-insensitive skill-name
collisions; M4 unvalidated receipt paths and an "Original" collection that was
not read-only.

## Verification on the integration branch (orchestrator runs)

| Behavior | Check | Result |
| --- | --- | --- |
| Packages compile | `tsc --noEmit` in contracts, shared, ssh, client-runtime, server, web, desktop | 0 errors, exit 0 each |
| Server slices | 13 test files (import, runtime, workspace, routes, `server.test.ts`, migrations; the live loop excluded) | 356 passed, 4 skipped (env-gated live tests) |
| Web slices | 22 test files (dock, workspace, runtime, import, context packet, queued sends) | 202 passed |
| Capture profile fix | `RunProfiles.test.ts`, `RunEvidence.test.ts` after `306191c17` | 48 passed |
| Capture schedule | `RunProfiles.test.ts` after `d87d295b4` | 31 passed |
| QA fixes | web `tsc`; `resolveWorkspacePanelView`, `workspaceCollections`, `resolveFilesDockPanelView`, `ChatDock`, `entities` tests | 0 errors; 16 + 21 passed |

Phase U and U2 evidence (merge, review fixes, provider contract suites, live
browser pass) is in
[upstream-reconciliation-2026-10-02.md](./upstream-reconciliation-2026-10-02.md).

## Preserved DevGame features

Dock workspace and surfaces as dock panels; unified top band and corner
brand; editor presence protocol and Unity/Godot/Unreal plugins; editor
selection and engine state (now upstream composer context records); engine
toolbar and live play state; Unity Setup Integrations; spaces and task refs
with the fork migration id space (plus the new ledger guard); agent images;
desktop webview security; DevGame identity and release config; MCP harness
hardening (#116, #155) and in-app MCP isolation; the 3D generation service.
Per-feature and per-file detail: the reconciliation record.

## Key conflict decisions

Base on the product tip; upstream `McpServer.toolkit` everywhere; grant
`pull-requests` and `generation`, keep `preview` settings-gated; combine
upstream agent-device env with DevGame's MCP isolation; keep the fork
migration id space and add a ledger guard that refuses mismatched databases;
port editor selection to context records; `ChatDock` mounted in upstream's
hoisted route view; `/usage` and `/pull-requests` in `AppSidebarLayout`; new
upstream identity rebranded (`devgame://`, `com.devgame.*`, Linux desktop id,
app-control socket); preview guests may only deflect http(s) URLs. Full log:
the reconciliation record.

## Mr. Mak import receipts

- Source: `~/Documents/Projects/mr-mak-workspace-trial`, committed HEAD
  `6248c9ec` (working-tree Mac trial edits ignored). Its `git status`
  fingerprint was identical before and after the import.
- Destination: `~/Documents/Projects/mr-mak-comparison`. Commits:
  `4e9bfc0 Import Mr. Mak original content (DevGame import)` (authored "Test"
  because the live import ran inside the test harness's git-identity stub) and
  `d904584 Import Mr. Mak skills (DevGame import)`. Receipt:
  `.devgame/import/receipt.json` (import `93bcaf83`: 994 files = 619 content +
  375 materialized skill files, 0 conflicts, 0 transforms, 34 exclusions).
- Content: 619 files (64.1 MB) from 9 roots. Exclusion categories: VCS,
  dependencies, build outputs and caches, live session data (`.mrmak`, named
  only, never read), app code and tooling, requirement templates (`.codex`,
  `.mcp.json`, `.env.example`: listed without values, not copied), skill
  distribution copies (re-materialized), untracked trial files, and
  not-selected root files (`AGENTS.md`, `CLAUDE.md`, `README.md`, `.github`).
- Links: 346 resolved, 125 external, 0 missing. A dry-run plan against the
  imported project afterwards classifies all 619 files `exists-identical`.
  `workspace.json` is byte-identical to HEAD.
- Live chat histories stay in their original stores (excluded by design).

## Skill discovery evidence

- 20 skills; 391 files in `.agents/skills`, 375 materialized into
  `.claude/skills`, 16 agents-only files (all in `img2threejs`: 11 under
  `.github/`, 5 other dotfiles); byte-equivalence verified.
- Codex: the ChatGPT-bundled Codex CLI (0.159.2), probed in the comparison
  project, reports all 20 under `.agents/skills` (the Homebrew `codex` on
  PATH is 0.159.3).
- Claude: a real Claude Code session started in the comparison project lists
  all 20 from `.claude/skills`.
- No Mr. Mak skill was written to `~/.claude/skills`, `~/.codex/skills` or
  `~/.agents/skills`; Claude Code refreshed its own `~/.claude/skills/synced`
  cache during the session.

## Kaigen launch and evidence

**Passing run (2026-10-03, owner-approved relaunch).** Profile
`vfx-capture-fire-front-0.65` (direct binary, `--no-build`) through DevGame's
real RunProfiles → RunService → RunEvidence loop (`KaigenRunLoop.live.test.ts`),
against a disposable APFS clone of HordeSpike's `Runtime/` (binary SHA-256
`df668be5…`, identical to HordeSpike's). Evidence kept in
`~/Documents/Projects/devgame-kaigen-evidence/2026-10-03-direct-settled/`:

| Behavior | Evidence | Result |
| --- | --- | --- |
| Launch existing build, no build step | run `e7a1e303…`, pid 8927, exit 0, 4.7 s | Pass |
| Capture at effect age 0.65 | log: `VFX capture probe: … effect age 0.65, frame 168, dt 0.02` | Matched |
| Screenshot written into the run directory | log: `screenshot saved: …/fire-front-t00_65.png (2880x1682)` | Matched |
| Output collected | `fire-front-t00_65.png`, 472,628 bytes, SHA-256 `ba35ddf3…` | Exists |
| Build provenance | path, 7,490,672 bytes, mtime 2026-09-23 15:27:34 UTC, SHA-256 `df668be5…` | Recorded |
| Evidence verdict | `outcome: passed`, no failures, `recordedBy: RunService` | Pass |
| Source provenance | clone is not a git repo | `unknown` (reported, not invented) |
| HordeSpike untouched | `git status` fingerprint identical before and after; clone removed | Pass |

Getting there took two more launches, both kept in the evidence folder and
both correctly recorded as failed: right after the macOS restart the game's
first second ran at a low frame rate, and because it advances an effect's
timeline by at most 0.05 s per frame, the capture reached effect age 0.05 and
then 0.32 instead of 0.65. Starting the capture schedule 2 s later
(`d87d295b4`) fixed it without changing the capture itself.

**First authorized launch (2026-10-03, failed).** Profile
`capture-fire-front-0.65` (HordeSpike's `tools/capture_kaigen_vfx.sh` with
`--no-build`):

- Adding `devgame.runtime.json` to HordeSpike was refused by the session's
  safety policy, so the launch used a disposable APFS clone of HordeSpike's
  `Runtime/` and capture script. The cloned binary's SHA-256 matched the
  original (`df668be5…`). HordeSpike's `git status` fingerprint was identical
  before and after; the clone was removed.
- Build provenance: the binary (mtime 2026-09-23 23:27:34) was built from
  HordeSpike's uncommitted `horde.c` (modified 7 s earlier), not from its HEAD
  `e13353b0`.
- The game ran and wrote a 341,459-byte capture (`228745d4…`) and a
  13,172-byte game log into the run directory.
- The script's final self-check exited 127: `rg` is not installed on this Mac
  (agent shells see only a Claude Code shell-snapshot function that
  non-interactive children do not inherit). DevGame recorded the run as
  failed with both log checks `missing`, rather than reporting success.
- The temporary state directory, and with it the artifacts, was cleaned up
  when the test ended; the test now accepts `KAIGEN_STATE_DIR` to keep them.

## Real-client QA of the new panels (2026-10-03, owner-approved)

One browser pass (Chrome DevTools, isolated context) against `vp run dev` in
the integration worktree's own `.t3` state.

| Behavior | Check | Result |
| --- | --- | --- |
| Workspace panel, original Mr. Mak checkout opened directly | Lists its 4 cards from the working-tree registry (including the uncommitted "Mac trial QA" step), engine detected as three.js | Pass |
| Workspace panel, comparison project | "Original Mr. Mak" collection: read-only, provenance `6248c9ec5f54` (codex/macos-trial); 4 cards with 1/2/3/10 steps; 2 workflows, 3 context files, 20 skills, each labelled Mr. Mak; steps disabled on a draft with a clear notice | Pass |
| Use in chat | "Use My Dream Game in chat" adds a visible "Workspace: My Dream Game" chip with "Remove workspace context"; nothing is sent | Pass |
| Import dialog dry run | Source mr-mak-workspace-trial → comparison project: 619 files (61.2 MB), 0 new, 619 already identical, 0 conflicts, 20 skills, 34 excluded, 0 issues, "7 uncommitted edits are not imported"; requirements listed only. Not applied | Pass |
| Run panel | No-profile and no-engine guidance naming `devgame.runtime.json` | Pass |
| Source untouched | Mr. Mak checkout `git status` fingerprint unchanged; comparison project clean | Pass |

Found and fixed during the pass:

- Collection switch labels drew over each other in a narrow dock panel; they
  now truncate (`496bd9b81`; checked live: no overlap at 103 px).
- The Files dock panel subscribed to a draft thread's server snapshot and
  thread sync retried the 404 every 250 ms (787 failed requests); it now waits
  for the thread shell like Terminal and Browser (`59cffdf13`; checked live:
  0 requests in 10 s on a draft, Files still loads on a server thread, console
  clean).

## Remaining limitations

- The default dock preset lays out nine single-panel columns, so each panel is
  narrow on a laptop screen. Grouping Workspace with Files/Diff/Terminal as
  tabs needs a layout-migration change (the migration only recognizes a new
  panel in a single-view column); not done.
- Live lifecycle was exercised with Codex only; Claude is covered by
  integration tests.
- Mr. Mak agent-lifecycle and overhead comparisons have no matched baseline
  ([mrmak-comparison.md](./mrmak-comparison.md)).
- Pre-existing: the dev splash/touch icon still shows the T3 mark; storage
  isolation (#98) is undecided; `devgame.fun` ownership is unconfirmed.
- Upstream mobile, marketing and relay packages were not installed or tested
  (disk); their conflict resolutions are not type-checked.
- Not done by design: release publishing, embedded Kaigen rendering, a C
  workbench, automatic asset production, PRs.

## Needs Piero

1. Decide storage isolation (#98) and confirm the `devgame.fun` domain.
2. Decide whether and how to land `codex/devgame-workspace` on fork `main`
   (a merge: `main`'s PR merge commits are not ancestors of the branch).
3. Decide whether HordeSpike should carry a `devgame.runtime.json` (one new
   untracked file) so it can be launched from DevGame directly; this session's
   safety policy refused writing it, so runs used a disposable clone.

To repeat the Kaigen proof (from `apps/server`, toolchain on PATH):
`DEVGAME_KAIGEN_LIVE=1 KAIGEN_PROJECT_ROOT=<root with devgame.runtime.json> KAIGEN_PROFILE_ID=vfx-capture-fire-front-0.65 KAIGEN_STATE_DIR=<absolute dir> pnpm exec vp test run src/projectRuntime/KaigenRunLoop.live.test.ts`
