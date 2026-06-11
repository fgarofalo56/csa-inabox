# Databricks notebook source
# MAGIC %md
# MAGIC # Pipeline Execution Log Setup
# MAGIC
# MAGIC This utility notebook creates the infrastructure for tracking pipeline execution
# MAGIC across all medallion layers (Bronze, Silver, Gold). Every notebook in the POC
# MAGIC logs its run status, row counts, data-quality scores, and errors to a central
# MAGIC Delta table so operators can monitor health at a glance.
# MAGIC
# MAGIC ## What Gets Created
# MAGIC
# MAGIC | Object | Type | Purpose |
# MAGIC |--------|------|---------|
# MAGIC | `lh_gold.pipeline_execution_log` | Delta Table | Central execution log for every notebook run |
# MAGIC | `lh_gold.v_pipeline_health` | View | 7-day health dashboard (success rate, avg duration, DQ scores) |
# MAGIC | `lh_gold.v_pipeline_freshness` | View | Freshness alerting (stale / warning / ok) |
# MAGIC
# MAGIC ## Usage
# MAGIC
# MAGIC Run this notebook **once** to bootstrap the tracking tables, then re-run any
# MAGIC time you need to upgrade the schema (the DDL is idempotent).
# MAGIC
# MAGIC ```python
# MAGIC # From any other notebook:
# MAGIC %run ../utils/pipeline_execution_log_setup
# MAGIC ```

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Configuration

# COMMAND ----------

# Lakehouse target — all tracking objects live in the Gold layer
CATALOG = "lh_gold"

