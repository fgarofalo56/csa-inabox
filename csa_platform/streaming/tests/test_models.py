"""Unit tests for :mod:`csa_platform.streaming.models`."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from csa_platform.streaming.models import (
    BronzeFormat,
    GoldStreamContract,
    LatencySLO,
    SilverMaterializedView,
    SourceConnection,
    SourceContract,
    SourceType,
    StreamingBronze,
    StreamingContractBundle,
)


def _connection() -> SourceConnection:
    return SourceConnection(
        namespace="csaiot",
        entity="telemetry",
        consumer_group="$Default",
    )


def test_source_contract_happy_path() -> None:
    sc = SourceContract(
        name="iot_telemetry",
        source_type=SourceType.IOT_HUB,
        connection=_connection(),
        partition_key_path="$.sensor_id",
        schema_ref="schemaregistry://x/v1",
        watermark_field="event_time",
        compliance_tags=("fedramp-high",),
    )
    assert sc.name == "iot_telemetry"
    assert sc.source_type is SourceType.IOT_HUB
    assert sc.compliance_tags == ("fedramp-high",)
    # frozen
    with pytest.raises(ValidationError):
        sc.name = "mutated"


def test_source_contract_rejects_bad_name() -> None:
    with pytest.raises(ValidationError):
        SourceContract(
            name="Bad-Name",
            source_type=SourceType.EVENT_HUB,
            connection=_connection(),
            partition_key_path="$.k",
            schema_ref="x",
            watermark_field="ts",
        )


def test_source_contract_tags_accept_list_via_validate() -> None:
    """model_validate accepts list input (e.g. from YAML) and coerces to tuple."""
    sc = SourceContract.model_validate(
        {
            "name": "a",
            "source_type": "event_hub",
            "connection": {"namespace": "n", "entity": "e"},
            "partition_key_path": "$.k",
            "schema_ref": "x",
            "watermark_field": "ts",
            "compliance_tags": ["a", "b"],
        },
    )
    assert sc.compliance_tags == ("a", "b")


def test_source_contract_tags_reject_string() -> None:
    """A bare string must not be silently accepted in place of a list/tuple."""
    with pytest.raises(ValidationError):
        SourceContract.model_validate(
            {
                "name": "a",
                "source_type": "event_hub",
                "connection": {"namespace": "n", "entity": "e"},
                "partition_key_path": "$.k",
                "schema_ref": "x",
                "watermark_field": "ts",
                "compliance_tags": "fedramp-high",
            },
        )


def test_streaming_bronze_rejects_missing_source_token() -> None:
    with pytest.raises(ValidationError):
        StreamingBronze(
            contract_ref="iot_telemetry",
            storage_account="csa",
            container="iot",
            path_template="bronze/year={yyyy}/",
        )


def test_streaming_bronze_defaults() -> None:
    b = StreamingBronze(
        contract_ref="iot_telemetry",
        storage_account="csa",
        container="iot",
    )
    assert b.format is BronzeFormat.AVRO
    assert "{source}" in b.path_template


def test_silver_view_validations() -> None:
    sv = SilverMaterializedView(
        name="iot_clean",
        upstream_bronze="iot_telemetry",
        dbt_model_ref="silver.iot_clean",
        watermark_field="event_time",
        deduplication_keys=("sensor_id", "event_time"),
    )
    assert sv.deduplication_keys == ("sensor_id", "event_time")


def test_silver_view_accepts_list_via_validate() -> None:
    sv = SilverMaterializedView.model_validate(
        {
            "name": "iot_clean",
            "upstream_bronze": "iot_telemetry",
            "dbt_model_ref": "silver.iot_clean",
            "watermark_field": "event_time",
            "deduplication_keys": ["sensor_id", "event_time"],
        },
    )
    assert sv.deduplication_keys == ("sensor_id", "event_time")


def test_latency_slo_requires_monotonic_percentiles() -> None:
    with pytest.raises(ValidationError):
        LatencySLO(p50_ms=100, p95_ms=50, p99_ms=200, sla_threshold_ms=300)


def test_latency_slo_rejects_threshold_below_p99() -> None:
    with pytest.raises(ValidationError):
        LatencySLO(p50_ms=50, p95_ms=100, p99_ms=200, sla_threshold_ms=150)


def test_latency_slo_happy_path() -> None:
    slo = LatencySLO(p50_ms=50, p95_ms=100, p99_ms=200, sla_threshold_ms=250)
    assert slo.rolling_window_minutes == 5


def test_gold_contract_minimal() -> None:
    slo = LatencySLO(p50_ms=50, p95_ms=100, p99_ms=200, sla_threshold_ms=250)
    g = GoldStreamContract(
        name="iot_dashboard",
        upstream_silver_refs=("iot_clean",),
        latency_slo=slo,
        query_spec="gold.iot_dashboard",
        consumers=("powerbi",),
    )
    assert g.consumers == ("powerbi",)


def test_gold_contract_rejects_empty_refs() -> None:
    slo = LatencySLO(p50_ms=50, p95_ms=100, p99_ms=200, sla_threshold_ms=250)
    with pytest.raises(ValidationError):
        GoldStreamContract(
            name="iot_dashboard",
            upstream_silver_refs=(),
            latency_slo=slo,
            query_spec="q",
            consumers=("powerbi",),
        )


def test_bundle_cross_references_resolve() -> None:
    bundle = StreamingContractBundle(
        sources=(
            SourceContract(
                name="iot_telemetry",
                source_type=SourceType.IOT_HUB,
                connection=_connection(),
                partition_key_path="$.k",
                schema_ref="x",
                watermark_field="ts",
            ),
        ),
        bronze=(
            StreamingBronze(
                contract_ref="iot_telemetry",
                storage_account="s",
                container="c",
            ),
        ),
        silver=(
            SilverMaterializedView(
                name="iot_clean",
                upstream_bronze="iot_telemetry",
                dbt_model_ref="silver.iot_clean",
                watermark_field="ts",
            ),
        ),
        gold=(
            GoldStreamContract(
                name="iot_dash",
                upstream_silver_refs=("iot_clean",),
                latency_slo=LatencySLO(
                    p50_ms=50, p95_ms=100, p99_ms=200, sla_threshold_ms=250,
                ),
                query_spec="q",
                consumers=("c1",),
            ),
        ),
    )
    assert len(bundle.sources) == 1


def test_bundle_flags_orphan_bronze() -> None:
    with pytest.raises(ValidationError):
        StreamingContractBundle(
            sources=(),
            bronze=(
                StreamingBronze(
                    contract_ref="missing_source",
                    storage_account="s",
                    container="c",
                ),
            ),
        )


def test_bundle_flags_orphan_gold() -> None:
    slo = LatencySLO(p50_ms=50, p95_ms=100, p99_ms=200, sla_threshold_ms=250)
    with pytest.raises(ValidationError):
        StreamingContractBundle(
            gold=(
                GoldStreamContract(
                    name="g",
                    upstream_silver_refs=("missing_silver",),
                    latency_slo=slo,
                    query_spec="q",
                    consumers=("c",),
                ),
            ),
        )


def test_bundle_flags_orphan_silver() -> None:
    with pytest.raises(ValidationError):
        StreamingContractBundle(
            sources=(
                SourceContract(
                    name="iot_telemetry",
                    source_type=SourceType.EVENT_HUB,
                    connection=_connection(),
                    partition_key_path="$.k",
                    schema_ref="x",
                    watermark_field="ts",
                ),
            ),
            bronze=(
                StreamingBronze(
                    contract_ref="iot_telemetry",
                    storage_account="s",
                    container="c",
                ),
            ),
            silver=(
                SilverMaterializedView(
                    name="sv",
                    upstream_bronze="other_bronze_source",
                    dbt_model_ref="silver.sv",
                    watermark_field="ts",
                ),
            ),
        )
