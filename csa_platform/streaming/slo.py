"""csa_platform.streaming.slo — rolling-window latency SLO monitor (CSA-0137).

:class:`SLOMonitor` is a deterministic, pure-Python monitor that accepts
``record_latency(contract_name, observed_ms)`` calls and emits
:class:`SLOBreach` events when the rolling-window p99 crosses the
threshold declared by a :class:`~csa_platform.streaming.models.LatencySLO`.

Gap-2 closure (see ``csa_platform/streaming/README.md``) adds a
publisher fan-out layer: breaches are delivered to every configured
:class:`~csa_platform.streaming.breach_publisher.BreachPublisher`
in addition to the legacy ``on_breach`` callback.  Publisher failures
are isolated — a misbehaving publisher can never knock the monitor
offline.  Duplicate breaches for the same contract inside a
``dedupe_window_seconds`` interval are coalesced so downstream sinks
are not flooded while the contract is in sustained breach.
"""

from __future__ import annotations

import asyncio
import logging
import math
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from csa_platform.streaming.models import LatencySLO

if TYPE_CHECKING:  # pragma: no cover
    from csa_platform.streaming.breach_publisher import BreachPublisher

_LOGGER = logging.getLogger("csa_platform.streaming.slo")


@dataclass(frozen=True, slots=True)
class SLOBreach:
    """Event emitted when a rolling-window p99 crosses the SLA threshold."""

    contract_name: str
    observed_p99_ms: int
    threshold_ms: int
    window_minutes: int
    sample_count: int
    occurred_at: datetime


