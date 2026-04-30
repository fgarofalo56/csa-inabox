# Compute Migration: BigQuery and Dataproc to Databricks and Fabric

**A hands-on guide for data engineers migrating BigQuery SQL workloads, BigQuery ML, scheduled queries, and Dataproc Spark jobs to Databricks SQL, Fabric, and dbt.**

---

## Scope

This guide covers:

- BigQuery SQL to SparkSQL / T-SQL dialect conversion
- Slots to DBU/CU capacity mapping
- Materialized views to dbt materializations
- Scheduled queries to dbt + ADF triggers
- BigQuery BI Engine to Direct Lake mode
- Clustering and partitioning to Delta table optimization
- BigQuery Omni to OneLake shortcuts
- Dataproc to Databricks cluster migration

For storage migration, see [Storage Migration](storage-migration.md). For Looker migration, see [Analytics Migration](analytics-migration.md).

---

## BigQuery SQL to Databricks SQL / Fabric

### Dialect conversion reference

The existing playbook (Section 4.3) documents the critical dialect differences. This guide expands on those with additional patterns.

#### Core syntax differences

| BigQuery StandardSQL                       | Databricks SQL                                | Notes                                   |
| ------------------------------------------ | --------------------------------------------- | --------------------------------------- |
| `DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY)` | `DATE_SUB(CURRENT_DATE(), 3)`                 | Argument form differs                   |
| `DATE_ADD(d, INTERVAL 7 DAY)`              | `DATE_ADD(d, 7)`                              | Same pattern                            |
| `TIMESTAMP_DIFF(a, b, HOUR)`               | `TIMESTAMPDIFF(HOUR, b, a)`                   | Argument order reversed                 |
| `SAFE_CAST(x AS INT64)`                    | `TRY_CAST(x AS BIGINT)`                       | Naming and type                         |
| `SAFE_DIVIDE(a, b)`                        | `TRY_DIVIDE(a, b)` or `a / NULLIF(b, 0)`      | TRY_DIVIDE available in DBR 13+         |
| `INT64`                                    | `BIGINT`                                      | Type name                               |
| `FLOAT64`                                  | `DOUBLE`                                      | Type name                               |
| `BOOL`                                     | `BOOLEAN`                                     | Type name                               |
| `BYTES`                                    | `BINARY`                                      | Type name                               |
| `STRING`                                   | `STRING`                                      | Same                                    |
| `STRUCT<a INT64, b STRING>`                | `STRUCT<a: BIGINT, b: STRING>`                | Colon syntax in struct fields           |
| `ARRAY<STRING>`                            | `ARRAY<STRING>`                               | Same                                    |
| `UNNEST(arr)`                              | `explode(arr)` or `LATERAL VIEW explode(arr)` | Different keyword                       |
| `GENERATE_ARRAY(1, 10)`                    | `sequence(1, 10)`                             | Function name                           |
| `FORMAT_DATE('%Y-%m', d)`                  | `DATE_FORMAT(d, 'yyyy-MM')`                   | Format string syntax (Java vs strftime) |
| `PARSE_DATE('%Y-%m-%d', s)`                | `TO_DATE(s, 'yyyy-MM-dd')`                    | Parse function name                     |
| `IF(cond, a, b)`                           | `IF(cond, a, b)`                              | Same                                    |
| `IFNULL(a, b)`                             | `COALESCE(a, b)` or `IFNULL(a, b)`            | Both work in Databricks                 |
| `STARTS_WITH(s, prefix)`                   | `s LIKE 'prefix%'` or `startswith(s, prefix)` | Function available in DBR 13+           |
| `REGEXP_CONTAINS(s, r'pattern')`           | `s RLIKE 'pattern'`                           | Different operator                      |
| `REGEXP_EXTRACT(s, r'pattern')`            | `REGEXP_EXTRACT(s, 'pattern')`                | Same function, different literal        |
| `@@project_id` session var                 | `current_catalog()`                           | Session context                         |
| `@@dataset_id` session var                 | `current_schema()`                            | Session context                         |

#### DDL differences

