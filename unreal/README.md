# T3 Editor Presence — Unreal Engine plugin

Streams the current Unreal Editor selection (level actors and Content
Browser assets) to a T3 Code chat composer, over the Editor Presence
Protocol (EPP) — see `docs/workbench/spec-editor-presence.md` in this repo
for the protocol itself, and `apps/server/src/editorPresence/protocol.ts`
for the exact wire contract this plugin implements.

A content-only Python plugin: no compiler, no per-engine-version binary, no
project conversion. Works on a Blueprint-only project with no C++ in it at
all. See `docs/workbench/spec-unreal-publisher.md` (referenced from the
build brief) for the full reasoning behind that choice, and
`UNVERIFIED.md` in this directory for exactly which Unreal Python API calls
this plugin depends on that have not been confirmed against a running
editor — **Unreal Engine was not installed on the machine this was built
on, so read that file before trusting this plugin in a real project.**

## Install

1. Close the Unreal Editor.
2. Copy the `EditorPresence/` folder (the one directly containing
   `EditorPresence.uplugin`) so it lands at
   `<YourProject>/Plugins/EditorPresence/EditorPresence.uplugin`.
   There is no package manager for Unreal plugins — a zip download, `git
clone`, or `git submodule` of just this folder are all equivalent.
3. Open the project. If prompted about a newly-discovered plugin, allow it.
4. Confirm both plugins are enabled: **Edit ▸ Plugins**, search "Python" →
   **Python Editor Script Plugin** should already be checked (this
   plugin's `.uplugin` declares it as a dependency — see `UNVERIFIED.md`
   for the one thing unverified about that auto-enabling); search
   "Presence" → **T3 Editor Presence** should be checked. If either was off,
   the editor will ask to restart — restart. If Python was already enabled
   on this project, no restart should be needed for this step.
5. In a terminal, on the machine running your T3 server, run `t3 pair` and
   copy what it prints (a token, or a full pairing URL — either works).
6. Back in the editor: open the **EPP** entry in the level-editor toolbar
   (or **Tools ▸ EPP** if your engine version put it there instead — see
   "Where did the toolbar entry go?" below) and choose **Open token
   folder**. Paste what `t3 pair` printed into `token.txt` in the folder
   that opens, and save.
   (Equivalent, e.g. for a CI machine: set the environment variable
   `T3_EDITOR_PRESENCE_TOKEN` to an **already-redeemed** bearer token
   before launching the editor — see "Two ways to provide a token" below.)
7. Back in the editor's EPP menu, choose **Pair**. This redeems what you
   pasted into `token.txt` for a long-lived session token and overwrites
   `token.txt` with it — from this point on the file holds a bearer token
   directly, not the one-time pairing credential you started with.
8. Choose **Reconnect now**. The indicator goes ◌ connecting → ● connected.
9. Click an actor in the World Outliner, or an asset in the Content
   Browser. A chip appears in the T3 composer.

No compiler. No Visual Studio or Xcode. No engine-version-specific binary.
Works on a project with zero C++ in it.

## Two ways to provide a token

`Saved/EditorPresence/token.txt` is checked first for a **redeemed bearer
session token** (`resolve_token` in `epp/config.py` — env var wins over the
file if both are set, via `T3_EDITOR_PRESENCE_TOKEN`).

- **The normal path (steps 5–7 above):** paste the raw pairing credential
  from `t3 pair` into `token.txt`, then click **EPP ▸ Pair**. The plugin
  POSTs it to your server's `/oauth/token` endpoint (the same
  token-exchange flow the rest of T3 already uses — see `epp/config.py`'s
  module docstring for the three primary sources this was confirmed
  against) and overwrites `token.txt` with the resulting bearer token.
- **The power-user / CI path:** set `T3_EDITOR_PRESENCE_TOKEN` to an
  already-redeemed bearer token yourself. No pairing/redeem step happens
  for this path — the env var is used exactly as given.

`Saved/` is Unreal's conventional gitignore location, which is why the
token lives there and not in `Config/` — **verify that convention holds
for your specific project before relying on it**; a bearer token
committed to a public game repo is not a recoverable mistake.

## Where did the toolbar entry go?

The UE5 level-editor toolbar's internal menu names shifted across the 5.x
line. This plugin tries a short list of candidate toolbar anchors and logs
which one resolved to the Output Log at startup
(`[T3 Editor Presence] status indicator anchored at ...`). If none of the
candidates resolve on your engine version, the same **EPP** entry appears
under **Tools** in the main menu bar instead — a degraded indicator (you
have to open the menu to see it), not a missing one. The Output Log line
on every connection-state change is the backstop either way; if you're not
sure whether anything is connected, check there.

## What "presence" means here

Whatever is selected right now — in the World Outliner or the Content
Browser — appears as a chip in the T3 composer. Deselecting clears the
chip; it is not sticky. This plugin only ever sends the _current_ selection
state, never a history of it — see `docs/workbench/spec-editor-presence.md`
for why ("presence is a level, not an edge").

Level actors and Content Browser assets are both supported. Multi-select
publishes multiple chips, capped at 64 (the same cap the server itself
enforces); selecting more than that publishes the first 64 in a stable
order (actors before assets) and logs a warning rather than silently
dropping the rest without saying so.

## Known limitations (stated, not hidden)

