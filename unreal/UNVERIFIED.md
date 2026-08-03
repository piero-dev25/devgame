# UNVERIFIED — every Unreal Python API name used in this plugin

Unreal Engine is not installed on the machine this plugin was built on
(verified: `/Applications` has no Epic Games / Unreal Editor entry, same
finding the frozen spec made). **Nothing in `EditorPresence/` has been
imported, compiled, or run.** Every `unreal.*` name below is documented
knowledge / recall, not a read of engine headers or the generated `unreal`
Python stub.

This file exists so the plugin is safe to hand to someone who _can_ run it:
every claim here should be checked against a real editor before the plugin
is trusted in a live project, and every failure mode has a stated fallback
so a wrong guess degrades a field or a feature rather than crashing the
editor. The pure-logic layer (`model.py`, `protocol.py`, `mapping.py`,
`sampler.py`, `wire.py`, `config.py`) is fully covered by
`unreal/tests/` and NOT listed below — everything there was actually run,
under `python3 -m unittest discover`, including a real loopback WebSocket
server. What follows is exclusively the surface that only a running editor
can confirm.

Where a claim mirrors one already flagged in
`docs/workbench/spec-unreal-publisher.md`'s own `unverifiable` section,
that is noted — this file adds the specific call site in this codebase for
each one, which the spec (written before any code existed) could not do.

## The single highest-risk item

**`unreal.register_slate_post_tick_callback` / `unreal.unregister_slate_post_tick_callback`**
— `epp/unreal_bridge.py`'s `register_tick` / `unregister_tick`.

Existence, exact name, argument signature (does the callback receive delta
seconds? `publisher.py` passes a `lambda *_args: ...` specifically so any
argument shape is tolerated), and the handle type are all unverified. Most
importantly: **whether this callback fires with no game running, no
viewport focused, and the editor window in the BACKGROUND.** Slate can
throttle when unfocused; if it stalls on alt-tab, the publisher goes silent
exactly when someone has switched to the chat window to use it — the worst
possible failure mode for this feature.

**Fallback if this API doesn't exist under this name:** `register_tick`
returns `None`, and `publisher.start()` logs a warning and continues
running the socket thread (which still connects and sends `hello`) with no
sampling ever happening — a visibly-connected chip that never updates,
rather than a crash. **This is degraded, not adequate** — someone running
this for real needs to confirm this API before relying on the plugin at
all. If it's absent entirely, the spec's fallback (a
`unreal.EditorUtilitySubsystem`-driven ticking object, or a
`threading.Timer` that only enqueues a "please sample" flag consumed on the
game thread) needs its own implementation; it was not attempted here since
step 1 of the frozen spec calls it "materially worse and needs its own
spike."

**Whether it throttles in the background specifically** cannot be degraded
around — if true, this design's core premise (5 Hz polling is enough) is
wrong for the case that matters most, and the fix is a different clock
source, not a smaller change.

## Selection queries

**`unreal.EditorActorSubsystem()` instantiation form** — `epp/unreal_bridge.py:_get_selected_actors`.
Tried as a direct constructor call; `unreal.get_editor_subsystem(unreal.EditorActorSubsystem)`
is the other documented form and was NOT tried as a fallback (a
try/except around the whole query already degrades to an empty actor list
on any failure, which would silently make actor selection appear
unsupported rather than trying the second form — worth revisiting once
someone can observe which form actually resolves).

**`EditorActorSubsystem.get_selected_level_actors()`** — same call site.
Existence under this exact name on every targeted 5.x minor is unverified.

**`unreal.EditorUtilityLibrary.get_selected_asset_data()`** — `epp/unreal_bridge.py:_get_selected_asset_data`.
LOAD-BEARING: this must NOT load the selected asset. If it's absent on the
target engine minor, **`get_selected_assets()` is deliberately NOT used as
a substitute** — that method loads every selected asset synchronously,
which would make the Content Browser unusable on every arrow-key press.
The code here lets the whole query degrade to an empty list instead,
meaning Content Browser selection simply reports as unsupported on that
engine version rather than silently becoming a loader.

**Whether ANY selection-changed delegate is exposed to Python at all** on
any UE5 minor was not investigated — a poll was assumed and designed for,
per the frozen spec's own reasoning (C++-side delegates, no confirmed
Python exposure). If one exists, `unreal_bridge.py`'s `sample_digest()` /
`sample_items()` split can be swapped for an event-driven `SelectionSource`
without touching `sampler.py`, `wire.py`, or the tests — that boundary was
built for exactly this kind of engine-binding swap.

## Per-actor field extraction (`epp/unreal_bridge.py:_build_actor_selection_item`)

Every one of the following is wrapped in its own `_safe(...)` call — a
single field failing degrades that field to `None`/`False`, never aborts
the whole item:

