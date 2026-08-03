# Attribution

**DevGame is a fork of [T3 Code](https://github.com/pingdotgg/t3code), built by T3 Tools, Inc.**

Almost everything that makes this application work was written by them. We did
not build an agent harness and add a few game-development features to it — we
took a finished, well-engineered product and specialised it.

## What T3 Tools built

The parts we depend on and did not write:

- **The agent harness itself** — orchestration across Claude Code, Codex,
  Cursor, Grok Build and OpenCode, each driven through the user's own
  subscription.
- **Four client applications** — the Effect-based server, the web app, the
  Electron desktop shell, and the Expo/React Native mobile app, sharing one
  contract layer.
- **The terminal**, built on Ghostty, including the vendored `libghostty`
  builds for iOS and Android.
- **Checkpointing** — isolated git index, hidden refs, per-turn snapshots that
  genuinely roll back binary assets.
- **Source control** — diffs, review, commit and branch handling.
- **DPoP device pairing** and the whole authentication and session model.
- **The release pipeline** — signing, notarization, EAS builds, update feeds.

The architecture is theirs too, and it held up under everything we asked of it.
The event-sourced orchestration model let us add an entire new aggregate without
touching their reducers. Their Effect `Layer` composition let us attach a new
WebSocket transport from outside their tree. Extending this codebase has been
consistently pleasant, which is not the usual experience of working inside
someone else's application.

## What we added

- **Editor presence** — a protocol and plugins for Unity, Unreal and Godot, so
  the object you have selected in your engine is already in the chat composer
  before you type.
- **A dockable workspace** — panels you can drag, tab and rearrange.
- **ICM workspaces** and the game-development project model.

## The licence, and the invitation

T3 Code is MIT-licensed. Their copyright notice stands unchanged in
[`LICENSE`](./LICENSE) and always will — that is both the licence's requirement
and the right thing to do.

Their README says it plainly: they want you to have everything you need to fork
and build the editor that you want. This fork exists because they meant it. We
would rather say thank you for that than treat it as mere permission.

## Staying in step

We are not diverging. We track `upstream/main` and merge their improvements on
a regular cadence, keeping their runtime, contracts and release plumbing close
to upstream and confining our changes to our own directories and small mount
points. See [`docs/workbench/upstream-strategy.md`](./docs/workbench/upstream-strategy.md).

If you want the general-purpose agent harness rather than the
game-development-specific one, **use T3 Code**. It is the better tool for that
job, it is actively developed, and it is where this all came from:

- https://github.com/pingdotgg/t3code
- https://t3.codes
