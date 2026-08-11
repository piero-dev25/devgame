# Unity support

Unity is served by Unity's own official package, **`com.unity.pipeline`**, plus
the **Unity CLI**. DevGame ships no Unity C# of its own.

This is the one engine where that is true. Godot
(`godot/addons/editor_presence/`) and Unreal (`unreal/EditorPresence/`) still
use our Editor Presence publishers, because neither engine has an official
equivalent.

## What happened to `com.ironmind.editor-presence`

**Corrected 2026-08-04 — the package was deleted, then REBUILT. It is not
gone.** An earlier version of this file said it was deleted outright and
that "Unity selection is currently unimplemented"; that led at least one
research pass to the wrong conclusion. At the time of that correction the
package was v0.2.0; it exists on disk today at
`unity/com.devgame.editor-presence/`, v0.4.0 (renamed from
`com.ironmind.editor-presence` on 2026-08-11 — packaging identity only,
nothing behavioral changed; see `unity/com.devgame.editor-presence/package.json`
for the current authoritative version rather than trusting a number pinned
in this file, which goes stale the moment the package next bumps).

Don't trust a specific commit sha as proof of this — a sha pinned here goes
stale the moment another lane commits, which has already happened twice in
one session. Verify it yourself instead: `git log --oneline -- unity/com.ironmind.editor-presence`
shows a delete commit ("Delete our Unity plugin — Unity is served by
com.unity.pipeline") followed by a rebuild commit later in the same log;
`git merge-base --is-ancestor <that rebuild commit> HEAD` confirms the
rebuild is still live on this branch, whatever its sha happens to be when
you run it.

The original, deleted version streamed Unity selection over the Editor
Presence Protocol, and had just been extended to handle Play/Stop. It was
never installed in the owner's real Unity project (which had
`com.unity.pipeline` in its manifest, no entry of ours), never compiled, and
redundant with what Unity's own official package covers.

Unity's official Pipeline package does that work and considerably more —
`editor_play` / `editor_stop` / `editor_pause`, `editor_status` (play state,
compilation, and domain-reload state in one read), `get_selection`,
`get_console_logs`, `run_tests`, `capture_game_view`, `capture_scene_view`,
and roughly 130 tools in total. Verified before the original deletion,
against a real Unity 6000.3.14f1 Editor: a full
`stopped -> editor_play -> playing -> editor_stop -> stopped` round trip
read back from editor state, and a real 1280x720 Game View capture.

**A LATER commit rebuilt `com.ironmind.editor-presence` — thin,
reporting-only (originally selection-only; 0.3.1 added play-state reporting,
see below).** It carries forward exactly the selection watcher, item
builder, connection/auth transport, and pairing settings from the deleted
package's reviewed code. It does **not** carry forward the command
dispatcher, play-mode controller, or cold-start entry point — those stay
Pipeline's job, same division as the rest of this file describes. Verified
live against a real Unity 6000.3.14f1 Editor on a disposable project: connects,
sends selection (single-select, multi-select, deselect), survives a forced
domain reload with session identity intact, and a real pairing redeem
against a live server. See `unity/editor-presence-UNVERIFIED.md`
for the full verification record and what remains unverified — moved out of
the package directory (2026-08-11, merge-gate R6) so this internal doc (task
numbers, git shas, dated notes) doesn't ship into every project that
installs the package.

**Corrected 2026-08-10 — 0.3.1 added play-state REPORTING, not play-state
CONTROL.** The package now also publishes a live `playState`
("stopped"/"playing"/"paused", computed from `EditorApplication.isPlaying`/
`isPaused`) over the same presence connection: once right after `hello` on
every (re)connect, and again on every change — see
`docs/specs/unity-playstate-presence.md`. This closes the gap where the
DevGame toolbar could only reflect a play state it had itself commanded via
Pipeline's CLI, and went stale the moment the user pressed Play/Stop/Pause
inside the Editor directly instead. It does **not** change the command split
described above: this package still advertises `capabilities: []` and still
cannot be told to do anything — Play/Stop/Pause commands issued FROM DevGame
still go through Pipeline's CLI shell-out, unchanged.

## Known gap

**Unity selection doesn't work in any real project today — not because it's
unimplemented, but because the rebuilt package isn't installed anywhere
real yet.** It exists, compiles, and was verified live (previous section),
but as of this correction it is present in zero of the owner's actual Unity
projects — only ever exercised on a disposable scratch project built for
verification. Installing it (adding the package to a project's manifest,
then pairing it from DevGame's own settings) is what's missing, not code.
Tracked as follow-up work — see `docs/workbench/plan-setup-integration.md`.

## Two things worth knowing about Pipeline

- **It confines writes to the project root.** A `--save_path` outside it is
  refused with a 400, and a path inside it may be rewritten — read `savedPath`
  back from the response rather than assuming where a file landed.
- **`eval` / `eval_file` execute arbitrary C# via Roslyn** and are _not_ bounded
  by `set_authoring_root`. DevGame does not use them.

Both `com.unity.pipeline` and the Unity CLI are pre-1.0 and experimental, and
the surface has already moved once (`eval` was a top-level CLI command in an
earlier release and is now a Pipeline tool). Expect it to shift.