| BigQuery                                 | Databricks                                   | Notes                                      |
| ---------------------------------------- | -------------------------------------------- | ------------------------------------------ |
| `CREATE TABLE ... PARTITION BY date_col` | `CREATE TABLE ... PARTITIONED BY (date_col)` | Keyword plural                             |
| `CLUSTER BY col1, col2`                  | `OPTIMIZE table ZORDER BY (col1, col2)`      | Separate command                           |
| `OPTIONS(partition_expiration_days=400)` | `VACUUM` + retention config                  | No auto-expiration; use scheduled `VACUUM` |
| `CREATE OR REPLACE TABLE`                | `CREATE OR REPLACE TABLE`                    | Same                                       |
| `CREATE TEMP TABLE`                      | `CREATE TEMPORARY VIEW` or temp table        | Different semantics                        |
| `EXPORT DATA OPTIONS(...)`               | `COPY INTO` or Spark write API               | Export idiom differs                       |

#### Window function differences

| BigQuery                             | Databricks                                       | Notes                                   |
| ------------------------------------ | ------------------------------------------------ | --------------------------------------- |
| `QUALIFY ROW_NUMBER() OVER(...) = 1` | Wrap in subquery with `WHERE rn = 1`             | QUALIFY not supported in Databricks SQL |
| `FIRST_VALUE(x IGNORE NULLS)`        | `FIRST_VALUE(x) IGNORE NULLS`                    | Placement differs                       |
| `LAST_VALUE(x IGNORE NULLS)`         | `LAST_VALUE(x) IGNORE NULLS`                     | Placement differs                       |
| `PERCENTILE_CONT(x, 0.5)`            | `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x)` | SQL standard syntax                     |

### Automated dialect conversion

For large codebases, manual conversion is impractical. Use a systematic approach:

1. **Regex-based find-and-replace** for type names (`INT64` to `BIGINT`, `FLOAT64` to `DOUBLE`)
2. **AST-based tools** (sqlglot) for complex syntax transformations
3. **Manual review** for `QUALIFY`, `UNNEST`, struct literals, and cross-joins

```python
# Using sqlglot for automated conversion
import sqlglot

bq_sql = """
SELECT
  DATE_SUB(CURRENT_DATE(), INTERVAL 3 DAY) AS start_date,
  SAFE_CAST(revenue AS FLOAT64) AS revenue,
  ARRAY_AGG(STRUCT(product_id, quantity)) AS line_items
FROM `acme-gov.sales.orders`
WHERE REGEXP_CONTAINS(region, r'^US-')
"""

databricks_sql = sqlglot.transpile(bq_sql, read="bigquery", write="databricks")[0]
print(databricks_sql)
```

---

## Slots to DBU/CU mapping

### Conceptual mapping

| BigQuery concept         | Azure equivalent                         | Notes                                    |
| ------------------------ | ---------------------------------------- | ---------------------------------------- |
| Slot                     | Databricks DBU or Fabric CU              | Not 1:1; depends on workload shape       |
| On-demand slots          | Databricks Serverless SQL                | Auto-scaling, no pre-provisioning        |
| Standard Edition slots   | Databricks SQL Classic (small)           | Entry-level committed compute            |
| Enterprise Edition slots | Databricks SQL Classic/Serverless        | Mid-tier with governance features        |
| Enterprise Plus slots    | Databricks SQL + UC Premium              | Advanced security and compliance         |
| Flex slots (deprecated)  | N/A                                      | Use serverless or auto-scaling instead   |
| Reservation              | Reserved capacity (Databricks or Fabric) | 1-3 year commitment for discounts        |
| Assignment               | Workspace allocation                     | Capacity assigned to specific workspaces |

### Sizing guidance

There is no direct slot-to-DBU conversion formula because the architectures differ. Use this heuristic:

| BigQuery slot count | Databricks SQL Warehouse size | Fabric capacity | Notes               |
| ------------------- | ----------------------------- | --------------- | ------------------- |
| 100 slots           | Small (8-16 DBU/hour)         | F32             | Light workloads     |
| 500 slots           | Medium (32-64 DBU/hour)       | F64             | Mid-sized analytics |
| 1,000 slots         | Large (64-128 DBU/hour)       | F128            | Heavy analytics     |
| 2,000+ slots        | X-Large + multiple warehouses | F256            | Enterprise scale    |

**Recommendation:** Start with the estimated size, run representative workloads for 2 weeks, then right-size based on actual DBU consumption.

---

## Materialized views to dbt materializations

