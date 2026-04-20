"""Unit tests for :mod:`csa_platform.streaming.gold`."""

from __future__ import annotations

import pytest

from csa_platform.streaming.gold import GoldContractValidationError, GoldStreamValidator
from csa_platform.streaming.models import (
    GoldStreamContract,
    LatencySLO,
    SilverMaterializedView,
)
from csa_platform.streaming.slo import SLOMonitor


def _slo() -> LatencySLO:
    return LatencySLO(p50_ms=50, p95_ms=100, p99_ms=200, sla_threshold_ms=250)


def _silver() -> SilverMaterializedView:
    return SilverMaterializedView(
        name="iot_clean",
        upstream_bronze="iot_telemetry",
        dbt_model_ref="silver.iot_clean",
        watermark_field="event_time",
    )


def test_validator_accepts_known_silver_refs() -> None:
    v = GoldStreamValidator([_silver()])
    gold = GoldStreamContract(
        name="g",
        upstream_silver_refs=("iot_clean",),
        latency_slo=_slo(),
        query_spec="q",
        consumers=("c1",),
    )
    v.validate(gold)  # no raise


def test_validator_rejects_missing_silver_refs() -> None:
    v = GoldStreamValidator([_silver()])
    gold = GoldStreamContract(
        name="g",
        upstream_silver_refs=("missing",),
        latency_slo=_slo(),
        query_spec="q",
        consumers=("c1",),
    )
    with pytest.raises(GoldContractValidationError, match="unknown silver views"):
        v.validate(gold)


def test_validator_rejects_blank_consumer() -> None:
    v = GoldStreamValidator([_silver()])
    gold = GoldStreamContract(
        name="g",
        upstream_silver_refs=("iot_clean",),
        latency_slo=_slo(),
        query_spec="q",
        consumers=("   ",),
    )
    with pytest.raises(GoldContractValidationError, match="empty consumer"):
        v.validate(gold)


def test_attach_to_monitor_registers_slo() -> None:
    v = GoldStreamValidator([_silver()])
    gold = GoldStreamContract(
        name="iot_dash",
        upstream_silver_refs=("iot_clean",),
        latency_slo=_slo(),
        query_spec="q",
        consumers=("c1",),
    )
    monitor = SLOMonitor()
    v.attach_to_monitor(gold, monitor)
    assert monitor.is_registered("iot_dash")


def test_attach_runs_validation_first() -> None:
    v = GoldStreamValidator([_silver()])
    gold = GoldStreamContract(
        name="g",
        upstream_silver_refs=("missing",),
        latency_slo=_slo(),
        query_spec="q",
        consumers=("c1",),
    )
    monitor = SLOMonitor()
    with pytest.raises(GoldContractValidationError):
        v.attach_to_monitor(gold, monitor)
    assert not monitor.is_registered("g")
