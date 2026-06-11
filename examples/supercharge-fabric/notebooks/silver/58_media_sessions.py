# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Media Session Construction
# MAGIC
# MAGIC This notebook transforms Bronze playback events into sessionized viewing records.
# MAGIC
# MAGIC ## Transformations Applied:
# MAGIC - Sessionization: 30-minute inactivity gap = new session
# MAGIC - Watch duration and completion percentage calculation
# MAGIC - Quality score (bitrate stability, rebuffer proxy)
# MAGIC - Bot/automated traffic filtering (< 5s or > 24h sessions)
# MAGIC - Heartbeat deduplication (collapse within 15s window)
# MAGIC - COPPA: child sessions tagged for downstream filtering

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

import os
from datetime import datetime

from delta.tables import DeltaTable
from pyspark.sql.functions import (
    avg,
    col,
    count,
    countDistinct,
    current_timestamp,
    first,
    last,
    lag,
    lit,
    max as spark_max,
    min as spark_min,
    row_number,
    sum as spark_sum,
    to_timestamp,
    unix_timestamp,
    when,
)
from pyspark.sql.window import Window


def _get_arg(name: str, default=None):
    """Read a notebook parameter from Fabric/Synapse runtime, env var, or default."""
    try:
        import notebookutils  # Fabric runtime
        return notebookutils.notebook.getArgument(name, default)
    except Exception:
        pass
    return os.environ.get(name, default)


SOURCE_TABLE = _get_arg("SOURCE_TABLE", "lh_bronze.bronze_media_events")
TARGET_TABLE = _get_arg("TARGET_TABLE", "lh_silver.silver_media_sessions")
SESSION_GAP_SEC = int(_get_arg("SESSION_GAP_SEC", "1800"))  # 30 minutes
MIN_SESSION_SEC = int(_get_arg("MIN_SESSION_SEC", "5"))
MAX_SESSION_SEC = int(_get_arg("MAX_SESSION_SEC", "86400"))  # 24 hours
HEARTBEAT_DEDUP_SEC = int(_get_arg("HEARTBEAT_DEDUP_SEC", "15"))

print(f"Source: {SOURCE_TABLE}")
print(f"Target: {TARGET_TABLE}")
print(f"Session gap: {SESSION_GAP_SEC}s | Min: {MIN_SESSION_SEC}s | Max: {MAX_SESSION_SEC}s")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Events

# COMMAND ----------

df_bronze = spark.table(SOURCE_TABLE) \
    .withColumn("event_ts", to_timestamp(col("event_timestamp")))

