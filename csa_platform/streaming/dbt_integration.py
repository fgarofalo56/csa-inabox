"""csa_platform.streaming.dbt_integration — dbt sources.yml emitter (CSA-0137).

Pure function :func:`generate_sources_yaml` that converts a list of
:class:`SourceContract` objects into a dbt ``sources.yml`` block.  The
output is deterministic (sorted by name) so tests can snapshot-compare
it with a fixture.
"""

from __future__ import annotations

from collections.abc import Iterable

import yaml

from csa_platform.streaming.models import SourceContract, SourceType


def _dbt_source_name_for(source_type: SourceType) -> str:
    """Map streaming source types to dbt source-group names.

    dbt ``sources.yml`` groups tables under a single source — we use the
    source technology as the group so bronze tables from the same
    pipeline share metadata (tests, freshness, loader hints).
    """
    return {
        SourceType.EVENT_HUB: "streaming_event_hub",
        SourceType.IOT_HUB: "streaming_iot_hub",
        SourceType.KAFKA: "streaming_kafka",
    }[source_type]


def _freshness_for(contract: SourceContract) -> dict[str, dict[str, int | str]]:
    """Derive a dbt freshness block from the contract's lateness SLA.

    The warn/error thresholds are generated from ``max_lateness_seconds``
    so dbt source-freshness checks line up with the contract promise:
    warn at 2x lateness, error at 4x lateness.
    """
    warn = max(60, contract.max_lateness_seconds * 2)
    err = max(120, contract.max_lateness_seconds * 4)
    return {
        "warn_after": {"count": warn, "period": "second"},
        "error_after": {"count": err, "period": "second"},
    }


def generate_sources_yaml(contract_list: Iterable[SourceContract]) -> str:
    """Emit a dbt-compatible ``sources.yml`` for the given contracts.

    Returns a YAML string (not parsed) so callers can write it directly to
    ``models/streaming/sources.yml``.  Grouping is by source technology;
    ordering is lexicographic by contract name for deterministic output.
    """
    contracts = sorted(contract_list, key=lambda c: c.name)
    # Group by dbt source name (= technology)
    grouped: dict[str, list[SourceContract]] = {}
    for c in contracts:
        key = _dbt_source_name_for(c.source_type)
        grouped.setdefault(key, []).append(c)

    sources_block: list[dict[str, object]] = []
    for source_name in sorted(grouped):
        tables: list[dict[str, object]] = []
        for contract in grouped[source_name]:
            table: dict[str, object] = {
                "name": contract.name,
                "description": (
                    f"Streaming {contract.source_type.value} source. "
                    f"Watermark: {contract.watermark_field}. "
                    f"Partition key: {contract.partition_key_path}."
                ),
                "loaded_at_field": contract.watermark_field,
                "freshness": _freshness_for(contract),
                "meta": {
                    "csa_streaming": True,
                    "source_type": contract.source_type.value,
                    "schema_ref": contract.schema_ref,
                    "partition_key_path": contract.partition_key_path,
                    "max_lateness_seconds": contract.max_lateness_seconds,
                    "expected_events_per_second": contract.expected_events_per_second,
                    "throughput_units": contract.throughput_units,
                    "compliance_tags": list(contract.compliance_tags),
                },
            }
            tables.append(table)
        sources_block.append(
            {
                "name": source_name,
                "description": f"CSA-in-a-Box streaming sources ({source_name}).",
                "tables": tables,
            },
        )

    doc = {"version": 2, "sources": sources_block}
    # sort_keys=False preserves the curated key order above; default_flow_style=False
    # gives block-style YAML which is the dbt convention.
    return yaml.safe_dump(doc, sort_keys=False, default_flow_style=False)
