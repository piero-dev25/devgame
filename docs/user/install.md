# Install DevGame

DevGame runs coding agents on your computer, specialised for game development (Unity
integration, dockable panels, editor presence). It is a fork of
[T3 Code](https://github.com/pingdotgg/t3code) — see [ATTRIBUTION.md](../../ATTRIBUTION.md).

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch DevGame and configure providers afterwards.

## Download

Grab the latest build from [GitHub Releases](https://github.com/piero-dev25/devgame/releases).

The released macOS build is **code-signed (Developer ID) and notarized by Apple** — it opens
like any normal download, no security warnings. Only self-built binaries are unsigned; see
[build-from-source.md](./build-from-source.md) for the one-time right-click-Open those need.

## No Package Registry Yet

There's no install script, `npx`, `winget`, `brew`, `.deb` repository, or AUR install for
DevGame yet, and the T3 Code mobile apps in the App Store and Google Play are T3 Code's, not
DevGame's. Download the release artifact above, or build it yourself. See
[docs/user/build-from-source.md](./build-from-source.md) for the full walkthrough.

## Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install the provider CLIs inside that distro. DevGame installs its own
server runtime there automatically; the first launch after an app update can
take longer.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from DevGame's provider settings.                                                                                         |

Provider CLIs must be on the server's `PATH`. If DevGame cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

DevGame warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when DevGame can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, DevGame does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Game Features Setup (Unity)

Unity's Play/Stop control, selection chips, and one-click **Setup Integrations** need Unity's
own official CLI on your machine, in addition to Unity Editor via Unity Hub:

```bash
brew install --cask unity-cli
```

(macOS; see [Unity's own CLI docs](https://docs.unity.com/en-us/unity-cli) for other platforms.)
No Unity sign-in is needed for this — Setup Integrations works with a signed-out CLI
(verified against a clean identity). Without the CLI installed, the **Setup Integrations**
button in the engine toolbar does not appear.

With it installed, open a Unity project folder as your DevGame project. The engine toolbar
shows **Setup Integrations** — one click installs Unity's own `com.unity.pipeline` package
(from Unity's own registry) plus DevGame's bundled `com.devgame.editor-presence` package into
the project, and pairs them automatically.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Keeping DevGame in sync](./updating.md): update the app and connected servers.
- [Build from source](./build-from-source.md): run the dev server or package a desktop build.
