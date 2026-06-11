# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Media Content Performance & User Segments
# MAGIC
# MAGIC This notebook produces Gold-layer analytics tables:
# MAGIC - **gold_content_performance:** Per-content engagement KPIs and trending scores
# MAGIC - **gold_user_segments:** User engagement segments (power/casual/at-risk/dormant)
# MAGIC - **gold_content_affinity:** User-genre affinity matrix for recommendations
# MAGIC
# MAGIC ## Compliance
# MAGIC - COPPA: Child users excluded from behavioral segmentation; content-level only
# MAGIC - GDPR: Pseudonymized user_id; erasure-compatible (DELETE by user_id)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

import os
from datetime import datetime

from delta.tables import DeltaTable
from pyspark.sql.functions import (
    avg,
    coalesce,
    col,
    count,
    countDistinct,
    current_date,
    current_timestamp,
    datediff,
    lit,
    max as spark_max,
    min as spark_min,
    sum as spark_sum,
    when,
)


def _get_arg(name: str, default=None):
    """Read a notebook parameter from Fabric/Synapse runtime, env var, or default."""
    try:
        import notebookutils
        return notebookutils.notebook.getArgument(name, default)
    except Exception:
        pass
    return os.environ.get(name, default)


SOURCE_TABLE = _get_arg("SOURCE_TABLE", "lh_silver.silver_media_sessions")
GOLD_CONTENT = _get_arg("GOLD_CONTENT_TABLE", "lh_gold.gold_content_performance")
GOLD_SEGMENTS = _get_arg("GOLD_SEGMENTS_TABLE", "lh_gold.gold_user_segments")
GOLD_AFFINITY = _get_arg("GOLD_AFFINITY_TABLE", "lh_gold.gold_content_affinity")

