# Loom Mirroring Engine service

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


Per [ADR fiab-0006](../adr/0006-mirroring-engine.md) and [Mirroring
parity workload](../workloads/mirroring-parity.md).

## Purpose

Fabric Mirroring parity service. Zero-ETL CDC from operational
databases into the Loom lakehouse as Delta tables. Honors Fabric's
Open Mirroring publisher contract so partner publishers work
unchanged.

## Service shape

| Aspect | Value |
|---|---|
| Repo path | `apps/fiab-mirroring-engine/` |
| CDC runtime | Debezium Connect (Kafka Connect) |
| Transport | Azure Event Hubs (Kafka protocol surface) |
| Stream compute | Spark Structured Streaming on Databricks |
| State store | Azure Cosmos DB (watermarks + schema-evolution log) |
| Container host | Container Apps (Commercial / GCC); AKS (GCC-H / IL5) |
| Build PRP | PRP-07 |

## Architecture

```
   Source DBs                Loom Mirroring Engine                Target
   ─────────             ─────────────────────────             ──────────
   Azure SQL  ─┐
   Cosmos DB  ─┼─► Debezium Connect / Cosmos Spark ─┐         ADLS Gen2
   Postgres   ─┤   in Container Apps / AKS          │         Delta tables
   MySQL      ─┤                                    │         (Bronze)
   SQL Server ─┤                                    ▼
   2016-25    ─┘                                    Event Hubs
                                                    (Kafka protocol)
   Snowflake/Oracle/SAP via Open Mirroring publisher          │
   → drop Parquet with __rowMarker__ to ADLS landing zone     │
                                                              ▼
                              Spark Structured Streaming job
                              on Databricks
                              - reads Event Hubs (Kafka)
                              - reads landing zone Parquet
                              - parses CDC envelope
                              - MERGE INTO target Delta idempotently
```

## Source connectors

| Source | Connector | Notes |
|---|---|---|
| Azure SQL DB / MI | Debezium SQL Server | reads CDC tables |
| Postgres | Debezium Postgres | logical replication (wal2json/pgoutput) |
| MySQL | Debezium MySQL | binlog-based |
| Cosmos DB | Azure Cosmos Spark | change feed |
| SQL Server 2016-25 | Debezium SQL Server + SHIR for on-prem | |
| Snowflake | Custom poller (Snowflake streams API) | no native Debezium |
| Oracle | Debezium Oracle | LogMiner |
| SAP / partner-published Parquet | Open Mirroring landing-zone protocol | partner SDKs |

## Open Mirroring landing-zone protocol

Identical to Fabric's:

- Path: `<ADLS>/landing-zone/<schema>/<table>/`
- `_metadata.json` declares `keyColumns` (primary key)
- 20-digit zero-padded file names (`00000000000000000001.parquet`)
- `__rowMarker__` column: 1=INSERT, 2=UPDATE, 3=DELETE

Use Blob API (not DFS) for writes — block blobs allow parallel block
uploads.

## Per-mirror configuration

Stored in Cosmos DB; authored via Console "Mirroring" pane (v1.1) or
JSON-direct (v1).

## Operational SLAs

| Metric | Target |
|---|---|
| Steady-state CDC lag | < 60 s |
| Spark Streaming trigger interval | 30 s default (5 s configurable) |
| Idempotent re-bootstrap | < 5 min for table reset |
| Schema-evolution detection | next streaming batch |

## Runbooks

- [Mirroring CDC lag](../runbooks/mirroring-cdc-lag.md)

## Related

- ADR: [fiab-0006 Mirroring engine](../adr/0006-mirroring-engine.md)
- Workload: [Mirroring parity](../workloads/mirroring-parity.md)
- Build PRP: PRP-07
- Tutorial: [Tutorial 06 — Mirroring from Cosmos DB](../tutorials/06-mirroring-cosmos.md)