- **Actor identity is a soft path, not a GUID.** An actor's `id` is built
  from `get_path_name()` — durable across an editor restart, but it moves
  if the actor is renamed, duplicated, or regenerated. Content Browser
  asset identity (`package_name.asset_name`) does not have this caveat.
  See `UNVERIFIED.md` for why `AActor::GetActorGuid()` (which would not
  have this caveat) is not used here.
- **Selection is polled, not pushed.** No Python-exposed
  selection-changed delegate was assumed to exist (see `UNVERIFIED.md`);
  the plugin samples the selection on a 5 Hz editor tick and only emits a
  frame when it actually changed. This means up to ~200ms of latency
  between clicking something and the chip appearing, and a small constant
  background cost for the life of the editor session — a deliberate
  design choice (see `docs/workbench/spec-unreal-publisher.md`'s
  "Rationale" section), not an oversight.
- **Two Unreal Editors open on two different projects produce two
  publishers with two different `workspace.root` values.** Which project's
  chips you see is the T3 client's job to filter (matching the active
  thread's working directory), not this plugin's — see
  `docs/workbench/spec-editor-presence.md` step 8 for the specific
  workspace-matching nuance an Unreal `.uproject` living in a subdirectory
  of a larger repo checkout creates.
- **Disabling the plugin at runtime is not a guaranteed clean shutdown.**
  Unreal's Python integration is not reliably unloaded by disabling a
  plugin. If you need to stop the publisher, closing the editor is the
  guaranteed-clean path; the server evicts a stale session on socket
  close or ping timeout either way, so a lingering connection does not
  produce a permanent ghost chip.
- **Multi-select beyond 64 items is silently truncated on the wire** (a
  warning is logged locally, but EPP v1 has no field to tell the server or
  the chat client "there were more than this" — see `UNVERIFIED.md`'s
  cross-reference and `docs/workbench/spec-editor-presence.md`'s
  "Deliberately left out" section).

## What this plugin does NOT do

Same "deliberately left out" list as the protocol itself: no transform,
component list, scene graph, asset bytes, thumbnails, or previews; no
cursor/caret position; no editor→chat command channel (this plugin only
ever sends, never receives anything meaningful back). If your workflow
needs one of these, it's a new EPP frame type or a pull-style agent tool
keyed on the opaque `id`, not something to bolt onto this plugin.

## Development

All logic that does not require a running Unreal Editor lives under
`EditorPresence/Content/Python/epp/` and is covered by
`unreal/tests/` (plain `unittest`, no pytest dependency):

```
cd unreal
python3 -m unittest discover -v
```

This includes a real, over-the-socket integration test
(`tests/test_wire_loopback.py`) against a minimal, independently-implemented
WebSocket test server — the handshake, the `Authorization: Bearer` header,
frame send/receive, and the EPP-specific "accept the upgrade, then reject
with a 4xxx close code" auth pattern are all exercised over a real TCP
socket, not mocked. Everything that DOES require a running editor
(`epp/unreal_bridge.py`, `epp/indicator.py`, and the `init_unreal.py`
entrypoint) is intentionally thin, wraps every individual Unreal API call
in its own narrow `try/except`, and is documented — not tested — in
`UNVERIFIED.md`.

## Deviations from the frozen spec

Handed to the implementer as `spec-unreal-publisher.md` (job scratch dir
referenced in the build brief). Two deliberate deviations, both explained
in-code where they matter most:

1. **No vendored WebSocket library.** The spec called for vendoring
   `websocket-client`, with a hand-rolled RFC 6455 client as an explicitly
   allowed alternative "if you judge [it] cleaner for a one-directional
   publisher." This build takes that option — see `epp/wire.py`'s module
   docstring for the full reasoning (precise close-code control, a smaller
   and fully-auditable surface, and avoiding an entirely separate
   unverified-import-behavior risk on top of everything else in
   `UNVERIFIED.md`). Consequence: step 2's `epp/vendor/websocket/` folder
   and the `sys.path`-insert-if-not-already-importable logic in
   `init_unreal.py` do not exist in this build — there is nothing to
   vendor, so nothing to insert onto the path.
2. **The `.uplugin` schema correction.** The spec's step 2 specifies a
   top-level `"Type": "Editor"` field in `EditorPresence.uplugin`. That is
   not a real top-level `.uplugin` field — `"Type"` exists only inside
   entries of a `"Modules"` array, and this plugin (content-only, by
   design) has no `Modules` array at all. The shipped `.uplugin` omits it.
   See `UNVERIFIED.md`'s final entry for the caveat on this correction.

One thing the spec left as an **open, unresolved dependency** — how a
pairing token issued by `t3 pair` gets redeemed for a usable session
token — is **resolved, not re-guessed**, in this build: see
`epp/config.py`'s module docstring for the three primary sources (read
directly from this repo, including the sibling Unity plugin, which already
implements the identical flow) that pin down the exact `/oauth/token`
request shape.

No other part of the spec was found to be wrong; where
`apps/server/src/editorPresence/protocol.ts` and
`docs/workbench/spec-editor-presence.md`'s JSON examples disagreed (the
`selection` frame's field nesting), protocol.ts was treated as
authoritative per the build brief, and `epp/protocol.py`'s module
docstring documents exactly where and why.
