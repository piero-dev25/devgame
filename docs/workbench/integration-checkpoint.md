# Integration checkpoint — DevGame workspace integration

Orchestrator state for the 2026-10-02 handoff
(`KaigenHordeSpike/docs/plans/2026-10-02-opus-devgame-handoff.md` and
`2026-10-02-devgame-workspace-kaigen.md`). Update after every milestone.

## Milestones

| Id | Milestone | State | Evidence |
| --- | --- | --- | --- |
| M1 | Phase U: latest T3 merged, compiling, focused tests, record, pushed | Done | Merge `b55344d8`, review fixes `0a28a8d4`, pushed; [reconciliation record](./upstream-reconciliation-2026-10-02.md) |
| M2 | U2 live gate in isolated state | Done | Contract suites and one integrated browser pass; U2 sections of the reconciliation record |
| M3 | PRs 1–8 and M1–M4 slices | Done | All 12 slices merged into `codex/devgame-workspace`; [final report](./devgame-integration-report.md) |
| M4 | Phase C comparison | Done, with named gaps | [mrmak-comparison.md](./mrmak-comparison.md) |
| M5 | Final report | Done | [devgame-integration-report.md](./devgame-integration-report.md) |

## Pins

- Upstream target: `54084ae1e6c32809db040e4fa571c80fdf2d8ae4`
- DevGame product tip: `ed232bc5b9ddd6b05971bfeb462b658fc8e9265a` (`workbench/upstream-20260806`)
- Merge base: `2c7267ad43a05cf3e30343400c76fd9ac47698e7`
- Sync merge: `b55344d8971c54cec30af3311c58aa6732e15d49`
- Green sync tip: `codex/upstream-sync-2026-10-02` `7e6eb847`
- Integration branch: `codex/devgame-workspace`

## Worktrees and processes

| Path | Branch | Owner | State dir | Owned PIDs |
| --- | --- | --- | --- | --- |
| `~/Documents/Projects/devgame` (primary clone, blobless) | `main` | orchestrator | — | none |
| `~/Documents/Projects/devgame/.claude/worktrees/upstream-sync` | `codex/devgame-workspace` | orchestrator | `<worktree>/.t3` (U2 pass) | none |

No DevGame dev server, game or provider process is running. Toolchain:
`~/.local/share/devgame-toolchain` (Node v24.21.0, pnpm 11.10.0 via corepack).
Dependencies are installed for server, web, desktop, contracts, shared and
client-runtime; mobile, marketing and relay are not.

Other artifacts: comparison project `~/Documents/Projects/mr-mak-comparison`
(commits `4e9bfc0` content, `d904584` skills).

## Settled decisions

- Base is the product tip; `main`'s content is contained, but landing on
  `main` is a merge.
- MCP: `McpServer.toolkit` everywhere; grant `pull-requests` and `generation`;
  `preview` stays settings-gated.
- Migrations keep the fork id space plus a ledger guard.
- Editor selection and engine state use composer context records.
- `/usage` and `/pull-requests` render in `AppSidebarLayout`.
- No PRs on the fork or upstream; branches are pushed for review.

## Blocked on Piero

- One more Kaigen launch with the direct-binary profile
  `vfx-capture-fire-front-0.65`, and where its `devgame.runtime.json` may live
  (HordeSpike root, or a disposable clone). The session's safety policy
  refused writing it into HordeSpike.
- A real-client QA pass over the Workspace, Use in chat, Runtime and Import
  panels.
- Storage isolation (#98) and `devgame.fun` domain ownership.
- Whether and how to land `codex/devgame-workspace` on fork `main`.

## Slice log

| Slice | Branch head | Merged into integration | Review |
| --- | --- | --- | --- |
| PR1 workspace reader | `codex/workspace-reader` `26edcfd3` | `e58795a6` | 4 minor, fixed with tests |
| PR2 workspace route | `codex/workspace-route` `9083dc0b` | `fea15d5b` | none |
| PR5 run profiles | `codex/kaigen-profiles` `eb0777fe` | `c0591188` | 1 major (dangling-symlink output escape) + 3 minor, fixed |
| PR3 workspace panel | `codex/workspace-panel` `8d3f9ac2` | `6bf7e6ee` | 3 minor, fixed |
| PR6 run service | `codex/kaigen-runner` `812e5d8f` | `47d3d405` | 1 major (process-group leftovers after a clean leader exit) + 2 minor, fixed |
| PR4 Use in chat | `codex/workspace-context` `e98aed35` | `a824cb51` | 5 minor, fixed |
| PR7 runtime panel | `codex/kaigen-panel` `61045fd4` | `6eda8777` | 3 minor, fixed |
| PR8 run evidence | `codex/kaigen-evidence` `e81602e7` | `9eafe40f` | 2 major (log-pattern prefix logic; registry read error could overwrite records) + 4 minor, fixed |
| M1 import plan | `codex/mrmak-import-plan` `16032fff` | `befa0e8e` | 1 major (symlink-chain escape) + 6 minor, fixed |
| M2 content import | `codex/mrmak-content-import` `802bcd35` | `867c4040` | 3 major (symlinked-parent destination, non-idempotent reruns, glob pathspecs) + 6 minor, fixed |
| M3 skill import | `codex/mrmak-skill-import` `4432c295` | `b759d7bb` | 1 major (case-insensitive rename collision) + 5 minor, fixed |
| M4 import UI | `codex/mrmak-import-ui` `4ef60db7` | `c1227205` | 2 major (unvalidated receipt paths; Original collection not read-only) + 3 minor, fixed |
| Kaigen live-loop test | `codex/kaigen-live-demo` `ceaabb4a` | `c451f442` | follow-ups `db683cd1`, `306191c1` on the integration branch, checked by a read-only fact-check |

Disk throttle (2026-10-03, at the disk session's request): one agent at a time,
all in the integration worktree; no new worktrees or `node_modules` while free
space is under 12 GB.

## Next step

The owner decisions above. Everything else in the handoff scope is done.
