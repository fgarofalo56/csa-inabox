# PRP-07 — Loom Mirroring Engine (Zero-ETL CDC Parity)

## Context

Fabric Mirroring parity: zero-ETL CDC from operational databases into
the Loom lakehouse as Delta tables. OSS Debezium + Spark Structured
Streaming + Delta MERGE per AMENDMENTS A10. Honors Fabric's Open
Mirroring publisher contract so partner publishers can drop Parquet
files directly.

PRD ref: `temp/fiab-prd/05-workload-parity.md` §5.8;
`temp/fiab-prd/06-custom-apps.md` §6.4.

## Goal

`apps/fiab-mirroring-engine/` delivers zero-ETL CDC from Azure SQL,
Azure SQL MI, SQL Server 2016-2025, Postgres, MySQL, Cosmos DB,
Snowflake, and Oracle sources into Loom lakehouse Delta tables. Open
Mirroring landing zone protocol supported for partner publishers
(SAP, etc.).

## Acceptance criteria

- [ ] Debezium Connect runtime (Kafka Connect) in Container App
  (Commercial / GCC) or AKS workload (GCC-High / IL5)
- [ ] Source connectors:
  - Azure SQL: Debezium SQL Server connector
  - Postgres: Debezium Postgres connector (logical replication)
  - MySQL: Debezium MySQL connector (binlog)
  - Cosmos DB: Azure Cosmos Spark connector (change feed)
  - Snowflake: custom poller via Snowflake streams API
  - Oracle: Debezium Oracle connector with LogMiner
  - SAP: Open Mirroring publisher landing-zone watcher
- [ ] Event Hubs (Kafka protocol surface) as the transport between
  CDC sources and Spark
- [ ] Spark Structured Streaming job on Databricks reads Event Hubs +
  landing zone, parses CDC envelope, MERGEs into Delta target
- [ ] Idempotency: per-row last_op_id in Delta metadata + watermarks
  in Cosmos DB
- [ ] Schema evolution: auto-union new columns; manual recreate for
  drops
- [ ] Open Mirroring landing-zone protocol implemented:
  - Path: `<ADLS>/landing-zone/<schema>/<table>/`
  - `_metadata.json` with `keyColumns`
  - 20-digit zero-padded sequence file names
  - `__rowMarker__` column with 1=INSERT, 2=UPDATE, 3=DELETE semantics
- [ ] Per-mirror config in Cosmos DB (source + target + cadence)
- [ ] Loom Console "Mirroring" pane (in PRP-03) provides CRUD
- [ ] Latency target: sub-minute steady-state for all sources (matches
  Fabric's typical)

## Validation gates

- E2E: deploy mirroring config → Azure SQL test source → assert Delta
  tables populate within 60s of source row changes
- Schema-evolution tests: add column to source → verify new column
  flows; drop column → verify NULL propagation
- Backpressure test: 100K rows/sec load → no data loss
- Open Mirroring test: drop synthetic Parquet files with
  `__rowMarker__` to landing zone → verify Delta MERGE applies

## Implementation outline

1. Scaffold Debezium Connect deployment manifest + connector configs
   per source type
2. Author Spark Structured Streaming job (PySpark in Databricks
   notebook checked into Git)
3. Implement landing-zone watcher (Function with Event Grid trigger)
4. Implement idempotent MERGE logic with watermark tracking
5. Per-source connector test fixtures
6. Loom Console pane → mirroring engine REST API
7. Helm chart + Container App Bicep
8. Telemetry: CDC lag per source, error rate, throughput

## File changes

```
apps/fiab-mirroring-engine/                              created
apps/fiab-mirroring-engine/connectors/                   created (per-source Debezium JSON configs)
apps/fiab-mirroring-engine/spark-streaming/              created (PySpark jobs)
apps/fiab-mirroring-engine/landing-zone-watcher/         created (Function App)
apps/fiab-mirroring-engine/Dockerfile                    created
apps/fiab-mirroring-engine/helm/                         created
platform/fiab/bicep/modules/landing-zone/mirroring-engine.bicep created
```

## Open questions / risks

- Snowflake source has no native Debezium; custom poller is fragile;
  document operational expectations openly
- First-touch setup UX is harder than Fabric's "click to mirror";
  v1 ships templated configs per source type; v1.1 polishes
- Open Mirroring publisher SDK (Python + .NET) deferred to v1.1
  (PRP-108)

## References

- `temp/fiab-prd/05-workload-parity.md` §5.8
- `temp/fiab-prd/06-custom-apps.md` §6.4
- `temp/fiab-research/03-fabric-only-internals.md` §5
- learn.microsoft.com/fabric/mirroring/open-mirroring-landing-zone-format
