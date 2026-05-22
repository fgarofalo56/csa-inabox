# Data Warehouse parity

## What Fabric does

Fabric Warehouse runs on the Polaris distributed SQL engine —
stateless, horizontally elastic, full T-SQL DML (INSERT / UPDATE /
DELETE / MERGE) over Delta on OneLake. Claims up to 1024 concurrent
queries; sub-second query SLA on warm data. Cross-warehouse and
cross-lakehouse queries via 3-/4-part naming. AI Functions in T-SQL
(sentiment, classification, translation, summarization) ship in
March 2026.

## CSA Loom parity design

Two surfaces by boundary:

| Boundary | Primary | Why |
|---|---|---|
| Commercial / GCC | **Databricks SQL Warehouse** (Serverless / Pro / Classic) | Closest to Polaris's T-SQL DML over Delta + horizontal elasticity; Photon engine; aggressive query cache |
| GCC-High / IL4 / IL5 | **Synapse Serverless SQL Pool** | Databricks SQL Warehouse not available in `usgovaz/usgovva`; Synapse Serverless is always-on, no cold-start cost |

### Databricks SQL Warehouse (Commercial)

- Photon engine; serverless tier scales automatically
- Full T-SQL-equivalent on Delta: INSERT / UPDATE / DELETE / MERGE
- Cross-table ACID via Delta transactions
- Cross-catalog queries via three-level naming (UC) — equivalent to
  Fabric's 3-part naming
- Disk + memory + result caches
- Loom Console "Warehouse" pane embeds the Databricks SQL editor

### Synapse Serverless SQL (Gov)

- Read-only T-SQL over Delta and Parquet
- External tables + views over ADLS Gen2 paths
- Cross-warehouse queries via DEFINE / OPENROWSET patterns
- No write path through Serverless (writes happen through Databricks
  classic Spark → Delta)
- Loom Console "Warehouse" pane uses the existing Synapse Studio
  query editor embed

### Materialized views

- **Commercial**: Databricks SQL materialized views (auto-refresh
  on schedule or commit)
- **Gov**: Synapse Serverless `EXTERNAL TABLE` over pre-aggregated
  Delta tables maintained by Databricks notebooks

### AI Functions in SQL

| Capability | Commercial | Gov |
|---|---|---|
| sentiment / classify / translate / summarize | Databricks SQL `ai_query()` | Databricks notebook UDF calling AOAI direct (gpt-4o in usgovvirginia) |

`ai_query` is Commercial-only per `research/02-gov-boundary-
availability.md §7.1`.

### Copilot for Warehouse

NL→SQL via Loom Data Agents (see [Data Agents parity](data-agents-parity.md));
embedded in the Console Warehouse pane.

## Per-boundary behavior

| Boundary | T-SQL DML over Delta | Cross-warehouse joins | `ai_query` |
|---|---|---|---|
| Commercial | ✅ Databricks SQL Warehouse | ✅ UC 3-level names | ✅ |
| GCC | ✅ Databricks SQL Warehouse | ✅ UC 3-level names | ✅ |
| GCC-High / IL4 | ❌ (Synapse Serverless read-only; writes via Databricks Spark) | ⚠ via external tables | ❌ (notebook + AOAI direct) |
| IL5 (v1.1) | Same as IL4 | Same | Same |

## Honest gaps

- **No sub-second cold-start in Synapse Serverless** comparable to
  Polaris's claimed sub-second. Synapse Serverless has cold-start of
  seconds; Polaris claims sub-second.
- **`ai_query` in Gov**: not available. Substitute via Databricks
  notebook + AOAI direct (slower; harder to invoke from a SQL query).
- **Cross-warehouse joins through 4-part names**: Synapse Serverless
  supports cross-database joins inside one workspace; cross-workspace
  requires Synapse Link or explicit external table setup. Fabric's
  4-part is more transparent.

## Forward migration

- Warehouse schemas migrate via T-SQL DDL → Fabric Warehouse `CREATE
  TABLE`
- Delta data via OneLake shortcut (zero data movement)
- dbt models — zero rewrite (dbt-fabric adapter mature)

## Related

- ADR: [fiab-0002 Hybrid compute](../adr/0002-compute-hybrid.md)
- Build PRP: PRP-03 (Console Warehouse pane)
- Tutorial: TBD — author warehouse via Loom Console
- Parent: [Azure Synapse Guide](../../guides/azure-synapse.md)
