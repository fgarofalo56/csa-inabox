# Mirroring parity

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


## What Fabric does

Zero-ETL near-real-time CDC into OneLake as Delta tables. GA sources
as of 2026-05-22: Azure SQL DB, Azure SQL MI, SQL Server 2016-2025,
Cosmos DB, Azure DB for PostgreSQL, Snowflake, Oracle, SAP Datasphere,
Fabric SQL DB.

Fabric publishes the **Open Mirroring landing-zone protocol** so
partners can drop Parquet files with a documented `__rowMarker__`
column directly into a landing zone path — Fabric's replicator picks
them up and MERGEs into Delta. This is the partner-extensible
ingestion path (Qlik Replicate, Striim, Informatica IDMC, SNP Glue for
SAP, Theobald Xtract Universal).

Latency: sub-minute steady-state; sub-second via partner streaming.

## CSA Loom parity design — `apps/fiab-mirroring-engine`

Per [ADR fiab-0006](../adr/0006-mirroring-engine.md): OSS Debezium +
Spark Structured Streaming + Delta MERGE. Honors Fabric's Open
Mirroring publisher contract so partner publishers work unchanged.

### Source connectors

| Source | Mechanism |
|---|---|
| Azure SQL DB / Azure SQL MI | Debezium SQL Server connector (CDC tables) |
| Postgres | Debezium Postgres connector (logical replication) |
| MySQL | Debezium MySQL connector (binlog) |
| Cosmos DB | Azure Cosmos Spark connector (change feed) |
| Snowflake | Custom poller via Snowflake streams API |
| Oracle | Debezium Oracle (LogMiner) |
| SQL Server 2016-2025 on-prem | Debezium SQL Server + Self-Hosted IR |
| SAP / partner-published Parquet | Open Mirroring landing-zone protocol |

### Transport

**Event Hubs** (Kafka protocol surface) — Debezium emits Kafka topics;
Event Hubs accepts them natively. Cross-cloud Kafka egress not
required.

### Replicator

**Spark Structured Streaming job on Databricks** — reads Event Hubs +
landing zone, parses CDC envelope (op = c/u/d/r, before, after),
MERGEs into Delta target idempotently. Trigger interval 30 s default
(configurable down to 5 s).

### Open Mirroring landing-zone protocol

Identical to Fabric's:

- Path: `<ADLS>/landing-zone/<schema>/<table>/`
- `_metadata.json` declares `keyColumns`
- 20-digit zero-padded sequence file names
  (`00000000000000000001.parquet`)
- `__rowMarker__` column: 1=INSERT, 2=UPDATE, 3=DELETE semantics

### Per-mirror configuration

Stored in Cosmos DB. Authored via Loom Console "Mirroring" pane
(v1.1) or JSON-direct in v1:

```json
{
  "id": "mirror-finance-sales-azuresql",
  "workspaceId": "ws-001",
  "source": {
    "type": "azure-sql-db",
    "server": "sqlsrv-finance-prod.database.windows.net",
    "database": "SalesDB",
    "tables": ["dbo.customers", "dbo.orders"],
    "credentialKVRef": "https://kv-loom.vault.azure.us/secrets/finance-sql-cdc"
  },
  "target": {
    "lakehouseId": "finance-lakehouse",
    "tablePrefix": "raw_sales_",
    "deltaProperties": {"delta.enableChangeDataFeed": "true"}
  },
  "triggerIntervalSeconds": 30,
  "schemaEvolution": "auto-union",
  "enabled": true
}
```

## Per-boundary behavior

| Boundary | Compute | Event Hubs Kafka | Spark Streaming |
|---|---|---|---|
| Commercial / GCC | Container Apps | ✅ | Databricks |
| GCC-High / IL4 | AKS | ✅ | Databricks classic |
| IL5 (v1.1) | AKS | ✅ | Databricks classic |

All Gov boundaries have Event Hubs + Databricks (classic clusters)
authorized.

## Honest gaps

- **First-touch setup UX** harder than Fabric's "click to mirror" —
  customer configures Debezium connector + Spark job parameters; v1
  ships templated configs per source type; v1.1 polishes UX
- **Snowflake source has no native Debezium** — custom poller is
  more fragile; document operational expectations openly
- **Latency** — sub-minute steady-state matches Fabric's typical; sub-
  second possible via partner streaming but harder than Fabric's
  managed-path

## Forward migration

When Fabric Mirroring lands in Gov, customers can keep Loom Mirroring
running OR switch per-source. Since both write Delta to the same
logical lakehouse path (via OneLake shortcut), switching is per-source
case-by-case.

## Related

- ADR: [fiab-0006 Mirroring engine](../adr/0006-mirroring-engine.md)
- Build PRP: PRP-07 — `apps/fiab-mirroring-engine/`
- Service docs: [Mirroring Engine service](../services/mirroring-engine.md)
- Tutorial: [Tutorial 06 — Mirroring from Cosmos DB to Lakehouse](../tutorials/06-mirroring-cosmos.md)
- Runbook: [Mirroring CDC lag](../runbooks/mirroring-cdc-lag.md)
