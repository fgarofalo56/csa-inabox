"""csa_platform.streaming.slo — in-process latency SLO monitor (CSA-0137).

:class:`SLOMonitor` is a deterministic, pure-Python monitor that accepts
``record_latency(contract_name, observed_ms)`` calls and emits
:class:`SLOBreach` events when the rolling-window p99 crosses the
threshold declared by a :class:`~csa_platform.streaming.models.LatencySLO`.

The monitor never touches Azure — it is intended to live inside a Gold
contract's query runtime (e.g. the FastAPI BFF that serves gold data, or
a Databricks streaming job) and to forward breach events to whatever
alerting channel is wired into that runtime.  Tests cover the whole
public surface.
"""

from __future__ import annotations

import math
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from csa_platform.streaming.models import LatencySLO


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
    """Rolling-window SLO monitor.

    The monitor keeps a per-contract deque of ``(timestamp, observed_ms)``
    tuples, prunes entries that fall outside the SLO's rolling window on
    every :meth:`record_latency` call, and emits breaches through the
    ``on_breach`` callback when the computed p99 exceeds the threshold.

    The monitor is intentionally pure and deterministic — pass a custom
    ``now`` callable in tests for fully reproducible behaviour.
    """

    def __init__(
        self,
        *,
        on_breach: Callable[[SLOBreach], None] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._slos: dict[str, LatencySLO] = {}
        self._samples: dict[str, deque[tuple[datetime, int]]] = {}
        self._on_breach = on_breach or (lambda _breach: None)
        self._now = now or (lambda: datetime.now(timezone.utc))

    # ----- registration -------------------------------------------------

    def register(self, contract_name: str, slo: LatencySLO) -> None:
        """Register an SLO for a named contract."""
        if contract_name in self._slos:
            raise ValueError(f"SLO already registered for contract {contract_name!r}")
        self._slos[contract_name] = slo
        self._samples[contract_name] = deque()

    def is_registered(self, contract_name: str) -> bool:
        return contract_name in self._slos

    # ----- metric ingestion --------------------------------------------

    def record_latency(self, contract_name: str, observed_ms: int) -> SLOBreach | None:
        """Record a single latency observation and optionally fire a breach."""
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
        if p99 > slo.sla_threshold_ms:
            breach = SLOBreach(
                contract_name=contract_name,
                observed_p99_ms=p99,
                threshold_ms=slo.sla_threshold_ms,
                window_minutes=slo.rolling_window_minutes,
                sample_count=len(samples),
                occurred_at=now,
            )
            self._on_breach(breach)
            return breach
        return None

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
