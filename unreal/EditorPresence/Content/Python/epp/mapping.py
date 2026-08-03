"""
Engine-concept -> EPP item mapping (spec step 3), as pure functions over
primitives already extracted from Unreal.

Every one of those primitives can fail independently on the real engine (a
renamed API, a subsystem unavailable on some 5.x minor) — see
../../../UNVERIFIED.md. The *caller*, unreal_bridge.py, is responsible for
wrapping each individual `unreal.*` call in its own narrow try/except and
passing `None` through for anything it could not read. This module never
talks to `unreal` and never raises for a missing optional input; it only
makes formatting/derivation decisions among the values it was handed, which
is exactly what makes it safe to unit test with plain Python values in
unreal/tests/test_mapping.py.
"""

from typing import Optional

from .model import SelectionItem

GAME_MOUNT_PREFIX = "/Game/"
CONTENT_DIR_PREFIX = "Content/"

KIND_ACTOR = "actor"
KIND_ASSET = "asset"


def map_game_package_path(package_name: Optional[str], *, is_world: bool) -> Optional[str]:
    """`/Game/Maps/Arena` -> `Content/Maps/Arena.umap` (or `.uasset` for a
    non-world asset). Only the `/Game/` mount point is implemented, per the
    spec's explicit ruling: any other mount point (plugin content,
    `/Engine/`) is `null` rather than a guessed path — "a guessed path is
    worse than no path, because `path` is precisely the field an agent will
    act on."
    """
    if not package_name or not package_name.startswith(GAME_MOUNT_PREFIX):
        return None
    relative = package_name[len(GAME_MOUNT_PREFIX) :]
    if not relative:
        return None
    extension = ".umap" if is_world else ".uasset"
    return CONTENT_DIR_PREFIX + relative + extension


def _first_nonblank(*candidates: Optional[str]) -> Optional[str]:
    """First candidate that is non-`None` AND non-blank after stripping.
    `label or fallback_name` alone is not this: a blank-but-non-empty
    string like `"   "` is truthy in Python, so a plain `or` chain would
    stop at it instead of falling through to the next candidate."""
    for candidate in candidates:
        if candidate and candidate.strip():
            return candidate.strip()
    return None


def _build_actor_detail(
    level_display_name: Optional[str],
    folder_path: Optional[str],
    class_name: Optional[str],
    is_blueprint_class: bool,
) -> Optional[str]:
    """`"<LevelName> / <OutlinerFolderPath>"` when the folder API resolved,
    else `"<LevelName> · <ClassName>"`, else just the level name. Appends
    " · Blueprint" for a BlueprintGeneratedClass. Degrades to `None` (never
    raises) if even the level name is unavailable — this is the field the
    spec calls out as living on the most version-shifty API, and it must
    never be able to break a frame.
    """
    if not level_display_name:
        return None
    if folder_path:
        base = f"{level_display_name} / {folder_path}"
    elif class_name:
        base = f"{level_display_name} · {class_name}"
    else:
        base = level_display_name
    if is_blueprint_class:
        base += " · Blueprint"
    return base


def build_actor_item(
    *,
    path_name: Optional[str],
    is_pie: bool,
    label: Optional[str],
    fallback_name: Optional[str],
    level_package_name: Optional[str],
    level_display_name: Optional[str],
    folder_path: Optional[str],
    class_name: Optional[str],
    is_blueprint_class: bool,
) -> SelectionItem:
    """`path_name` is the actor's `get_path_name()` FSoftObjectPath string,
    e.g. `/Game/Maps/Arena.Arena:PersistentLevel.PlayerRoot_C_1` — durable
    across an editor restart but NOT a GUID: it moves under rename,
    duplicate, or regenerate (see ../../../UNVERIFIED.md on
    `AActor::GetActorGuid()` as a possible future upgrade).

    `id` is `None` for a PIE actor even though `path_name` may still resolve
    to *something* — identity, not lifetime, is the PIE hazard: a PIE actor
    is a different instance with a `UEDPIE_`-prefixed package path that
    resolves to nothing after PIE ends, so publishing it would be
    fabricating a durable-looking id for something that is not durable.
    Label and detail are still published during PIE; only the id is
    suppressed.

    `path` is the owning LEVEL's `.umap`, not the actor's own soft path —
    the actor lives *in* the level, it is not itself an asset.
    """
    item_id = None if is_pie else (path_name or None)

    resolved_label = _first_nonblank(label, fallback_name) or "(unnamed actor)"

    path = map_game_package_path(level_package_name, is_world=True)
    detail = _build_actor_detail(level_display_name, folder_path, class_name, is_blueprint_class)

    return SelectionItem(id=item_id, kind=KIND_ACTOR, label=resolved_label, path=path, detail=detail)


def build_asset_item(
    *,
    package_name: Optional[str],
    asset_name: Optional[str],
    asset_class: Optional[str],
    is_world_class: bool,
) -> SelectionItem:
    """`id` = `f"{package_name}.{asset_name}"`, e.g. `/Game/Meshes/Rock.Rock`
    — the strong half of the identity story per the spec: unambiguous,
    survives an editor restart, resolves on another machine given shared
    source control, no caveat needed (unlike the actor path above).

    HARD RULE the caller must uphold: this function receives Asset Registry
    metadata already extracted by unreal_bridge.py, and that extraction must
    never call `asset_data.get_asset()` / `unreal.load_asset()` / anything
    else that loads the asset. The Content Browser fires selection on every
    arrow-key press; a load in that path would make the editor unusable.
    This module has no way to enforce that itself — it only ever sees
    strings — so the rule is documented at both call sites.
    """
    item_id = f"{package_name}.{asset_name}" if package_name and asset_name else None
    resolved_label = _first_nonblank(asset_name) or "(unnamed asset)"
    path = map_game_package_path(package_name, is_world=is_world_class)
    detail = asset_class or None
    return SelectionItem(id=item_id, kind=KIND_ASSET, label=resolved_label, path=path, detail=detail)


def order_items(actor_items, asset_items):
    """Actors first in selection order, then assets — a stable ordering
    rule so the chip row doesn't reshuffle on unrelated frames (spec step
    4)."""
    return list(actor_items) + list(asset_items)
