"""csa_platform.streaming — unified streaming contract spine (CSA-0137).

This package defines the streaming backbone used by CSA-in-a-Box verticals
that require real-time ingestion, materialization, and SLO-managed
consumption.  The module is intentionally thin and contract-first: all
runtime behaviours are expressed as frozen Pydantic models + small async
adapters over the Azure SDK, so the same contract can drive dbt sources,
Stream Analytics jobs, ADX tables, and Fabric Real-Time Intelligence (gated
on ``FABRIC_RTI_ENABLED=true`` pre-GA — see ADR-0018).

Public surface::

    from csa_platform.streaming import (
        # Core contracts
        SourceContract,
        StreamingBronze,
        SilverMaterializedView,
        GoldStreamContract,
        StreamingContractBundle,
        LatencySLO,
        SourceType,
        BronzeFormat,
        # SLO
        SLOMonitor,
        SLOBreach,
        # Publishers (durable fan-out, Gap 2)
        BreachPublisher,
        NoopBreachPublisher,
        LogBreachPublisher,
        EventGridBreachPublisher,
        CosmosBreachPublisher,
        # Schema registry (Gap 1)
        SchemaRegistry,
        NoopSchemaRegistry,
        ConfluentCompatRegistry,
        AzureSchemaRegistry,
        ResolvedSchema,
        ValidationIssue,
        # Fabric RTI (Gap 3 — pre-GA, env-gated)
        FabricRTISource,
        FabricRTINotAvailableError,
        # dbt
        generate_sources_yaml,
    )
"""

from __future__ import annotations

from csa_platform.streaming.breach_publisher import (
    BreachPublisher,
    CosmosBreachPublisher,
    EventGridBreachPublisher,
    LogBreachPublisher,
    NoopBreachPublisher,
)
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
    StreamingContractBundle,
)
from csa_platform.streaming.schema_registry import (
    AzureSchemaRegistry,
    ConfluentCompatRegistry,
    NoopSchemaRegistry,
    ResolvedSchema,
    SchemaNotFoundError,
    SchemaRegistry,
    SchemaRegistryError,
    ValidationIssue,
)
from csa_platform.streaming.slo import SLOBreach, SLOMonitor
from csa_platform.streaming.sources_fabric import (
    FabricRTINotAvailableError,
    FabricRTISource,
)

__all__ = [
    "AzureSchemaRegistry",
    "BreachPublisher",
    "BronzeFormat",
    "ConfluentCompatRegistry",
    "CosmosBreachPublisher",
    "EventGridBreachPublisher",
    "FabricRTINotAvailableError",
    "FabricRTISource",
    "GoldStreamContract",
    "LatencySLO",
    "LogBreachPublisher",
    "NoopBreachPublisher",
    "NoopSchemaRegistry",
    "ResolvedSchema",
    "SLOBreach",
    "SLOMonitor",
    "SchemaNotFoundError",
    "SchemaRegistry",
    "SchemaRegistryError",
    "SilverMaterializedView",
    "SourceConnection",
    "SourceContract",
    "SourceType",
    "StreamingBronze",
    "StreamingContractBundle",
    "ValidationIssue",
    "generate_sources_yaml",
]
