import unittest

from epp import wire


class RfcWorkedExampleTests(unittest.TestCase):
    def test_expected_accept_matches_rfc6455_section_1_3_worked_example(self):
        # https://www.rfc-editor.org/rfc/rfc6455#section-1.3 — the standard's
        # own worked example. Verifies the SHA-1 + base64 handshake math
        # against the published spec, independent of any server (real or
        # loopback) ever being reachable.
        key = "dGhlIHNhbXBsZSBub25jZQ=="
        self.assertEqual(wire.expected_accept(key), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")


class EncodeDecodeRoundTripTests(unittest.TestCase):
    def test_text_frame_round_trip_masked(self):
        payload = "hello world".encode("utf-8")
        encoded = wire.encode_frame(wire.OPCODE_TEXT, payload, mask=True)
        frame, consumed = wire.try_decode_frame(encoded)
        self.assertIsNotNone(frame)
        self.assertEqual(consumed, len(encoded))
        self.assertEqual(frame.opcode, wire.OPCODE_TEXT)
        self.assertEqual(frame.payload, payload)
        self.assertTrue(frame.fin)

    def test_text_frame_round_trip_unmasked(self):
        payload = "server says hi".encode("utf-8")
        encoded = wire.encode_frame(wire.OPCODE_TEXT, payload, mask=False)
        frame, consumed = wire.try_decode_frame(encoded)
        self.assertEqual(frame.payload, payload)
        self.assertEqual(consumed, len(encoded))

    def test_masking_actually_changes_the_wire_bytes(self):
        payload = b"unmistakable payload"
        masked = wire.encode_frame(wire.OPCODE_TEXT, payload, mask=True)
        unmasked = wire.encode_frame(wire.OPCODE_TEXT, payload, mask=False)
        self.assertNotIn(payload, masked)  # not present in cleartext on the wire
        self.assertIn(payload, unmasked)

    def test_ping_and_pong_opcodes_round_trip(self):
        for opcode in (wire.OPCODE_PING, wire.OPCODE_PONG):
            encoded = wire.encode_frame(opcode, b"payload", mask=True)
            frame, _consumed = wire.try_decode_frame(encoded)
            self.assertEqual(frame.opcode, opcode)
            self.assertEqual(frame.payload, b"payload")

    def test_empty_payload(self):
        encoded = wire.encode_frame(wire.OPCODE_PING, b"", mask=True)
        frame, consumed = wire.try_decode_frame(encoded)
        self.assertEqual(frame.payload, b"")
        self.assertEqual(consumed, len(encoded))

    def test_long_payload_uses_16_bit_extended_length(self):
        payload = b"x" * 1000
        encoded = wire.encode_frame(wire.OPCODE_TEXT, payload, mask=True)
        frame, consumed = wire.try_decode_frame(encoded)
        self.assertEqual(frame.payload, payload)
        self.assertEqual(consumed, len(encoded))

    def test_very_long_payload_uses_64_bit_extended_length(self):
        payload = b"y" * 70000
        encoded = wire.encode_frame(wire.OPCODE_BINARY, payload, mask=True)
        frame, consumed = wire.try_decode_frame(encoded)
        self.assertEqual(frame.payload, payload)
        self.assertEqual(consumed, len(encoded))

    def test_partial_buffer_returns_none_and_zero_consumed(self):
        encoded = wire.encode_frame(wire.OPCODE_TEXT, b"hello", mask=True)
        for cut in range(0, len(encoded)):
            frame, consumed = wire.try_decode_frame(encoded[:cut])
            self.assertIsNone(frame, f"should not decode a partial {cut}-byte buffer")
            self.assertEqual(consumed, 0)
        # And the full buffer decodes correctly, proving the loop above
        # wasn't just testing an always-false shortcut.
        frame, consumed = wire.try_decode_frame(encoded)
        self.assertIsNotNone(frame)

    def test_two_frames_back_to_back_decode_independently(self):
        first = wire.encode_frame(wire.OPCODE_TEXT, b"one", mask=True)
        second = wire.encode_frame(wire.OPCODE_TEXT, b"two", mask=True)
        buf = first + second
        frame1, consumed1 = wire.try_decode_frame(buf)
        self.assertEqual(frame1.payload, b"one")
        buf = buf[consumed1:]
        frame2, consumed2 = wire.try_decode_frame(buf)
        self.assertEqual(frame2.payload, b"two")
        self.assertEqual(consumed1 + consumed2, len(first) + len(second))


class CloseFramePayloadTests(unittest.TestCase):
    def test_code_and_reason(self):
        import struct

        payload = struct.pack("!H", 4401) + "invalid or expired token".encode("utf-8")
        code, reason = wire.parse_close_payload(payload)
        self.assertEqual(code, 4401)
        self.assertEqual(reason, "invalid or expired token")

    def test_empty_close_payload(self):
        code, reason = wire.parse_close_payload(b"")
        self.assertIsNone(code)
        self.assertEqual(reason, "")

    def test_code_only_no_reason(self):
        import struct

        code, reason = wire.parse_close_payload(struct.pack("!H", 1000))
        self.assertEqual(code, 1000)
        self.assertEqual(reason, "")


class HandshakeRequestTests(unittest.TestCase):
    def test_request_contains_required_headers_and_authorization(self):
        request = wire.build_handshake_request(
            host_header="127.0.0.1:3777",
            path="/editor-presence?role=publisher",
            key="dGhlIHNhbXBsZSBub25jZQ==",
            extra_headers=[("Authorization", "Bearer test-token")],
        )
        text = request.decode("ascii")
        self.assertTrue(text.startswith("GET /editor-presence?role=publisher HTTP/1.1\r\n"))
        self.assertIn("Host: 127.0.0.1:3777\r\n", text)
        self.assertIn("Upgrade: websocket\r\n", text)
        self.assertIn("Connection: Upgrade\r\n", text)
        self.assertIn("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n", text)
        self.assertIn("Sec-WebSocket-Version: 13\r\n", text)
        self.assertIn("Authorization: Bearer test-token\r\n", text)
        self.assertTrue(text.endswith("\r\n\r\n"))


class HandshakeResponseParsingTests(unittest.TestCase):
    def test_parses_101_response(self):
        raw = (
            b"HTTP/1.1 101 Switching Protocols\r\n"
            b"Upgrade: websocket\r\n"
            b"Connection: Upgrade\r\n"
            b"Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"
            b"\r\n"
        )
        response, consumed = wire.try_parse_handshake_response(raw)
        self.assertEqual(response.status_code, 101)
        self.assertEqual(response.headers["sec-websocket-accept"], "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
        self.assertEqual(consumed, len(raw))

    def test_parses_non_101_rejection(self):
        raw = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"
        response, _consumed = wire.try_parse_handshake_response(raw)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.reason, "Forbidden")

    def test_incomplete_header_block_returns_none(self):
        raw = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: web"
        response, consumed = wire.try_parse_handshake_response(raw)
        self.assertIsNone(response)
        self.assertEqual(consumed, 0)

    def test_body_start_captures_bytes_past_the_header_terminator(self):
        raw = b"HTTP/1.1 101 Switching Protocols\r\n\r\nEXTRA"
        response, _consumed = wire.try_parse_handshake_response(raw)
        self.assertEqual(response.body_start, b"EXTRA")


class DescribeCloseTests(unittest.TestCase):
    def test_close_code_at_or_above_4000_surfaces_reason_verbatim(self):
        self.assertEqual(wire.describe_close(4401, "invalid or expired token"), "invalid or expired token")
        self.assertEqual(wire.describe_close(4000, "boundary"), "boundary")

    def test_close_code_below_4000_returns_none(self):
        self.assertIsNone(wire.describe_close(1000, "normal closure"))
        self.assertIsNone(wire.describe_close(3999, "just under"))

    def test_no_session_established_sentinel_returns_none(self):
        self.assertIsNone(wire.describe_close(-1, ""))
        self.assertIsNone(wire.describe_close(None, ""))

    def test_missing_reason_still_produces_a_message_above_4000(self):
        message = wire.describe_close(4401, "")
        self.assertIsNotNone(message)
        self.assertIn("4401", message)


if __name__ == "__main__":
    unittest.main()
