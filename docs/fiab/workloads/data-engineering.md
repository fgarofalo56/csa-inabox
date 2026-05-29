# Data Engineering parity

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


## What Fabric does

Fabric Data Engineering = Lakehouse item + Spark notebooks +
Environments + Materialized Lake Views + User Data Functions.
Lakehouse combines `Files/` (raw) + `Tables/` (Delta managed) with
an auto-provisioned SQL Analytics Endpoint. Spark Runtime 1.x/2.0
runs Apache Spark 4.x + Delta Lake 4.x with the Native Execution
Engine (NEE) — a C++ vectorized engine for ~2× perf on many
operators.

## CSA Loom parity design

### Lakehouse

ADLS Gen2 container per workspace + UC managed catalog (Commercial /
GCC) or Hive metastore (Gov). Console "Lakehouse" pane surfaces
both `Tables/` (Delta + UC/Hive) and `Files/` (raw browsable).

### Spark compute

**Azure Databricks Premium workspace per DLZ:**

| Boundary | Runtime |
|---|---|
| Commercial / GCC | Databricks Runtime 16.4 LTS+ with Photon, UC managed, serverless compute |
| GCC-High / IL5 | Databricks Runtime 16.4 LTS+ classic clusters with Hive metastore (no UC, no Photon-via-SQL Warehouse, but Photon-on-classic-cluster pending verification) |

Photon is the Databricks-proprietary C++ vectorized engine — closest
equivalent to Fabric's NEE.

### Notebooks

Loom Console "Notebook" pane embeds the Databricks notebook UI via
iframe with SSO via Entra. Notebook content stored in Databricks
Repos linked to Azure DevOps / GitHub for CI/CD.

### Environments

Custom Databricks compute policies + cluster init scripts + library
installations declared as Bicep. Each workspace gets a `default`
cluster policy; admins author additional environments.

### Materialized Lake Views (MLVs) parity

| Boundary | Implementation |
|---|---|
| Commercial | Databricks Delta Live Tables (DLT) with declarative dependency tracking |
| Gov | Scheduled Databricks Jobs that `CREATE OR REPLACE TABLE` + `OPTIMIZE` |

Loom Console "Materialized Views" sub-pane authors + schedules these.

### User Data Functions

Serverless Python functions via **Azure Functions** (Premium EP1 in
Gov; Flex Consumption in Commercial). Console pane exposes UDF CRUD;
Variable Library + Key Vault integration matches Fabric.

### dbt Core

`docs/adr/0008-dbt-core-over-dbt-cloud.md` parent ADR holds; Loom
inherits dbt Core. Models run inside Databricks Workflows or via
ADF dbt activity.

## Per-boundary behavior

| Boundary | Spark | UC managed | DLT |
|---|---|---|---|
| Commercial | Photon ✅ | ✅ | ✅ |
| GCC | Photon ✅ | ✅ | ✅ |
| GCC-High / IL4 | classic (Photon-on-cluster TBD) | ❌ Hive only | ❌ scheduled Jobs |
| IL5 (v1.1) | Same as IL4 | ❌ Hive only | ❌ scheduled Jobs |

## Honest gaps

- **Native Execution Engine (NEE)** is Microsoft-proprietary; Loom
  gets Photon in Commercial — equivalent intent but different vendor
  IP. In Gov, classic Spark only — measurable perf delta (~30-50%)
  for some operations.
- **DLT automatic dependency tracking** requires Databricks Pipelines
  (Commercial only); the "scheduled Job" variant works but doesn't
  auto-detect upstream changes.

## Forward migration

- Notebooks migrate to Fabric notebooks via Git folder binding —
  bind Fabric workspace to same Git repo
- Lakehouse Delta tables → OneLake shortcut (zero data movement)
- Environments → Fabric Environments (declarative re-create)
- DLT pipelines → Fabric DF pipelines (port)

## Related

- ADR: [fiab-0002 Hybrid compute](../adr/0002-compute-hybrid.md)
- Build PRP: PRP-02 (Bicep) + PRP-03 (Console Notebook pane)
- Tutorial: [Tutorial 02 — First lakehouse + Delta tables](../tutorials/02-first-lakehouse.md)
- Parent: [Databricks Guide](../../DATABRICKS_GUIDE.md), [Databricks Best Practices](../../guides/databricks-best-practices.md)
