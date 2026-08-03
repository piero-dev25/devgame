"""
Plain data shapes shared by mapping, sampler, protocol and wire. No `unreal`
import anywhere in this file — see epp/__init__.py for why that matters.
"""

from typing import NamedTuple, Optional


class SelectionItem(NamedTuple):
    """Mirrors one entry of `selection.items[]` in
    apps/server/src/editorPresence/protocol.ts's `EditorPresenceItem`
    exactly. `label` is the only field the server's `parseItem` requires to
    be a non-empty string; `id`, `path` and `detail` may be `None` (rendered
    as JSON `null`), and a missing/empty `kind` is defaulted to `"unknown"`
    server-side — though this plugin always supplies a concrete `kind`
    ("actor" or "asset"), so that fallback should never actually fire for
    us; it exists for other, future EPP publishers.
    """

    id: Optional[str]
    kind: str
    label: str
    path: Optional[str]
    detail: Optional[str]
