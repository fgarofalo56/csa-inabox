# Tutorial: Migrate Dataflow Pipeline to ADF + dbt

**A hands-on, step-by-step walkthrough for data engineers migrating Google Cloud Dataflow (Apache Beam) pipelines to Azure Data Factory with dbt transforms, and Event Hubs + Stream Analytics for streaming workloads.**

**Estimated time:** 3-5 hours per pipeline
**Difficulty:** Intermediate to Advanced
**GCP experience assumed:** Dataflow, Apache Beam SDK (Python or Java), Pub/Sub basics

---

## Prerequisites

Before starting this tutorial, ensure you have the following:

| Requirement | Details |
|---|---|
| **GCP project** | With Dataflow jobs you intend to migrate; read access to Beam pipeline code |
| **Apache Beam source code** | Git repository or local copy of the pipeline code |
| **Azure subscription** | With permissions to create ADF, Storage Account, Event Hubs, and Stream Analytics |
| **Azure Data Factory** | Provisioned ADF instance |
| **ADLS Gen2 storage account** | With hierarchical namespace enabled |
| **Azure Databricks workspace** | With Unity Catalog enabled (for batch transforms) |
| **dbt Core** | `pip install dbt-databricks` (v1.7+) |
| **Azure CLI** | Authenticated with `az login` |
| **Event Hubs namespace** | Provisioned (for streaming pipelines only) |

> **GCP comparison:** Dataflow is a managed service for Apache Beam pipelines that handles both batch and streaming. On Azure, batch data movement maps to ADF Copy Activities, batch transforms map to dbt models on Databricks, and streaming maps to Event Hubs + Stream Analytics (SQL-first) or Databricks Structured Streaming (code-first).

---

## Scenario

You are migrating two Dataflow pipelines:

1. **Batch pipeline:** Reads CSV files from GCS, cleans and joins customer/order data, writes aggregated results to BigQuery. Runs daily at 03:00 UTC via Cloud Scheduler.
2. **Streaming pipeline:** Reads JSON events from Pub/Sub, applies windowed aggregations (5-minute tumbling windows), writes results to BigQuery for near-real-time dashboards.

By the end of this tutorial you will have equivalent pipelines on Azure: ADF + dbt for batch, Event Hubs + Stream Analytics for streaming.

---

## Step 1: Document existing Dataflow pipeline

### 1.1 Inventory the batch pipeline

Review the Apache Beam code and document every stage:

```python
# Example: existing Beam batch pipeline (Python)
import apache_beam as beam
from apache_beam.options.pipeline_options import PipelineOptions

def run():
    options = PipelineOptions([
        '--runner=DataflowRunner',
        '--project=acme-gov',
        '--region=us-east4',
        '--temp_location=gs://acme-gov-temp/dataflow/',
        '--staging_location=gs://acme-gov-staging/dataflow/',
    ])

    with beam.Pipeline(options=options) as p:
        # Stage 1: Read from GCS
        customers = (
            p
            | 'ReadCustomers' >> beam.io.ReadFromText('gs://acme-gov-raw/customers/*.csv')
            | 'ParseCustomers' >> beam.Map(parse_customer_csv)
            | 'FilterValidCustomers' >> beam.Filter(lambda r: r['email'] is not None)
        )

        orders = (
            p
            | 'ReadOrders' >> beam.io.ReadFromText('gs://acme-gov-raw/orders/*.csv')
            | 'ParseOrders' >> beam.Map(parse_order_csv)
            | 'FilterValidOrders' >> beam.Filter(lambda r: r['amount'] > 0)
        )

        # Stage 2: Join and aggregate
        joined = (
            {'customers': customers, 'orders': orders}
            | 'CoGroupByCustomerId' >> beam.CoGroupByKey()
            | 'FlattenJoin' >> beam.FlatMap(join_customer_orders)
        )

        summary = (
            joined
            | 'KeyByCustomer' >> beam.Map(lambda r: (r['customer_id'], r))
            | 'GroupByCustomer' >> beam.GroupByKey()
            | 'Aggregate' >> beam.Map(compute_order_summary)
        )

        # Stage 3: Write to BigQuery
        summary | 'WriteToBQ' >> beam.io.WriteToBigQuery(
            'acme-gov:analytics.order_summary',
            schema='customer_id:STRING,total_orders:INTEGER,total_revenue:FLOAT,avg_order:FLOAT',
            write_disposition=beam.io.BigQueryDisposition.WRITE_TRUNCATE,
        )
```

