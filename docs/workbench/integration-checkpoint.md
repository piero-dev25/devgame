# Integration checkpoint — DevGame workspace integration

Orchestrator state for the 2026-10-02 handoff
(`KaigenHordeSpike/docs/plans/2026-10-02-opus-devgame-handoff.md` and
`2026-10-02-devgame-workspace-kaigen.md`). Update after every milestone.

## Milestones

| Id  | Milestone                                                           | State       | Evidence                                                                                                            |
| --- | ------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| M1  | Phase U: latest T3 merged, compiling, focused tests, record, pushed | Done        | Merge `b55344d8`, review fixes `0a28a8d4`, pushed; [reconciliation record](./upstream-reconciliation-2026-10-02.md) |
| M2  | U2 live gate in isolated state                                      | Done        | Contract suites and one integrated browser pass; see the U2 sections of the reconciliation record                   |
| M3  | PRs 1–8 and M1–M4 slices | In progress | Integration branch `codex/devgame-workspace`; merged PR1 `e58795a6`, PR2 `fea15d5b`, PR5 `c0591188`, PR3 `6bf7e6ee` |
| M4  | Phase C comparison                                                  | Not started | —                                                                                                                   |
| M5  | Final report                                                        | Not started | —                                                                                                                   |

## Pins

- Upstream target: `54084ae1e6c32809db040e4fa571c80fdf2d8ae4`
- DevGame product tip: `ed232bc5b9ddd6b05971bfeb462b658fc8e9265a` (`workbench/upstream-20260806`)
- Merge base: `2c7267ad43a05cf3e30343400c76fd9ac47698e7`
- Integration merge: `b55344d8971c54cec30af3311c58aa6732e15d49`

## Worktrees and processes

| Path                                                           | Branch                           | Base       | Owner        | State dir                        | Owned PIDs |
| -------------------------------------------------------------- | -------------------------------- | ---------- | ------------ | -------------------------------- | ---------- |
| `~/Documents/Projects/devgame` (primary clone, blobless)       | `main`                           | `4219e871` | orchestrator | —                                | none       |
| `~/Documents/Projects/devgame/.claude/worktrees/upstream-sync` | `codex/devgame-workspace` (slices branch from here) | `ed232bc5` | orchestrator | `<worktree>/.t3` (unused so far) | none       |

Toolchain: `~/.local/share/devgame-toolchain` (Node v24.21.0, pnpm 11.10.0 via
corepack). Dependencies installed for server, web, desktop, contracts, shared,
client-runtime; mobile, marketing and relay are not installed.

## Settled decisions

- Base is the product tip, which contains `main`.
- MCP: `McpServer.toolkit` everywhere; grant `pull-requests` and `generation`;
  `preview` stays settings-gated.
- Migrations keep the fork id space plus a ledger guard; storage isolation
  (#98) is an owner decision.
- Editor selection and engine state use composer context records.
- `/usage` and `/pull-requests` render in `AppSidebarLayout`.
- No PRs on the fork or upstream; branches are pushed for review.

## Blocked on Piero

- Storage isolation (#98): whether DevGame moves off `~/.t3`.
- `devgame.fun` domain ownership (used in identity strings).

## Slice log

| Slice | Branch head | Merged into integration | Review |
| --- | --- | --- | --- |
| PR1 workspace reader | `codex/workspace-reader` `26edcfd3` | `e58795a6` | 4 minor, fixed with tests |
| PR2 workspace route | `codex/workspace-route` `9083dc0b` | `fea15d5b` | none |
| PR5 run profiles | `codex/kaigen-profiles` `eb0777fe` | `c0591188` | 1 major (dangling-symlink output escape) + 3 minor, fixed |
| PR3 workspace panel | `codex/workspace-panel` `8d3f9ac2` | `6bf7e6ee` | 3 minor, fixed |

Disk throttle (2026-10-03, at the disk session's request): one agent at a time,
all in the integration worktree; no new worktrees or `node_modules` while free
space is under 12 GB.

Kaigen target: `KaigenHordeSpike/Runtime/out/macos/debug/kaigen-horde-spike`
(arm64, built 2026-09-23). HordeSpike has uncommitted `horde.c` changes, so
build provenance must be reported as possibly stale.

## Next step

Batch 2: PR6 runner, PR4 Use in chat, PR7 runtime panel, PR8 evidence. Then
batch 3: M1–M4 Mr. Mak import. Then the one authorized Kaigen launch.
