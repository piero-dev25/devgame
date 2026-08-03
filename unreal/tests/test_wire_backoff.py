import queue
import unittest

from epp import wire


class BackoffTests(unittest.TestCase):
    def _no_jitter_backoff(self, **kwargs):
        # random_fn always returns 1.0 -> isolates the exponential/cap math
        # from the jitter multiplier, which is tested separately below.
        return wire.Backoff(random_fn=lambda lo, hi: 1.0, **kwargs)

    def test_exponential_progression_before_cap(self):
        backoff = self._no_jitter_backoff(base_s=0.5, cap_s=30.0)
        delays = [backoff.next_delay() for _ in range(6)]
        self.assertEqual(delays, [0.5, 1.0, 2.0, 4.0, 8.0, 16.0])

    def test_caps_at_configured_ceiling(self):
        backoff = self._no_jitter_backoff(base_s=0.5, cap_s=30.0)
        for _ in range(10):
            backoff.next_delay()
        capped = backoff.next_delay()
        self.assertEqual(capped, 30.0)

    def test_reset_returns_to_base_delay(self):
        backoff = self._no_jitter_backoff(base_s=0.5, cap_s=30.0)
        backoff.next_delay()
        backoff.next_delay()
        backoff.reset()
        self.assertEqual(backoff.next_delay(), 0.5)

    def test_jitter_multiplier_is_applied_and_bounded(self):
        calls = []

        def recording_random(lo, hi):
            calls.append((lo, hi))
            return hi  # exercise the upper bound

        backoff = wire.Backoff(base_s=1.0, cap_s=30.0, jitter=(0.5, 1.5), random_fn=recording_random)
        delay = backoff.next_delay()
        self.assertEqual(delay, 1.5)  # 1.0 base * 1.5 jitter
        self.assertEqual(calls, [(0.5, 1.5)])

    def test_default_random_fn_stays_within_jitter_bounds(self):
        # Uses the real random.uniform default; asserts bounds hold over
        # many samples rather than asserting an exact value.
        backoff = wire.Backoff(base_s=1.0, cap_s=30.0)
        for _ in range(200):
            backoff.reset()
            delay = backoff.next_delay()
            self.assertGreaterEqual(delay, 0.5)
            self.assertLessEqual(delay, 1.5)


class ReplaceLatestTests(unittest.TestCase):
    def test_bounded_to_one_item(self):
        q: "queue.Queue" = queue.Queue(maxsize=1)
        wire.replace_latest(q, "first")
        wire.replace_latest(q, "second")
        wire.replace_latest(q, "third")
        self.assertEqual(q.qsize(), 1)
        self.assertEqual(q.get_nowait(), "third")

    def test_works_on_an_empty_queue(self):
        q: "queue.Queue" = queue.Queue(maxsize=1)
        wire.replace_latest(q, "only")
        self.assertEqual(q.get_nowait(), "only")


if __name__ == "__main__":
    unittest.main()
