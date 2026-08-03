import json
import unittest

from epp.sampler import Sampler

from .fakes import FakeClock, FakeSelectionSource, make_item


class SamplerTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.source = FakeSelectionSource()
        self.frames = []
        self.statuses = []

    def _make_sampler(self, **kwargs):
        return Sampler(
            selection_source=self.source,
            on_frame=self.frames.append,
            on_status=lambda event, **fields: self.statuses.append((event, fields)),
            clock=self.clock,
            now_iso=lambda: "2026-08-03T00:00:00Z",
            **kwargs,
        )

    def test_first_tick_emits_even_with_empty_selection(self):
        sampler = self._make_sampler()
        emitted = sampler.tick()
        self.assertTrue(emitted)
        self.assertEqual(len(self.frames), 1)
        parsed = json.loads(self.frames[0])
        self.assertEqual(parsed["selection"]["items"], [])
        self.assertEqual(parsed["selection"]["seq"], 1)

    def test_no_emit_when_selection_unchanged(self):
        self.source.items = [make_item(id="a1", label="A")]
        sampler = self._make_sampler()
        sampler.tick()
        self.clock.advance(1.0)
        emitted_again = sampler.tick()
        self.assertFalse(emitted_again)
        self.assertEqual(len(self.frames), 1)

    def test_emits_again_on_selection_change(self):
        self.source.items = [make_item(id="a1", label="A")]
        sampler = self._make_sampler()
        sampler.tick()
        self.clock.advance(1.0)
        self.source.items = [make_item(id="a2", label="B")]
        emitted = sampler.tick()
        self.assertTrue(emitted)
        self.assertEqual(len(self.frames), 2)

    def test_rate_limited_within_interval(self):
        sampler = self._make_sampler(interval_s=0.2)
        sampler.tick()  # first tick always samples
        self.source.items = [make_item(id="a1", label="A")]
        self.clock.advance(0.05)  # inside the 200ms window
        emitted = sampler.tick()
        self.assertFalse(emitted)
        self.assertEqual(sampler.current_frame(), self.frames[0])  # unchanged

    def test_samples_again_once_interval_elapses(self):
        sampler = self._make_sampler(interval_s=0.2)
        sampler.tick()
        self.source.items = [make_item(id="a1", label="A")]
        self.clock.advance(0.25)
        emitted = sampler.tick()
        self.assertTrue(emitted)

    def test_marquee_select_coalesced_into_few_frames(self):
        # Simulates dragging a marquee across many actors while the clock
        # only advances a small amount per intermediate state — the sampler
        # should not emit once per intermediate selection. 30 steps of 5ms
        # each totals 150ms of simulated drag time, staying under the 200ms
        # rate-limit window for the whole drag.
        sampler = self._make_sampler(interval_s=0.2)
        sampler.tick()  # initial empty-selection frame
        for i in range(30):
            self.source.items = [make_item(id=f"a{j}", label=f"A{j}") for j in range(i + 1)]
            self.clock.advance(0.005)
            sampler.tick()
        self.assertEqual(len(self.frames), 1)  # still just the initial one

        self.clock.advance(0.2)
        self.source.items = [make_item(id="final", label="Final")]
        sampler.tick()
        self.assertEqual(len(self.frames), 2)

    def test_deselect_to_nothing_emits_items_empty_list(self):
        self.source.items = [make_item(id="a1", label="A")]
        sampler = self._make_sampler()
        sampler.tick()
        self.clock.advance(1.0)
        self.source.items = []
        emitted = sampler.tick()
        self.assertTrue(emitted)
        parsed = json.loads(self.frames[-1])
        self.assertEqual(parsed["selection"]["items"], [])

    def test_truncation_reports_status(self):
        self.source.items = [make_item(id=str(i), label=f"A{i}") for i in range(70)]
        sampler = self._make_sampler(max_items=64)
        sampler.tick()
        truncated_events = [s for s in self.statuses if s[0] == "truncated"]
        self.assertEqual(len(truncated_events), 1)
        self.assertIn("64", truncated_events[0][1]["detail"])

    def test_current_frame_persists_across_calls(self):
        sampler = self._make_sampler()
        self.assertIsNone(sampler.current_frame())
        sampler.tick()
        first = sampler.current_frame()
        self.assertIsNotNone(first)
        self.clock.advance(1.0)
        # No selection change -> no new tick emission, current_frame stable.
        sampler.tick()
        self.assertEqual(sampler.current_frame(), first)

    def test_expensive_items_extraction_only_happens_on_change(self):
        # sample_items() is the "expensive-ish" call; it must only be
        # invoked when the cheap digest actually changed.
        self.source.items = [make_item(id="a1", label="A")]
        sampler = self._make_sampler(interval_s=0.0)
        sampler.tick()
        self.assertEqual(self.source.items_calls, 1)
        sampler.tick()  # same selection, digest unchanged
        self.assertEqual(self.source.items_calls, 1)
        self.source.items = [make_item(id="a2", label="B")]
        sampler.tick()
        self.assertEqual(self.source.items_calls, 2)


if __name__ == "__main__":
    unittest.main()