### 1.2 Document the pipeline DAG

```
GCS (customers/*.csv)  ──→  Parse  ──→  Filter  ──┐
                                                    ├──→  CoGroupByKey  ──→  Aggregate  ──→  BigQuery
GCS (orders/*.csv)     ──→  Parse  ──→  Filter  ──┘
```

### 1.3 Record the streaming pipeline

```python
# Example: existing Beam streaming pipeline
def run_streaming():
    options = PipelineOptions([
        '--runner=DataflowRunner',
        '--project=acme-gov',
        '--streaming',
        '--region=us-east4',
    ])

    with beam.Pipeline(options=options) as p:
        events = (
            p
            | 'ReadPubSub' >> beam.io.ReadFromPubSub(topic='projects/acme-gov/topics/click-events')
            | 'ParseJSON' >> beam.Map(json.loads)
            | 'Window5Min' >> beam.WindowInto(beam.window.FixedWindows(300))
            | 'CountByPage' >> beam.combiners.Count.PerKey()
            | 'FormatOutput' >> beam.Map(format_pageview_count)
            | 'WriteToBQ' >> beam.io.WriteToBigQuery(
                'acme-gov:analytics.pageview_counts_5min',
                write_disposition=beam.io.BigQueryDisposition.WRITE_APPEND,
            )
        )
```

### 1.4 Build migration inventory

| Pipeline | Type | Sources | Sinks | Transforms | Schedule | Priority |
|---|---|---|---|---|---|---|
| customer_orders_batch | Batch | GCS (CSV) | BigQuery | Parse, filter, join, aggregate | Daily 03:00 UTC | High |
| pageview_streaming | Streaming | Pub/Sub (JSON) | BigQuery | Parse, window (5m tumbling), count | Continuous | High |

---

## Step 2: Identify transformation pattern

### 2.1 Decision matrix: batch vs. streaming

| Beam pipeline characteristic | Azure target | Rationale |
|---|---|---|
| Batch, file-based sources | ADF Copy Activity + dbt | ADF handles file movement; dbt handles SQL transforms |
| Batch, database sources | ADF Copy Activity + dbt | ADF has 100+ native connectors |
| Streaming, low-latency (< 1 min) | Event Hubs + Stream Analytics | SQL-first streaming for simple transforms |
| Streaming, complex stateful logic | Event Hubs + Databricks Structured Streaming | Code-first for complex windowing and state |
| Hybrid (batch + micro-batch) | ADF + Databricks Auto Loader | Auto Loader provides streaming-like ingestion from files |

### 2.2 Map Beam concepts to Azure

| Apache Beam concept | Azure equivalent | Notes |
|---|---|---|
| `Pipeline` | ADF Pipeline + dbt project | Top-level orchestration unit |
| `PCollection` | ADLS Gen2 files or Delta tables | Intermediate data lands in storage |
| `ReadFromText` / `ReadFromAvro` | ADF Copy Activity (source) | File-based source connectors |
| `ReadFromPubSub` | Event Hubs consumer | Kafka protocol or native SDK |
| `WriteToBigQuery` | ADF Copy Activity (sink) or dbt model | Write to Delta Lake / Fabric |
| `Map` / `FlatMap` | dbt SQL expression or ADF Data Flow mapping | SQL for declarative; Data Flow for visual |
| `Filter` | dbt `WHERE` clause | Direct SQL equivalent |
| `GroupByKey` / `CoGroupByKey` | dbt `GROUP BY` / `JOIN` | SQL joins replace Beam grouping |
| `Combine` (sum, count, avg) | dbt aggregate functions | `SUM()`, `COUNT()`, `AVG()` |
| `WindowInto` (fixed, sliding, session) | Stream Analytics windowing | `TumblingWindow`, `HoppingWindow`, `SessionWindow` |
| `ParDo` (custom DoFn) | dbt macro, ADF Data Flow script, or Databricks notebook | Depends on complexity |
| `Side inputs` | dbt `ref()` to lookup table | Join to a reference table |
| `Triggers` | Stream Analytics output policy | Watermark and late-arrival handling |
| `Dead letter queue` | Event Hubs secondary topic + ADF error handling | Separate error path |

