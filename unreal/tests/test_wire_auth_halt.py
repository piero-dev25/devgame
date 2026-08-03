"""
Tests for the "do not hammer-reconnect on a credential rejection" behavior
added to `wire.Wire` during the cross-engine contract audit — see
wire.Wire's module docstring. Uses real threads (the halt path polls a real
`threading.Event`, not the injected `sleep`), so these tests spend a small,
bounded amount of real wall-clock time rather than being fully
clock-injected like unreal/tests/test_wire_backoff.py.
"""

import queue
import threading
import time
import unittest

from epp import wire


def _wait_until(predicate, timeout=2.0, interval=0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class _FakeSampler:
    def current_frame(self):
        return None


class AuthRejectionHaltTests(unittest.TestCase):
    def _make_wire(self, connect_fn, *, sleep_recorder=None):
        statuses = []
        return (
            wire.Wire(
                connect_fn=connect_fn,
                hello_frame_fn=lambda: '{"v":1,"type":"hello"}',
                sampler=_FakeSampler(),
                outbound=queue.Queue(maxsize=1),
                on_status=lambda event, **fields: statuses.append((event, fields)),
                sleep=sleep_recorder if sleep_recorder is not None else (lambda _s: None),
            ),
            statuses,
        )

    def test_auth_rejection_at_handshake_halts_without_backoff_sleep(self):
        call_count = {"n": 0}

        def connect_fn():
            call_count["n"] += 1
            raise wire.HandshakeFailed(status_code=4401, reason="invalid or expired token")

        sleeps = []
        w, statuses = self._make_wire(connect_fn, sleep_recorder=lambda s: sleeps.append(s))
        stop_event = threading.Event()
        thread = threading.Thread(target=w.run_forever, args=(stop_event,), daemon=True)
        thread.start()
        try:
            self.assertTrue(_wait_until(lambda: any(s[0] == "halted" for s in statuses)))
            halted = next(s for s in statuses if s[0] == "halted")
            self.assertIn("invalid or expired token", halted[1]["reason"])
            self.assertEqual(halted[1]["close_code"], 4401)

            # Give the halt loop a real chance to have retried on its own
            # if the halt were broken — it must not have.
            time.sleep(0.4)
            self.assertEqual(call_count["n"], 1)
            self.assertEqual(sleeps, [])  # never took the normal backoff path
        finally:
            stop_event.set()
            w.request_reconnect()  # unstick the wait loop so the thread exits promptly
            thread.join(timeout=2.0)

    def test_request_reconnect_wakes_the_halt_immediately(self):
        call_count = {"n": 0}

        def connect_fn():
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise wire.HandshakeFailed(status_code=4401, reason="invalid or expired token")
            raise wire.HandshakeFailed(status_code=4401, reason="still bad")  # simplest: stays rejected

        w, statuses = self._make_wire(connect_fn)
        stop_event = threading.Event()
        thread = threading.Thread(target=w.run_forever, args=(stop_event,), daemon=True)
        thread.start()
        try:
            self.assertTrue(_wait_until(lambda: call_count["n"] >= 1))
            self.assertTrue(_wait_until(lambda: any(s[0] == "halted" for s in statuses)))

            w.request_reconnect()
            self.assertTrue(_wait_until(lambda: call_count["n"] >= 2, timeout=1.0))
        finally:
            stop_event.set()
            w.request_reconnect()
            thread.join(timeout=2.0)

    def test_non_auth_failure_uses_normal_backoff_not_halt(self):
        call_count = {"n": 0}

        def connect_fn():
            call_count["n"] += 1
            raise OSError("connection refused")

        sleeps = []
        w, statuses = self._make_wire(connect_fn, sleep_recorder=lambda s: sleeps.append(s))
        stop_event = threading.Event()
        thread = threading.Thread(target=w.run_forever, args=(stop_event,), daemon=True)
        thread.start()
        try:
            self.assertTrue(_wait_until(lambda: len(sleeps) >= 1))
            self.assertFalse(any(s[0] == "halted" for s in statuses))
            self.assertTrue(any(s[0] == "disconnected" for s in statuses))
        finally:
            stop_event.set()
            thread.join(timeout=2.0)

    def test_is_auth_rejection_predicate(self):
        self.assertTrue(wire.is_auth_rejection(4000))
        self.assertTrue(wire.is_auth_rejection(4401))
        self.assertFalse(wire.is_auth_rejection(3999))
        self.assertFalse(wire.is_auth_rejection(1000))
        self.assertFalse(wire.is_auth_rejection(-1))
        self.assertFalse(wire.is_auth_rejection(None))


if __name__ == "__main__":
    unittest.main()
