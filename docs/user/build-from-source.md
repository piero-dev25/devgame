# Build DevGame From Source

This is the one complete walkthrough for building DevGame yourself: running the dev server, and
packaging a desktop artifact. There's no package registry install yet (see
[install.md](./install.md)) — this is the path until there is.

## Prerequisites

- **Node.js `^24.13.1`** (pinned in the root `package.json`'s `engines` field).
- **The `vp` (Vite+) CLI**, or plain `pnpm@11.10.0` (the pinned `packageManager`).
- **macOS only: Xcode Command Line Tools.** `apps/server` depends on `node-pty`, which compiles
  a native addon. Install with `xcode-select --install` if you don't already have them.
- **A Rust toolchain (`cargo`).** Desktop artifact builds compile
  `native/resource-monitor` via `cargo build --locked --release`. Any standard install
  (e.g. [rustup](https://rustup.rs)) works — CI uses `dtolnay/rust-toolchain@stable`, i.e. just
  the stable channel, no pinned version. If you're building for an architecture other than your
  host's, you'll also need that target installed (`rustup target add <target-triple>`).

## Install `vp`

DevGame uses Vite+, so you'll need the global `vp` command-line tool.

macOS / Linux:

```bash
curl -fsSL https://vite.plus | bash
```

Windows:

```bash
irm https://vite.plus/ps1 | iex
```

See https://viteplus.dev/guide/ for more.

## Clone And Install

```bash
git clone https://github.com/piero-dev25/devgame.git
cd devgame
vp i
```

## Run The Dev Server

```bash
vp run dev
```

This starts both the server and the web app. Read the real port numbers from the
`[dev-runner]` line in the output — they're derived from your worktree path and can shift if
the default ports are occupied.

Other dev targets, if you only want one piece: `vp run dev:server`, `vp run dev:web`,
`vp run dev:desktop`. See `AGENTS.md` ("Dev servers") for details on worktree-local state,
sharing over Tailscale, and pairing URLs.

## Build A Desktop Artifact

Desktop artifacts are built with `scripts/build-desktop-artifact.ts`, exposed as `pnpm`/`vp`
scripts per platform and architecture:

| Command                       | Platform | Target   | Arch                                                 |
| ----------------------------- | -------- | -------- | ---------------------------------------------------- |
| `pnpm dist:desktop:dmg:arm64` | macOS    | dmg      | arm64                                                |
| `pnpm dist:desktop:dmg:x64`   | macOS    | dmg      | x64                                                  |
| `pnpm dist:desktop:dmg`       | macOS    | dmg      | host default                                         |
| `pnpm dist:desktop:linux`     | Linux    | AppImage | x64                                                  |
| `pnpm dist:desktop:win:arm64` | Windows  | nsis     | arm64                                                |
| `pnpm dist:desktop:win:x64`   | Windows  | nsis     | x64                                                  |
| `pnpm dist:desktop:win`       | Windows  | nsis     | host default                                         |
| `pnpm dist:desktop:artifact`  | —        | —        | pass your own `--platform`/`--target`/`--arch` flags |

For example, on Apple Silicon:

```bash
pnpm dist:desktop:dmg:arm64
```

The DMG and its zip land in `release/` at the repo root, e.g.
`release/DevGame-<version>-arm64.dmg` and `release/DevGame-<version>-arm64.zip`.

### Builds Are Unsigned By Default

Unless you set the Apple signing environment variables the build script looks for
(`T3CODE_APPLE_TEAM_ID`, `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`), the resulting `.app` is unsigned. macOS Gatekeeper will refuse to open it
on first launch: _"cannot be opened because Apple cannot check it for malicious software."_

Work around it one of these ways:

- Right-click the `.app` → **Open** → **Open** in the dialog that appears.
- Or launch it once (it will be blocked), then go to **System Settings → Privacy & Security**
  and click **Open Anyway** next to the app's entry.
- Or strip the quarantine flag directly: `xattr -d com.apple.quarantine /path/to/DevGame.app`

## Next Steps

- [docs/user/install.md](./install.md) — provider setup and Unity CLI setup for a built app.
- [docs/internals/overview.md](../internals/overview.md) — architecture, for anyone changing
  the code rather than just building it.
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — read before opening an issue or PR.