---

## Step 3: Create ADF pipeline for batch data movement

### 3.1 Set up linked services

Create linked services for GCS (source) and ADLS Gen2 (sink):

```json
{
  "name": "ls_gcs_acme",
  "type": "GoogleCloudStorage",
  "typeProperties": {
    "accessKeyId": "<GCS_HMAC_ACCESS_KEY>",
    "secretAccessKey": {
      "type": "AzureKeyVaultSecret",
      "store": { "referenceName": "ls_keyvault", "type": "LinkedServiceReference" },
      "secretName": "gcs-hmac-secret"
    }
  }
}
```

```json
{
  "name": "ls_adls_bronze",
  "type": "AzureBlobFS",
  "typeProperties": {
    "url": "https://<STORAGE_ACCOUNT>.dfs.core.windows.net"
  },
  "connectVia": { "type": "IntegrationRuntimeReference", "referenceName": "AutoResolveIR" }
}
```

### 3.2 Create Copy Activities

Replace `ReadFromText` with ADF Copy Activities:

```json
{
  "name": "copy_customers_csv",
  "type": "Copy",
  "typeProperties": {
    "source": {
      "type": "DelimitedTextSource",
      "storeSettings": {
        "type": "GoogleCloudStorageReadSettings",
        "recursive": true,
        "wildcardFileName": "*.csv"
      },
      "formatSettings": { "type": "DelimitedTextReadSettings" }
    },
    "sink": {
      "type": "ParquetSink",
      "storeSettings": { "type": "AzureBlobFSWriteSettings" }
    }
  },
  "inputs": [
    {
      "referenceName": "ds_gcs_customers_csv",
      "type": "DatasetReference"
    }
  ],
  "outputs": [
    {
      "referenceName": "ds_adls_customers_parquet",
      "type": "DatasetReference"
    }
  ]
}
```

### 3.3 Pipeline flow

```
ADF Pipeline: pl_customer_orders_daily
  ├── copy_customers_csv (GCS CSV → ADLS Parquet)
  ├── copy_orders_csv (GCS CSV → ADLS Parquet)
  └── run_dbt_transforms (depends on both copies)
        └── dbt run --select stg_customers stg_orders fact_order_summary
```

---

## Step 4: Convert Beam transforms to dbt SQL models

### 4.1 Map each Beam transform to a dbt model

**`parse_customer_csv` + `filter_valid_customers` becomes `stg_customers.sql`:**

```sql
-- models/staging/stg_customers.sql
{{ config(materialized='view') }}

with source as (
    select * from {{ source('bronze', 'customers_raw') }}
),

cleaned as (
    select
        customer_id,
        TRIM(LOWER(email)) AS email,
        customer_name,
        phone,
        created_at
    from source
    where email IS NOT NULL  -- Beam Filter: email is not None
)

select * from cleaned
```

**`parse_order_csv` + `filter_valid_orders` becomes `stg_orders.sql`:**

```sql
-- models/staging/stg_orders.sql
{{ config(materialized='view') }}

with source as (
    select * from {{ source('bronze', 'orders_raw') }}
),

cleaned as (
    select
        order_id,
        customer_id,
        order_date,
        CAST(amount AS DECIMAL(18, 2)) AS amount,
        order_status,
        created_at
    from source
    where amount > 0  -- Beam Filter: amount > 0
)

select * from cleaned
```

