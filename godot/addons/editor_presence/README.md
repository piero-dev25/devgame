# T3 Editor Presence — Godot addon

Streams your current Godot editor selection to a T3 Code chat composer over
the Editor Presence Protocol (EPP). See
`docs/workbench/spec-editor-presence.md` in the t3code repo for the wire
protocol; this addon is a publisher, one of several (Unity, Godot, Unreal)
speaking the same unmodified protocol to the same unmodified server route
and web chip.

## Install

1. Copy the `addons/editor_presence/` folder into your Godot project's
   `addons/` directory (merge if you already have one). **The folder you
   copy must be named `editor_presence` directly under `addons/`** — if you
   unzip a whole repo download, you'll end up with a nested
   `addons/t3code-main/godot/addons/editor_presence/`, and Godot will not
   detect the plugin at all. Copy the inner `editor_presence/` folder, not
   the outer archive.
2. `Project > Project Settings > Plugins` → tick **Enable** next to "Editor
   Presence". A grey dot appears in the editor toolbar.
   - If the dot never appears, toggle the plugin off and on once more —
     some Godot versions need the enable checkbox flipped twice on a fresh
     install (this is a known Godot editor quirk, not specific to this
     addon).
3. Get a token: on the machine running the T3 server, run `t3 pair` and
   copy the printed token (or the full pairing URL — either works, see
   below).
   - **Do not use the code the server prints automatically at startup** in
     its "Authentication required" banner — that one is for a different
     purpose and will not redeem here. Run `t3 pair` explicitly instead.
4. `Editor > Editor Settings > Workbench > Editor Presence`, paste the
   token into the `Token` field, and adjust `Url` if your T3 server is not
   on the default `ws://127.0.0.1:3777/editor-presence`.
5. The toolbar dot goes amber (connecting) then green (connected). Select
   a node in the Scene dock — the chip appears in the T3 composer.

## What it sends

- **Scene dock selection** — pushed live via `EditorSelection.selection_changed`.
- **FileSystem dock selection** — Godot has no change signal for this dock
  (tracked upstream: godot #26709), so it's polled every 250ms. Toggle it
  off via `Editor Settings > Workbench > Editor Presence > Include
Filesystem Selection` if you find it noisy.
- **Both together, unioned.** Godot's two selections are independent and
  clicking a node does not clear the FileSystem dock's selection (or the
  reverse) — so a file you clicked earlier can keep riding along in the
  chip row after you've moved on in the Scene dock. That stickiness is a
  property of Godot's dock model, not a bug here; turn off the FileSystem
  source above, or pin/unpin individual chips in the T3 composer, if it's
  not what you want.

## Node identity — read this before relying on it

Godot 4 has **no public, scriptable stable per-node identifier**. This
addon builds one anyway (`godot:v1:<scene-uid-or-path>#<node-path>`), and it
is honest about what that survives:

- Editor restart, project reopen, another machine on the same checkout: **survives**.
- Renaming or reparenting the node: **breaks silently** — a future "resolve
  this id" tool will just get a not-found, with no error.

Resource/file identity (`uid://…`) is stronger — it survives moving and
renaming the file, because Godot's own `.uid`/import-sidecar mechanism
tracks it. It only breaks on delete-and-recreate.

## Known limits, stated rather than hidden

- **The token is stored in plaintext** in your editor's settings file
  (`EditorSettings`, editor-global — not committed to your project, but not
  encrypted either). Same exposure as Unity's `EditorPrefs`.
- **One token per editor install, not per project.** If you have this
  addon enabled in two Godot projects at once, both publish under the same
  token to the same server, distinguished only by `workspace.root`. The web
  client is responsible for matching that against the active thread's
  project — if that match is ever wrong, the wrong project's node can land
  in your composer.
- **A capped multi-select (64+ items) is silently truncated.** EPP v1's
  `items[]` is defined as full state with no "this was truncated" flag, so
  a huge selection produces a frame that looks complete and isn't. This is
  a protocol-level gap shared by every publisher, not something this addon
  can fix alone.
- **A bad token and a down server used to look identical.** The presence
  route now accepts the WebSocket upgrade first and rejects with an
  application close code (4401, reason included) rather than an HTTP 401 —
  specifically so this addon can tell you which one happened. See
  `docs/workbench/godot-probe-findings.md` for the measurement that forced
  this design.

## What is proven and what is not

**Proven, headlessly, with a real Godot process** (`godot --headless`):
frame construction (`epp_selection_test.gd`) and the pure transport helpers
— close-code interpretation, backoff timing, session id shape
(`epp_client_test.gd`). Run them yourself:

```
godot --headless --path godot --script addons/editor_presence/tests/epp_selection_test.gd
godot --headless --path godot --script addons/editor_presence/tests/epp_client_test.gd
```

**NOT proven — needs the actual editor open, which this environment cannot
do:**

- Whether `EditorPlugin._process` ticks with no game running and the
  editor window backgrounded. If it turns out not to, `plugin.gd`'s
  `set_process(true)` needs to become a `Timer` child with
  `PROCESS_MODE_ALWAYS` instead — the fallback documented in
  `docs/workbench/spec-godot-publisher.md` step 0(a). Nothing else in the
  design changes either way.
- Whether `EditorSelection.selection_changed` actually fires on a click,
  and what `get_selected_nodes()` contains and in what order.
- Whether `EditorInterface.get_selected_paths()` behaves as documented,
  including the split-view defect reported upstream as godot #88228 (only
  the containing folder is returned instead of the clicked files) — if it
  reproduces on your Godot version, you'll see a folder chip instead of a
  file chip when the FileSystem dock is in split view.
- The toolbar indicator's actual on-screen appearance and click behavior.

If you run this in a real editor and any of the above turns out wrong,
that is exactly the "last inch" this README is naming in advance rather
than papering over.