print(f"Target catalog/lakehouse: {CATALOG}")
print("Objects to create:")
print(f"  - {CATALOG}.pipeline_execution_log  (Delta table)")
print(f"  - {CATALOG}.v_pipeline_health       (view)")
print(f"  - {CATALOG}.v_pipeline_freshness    (view)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Create `pipeline_execution_log` Delta Table
# MAGIC
# MAGIC This is the central fact table that every notebook writes to at the start and
# MAGIC end of its run. Key design choices:
# MAGIC
# MAGIC - **Partitioned by `layer` and `status`** — most queries filter on one or both
# MAGIC   of these columns, and the low cardinality keeps the number of partitions small.
# MAGIC - **Auto-optimize enabled** — `optimizeWrite` bins small files automatically and
# MAGIC   `autoCompact` runs a lightweight compaction pass after every write, which is
# MAGIC   ideal for the frequent single-row appends this table receives.
# MAGIC - **Schema includes DQ metrics** — `dq_score_avg`, `dq_score_min`, and
# MAGIC   `dq_pass_rate` let the health view surface data-quality trends without
# MAGIC   joining to a separate DQ results table.

# COMMAND ----------

# MAGIC %sql
# MAGIC CREATE TABLE IF NOT EXISTS lh_gold.pipeline_execution_log (
# MAGIC     execution_id          STRING        COMMENT 'Unique UUID for this execution record',
# MAGIC     pipeline_run_id       STRING        COMMENT 'Correlates multiple notebooks in one pipeline run',
# MAGIC     batch_id              STRING        COMMENT 'The batch_id widget value passed to the notebook',
# MAGIC     notebook_name         STRING        COMMENT 'Short notebook name, e.g. 02_silver_player_master',
# MAGIC     layer                 STRING        COMMENT 'Medallion layer: bronze, silver, or gold',
# MAGIC     source_table          STRING        COMMENT 'Input table or file path',
# MAGIC     target_table          STRING        COMMENT 'Output Delta table name',
# MAGIC     status                STRING        COMMENT 'RUNNING, SUCCESS, or FAILED',
# MAGIC     started_at            TIMESTAMP     COMMENT 'UTC timestamp when notebook execution began',
# MAGIC     completed_at          TIMESTAMP     COMMENT 'UTC timestamp when notebook execution ended',
# MAGIC     duration_seconds      DOUBLE        COMMENT 'Wall-clock seconds from start to completion',
# MAGIC     rows_read             LONG          COMMENT 'Number of rows read from source',
# MAGIC     rows_written          LONG          COMMENT 'Number of rows written to target',
# MAGIC     rows_rejected         LONG          COMMENT 'Rows that failed data-quality checks',
# MAGIC     dq_score_avg          DOUBLE        COMMENT 'Average data-quality score (0-100)',
# MAGIC     dq_score_min          DOUBLE        COMMENT 'Minimum data-quality score in the batch',
# MAGIC     dq_pass_rate          DOUBLE        COMMENT 'Percentage of rows passing the DQ threshold',
# MAGIC     error_message         STRING        COMMENT 'Error details; NULL on success',
# MAGIC     error_type            STRING        COMMENT 'Python exception class name; NULL on success',
# MAGIC     spark_application_id  STRING        COMMENT 'Spark application ID for cross-referencing Spark UI',
# MAGIC     environment           STRING        COMMENT 'Runtime environment: dev, staging, or prod',
# MAGIC     _logged_at            TIMESTAMP     COMMENT 'UTC timestamp when this record was written to the log'
# MAGIC )
# MAGIC USING DELTA
# MAGIC PARTITIONED BY (layer, status)
# MAGIC TBLPROPERTIES (
# MAGIC     'delta.autoOptimize.optimizeWrite' = 'true',
# MAGIC     'delta.autoOptimize.autoCompact'   = 'true'
# MAGIC )

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Create `v_pipeline_health` View
# MAGIC
# MAGIC A rolling 7-day health dashboard. This view is designed to power a Power BI
# MAGIC Direct Lake report or a KQL dashboard tile. It answers:
# MAGIC
# MAGIC - How many times did each notebook run?
# MAGIC - What is the success/failure ratio?
# MAGIC - How long do runs typically take?
# MAGIC - What is the average data-quality score?

# COMMAND ----------

# MAGIC %sql
# MAGIC CREATE OR REPLACE VIEW lh_gold.v_pipeline_health AS
# MAGIC SELECT
# MAGIC     layer,
# MAGIC     notebook_name,
# MAGIC     COUNT(*)                                                    AS total_runs,
# MAGIC     SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END)        AS successes,
# MAGIC     SUM(CASE WHEN status = 'FAILED'  THEN 1 ELSE 0 END)        AS failures,
# MAGIC     ROUND(
# MAGIC         SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END)
# MAGIC         * 100.0 / COUNT(*), 1
# MAGIC     )                                                           AS success_rate_pct,
# MAGIC     ROUND(AVG(duration_seconds), 1)                             AS avg_duration_sec,
# MAGIC     ROUND(MAX(duration_seconds), 1)                             AS max_duration_sec,
# MAGIC     ROUND(AVG(dq_score_avg), 1)                                 AS avg_dq_score,
# MAGIC     ROUND(AVG(dq_pass_rate), 1)                                 AS avg_dq_pass_rate,
# MAGIC     MAX(completed_at)                                           AS last_run
# MAGIC FROM lh_gold.pipeline_execution_log
# MAGIC WHERE started_at >= current_date() - INTERVAL 7 DAYS
# MAGIC GROUP BY layer, notebook_name
# MAGIC ORDER BY layer, notebook_name

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Create `v_pipeline_freshness` View
# MAGIC
# MAGIC Freshness alerting for operational monitoring. Each notebook's last successful
# MAGIC run is compared against the current timestamp to produce a traffic-light status:
# MAGIC
# MAGIC | Status | Meaning |
# MAGIC |--------|---------|
# MAGIC | **OK** | Last success within 12 hours |
# MAGIC | **WARNING** | Last success between 12 and 24 hours ago |
# MAGIC | **STALE** | No successful run in over 24 hours |
# MAGIC
# MAGIC Wire this view to a Power BI conditional-formatting rule or a Data Activator
# MAGIC reflex to get proactive alerts when pipelines fall behind.

# COMMAND ----------

# MAGIC %sql
# MAGIC CREATE OR REPLACE VIEW lh_gold.v_pipeline_freshness AS
# MAGIC SELECT
# MAGIC     notebook_name,
# MAGIC     layer,
# MAGIC     MAX(completed_at)                                                   AS last_success,
# MAGIC     CAST(
# MAGIC         (unix_timestamp(current_timestamp()) - unix_timestamp(MAX(completed_at))) / 3600
# MAGIC         AS INT
# MAGIC     )                                                                   AS hours_since_last_run,
# MAGIC     CASE
# MAGIC         WHEN (unix_timestamp(current_timestamp()) - unix_timestamp(MAX(completed_at))) / 3600 > 24
# MAGIC             THEN 'STALE'
# MAGIC         WHEN (unix_timestamp(current_timestamp()) - unix_timestamp(MAX(completed_at))) / 3600 > 12
# MAGIC             THEN 'WARNING'
# MAGIC         ELSE 'OK'
# MAGIC     END                                                                 AS freshness_status
# MAGIC FROM lh_gold.pipeline_execution_log
# MAGIC WHERE status = 'SUCCESS'
# MAGIC GROUP BY notebook_name, layer
# MAGIC ORDER BY hours_since_last_run DESC

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Helper Functions
# MAGIC
# MAGIC These Python functions are available to any notebook that `%run`s this file.
# MAGIC They wrap the insert logic so callers only need two lines of code — one to
# MAGIC start tracking and one to finish.
# MAGIC
# MAGIC ```python
# MAGIC %run ../utils/pipeline_execution_log_setup
# MAGIC
# MAGIC # At the top of your notebook:
# MAGIC exec_ctx = start_execution_log(
# MAGIC     notebook_name="02_silver_player_master",
# MAGIC     layer="silver",
# MAGIC     source_table="bronze_player_events",
# MAGIC     target_table="silver_player_master",
# MAGIC     batch_id=BATCH_ID,
# MAGIC     pipeline_run_id=PIPELINE_RUN_ID,   # optional
# MAGIC     environment="dev"                   # optional
# MAGIC )
# MAGIC
# MAGIC # ... your notebook logic ...
# MAGIC
# MAGIC # At the bottom (in a finally block):
# MAGIC complete_execution_log(
# MAGIC     exec_ctx,
# MAGIC     status="SUCCESS",
# MAGIC     rows_read=input_count,
# MAGIC     rows_written=output_count,
# MAGIC     rows_rejected=rejected_count,       # optional
# MAGIC     dq_score_avg=avg_score,              # optional
# MAGIC     dq_score_min=min_score,              # optional
# MAGIC     dq_pass_rate=pass_rate               # optional
# MAGIC )
# MAGIC ```

# COMMAND ----------

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from pyspark.sql import SparkSession
from pyspark.sql.functions import col, current_timestamp, lit
from pyspark.sql.types import (
    DoubleType,
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)


@dataclass
class ExecutionContext:
    """Tracks state for a single notebook execution."""

    execution_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    pipeline_run_id: str = ""
    batch_id: str = ""
    notebook_name: str = ""
    layer: str = ""
    source_table: str = ""
    target_table: str = ""
    environment: str = "dev"
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    spark_application_id: str = ""


# Schema mirrors the Delta table exactly
_LOG_SCHEMA = StructType([
    StructField("execution_id",         StringType(),    False),
    StructField("pipeline_run_id",      StringType(),    True),
    StructField("batch_id",             StringType(),    True),
    StructField("notebook_name",        StringType(),    False),
    StructField("layer",                StringType(),    False),
    StructField("source_table",         StringType(),    True),
    StructField("target_table",         StringType(),    True),
    StructField("status",               StringType(),    False),
    StructField("started_at",           TimestampType(), False),
    StructField("completed_at",         TimestampType(), True),
    StructField("duration_seconds",     DoubleType(),    True),
    StructField("rows_read",            LongType(),      True),
    StructField("rows_written",         LongType(),      True),
    StructField("rows_rejected",        LongType(),      True),
    StructField("dq_score_avg",         DoubleType(),    True),
    StructField("dq_score_min",         DoubleType(),    True),
    StructField("dq_pass_rate",         DoubleType(),    True),
    StructField("error_message",        StringType(),    True),
    StructField("error_type",           StringType(),    True),
    StructField("spark_application_id", StringType(),    True),
    StructField("environment",          StringType(),    True),
    StructField("_logged_at",           TimestampType(), True),
])


def _get_spark() -> SparkSession:
    """Return the active Spark session."""
    return SparkSession.builder.getOrCreate()


def start_execution_log(
    notebook_name: str,
    layer: str,
    source_table: str,
    target_table: str,
    batch_id: str = "",
    pipeline_run_id: str | None = None,
    environment: str = "dev",
) -> ExecutionContext:
    """Record the start of a notebook execution.

    Inserts a row with status='RUNNING' and returns an ExecutionContext that
    must be passed to ``complete_execution_log`` when the notebook finishes.
    """
    spark = _get_spark()

    ctx = ExecutionContext(
        pipeline_run_id=pipeline_run_id or f"run-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}",
        batch_id=batch_id,
        notebook_name=notebook_name,
        layer=layer,
        source_table=source_table,
        target_table=target_table,
        environment=environment,
        spark_application_id=spark.sparkContext.applicationId or "",
    )

    now = datetime.now(timezone.utc)
    row = [(
        ctx.execution_id,
        ctx.pipeline_run_id,
        ctx.batch_id,
        ctx.notebook_name,
        ctx.layer,
        ctx.source_table,
        ctx.target_table,
        "RUNNING",           # status
        ctx.started_at,      # started_at
        None,                # completed_at
        None,                # duration_seconds
        None,                # rows_read
        None,                # rows_written
        None,                # rows_rejected
        None,                # dq_score_avg
        None,                # dq_score_min
        None,                # dq_pass_rate
        None,                # error_message
        None,                # error_type
        ctx.spark_application_id,
        ctx.environment,
        now,                 # _logged_at
    )]

    df = spark.createDataFrame(row, schema=_LOG_SCHEMA)
    df.write.format("delta").mode("append").saveAsTable("lh_gold.pipeline_execution_log")

    print(f"[ExecutionLog] STARTED  | {notebook_name} | exec={ctx.execution_id[:8]}... | run={ctx.pipeline_run_id}")
    return ctx


def complete_execution_log(
    ctx: ExecutionContext,
    status: str = "SUCCESS",
    rows_read: int | None = None,
    rows_written: int | None = None,
    rows_rejected: int | None = None,
    dq_score_avg: float | None = None,
    dq_score_min: float | None = None,
    dq_pass_rate: float | None = None,
    error_message: str | None = None,
    error_type: str | None = None,
) -> None:
    """Record the completion (success or failure) of a notebook execution.

    This appends a **new row** with the final status rather than updating the
    RUNNING row, which avoids the overhead of a Delta MERGE for a write-heavy
    log table.  Downstream views filter on ``status IN ('SUCCESS', 'FAILED')``
    so the RUNNING row is effectively superseded.
    """
    spark = _get_spark()

    now = datetime.now(timezone.utc)
    duration = (now - ctx.started_at).total_seconds()

    row = [(
        ctx.execution_id,
        ctx.pipeline_run_id,
        ctx.batch_id,
        ctx.notebook_name,
        ctx.layer,
        ctx.source_table,
        ctx.target_table,
        status,
        ctx.started_at,
        now,                 # completed_at
        duration,            # duration_seconds
        rows_read,
        rows_written,
        rows_rejected,
        dq_score_avg,
        dq_score_min,
        dq_pass_rate,
        error_message,
        error_type,
        ctx.spark_application_id,
        ctx.environment,
        now,                 # _logged_at
    )]

    df = spark.createDataFrame(row, schema=_LOG_SCHEMA)
    df.write.format("delta").mode("append").saveAsTable("lh_gold.pipeline_execution_log")

    emoji = "✅" if status == "SUCCESS" else "❌"
    print(
        f"[ExecutionLog] {emoji} {status} | {ctx.notebook_name} "
        f"| {duration:.1f}s | read={rows_read} written={rows_written} "
        f"| exec={ctx.execution_id[:8]}..."
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Verification
# MAGIC
# MAGIC Confirm that all objects were created successfully.

# COMMAND ----------

# Verify table exists
spark = SparkSession.builder.getOrCreate()

try:
    table_exists = spark.catalog.tableExists("lh_gold.pipeline_execution_log")
    print(f"✅ lh_gold.pipeline_execution_log exists: {table_exists}")
except Exception as e:
    print(f"⚠️  Table check skipped (expected outside Fabric): {e}")

# Show table schema
try:
    print("\n--- Table Schema ---")
    spark.sql("DESCRIBE TABLE lh_gold.pipeline_execution_log").show(truncate=False)
except Exception as e:
    print(f"⚠️  DESCRIBE skipped: {e}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 7. Sample Queries
# MAGIC
# MAGIC Use these queries to explore the execution log after notebooks have run.

# COMMAND ----------

# MAGIC %sql
# MAGIC -- Recent executions (last 24 hours)
# MAGIC SELECT
# MAGIC     notebook_name,
# MAGIC     layer,
# MAGIC     status,
# MAGIC     started_at,
# MAGIC     duration_seconds,
# MAGIC     rows_read,
# MAGIC     rows_written,
# MAGIC     dq_score_avg,
# MAGIC     error_message
# MAGIC FROM lh_gold.pipeline_execution_log
# MAGIC WHERE started_at >= current_timestamp() - INTERVAL 24 HOURS
# MAGIC   AND status IN ('SUCCESS', 'FAILED')
# MAGIC ORDER BY started_at DESC
# MAGIC LIMIT 50

# COMMAND ----------

# MAGIC %sql
# MAGIC -- Pipeline health dashboard (7-day rolling)
# MAGIC SELECT * FROM lh_gold.v_pipeline_health

# COMMAND ----------

# MAGIC %sql
# MAGIC -- Freshness check — which notebooks are overdue?
# MAGIC SELECT * FROM lh_gold.v_pipeline_freshness
# MAGIC WHERE freshness_status IN ('STALE', 'WARNING')

# COMMAND ----------

# MAGIC %sql
# MAGIC -- Failed runs with error details
# MAGIC SELECT
# MAGIC     notebook_name,
# MAGIC     started_at,
# MAGIC     error_type,
# MAGIC     error_message,
# MAGIC     pipeline_run_id
# MAGIC FROM lh_gold.pipeline_execution_log
# MAGIC WHERE status = 'FAILED'
# MAGIC   AND started_at >= current_date() - INTERVAL 7 DAYS
# MAGIC ORDER BY started_at DESC

# COMMAND ----------

# MAGIC %sql
# MAGIC -- End-to-end pipeline run view (group by pipeline_run_id)
# MAGIC SELECT
# MAGIC     pipeline_run_id,
# MAGIC     MIN(started_at)                                          AS pipeline_start,
# MAGIC     MAX(completed_at)                                        AS pipeline_end,
# MAGIC     ROUND(
# MAGIC         (unix_timestamp(MAX(completed_at)) - unix_timestamp(MIN(started_at))), 1
# MAGIC     )                                                        AS total_seconds,
# MAGIC     COUNT(DISTINCT notebook_name)                             AS notebooks_run,
# MAGIC     SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END)       AS failures,
# MAGIC     SUM(rows_written)                                        AS total_rows_written
# MAGIC FROM lh_gold.pipeline_execution_log
# MAGIC WHERE status IN ('SUCCESS', 'FAILED')
# MAGIC   AND started_at >= current_date() - INTERVAL 7 DAYS
# MAGIC GROUP BY pipeline_run_id
# MAGIC ORDER BY pipeline_start DESC
# MAGIC LIMIT 20

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup Complete
# MAGIC
# MAGIC The pipeline execution log infrastructure is now ready. To integrate into
# MAGIC your notebooks, add the following pattern:
# MAGIC
# MAGIC ```python
# MAGIC %run ../utils/pipeline_execution_log_setup
# MAGIC
# MAGIC exec_ctx = start_execution_log(
# MAGIC     notebook_name="02_silver_player_master",
# MAGIC     layer="silver",
# MAGIC     source_table="bronze_player_events",
# MAGIC     target_table="silver_player_master",
# MAGIC     batch_id=BATCH_ID,
# MAGIC )
# MAGIC
# MAGIC try:
# MAGIC     # ... your notebook logic ...
# MAGIC     complete_execution_log(exec_ctx, status="SUCCESS",
# MAGIC         rows_read=input_count, rows_written=output_count)
# MAGIC except Exception as e:
# MAGIC     complete_execution_log(exec_ctx, status="FAILED",
# MAGIC         error_message=str(e), error_type=type(e).__name__)
# MAGIC     raise
# MAGIC ```