**`CoGroupByKey` + `Aggregate` becomes `fact_order_summary.sql`:**

```sql
-- models/gold/fact_order_summary.sql
{{ config(materialized='table') }}

with customers as (
    select * from {{ ref('stg_customers') }}
),

orders as (
    select * from {{ ref('stg_orders') }}
)

-- Replaces Beam CoGroupByKey + GroupByKey + compute_order_summary
select
    c.customer_id,
    c.email,
    c.customer_name,
    COUNT(o.order_id) AS total_orders,
    SUM(o.amount) AS total_revenue,
    AVG(o.amount) AS avg_order_value,
    MIN(o.order_date) AS first_order_date,
    MAX(o.order_date) AS last_order_date
from customers c
left join orders o
    on c.customer_id = o.customer_id
group by
    c.customer_id,
    c.email,
    c.customer_name
```

### 4.2 Add schema tests

```yaml
# models/gold/schema.yml
version: 2

models:
  - name: fact_order_summary
    description: "Customer order summary replacing Beam pipeline output"
    columns:
      - name: customer_id
        tests:
          - not_null
          - unique
      - name: total_orders
        tests:
          - not_null
      - name: total_revenue
        tests:
          - not_null
```

### 4.3 Run and validate

```bash
dbt run
dbt test
```

---

## Step 5: For streaming -- set up Event Hubs + Stream Analytics

### 5.1 Migrate Pub/Sub to Event Hubs

Create an Event Hub matching the Pub/Sub topic:

```bash
# Create Event Hubs namespace
az eventhubs namespace create \
  --resource-group rg-data-platform \
  --name ehns-acme-streaming \
  --sku Standard \
  --capacity 2

# Create Event Hub (replaces Pub/Sub topic)
az eventhubs eventhub create \
  --resource-group rg-data-platform \
  --namespace-name ehns-acme-streaming \
  --name eh-click-events \
  --partition-count 8 \
  --message-retention 7
```

### 5.2 Migrate event producers

Update producers to send to Event Hubs instead of Pub/Sub. Event Hubs supports the Kafka protocol, so Kafka-based producers only need a config change:

```python
# Python producer using azure-eventhub SDK
from azure.eventhub import EventHubProducerClient, EventData
import json

producer = EventHubProducerClient.from_connection_string(
    conn_str="Endpoint=sb://ehns-acme-streaming.servicebus.windows.net/;SharedAccessKeyName=...;SharedAccessKey=...",
    eventhub_name="eh-click-events"
)

event_batch = producer.create_batch()
event_batch.add(EventData(json.dumps({"page": "/home", "ts": "2025-01-15T10:30:00Z"})))
producer.send_batch(event_batch)
producer.close()
```

### 5.3 Create Stream Analytics job (replaces Beam streaming pipeline)

```sql
-- Stream Analytics query replacing Beam WindowInto + CountByPage
-- Input: eh-click-events (Event Hub)
-- Output: adls-pageview-counts (ADLS Gen2 or Fabric lakehouse)

SELECT
    page,
    COUNT(*) AS view_count,
    System.Timestamp() AS window_end
INTO [adls-pageview-counts]
FROM [eh-click-events]
TIMESTAMP BY ts
GROUP BY
    page,
    TumblingWindow(minute, 5)
```

### 5.4 Map Beam windowing to Stream Analytics

| Beam window type | Stream Analytics function | SQL syntax |
|---|---|---|
| `FixedWindows(300)` (5 min) | `TumblingWindow` | `TumblingWindow(minute, 5)` |
| `SlidingWindows(600, 60)` (10 min, 1 min slide) | `HoppingWindow` | `HoppingWindow(minute, 10, 1)` |
| `Sessions(600)` (10 min gap) | `SessionWindow` | `SessionWindow(minute, 10)` |
| `GlobalWindows()` | No window (full aggregate) | Omit window function |
| Late data with `allowed_lateness` | Watermark policy | `TIMESTAMP BY col OVER col (Tolerance ...)` |

