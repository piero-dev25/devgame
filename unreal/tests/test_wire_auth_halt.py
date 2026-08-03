"""
Tests for the "do not hammer-reconnect on a credential rejection" behavior
in `wire.Wire` — see wire.Wire's module docstring and
`wire.is_credential_rejection`.

CORRECTED per docs/workbench/godot-probe-findings.md's "Correction: '>= 4000
means stop retrying' was too coarse": only 4400 (missing credential) and
4401 (invalid credential) halt. Everything else — including an unrecognized
code >= 4000 like 4500 (server internal error) — keeps retrying with normal
backoff, because retrying CAN fix a transient server fault but cannot fix a
rejected credential. `test_server_internal_error_keeps_retrying_with_backoff_not_halting`
and `test_invalid_credential_code_halts_not_retries` are the two tests that
exist specifically to keep this distinction from collapsing back into a
numeric threshold — see this module's bottom for the mutation-proof
instructions these two are designed to satisfy.

Uses real threads (the halt path polls a real `threading.Event`, not the
injected `sleep`), so these tests spend a small, bounded amount of real
wall-clock time rather than being fully clock-injected like
unreal/tests/test_wire_backoff.py.
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


class WireTestHarness:
    """Shared setup for the threaded Wire tests below — not a TestCase
    itself, mixed in so each concrete TestCase gets its own fresh
    statuses/sleeps lists per test."""

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


class IsCredentialRejectionPredicateTests(unittest.TestCase):
    """Pure, no threads — the fast, exhaustive check that the predicate
    itself is a named membership test, not a threshold, before trusting
    the slower threaded tests below to exercise it correctly."""

    def test_missing_and_invalid_credential_codes_are_rejections(self):
        self.assertTrue(wire.is_credential_rejection(wire.CLOSE_CODE_MISSING_CREDENTIAL))
        self.assertTrue(wire.is_credential_rejection(wire.CLOSE_CODE_INVALID_CREDENTIAL))
        self.assertTrue(wire.is_credential_rejection(4400))
        self.assertTrue(wire.is_credential_rejection(4401))

    def test_unrecognized_codes_above_4000_are_not_rejections(self):
        # This is the exact case the correction exists for: 4500 (server
        # internal error) must NOT be treated as a credential problem.
        self.assertFalse(wire.is_credential_rejection(4500))
        self.assertFalse(wire.is_credential_rejection(4999))
        self.assertFalse(wire.is_credential_rejection(4000))
        self.assertFalse(wire.is_credential_rejection(4402))

    def test_codes_below_4000_and_none_are_not_rejections(self):
        self.assertFalse(wire.is_credential_rejection(1000))
        self.assertFalse(wire.is_credential_rejection(-1))
        self.assertFalse(wire.is_credential_rejection(None))

    def test_not_a_threshold_comparison(self):
        # A regression-proof way to assert "membership, not >=": 4402 is
        # above the old (wrong) threshold but is not one of the two named
        # credential codes, so it must read False.
        self.assertGreater(4402, wire.CLOSE_CODE_INVALID_CREDENTIAL)
        self.assertFalse(wire.is_credential_rejection(4402))


class InvalidCredentialHaltsTests(WireTestHarness, unittest.TestCase):
    """4401 (invalid credential): must halt, not retry.

    This is the "must still halt" side of the divergence — see
    UnrecognizedServerFaultKeepsRetryingTests for the "must NOT halt" side.
    Together, these are the two mutation-proof tests from the audit
    correction: flip either engine's halt condition to a `>= 4000`
    threshold, or to "nothing halts," and one of the two goes red.
    """

    def test_invalid_credential_code_halts_not_retries(self):
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

    def test_missing_credential_code_also_halts(self):
        call_count = {"n": 0}

        def connect_fn():
            call_count["n"] += 1
            raise wire.HandshakeFailed(status_code=4400, reason="no credential presented")

        w, statuses = self._make_wire(connect_fn)
        stop_event = threading.Event()
        thread = threading.Thread(target=w.run_forever, args=(stop_event,), daemon=True)
        thread.start()
        try:
            self.assertTrue(_wait_until(lambda: any(s[0] == "halted" for s in statuses)))
            time.sleep(0.3)
            self.assertEqual(call_count["n"], 1)
        finally:
            stop_event.set()
            w.request_reconnect()
            thread.join(timeout=2.0)

    def test_request_reconnect_wakes_the_halt_immediately(self):
        call_count = {"n": 0}

        def connect_fn():
            call_count["n"] += 1
            raise wire.HandshakeFailed(status_code=4401, reason="still bad")

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


class UnrecognizedServerFaultKeepsRetryingTests(WireTestHarness, unittest.TestCase):
    """4500 (server internal error) and other unrecognized >= 4000 codes:
    must keep retrying with backoff, must NOT halt. This is the case the
    audit correction exists for — the original (too coarse) rule would
    have halted here and permanently disconnected every editor on a
    momentary server fault."""

    def test_server_internal_error_keeps_retrying_with_backoff_not_halting(self):
        call_count = {"n": 0}

        def connect_fn():
            call_count["n"] += 1
            raise wire.HandshakeFailed(status_code=4500, reason="internal error")

        sleeps = []
        w, statuses = self._make_wire(connect_fn, sleep_recorder=lambda s: sleeps.append(s))
        stop_event = threading.Event()
        thread = threading.Thread(target=w.run_forever, args=(stop_event,), daemon=True)
        thread.start()
        try:
            # Must reach the normal backoff-sleep path (proves it did NOT
            # halt) and must call connect_fn again on its own (proves it
            # actually keeps retrying, not just "didn't emit halted").
            self.assertTrue(_wait_until(lambda: len(sleeps) >= 1))
            self.assertTrue(_wait_until(lambda: call_count["n"] >= 2, timeout=2.0))
            self.assertFalse(any(s[0] == "halted" for s in statuses))

            disconnected = [s for s in statuses if s[0] == "disconnected"]
            self.assertTrue(disconnected)
            self.assertIn("internal error", disconnected[0][1]["reason"])
            self.assertEqual(disconnected[0][1]["close_code"], 4500)
        finally:
            stop_event.set()
            thread.join(timeout=2.0)

    def test_unrecognized_close_code_above_4401_keeps_retrying(self):
        call_count = {"n": 0}

        def connect_fn():
            call_count["n"] += 1
            raise wire.HandshakeFailed(status_code=4999, reason="something new")

        sleeps = []
        w, statuses = self._make_wire(connect_fn, sleep_recorder=lambda s: sleeps.append(s))
        stop_event = threading.Event()
        thread = threading.Thread(target=w.run_forever, args=(stop_event,), daemon=True)
        thread.start()
        try:
            self.assertTrue(_wait_until(lambda: len(sleeps) >= 1))
            self.assertFalse(any(s[0] == "halted" for s in statuses))
        finally:
            stop_event.set()
            thread.join(timeout=2.0)


class NonAuthFailureUsesNormalBackoffTests(WireTestHarness, unittest.TestCase):
    def test_network_unreachable_uses_normal_backoff_not_halt(self):
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


if __name__ == "__main__":
    unittest.main()

# -----------------------------------------------------------------------
# MUTATION-PROOF, as requested — two mutations, each must turn exactly one
# NAMED test red, then restore to green. Run from unreal/:
#
#   python3 -m unittest tests.test_wire_auth_halt -v
#
# Mutation 1 — "make 4500 halt": in wire.py's `is_credential_rejection`,
# temporarily change the body to `return close_code is not None and
# close_code >= 4000` (the old, too-coarse rule). Expected: RED —
# `test_server_internal_error_keeps_retrying_with_backoff_not_halting`
# (asserts `not any(s[0] == "halted" ...)`, which now fails) and likely
# `test_unrecognized_close_code_above_4401_keeps_retrying` too. Restore the
# body to `return close_code in CREDENTIAL_REJECTION_CLOSE_CODES` and
# confirm GREEN again.
#
# Mutation 2 — "make 4401 keep retrying": temporarily change
# `CREDENTIAL_REJECTION_CLOSE_CODES` to `frozenset()` (nothing halts).
# Expected: RED — `test_invalid_credential_code_halts_not_retries` (its
# `self.assertEqual(call_count["n"], 1)` fails, since it would have retried)
# and `test_missing_credential_code_also_halts`. Restore to
# `frozenset({CLOSE_CODE_MISSING_CREDENTIAL, CLOSE_CODE_INVALID_CREDENTIAL})`
# and confirm GREEN again.
# -----------------------------------------------------------------------
