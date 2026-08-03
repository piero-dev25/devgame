"""
A minimal, single-connection WebSocket server for real over-the-socket
integration tests (unreal/tests/test_wire_loopback.py) — the same idea as
the throwaway probe server described in
docs/workbench/godot-probe-findings.md, but written for Python's own
`unittest` rather than a one-off script.

DELIBERATELY DOES NOT REUSE epp/wire.py's frame encoder/decoder. This file
implements its own, independent, minimal RFC 6455 codec so that a bug in
wire.py's framing cannot pass a loopback test by agreeing with itself on
both ends of the wire — this server is the test's ground truth, not a
second copy of the code under test. It only implements what these tests
actually need (single-frame, non-fragmented, payload < 64KiB), which is
also everything this protocol's publisher ever sends.
"""

import base64
import hashlib
import socket
import struct
import threading
from typing import Optional, Tuple

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OPCODE_TEXT = 0x1
OPCODE_CLOSE = 0x8
OPCODE_PING = 0x9
OPCODE_PONG = 0xA


def _accept_key(client_key: str) -> str:
    digest = hashlib.sha1((client_key + _WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def _read_http_request(conn) -> Tuple[dict, bytes]:
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = conn.recv(4096)
        if not chunk:
            break
        buf += chunk
    idx = buf.find(b"\r\n\r\n")
    if idx == -1:
        return {}, b""
    head = buf[:idx].decode("iso-8859-1", errors="replace")
    leftover = buf[idx + 4 :]
    headers = {}
    for line in head.split("\r\n")[1:]:
        if ":" not in line:
            continue
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    return headers, leftover


def _decode_client_frame(buf: bytes):
    """Client frames are always masked per RFC 6455. Returns
    `(opcode, payload, consumed)` or `(None, None, 0)` if `buf` doesn't yet
    hold a complete frame."""
    if len(buf) < 2:
        return None, None, 0
    b0, b1 = buf[0], buf[1]
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    length = b1 & 0x7F
    offset = 2
    if length == 126:
        if len(buf) < offset + 2:
            return None, None, 0
        length = struct.unpack("!H", buf[offset : offset + 2])[0]
        offset += 2
    elif length == 127:
        if len(buf) < offset + 8:
            return None, None, 0
        length = struct.unpack("!Q", buf[offset : offset + 8])[0]
        offset += 8
    key = b""
    if masked:
        if len(buf) < offset + 4:
            return None, None, 0
        key = buf[offset : offset + 4]
        offset += 4
    if len(buf) < offset + length:
        return None, None, 0
    raw = buf[offset : offset + length]
    payload = bytes(c ^ key[i % 4] for i, c in enumerate(raw)) if masked else bytes(raw)
    return opcode, payload, offset + length


def _encode_server_frame(opcode: int, payload: bytes) -> bytes:
    """Server-to-client frames are never masked."""
    header = bytearray()
    header.append(0x80 | (opcode & 0x0F))
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header += struct.pack("!H", length)
    else:
        header.append(127)
        header += struct.pack("!Q", length)
    return bytes(header) + payload


class LoopbackWSServer:
    """Listens on 127.0.0.1 on an OS-assigned port, accepts exactly one
    connection, performs the server side of the WS handshake, and then
    either:
      - immediately sends a close frame (`on_connect_close=(code, reason)`),
        simulating the "accept the upgrade, then reject" pattern EPP uses
        (see docs/workbench/godot-probe-findings.md); or
      - reads client frames into `received_texts`, auto-replies `pong` to
        any `ping`, and stops on a client-initiated close.

    `self.port` is valid as soon as the constructor returns; the accept
    loop runs on a background daemon thread.
    """

    def __init__(self, *, on_connect_close: Optional[Tuple[int, str]] = None):
        self._listen_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._listen_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._listen_sock.bind(("127.0.0.1", 0))
        self._listen_sock.listen(1)
        self.port = self._listen_sock.getsockname()[1]

        self.received_texts = []
        self.authorization_header: Optional[str] = None
        self.closed_by_client = threading.Event()
        self.client_close_code: Optional[int] = None
        self.client_close_reason = ""

        self._on_connect_close = on_connect_close
        self._conn = None
        self._stop = threading.Event()
        self._lock = threading.Lock()

        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        self._listen_sock.settimeout(10.0)
        try:
            conn, _addr = self._listen_sock.accept()
        except OSError:
            return
        self._conn = conn
        conn.settimeout(5.0)
        try:
            headers, leftover = _read_http_request(conn)
            self.authorization_header = headers.get("authorization")
            client_key = headers.get("sec-websocket-key", "")
            accept = _accept_key(client_key)
            response = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n"
                "\r\n"
            ).encode("ascii")
            conn.sendall(response)

            if self._on_connect_close is not None:
                code, reason = self._on_connect_close
                payload = struct.pack("!H", code) + reason.encode("utf-8")
                conn.sendall(_encode_server_frame(OPCODE_CLOSE, payload))
                return

            buf = leftover
            while not self._stop.is_set():
                try:
                    chunk = conn.recv(4096)
                except socket.timeout:
                    continue
                if not chunk:
                    break
                buf += chunk
                while True:
                    opcode, payload, consumed = _decode_client_frame(buf)
                    if opcode is None:
                        break
                    buf = buf[consumed:]
                    if opcode == OPCODE_TEXT:
                        with self._lock:
                            self.received_texts.append(payload.decode("utf-8"))
                    elif opcode == OPCODE_PING:
                        try:
                            conn.sendall(_encode_server_frame(OPCODE_PONG, payload))
                        except OSError:
                            return
                    elif opcode == OPCODE_CLOSE:
                        if len(payload) >= 2:
                            self.client_close_code = struct.unpack("!H", payload[:2])[0]
                            self.client_close_reason = payload[2:].decode("utf-8", errors="replace")
                        self.closed_by_client.set()
                        return
        except OSError:
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def send_close(self, code: int, reason: str) -> None:
        if self._conn is None:
            return
        payload = struct.pack("!H", code) + reason.encode("utf-8")
        try:
            self._conn.sendall(_encode_server_frame(OPCODE_CLOSE, payload))
        except OSError:
            pass

    def snapshot_received_texts(self):
        with self._lock:
            return list(self.received_texts)

    def stop(self) -> None:
        self._stop.set()
        try:
            self._listen_sock.close()
        except OSError:
            pass
        if self._conn is not None:
            try:
                self._conn.close()
            except OSError:
                pass
