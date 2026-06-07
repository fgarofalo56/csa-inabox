# Tutorial 03 — Build a Power BI model over your Silver table

Turn the `noaa_silver_daily` table from [Tutorial 02](02-first-lakehouse.md)
into a Power BI model with the Loom **Weave** edge, then report over it.
**30 minutes.**

## Prerequisites

- Workspace + `noaa_silver_daily` Silver table from Tutorial 02

No Fabric capacity or Power BI Premium workspace is required for the
Azure-native path. A real Power BI / Fabric workspace is opt-in only.

## How this works

The shipped way to publish a model is the item's **Weave → "Build a Power
BI model"** edge. It reads a warehouse/lakehouse table (or a custom SQL
query), infers a typed schema, and creates a Power BI **push dataset** —
no TMDL authoring, no `.pbip` project, no XMLA, and no Power BI Desktop
required. The created dataset shows up in your Loom workspace as a
`semantic-model` item.

## Steps

### 1. Open the source item

Left nav → **Workspaces** → open your workspace → in the item tree, open
the lakehouse (or warehouse) that holds `noaa_silver_daily`.

### 2. Build the Power BI model

In the item's **Weave** menu, choose **Build a Power BI model**. Pick the
table (`noaa_silver_daily`) or paste a custom SQL query to shape the
model. Confirm.

Under the hood the BFF calls `POST /api/thread/build-powerbi-model`, which:

- reads the table schema from Synapse Serverless / the lakehouse backend,
- creates a Power BI **push dataset** with typed columns, and
- seeds it with a sample of rows
  (`POST https://api.powerbi.com/v1.0/myorg/groups/<wsId>/datasets`).

### 3. Open the new semantic model

The new dataset appears in the workspace item tree as a `semantic-model`
item. Open it to load the **Semantic Model editor**, which surfaces the
dataset over the Power BI REST API and embeds the live report frame
(`PowerBIEmbedFrame`).

### 4. Build a report

From the embedded report surface, build visuals over the push dataset:

- a line chart with **date** on the X-axis and average **temperature_c**
  on the Y-axis, and
- a card showing the count of recorded days.

Save the report. It renders inline in the editor.

### 5. Push fresh rows and refresh

A push dataset takes new rows whenever code PATCHes its rows endpoint. To
demonstrate freshness, add a notebook cell that appends a row to the Silver
table and pushes it to the dataset, then refresh the report visual:

```python
from pyspark.sql.functions import col, to_date

new_data = spark.createDataFrame(
  [("2026-05-15", "ABC123", "WeatherStation X", 75.0)],
  schema=["date_str", "station_id", "station_name", "temp_f"],
)

silver_new = (
  new_data
  .withColumn("date", to_date("date_str"))
  .withColumn("temperature_c", (col("temp_f") - 32) * 5 / 9)
)

silver_new.write.format("delta").mode("append").saveAsTable("noaa_silver_daily")
```

After the push, refresh the report and the new point appears.

## The honest gap

This is a **manual push** model: rows reach the dataset when you push
them, not via sub-second framing. It is intentionally not Fabric's native
Direct Lake freshness. The 5-30 s partition-refresh design (the
Direct-Lake-Shim) is roadmap; today the push-dataset path requires an
explicit push per write. Sub-second Direct Lake freshness is available
only after forward-migration to Fabric — see
[Tutorial 08](08-forward-migrate-to-fabric.md) and the
[Direct Lake parity workload](../workloads/direct-lake-parity.md).

## What's next

- [Tutorial 05 — Data Agent over Lakehouse](05-data-agent.md) —
  natural-language Q&A over your tables and model
- [Direct Lake parity workload page](../workloads/direct-lake-parity.md)

## Cleanup

- Delete the `semantic-model` item from the workspace item tree
  (right-click → Delete), which removes the push dataset
- Drop the Silver table from the notebook if you no longer need it
