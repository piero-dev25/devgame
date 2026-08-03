"""
epp/wire.py — RFC 6455 framing + the reconnecting publisher connection.

ABSOLUTE RULE, from the frozen spec's step 7 risk list: THIS FILE NEVER
IMPORTS `unreal`, for any reason, including logging. It is the one mistake
in this whole plugin that crashes the editor rather than logging an error —
a worker thread touching the `unreal` API is not safe. Enforced structurally
here: importing `unreal` in this file would be a NameError in review, not a
crash in someone's editor. Status/log information leaves this module only
through the `on_status(event, **fields)` callback the caller supplies; the
caller (publisher.py) is responsible for draining that onto a queue the game
thread reads, never calling into `unreal` from inside the callback itself if
it's invoked from this thread (see `Wire.run_forever`'s threading contract
below).

WHY HAND-ROLLED RFC 6455 INSTEAD OF A VENDORED LIBRARY (this is the one call
the brief left to my judgment, and I'm taking it, with reasons):
  1. The precise requirement this plugin has — read the WebSocket close code
     and reason verbatim on disconnect, and tell them apart from "never
     reached the server at all" — needs direct control over frame parsing.
     A vendored library's exception/callback shape for a close frame vs. a
     dead TCP connection is exactly the kind of behavior I cannot verify on
     Unreal's embedded interpreter (unlike here, where I both wrote and
     tested the parser). Hand-rolling removes a whole layer of "trust the
     library's abstraction" from the one behavior this plugin most needs to
     get right.
  2. This publisher is one-directional and small: it sends `hello`,
     `selection`, and `ping` text frames, and only ever needs to understand
     `pong` and `close` in reply (plus replying to an inbound `ping`, which
     nothing in the protocol currently sends us, but costs nothing to
     handle). That is a narrow, fully-enumerable surface — the spec's own
     estimate for a hand-rolled implementation ("~250 lines") matches what
     is actually needed here, not a general-purpose client.
  3. It avoids an entire unverified-import surface: whether a vendored
     `websocket-client` version imports cleanly on Unreal's trimmed embedded
     interpreter, whether its import graph is pure stdlib, and its exact
     license text at the pinned version, are all things nobody has checked
     (see ../../../UNVERIFIED.md in the frozen spec's own risk list). This
     file depends only on `socket`, `ssl`, `struct`, `base64`, `hashlib`,
     `os`, `random`, `time`, `queue`, `threading`, `urllib.parse` — all
     present in every CPython stdlib back to versions far older than
     anything Unreal embeds.
  4. Smaller, fully-owned surface = easier to audit, which is the framing
     the brief itself asked for ("keep the surface small and auditable").

No vendored code, so there is no third-party license to record here.

The RFC 6455 worked example from the spec itself (section 1.3) is used
verbatim as a unit test vector in unreal/tests/test_wire_framing.py to
verify the SHA-1/base64 handshake math against the standard, independent of
whether a real Unreal-hosted server is ever reachable from this machine.
unreal/tests/test_wire_loopback.py goes one step further and proves the
whole handshake + framing + close-code path against a real (if minimal, and
DELIBERATELY independently implemented — not reusing this file's own
decoder) loopback WebSocket server over an actual TCP socket, which is the
one part of this plugin that genuinely can be proven end-to-end without
Unreal itself.
"""

import base64
import hashlib
import os
import queue
import random
import socket
import ssl
import struct
import threading
import time
from typing import Callable, List, Optional, Tuple
from urllib.parse import urlsplit

# ---------------------------------------------------------------------------
# RFC 6455 frame opcodes
# ---------------------------------------------------------------------------

OPCODE_CONTINUATION = 0x0
OPCODE_TEXT = 0x1
OPCODE_BINARY = 0x2
OPCODE_CLOSE = 0x8
OPCODE_PING = 0x9
OPCODE_PONG = 0xA

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class Frame:
    __slots__ = ("opcode", "payload", "fin")

    def __init__(self, opcode: int, payload: bytes, fin: bool = True):
        self.opcode = opcode
        self.payload = payload
        self.fin = fin


