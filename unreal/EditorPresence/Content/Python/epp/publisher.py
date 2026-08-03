"""
epp/publisher.py — wires sampler + wire + indicator into one running
publisher.

Runs on the game thread except for the daemon thread `wire.Wire` starts
internally. This module is the orchestration layer: it calls into
unreal_bridge.py and indicator.py (both of which touch `unreal`) and into
sampler.py / wire.py / config.py (none of which do), but does not itself
make low-level `unreal.*` calls beyond delegating to those two modules —
kept that way so the "which files touch unreal" boundary stated in
epp/__init__.py stays accurate.
"""

import queue
import threading
from typing import Optional

from . import config, indicator, protocol, unreal_bridge, wire
from .sampler import Sampler

try:
    import unreal
except ImportError:  # pragma: no cover - exercised only inside the editor
    unreal = None  # type: ignore[assignment]


class Publisher:
    def __init__(self):
        self._tick_handle = None
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._outbound: "queue.Queue" = queue.Queue(maxsize=1)
        self._status_queue: "queue.Queue" = queue.Queue()

        self._sampler: Optional[Sampler] = None
        self._wire: Optional[wire.Wire] = None
        self._indicator: Optional[indicator.StatusIndicator] = None

        self._endpoint = ""
        self._project_dir = ""
        self._token_present = True

    # -- lifecycle ----------------------------------------------------

    def start(self) -> None:
        if unreal is None:
            return

        workspace_root = unreal_bridge.resolve_workspace_root()
        if not workspace_root:
            unreal.log_error(
                "[T3 Editor Presence] could not resolve the project directory "
                "(unreal.Paths.project_dir() unavailable or failed) — the publisher "
                "cannot send a valid `hello` frame without it, so it is not starting. "
                "See UNVERIFIED.md."
            )
            return

        self._project_dir = workspace_root
        session_id = unreal_bridge.get_or_create_session_id()
        ws_url = config.resolve_ws_url()
        self._endpoint = ws_url
        http_base = config.ws_url_to_http_base(ws_url)

        def hello_frame_fn() -> str:
            return protocol.build_hello_frame(
                editor_id=unreal_bridge.EDITOR_ID,
                editor_name=unreal_bridge.EDITOR_NAME,
                editor_version=unreal_bridge.resolve_engine_version(),
                session_id=session_id,
                workspace_root=workspace_root,
            )

        def on_frame(frame_json: str) -> None:
            wire.replace_latest(self._outbound, frame_json)

        def on_sampler_status(event, **fields):
            self._status_queue.put(("sampler", event, fields))

        self._sampler = Sampler(
            selection_source=unreal_bridge.UnrealSelectionSource(),
            on_frame=on_frame,
            on_status=on_sampler_status,
            now_iso=unreal_bridge.now_iso,
        )

        def connect_fn():
            token = config.resolve_token(token_file_path=config.default_token_file_path(workspace_root))
            self._token_present = bool(token)
            return wire.connect(ws_url, token or "")

        def on_wire_status(event, **fields):
            self._status_queue.put(("wire", event, fields))

        self._wire = wire.Wire(
            connect_fn=connect_fn,
            hello_frame_fn=hello_frame_fn,
            sampler=self._sampler,
            outbound=self._outbound,
            on_status=on_wire_status,
        )

        self._indicator = indicator.StatusIndicator(
            on_reconnect=self.request_reconnect,
            on_pair=lambda: self._pair(http_base),
            on_open_token_folder=lambda: indicator.open_token_folder(workspace_root),
        )

        self._thread = threading.Thread(target=self._wire.run_forever, args=(self._stop_event,), daemon=True)
        self._thread.start()

        self._tick_handle = unreal_bridge.register_tick(lambda *_args: self._on_tick())
        if self._tick_handle is None:
            unreal.log_warning(
                "[T3 Editor Presence] could not register a Slate tick callback — "
                "the publisher's socket thread is running, but selection will never "
                "be sampled. See UNVERIFIED.md (register_slate_post_tick_callback)."
            )

        unreal.log(f"[T3 Editor Presence] starting, session {session_id}, endpoint {ws_url}")

    def stop(self) -> None:
        self._stop_event.set()
        if self._tick_handle is not None:
            unreal_bridge.unregister_tick(self._tick_handle)
            self._tick_handle = None
        # Best-effort clean close; the daemon thread will also exit on its
        # own within one `poll()` timeout since `_stop_event` is checked
        # inside `Wire.run_forever`'s loop. The PRIMARY guarantee that a
        # stale session disappears is server-side (ping-timeout / socket
        # close eviction — see EditorPresenceRoute.ts), so a thread that
        # doesn't join instantly here is not a correctness problem, only a
        # latency one.

    def request_reconnect(self) -> None:
        # Wakes a credential-rejection halt immediately (see
        # wire.Wire's module docstring and wire.is_credential_rejection —
        # only 4400/missing and 4401/invalid halt; an unrecognized >= 4000
        # code like 4500 keeps retrying on its own and never reaches this
        # halted state at all). While the wire is in its normal backoff
        # cycle rather than halted, this is a no-op — the next attempt
        # still lands on the existing backoff schedule, same as before this
        # method did anything real.
        if self._wire is not None:
            self._wire.request_reconnect()
        if unreal is not None:
            unreal.log("[T3 Editor Presence] reconnect requested")

    def _pair(self, http_base: str) -> None:
        try:
            config.redeem_and_store_from_token_file(self._project_dir, base_http_url=http_base)
            if unreal is not None:
                unreal.log("[T3 Editor Presence] paired — token.txt now holds a redeemed session token")
            # A fresh token makes a prior credential-rejection halt stale —
            # kick the wire immediately rather than making the user click
            # "Reconnect now" as a second, separate step after pairing.
            self.request_reconnect()
        except config.RedeemError as e:
            if unreal is not None:
                unreal.log_warning(f"[T3 Editor Presence] pairing failed: {e}")

    # -- game-thread tick ----------------------------------------------

    def _on_tick(self) -> None:
        if self._sampler is not None:
            self._sampler.tick()
        self._drain_status()

    def _drain_status(self) -> None:
        last_error = ""
        state = indicator.STATE_DISCONNECTED
        drained_any = False
        while True:
            try:
                source, event, fields = self._status_queue.get_nowait()
            except queue.Empty:
                break
            drained_any = True
            if source == "wire":
                if event == "connecting":
                    state = indicator.STATE_CONNECTING
                elif event == "connected":
                    state = indicator.STATE_CONNECTED
                elif event in ("disconnected", "halted"):
                    # "halted" (auth rejection — see wire.Wire) has no
                    # distinct indicator state of its own; it renders as
                    # disconnected with the rejection reason in the
                    # tooltip, same as any other disconnect, but critically
                    # does NOT keep flashing "connecting" every backoff
                    # cycle the way a transient drop does.
                    state = indicator.STATE_DISCONNECTED
                    last_error = fields.get("reason", "") or last_error
            elif source == "sampler" and event == "truncated":
                if unreal is not None:
                    unreal.log_warning(f"[T3 Editor Presence] {fields.get('detail', 'selection truncated')}")

        if drained_any and self._indicator is not None:
            self._indicator.update(
                state=state, endpoint=self._endpoint, last_error=last_error, token_present=self._token_present
            )
