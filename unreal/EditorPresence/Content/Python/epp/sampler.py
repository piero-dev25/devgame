"""
epp/sampler.py — poll on tick, emit only on change (spec step 4).

No `unreal` import. Driven entirely by an injected `selection_source`
(duck-typed — see `SelectionSource` docstring below) and an injected
`clock` (a zero-arg callable returning an increasing float, `time.monotonic`
shaped), so unreal/tests/test_sampler.py drives this with a fake selection
source and a fake clock with no engine process involved. The real
`unreal`-touching implementation of `SelectionSource` lives in
unreal_bridge.py and is exercised only by inspection, not by these tests —
see ../../../UNVERIFIED.md.
"""

import time as _time
from typing import Callable, List, Optional, Tuple

from . import protocol
from .model import SelectionItem

# 5 Hz, per spec step 4. Everything below is skipped on intervening ticks.
DEFAULT_INTERVAL_S = 0.2


class SelectionSource:
    """Documents the duck-typed interface `Sampler` expects. Not an ABC —
    Unreal's embedded Python has no guaranteed `typing`/`abc` completeness
    per ../../../UNVERIFIED.md, and this is a two-method contract simple
    enough not to need one.

    `sample_digest()` must be CHEAP: an ordered tuple identifying the
    current selection (kind + durable-id-or-best-available-fallback per
    item) using only the fields that are cheap to read every tick. It is
    called every tick within the rate limit.

    `sample_items()` must return the full ordered `list[SelectionItem]`
    (actors before assets — see mapping.order_items) with every field
    populated. It is called only when `sample_digest()` changed, which is
    what keeps the expensive-ish field extraction (Outliner folder path,
    class name, Blueprint check) rare.
    """

    def sample_digest(self) -> tuple:
        raise NotImplementedError

    def sample_items(self) -> List[SelectionItem]:
        raise NotImplementedError


def _default_now_iso() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


class Sampler:
    def __init__(
        self,
        *,
        selection_source: SelectionSource,
        on_frame: Callable[[str], None],
        on_status: Optional[Callable[..., None]] = None,
        clock: Callable[[], float] = _time.monotonic,
        interval_s: float = DEFAULT_INTERVAL_S,
        max_items: int = protocol.MAX_ITEMS,
        now_iso: Optional[Callable[[], str]] = None,
    ):
        self._source = selection_source
        self._on_frame = on_frame
        self._on_status = on_status or (lambda *_args, **_kwargs: None)
        self._clock = clock
        self._interval_s = interval_s
        self._max_items = max_items
        self._now_iso = now_iso or _default_now_iso

        self._last_digest: Optional[tuple] = None
        self._last_sample_at: Optional[float] = None
        self._seq = 0
        self._last_frame: Optional[str] = None

    def tick(self) -> bool:
        """Call once per engine tick. Returns True if a frame was built and
        handed to `on_frame` this call."""
        now = self._clock()
        if self._last_sample_at is not None and (now - self._last_sample_at) < self._interval_s:
            return False
        self._last_sample_at = now

        digest = self._source.sample_digest()
        if digest == self._last_digest:
            return False
        self._last_digest = digest

        # Deselect-to-nothing is `"items": []` — a state, not the absence of
        # a message. Nothing here early-returns on an empty digest; an empty
        # tuple `()` differs from the initial `None` digest, so the very
        # first tick after startup emits even when nothing is selected.
        items = self._source.sample_items()
        self._seq += 1
        frame, truncated = protocol.build_selection_frame(
            seq=self._seq, at=self._now_iso(), items=items, max_items=self._max_items
        )
        if truncated:
            self._on_status(
                "truncated",
                detail=(
                    f"selection has more than {self._max_items} items; publishing the "
                    f"first {self._max_items} (stable order: actors before assets)"
                ),
            )
        self._last_frame = frame
        self._on_frame(frame)
        return True

    def current_frame(self) -> Optional[str]:
        """The most recently emitted frame text, or `None` if nothing has
        been sampled yet this process. Used on (re)connect: "reconnect is
        just 'send current state'" (spec step 5) — the wire layer calls this
        immediately after `hello` rather than waiting for the next selection
        change, which is what makes a dropped connection self-healing
        without a replay buffer or delta log.

        If this returns `None` (the very first connection attempt races the
        very first tick), the wire layer simply sends nothing extra; the
        sampler's own next tick — due within `interval_s` — emits the first
        frame over the now-established connection through the normal
        outbound-queue path. No special-casing needed at the call site.
        """
        return self._last_frame
