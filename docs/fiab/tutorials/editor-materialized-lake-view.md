# Tutorial: Materialized lake view editor

> CSA Loom `materialized-lake-view` editor — a persisted, auto-refreshed Delta
> view defined in **Spark SQL or PySpark** over your lakehouse, with
> data-quality constraints and cross-workspace lineage. **No Microsoft Fabric
> required.**

## What it is

A materialized lake view (MLV) is a persisted, automatically refreshed view
defined in Spark SQL or PySpark. It expresses multi-stage medallion
(bronze → silver → gold) transformations declaratively rather than as custom
Spark jobs, persisting the result as a managed Delta table that downstream
consumers query directly. In Loom the MLV rides on Azure-native ADLS Gen2 +
Delta: the definition is materialized by a Synapse Spark batch, refreshes run
via an ADF "Refresh materialized lake view" pipeline activity, and Loom tracks
cross-workspace dependency lineage in its own Cosmos store.

## When to use it

- Your medallion transformations are declarative SELECTs — an MLV replaces a
  hand-rolled Spark job + schedule.
- You want data-quality constraints enforced uniformly on every refresh.
- Downstream views depend on upstream ones and refreshes must run in
  dependency order.

## Step-by-step in Loom

1. **Create the item.** Choose **+ New item → Materialized lake view** (Data
   Engineering). The editor opens at `/items/materialized-lake-view/<id>`.
2. **Author the definition (SQL or PySpark).** Write a
   `CREATE MATERIALIZED LAKE VIEW … AS SELECT …` in the **SQL** tab, or an
   `@fmlv`-style PySpark function returning a DataFrame in the **PySpark** tab.
   Pick the target medallion container + schema + view name.
3. **Add data-quality constraints.** Declare CHECK constraints with an
   on-violation action (**FAIL** stops the refresh; **DROP** silently removes
   bad rows) so quality is enforced uniformly on every refresh.
4. **Materialize + refresh.** **Refresh** runs a Synapse Spark batch that
   executes the definition and writes the result as a managed Delta table; an
   ADF "Refresh materialized lake view" pipeline orchestrates scheduled
   refreshes.
5. **Track lineage.** Loom auto-derives source-table → MLV and MLV → MLV
   dependencies from the definition and persists them as cross-workspace
   lineage edges, so refreshes can be ordered and impact analysis is one click
   away.

## The Azure backend it rides on

- **Storage:** ADLS Gen2 + Delta (managed table output).
- **Compute:** Synapse Spark batch (materialization) + ADF pipeline activity
  (scheduled refresh).
- **Lineage:** Loom Cosmos store (dependency edges).

## No Fabric required

MLVs materialize to ADLS Delta via Synapse Spark; no Fabric capacity, OneLake,
or Fabric lakehouse is involved.

## Learn more

- Materialized lake views (parity source):
  <https://learn.microsoft.com/fabric/data-engineering/materialized-lake-views/overview-materialized-lake-view>
