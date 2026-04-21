"""Unit tests for :mod:`csa_platform.streaming.slo`."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta, timezone

import pytest

from csa_platform.streaming.models import LatencySLO
from csa_platform.streaming.slo import SLOBreach, SLOMonitor


def _clock(times: list[datetime]) -> Callable[[], datetime]:
    it = iter(times)

    def now() -> datetime:
        return next(it)

    return now


def test_register_and_record_happy_path() -> None:
    breaches: list[SLOBreach] = []
    monitor = SLOMonitor(on_breach=breaches.append)
    slo = LatencySLO(p50_ms=50, p95_ms=100, p99_ms=200, sla_threshold_ms=300)
    monitor.register("gold_a", slo)
    assert monitor.is_registered("gold_a")
    result = monitor.record_latency("gold_a", 100)
    assert result is None
    assert breaches == []
    assert monitor.sample_count("gold_a") == 1


def test_record_raises_on_unregistered_contract() -> None:
    monitor = SLOMonitor()
    with pytest.raises(KeyError):
        monitor.record_latency("missing", 100)


def test_record_rejects_negative_latency() -> None:
    monitor = SLOMonitor()
    slo = LatencySLO(p50_ms=50, p95_ms=100, p99_ms=200, sla_threshold_ms=300)
    monitor.register("g", slo)
    with pytest.raises(ValueError, match="observed_ms"):
        monitor.record_latency("g", -5)


def test_duplicate_registration_rejected() -> None:
    monitor = SLOMonitor()
    slo = LatencySLO(p50_ms=50, p95_ms=100, p99_ms=200, sla_threshold_ms=300)
    monitor.register("g", slo)
    with pytest.raises(ValueError, match="already registered"):
        monitor.register("g", slo)


def test_breach_emitted_when_p99_above_threshold() -> None:
    breaches: list[SLOBreach] = []
    slo = LatencySLO(p50_ms=50, p95_ms=100, p99_ms=200, sla_threshold_ms=250)
    start = datetime(2026, 4, 20, 12, 0, 0, tzinfo=timezone.utc)
    times = [start + timedelta(seconds=i) for i in range(10)]
    monitor = SLOMonitor(on_breach=breaches.append, now=_clock(times))
    monitor.register("g", slo)

    # Record 10 samples — one very bad one at the end.
    for v in [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000]:
        monitor.record_latency("g", v)

    # Nearest-rank p99 of 10 samples = index ceil(0.99 * 10) = 10 -> the
    # max value (1000), which is above sla_threshold_ms=250.
    assert breaches, "expected at least one breach"
    latest = breaches[-1]
    assert latest.contract_name == "g"
    assert latest.observed_p99_ms == 1000
    assert latest.threshold_ms == 250
    assert latest.sample_count == 10


def test_rolling_window_prunes_old_samples() -> None:
    slo = LatencySLO(
        p50_ms=50, p95_ms=100, p99_ms=200, sla_threshold_ms=250, rolling_window_minutes=1,
    )
    start = datetime(2026, 4, 20, 12, 0, 0, tzinfo=timezone.utc)
    # 3 old samples outside the window, then 2 recent samples inside.
    times = [
        start,
        start + timedelta(seconds=10),
        start + timedelta(seconds=20),
        start + timedelta(minutes=5),
        start + timedelta(minutes=5, seconds=1),
    ]
    monitor = SLOMonitor(now=_clock(times))
    monitor.register("g", slo)

    for v in [100, 200, 300, 10, 20]:
        monitor.record_latency("g", v)

    # Only the last two samples (at t=5m and t=5m+1s) remain — older
    # entries fell outside the 1-minute rolling window.
    assert monitor.sample_count("g") == 2
    assert monitor.current_p99("g") == 20


def test_current_p99_returns_none_when_no_samples() -> None:
    monitor = SLOMonitor()
    slo = LatencySLO(p50_ms=50, p95_ms=100, p99_ms=200, sla_threshold_ms=300)
    monitor.register("g", slo)
    assert monitor.current_p99("g") is None


def test_sample_count_raises_on_unknown_contract() -> None:
    monitor = SLOMonitor()
    with pytest.raises(KeyError):
        monitor.sample_count("missing")
    with pytest.raises(KeyError):
        monitor.current_p99("missing")


def test_percentile_validation() -> None:
    with pytest.raises(ValueError, match="pct must be"):
        SLOMonitor._percentile([1, 2, 3], 0.0)
    with pytest.raises(ValueError, match="pct must be"):
        SLOMonitor._percentile([1, 2, 3], 1.1)
    assert SLOMonitor._percentile([], 0.5) is None
    assert SLOMonitor._percentile([1, 2, 3, 4, 5], 0.5) == 3