def encode_frame(opcode: int, payload: bytes, *, mask: bool = True, fin: bool = True) -> bytes:
    """Client-to-server frames MUST be masked per RFC 6455 §5.1; this
    function always masks unless explicitly told not to (tests use
    `mask=False` to exercise the decoder's unmasked path, which is what a
    compliant server sends us)."""
    header = bytearray()
    header.append((0x80 if fin else 0x00) | (opcode & 0x0F))

    length = len(payload)
    mask_bit = 0x80 if mask else 0x00
    if length < 126:
        header.append(mask_bit | length)
    elif length < 65536:
        header.append(mask_bit | 126)
        header += struct.pack("!H", length)
    else:
        header.append(mask_bit | 127)
        header += struct.pack("!Q", length)

    if not mask:
        return bytes(header) + payload

    masking_key = os.urandom(4)
    header += masking_key
    masked = bytes(b ^ masking_key[i % 4] for i, b in enumerate(payload))
    return bytes(header) + masked


def try_decode_frame(buf: bytes) -> Tuple[Optional[Frame], int]:
    """Returns `(Frame, bytes_consumed)`, or `(None, 0)` if `buf` doesn't yet
    hold one complete frame. Never raises on truncated input — the caller
    keeps accumulating bytes from the socket and retries. Handles both
    masked (a misbehaving/relaying peer) and unmasked (the normal
    server-to-client case) frames."""
    if len(buf) < 2:
        return None, 0
    b0, b1 = buf[0], buf[1]
    fin = bool(b0 & 0x80)
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    length = b1 & 0x7F
    offset = 2

    if length == 126:
        if len(buf) < offset + 2:
            return None, 0
        length = struct.unpack("!H", buf[offset : offset + 2])[0]
        offset += 2
    elif length == 127:
        if len(buf) < offset + 8:
            return None, 0
        length = struct.unpack("!Q", buf[offset : offset + 8])[0]
        offset += 8

    masking_key = b""
    if masked:
        if len(buf) < offset + 4:
            return None, 0
        masking_key = buf[offset : offset + 4]
        offset += 4

    if len(buf) < offset + length:
        return None, 0

    raw_payload = buf[offset : offset + length]
    if masked:
        payload = bytes(b ^ masking_key[i % 4] for i, b in enumerate(raw_payload))
    else:
        payload = bytes(raw_payload)

    return Frame(opcode=opcode, payload=payload, fin=fin), offset + length


def parse_close_payload(payload: bytes) -> Tuple[Optional[int], str]:
    """First two bytes big-endian = close code, remainder = UTF-8 reason.
    An empty close payload (a bare close frame with no code) is legal per
    RFC 6455 and returns `(None, "")`."""
    if len(payload) < 2:
        return None, ""
    code = struct.unpack("!H", payload[:2])[0]
    try:
        reason = payload[2:].decode("utf-8", errors="replace")
    except Exception:
        reason = ""
    return code, reason


# ---------------------------------------------------------------------------
# Handshake
# ---------------------------------------------------------------------------


def make_sec_websocket_key() -> str:
    return base64.b64encode(os.urandom(16)).decode("ascii")


