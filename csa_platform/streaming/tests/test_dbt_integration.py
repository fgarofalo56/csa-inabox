"""Unit tests for :mod:`csa_platform.streaming.dbt_integration`."""

from __future__ import annotations

import yaml

from csa_platform.streaming.dbt_integration import generate_sources_yaml
from csa_platform.streaming.models import SourceConnection, SourceContract, SourceType


def _contract(name: str, source_type: SourceType, **overrides: object) -> SourceContract:
    defaults: dict[str, object] = {
        "name": name,
        "source_type": source_type,
        "connection": SourceConnection(namespace="ns", entity="ent"),
        "partition_key_path": "$.k",
        "schema_ref": "schemaregistry://x/v1",
        "watermark_field": "event_time",
        "max_lateness_seconds": 300,
        "expected_events_per_second": 100,
        "throughput_units": 1,
        "compliance_tags": ("fedramp-high",),
    }
    defaults.update(overrides)
    return SourceContract(**defaults)  # type: ignore[arg-type]


def test_generates_valid_yaml_with_grouping() -> None:
    contracts = [
        _contract("iot_telemetry", SourceType.IOT_HUB),
        _contract("aqi_stream", SourceType.EVENT_HUB),
        _contract("slot_events", SourceType.EVENT_HUB),
        _contract("kafka_passthrough", SourceType.KAFKA),
    ]
    text = generate_sources_yaml(contracts)
    doc = yaml.safe_load(text)
    assert doc["version"] == 2
    names = [s["name"] for s in doc["sources"]]
    # Group names sorted lexicographically, tech-level grouping.
    assert names == ["streaming_event_hub", "streaming_iot_hub", "streaming_kafka"]
    # Event Hub group should have two tables, sorted by contract name.
    eh = next(s for s in doc["sources"] if s["name"] == "streaming_event_hub")
    table_names = [t["name"] for t in eh["tables"]]
    assert table_names == ["aqi_stream", "slot_events"]


def test_freshness_derived_from_lateness() -> None:
    contract = _contract("iot_telemetry", SourceType.IOT_HUB, max_lateness_seconds=600)
    doc = yaml.safe_load(generate_sources_yaml([contract]))
    table = doc["sources"][0]["tables"][0]
    assert table["freshness"]["warn_after"]["count"] == 1200
    assert table["freshness"]["error_after"]["count"] == 2400
    assert table["freshness"]["warn_after"]["period"] == "second"


def test_meta_block_contains_contract_fields() -> None:
    contract = _contract("iot_telemetry", SourceType.IOT_HUB)
    doc = yaml.safe_load(generate_sources_yaml([contract]))
    meta = doc["sources"][0]["tables"][0]["meta"]
    assert meta["csa_streaming"] is True
    assert meta["source_type"] == "iot_hub"
    assert meta["schema_ref"] == "schemaregistry://x/v1"
    assert meta["partition_key_path"] == "$.k"
    assert meta["compliance_tags"] == ["fedramp-high"]


def test_deterministic_output() -> None:
    contracts = [
        _contract("b", SourceType.EVENT_HUB),
        _contract("a", SourceType.EVENT_HUB),
    ]
    a = generate_sources_yaml(contracts)
    b = generate_sources_yaml(list(reversed(contracts)))
    assert a == b


def test_empty_input_produces_empty_sources_block() -> None:
    doc = yaml.safe_load(generate_sources_yaml([]))
    assert doc == {"version": 2, "sources": []}
