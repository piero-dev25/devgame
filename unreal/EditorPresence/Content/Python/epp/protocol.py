"""
Frame construction for the Editor Presence Protocol (EPP) v1, publisher
side.

THE AUTHORITATIVE SOURCE IS apps/server/src/editorPresence/protocol.ts.

CORRECTION (found during the cross-engine contract audit, not during the
original build): an earlier version of this module nested `seq`/`at`/`items`
inside a `selection` object on the wire. That was a real bug, not a
protocol.ts-vs-design-doc disagreement — protocol.ts's `parseSelection`
function receives the RAW TOP-LEVEL parsed JSON (`parseEditorPresenceInboundFrame`
calls `parseSelection(parsed)` where `parsed = JSON.parse(raw)`), and reads
`value.seq` / `value.at` / `value.items` directly off THAT top-level object:

    function parseSelection(value: Record<string, unknown>): ... {
      if (typeof value.seq !== "number" ...) return null;
      ...
      return { type: "selection", selection: { seq: value.seq, at: value.at, items } };
    }

The nested `{ selection: { seq, at, items } }` shape only exists in the
RETURNED, in-memory `EditorPresenceInboundFrame` TypeScript type — that is
how the rest of the server's code (e.g. `EditorPresenceRoute.ts`'s
`registry.updatePublisherSelection(sessionId, connectionToken,
frame.selection)`) conveniently accesses the parsed fields. It is NOT the
wire shape. The wire shape is flat, exactly as
docs/workbench/spec-editor-presence.md's JSON example already showed:

    { "v": 1, "type": "selection", "seq": 42, "at": "...", "items": [...] }

A frame built with the old nested shape would have `value.seq` read as
`undefined` server-side (`typeof undefined !== "number"`), so
`parseSelection` would return `null` and the ENTIRE selection frame would be
silently dropped — every single selection this plugin ever sent would have
vanished, while `hello` and `ping` (which don't have this field) kept working
normally, which is exactly the kind of failure that looks like "it's
connected, nothing's wrong" right up until nothing ever shows up as a chip.
Caught by a fresh re-read of protocol.ts while auditing the Unity
implementation against it, not by any test — see
unreal/tests/test_protocol.py's now-corrected assertions and the divergence
audit report for how this was found.

No `unreal` import. Pure functions, plain data in, JSON text out — exercised
directly by unreal/tests/test_protocol.py with no engine process involved.
"""

import json
from typing import Iterable, Optional, Tuple

from .model import SelectionItem

PROTOCOL_VERSION = 1

# Mirrors EDITOR_PRESENCE_MAX_ITEMS in protocol.ts. The server enforces this
# cap too, but truncating client-side means a 500-actor marquee-select
# truncates predictably at the source (with a status event the sampler can
# act on — see sampler.py) instead of silently relying on the server to drop
# the tail of an oversized frame.
MAX_ITEMS = 64


def _item_to_wire(item: SelectionItem) -> dict:
    # `label` is the only field protocol.ts's parseItem requires to be a
    # non-empty string; an item with a blank label is dropped entirely on
    # the server side. Guarantee a non-empty string here rather than let a
    # mapping bug silently vanish an item off the wire.
    label = item.label if isinstance(item.label, str) and item.label.strip() else "(unnamed)"
    return {
        "id": item.id if item.id else None,
        "kind": item.kind if item.kind else "unknown",
        "label": label,
        "path": item.path if item.path else None,
        "detail": item.detail if item.detail else None,
    }


def build_hello_frame(
    *,
    editor_id: str,
    editor_name: str,
    editor_version: str,
    session_id: str,
    workspace_root: str,
) -> str:
    """Build the `hello` frame. protocol.ts's `parseHello` drops the whole
    frame if any of these five strings is missing or blank, so callers must
    resolve fallbacks *before* calling this — there is no server-side
    leniency to lean on here the way there is for optional item fields."""
    return json.dumps(
        {
            "v": PROTOCOL_VERSION,
            "type": "hello",
            "editor": {"id": editor_id, "name": editor_name, "version": editor_version},
            "session": {"id": session_id},
            "workspace": {"root": workspace_root},
        }
    )


def build_selection_frame(
    *,
    seq: int,
    at: str,
    items: Iterable[SelectionItem],
    max_items: int = MAX_ITEMS,
) -> Tuple[str, bool]:
    """Returns `(frame_json, truncated)`. `truncated` is True when `items`
    held more than `max_items` entries — EPP v1 has no field to say "there
    were more than this," so the caller (sampler.py) is expected to log or
    surface that fact through its own status channel rather than the wire."""
    item_list = list(items)
    truncated = len(item_list) > max_items
    wire_items = [_item_to_wire(i) for i in item_list[:max_items]]
    # FLAT on the wire — see this module's docstring for why this is not
    # nested under a `selection` key despite the TypeScript-side parsed
    # result type looking like it should be.
    frame = json.dumps(
        {
            "v": PROTOCOL_VERSION,
            "type": "selection",
            "seq": seq,
            "at": at,
            "items": wire_items,
        }
    )
    return frame, truncated


def build_ping_frame() -> str:
    return json.dumps({"v": PROTOCOL_VERSION, "type": "ping"})


def is_pong_frame(raw: str) -> bool:
    """The only inbound frame type this publisher ever needs to recognize by
    content (close is a WebSocket-level close frame, handled in wire.py, not
    a JSON text frame)."""
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return False
    return isinstance(parsed, dict) and parsed.get("v") == 1 and parsed.get("type") == "pong"


def frame_type(raw: str) -> Optional[str]:
    """Best-effort peek at a frame's `type` for logging/diagnostics. Returns
    None for anything unparsable — mirrors protocol.ts's own
    drop-rather-than-fail posture for malformed input."""
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if isinstance(parsed, dict) and parsed.get("v") == 1 and isinstance(parsed.get("type"), str):
        return parsed["type"]
    return None
