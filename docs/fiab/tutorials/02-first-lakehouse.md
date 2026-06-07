# Tutorial 02 — First lakehouse + Delta tables

Upload sample data into a lakehouse, query it with Synapse Serverless,
and write a Silver Delta table from a notebook. **30 minutes.**

## Prerequisites

- Workspace from [Tutorial 01](01-first-workspace.md)
- Console open on the workspace home

## How navigation works

Loom uses **top-level left-nav surfaces** (Home, Workspaces, Browse,
OneLake catalog, Unified catalog, Lineage, Data agents, Monitor, …) plus
a **flat item tree inside each workspace**. Item types are not
per-workspace "panes" — you create them with the workspace's **New item**
button, and each one opens as an editor at `/items/<type>/<id>`.

## Steps

### 1. Open your workspace

Left nav → **Workspaces** → click your workspace row. You land on
`/workspaces/<id>` with a flat item tree (folders first, then items,
sorted alphabetically). It's empty for a new workspace.

### 2. Create a lakehouse

Workspace header → **New item** → category **Data Engineering** →
**Lakehouse**. Give it a name and click **Create**. You land on the
Lakehouse editor at `/items/lakehouse/<id>`.

### 3. Pick a container

The editor's left panel shows the ADLS Gen2 container tree (loaded from
`/api/lakehouse/containers`). Pick a container — this is the Azure-native
Delta store backing the lakehouse. No Fabric/OneLake workspace is
required.

### 4. Upload sample data

Toolbar → **Upload file**. Choose a CSV or Parquet sample (e.g. the NOAA
daily weather sample from
`examples/fiab-quickstart/data/noaa-daily-2025-01.csv`). The file appears
in the tree and a success toast shows `Uploaded <name> at HH:MM:SS`.

### 5. Preview the file

Click the uploaded file. The editor auto-populates the **SQL** tab with a
Synapse Serverless `OPENROWSET` template for that file. Switch to the
**Preview** tab to render the first 100 rows (served by
`/api/lakehouse/preview`).

### 6. Query it with Serverless SQL

Switch to the **SQL** tab. Adjust the generated `OPENROWSET` query if
needed and click **Run** (calls `POST /api/items/lakehouse/<id>/query`,
which executes against Synapse Serverless). Results render in the grid.

### 7. Open the file in a notebook

Right-click the uploaded file → **Open in notebook**. This opens a new
Notebook editor (`/items/notebook/new?lakehouse=…&path=…`) prefilled with
Spark code that loads the file and writes a Delta table. A representative
Bronze cell:

```python
df = spark.read.csv(
  "abfss://<container>@<storage-account>.dfs.core.windows.net/Files/noaa-daily-2025-01.csv",
  header=True,
  inferSchema=True,
)

df.write.format("delta").mode("overwrite").saveAsTable("noaa_bronze_daily")
print(f"Bronze table created with {df.count()} rows")
```

Run the cell (the notebook executes against the compute backend via
`POST /api/items/notebook/<id>/run-cell`). The Delta table lands in the
lakehouse `Tables/` prefix.

### 8. Verify the Bronze table

Return to the Lakehouse editor and open the **Tables** tab (it lists the
`Tables/` prefix via `/api/lakehouse/paths`). `noaa_bronze_daily` appears.

### 9. Transform Bronze → Silver

Back in the notebook, add a second cell to clean and partition the data:

```python
from pyspark.sql.functions import col, to_date

silver_df = (
  spark.table("noaa_bronze_daily")
  .withColumn("date", to_date("date_str"))
  .withColumn("temperature_c", (col("temp_f") - 32) * 5 / 9)
  .filter(col("temp_f").isNotNull())
)

silver_df.write.format("delta") \
  .mode("overwrite") \
  .partitionBy("date") \
  .saveAsTable("noaa_silver_daily")

print(f"Silver table: {silver_df.count()} rows, partitioned by date")
```

Run the cell. The Silver table appears in the lakehouse **Tables** tab.

### 10. Aggregate over Silver

In the Lakehouse **SQL** tab, `OPENROWSET` (or `SELECT` against the
registered table) the Silver data for a monthly rollup:

```sql
SELECT
  YEAR(date) AS year,
  MONTH(date) AS month,
  COUNT(*) AS days_recorded,
  AVG(temperature_c) AS avg_temp_c
FROM noaa_silver_daily
GROUP BY YEAR(date), MONTH(date)
ORDER BY year, month
```

Click **Run**. Results render in the grid. There is no separate
"Warehouse" surface to switch to — Serverless SQL is built into the
lakehouse editor.

### 11. Catalog the tables

Left nav → **Unified catalog**. Find both tables. Open
`noaa_silver_daily` and add a description, tags (e.g. `domain: weather`),
and column descriptions. The catalog writes to UC (Commercial) or Purview
(Gov) — same UX.

## What's next

- [Tutorial 03 — Direct Lake parity](03-direct-lake-parity.md) —
  build a Power BI model over your Silver table
- [Tutorial 04 — Activator rules](04-activator-rules.md) — alert on
  weather extremes

## Cleanup

- In the notebook: `spark.sql("DROP TABLE noaa_bronze_daily")`
- In the notebook: `spark.sql("DROP TABLE noaa_silver_daily")`
- Or delete the workspace per [Tutorial 01](01-first-workspace.md) §6

## Troubleshooting

- Notebook can't read the path: verify the compute identity has Storage
  Blob Data Contributor on the workspace ADLS account
- Empty container tree: confirm the Console UAMI has Storage Blob Data
  Reader on the storage account behind the lakehouse