- **`actor.get_path_name()`** returning the
  `/Game/Maps/Arena.Arena:PersistentLevel.PlayerRoot_C_1` FSoftObjectPath
  form. The entire actor `id` design (`epp/mapping.py:build_actor_item`)
  assumes this exact string shape. If the shape differs, `id` is still
  whatever string comes back — not validated against a pattern — so a
  differently-shaped string would still work as an opaque id (the protocol
  treats it as opaque), just not necessarily as a _useful_ one to a human
  reading the `detail`/`path` fields alongside it.
- **`actor.get_actor_label()`** existence as a Python-exposed UFUNCTION —
  unconfirmed. Falls back to `actor.get_name()`, then to the literal
  `"(unnamed actor)"` if both fail — see `mapping._first_nonblank`. If
  `get_actor_label()` is unavailable, every actor chip shows the internal
  name instead of the Outliner label: a visible quality regression, not a
  crash.
- **`AActor::GetActorGuid()`** — NOT used. The spec flags this as
  potentially a strictly-better `id` than the soft path, contingent on
  whether it's reliably populated (non-zero) for hand-placed actors in a
  plain, non-World-Partitioned level. That was never checked, so this
  plugin ships the weaker-but-known path-based id rather than an unverified
  "better" one. Upgrading `id` later is not a protocol change (`id` is
  opaque), so this is a safe thing to defer.
- **`actor.get_world().get_path_name()`**, split on the first `.` to
  recover the level's package name (`epp/unreal_bridge.py:_world_package_name`)
  — the `"<PackageName>.<WorldName>"` shape is assumed; unconfirmed.
- **`actor.get_folder_path()` vs `actor.get_folder().get_path()`** —
  `epp/unreal_bridge.py:_build_actor_selection_item._folder_path` tries the
  first (older / simpler) form and falls back to the second on
  `AttributeError` specifically (not a bare `except Exception`, so a
  different failure in the second form still surfaces as a genuine bug
  rather than silently returning `None` — though the outer `_safe()` wrapper
  ultimately catches it either way). Which form exists on which 5.x minor
  is unverified. Only affects `detail`, which is designed to degrade.
- **`unreal.UnrealEditorSubsystem().get_editor_world()`** and
  **`actor.get_world()`** for PIE detection
  (`epp/unreal_bridge.py:_is_pie_actor`) — existence of the subsystem and
  of `get_editor_world()` under that name is unverified. Falls back to a
  `"UEDPIE_"` substring check on `get_path_name()` output — whether that
  substring actually appears there is ALSO unverified. If both signals fail
  to resolve, the code assumes NOT PIE (fails open on publishing an id,
  rather than silently suppressing every actor id during normal edit mode
  if the PIE-detection machinery itself is broken).
- **`actor.get_class().get_name()`** for `class_name`, and
  **`isinstance(actor.get_class(), unreal.BlueprintGeneratedClass)`** for
  the "· Blueprint" detail suffix — both unverified as Python-accessible in
  this exact form.

## Per-asset field extraction (`epp/unreal_bridge.py:_build_asset_selection_item`)

- **`asset_data.package_name`, `asset_data.asset_name`** — assumed stable
  across 5.0–5.5 per the frozen spec's own claim; not independently
  re-verified here.
- **`asset_data.asset_class_path` (5.1+) vs `asset_data.asset_class` (5.0,
  deprecated 5.1)** — `getattr(asset_data, "asset_class_path", None) or
getattr(asset_data, "asset_class", None)` tries the newer name first.
  Whether this `getattr` pair actually covers both real shapes (as opposed
  to, say, `asset_class_path` existing-but-`None` on some minor, silently
  falling through correctly, or existing-but-differently-typed) is
  unverified.
- **HARD RULE enforced only by code review, not by a runtime guard**: this
  function must never call `asset_data.get_asset()` or
  `unreal.load_asset()`. There is no way to make this fail loudly if a
  future edit violates it — worth a second pair of eyes specifically on
  this function before it ships.

## Paths, identity, engine version (`epp/unreal_bridge.py`)

