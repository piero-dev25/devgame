import json
import unittest

from epp import protocol
from epp.model import SelectionItem


class BuildHelloFrameTests(unittest.TestCase):
    def test_matches_protocol_ts_shape_exactly(self):
        raw = protocol.build_hello_frame(
            editor_id="unreal",
            editor_name="Unreal Editor",
            editor_version="5.4.4-33043543+++UE5+Release-5.4",
            session_id="session-123",
            workspace_root="/Users/piero/Projects/Deepmind",
        )
        parsed = json.loads(raw)
        self.assertEqual(
            parsed,
            {
                "v": 1,
                "type": "hello",
                "editor": {
                    "id": "unreal",
                    "name": "Unreal Editor",
                    "version": "5.4.4-33043543+++UE5+Release-5.4",
                },
                "session": {"id": "session-123"},
                "workspace": {"root": "/Users/piero/Projects/Deepmind"},
            },
        )


class BuildSelectionFrameTests(unittest.TestCase):
    def test_nests_seq_at_items_under_selection_key(self):
        # This is the one place the design doc (spec-editor-presence.md)
        # and the authoritative protocol.ts disagree — protocol.ts nests
        # seq/at/items inside a `selection` object; the design doc's JSON
        # example does not. protocol.ts wins; this test pins that down.
        item = SelectionItem(id="id-1", kind="actor", label="PlayerRoot", path="Content/Maps/Arena.umap", detail="Arena")
        raw, truncated = protocol.build_selection_frame(seq=42, at="2026-08-03T11:04:07.221Z", items=[item])
        parsed = json.loads(raw)
        self.assertFalse(truncated)
        self.assertEqual(parsed["v"], 1)
        self.assertEqual(parsed["type"], "selection")
        self.assertIn("selection", parsed)
        self.assertNotIn("seq", parsed)  # must NOT be top-level
        self.assertNotIn("items", parsed)  # must NOT be top-level
        self.assertEqual(parsed["selection"]["seq"], 42)
        self.assertEqual(parsed["selection"]["at"], "2026-08-03T11:04:07.221Z")
        self.assertEqual(
            parsed["selection"]["items"],
            [
                {
                    "id": "id-1",
                    "kind": "actor",
                    "label": "PlayerRoot",
                    "path": "Content/Maps/Arena.umap",
                    "detail": "Arena",
                }
            ],
        )

    def test_empty_selection_is_items_empty_list_not_absence(self):
        raw, truncated = protocol.build_selection_frame(seq=1, at="2026-01-01T00:00:00Z", items=[])
        parsed = json.loads(raw)
        self.assertEqual(parsed["selection"]["items"], [])
        self.assertFalse(truncated)

    def test_none_fields_become_json_null(self):
        item = SelectionItem(id=None, kind="actor", label="X", path=None, detail=None)
        raw, _truncated = protocol.build_selection_frame(seq=1, at="t", items=[item])
        wire_item = json.loads(raw)["selection"]["items"][0]
        self.assertIsNone(wire_item["id"])
        self.assertIsNone(wire_item["path"])
        self.assertIsNone(wire_item["detail"])
        self.assertEqual(wire_item["kind"], "actor")

    def test_blank_label_is_never_sent_blank(self):
        # protocol.ts's parseItem drops any item whose label is missing or
        # blank; guaranteeing a non-empty label here is what keeps a
        # mapping bug from silently vanishing an item off the wire.
        item = SelectionItem(id="x", kind="actor", label="   ", path=None, detail=None)
        raw, _truncated = protocol.build_selection_frame(seq=1, at="t", items=[item])
        wire_item = json.loads(raw)["selection"]["items"][0]
        self.assertTrue(wire_item["label"].strip())

    def test_truncates_at_max_items_and_reports_it(self):
        items = [SelectionItem(id=str(i), kind="actor", label=f"A{i}", path=None, detail=None) for i in range(100)]
        raw, truncated = protocol.build_selection_frame(seq=1, at="t", items=items, max_items=64)
        parsed = json.loads(raw)
        self.assertTrue(truncated)
        self.assertEqual(len(parsed["selection"]["items"]), 64)
        self.assertEqual(parsed["selection"]["items"][0]["id"], "0")
        self.assertEqual(parsed["selection"]["items"][-1]["id"], "63")

    def test_default_max_items_matches_protocol_ts_constant(self):
        self.assertEqual(protocol.MAX_ITEMS, 64)


class PingPongTests(unittest.TestCase):
    def test_build_ping_frame(self):
        parsed = json.loads(protocol.build_ping_frame())
        self.assertEqual(parsed, {"v": 1, "type": "ping"})

    def test_is_pong_frame_recognizes_server_pong(self):
        self.assertTrue(protocol.is_pong_frame(json.dumps({"v": 1, "type": "pong"})))

    def test_is_pong_frame_rejects_other_types(self):
        self.assertFalse(protocol.is_pong_frame(json.dumps({"v": 1, "type": "presence", "editors": []})))
        self.assertFalse(protocol.is_pong_frame("not json"))
        self.assertFalse(protocol.is_pong_frame(json.dumps(["not", "an", "object"])))

    def test_frame_type_peek(self):
        self.assertEqual(protocol.frame_type(json.dumps({"v": 1, "type": "pong"})), "pong")
        self.assertIsNone(protocol.frame_type("garbage"))
        self.assertIsNone(protocol.frame_type(json.dumps({"type": "pong"})))  # missing v


if __name__ == "__main__":
    unittest.main()
