# DevGame

> **DevGame is a fork of [T3 Code](https://github.com/pingdotgg/t3code), built by T3 Tools, Inc. and MIT-licensed.**
>
> Almost everything that makes this application work was written by them — the
> agent harness, the terminal, checkpointing, source control, device pairing,
> and all four client apps. We specialised it for game development; we did not
> build it. Full credit, and what we actually added, in
> [ATTRIBUTION.md](./ATTRIBUTION.md).
>
> If you want the general-purpose agent harness rather than the game-dev one,
> **use [T3 Code](https://github.com/pingdotgg/t3code)** — it is the better tool
> for that job and it is where this came from.

T3 Code (below) is an "agent harness control surface". It enables control of the agents on your
machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824),
[Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes)
and [Electron-based desktop app](https://t3.codes). Those store listings and hosted apps are
**T3 Code's**, not DevGame's — DevGame today ships as a desktop app you download or build
yourself; see Installation below.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and OpenCode. If they're set up on your computer, DevGame can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> DevGame currently supports Codex, Claude, Cursor, Grok Build and OpenCode. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Download

Grab the latest build from [GitHub Releases](https://github.com/piero-dev25/devgame/releases).

> [!NOTE]
> The released macOS build is **code-signed (Developer ID) and notarized by
> Apple** — it opens like any normal download, no security warnings. (Only
> self-built binaries are unsigned; the [build guide](./docs/user/build-from-source.md)
> covers the one-time right-click-Open for those.)

### Build from source

There's no package registry install yet — build the desktop app or run the
dev server yourself. See [docs/user/build-from-source.md](./docs/user/build-from-source.md)
for the full walkthrough (prerequisites, `vp i`, dev run, and packaging a
desktop artifact).

### Game features setup (Unity)

The Unity integration (Play/Stop, selection chips, one-click **Setup
Integrations**) needs Unity's own official CLI on your machine, in addition
to Unity Editor via Unity Hub:

```bash
brew install --cask unity-cli
```

(macOS; see [Unity's own CLI docs](https://docs.unity.com/en-us/unity-cli) for
other platforms.) No Unity sign-in is needed for this — Setup Integrations
works with a signed-out CLI (verified against a clean identity). Without
the CLI installed, the **Setup Integrations** button in the engine toolbar
does not appear. With it installed, open a Unity project as your DevGame
project and click **Setup Integrations** — it installs Unity's own
`com.unity.pipeline` package plus our bundled `com.devgame.editor-presence`
package into the project and pairs them automatically.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/user/build-from-source.md](./docs/user/build-from-source.md).
For the architecture behind it, see [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

The canonical build walkthrough lives at [docs/user/build-from-source.md](./docs/user/build-from-source.md); the steps below are the short version.

### Install `vp`

DevGame uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
