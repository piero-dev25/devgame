"""
Real over-the-socket integration tests against unreal/tests/loopback_ws_server.py.

This is the one part of this plugin that genuinely CAN be proven end-to-end
on this machine even though Unreal itself cannot be run here: the wire
layer's handshake, Authorization header delivery, text-frame send, ping/pong
exchange, and close-code surfacing all happen over a real TCP socket to a
real (if minimal, independently-implemented) WebSocket server — nothing
here is mocked at the socket level.
"""

import json
import threading
import time
import unittest

from epp import wire
from epp.sampler import Sampler

from .fakes import FakeSelectionSource
from .loopback_ws_server import LoopbackWSServer


def _wait_until(predicate, timeout=2.0, interval=0.01):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


class HandshakeAndSendTests(unittest.TestCase):
    def test_authorization_header_reaches_the_server_and_text_frame_arrives(self):
        server = LoopbackWSServer()
        try:
            conn = wire.connect(f"ws://127.0.0.1:{server.port}/editor-presence?role=publisher", "test-token-123")
            try:
                self.assertTrue(_wait_until(lambda: server.authorization_header is not None))
                self.assertEqual(server.authorization_header, "Bearer test-token-123")

                conn.send_text(json.dumps({"v": 1, "type": "hello", "editor": {"id": "unreal"}}))
                self.assertTrue(_wait_until(lambda: len(server.snapshot_received_texts()) == 1))
                received = json.loads(server.snapshot_received_texts()[0])
                self.assertEqual(received["type"], "hello")
            finally:
                conn.close()
        finally:
            server.stop()

    def test_ping_gets_a_real_pong_reply(self):
        server = LoopbackWSServer()
        try:
            conn = wire.connect(f"ws://127.0.0.1:{server.port}/editor-presence?role=publisher", "tok")
            try:
                conn.send_ping(b"payload123")
                events = []

                def _poll_until_pong():
                    events.extend(conn.poll(0.2))
                    return any(e[0] == "pong" for e in events)

                self.assertTrue(_wait_until(_poll_until_pong, timeout=3.0))
                pong_events = [e for e in events if e[0] == "pong"]
                self.assertEqual(pong_events[0][1], b"payload123")
            finally:
                conn.close()
        finally:
            server.stop()

    def test_close_code_and_reason_surfaced_verbatim(self):
        # Simulates the documented EPP auth pattern (see
        # docs/workbench/godot-probe-findings.md): accept the WebSocket
        # upgrade, THEN reject with an application close code + reason.
        server = LoopbackWSServer(on_connect_close=(4401, "invalid or expired token"))
        try:
            conn = wire.connect(f"ws://127.0.0.1:{server.port}/editor-presence?role=publisher", "bad-token")
            try:
                events = []

                def _poll_until_close():
                    events.extend(conn.poll(0.2))
                    return any(e[0] == "close" for e in events)

                self.assertTrue(_wait_until(_poll_until_close, timeout=3.0))
                close_event = next(e for e in events if e[0] == "close")
                _, code, reason = close_event
                self.assertEqual(code, 4401)
                self.assertEqual(reason, "invalid or expired token")
                self.assertEqual(wire.describe_close(code, reason), "invalid or expired token")
            finally:
                conn.close()
        finally:
            server.stop()

    def test_connect_to_nothing_listening_raises_os_error(self):
        # No server at all -> "no WebSocket session was ever established"
        # (the -1 sentinel case), proven against a real closed port rather
        # than a mocked exception.
        with self.assertRaises(OSError):
            wire.connect("ws://127.0.0.1:1/editor-presence?role=publisher", "tok", timeout_s=1.0)


class WireEndToEndTests(unittest.TestCase):
    def test_full_wire_run_sends_hello_and_current_selection_then_reports_disconnect_on_close(self):
        server = LoopbackWSServer()
        source = FakeSelectionSource()
        from .fakes import make_item

        source.items = [make_item(id="a1", kind="actor", label="PlayerRoot")]

        sampler = Sampler(selection_source=source, on_frame=lambda _f: None, now_iso=lambda: "2026-08-03T00:00:00Z")
        sampler.tick()  # populates current_frame() before the wire connects, as a real tick would have by then

        import queue

        outbound: "queue.Queue" = queue.Queue(maxsize=1)
        statuses = []
        stop_event = threading.Event()

        def on_status(event, **fields):
            statuses.append((event, fields))
            if event == "disconnected":
                stop_event.set()

        w = wire.Wire(
            connect_fn=lambda: wire.connect(f"ws://127.0.0.1:{server.port}/editor-presence?role=publisher", "tok"),
            hello_frame_fn=lambda: json.dumps({"v": 1, "type": "hello", "editor": {"id": "unreal"}}),
            sampler=sampler,
            outbound=outbound,
            on_status=on_status,
            poll_timeout_s=0.1,
        )

        thread = threading.Thread(target=w.run_forever, args=(stop_event,), daemon=True)
        thread.start()
        try:
            self.assertTrue(_wait_until(lambda: len(server.snapshot_received_texts()) >= 2, timeout=3.0))
            texts = server.snapshot_received_texts()
            self.assertEqual(json.loads(texts[0])["type"], "hello")
            self.assertEqual(json.loads(texts[1])["type"], "selection")

            self.assertTrue(any(s[0] == "connecting" for s in statuses))
            self.assertTrue(any(s[0] == "connected" for s in statuses))

            server.send_close(1000, "test done")
            self.assertTrue(_wait_until(lambda: any(s[0] == "disconnected" for s in statuses), timeout=3.0))
        finally:
            stop_event.set()
            server.stop()
            thread.join(timeout=2.0)


if __name__ == "__main__":
    unittest.main()
