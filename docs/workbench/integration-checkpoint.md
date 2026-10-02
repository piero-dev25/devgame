# Integration checkpoint — DevGame workspace integration

Orchestrator state for the 2026-10-02 handoff
(`KaigenHordeSpike/docs/plans/2026-10-02-opus-devgame-handoff.md` and
`2026-10-02-devgame-workspace-kaigen.md`). Update after every milestone.

## Milestones

| Id  | Milestone                                                           | State              | Evidence                                                                           |
| --- | ------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| M1  | Phase U: latest T3 merged, compiling, focused tests, record, pushed | Review in progress | Merge `b55344d8`; [reconciliation record](./upstream-reconciliation-2026-10-02.md) |
| M2  | U2 live gate in isolated state                                      | Not started        | —                                                                                  |
| M3  | PRs 1–8 and M1–M4 slices                                            | Not started        | —                                                                                  |
| M4  | Phase C comparison                                                  | Not started        | —                                                                                  |
| M5  | Final report                                                        | Not started        | —                                                                                  |

## Pins

- Upstream target: `54084ae1e6c32809db040e4fa571c80fdf2d8ae4`
- DevGame product tip: `ed232bc5b9ddd6b05971bfeb462b658fc8e9265a` (`workbench/upstream-20260806`)
- Merge base: `2c7267ad43a05cf3e30343400c76fd9ac47698e7`
- Integration merge: `b55344d8971c54cec30af3311c58aa6732e15d49`

## Worktrees and processes

| Path                                                           | Branch                           | Base       | Owner        | State dir                        | Owned PIDs |
| -------------------------------------------------------------- | -------------------------------- | ---------- | ------------ | -------------------------------- | ---------- |
| `~/Documents/Projects/devgame` (primary clone, blobless)       | `main`                           | `4219e871` | orchestrator | —                                | none       |
| `~/Documents/Projects/devgame/.claude/worktrees/upstream-sync` | `codex/upstream-sync-2026-10-02` | `ed232bc5` | orchestrator | `<worktree>/.t3` (unused so far) | none       |

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

## Next step

Close adversarial review findings on the merge, then start the U2 live gate.