BigQuery materialized views auto-refresh when base tables change. The dbt equivalent depends on the refresh pattern:

| BigQuery MV pattern    | dbt equivalent                        | When to use                         |
| ---------------------- | ------------------------------------- | ----------------------------------- |
| Auto-refresh on write  | Delta Live Tables (DLT)               | Real-time or near-real-time refresh |
| Scheduled refresh      | dbt incremental model + scheduled job | Batch refresh on schedule           |
| Query-time refresh     | dbt ephemeral model                   | Computed on each query              |
| Complex aggregation MV | dbt incremental with merge strategy   | Aggregation over fact tables        |

### Worked example: BigQuery MV to dbt incremental

**BigQuery materialized view:**

```sql
CREATE MATERIALIZED VIEW `acme-gov.finance.mv_daily_revenue`
PARTITION BY sales_date
CLUSTER BY region
AS
SELECT
  DATE(order_ts) AS sales_date,
  region,
  SUM(gross_amount) AS daily_revenue,
  COUNT(*) AS order_count
FROM `acme-gov.sales.orders`
GROUP BY 1, 2;
```

**dbt incremental model:**

```sql
-- models/gold/daily_revenue.sql
{{ config(
    materialized='incremental',
    unique_key=['sales_date', 'region'],
    incremental_strategy='merge',
    partition_by=['sales_date']
) }}

SELECT
  DATE(order_ts) AS sales_date,
  region,
  SUM(gross_amount) AS daily_revenue,
  COUNT(*) AS order_count
FROM {{ ref('stg_orders') }}
{% if is_incremental() %}
WHERE DATE(order_ts) >= DATE_SUB(CURRENT_DATE(), 3)
{% endif %}
GROUP BY 1, 2
```

---

## Scheduled queries to dbt + ADF triggers

| BigQuery scheduled query pattern   | Azure equivalent                | Implementation                                               |
| ---------------------------------- | ------------------------------- | ------------------------------------------------------------ |
| Simple daily/hourly query          | Databricks Workflow schedule    | Cron-based schedule on a SQL task                            |
| Query with downstream dependencies | dbt job with model dependencies | dbt handles DAG ordering automatically                       |
| Cross-system orchestration         | ADF pipeline with triggers      | ADF orchestrates across Databricks, Fabric, external systems |
| Event-driven (on table update)     | Databricks Auto Loader + DLT    | File-arrival triggers processing                             |

### Migration steps

1. **Inventory** all scheduled queries from BigQuery console or `INFORMATION_SCHEMA.SCHEDULED_QUERIES`
2. **Classify** each query as simple (single table refresh), dependent (DAG chain), or cross-system
3. **Convert** simple queries to dbt models with Databricks Workflow schedules
4. **Convert** dependent chains to dbt jobs (dbt manages the DAG)
5. **Convert** cross-system queries to ADF pipelines calling dbt and other activities

---

## BigQuery BI Engine to Direct Lake

BigQuery BI Engine is an in-memory acceleration layer that speeds up BI queries over BigQuery tables. The Azure equivalent is Power BI Direct Lake mode.

| BigQuery BI Engine               | Power BI Direct Lake                   | Notes                                      |
| -------------------------------- | -------------------------------------- | ------------------------------------------ |
| In-memory cache of BigQuery data | Direct read from Delta Lake in OneLake | No data copy -- reads Delta files directly |
| Automatic refresh                | Automatic refresh on Delta changes     | Near-real-time without scheduled imports   |
| Reservation-based (GB of memory) | Included in Fabric capacity            | No separate reservation needed             |
| Optimized for Looker/BI queries  | Optimized for Power BI queries         | Native integration                         |

**Migration:** Once data is in Delta Lake on OneLake, create a Direct Lake semantic model in Power BI that points to the Delta tables. No BI Engine configuration is needed -- Direct Lake is the default mode for Fabric lakehouses.

---

## Clustering and partitioning to Delta optimization

### Partitioning

| BigQuery partition type          | Delta equivalent                        | Migration notes                               |
| -------------------------------- | --------------------------------------- | --------------------------------------------- |
| Date/timestamp column            | `PARTITIONED BY (date_col)`             | Direct mapping                                |
| Integer range partition          | `PARTITIONED BY (int_col)`              | May need bucketing for equivalent performance |
| Ingestion-time (\_PARTITIONTIME) | `PARTITIONED BY (_ingest_date)`         | Add explicit ingest date column               |
| No partitioning                  | No partitioning needed for small tables | Delta stats-based pruning often sufficient    |

