# Install DevGame

DevGame is a web and desktop GUI for running coding agents on your machine, specialised for
game development (Unity integration, dockable panels, editor presence). It is a fork of
[T3 Code](https://github.com/pingdotgg/t3code) — see [ATTRIBUTION.md](../../ATTRIBUTION.md).

## Download

Grab the latest build from [GitHub Releases](https://github.com/piero-dev25/devgame/releases).

Releases are currently an **unsigned alpha**. macOS Gatekeeper will refuse to open the app on
first launch ("cannot be opened because Apple cannot check it for malicious software"). Work
around it one of these ways:

- Right-click `DevGame.app` → **Open** → **Open** in the dialog that appears.
- Or launch it once (it will be blocked), then go to **System Settings → Privacy & Security**
  and click **Open Anyway** next to the DevGame entry.
- Or strip the quarantine flag directly: `xattr -d com.apple.quarantine /path/to/DevGame.app`

## No Package Registry Yet

There's no `npx`, `winget`, `brew`, or AUR install for DevGame yet — download the release
artifact above, or build it yourself. See
[docs/user/build-from-source.md](./build-from-source.md) for the full walkthrough.

## Providers

DevGame drives provider CLIs; it does not ship them. Install the CLI for each provider you want
to use, then authenticate it.

| Provider   | CLI                                                   | Default binary | Log in with           |
| ---------- | ----------------------------------------------------- | -------------- | --------------------- |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)  | `codex`        | `codex login`         |
| Claude     | [Claude Code](https://claude.com/product/claude-code) | `claude`       | `claude auth login`   |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                  | `cursor-agent` | `agent login`         |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                    | `grok`         | `grok login`          |
| OpenCode   | [OpenCode](https://opencode.ai)                       | `opencode`     | `opencode auth login` |

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
DevGame looks for, but authenticate with `agent login`, not `cursor-agent login`.

Run the login command on the machine running the DevGame server, not on the device you browse
from.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started DevGame.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
DevGame. You can install DevGame, open it, and add providers afterwards. A provider that is not
authenticated shows its status in **Settings** and fails at session start with the login command
to run.

For multi-account setups, see [Codex](./providers-codex.md) and [Claude](./providers-claude.md).

## Game Features Setup (Unity)

Unity's Play/Stop control, selection chips, and one-click **Setup Integrations** need Unity's
own official CLI on your machine, in addition to Unity Editor via Unity Hub:

```bash
brew install --cask unity-cli
```

(macOS; see [Unity's own CLI docs](https://docs.unity.com/en-us/unity-cli) for other platforms.)
You may also need to run `unity auth login` once. Without the CLI installed, the **Setup
Integrations** button in the engine toolbar does not appear.

With it installed, open a Unity project folder as your DevGame project. The engine toolbar
shows **Setup Integrations** — one click installs Unity's own `com.unity.pipeline` package
(from Unity's own registry) plus DevGame's bundled `com.devgame.editor-presence` package into
the project, and pairs them automatically.

## Next Steps

- [Permission modes](./permission-modes.md): how much DevGame asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping DevGame in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
