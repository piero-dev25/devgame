"""
epp/unreal_bridge.py — the ONLY place that reads actor/asset selection
state out of the running Unreal Editor.

Every `unreal.*` name used in this file is UNVERIFIED against a real editor
— see ../../../UNVERIFIED.md, which cross-references each one back to a
specific function here. Unreal Engine is not installed on the machine this
was written on (verified: no Epic Games / Unreal Editor entry in
/Applications), so nothing below has been imported, let alone run.

Because of that, EVERY individual `unreal.*` call in the selection path is
wrapped in its OWN narrow try/except that degrades to `None` for that one
field, per the build brief's hard requirement. A renamed method on a future
engine minor should cost this plugin one blank chip field, never a crash
inside a tick callback (that would be exactly the failure mode the spec
calls out as the worst one — a tick callback exception can wedge or spam
the editor).

This module also owns tick registration, the commandlet guard, and
path/version resolution — everything that has to run on the game thread and
touch `unreal`, so that epp/wire.py can stay free of it entirely (see that
module's absolute rule).
"""

import datetime
import uuid
from typing import List, Optional, Tuple

from . import mapping
from .model import SelectionItem
from .sampler import SelectionSource

try:
    import unreal  # noqa: F401 - only import target in this module besides indicator.py
except ImportError:  # pragma: no cover - exercised only inside the editor
    unreal = None  # type: ignore[assignment]


def _safe(fn, default=None):
    """Call a zero-arg callable, returning `default` on ANY exception. Used
    for every individual `unreal.*` field read below so one bad accessor
    degrades one field instead of aborting the whole selection sample."""
    try:
        return fn()
    except Exception:
        return default


# ---------------------------------------------------------------------------
# Commandlet guard (spec step 2, point 1)
# ---------------------------------------------------------------------------


def is_commandlet_context() -> bool:
    """Cook and build commandlets execute `init_unreal.py` too — a build
    agent opening a WebSocket to a developer's laptop is a real bug, not a
    hypothetical. UNVERIFIED: `unreal.SystemLibrary.get_command_line()`'s
    existence and exact name (see UNVERIFIED.md). If it is absent, this
    function fails CLOSED (returns True, i.e. "assume commandlet, don't
    start") rather than open — a publisher that silently never starts in a
    normal editor session is a much smaller problem than one that connects
    from a CI build agent."""
    if unreal is None:
        return True
    command_line = _safe(lambda: unreal.SystemLibrary.get_command_line(), default=None)
    if command_line is None:
        # Could not determine the command line at all — refuse to start
        # rather than guess. See docstring above.
        return True
    lowered = command_line.lower()
    return any(flag in lowered for flag in ("-run=", "-unattended", "-buildmachine"))


# ---------------------------------------------------------------------------
# Singleton guard (spec step 2, point 2)
# ---------------------------------------------------------------------------

_SENTINEL_ATTR = "_t3_editor_presence"


def get_running_publisher():
    """Module-level Python globals do NOT survive a Python module reload
    (re-running init_unreal.py by hand, or toggling the plugin); the
    `unreal` module OBJECT does. Stashing the running publisher on it is
    what makes a second init a no-op instead of a second socket."""
    if unreal is None:
        return None
    return getattr(unreal, _SENTINEL_ATTR, None)


def set_running_publisher(publisher) -> None:
    if unreal is None:
        return
    setattr(unreal, _SENTINEL_ATTR, publisher)


def get_or_create_session_id() -> str:
    """`session.id` must be stable per editor-process launch and survive a
    Python module reload — stashed on the same `unreal` module sentinel
    object as the singleton guard, for the same reason."""
    if unreal is None:
        return str(uuid.uuid4())
    existing = getattr(unreal, "_t3_editor_presence_session_id", None)
    if existing:
        return existing
    new_id = str(uuid.uuid4())
    setattr(unreal, "_t3_editor_presence_session_id", new_id)
    return new_id


# ---------------------------------------------------------------------------
# Tick registration (spec step 4 / UNVERIFIED.md's single highest-risk item)
# ---------------------------------------------------------------------------


def register_tick(callback):
    """UNVERIFIED: `unreal.register_slate_post_tick_callback` — existence,
    exact name, argument signature (does the callback receive delta
    seconds?), the handle type, and critically whether it fires with no
    game running, no viewport focused, and the editor window in the
    BACKGROUND (Slate can throttle when unfocused; if it stalls on alt-tab
    the publisher goes silent exactly when it's needed). None of this is
    verified — see UNVERIFIED.md. `callback` is called with whatever
    arguments the real API passes; `Sampler.tick()` takes none, so the
    caller (publisher.py) wraps it in a lambda that discards them.

    Returns an opaque handle for `unregister_tick`, or `None` if
    registration failed — the caller must treat `None` as "no sampling is
    happening" and surface that rather than silently doing nothing forever.
    """
    if unreal is None:
        return None
    try:
        return unreal.register_slate_post_tick_callback(callback)
    except Exception:
        return None


