# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Security Dashboard
# MAGIC
# MAGIC This notebook creates security metrics for the surveillance dashboard.
# MAGIC
# MAGIC ## Key Metrics:
# MAGIC - Incident counts by type and severity
# MAGIC - Response time tracking
# MAGIC - Location hotspots
# MAGIC - Threat trend analysis

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

# Imports, Fabric parameter shim, and configuration — all in one cell so the
# shim is guaranteed to be defined before it's called (avoids NameError when
# cells are run out of order after import).
import os
from datetime import datetime

from delta.tables import DeltaTable
from pyspark.sql.functions import (
    array,
    array_compact,
    avg,
    col,
    count,
    countDistinct,
    current_timestamp,
    exists,
    greatest,
    lit,
    max,
    round,
    size,
    sum,
    when,
)
from pyspark.sql.types import DateType, DoubleType, LongType, StructField, StructType


def _get_arg(name: str, default=None):
    """Read a notebook parameter from Fabric/Synapse runtime, env var, or default."""
    try:
        import notebookutils  # Fabric runtime
        return notebookutils.notebook.getArgument(name, default)
    except Exception:
        try:
            import mssparkutils  # legacy Synapse/Fabric runtime
            return mssparkutils.notebook.getArgument(name, default)
        except Exception:
            return os.environ.get(name.upper(), default)


def _notebook_exit(status: str) -> None:
    """Exit the notebook with a status message (Fabric/Synapse pipelines consume this)."""
    try:
        import notebookutils
        notebookutils.notebook.exit(status)
    except Exception:
        try:
            import mssparkutils
            mssparkutils.notebook.exit(status)
        except Exception:
            raise SystemExit(status)


# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source and target (three-part names for schema-enabled Lakehouses)
source_table = "lh_silver.dbo.silver_security_enriched"
target_table = "lh_gold.dbo.gold_security_dashboard"