### 5.5 Alternative: Databricks Structured Streaming

For complex stateful logic that Stream Analytics SQL cannot handle:

```python
# Databricks notebook: streaming pageview counts
from pyspark.sql.functions import from_json, col, window, count
from pyspark.sql.types import StructType, StringType, TimestampType

schema = StructType() \
    .add("page", StringType()) \
    .add("ts", TimestampType())

# Read from Event Hubs
df = (spark.readStream
    .format("eventhubs")
    .options(**eh_conf)
    .load()
    .select(from_json(col("body").cast("string"), schema).alias("data"))
    .select("data.*")
)

# 5-minute tumbling window (replaces Beam WindowInto)
windowed = (df
    .withWatermark("ts", "2 minutes")
    .groupBy(window("ts", "5 minutes"), "page")
    .agg(count("*").alias("view_count"))
)

# Write to Delta Lake
(windowed.writeStream
    .format("delta")
    .outputMode("append")
    .option("checkpointLocation", "/mnt/checkpoints/pageviews")
    .toTable("acme_gov.analytics.pageview_counts_5min")
)
```

---

## Step 6: Configure triggers and scheduling

### 6.1 Batch pipeline: ADF schedule trigger

```json
{
  "name": "tr_daily_0300_utc",
  "properties": {
    "type": "ScheduleTrigger",
    "typeProperties": {
      "recurrence": {
        "frequency": "Day",
        "interval": 1,
        "startTime": "2025-01-01T03:00:00Z",
        "timeZone": "UTC"
      }
    },
    "pipelines": [
      {
        "pipelineReference": {
          "referenceName": "pl_customer_orders_daily",
          "type": "PipelineReference"
        }
      }
    ]
  }
}
```

### 6.2 Streaming pipeline: always-on

Stream Analytics jobs run continuously. Configure auto-start and monitoring:

```bash
# Start the Stream Analytics job
az stream-analytics job start \
  --resource-group rg-data-platform \
  --job-name asa-pageview-counts \
  --output-start-mode JobStartTime

# Set up auto-restart on failure via Azure Monitor
az monitor metrics alert create \
  --resource-group rg-data-platform \
  --name alert-asa-failure \
  --scopes /subscriptions/{sub-id}/resourceGroups/rg-data-platform/providers/Microsoft.StreamAnalytics/streamingjobs/asa-pageview-counts \
  --condition "total Errors > 0" \
  --window-size 5m \
  --action ag-data-team
```

### 6.3 Scheduling mapping

| Dataflow / GCP scheduling | Azure equivalent |
|---|---|
| Cloud Scheduler + Dataflow template launch | ADF Schedule Trigger |
| Cloud Composer (Airflow) DAG | ADF Pipeline with dependencies |
| Dataflow streaming (always-on) | Stream Analytics job (always-on) or Databricks streaming job |
| Pub/Sub trigger → Cloud Function → Dataflow | Event Grid → ADF event-based trigger |
| Manual `gcloud dataflow jobs run` | `az datafactory pipeline create-run` or ADF Studio "Trigger Now" |

---

## Step 7: Validate output parity

### 7.1 Batch pipeline validation

Run both the Dataflow pipeline and the ADF + dbt pipeline on the same input data:

```sql
-- Compare row counts
SELECT 'azure' AS source, COUNT(*) AS rows FROM acme_gov.analytics.fact_order_summary
UNION ALL
SELECT 'gcp', COUNT(*) FROM `acme-gov.analytics.order_summary`;

-- Compare aggregates
SELECT 'azure' AS source,
       SUM(total_revenue) AS total_rev,
       AVG(avg_order_value) AS avg_order
FROM acme_gov.analytics.fact_order_summary
UNION ALL
SELECT 'gcp',
       SUM(total_revenue),
       AVG(avg_order)
FROM `acme-gov.analytics.order_summary`;
```

