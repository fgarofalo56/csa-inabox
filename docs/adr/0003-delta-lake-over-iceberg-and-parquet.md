---
status: accepted
date: 2026-04-19
deciders: csa-inabox platform team
consulted: security, governance, dev-loop
informed: all
---

# ADR 0003 — Delta Lake over Iceberg and Parquet as canonical table format

## Context and Problem Statement

The medallion lakehouse stores Bronze/Silver/Gold tables on ADLS Gen2. We
must pick a single canonical table format to unify reads and writes across
Databricks Spark, dbt, Synapse SQL serverless, and ad-hoc DuckDB analysis.
The choice materially affects query performance (statistics + data-skipping),
ACID guarantees (concurrent writes during MERGE operations), Purview lineage,
and eventual compatibility with Microsoft Fabric OneLake.

## Decision Drivers

- **Microsoft Fabric OneLake compatibility** — Fabric's native table format
  is Delta; selecting Delta aligns with the strategic target (ADR-0010).
- **Databricks-native optimizations** — Photon + Delta Caching + Liquid
  Clustering deliver the best price/performance on our primary engine.
- **ACID MERGE semantics** — CDC and SCD2 patterns in dbt and ADF pipelines
  require atomic upserts; plain Parquet does not provide this.
- **Governance** — Purview, Unity Catalog, and Fabric OneLake all read Delta
  transaction logs for lineage and classification propagation.
- **Open-source interoperability** — Delta has an open spec + Delta-RS
  client so non-Spark readers (DuckDB, Polars, Trino) can consume tables.

## Considered Options

1. **Delta Lake (chosen)** — Open spec, ACID, Databricks-native, Fabric
   OneLake-native, mature dbt adapter, Purview-aware.
2. **Apache Iceberg** — Open spec, strong engine-neutrality story (Snowflake,
   Trino, Athena), excellent schema-evolution semantics.
3. **Apache Hudi** — ACID upserts, strong CDC story, smaller Azure ecosystem.
4. **Raw Parquet + Hive metastore** — Simplest; no ACID; data-skipping via
   metastore stats only.

## Decision Outcome

Chosen: **Option 1 — Delta Lake** for all Silver and Gold tables. Bronze
may remain as landed raw files (Parquet/JSON/CSV) until promotion.

## Consequences

- Positive: Native on Databricks + Fabric OneLake; minimal adapter surface.
- Positive: ACID MERGE, time travel, Z-ORDER / Liquid Clustering, and OPTIMIZE
  are available without extra tooling.
- Positive: Purview + Unity Catalog automatically discover Delta tables and
  propagate classifications.
- Positive: Open spec + Delta-RS enable DuckDB/Polars analysis in the dev
  loop without a Spark cluster.
- Negative: Engine-neutrality is weaker than Iceberg outside the
  Azure/Databricks/Fabric ecosystem (e.g., Snowflake's Iceberg support is
  more mature than its Delta support).
- Negative: Delta Uniform (Iceberg compatibility layer) is available but
  adds a metadata-sync cost; we do not enable it by default.
- Negative: Small-file problems require regular OPTIMIZE jobs; mitigated by
  dbt post-hooks and scheduled maintenance notebooks.
- Neutral: If a federal tenant mandates Iceberg, Delta Uniform or a one-way
  conversion path is feasible.

## Pros and Cons of the Options

### Option 1 — Delta Lake
- Pros: Databricks + Fabric native; ACID; Z-ORDER; open spec; Delta-RS;
  mature dbt adapter; Purview-aware.
- Cons: Weaker non-Azure engine parity vs. Iceberg; OPTIMIZE overhead.

### Option 2 — Apache Iceberg
- Pros: Engine-neutral; strong schema evolution; hidden partitioning;
  first-class in Snowflake/Trino/Athena.
- Cons: Not native to Databricks (as of decision date); Fabric OneLake
  does not write Iceberg natively; Purview lineage is weaker.

### Option 3 — Apache Hudi
- Pros: Strong CDC and upsert semantics; merge-on-read tables for low-latency
  ingestion.
- Cons: Smaller Azure ecosystem; no Fabric native story; fewer engineers
  fluent in operations.

### Option 4 — Raw Parquet
- Pros: Simplest; zero lock-in; every engine reads it.
- Cons: No ACID; no time travel; compaction is manual; CDC requires custom
  patterns; stats live in an external metastore.

## Validation

We will know this decision is right if:
- All Silver and Gold tables in vertical examples are Delta within one
  quarter of onboarding.
- Purview lineage coverage for Delta tables exceeds 95% of the catalog.
- If a tenant's consumer stack is Snowflake-primary and Delta performance
  is materially worse than Iceberg, revisit with Delta Uniform as the
  compromise.

## References

- Decision tree:
  [Delta vs. Iceberg vs. Parquet](../decisions/delta-vs-iceberg-vs-parquet.md)
- Related code: `domains/shared/dbt/dbt_project.yml` (materialization
  defaults), `deploy/bicep/DLZ/modules/databricks/databricks.bicep` (Unity
  Catalog), `domains/shared/pipelines/adf/pl_ingest_to_bronze.json`
- Framework controls: NIST 800-53 **SC-28** (Delta log integrity via ADLS
  encryption at rest), **AU-10** (non-repudiation via time travel / version
  history), **CP-9** (backup via time-travel retention). See
  `governance/compliance/nist-800-53-rev5.yaml`.
- Discussion: CSA-0087
