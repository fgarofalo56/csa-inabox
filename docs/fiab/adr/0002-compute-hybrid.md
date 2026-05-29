# fiab-0002: Hybrid compute (Databricks + Synapse Serverless + ADX)

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


**Status:** Accepted
**Date:** 2026-05-22
**Locked decision ref:** LD-2

## Context

CSA Loom needs primary compute for four workload categories:
1. Spark (notebooks, ELT, ML)
2. SQL warehouse (analytics queries, T-SQL DML, cross-warehouse joins)
3. Ad-hoc / serverless SQL over Delta
4. KQL / time-series / real-time

Microsoft Fabric ships one F-SKU capacity that covers all four
internally (Polaris for T-SQL DW, Fabric Spark for notebooks, KQL DB
for time-series, etc.). Loom cannot replicate the F-SKU billing
abstraction — but it must cover the same workload surface using
Azure-native services that are Gov-available.

The CSA-in-a-Box parent project already uses Databricks (per ADR-0002)
and Synapse + ADX (per various decision docs). Loom inherits that
foundation but needs to decide how the four workload categories map.

## Decision

**Hybrid compute by workload:**

| Workload | Primary | Backup / Gov fallback |
|---|---|---|
| Spark (notebooks + ELT + ML) | **Azure Databricks Premium** (Photon-enabled clusters in Commercial; classic clusters in Gov where UC + SQL Warehouse aren't yet GA) | n/a — Databricks is the canonical Spark |
| SQL warehouse (T-SQL DML over Delta) | **Databricks SQL Warehouse** (Commercial only) | **Synapse Serverless SQL** in Gov (read-only ad-hoc) |
| Ad-hoc / serverless SQL over Delta | **Synapse Serverless SQL** (always-on, no separate provisioning) | n/a |
| KQL / time-series / real-time | **Azure Data Explorer (Kusto)** — same engine as Fabric Eventhouse | n/a |
| BI / semantic models | **Power BI Premium** (F-SKU in GCC-H/IL5; P-SKU in GCC) | n/a |

Loom never deploys:
- Synapse Dedicated SQL Pool (deprecation-trending; Fabric Warehouse
  is the forward-compatible answer)
- HDInsight (out of scope)
- Azure ML compute clusters for primary Spark (use Databricks)

Loom **does** deploy as supporting compute:
- Azure ML managed endpoints (Gov fallback for Databricks Model
  Serving)
- AKS-hosted MLflow (Gov fallback for Databricks-managed MLflow)
- Azure Functions (User Data Functions equivalent; per-action
  dispatchers for Activator)

## Consequences

### Positive

- Best-of-breed per workload category — Databricks for Spark
  (industry-leading Photon perf); Synapse Serverless for cheap ad-hoc
  SQL over Delta (always-on, no minimum); ADX for KQL (the same
  Kusto engine Fabric Eventhouse runs on)
- Workload portability — Delta tables are the single source of truth;
  every engine reads them
- Forward-migration path is clean — Databricks tables migrate to
  Fabric via OneLake shortcut; Synapse Serverless external tables
  re-create as Fabric Warehouse; ADX databases attach as Fabric
  Eventhouse

### Negative

- More services to operate than a single Fabric F-SKU capacity
- Per-service billing instead of unified CU — Loom synthesizes a
  CU-equivalent dashboard but the bill is not unified
- In Gov, the Databricks SQL Warehouse gap (no SQL Warehouse in
  usgovaz/usgovva) means Synapse Serverless is the primary SQL
  surface, which is read-only — writes happen via Databricks Spark
- Customers expecting Fabric's "single capacity scales everything"
  must understand the per-service sizing model in Loom

### Neutral

- When UC managed reaches Gov-GA (CY2026 commitment per Databricks),
  Loom can promote Gov customers from Hive metastore + Synapse-
  Serverless-primary to UC managed + Databricks SQL Warehouse
  primary — narrowing the Gov-vs-Commercial delta

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Databricks-only (consolidated) — Databricks SQL Warehouse everywhere | Not available in Gov today; forces customer to wait for UC managed Gov-GA; misses opportunity to use Synapse Serverless's always-on no-min-cost ad-hoc surface |
| Synapse-only (Microsoft 1P-only) — Spark + Dedicated SQL + Serverless | Synapse is in maintenance posture vs Fabric; Synapse Dedicated SQL is being deprecated; misses Photon Spark's perf advantage |
| Single F-SKU equivalent (one shared compute pool) | Impossible to build with Azure-native today; no single CU model spans Spark + SQL + KQL + Power BI |
| Open-source Spark (no Databricks) | Loses Photon perf + UC; CSA parent project already decided on Databricks per ADR-0002 |

## References

- PRD: [`temp/fiab-prd/04-reference-architecture.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/04-reference-architecture.md) §4.3
- Amendments: [`temp/fiab-prd/AMENDMENTS.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/AMENDMENTS.md) §A1
- Research: [`temp/fiab-research/02-gov-boundary-availability.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-research/02-gov-boundary-availability.md) §7.1 (Databricks UC/SQL Warehouse not in Gov)
- Parent ADRs: [`docs/adr/0002-databricks-over-oss-spark.md`](../../adr/0002-databricks-over-oss-spark.md), [`docs/adr/0003-delta-lake-over-iceberg-and-parquet.md`](../../adr/0003-delta-lake-over-iceberg-and-parquet.md)