def unregister_tick(handle) -> None:
    if unreal is None or handle is None:
        return
    try:
        unreal.unregister_slate_post_tick_callback(handle)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Paths / identity (spec step 3's `hello` frame fields)
# ---------------------------------------------------------------------------


def resolve_workspace_root() -> Optional[str]:
    """UNVERIFIED: `unreal.Paths.project_dir()` /
    `convert_relative_path_to_full()` — existence, exact names, whether the
    result is already absolute, whether it has a trailing separator (this
    function strips one if present). Returns `None` on total failure; the
    caller must not send `hello` without a workspace root — protocol.ts
    drops the whole frame for a blank one, so there is nothing to gain by
    sending a guess."""
    if unreal is None:
        return None

    def _resolve():
        relative = unreal.Paths.project_dir()
        full = unreal.Paths.convert_relative_path_to_full(relative)
        return full.rstrip("/\\")

    return _safe(_resolve, default=None)


def resolve_engine_version() -> str:
    """UNVERIFIED: `unreal.SystemLibrary.get_engine_version()` — existence
    and output format. Display-string only; a placeholder is a fine
    fallback since nothing parses this field."""
    if unreal is None:
        return "Unreal Editor"
    version = _safe(lambda: unreal.SystemLibrary.get_engine_version(), default=None)
    return version or "Unreal Editor (version unavailable)"


EDITOR_ID = "unreal"
EDITOR_NAME = "Unreal Editor"


# ---------------------------------------------------------------------------
# PIE detection (spec step 7)
# ---------------------------------------------------------------------------

_PIE_PACKAGE_MARKER = "UEDPIE_"


def _is_pie_actor(actor) -> bool:
    """Two independent signals, either one sufficient: (1) the actor's
    owning world matches `UnrealEditorSubsystem.get_editor_world()` — if it
    does NOT and get_editor_world() resolved successfully, the actor is
    presumed to be in some other (very likely PIE) world; (2) a `UEDPIE_`
    prefix appears anywhere in the actor's own path name, which is the
    documented PIE package-renaming convention. Both accessors are
    UNVERIFIED (existence of `UnrealEditorSubsystem`, of
    `get_editor_world()`, and of the `UEDPIE_` substring actually appearing
    in `get_path_name()` output) — see UNVERIFIED.md. Failure of BOTH
    signals means "assume NOT PIE" (fail open on suppression, i.e. prefer
    publishing an id that might be wrong over silently never publishing
    actor ids at all)."""

    def _by_subsystem():
        editor_world = unreal.UnrealEditorSubsystem().get_editor_world()
        actor_world = actor.get_world()
        if editor_world is None or actor_world is None:
            return None
        return actor_world != editor_world

    by_subsystem = _safe(_by_subsystem, default=None)
    if by_subsystem is not None:
        return by_subsystem

    path_name = _safe(lambda: actor.get_path_name(), default="") or ""
    return _PIE_PACKAGE_MARKER in path_name


# ---------------------------------------------------------------------------
# Per-actor / per-asset extraction (spec step 3), each field independently
# guarded, handing off to mapping.py for the pure derivation logic.
# ---------------------------------------------------------------------------


def _actor_digest_key(actor) -> Tuple[str, Optional[str]]:
    path_name = _safe(lambda: actor.get_path_name(), default=None)
    return ("actor", path_name)


def _asset_digest_key(asset_data) -> Tuple[str, Optional[str]]:
    package_name = _safe(lambda: str(asset_data.package_name), default=None)
    asset_name = _safe(lambda: str(asset_data.asset_name), default=None)
    combined = f"{package_name}.{asset_name}" if package_name and asset_name else None
    return ("asset", combined)


def _build_actor_selection_item(actor) -> SelectionItem:
    path_name = _safe(lambda: actor.get_path_name(), default=None)
    is_pie = _safe(lambda: _is_pie_actor(actor), default=False)

    label = _safe(lambda: actor.get_actor_label(), default=None)
    fallback_name = _safe(lambda: actor.get_name(), default=None)

    def _world_package_name():
        world = actor.get_world()
        world_path = world.get_path_name()
        # A world's own path name is "<PackageName>.<WorldName>", e.g.
        # "/Game/Maps/Arena.Arena" — the package portion (before the first
        # '.') is what map_game_package_path expects.
        return world_path.split(".", 1)[0]

    level_package_name = _safe(_world_package_name, default=None)
    level_display_name = _safe(lambda: actor.get_world().get_name(), default=None)

    def _folder_path():
        # UNVERIFIED which of these two forms exists on the target engine
        # minor (get_folder_path returning an FName vs a get_folder/FFolder
        # shape) — try the older, simpler form first.
        try:
            return str(actor.get_folder_path())
        except AttributeError:
            return str(actor.get_folder().get_path())

    folder_path = _safe(_folder_path, default=None)
    if folder_path == "None":  # a bare FName("None") stringifies to this
        folder_path = None

    class_name = _safe(lambda: actor.get_class().get_name(), default=None)
    is_blueprint = _safe(
        lambda: unreal.BlueprintGeneratedClass is not None
        and isinstance(actor.get_class(), unreal.BlueprintGeneratedClass),
        default=False,
    )

    return mapping.build_actor_item(
        path_name=path_name,
        is_pie=is_pie,
        label=label,
        fallback_name=fallback_name,
        level_package_name=level_package_name,
        level_display_name=level_display_name,
        folder_path=folder_path,
        class_name=class_name,
        is_blueprint_class=is_blueprint,
    )


def _build_asset_selection_item(asset_data) -> SelectionItem:
    # HARD RULE (mapping.py's docstring repeats this): never call
    # `asset_data.get_asset()` / `unreal.load_asset()` here. Everything read
    # below is Asset Registry metadata, not a loaded UObject property.
    package_name = _safe(lambda: str(asset_data.package_name), default=None)
    asset_name = _safe(lambda: str(asset_data.asset_name), default=None)

    def _asset_class():
        # UNVERIFIED: `asset_class_path` (5.1+) vs `asset_class` (5.0,
        # deprecated at 5.1) — one code path covers both by trying the
        # newer name first.
        value = getattr(asset_data, "asset_class_path", None) or getattr(asset_data, "asset_class", None)
        return str(value) if value is not None else None

    asset_class = _safe(_asset_class, default=None)
    is_world = bool(asset_class) and asset_class.rsplit(".", 1)[-1] == "World"

    return mapping.build_asset_item(
        package_name=package_name,
        asset_name=asset_name,
        asset_class=asset_class,
        is_world_class=is_world,
    )


# ---------------------------------------------------------------------------
# The real SelectionSource
# ---------------------------------------------------------------------------


class UnrealSelectionSource(SelectionSource):
    """Never caches UObject references across calls — every sample re-queries
    from scratch (spec step 4), which is what makes level change,
    undo/redo, actor deletion, and PIE transitions need no special handling
    here at all: the next sample just reports reality. A cached actor whose
    object was destroyed by a map change or an undo would be a stale
    handle, and touching it is at best an exception inside a tick callback.
    """

    def _get_selected_actors(self) -> list:
        def _query():
            # UNVERIFIED: instantiation form
            # (`unreal.EditorActorSubsystem()` vs
            # `unreal.get_editor_subsystem(unreal.EditorActorSubsystem)`) and
            # whether `get_selected_level_actors()` exists under that name
            # on every targeted minor.
            subsystem = unreal.EditorActorSubsystem()
            return list(subsystem.get_selected_level_actors())

        return _safe(_query, default=[]) or []

    def _get_selected_asset_data(self) -> list:
        def _query():
            # UNVERIFIED and load-bearing: `get_selected_asset_data()` must
            # NOT load the asset. If it is absent on the target engine
            # minor, `get_selected_assets()` is explicitly NOT a
            # substitute (it loads every selected asset synchronously) —
            # content-browser support is simply dropped in that case by
            # letting this raise/degrade to [] rather than falling back to
            # the loading API.
            return list(unreal.EditorUtilityLibrary.get_selected_asset_data())

        return _safe(_query, default=[]) or []

    def sample_digest(self) -> tuple:
        actors = self._get_selected_actors()
        assets = self._get_selected_asset_data()
        actor_keys = [_safe(lambda a=a: _actor_digest_key(a), default=("actor", None)) for a in actors]
        asset_keys = [_safe(lambda ad=ad: _asset_digest_key(ad), default=("asset", None)) for ad in assets]
        return tuple(actor_keys + asset_keys)

    def sample_items(self) -> List[SelectionItem]:
        actors = self._get_selected_actors()
        assets = self._get_selected_asset_data()
        actor_items = [_safe(lambda a=a: _build_actor_selection_item(a), default=None) for a in actors]
        asset_items = [_safe(lambda ad=ad: _build_asset_selection_item(ad), default=None) for ad in assets]
        actor_items = [i for i in actor_items if i is not None]
        asset_items = [i for i in asset_items if i is not None]
        return mapping.order_items(actor_items, asset_items)


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