class SLOMonitor:
    """Rolling-window SLO monitor with optional durable publisher fan-out.

    The monitor keeps a per-contract deque of ``(timestamp, observed_ms)``
    tuples, prunes entries that fall outside the SLO's rolling window on
    every :meth:`record_latency` call, and emits breaches through the
    ``on_breach`` callback when the computed p99 exceeds the threshold.

    If ``publishers`` is supplied every breach is additionally routed
    (async, fire-and-forget) to each publisher with tenacity-backed
    retries inside the publisher itself.  Publisher failures are logged
    but never propagated.

    Deduplication: within ``dedupe_window_seconds`` of the last breach
    for a given contract, subsequent breaches are coalesced — the
    monitor does NOT call ``on_breach`` or publishers again until the
    window elapses.  Defaults to 60 seconds.
    """

    def __init__(
        self,
        *,
        on_breach: Callable[[SLOBreach], None] | None = None,
        now: Callable[[], datetime] | None = None,
        publishers: list[BreachPublisher] | None = None,
        dedupe_window_seconds: int = 60,
    ) -> None:
        self._slos: dict[str, LatencySLO] = {}
        self._samples: dict[str, deque[tuple[datetime, int]]] = {}
        self._on_breach = on_breach or (lambda _breach: None)
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._publishers: list[BreachPublisher] = list(publishers or [])
        self._dedupe_window = timedelta(seconds=max(0, int(dedupe_window_seconds)))
        self._last_breach_at: dict[str, datetime] = {}
        # We keep strong refs to outstanding fan-out tasks so they cannot
        # be garbage-collected mid-flight (asyncio.create_task only holds
        # a weak reference in some Python versions; RUF006).
        self._pending_tasks: set[asyncio.Task[None]] = set()

    # ----- registration -------------------------------------------------

    def register(self, contract_name: str, slo: LatencySLO) -> None:
        """Register an SLO for a named contract."""
        if contract_name in self._slos:
            raise ValueError(f"SLO already registered for contract {contract_name!r}")
        self._slos[contract_name] = slo
        self._samples[contract_name] = deque()

    def is_registered(self, contract_name: str) -> bool:
        return contract_name in self._slos

    def add_publisher(self, publisher: BreachPublisher) -> None:
        """Register an additional publisher after construction."""
        self._publishers.append(publisher)

    @property
    def publishers(self) -> tuple[BreachPublisher, ...]:
        """Return the current publisher list as an immutable snapshot."""
        return tuple(self._publishers)

    # ----- metric ingestion --------------------------------------------

    def record_latency(self, contract_name: str, observed_ms: int) -> SLOBreach | None:
        """Record a single latency observation and optionally fire a breach.

        Returns the :class:`SLOBreach` only when it is NOT suppressed by
        the deduplication window — suppressed breaches return ``None``
        so callers that key on the return value align with publisher
        behaviour.
        """
        if contract_name not in self._slos:
            raise KeyError(f"No SLO registered for contract {contract_name!r}")
        if observed_ms < 0:
            raise ValueError(f"observed_ms must be >= 0, got {observed_ms}")
        slo = self._slos[contract_name]
        now = self._now()
        samples = self._samples[contract_name]
        samples.append((now, observed_ms))
        # Prune outside rolling window.
        cutoff = now - timedelta(minutes=slo.rolling_window_minutes)
        while samples and samples[0][0] < cutoff:
            samples.popleft()

        p99 = self._percentile([v for _, v in samples], 0.99)
        if p99 is None:
            return None
        if p99 <= slo.sla_threshold_ms:
            return None

        # Deduplication window — within N seconds of a recent breach for
        # this contract, suppress both the callback and the publisher
        # fan-out.
        last = self._last_breach_at.get(contract_name)
        if last is not None and (now - last) < self._dedupe_window:
            return None

        breach = SLOBreach(
            contract_name=contract_name,
            observed_p99_ms=p99,
            threshold_ms=slo.sla_threshold_ms,
            window_minutes=slo.rolling_window_minutes,
            sample_count=len(samples),
            occurred_at=now,
        )
        self._last_breach_at[contract_name] = now
        self._on_breach(breach)
        self._dispatch_to_publishers(breach)
        return breach

    # ----- publisher fan-out -------------------------------------------

    def _dispatch_to_publishers(self, breach: SLOBreach) -> None:
        """Fan the breach out to every publisher, insulating the monitor loop."""
        if not self._publishers:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No running loop — run the fan-out synchronously so the
            # record_latency call-site still sees the publishers fire.
            # This branch covers CLI / unit-test invocations that drive
            # the monitor from plain synchronous code.
            asyncio.run(self._publish_all(breach))
            return
        task = loop.create_task(self._publish_all(breach))
        self._pending_tasks.add(task)
        task.add_done_callback(self._pending_tasks.discard)

    async def _publish_all(self, breach: SLOBreach) -> None:
        """Invoke every publisher; log but swallow any exception."""
        for publisher in self._publishers:
            try:
                await publisher.publish(breach)
            except Exception:
                _LOGGER.exception(
                    "breach publisher failed",
                    extra={
                        "contract_name": breach.contract_name,
                        "publisher": publisher.__class__.__name__,
                    },
                )

    # ----- introspection ------------------------------------------------

    def sample_count(self, contract_name: str) -> int:
        """Return the current in-window sample count for a contract."""
        if contract_name not in self._samples:
            raise KeyError(f"No SLO registered for contract {contract_name!r}")
        return len(self._samples[contract_name])

    def current_p99(self, contract_name: str) -> int | None:
        """Return the current in-window p99, or ``None`` if no samples."""
        if contract_name not in self._samples:
            raise KeyError(f"No SLO registered for contract {contract_name!r}")
        return self._percentile([v for _, v in self._samples[contract_name]], 0.99)

    # ----- percentiles --------------------------------------------------

    @staticmethod
    def _percentile(values: list[int], pct: float) -> int | None:
        """Return the nearest-rank percentile (1-based), or ``None`` if empty."""
        if not values:
            return None
        if not 0.0 < pct <= 1.0:
            raise ValueError(f"pct must be in (0, 1], got {pct}")
        sorted_values = sorted(values)
        # Nearest-rank: ceil(pct * n), then map to 0-based index.
        rank = max(1, math.ceil(pct * len(sorted_values)))
        return sorted_values[rank - 1]
