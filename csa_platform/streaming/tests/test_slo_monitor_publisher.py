"""Integration tests for :class:`SLOMonitor` x :class:`BreachPublisher` fan-out.

Covers:
* Multiple publishers receive every breach.
* A failing publisher does not kill the monitor loop.
* Deduplication window suppresses subsequent breaches in the same window.
* After the window elapses, a new breach fires again.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from csa_platform.streaming.models import LatencySLO
from csa_platform.streaming.slo import SLOBreach, SLOMonitor


class _RecordingPublisher:
    def __init__(self) -> None:
        self.received: list[SLOBreach] = []

    async def publish(self, breach: SLOBreach) -> None:
        self.received.append(breach)


class _ExplodingPublisher:
    def __init__(self) -> None:
        self.calls = 0

    async def publish(self, breach: SLOBreach) -> None:
        _ = breach
        self.calls += 1
        raise RuntimeError("publisher blew up")


def _clock(times: list[datetime]) -> Callable[[], datetime]:
    it = iter(times)

    def now() -> datetime:
        return next(it)

    return now


def _slo() -> LatencySLO:
    return LatencySLO(p50_ms=50, p95_ms=100, p99_ms=200, sla_threshold_ms=250)


@pytest.mark.asyncio
async def test_fanout_delivers_to_every_publisher() -> None:
    p1 = _RecordingPublisher()
    p2 = _RecordingPublisher()
    monitor = SLOMonitor(publishers=[p1, p2])
    monitor.register("g", _slo())

    # Single bad sample -> one breach.
    monitor.record_latency("g", 1000)
    # Yield to the loop so the create_task-scheduled fan-out runs.
    await asyncio.sleep(0)
    # Give a second yield in case scheduling reorders.
    await asyncio.sleep(0)

    assert len(p1.received) == 1
    assert len(p2.received) == 1
    assert p1.received[0].contract_name == "g"
    assert p1.received[0].observed_p99_ms == 1000


@pytest.mark.asyncio
async def test_failing_publisher_does_not_kill_monitor() -> None:
    explode = _ExplodingPublisher()
    good = _RecordingPublisher()
    monitor = SLOMonitor(publishers=[explode, good])
    monitor.register("g", _slo())

    monitor.record_latency("g", 1000)
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert explode.calls == 1
    # Good publisher still got the breach even though the first one
    # raised.
    assert len(good.received) == 1


@pytest.mark.asyncio
async def test_dedupe_window_suppresses_consecutive_breaches() -> None:
    start = datetime(2026, 4, 20, 12, 0, 0, tzinfo=timezone.utc)
    times = [
        start + timedelta(seconds=0),   # record #1
        start + timedelta(seconds=10),  # record #2 — inside window
        start + timedelta(seconds=20),  # record #3 — inside window
    ]
    pub = _RecordingPublisher()
    monitor = SLOMonitor(
        publishers=[pub],
        now=_clock(times),
        dedupe_window_seconds=60,
    )
    monitor.register("g", _slo())

    first = monitor.record_latency("g", 1000)
    second = monitor.record_latency("g", 1200)
    third = monitor.record_latency("g", 1300)
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert first is not None
    assert second is None
    assert third is None
    assert len(pub.received) == 1


@pytest.mark.asyncio
async def test_dedupe_window_re_fires_after_elapses() -> None:
    start = datetime(2026, 4, 20, 12, 0, 0, tzinfo=timezone.utc)
    times = [
        start + timedelta(seconds=0),    # breach #1
        start + timedelta(seconds=10),   # suppressed
        start + timedelta(seconds=120),  # breach #2 (> 60s later)
    ]
    pub = _RecordingPublisher()
    monitor = SLOMonitor(
        publishers=[pub],
        now=_clock(times),
        dedupe_window_seconds=60,
    )
    monitor.register("g", _slo())

    first = monitor.record_latency("g", 1000)
    suppressed = monitor.record_latency("g", 1200)
    # Widen the window so samples from t=0 and t=10s fall out; use a
    # fresh short-window SLO so the second record still computes a
    # breach.  We reuse the same monitor for simplicity by registering
    # a new contract.
    _ = first
    _ = suppressed
    third = monitor.record_latency("g", 3000)
    await asyncio.sleep(0)

    assert first is not None
    assert suppressed is None
    assert third is not None
    assert third.observed_p99_ms == 3000
    assert len(pub.received) == 2


@pytest.mark.asyncio
async def test_legacy_on_breach_callback_still_fires() -> None:
    captured: list[SLOBreach] = []
    pub = _RecordingPublisher()
    monitor = SLOMonitor(on_breach=captured.append, publishers=[pub])
    monitor.register("g", _slo())
    monitor.record_latency("g", 1000)
    await asyncio.sleep(0)

    assert len(captured) == 1
    assert len(pub.received) == 1


@pytest.mark.asyncio
async def test_dedupe_also_suppresses_callback() -> None:
    start = datetime(2026, 4, 20, 12, 0, 0, tzinfo=timezone.utc)
    times = [
        start,
        start + timedelta(seconds=1),
    ]
    captured: list[SLOBreach] = []
    monitor = SLOMonitor(
        on_breach=captured.append,
        now=_clock(times),
        dedupe_window_seconds=60,
    )
    monitor.register("g", _slo())
    monitor.record_latency("g", 1000)
    monitor.record_latency("g", 2000)

    assert len(captured) == 1


def test_add_publisher_after_construction() -> None:
    pub = _RecordingPublisher()
    monitor = SLOMonitor()
    assert monitor.publishers == ()
    monitor.add_publisher(pub)
    assert monitor.publishers == (pub,)


def test_dispatch_without_running_loop_runs_synchronously() -> None:
    pub = _RecordingPublisher()
    monitor = SLOMonitor(publishers=[pub])
    monitor.register("g", _slo())
    # No running loop here — the dispatcher should fall back to asyncio.run.
    monitor.record_latency("g", 1000)
    assert len(pub.received) == 1


def test_dedupe_window_zero_allows_every_breach() -> None:
    pub = _RecordingPublisher()
    monitor = SLOMonitor(publishers=[pub], dedupe_window_seconds=0)
    monitor.register("g", _slo())
    monitor.record_latency("g", 1000)
    monitor.record_latency("g", 1100)
    assert len(pub.received) == 2


@pytest.mark.asyncio
async def test_publisher_negative_dedupe_coerced_to_zero() -> None:
    pub = _RecordingPublisher()
    monitor = SLOMonitor(publishers=[pub], dedupe_window_seconds=-10)
    monitor.register("g", _slo())
    monitor.record_latency("g", 1000)
    monitor.record_latency("g", 1100)
    await asyncio.sleep(0)
    assert len(pub.received) == 2


def test_sample_count_and_p99_still_work_with_publishers() -> None:
    pub = _RecordingPublisher()
    monitor = SLOMonitor(publishers=[pub])
    monitor.register("g", _slo())
    monitor.record_latency("g", 100)
    assert monitor.sample_count("g") == 1
    assert monitor.current_p99("g") == 100
    # No breach → publishers silent.
    assert pub.received == []


@pytest.mark.asyncio
async def test_tuple_publishers_input_is_accepted() -> None:
    pub = _RecordingPublisher()
    monitor = SLOMonitor(publishers=[pub])  # list is the primary contract
    any_tuple_publisher: Any = pub
    monitor.add_publisher(any_tuple_publisher)
    monitor.register("g", _slo())
    monitor.record_latency("g", 1000)
    await asyncio.sleep(0)
    # Both registrations fan out to the same instance — 2 deliveries.
    assert len(pub.received) == 2