- **`unreal.SystemLibrary.get_command_line()`** (`is_commandlet_context`) —
  existence unverified. This is the commandlet guard, so absence is
  handled by failing CLOSED: the function returns `True` ("assume
  commandlet, don't start") rather than guessing. Consequence if this API
  turns out not to exist: the plugin never starts in ANY context,
  including a normal editor session, until this is fixed — a loud, visible
  failure (nothing connects, ever) rather than the quiet-but-dangerous
  alternative of a build agent silently opening a socket.
- **`unreal.Paths.project_dir()` / `unreal.Paths.convert_relative_path_to_full()`**
  (`resolve_workspace_root`) — existence, exact names, whether the result
  is already absolute, and whether it has a trailing separator (stripped
  defensively either way) are all unverified. Failure here is also
  fail-closed: `Publisher.start()` refuses to start rather than send a
  `hello` with a guessed or blank `workspace.root` — protocol.ts drops any
  `hello` frame with a blank workspace root anyway, so there is nothing to
  gain from guessing.
- **`unreal.SystemLibrary.get_engine_version()`** (`resolve_engine_version`)
  — existence and output format unverified. Display-string only; falls
  back to a placeholder string. Cosmetic-only failure mode.

## Status indicator (`epp/indicator.py`)

- **`unreal.ToolMenus` toolbar anchor names**
  (`LevelEditor.LevelEditorToolBar.User`,
  `LevelEditor.LevelEditorToolBar`,
  `LevelEditor.LevelEditorToolBar.PlayToolBar`) — the frozen spec calls
  this "the most likely thing to silently degrade across engine versions."
  Tried in order via `menus.find_menu(candidate)`; the first resolved
  anchor is logged at startup so a bug report can say which one fired.
  Falls back to registering a `LevelEditor.MainMenu.Tools` menu entry if
  none resolve — a degraded indicator (you have to open the Tools menu to
  see it) rather than a crash.
- **`unreal.ToolMenuEntry(...)`, `unreal.MultiBlockType.TOOL_BAR_BUTTON` /
  `.MENU_ENTRY`, `entry.set_label()`, `entry.set_tool_tip()`,
  `menu.add_menu_entry()`, `menu.find_entry()`,
  `menus.refresh_all_widgets()`** — the whole `ToolMenus` construction
  sequence is recalled from general Unreal Python API shape, not confirmed
  against a real editor. The entire `_register` / `update` pair is wrapped
  in `try/except Exception`, so any failure here logs a warning (via
  `unreal.log_warning`, itself a call this file assumes exists) and leaves
  the publisher running without a visible indicator — the Output Log line
  logged on every state transition is the stated backstop for exactly this
  case.
- **`unreal.EditorDialog.show_object_details_view`** — the spec's
  "nice-to-have" possible real paste dialog. `indicator.try_show_paste_dialog`
  checks for its existence via `hasattr` but deliberately does NOT attempt
  to build the `@unreal.uclass()` object it would need, and always returns
  `None`. This is not a partial implementation with an unverified gap — it
  is a stub that always falls through to the guaranteed file-based flow,
  documented as a gap in the README rather than shipped as a half-working
  dialog nobody could review without a running editor to look at the
  actual widget it produces.

## Everything else

- **The embedded Python version** (recalled as roughly 3.9–3.11 depending
  on engine version) and **whether `socket`, `ssl`, `struct`, `base64`,
  `hashlib`, `queue`, `threading`, `urllib.request` all import** on the
  trimmed embedded interpreter — unverified. Unlike the vendoring path the
  frozen spec designed around, this plugin has no third-party import to
  fail; if any of these specific stdlib modules is missing from the
  embedded build, that would be surprising (all are extremely
  commonly-depended-on stdlib modules) but has not been confirmed.
- **Whether background threads spawned from the embedded interpreter
  behave normally**, whether the GIL interacts badly with the editor's own
  threads, and whether editor shutdown tears the daemon thread down
  cleanly or hangs — unverified. `epp/publisher.py`'s `stop()` documents
  why a slow-to-exit thread is a latency problem, not a correctness one:
  the server-side ping-timeout/socket-close eviction in
  `EditorPresenceRoute.ts` is the primary guarantee a stale session
  disappears, not a clean client-side shutdown.
- **`unreal.register_python_shutdown_callback`** — not used; not
  implemented, since its existence under that name is unverified and
  `atexit` (also unverified in the embedded interpreter, and also not
  wired up in this v1) was the spec's stated fallback. Editor shutdown
  currently relies entirely on the server-side eviction guarantee above.
- **Whether disabling the plugin at runtime tears anything down.** Per the
  spec: assumed NOT to reliably unload Python. The README states this
  explicitly rather than implying "disable the plugin" is a clean shutdown
  path.
- **Whether a content-only `.uplugin` with no `Modules` array, declaring
  `PythonScriptPlugin` as a dependency, actually auto-enables that
  dependency for the user** — unverified. If it does not, step 4 of the
  README (manually enabling "Python Editor Script Plugin") becomes
  mandatory rather than a check.
- **Whether `init_unreal.py` under a PLUGIN's `Content/Python/` auto-runs
  the same way a PROJECT's own `Content/Python/init_unreal.py` does** — the
  entire drop-in distribution shape rests on this. If it turns out to be
  project-only, installing this plugin needs an additional manual
  `sys.path` step this README does not currently describe.
- **The `.uplugin` schema correction made in this build** (see the README's
  "Deviations from the frozen spec" section): the frozen spec's step 2
  specifies a top-level `"Type": "Editor"` field in `EditorPresence.uplugin`.
  Standard `.uplugin` JSON only has a `"Type"` field _inside_ each entry of
  a `"Modules"` array — there is no top-level `"Type"` key in Epic's
  documented `.uplugin` schema, and this plugin has no `Modules` array at
  all (content-only, by design). The shipped `.uplugin` omits it. This is
  a correction against general, reasonably-confident knowledge of the
  `.uplugin` schema, not a re-guess — but it has not been validated by
  actually loading the plugin in an editor, so it is listed here too.