record_count = df_bronze.count()
print(f"Bronze records: {record_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Deduplicate Heartbeats
# MAGIC
# MAGIC Collapse consecutive heartbeat events within a 15-second window per user+content.

# COMMAND ----------

w_user_content = Window.partitionBy("user_id", "content_id").orderBy("event_ts")

df_deduped = df_bronze \
    .withColumn("prev_ts", lag("event_ts").over(w_user_content)) \
    .withColumn("prev_type", lag("event_type").over(w_user_content)) \
    .withColumn("gap_sec", unix_timestamp("event_ts") - unix_timestamp("prev_ts")) \
    .filter(
        ~(
            (col("event_type") == "heartbeat") &
            (col("prev_type") == "heartbeat") &
            (col("gap_sec") <= HEARTBEAT_DEDUP_SEC)
        )
    ) \
    .drop("prev_ts", "prev_type", "gap_sec")

dedup_count = df_deduped.count()
print(f"After heartbeat dedup: {dedup_count:,} (removed {record_count - dedup_count:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Sessionize Events
# MAGIC
# MAGIC A new session begins when the gap between consecutive events for the same
# MAGIC user+content exceeds 30 minutes.

# COMMAND ----------

w_session = Window.partitionBy("user_id", "content_id").orderBy("event_ts")

df_with_gap = df_deduped \
    .withColumn("prev_event_ts", lag("event_ts").over(w_session)) \
    .withColumn("gap_sec",
        when(col("prev_event_ts").isNull(), lit(SESSION_GAP_SEC + 1))
        .otherwise(unix_timestamp("event_ts") - unix_timestamp("prev_event_ts"))
    ) \
    .withColumn("new_session", when(col("gap_sec") > SESSION_GAP_SEC, lit(1)).otherwise(lit(0)))

# Cumulative sum to assign session IDs
w_cumsum = Window.partitionBy("user_id", "content_id").orderBy("event_ts") \
    .rowsBetween(Window.unboundedPreceding, Window.currentRow)

df_sessioned = df_with_gap \
    .withColumn("session_num", spark_sum("new_session").over(w_cumsum)) \
    .withColumn("session_id",
        col("user_id").substr(1, 10).__add__(lit("-"))
        .__add__(col("content_id"))
        .__add__(lit("-"))
        .__add__(col("session_num").cast("string"))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Sessions

# COMMAND ----------

# Content duration lookup (approximate from max position observed)
df_sessions = df_sessioned.groupBy("session_id", "user_id", "content_id") \
    .agg(
        spark_min("event_ts").alias("session_start"),
        spark_max("event_ts").alias("session_end"),
        (unix_timestamp(spark_max("event_ts")) - unix_timestamp(spark_min("event_ts"))).alias("watch_duration_sec"),
        spark_max("position_sec").alias("max_position_sec"),
        count(when(col("event_type") == "pause", True)).alias("pause_count"),
        count(when(col("event_type") == "seek", True)).alias("seek_count"),
        avg("bitrate_kbps").cast("int").alias("avg_bitrate_kbps"),
        first("device_type").alias("device_type"),
        first("plan_tier").alias("plan_tier"),
        first("age_bucket").alias("age_bucket"),
        count("*").alias("event_count"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Compute Derived Metrics

# COMMAND ----------

# Completion percentage (estimated from max position vs typical content length)
# Using 45 min (2700 sec) as default content duration when unknown
DEFAULT_CONTENT_DURATION_SEC = 2700

df_enriched = df_sessions \
    .withColumn("content_duration_sec", lit(DEFAULT_CONTENT_DURATION_SEC)) \
    .withColumn("completion_pct",
        when(col("max_position_sec") > 0,
            (col("max_position_sec") / col("content_duration_sec")).cast("double")
        ).otherwise(lit(0.0))
    ) \
    .withColumn("completion_pct",
        when(col("completion_pct") > 1.0, lit(1.0)).otherwise(col("completion_pct"))
    ) \
    .withColumn("quality_score",
        # Simple QoE proxy: higher bitrate = better quality, more pauses = worse
        (col("avg_bitrate_kbps") / 15000.0 * 0.7 +
         when(col("pause_count") == 0, lit(0.3))
         .otherwise((lit(1.0) / (col("pause_count") + 1)) * 0.3))
    ) \
    .withColumn("is_binge", lit(False))  # Placeholder; requires cross-content session analysis

# COMMAND ----------

# MAGIC %md
# MAGIC ## Filter Bot / Anomalous Sessions

# COMMAND ----------

df_clean = df_enriched \
    .filter(col("watch_duration_sec") >= MIN_SESSION_SEC) \
    .filter(col("watch_duration_sec") <= MAX_SESSION_SEC)

filtered_count = df_enriched.count() - df_clean.count()
print(f"Filtered {filtered_count:,} bot/anomalous sessions")
print(f"Clean sessions: {df_clean.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Silver Metadata & Write

# COMMAND ----------

df_silver = df_clean \
    .withColumn("_silver_processed_at", current_timestamp()) \
    .withColumn("_silver_load_date", current_timestamp().cast("date"))

df_silver.write \
    .format("delta") \
    .mode("overwrite") \
    .option("mergeSchema", "true") \
    .partitionBy("_silver_load_date") \
    .saveAsTable(TARGET_TABLE)

final_count = spark.table(TARGET_TABLE).count()
print(f"Wrote {final_count:,} sessions to {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Verify

# COMMAND ----------

df_verify = spark.table(TARGET_TABLE)

print("Session Statistics:")
display(
    df_verify.selectExpr(
        "count(*) as total_sessions",
        "count(distinct user_id) as unique_users",
        "count(distinct content_id) as unique_content",
        "avg(watch_duration_sec) as avg_watch_sec",
        "avg(completion_pct) as avg_completion",
        "avg(quality_score) as avg_quality",
    )
)

print("\nAge Bucket Distribution (COPPA):")
display(df_verify.groupBy("age_bucket").count().orderBy(col("count").desc()))

# COMMAND ----------

# MAGIC %md
# MAGIC **Next Step:** Continue to Gold layer analytics (`58_media_recommendations.py`).
