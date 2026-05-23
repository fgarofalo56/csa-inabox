# fiab-0006: Mirroring engine via Debezium + Spark Structured Streaming + Delta MERGE

**Status:** Accepted
**Date:** 2026-05-22
**Locked decision ref:** LD-9

## Context

CSA Loom needs Fabric Mirroring parity: zero-ETL near-real-time CDC
from operational databases into the Loom lakehouse as Delta tables.
Fabric GA sources as of 2026-05-22: Azure SQL DB, Azure SQL MI,
SQL Server 2016-2025, Cosmos DB, Azure DB for PostgreSQL, Snowflake,
Oracle, SAP Datasphere, Fabric SQL DB.

Fabric exposes the **Open Mirroring landing-zone protocol** publicly
so partners can drop Parquet files with a documented `__rowMarker__`
column directly into a landing zone path — Fabric's replicator picks
them up and MERGEs into Delta. This is the partner-extensible
ingestion path (Qlik, Striim, Informatica IDMC, SNP Glue for SAP,
Theobald Xtract Universal).

Per `temp/fiab-research/03-fabric-only-internals.md §5`, this is
**tractable OSS territory** — per-source CDC is well-trodden
(Debezium has connectors for SQL Server, Postgres, MySQL, Oracle;
Cosmos DB Spark connector handles change feed; Snowflake streams API
exists), and writing Delta MERGE INTO logic in Spark Structured
Streaming is standard.

Three approaches considered:
1. **OSS Debezium + Spark Structured Streaming + Delta MERGE** —
   portable, debuggable, source-supported, customer can inspect every
   connector log
2. **Build our own simplified CDC framework** — tighter Console
   integration; engineering cost
3. **Wrap Azure Data Factory CDC + Mapping Data Flows** — native
   Azure; managed; slower

## Decision

**OSS Debezium + Spark Structured Streaming + Delta MERGE.** With
honor of Fabric's Open Mirroring publisher contract so partner
publishers can drop Parquet directly.

Implemented as `apps/fiab-mirroring-engine/` — Container App
(Commercial / GCC) or AKS workload (GCC-High / IL5).

Source connectors:

| Source | Mechanism |
|---|---|
| Azure SQL DB / Azure SQL MI | Debezium SQL Server connector (reads CDC tables) |
| Postgres | Debezium Postgres connector (logical replication) |
| MySQL | Debezium MySQL connector (binlog) |
| Cosmos DB | Azure Cosmos Spark connector (change feed) |
| Snowflake | Custom poller via Snowflake streams API |
| Oracle | Debezium Oracle connector (LogMiner) |
| SQL Server 2016-2025 on-prem | Debezium SQL Server + Self-Hosted IR for network connectivity |
| SAP / Snowflake / Oracle via partner publishers | Open Mirroring landing-zone protocol — partner writes Parquet directly |

Transport: **Event Hubs** (Kafka protocol surface — Debezium emits
Kafka topics; Event Hubs accepts them natively).

Replicator: **Spark Structured Streaming job on Databricks** that
reads Event Hubs + landing zone, parses CDC envelope, MERGE INTOs
target Delta with idempotency.

Idempotency: per-row `last_op_id` in Delta + watermarks in Cosmos DB.

Schema evolution: auto-union new columns; manual recreate for drops.

Open Mirroring landing-zone protocol (identical to Fabric's):
- Path: `<ADLS>/landing-zone/<schema>/<table>/`
- `_metadata.json` declares `keyColumns`
- 20-digit zero-padded sequence file names
- `__rowMarker__` column with 1=INSERT, 2=UPDATE, 3=DELETE semantics

## Consequences

### Positive

- Portable + debuggable — customer can read every Debezium connector
  log and Spark Streaming job log
- Source-supported — Debezium has active community + commercial
  backing (Red Hat); Spark Structured Streaming is industry standard
- Honors Fabric's Open Mirroring publisher contract — partner
  publishers (Qlik, Striim, Informatica, SAP-side connectors)
  already support this protocol; they "just work" against Loom
- Sub-minute steady-state latency matches Fabric
- Forward-migration friendly — when Fabric Mirroring lands in Gov,
  customers can switch per-source (Cosmos / SQL / Postgres / Snowflake /
  Oracle already GA in Fabric); keep Loom Mirroring for sources
  Fabric doesn't yet cover

### Negative

- First-touch setup UX is harder than Fabric's "click to mirror" —
  customer configures Debezium connector + Spark job parameters;
  v1 ships templated configs per source type; v1.1 polishes UX
- Snowflake source has no native Debezium — custom poller is more
  fragile; document operational expectations openly
- Operating a Debezium Connect runtime + Spark Streaming jobs adds
  complexity vs Fabric's managed service
- Backpressure handling under high CDC volume requires Spark Streaming
  trigger interval tuning

### Neutral

- Open Mirroring publisher SDK (Python + .NET) deferred to v1.1
  (PRP-108) — partners using existing SDKs (Qlik / Striim) just work
- Latency at 5-15 s steady-state with default 30-s trigger interval;
  configurable down to 5-s trigger for lower latency

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Build our own simplified CDC framework | Reinvents the wheel; less community support; harder for customer to debug |
| Wrap ADF CDC + Mapping Data Flows | Slower latency than Spark Streaming; doesn't match Open Mirroring publisher contract; harder to extend to non-Microsoft sources |
| Use Azure Synapse Link directly | Only covers Cosmos DB + Azure SQL DB; Synapse Link to Snowflake / Oracle / SAP doesn't exist |
| Native SQL Server CDC into Parquet (no Debezium) | Works only for SQL Server 2025+; misses older SQL Server, Postgres, MySQL, Cosmos, Snowflake, Oracle |

## References

- PRD: [`temp/fiab-prd/05-workload-parity.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/05-workload-parity.md) §5.8, [`06-custom-apps.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/06-custom-apps.md) §6.4
- Amendments: [`temp/fiab-prd/AMENDMENTS.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/AMENDMENTS.md) §A10
- Research: [`temp/fiab-research/03-fabric-only-internals.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-research/03-fabric-only-internals.md) §5
- External: [Microsoft Learn — Open Mirroring landing-zone format](https://learn.microsoft.com/fabric/mirroring/open-mirroring-landing-zone-format), [Debezium docs](https://debezium.io/documentation/)
- Build: PRP-07 — `apps/fiab-mirroring-engine/`
