"""csa_platform.streaming — unified streaming contract spine (CSA-0137).

This package defines the streaming backbone used by CSA-in-a-Box verticals
that require real-time ingestion, materialization, and SLO-managed
consumption.  The module is intentionally thin and contract-first: all
runtime behaviours are expressed as frozen Pydantic models + small async
adapters over the Azure SDK, so the same contract can drive dbt sources,
Stream Analytics jobs, ADX tables, and Fabric Real-Time Intelligence (when
the latter reaches Government GA).

Public surface::

    from csa_platform.streaming import (
        SourceContract,
        StreamingBronze,
        SilverMaterializedView,
        GoldStreamContract,
        LatencySLO,
        SLOMonitor,
        SourceType,
        BronzeFormat,
        generate_sources_yaml,
    )

The :mod:`csa_platform.streaming.sources` module exposes the
:class:`SourceAdapter` protocol plus concrete adapters for Event Hub and
IoT Hub; :mod:`csa_platform.streaming.bronze` writes raw events to
ADLS Gen2 using a date-partitioned layout; :mod:`csa_platform.streaming.silver`
and :mod:`csa_platform.streaming.gold` model materialized views and the
latency-governed gold contract respectively.

The CLI (``python -m csa_platform.streaming validate <path>``) validates
YAML contract files without requiring Azure credentials — useful in CI.
"""

from __future__ import annotations

from csa_platform.streaming.dbt_integration import generate_sources_yaml
from csa_platform.streaming.models import (
    BronzeFormat,
    GoldStreamContract,
    LatencySLO,
    SilverMaterializedView,
    SourceConnection,
    SourceContract,
    SourceType,
    StreamingBronze,
)
from csa_platform.streaming.slo import SLOBreach, SLOMonitor

__all__ = [
    "BronzeFormat",
    "GoldStreamContract",
    "LatencySLO",
    "SLOBreach",
    "SLOMonitor",
    "SilverMaterializedView",
    "SourceConnection",
    "SourceContract",
    "SourceType",
    "StreamingBronze",
    "generate_sources_yaml",
]
