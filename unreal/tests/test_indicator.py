import unittest

from epp import indicator


class LabelForStateTests(unittest.TestCase):
    def test_each_state_has_a_distinct_glyph(self):
        labels = {
            indicator.label_for_state(indicator.STATE_CONNECTED),
            indicator.label_for_state(indicator.STATE_CONNECTING),
            indicator.label_for_state(indicator.STATE_DISCONNECTED),
        }
        self.assertEqual(len(labels), 3)

    def test_unknown_state_falls_back_to_disconnected_glyph(self):
        self.assertEqual(indicator.label_for_state("bogus"), indicator.label_for_state(indicator.STATE_DISCONNECTED))


class TooltipForTests(unittest.TestCase):
    def test_includes_state_and_endpoint(self):
        tooltip = indicator.tooltip_for(state=indicator.STATE_CONNECTED, endpoint="ws://127.0.0.1:3777/x")
        self.assertIn("connected", tooltip)
        self.assertIn("ws://127.0.0.1:3777/x", tooltip)

    def test_missing_token_is_called_out(self):
        tooltip = indicator.tooltip_for(state=indicator.STATE_DISCONNECTED, endpoint="ws://x", token_present=False)
        self.assertIn("No token found", tooltip)

    def test_present_token_omits_the_warning(self):
        tooltip = indicator.tooltip_for(state=indicator.STATE_DISCONNECTED, endpoint="ws://x", token_present=True)
        self.assertNotIn("No token found", tooltip)

    def test_last_error_included_when_present(self):
        tooltip = indicator.tooltip_for(state=indicator.STATE_DISCONNECTED, endpoint="ws://x", last_error="cannot reach Workbench at ws://x")
        self.assertIn("cannot reach Workbench at ws://x", tooltip)

    def test_last_error_omitted_when_blank(self):
        tooltip = indicator.tooltip_for(state=indicator.STATE_CONNECTED, endpoint="ws://x", last_error="")
        self.assertNotIn("Last error", tooltip)


if __name__ == "__main__":
    unittest.main()
