# Tutorial 03 — Direct Lake parity (warm-cache materializer)

Author a TMDL semantic model over the Silver table from
[Tutorial 02](02-first-lakehouse.md), configure the Direct-Lake-Shim
refresh policy, build a Power BI report. **45 minutes.**

!!! warning "Shipped vs. roadmap (2026-06-06)"
    The **`loom-dl-shim` / `loom-semantic-model` CLIs and the TMDL/XMLA shim
    described here do NOT exist.** The shipped way to publish a model is the
    item's **Weave → “Build a Power BI model”** edge (it reads a warehouse table
    or a custom SQL query and creates a real Power BI **push dataset** — no XMLA).
    See [`direct-lake-parity`](../workloads/direct-lake-parity.md). The CLI steps
    below are roadmap design, not the current product.

## Prerequisites

- Workspace + `noaa_silver_daily` Silver table from Tutorial 02
- Power BI Desktop installed (or Loom Console Semantic Model designer
  if v1.1+)
- Power BI Premium F-SKU (Gov-H / IL5) or P-SKU (GCC) workspace
  attached to your Loom workspace

## Steps

### 1. Author the TMDL semantic model

Open Power BI Desktop → File → New → Composite model.

Add connection:
- Type: Synapse Serverless SQL (Gov) or Databricks SQL Warehouse (Commercial)
- Endpoint: from Loom Console "Warehouse" pane (Copy connection string)
- Database: `<workspace>_loom_silver`
- Tables: `noaa_silver_daily`

Save as `noaa-semantic-model.pbip` (project format, TMDL underneath).

### 2. Build a basic model

In Power BI Desktop Modeling view:
- Mark `date` as Date column
- Create a Date dimension table (auto-generated from Modeling →
  New Table)
- Add measures:
  ```
  Avg Temperature = AVERAGE(noaa_silver_daily[temperature_c])
  Days Recorded = COUNT(noaa_silver_daily[date])
  ```

Commit `.pbip` files to Git (`docs/fiab/tutorials/_examples/03-tmdl/`).

### 3. Configure Direct-Lake-Shim refresh policy

Loom Console → **Semantic Models** (v1.1) OR CLI in v1:

```bash
# v1 CLI
loom-dl-shim configure \
  --semantic-model noaa-semantic-model \
  --table noaa_silver_daily \
  --refresh-policy partition \
  --partition-column date
```

This tells the Direct-Lake-Shim service to:
- Subscribe to Event Grid notifications on the `noaa_silver_daily`
  table's `_delta_log/*.json`
- On each commit, identify the affected partition (date)
- Issue TOM partition refresh against the Power BI semantic model

### 4. Deploy to Power BI Premium workspace

```bash
loom-semantic-model deploy \
  --pbip noaa-semantic-model.pbip \
  --workspace-id <power-bi-workspace-id>
```

Or use Power BI service "Get data → Power BI Project (.pbip)".

### 5. Build a Power BI report

In Power BI Desktop, switch to Report view:
- Add a line chart: X-axis Date, Y-axis Avg Temperature
- Add a card: Days Recorded
- Save + publish to the Loom Power BI workspace

### 6. Test the freshness

Back in the Loom notebook:

```python
# Add a new partition to Silver
new_data = spark.createDataFrame([
  ("2026-05-15", "ABC123", "WeatherStation X", 75.0),
], schema=["date_str", "station_id", "station_name", "temp_f"])

silver_new = (
  new_data
  .withColumn("date", to_date("date_str"))
  .withColumn("temperature_c", (col("temp_f") - 32) * 5/9)
)

silver_new.write.format("delta") \
  .mode("append") \
  .saveAsTable("noaa_silver_daily")
```

Run. Note the time.

### 7. Verify the semantic model refreshes

In the Power BI report, refresh the dataset. The Direct-Lake-Shim
should have triggered a partition refresh within 5-30 seconds of
your write.

Check refresh time:
- Power BI workspace → Dataset settings → Refresh history

You should see a partition refresh for the `2026-05-15` partition
within seconds of the Spark write.

### 8. Verify in Loom Console

Console **Monitoring → Direct-Lake-Shim**:
- Latency p50, p95 for the recent refresh
- Refresh history

Latency target: 5-30 s (per [Direct Lake parity](../workloads/direct-lake-parity.md)).

## The honest gap

This is **not Fabric's native Direct Lake sub-second freshness**.
You're seeing 5-30 s instead. Document this in your customer
expectations. When Fabric Gov GA arrives, re-author the model with
Direct Lake on OneLake storage mode → sub-second freshness.

## What's next

- [Tutorial 05 — Data Agent over Lakehouse](05-data-agent.md) —
  natural-language Q&A over your semantic model
- [Direct Lake parity workload page](../workloads/direct-lake-parity.md) —
  full mechanics

## Cleanup

- Delete the Power BI report + dataset
- Run `loom-dl-shim unconfigure --semantic-model noaa-semantic-model`
- Drop the Silver table from notebook
