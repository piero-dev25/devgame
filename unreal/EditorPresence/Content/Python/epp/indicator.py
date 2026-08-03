"""
epp/indicator.py — the required status indicator (spec step 6) and the
first-run token/pairing UX.

Imports `unreal` (ToolMenus, an attempted dialog, log) and `subprocess` (to
open the token folder in a file browser). The pure label/tooltip formatting
is split into module-level functions with no `unreal` dependency so
unreal/tests/test_indicator.py can check what gets displayed for each
connection state without a running editor; only the actual menu
registration and the pairing/folder actions are untestable here, and they
are kept short and mechanical on purpose.

Every `unreal.*` name below is UNVERIFIED — see ../../../UNVERIFIED.md,
which is explicit that the ToolMenus toolbar anchor is "the most likely
thing to silently degrade across engine versions." The ordered-candidate +
menu fallback below, and logging which anchor resolved, are both direct
responses to that entry.
"""

import subprocess
import sys
from typing import Callable, List, Optional

from . import config

try:
    import unreal
except ImportError:  # pragma: no cover - exercised only inside the editor
    unreal = None  # type: ignore[assignment]


STATE_DISCONNECTED = "disconnected"
STATE_CONNECTING = "connecting"
STATE_CONNECTED = "connected"

_GLYPH = {
    STATE_CONNECTED: "●",  # ●
    STATE_CONNECTING: "◌",  # ◌
    STATE_DISCONNECTED: "○",  # ○
}

# UNVERIFIED: the UE5 level-editor toolbar menu names shifted across the
# 5.x line. Tried in order; the first that `find_menu` resolves to a
# non-None value wins. If none resolve, `register_status_entry` falls back
# to a plain "Tools" menu item (a degraded indicator — you have to open the
# menu to see it — but not a startup crash).
_TOOLBAR_ANCHOR_CANDIDATES = (
    "LevelEditor.LevelEditorToolBar.User",
    "LevelEditor.LevelEditorToolBar",
    "LevelEditor.LevelEditorToolBar.PlayToolBar",
)

_ENTRY_NAME = "T3EditorPresenceStatus"
_MENU_OWNER = "T3EditorPresence"


def label_for_state(state: str) -> str:
    return f"EPP {_GLYPH.get(state, _GLYPH[STATE_DISCONNECTED])}"


def tooltip_for(*, state: str, endpoint: str, last_error: str = "", token_present: bool = True) -> str:
    lines = [f"T3 Editor Presence: {state}", f"Endpoint: {endpoint}"]
    if not token_present:
        lines.append("No token found — see Saved/EditorPresence/token.txt")
    if last_error:
        lines.append(f"Last error: {last_error}")
    return "\n".join(lines)