def expected_accept(key: str) -> str:
    """RFC 6455 §1.3's worked example (key `dGhlIHNhbXBsZSBub25jZQ==` ->
    accept `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`) is used as a unit test vector for
    this function directly against the published standard."""
    digest = hashlib.sha1((key + _WS_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def build_handshake_request(*, host_header: str, path: str, key: str, extra_headers=()) -> bytes:
    lines = [
        f"GET {path} HTTP/1.1",
        f"Host: {host_header}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Version: 13",
    ]
    for name, value in extra_headers:
        lines.append(f"{name}: {value}")
    lines.append("")
    lines.append("")
    return "\r\n".join(lines).encode("ascii")


class HandshakeResponse:
    def __init__(self, status_code: int, reason: str, headers: dict, body_start: bytes):
        self.status_code = status_code
        self.reason = reason
        self.headers = headers  # lower-cased header names
        self.body_start = body_start


def try_parse_handshake_response(buf: bytes) -> Tuple[Optional[HandshakeResponse], int]:
    """Returns `(HandshakeResponse, consumed)`, or `(None, 0)` if the header
    block (terminated by a bare CRLFCRLF) isn't fully buffered yet."""
    terminator = b"\r\n\r\n"
    idx = buf.find(terminator)
    if idx == -1:
        return None, 0
    head = buf[:idx].decode("iso-8859-1", errors="replace")
    body_start = buf[idx + len(terminator) :]
    lines = head.split("\r\n")
    status_line = lines[0] if lines else ""
    parts = status_line.split(" ", 2)
    status_code = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else 0
    reason = parts[2] if len(parts) >= 3 else ""
    headers: dict = {}
    for line in lines[1:]:
        if ":" not in line:
            continue
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    return HandshakeResponse(status_code, reason, headers, body_start), idx + len(terminator)


class HandshakeFailed(Exception):
    """`status_code is None` means the connection dropped before any HTTP
    response arrived at all (the -1 / "never reached the server" case);
    otherwise it's a non-101 HTTP status."""

    def __init__(self, status_code: Optional[int], reason: str):
        super().__init__(f"WebSocket handshake failed: HTTP {status_code} {reason}".strip())
        self.status_code = status_code
        self.reason = reason


# ---------------------------------------------------------------------------
# One connection: handshake + framed send/recv over a connected socket-like
# object. `sock` must implement `.sendall(bytes)`, `.recv(n) -> bytes`,
# `.settimeout(s)`, `.close()` — real use passes a `socket.socket` (wrapped
# in `ssl` for `wss://`); tests pass either a real loopback socket or a
# minimal fake.
# ---------------------------------------------------------------------------


class PublisherConnection:
    def __init__(self, sock, *, host_header: str, path: str, bearer_token: str, timeout_s: float = 5.0):
        self._sock = sock
        self._recv_buf = b""
        self._closed = False
        self.last_close_code: Optional[int] = None
        self.last_close_reason: str = ""
        self._handshake(host_header, path, bearer_token, timeout_s)

    def _handshake(self, host_header: str, path: str, bearer_token: str, timeout_s: float) -> None:
        key = make_sec_websocket_key()
        headers = [("Authorization", f"Bearer {bearer_token}")] if bearer_token else []
        request = build_handshake_request(host_header=host_header, path=path, key=key, extra_headers=headers)
        self._sock.settimeout(timeout_s)
        self._sock.sendall(request)

        buf = b""
        response = None
        while response is None:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise HandshakeFailed(status_code=None, reason="connection closed during handshake")
            buf += chunk
            response, _consumed = try_parse_handshake_response(buf)
        self._recv_buf = response.body_start

        if response.status_code != 101:
            raise HandshakeFailed(status_code=response.status_code, reason=response.reason)

        accept = response.headers.get("sec-websocket-accept", "")
        if accept != expected_accept(key):
            raise HandshakeFailed(
                status_code=response.status_code,
                reason="Sec-WebSocket-Accept did not match the request key (possible proxy interference)",
            )

    def send_text(self, text: str) -> None:
        self._sock.sendall(encode_frame(OPCODE_TEXT, text.encode("utf-8")))

    def send_ping(self, payload: bytes = b"") -> None:
        self._sock.sendall(encode_frame(OPCODE_PING, payload))

    def _drain_buffered_frames(self, events: List[tuple]) -> None:
        while True:
            frame, consumed = try_decode_frame(self._recv_buf)
            if frame is None:
                break
            self._recv_buf = self._recv_buf[consumed:]
            if frame.opcode == OPCODE_TEXT:
                events.append(("text", frame.payload.decode("utf-8", errors="replace")))
            elif frame.opcode == OPCODE_PONG:
                events.append(("pong", frame.payload))
            elif frame.opcode == OPCODE_PING:
                # Nothing in EPP v1 currently pings the publisher, but
                # replying in-kind is correct per RFC 6455 and costs nothing.
                try:
                    self._sock.sendall(encode_frame(OPCODE_PONG, frame.payload))
                except OSError:
                    pass
            elif frame.opcode == OPCODE_CLOSE:
                code, reason = parse_close_payload(frame.payload)
                self.last_close_code = code if code is not None else -1
                self.last_close_reason = reason
                events.append(("close", self.last_close_code, reason))

    def poll(self, timeout_s: float) -> List[tuple]:
        """Returns a list of `("text", str)` / `("pong", bytes)` /
        `("close", code, reason)` events decoded from whatever arrived
        within `timeout_s`. An empty list means "nothing arrived," not an
        error — the common case on every call given a 5 Hz sampler and a
        20 s ping interval.

        Drains already-buffered bytes BEFORE touching the socket again. This
        matters more than it looks: a server that accepts the upgrade and
        then immediately closes with an application close code (the EPP
        auth-rejection pattern — see wire.py's `describe_close`) can have
        that close frame arrive in the SAME `recv()` as the 101 handshake
        response, land in `self._recv_buf` as handshake leftover, and then
        close the TCP connection outright. A naive `poll()` that always
        calls `recv()` first would see EOF and report a bare "-1, connection
        closed" instead of ever decoding the already-buffered close frame
        with its real code and reason — this was caught by
        unreal/tests/test_wire_loopback.py's real-socket close-code test,
        not reasoned out in advance.
        """
        events: List[tuple] = []
        self._drain_buffered_frames(events)
        if events:
            return events

        self._sock.settimeout(timeout_s)
        try:
            chunk = self._sock.recv(4096)
        except (socket.timeout, TimeoutError):
            return []
        except OSError:
            return [("close", -1, "socket error")]

        if not chunk:
            self.last_close_code = -1
            self.last_close_reason = "connection closed"
            return [("close", -1, "connection closed")]

        self._recv_buf += chunk
        self._drain_buffered_frames(events)
        return events

    def close(self, code: int = 1000, reason: str = "") -> None:
        if self._closed:
            return
        self._closed = True
        try:
            payload = struct.pack("!H", code) + reason.encode("utf-8")
            self._sock.sendall(encode_frame(OPCODE_CLOSE, payload))
        except OSError:
            pass
        try:
            self._sock.close()
        except OSError:
            pass


def parse_ws_url(url: str):
    parts = urlsplit(url)
    if parts.scheme not in ("ws", "wss"):
        raise ValueError(f"unsupported WebSocket scheme: {parts.scheme!r}")
    use_tls = parts.scheme == "wss"
    host = parts.hostname or "127.0.0.1"
    port = parts.port or (443 if use_tls else 80)
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    host_header = host if parts.port is None else f"{host}:{port}"
    return host, port, path, host_header, use_tls


def connect(url: str, bearer_token: str, *, timeout_s: float = 5.0) -> PublisherConnection:
    """The real, network-touching `connect_fn` used by `Wire` outside of
    tests. Tests either call this directly against a real loopback server
    (unreal/tests/test_wire_loopback.py) or inject their own `connect_fn`
    entirely (unreal/tests/test_wire_reconnect.py)."""
    host, port, path, host_header, use_tls = parse_ws_url(url)
    sock = socket.create_connection((host, port), timeout=timeout_s)
    if use_tls:
        context = ssl.create_default_context()
        sock = context.wrap_socket(sock, server_hostname=host)
    return PublisherConnection(sock, host_header=host_header, path=path, bearer_token=bearer_token, timeout_s=timeout_s)


# ---------------------------------------------------------------------------
# Close-code diagnosis
# ---------------------------------------------------------------------------


def describe_close(code: Optional[int], reason: str) -> Optional[str]:
    """Implements the ruling from docs/workbench/godot-probe-findings.md,
    measured against a real server and generalized to every engine client
    (Unreal's close-code exposure was not independently re-verified here,
    but the ruling explicitly says it should hold for every WebSocket client
    that exposes a close code, which the hand-rolled parser above does by
    construction):

      - close code >= 4000 -> the server told us why; show the reason
        verbatim.
      - anything else (including this module's own -1 sentinel for "no
        WebSocket session was ever established," and a HandshakeFailed with
        a non-101, non-4xxx HTTP status) -> we never got far enough to be
        told anything.

    Returns `None` for the second case; the caller substitutes
    "cannot reach Workbench at <url>" (spec + brief's exact wording),
    which lives at the call site rather than here since only the caller
    knows the URL. Deliberately does NOT use the connection-state sequence
    (CONNECTING vs CLOSED) to guess — the Godot probe proved that is a
    localhost timing artifact, wrong on a remote or firewalled port.
    """
    if code is not None and code >= 4000:
        return reason or f"rejected (close code {code})"
    return None


# ---------------------------------------------------------------------------
# Backoff
# ---------------------------------------------------------------------------


class Backoff:
    """Exponential backoff with jitter: 0.5s -> 30s cap,
    `random.uniform(0.5, 1.5)` multiplier so several editors reconnecting to
    the same restarted server don't synchronize (spec step 5)."""

    def __init__(
        self,
        *,
        base_s: float = 0.5,
        cap_s: float = 30.0,
        jitter=(0.5, 1.5),
        random_fn: Callable[[float, float], float] = random.uniform,
    ):
        self._base = base_s
        self._cap = cap_s
        self._jitter = jitter
        self._random = random_fn
        self._attempt = 0

    def reset(self) -> None:
        self._attempt = 0

    def next_delay(self) -> float:
        raw = min(self._cap, self._base * (2**self._attempt))
        self._attempt += 1
        return raw * self._random(*self._jitter)


def replace_latest(q: "queue.Queue", item) -> None:
    """Bounded queue of size 1 for selection frames: a new frame overwrites
    any pending one rather than accumulating (spec step 5). Presence is a
    level, so while disconnected the only frame worth sending on reconnect
    is the current one — this makes an unbounded backlog impossible by
    construction rather than by a size check someone could get wrong."""
    while True:
        try:
            q.get_nowait()
        except queue.Empty:
            break
    q.put_nowait(item)


# ---------------------------------------------------------------------------
# The reconnecting publisher loop. Runs on its own daemon thread in real use
# (see publisher.py) so a hard editor exit cannot hang on a join.
# ---------------------------------------------------------------------------

PING_INTERVAL_S = 20.0
PONG_TIMEOUT_S = 60.0
POLL_TIMEOUT_S = 0.5


def is_auth_rejection(close_code: Optional[int]) -> bool:
    """A close code >= 4000 means the server told us why it closed the
    connection (docs/workbench/godot-probe-findings.md's ruling) — for EPP
    specifically, that is always a credential problem, never a transient
    network blip. Retrying with backoff cannot fix a bad or missing token,
    so this is the single predicate both `Wire`'s halt-on-rejection branch
    and any status-consuming UI should use to decide "don't hammer this,
    wait for the user to fix the token and ask again." """
    return close_code is not None and close_code >= 4000


class Wire:
    """`connect_fn()` -> `PublisherConnection` (or raises `HandshakeFailed`
    / `OSError`). `hello_frame_fn()` -> the current `hello` frame JSON,
    resolved at connect time so a `session.id` minted once at startup is
    still what gets sent on every reconnect. `sampler` only needs
    `.current_frame()`. `outbound` is a `queue.Queue(maxsize=1)` fed via
    `replace_latest`. `on_status(event, **fields)` is called from THIS
    THREAD — the caller must not touch `unreal` inside it; see the module
    docstring's absolute rule.

    AUTH-REJECTION HALT: a close code >= 4000 stops the automatic
    reconnect loop entirely (a `"halted"` status event fires instead of the
    normal `"connecting"`/backoff cycle) rather than retrying with the same
    rejected credential every few seconds — retrying cannot fix a bad
    token, only hammer the server and spam the Output Log. The loop then
    blocks until `request_reconnect()` is called (wired to the "Reconnect
    now" / "Pair" UI actions in publisher.py) or `stop_event` fires. This
    was added during the cross-engine contract audit alongside the
    equivalent fix in the Unity plugin (`EditorPresenceConnection.cs`),
    per the same ruling: "do not hammer-reconnect on a >= 4000 rejection."
    """

    def __init__(
        self,
        *,
        connect_fn: Callable[[], PublisherConnection],
        hello_frame_fn: Callable[[], str],
        sampler,
        outbound: "queue.Queue",
        on_status: Callable[..., None],
        backoff: Optional[Backoff] = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        ping_interval_s: float = PING_INTERVAL_S,
        pong_timeout_s: float = PONG_TIMEOUT_S,
        poll_timeout_s: float = POLL_TIMEOUT_S,
    ):
        self._connect_fn = connect_fn
        self._hello_frame_fn = hello_frame_fn
        self._sampler = sampler
        self._outbound = outbound
        self._on_status = on_status
        self._backoff = backoff or Backoff()
        self._clock = clock
        self._sleep = sleep
        self._ping_interval_s = ping_interval_s
        self._pong_timeout_s = pong_timeout_s
        self._poll_timeout_s = poll_timeout_s
        self._resume_event = threading.Event()

    def request_reconnect(self) -> None:
        """Wakes a halted (auth-rejected) wire loop immediately. Safe to
        call from any thread — this is the only method on `Wire` that is.
        A no-op while the loop is in its normal backoff cycle rather than
        halted (that path is not currently interruptible; see the module
        docstring's scope note if that changes)."""
        self._resume_event.set()

    def run_forever(self, stop_event) -> None:
        """`stop_event` is a `threading.Event`-shaped object (`.is_set()`);
        checked between connection attempts and inside the per-connection
        loop so a clean shutdown doesn't wait out a full backoff sleep or
        an auth-rejection halt."""
        while not stop_event.is_set():
            close_code, close_reason = self._run_one_connection(stop_event)
            if stop_event.is_set():
                return

            if is_auth_rejection(close_code):
                # Surface the server's own reason VERBATIM (describe_close
                # already extracted it) rather than a generic message — a
                # generic "credential rejected" is exactly the kind of
                # local guess the close-code ruling exists to avoid.
                described = describe_close(close_code, close_reason)
                self._on_status(
                    "halted",
                    reason=described or "credential rejected — fix the token, then Reconnect now",
                    close_code=close_code,
                )
                self._resume_event.clear()
                while not stop_event.is_set() and not self._resume_event.is_set():
                    stop_event.wait(0.2)
                if stop_event.is_set():
                    return
                self._backoff.reset()
                continue

            delay = self._backoff.next_delay()
            self._on_status("connecting", detail=f"retrying in {delay:.1f}s")
            self._sleep(delay)

    def _run_one_connection(self, stop_event) -> "Tuple[Optional[int], str]":
        """Returns `(close_code, reason)` observed for this connection
        attempt — `close_code` is `None` for anything that isn't a definite
        server-issued close code (a pre-connect failure, a pong timeout, a
        clean local stop). The caller (`run_forever`) uses this to decide
        whether to halt instead of backing off, and to surface the reason
        verbatim if so."""
        self._on_status("connecting")
        try:
            conn = self._connect_fn()
        except HandshakeFailed as e:
            code = e.status_code if is_auth_rejection(e.status_code) else None
            described = describe_close(code, e.reason)
            self._on_status(
                "disconnected",
                reason=described or f"cannot reach Workbench: HTTP {e.status_code} {e.reason}".strip(),
                close_code=e.status_code,
            )
            if is_auth_rejection(e.status_code):
                return e.status_code, e.reason
            return None, ""
        except OSError as e:
            self._on_status("disconnected", reason=f"cannot reach Workbench: {e}", close_code=None)
            return None, ""

        self._backoff.reset()
        self._on_status("connected")
        try:
            conn.send_text(self._hello_frame_fn())
            current = self._sampler.current_frame()
            if current is not None:
                conn.send_text(current)

            last_ping_at = self._clock()
            last_pong_at = self._clock()

            while not stop_event.is_set():
                now = self._clock()
                if now - last_ping_at >= self._ping_interval_s:
                    conn.send_ping()
                    last_ping_at = now
                if now - last_pong_at > self._pong_timeout_s:
                    self._on_status(
                        "disconnected", reason="no pong within timeout; forcing reconnect", close_code=None
                    )
                    return None, ""

                try:
                    frame = self._outbound.get_nowait()
                    conn.send_text(frame)
                except queue.Empty:
                    pass

                for event in conn.poll(self._poll_timeout_s):
                    kind = event[0]
                    if kind == "pong":
                        last_pong_at = self._clock()
                    elif kind == "close":
                        _, code, reason = event
                        described = describe_close(code, reason)
                        self._on_status(
                            "disconnected",
                            reason=described or "cannot reach Workbench (connection closed)",
                            close_code=code,
                        )
                        return code, reason
            return None, ""
        finally:
            conn.close()
