"""
Test doubles shared across the test modules. No `unreal` import anywhere in
this package — that is the entire point (see epp/__init__.py).
"""

from typing import List, Optional

from epp.model import SelectionItem
from epp.sampler import SelectionSource


class FakeSelectionSource(SelectionSource):
    """A scriptable `SelectionSource`: set `.items` to whatever the next
    `sample_items()`/`sample_digest()` call should reflect."""

    def __init__(self, items: Optional[List[SelectionItem]] = None):
        self.items: List[SelectionItem] = items or []
        self.digest_calls = 0
        self.items_calls = 0

    def sample_digest(self) -> tuple:
        self.digest_calls += 1
        return tuple((item.kind, item.id, item.label) for item in self.items)

    def sample_items(self) -> List[SelectionItem]:
        self.items_calls += 1
        return list(self.items)


class FakeClock:
    """A `time.monotonic`-shaped fake: starts at 0.0, advances only when
    told to, so sampler/backoff tests are deterministic and instantaneous."""

    def __init__(self, start: float = 0.0):
        self._now = start

    def __call__(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += seconds


class RecordingSleep:
    """A `time.sleep`-shaped fake that records every requested delay instead
    of actually sleeping, and advances a paired `FakeClock` by the same
    amount so `Wire.run_forever` test loops don't need real wall-clock
    time."""

    def __init__(self, clock: Optional[FakeClock] = None):
        self.delays: List[float] = []
        self._clock = clock

    def __call__(self, seconds: float) -> None:
        self.delays.append(seconds)
        if self._clock is not None:
            self._clock.advance(seconds)


def make_item(
    *, id=None, kind="actor", label="Item", path=None, detail=None  # noqa: A002 - matches SelectionItem field name
) -> SelectionItem:
    return SelectionItem(id=id, kind=kind, label=label, path=path, detail=detail)