### Clustering to Z-ordering

BigQuery clustering is automatic and maintenance-free. Delta Z-ordering requires explicit `OPTIMIZE` commands.

```sql
-- Run after data load or on a schedule
OPTIMIZE finance.fact_sales_daily ZORDER BY (region, product_id);

-- Enable auto-compaction for ongoing optimization
ALTER TABLE finance.fact_sales_daily SET TBLPROPERTIES (
  'delta.autoOptimize.autoCompact' = 'true',
  'delta.autoOptimize.optimizeWrite' = 'true'
);
```

**Best practice:** Schedule `OPTIMIZE` as a post-load step in dbt or as a Databricks Workflow task.

---

## BigQuery Omni to OneLake shortcuts

BigQuery Omni allows querying data in S3 or Azure Storage from BigQuery. During migration, use OneLake shortcuts for the reverse: querying GCS data from Azure.

| BigQuery Omni feature                | Azure equivalent         | Notes                                                        |
| ------------------------------------ | ------------------------ | ------------------------------------------------------------ |
| External connection to S3            | OneLake shortcut to S3   | Zero-copy read                                               |
| External connection to Azure Storage | OneLake shortcut to ADLS | Zero-copy read                                               |
| Cross-cloud query                    | Lakehouse Federation     | Query external sources from Databricks SQL                   |
| Bi-directional cross-cloud           | Not fully replicated     | Azure reads GCS; BigQuery reads Azure -- not unified console |

---

## Dataproc to Databricks

### Cluster migration

| Dataproc concept                      | Databricks equivalent             | Notes                                    |
| ------------------------------------- | --------------------------------- | ---------------------------------------- |
| Cluster (master + workers)            | All-purpose cluster               | Interactive workloads                    |
| Autoscaling cluster                   | Auto-scaling cluster + serverless | Serverless eliminates cluster management |
| Serverless Spark                      | Serverless SQL + Jobs             | No cluster management                    |
| Init actions                          | Cluster init scripts + policies   | Libraries via cluster policy             |
| Component gateway                     | Workspace web terminal            | Browser-based access                     |
| Jupyter on Dataproc                   | Databricks Notebooks              | Richer collaboration features            |
| Job submission (gcloud dataproc jobs) | Databricks Jobs API / Workflows   | REST API + CLI                           |

### Spark compatibility

Dataproc uses open-source Apache Spark. Databricks uses the Databricks Runtime, which is a superset of Apache Spark with performance optimizations (Photon engine).

**Compatibility notes:**

- PySpark code runs on Databricks with minimal changes
- Spark SQL is compatible; some GCP-specific UDFs need porting
- Spark JAR jobs run on Databricks with the same JAR
- Hive metastore tables bridge via Unity Catalog external metastore
- GCS paths (`gs://`) need translation to ADLS paths (`abfss://`)
- GCP-specific libraries (e.g., BigQuery connector) are replaced by Databricks native connectors

### Migration steps

1. **Inventory** Dataproc clusters, jobs, notebooks, and init actions
2. **Map** cluster configurations to Databricks cluster policies
3. **Port** Spark jobs -- change storage paths, remove GCP-specific operators
4. **Port** notebooks -- change `gs://` to `abfss://`, update library imports
5. **Test** on Databricks with representative data
6. **Schedule** using Databricks Workflows

---

## Validation checklist

After migrating compute workloads:

- [ ] All BigQuery scheduled queries have equivalent dbt models or Databricks jobs
- [ ] SQL dialect conversion tested with representative queries
- [ ] Partition and Z-order strategies applied to Delta tables
- [ ] Query performance is comparable or better (benchmark key queries)
- [ ] dbt tests pass for all migrated models
- [ ] Databricks Workflow schedules match original BigQuery schedules
- [ ] Dataproc Spark jobs run successfully on Databricks
- [ ] MLflow models registered for any BigQuery ML conversions

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Storage Migration](storage-migration.md) | [ETL Migration](etl-migration.md) | [Analytics Migration](analytics-migration.md) | [Migration Playbook](../gcp-to-azure.md)
