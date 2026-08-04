# Unity support

Unity is served by Unity's own official package, **`com.unity.pipeline`**, plus
the **Unity CLI**. DevGame ships no Unity C# of its own.

This is the one engine where that is true. Godot
(`godot/addons/editor_presence/`) and Unreal (`unreal/EditorPresence/`) still
use our Editor Presence publishers, because neither engine has an official
equivalent.

## What happened to `com.ironmind.editor-presence`

It was deleted on 2026-08-03. It was an editor-only UPM package of ours that
streamed Unity selection over the Editor Presence Protocol, and had just been
extended to handle Play/Stop.

Unity's official package does the same work and considerably more —
`editor_play` / `editor_stop` / `editor_pause`, `editor_status` (play state,
compilation, and domain-reload state in one read), `get_selection`,
`get_console_logs`, `run_tests`, `capture_game_view`, `capture_scene_view`,
and roughly 130 tools in total.

Three things decided it:

- **It was never installed.** The owner's real Unity project had
  `com.unity.pipeline` in its manifest and no entry of ours.
- **It had never been compiled.** 1,633 lines of C# written on machines
  without Unity. Its own `UNVERIFIED.md` said so plainly, which is the reason
  the gap was noticed rather than shipped.
- **Two packages for one capability is worse than one.** Keeping ours meant a
  user installing our package _and_ Unity's. The official package alone is the
  smaller ask, and it is the one Unity maintains.

Verified before deleting, against a real Unity 6000.3.14f1 Editor: a full
`stopped -> editor_play -> playing -> editor_stop -> stopped` round trip read
back from editor state, and a real 1280x720 Game View capture.

The history is in git if any of it is ever wanted back.

## Known gap

**Unity selection is currently unimplemented.** Deleting our package removed
the Unity selection chips in the composer; Godot and Unreal keep theirs.
`get_selection` is the replacement, but nothing plumbs it yet — and note the
shape differs, because Editor Presence pushes on change while Pipeline is
pulled on demand. Tracked as follow-up work.

## Two things worth knowing about Pipeline

- **It confines writes to the project root.** A `--save_path` outside it is
  refused with a 400, and a path inside it may be rewritten — read `savedPath`
  back from the response rather than assuming where a file landed.
- **`eval` / `eval_file` execute arbitrary C# via Roslyn** and are _not_ bounded
  by `set_authoring_root`. DevGame does not use them.

Both `com.unity.pipeline` and the Unity CLI are pre-1.0 and experimental, and
the surface has already moved once (`eval` was a top-level CLI command in an
earlier release and is now a Pipeline tool). Expect it to shift.