class StatusIndicator:
    """Owns the ToolMenus entry (or its Tools-menu fallback). Constructed
    once by publisher.py; `update(state, endpoint, last_error,
    token_present)` is called from the tick callback only (game thread),
    same as everything else that touches `unreal` outside wire.py."""

    def __init__(self, *, on_reconnect: Callable[[], None], on_pair: Callable[[], None], on_open_token_folder: Callable[[], None]):
        self._on_reconnect = on_reconnect
        self._on_pair = on_pair
        self._on_open_token_folder = on_open_token_folder
        self._resolved_anchor: Optional[str] = None
        self._registered = False
        self._last_state = STATE_DISCONNECTED
        self._last_endpoint = ""
        self._last_error = ""
        self._last_token_present = True

    def _resolve_anchor(self) -> Optional[str]:
        if unreal is None:
            return None
        menus = unreal.ToolMenus.get()
        for candidate in _TOOLBAR_ANCHOR_CANDIDATES:
            try:
                found = menus.find_menu(candidate)
            except Exception:
                found = None
            if found is not None:
                return candidate
        return None

    def _register(self) -> None:
        if unreal is None or self._registered:
            return
        try:
            menus = unreal.ToolMenus.get()
            anchor = self._resolve_anchor()
            self._resolved_anchor = anchor
            target_menu_name = anchor or "LevelEditor.MainMenu.Tools"
            menu = menus.find_menu(target_menu_name) or menus.register_menu(target_menu_name)
            entry = unreal.ToolMenuEntry(
                name=_ENTRY_NAME,
                type=unreal.MultiBlockType.TOOL_BAR_BUTTON if anchor else unreal.MultiBlockType.MENU_ENTRY,
            )
            entry.set_label(label_for_state(self._last_state))
            entry.set_tool_tip(tooltip_for(state=self._last_state, endpoint=self._last_endpoint))
            menu.add_menu_entry(_MENU_OWNER, entry)
            self._registered = True
            unreal.log(
                f"[T3 Editor Presence] status indicator anchored at "
                f"{'toolbar: ' + anchor if anchor else 'Tools menu fallback (no toolbar anchor resolved)'}"
            )
        except Exception as e:  # noqa: BLE001 - indicator failure must never break the publisher
            if unreal is not None:
                try:
                    unreal.log_warning(f"[T3 Editor Presence] could not register status indicator: {e}")
                except Exception:
                    pass

    def update(self, *, state: str, endpoint: str, last_error: str = "", token_present: bool = True) -> None:
        if unreal is None:
            return
        changed = (
            state != self._last_state
            or endpoint != self._last_endpoint
            or last_error != self._last_error
            or token_present != self._last_token_present
        )
        self._last_state = state
        self._last_endpoint = endpoint
        self._last_error = last_error
        self._last_token_present = token_present
        if not changed:
            return

        # Always log the transition to the Output Log — the backstop the
        # spec calls for in case the toolbar rendering doesn't behave the
        # way this was designed without being able to see it.
        try:
            unreal.log(f"[T3 Editor Presence] {state}" + (f" — {last_error}" if last_error else ""))
        except Exception:
            pass

        if not self._registered:
            self._register()
        if not self._registered:
            return
        try:
            menus = unreal.ToolMenus.get()
            target_menu_name = self._resolved_anchor or "LevelEditor.MainMenu.Tools"
            menu = menus.find_menu(target_menu_name)
            if menu is None:
                return
            entry = menu.find_entry(_ENTRY_NAME) if hasattr(menu, "find_entry") else None
            if entry is not None:
                entry.set_label(label_for_state(state))
                entry.set_tool_tip(
                    tooltip_for(state=state, endpoint=endpoint, last_error=last_error, token_present=token_present)
                )
            # A blunt instrument, but state transitions are rare (connect,
            # drop, reconnect) so the cost is acceptable here in a way it
            # would not be for a per-selection update.
            menus.refresh_all_widgets()
        except Exception as e:  # noqa: BLE001
            try:
                unreal.log_warning(f"[T3 Editor Presence] could not update status indicator: {e}")
            except Exception:
                pass


def open_token_folder(project_dir: str) -> None:
    """`subprocess` to the platform's file browser. Best-effort; a failure
    here should never be fatal to the publisher, only logged."""
    import os

    folder = os.path.dirname(config.default_token_file_path(project_dir))
    try:
        os.makedirs(folder, exist_ok=True)
        if sys.platform == "darwin":
            subprocess.Popen(["open", folder])
        elif sys.platform.startswith("win"):
            subprocess.Popen(["explorer", folder])
        else:
            subprocess.Popen(["xdg-open", folder])
    except Exception as e:  # noqa: BLE001
        if unreal is not None:
            try:
                unreal.log_warning(f"[T3 Editor Presence] could not open {folder}: {e}")
            except Exception:
                pass


def try_show_paste_dialog() -> Optional[str]:
    """UNVERIFIED, nice-to-have only (see UNVERIFIED.md):
    `unreal.EditorDialog.show_object_details_view` on a Python-declared
    `@unreal.uclass()` object with a string property MIGHT give a real
    paste box. Returns the pasted string, or `None` if the API is
    unavailable or the attempt fails for any reason — callers must treat
    `None` as "fall back to the token-folder + file flow," never as an
    error to surface, since this path is not expected to work on most
    engine versions and that is fine: the file flow is the guaranteed
    path."""
    if unreal is None:
        return None
    try:
        if not hasattr(unreal, "EditorDialog") or not hasattr(unreal.EditorDialog, "show_object_details_view"):
            return None
        # Deliberately not implemented further: without a running editor to
        # observe the actual widget this produces for a plain string
        # property, guessing at the property-declaration shape here would
        # be exactly the kind of unverified code the brief asked us not to
        # paper over. Left as a documented gap — see README's "Pairing"
        # section — rather than a half-working dialog nobody can review.
        return None
    except Exception:
        return None
