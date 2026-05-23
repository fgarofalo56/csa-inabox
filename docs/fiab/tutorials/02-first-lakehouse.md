# Tutorial 02 — First lakehouse + Delta tables

Create a Bronze Delta table from sample data and run a Spark transform
into Silver. **30 minutes.**

## Prerequisites

- Workspace from [Tutorial 01](01-first-workspace.md)
- Console open on the workspace home

## Steps

### 1. Open the Lakehouse pane

Click **Lakehouse** in the workspace left rail. You see an empty
Files + Tables panes.

### 2. Upload sample data

Click **Files → Upload**. Choose a CSV or Parquet sample file (e.g.,
NOAA daily weather sample from
`examples/fiab-quickstart/data/noaa-daily-2025-01.csv`).

File appears in `Files/` panel. Path: `<workspace>/<lakehouse>/Files/noaa-daily-2025-01.csv`.

### 3. Open a notebook

Click **Notebook** in left rail. Click **+ New Notebook**:
- Name: `bronze-ingest`
- Language: PySpark
- Cluster: select default cluster (Loom Console pre-configured)

The notebook opens in an iframe (Databricks UI).

### 4. Create a Bronze table

In the first cell:

```python
# Read the uploaded CSV
df = spark.read.csv(
  "abfss://<container>@<storage-account>.dfs.core.windows.net/Files/noaa-daily-2025-01.csv",
  header=True,
  inferSchema=True
)

# Write as Bronze Delta table
df.write.format("delta") \
  .mode("overwrite") \
  .saveAsTable("noaa_bronze_daily")

print(f"Bronze table created with {df.count()} rows")
```

Run the cell (Shift+Enter). After ~30 s, table appears in the
Lakehouse Tables panel.

### 5. Verify in Console

Navigate back to **Lakehouse** pane. Refresh. You see
`noaa_bronze_daily` in the Tables list with:
- Row count
- Schema
- Sample 10 rows
- Sensitivity labels (none yet)

### 6. Transform Bronze → Silver

Back in the notebook, add a second cell:

```python
from pyspark.sql.functions import col, to_date, when

silver_df = (
  spark.table("noaa_bronze_daily")
  .withColumn("date", to_date("date_str"))
  .withColumn("temperature_c", col("temp_f") - 32) * 5/9)
  .filter(col("temp_f").isNotNull())
)

silver_df.write.format("delta") \
  .mode("overwrite") \
  .partitionBy("date") \
  .saveAsTable("noaa_silver_daily")

print(f"Silver table: {silver_df.count()} rows, partitioned by date")
```

Run the cell. ~20-60 s depending on data size.

### 7. Query via SQL Analytics Endpoint

Navigate to the **Warehouse** pane. The newly created tables appear
in the schema explorer (refresh if needed).

Run:
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

Results appear in the bottom pane.

### 8. Catalog the tables

Navigate to **Catalog** pane. You see both tables. Click
`noaa_silver_daily`:
- Add description: "NOAA daily weather, Silver layer"
- Add tag: `domain: weather`
- Add column descriptions

The Console writes to UC (Commercial) or Purview (Gov) — same UX.

## What's next

- [Tutorial 03 — Direct Lake parity](03-direct-lake-parity.md) —
  build a semantic model over your Silver table
- [Tutorial 04 — Activator rules](04-activator-rules.md) — alert on
  weather extremes

## Cleanup

- In the notebook: `DROP TABLE noaa_bronze_daily;`
- In the notebook: `DROP TABLE noaa_silver_daily;`
- Or delete the workspace per [Tutorial 01](01-first-workspace.md) §6

## Troubleshooting

- Notebook can't read CSV path: verify Databricks workspace identity
  has Storage Blob Data Contributor on the workspace ADLS account
- Slow query in Warehouse pane: cluster cold-start; try again after
  30 s