### 7.2 Streaming pipeline validation

For streaming, compare windowed output over a test period:

1. Send identical test events to both Pub/Sub and Event Hubs
2. Wait for 3-5 window cycles (15-25 minutes for 5-minute windows)
3. Compare output row counts and aggregates per window
4. Tolerance: < 1% variance (streaming systems may differ on window boundaries for late data)

### 7.3 Reconciliation checklist

- [ ] Batch: row counts match exactly
- [ ] Batch: aggregate values match within 0.01% tolerance
- [ ] Batch: scheduling fires at correct time
- [ ] Streaming: windowed counts match within 1% tolerance
- [ ] Streaming: late-data handling behaves equivalently
- [ ] Streaming: throughput meets latency SLA (< 1 minute end-to-end)
- [ ] Error handling: failed records route to dead-letter path
- [ ] Monitoring: alerts fire on pipeline/job failure

---

## Beam transform to dbt/ADF mapping reference

| Beam transform | Azure equivalent | Implementation |
|---|---|---|
| `ReadFromText(path)` | ADF Copy Activity | Copy from GCS/ADLS to bronze layer |
| `ReadFromAvro(path)` | ADF Copy Activity (Avro format) | Copy Avro files preserving schema |
| `ReadFromPubSub(topic)` | Event Hubs consumer | Kafka protocol or native SDK |
| `WriteToBigQuery(table)` | dbt model or ADF Copy (sink) | Write to Delta table |
| `WriteToText(path)` | ADF Copy Activity (sink) | Write to ADLS as CSV/JSON |
| `Map(fn)` | dbt SQL expression | `SELECT fn_logic FROM ...` |
| `FlatMap(fn)` | dbt `LATERAL VIEW EXPLODE` | Unnest arrays |
| `Filter(fn)` | dbt `WHERE` clause | `WHERE condition` |
| `GroupByKey()` | dbt `GROUP BY` | `GROUP BY key_columns` |
| `CoGroupByKey()` | dbt `JOIN` | `LEFT JOIN` / `INNER JOIN` on keys |
| `Combine.globally(sum)` | dbt `SUM()` | Aggregate without GROUP BY |
| `Combine.perKey(sum)` | dbt `SUM() ... GROUP BY` | Aggregate with GROUP BY |
| `Flatten()` | dbt `UNION ALL` | Combine multiple sources |
| `Partition(fn)` | dbt `CASE WHEN` + separate models | Route rows to different targets |
| `WindowInto(FixedWindows)` | Stream Analytics `TumblingWindow` | SQL windowing function |
| `WindowInto(SlidingWindows)` | Stream Analytics `HoppingWindow` | Sliding window aggregation |
| `WindowInto(Sessions)` | Stream Analytics `SessionWindow` | Session-based grouping |
| Side input (`AsDict`) | dbt `ref()` + `JOIN` | Join to reference table |
| `Reshuffle()` | No equivalent needed | Databricks handles parallelism automatically |
| Custom `DoFn` with state | Databricks Structured Streaming `mapGroupsWithState` | For stateful streaming logic |

---

## Next steps

After completing this tutorial:

1. **Migrate remaining Dataflow pipelines.** Apply the batch or streaming pattern to each pipeline in your inventory.
2. **Set up monitoring dashboards.** Create Azure Monitor workbooks for ADF pipeline and Stream Analytics job health.
3. **Implement error handling.** Configure dead-letter Event Hubs and ADF failure paths for production resilience.
4. **Review the playbook.** See [GCP to Azure Migration Playbook](../gcp-to-azure.md) for the full phased plan covering Dataproc and other GCP services.

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Migration Playbook](../gcp-to-azure.md) | [BigQuery to Fabric Tutorial](tutorial-bigquery-to-fabric.md) | [Benchmarks](benchmarks.md) | [Best Practices](best-practices.md)
