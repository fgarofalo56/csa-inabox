# Loom Mirroring Engine

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


Fabric Mirroring parity. OSS Debezium + Spark Structured Streaming
+ Delta MERGE. Honors Open Mirroring landing-zone protocol so
partner publishers (SAP / Qlik / Striim / Informatica) work
unchanged.

**Status**: SCAFFOLDED. Real implementation per [PRP-07](../../PRPs/active/csa-loom/PRP-07-mirroring-engine.md)
+ [ADR fiab-0006](../../docs/fiab/adr/0006-mirroring-engine.md).

## Tech stack

- Debezium Connect runtime (Kafka Connect — Java)
- Per-source Debezium connectors (SQL Server, Postgres, MySQL,
  Oracle, Cosmos via Spark connector, Snowflake custom poller)
- Azure Event Hubs (Kafka protocol surface) as transport
- Spark Structured Streaming on Databricks for MERGE INTO Delta
- Cosmos DB for watermarks + schema-evolution log
- Container App (Commercial / GCC) or AKS workload (GCC-H / IL5)

## Open Mirroring landing-zone protocol

Identical to Fabric's:
- Path: `<ADLS>/landing-zone/<schema>/<table>/`
- `_metadata.json` declares `keyColumns`
- 20-digit zero-padded sequence files (`00000000000000000001.parquet`)
- `__rowMarker__` column: 1=INSERT, 2=UPDATE, 3=DELETE

## Scaffolded structure

```
apps/fiab-mirroring-engine/
├── README.md
├── Dockerfile
├── connectors/
│   ├── debezium-azure-sql.json
│   ├── debezium-postgres.json
│   ├── debezium-mysql.json
│   ├── debezium-sqlserver.json
│   ├── debezium-oracle.json
│   ├── cosmos-spark-cdc.json
│   └── snowflake-streams-poller.yaml
├── spark-streaming/
│   ├── replicator-job.py            # MERGE INTO Delta logic
│   └── landing-zone-watcher.py      # for Open Mirroring path
├── helm/                             # AKS Helm chart
└── tests/
```

## Sources covered (v1)

- Azure SQL DB / Azure SQL MI (Debezium SQL Server)
- Postgres (Debezium Postgres / logical replication)
- MySQL (Debezium MySQL / binlog)
- Cosmos DB NoSQL (Azure Cosmos Spark connector)
- SQL Server 2016-2025 (Debezium SQL Server + SHIR for on-prem)
- Snowflake (custom poller via streams API)
- Oracle (Debezium Oracle + LogMiner)
- SAP / partner-published Parquet (Open Mirroring landing-zone watcher)

## Related

- [Mirroring Engine service docs](../../docs/fiab/services/mirroring-engine.md)
- [Mirroring parity workload](../../docs/fiab/workloads/mirroring-parity.md)
- [PRP-07](../../PRPs/active/csa-loom/PRP-07-mirroring-engine.md)
- [Mirroring CDC lag runbook](../../docs/fiab/runbooks/mirroring-cdc-lag.md)