print(f"Processing batch: {batch_id}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Check Source Table

# COMMAND ----------

table_exists = spark.catalog.tableExists(source_table)
print(f"Source table exists: {table_exists}")

if table_exists:
    df_silver = spark.table(source_table)
    print(f"Silver records: {df_silver.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Daily Security Aggregations

# COMMAND ----------

if table_exists:
    # Daily summary
    df_daily = df_silver \
        .groupBy("event_date") \
        .agg(
            # Volume metrics
            count("*").alias("total_events"),
            countDistinct("location_id").alias("locations_with_events"),

            # Severity breakdown
            sum(when(col("severity_level") == "CRITICAL", 1).otherwise(0)).alias("critical_events"),
            sum(when(col("severity_level") == "HIGH", 1).otherwise(0)).alias("high_events"),
            sum(when(col("severity_level") == "MEDIUM", 1).otherwise(0)).alias("medium_events"),
            sum(when(col("severity_level") == "LOW", 1).otherwise(0)).alias("low_events"),

            # Incident type breakdown
            sum(when(col("incident_type") == "ACTIVE_THREAT", 1).otherwise(0)).alias("active_threats"),
            sum(when(col("incident_type") == "EXCLUSION_BREACH", 1).otherwise(0)).alias("exclusion_breaches"),
            sum(when(col("incident_type") == "DISTURBANCE", 1).otherwise(0)).alias("disturbances"),
            sum(when(col("incident_type") == "ACCESS_VIOLATION", 1).otherwise(0)).alias("access_violations"),
            sum(when(col("incident_type") == "MEDICAL", 1).otherwise(0)).alias("medical_emergencies"),

            # Threat metrics
            avg("threat_score").alias("avg_threat_score"),
            max("threat_score").alias("max_threat_score"),
            sum(when(col("threat_score") >= 75, 1).otherwise(0)).alias("high_threat_events"),

            # Response metrics
            sum(when(col("requires_dispatch"), 1).otherwise(0)).alias("dispatch_required"),
            sum(when(col("requires_review"), 1).otherwise(0)).alias("review_required"),

            # Cluster events
            sum(when(col("is_cluster_event"), 1).otherwise(0)).alias("cluster_events"),

            # Repeat persons
            countDistinct(when(col("is_repeat_person"), col("person_id"))).alias("repeat_persons")
        )
else:
    schema = StructType([
        StructField("event_date", DateType()),
        StructField("total_events", LongType()),
        StructField("locations_with_events", LongType()),
        StructField("critical_events", LongType()),
        StructField("high_events", LongType()),
        StructField("medium_events", LongType()),
        StructField("low_events", LongType()),
        StructField("active_threats", LongType()),
        StructField("exclusion_breaches", LongType()),
        StructField("disturbances", LongType()),
        StructField("access_violations", LongType()),
        StructField("medical_emergencies", LongType()),
        StructField("avg_threat_score", DoubleType()),
        StructField("max_threat_score", DoubleType()),
        StructField("high_threat_events", LongType()),
        StructField("dispatch_required", LongType()),
        StructField("review_required", LongType()),
        StructField("cluster_events", LongType()),
        StructField("repeat_persons", LongType())
    ])
    df_daily = spark.createDataFrame([], schema)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Calculate Security KPIs

# COMMAND ----------

df_with_kpis = df_daily \
    .withColumn("severity_score",
        round((col("critical_events") * 100 +
               col("high_events") * 75 +
               col("medium_events") * 50 +
               col("low_events") * 25) /
              greatest(col("total_events"), lit(1)), 1)) \
    .withColumn("critical_rate",
        round(col("critical_events") / greatest(col("total_events"), lit(1)) * 100, 2)) \
    .withColumn("high_threat_rate",
        round(col("high_threat_events") / greatest(col("total_events"), lit(1)) * 100, 2)) \
    .withColumn("dispatch_rate",
        round(col("dispatch_required") / greatest(col("total_events"), lit(1)) * 100, 2))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Security Status Classification

# COMMAND ----------

df_with_status = df_with_kpis \
    .withColumn("daily_security_status",
        when((col("active_threats") > 0) | (col("critical_events") >= 3), "CRITICAL")
        .when((col("critical_events") >= 1) | (col("high_events") >= 5), "ELEVATED")
        .when(col("high_events") >= 2, "MODERATE")
        .otherwise("NORMAL")) \
    .withColumn("security_alerts",
        array_compact(array(
            when(col("active_threats") > 0, lit("ACTIVE_THREAT_ALERT")),
            when(col("exclusion_breaches") > 0, lit("EXCLUSION_BREACH_ALERT")),
            when(col("medical_emergencies") > 0, lit("MEDICAL_EMERGENCY")),
            when(col("cluster_events") >= 10, lit("HOTSPOT_DETECTED")),
            when(col("repeat_persons") >= 5, lit("REPEAT_OFFENDER_ACTIVITY")),
            when(col("avg_threat_score") >= 60, lit("HIGH_THREAT_ENVIRONMENT"))
        ))) \
    .withColumn("alert_count", size(col("security_alerts")))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Gold Metadata

# COMMAND ----------

df_gold = df_with_status \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Gold Table

# COMMAND ----------

try:
    # Write to Gold — incremental MERGE on event_date natural key
    if spark.catalog.tableExists(target_table):
        deltaTable = DeltaTable.forName(spark, target_table)
        deltaTable.alias("target").merge(
            df_gold.alias("source"),
            "target.event_date = source.event_date"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_gold.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("event_date") \
            .option("overwriteSchema", "true") \
            .saveAsTable(target_table)

    print(f"Merged {spark.table(target_table).count():,} records into {target_table}")
except Exception as e:
    print(f"ERROR in lh_gold.gold_security_dashboard (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize for Direct Lake

# COMMAND ----------

# event_date is the partition column, so it can't appear in ZORDER. Plain OPTIMIZE
# still compacts parquet files for Direct Lake.
spark.sql(f"OPTIMIZE {target_table}")
print("Table optimized with Z-Order on event_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Security Dashboard Summary

# COMMAND ----------

# Overall security metrics
spark.sql(f"""
    SELECT
        MIN(event_date) as period_start,
        MAX(event_date) as period_end,
        SUM(total_events) as total_events,
        SUM(critical_events) as critical_total,
        SUM(high_events) as high_total,
        SUM(active_threats) as active_threats_total,
        SUM(exclusion_breaches) as exclusion_breaches_total,
        ROUND(AVG(avg_threat_score), 1) as avg_threat_score
    FROM {target_table}
""").show()

# COMMAND ----------

# Daily status trend
spark.sql(f"""
    SELECT
        event_date,
        total_events,
        daily_security_status,
        severity_score,
        critical_events,
        high_events,
        dispatch_required
    FROM {target_table}
    ORDER BY event_date DESC
    LIMIT 10
""").show()

# COMMAND ----------

# Days with alerts
spark.sql(f"""
    SELECT
        event_date,
        daily_security_status,
        alert_count,
        security_alerts
    FROM {target_table}
    WHERE alert_count > 0
    ORDER BY event_date DESC
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Critical Days Analysis

# COMMAND ----------

spark.sql(f"""
    SELECT
        event_date,
        active_threats,
        critical_events,
        exclusion_breaches,
        medical_emergencies,
        max_threat_score
    FROM {target_table}
    WHERE daily_security_status IN ('CRITICAL', 'ELEVATED')
    ORDER BY event_date DESC
""").show()