print(f"Source: {SOURCE_TABLE}")
print(f"Targets: {GOLD_CONTENT}, {GOLD_SEGMENTS}, {GOLD_AFFINITY}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Sessions

# COMMAND ----------

df_sessions = spark.table(SOURCE_TABLE)
session_count = df_sessions.count()
print(f"Silver sessions: {session_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Gold 1: Content Performance
# MAGIC
# MAGIC Aggregated per-content metrics with trending score.

# COMMAND ----------

df_content = df_sessions.groupBy("content_id") \
    .agg(
        countDistinct("user_id").alias("unique_viewers"),
        count("session_id").alias("total_sessions"),
        (spark_sum("watch_duration_sec") / 3600.0).alias("total_watch_hours"),
        avg("completion_pct").alias("avg_completion_pct"),
        avg("quality_score").alias("avg_quality_score"),
        spark_max("session_start").alias("last_viewed"),
        spark_min("session_start").alias("first_viewed"),
    )

# Trending score: combination of viewer count + recency
# Higher score = more viewers recently
df_content_scored = df_content \
    .withColumn("days_since_last",
        datediff(current_date(), col("last_viewed").cast("date"))
    ) \
    .withColumn("recency_weight",
        when(col("days_since_last") <= 1, lit(3.0))
        .when(col("days_since_last") <= 7, lit(2.0))
        .when(col("days_since_last") <= 30, lit(1.0))
        .otherwise(lit(0.5))
    ) \
    .withColumn("trending_score",
        col("unique_viewers") * col("recency_weight") * col("avg_completion_pct")
    ) \
    .withColumn("_gold_computed_at", current_timestamp())

df_content_scored.write \
    .format("delta") \
    .mode("overwrite") \
    .saveAsTable(GOLD_CONTENT)

print(f"Wrote {spark.table(GOLD_CONTENT).count():,} content records to {GOLD_CONTENT}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Gold 2: User Engagement Segments
# MAGIC
# MAGIC Segment definitions:
# MAGIC - **Power:** 20+ hours/month, 15+ sessions, completion > 70%
# MAGIC - **Casual:** 5-20 hours/month, 5-15 sessions
# MAGIC - **At-Risk:** < 5 hours/month or 14+ days inactive
# MAGIC - **Dormant:** 30+ days since last session
# MAGIC
# MAGIC COPPA: child users (age_bucket = "child") are excluded from behavioral
# MAGIC segmentation to comply with data minimization requirements.

# COMMAND ----------

# Exclude child profiles from behavioral segmentation (COPPA)
df_adult = df_sessions.filter(col("age_bucket") != "child")

df_user_agg = df_adult.groupBy("user_id") \
    .agg(
        (spark_sum("watch_duration_sec") / 3600.0).alias("watch_hours_30d"),
        count("session_id").alias("sessions_30d"),
        countDistinct("content_id").alias("genres_watched"),
        avg("completion_pct").alias("avg_completion"),
        datediff(current_date(), spark_max("session_start").cast("date")).alias("days_since_last"),
        coalesce(col("plan_tier"), lit("unknown")).alias("plan_tier"),
    )

# Fix: plan_tier from first() in group -- re-read
df_user_agg = df_adult.groupBy("user_id") \
    .agg(
        (spark_sum("watch_duration_sec") / 3600.0).alias("watch_hours_30d"),
        count("session_id").alias("sessions_30d"),
        countDistinct("content_id").alias("content_diversity"),
        avg("completion_pct").alias("avg_completion"),
        datediff(current_date(), spark_max("session_start").cast("date")).alias("days_since_last"),
    )

# Join back to get plan_tier (take the most recent session's tier)
from pyspark.sql.functions import first
from pyspark.sql.window import Window

w_latest = Window.partitionBy("user_id").orderBy(col("session_start").desc())
df_latest_tier = df_adult \
    .withColumn("rn", first("plan_tier").over(w_latest)) \
    .select("user_id", col("rn").alias("plan_tier")) \
    .dropDuplicates(["user_id"])

df_user_enriched = df_user_agg.join(df_latest_tier, "user_id", "left")

# Assign segments
df_segments = df_user_enriched \
    .withColumn("segment",
        when(col("days_since_last") >= 30, lit("dormant"))
        .when(
            (col("watch_hours_30d") >= 20) &
            (col("sessions_30d") >= 15) &
            (col("avg_completion") >= 0.70),
            lit("power")
        )
        .when(
            (col("watch_hours_30d") < 5) | (col("days_since_last") >= 14),
            lit("at_risk")
        )
        .otherwise(lit("casual"))
    ) \
    .withColumn("churn_probability",
        when(col("segment") == "dormant", lit(0.85))
        .when(col("segment") == "at_risk", lit(0.45))
        .when(col("segment") == "casual", lit(0.15))
        .otherwise(lit(0.05))
    ) \
    .withColumn("_gold_computed_at", current_timestamp())

df_segments.write \
    .format("delta") \
    .mode("overwrite") \
    .saveAsTable(GOLD_SEGMENTS)

seg_count = spark.table(GOLD_SEGMENTS).count()
print(f"Wrote {seg_count:,} user segments to {GOLD_SEGMENTS}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Segment Distribution

# COMMAND ----------

display(
    spark.table(GOLD_SEGMENTS)
    .groupBy("segment")
    .agg(
        count("*").alias("users"),
        avg("watch_hours_30d").alias("avg_watch_hours"),
        avg("churn_probability").alias("avg_churn_prob"),
    )
    .orderBy("segment")
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Gold 3: Content Affinity Matrix
# MAGIC
# MAGIC User-genre affinity scores for collaborative/content-based recommendation input.
# MAGIC COPPA: child users receive content-based recommendations only (no collaborative).

# COMMAND ----------

# For adult users: full affinity with collaborative signal
# Approximate genre from content_id prefix (in production, join to catalog)
df_affinity = df_adult.groupBy("user_id", "content_id") \
    .agg(
        spark_sum("watch_duration_sec").alias("total_watch_sec"),
        avg("completion_pct").alias("avg_completion"),
        count("session_id").alias("session_count"),
    ) \
    .withColumn("affinity_score",
        col("total_watch_sec") * 0.4 +
        col("avg_completion") * 100 * 0.4 +
        col("session_count") * 0.2
    ) \
    .withColumn("_gold_computed_at", current_timestamp())

df_affinity.write \
    .format("delta") \
    .mode("overwrite") \
    .saveAsTable(GOLD_AFFINITY)

affinity_count = spark.table(GOLD_AFFINITY).count()
print(f"Wrote {affinity_count:,} affinity records to {GOLD_AFFINITY}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Table | Records | Description |
# MAGIC |-------|---------|-------------|
# MAGIC | gold_content_performance | {content} | Per-content KPIs + trending |
# MAGIC | gold_user_segments | {segments} | Engagement segments + churn probability |
# MAGIC | gold_content_affinity | {affinity} | User-content affinity for recommendations |
# MAGIC
# MAGIC **COPPA Note:** Child profiles excluded from user segments and collaborative
# MAGIC affinity. Kids content performance is tracked at the aggregate level only.
# MAGIC
# MAGIC **Next Step:** Build Power BI Direct Lake semantic model on Gold tables.
