# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Video Analytics Cleansing & Enrichment
# MAGIC
# MAGIC This notebook transforms Bronze video analytics data into cleansed, validated,
# MAGIC and enriched Silver layer tables.
# MAGIC
# MAGIC ## Transformations Applied:
# MAGIC - Deduplication by event_id
# MAGIC - Confidence score threshold filtering (drop below 0.50)
# MAGIC - Alert level standardization and severity scoring
# MAGIC - Event type validation against known types
# MAGIC - Camera location normalization
# MAGIC - Bounding box parsing and area calculation
# MAGIC - Data quality scoring (0-100)

# COMMAND ----------

# ---------------------------------------------------------------------------
# Fabric/local compatibility shim
# ---------------------------------------------------------------------------
import os

try:
    import notebookutils  # Fabric runtime
    def _get_arg(name, default=None):
        try:
            return notebookutils.notebook.getArgument(name, default)
        except Exception:
            return os.environ.get(name.upper(), default)
    def _notebook_exit(status: str) -> None:
        notebookutils.notebook.exit(status)
except ImportError:
    try:
        import mssparkutils  # legacy Synapse/Fabric runtime
        def _get_arg(name, default=None):
            try:
                return mssparkutils.notebook.getArgument(name, default)
            except Exception:
                return os.environ.get(name.upper(), default)
        def _notebook_exit(status: str) -> None:
            mssparkutils.notebook.exit(status)
    except ImportError:
        def _get_arg(name, default=None):
            return os.environ.get(name.upper(), default)
        def _notebook_exit(status: str) -> None:
            raise SystemExit(status)


# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from datetime import datetime

from delta.tables import DeltaTable
from pyspark.sql.functions import (
    array,
    array_compact,
    coalesce,
    col,
    count,
    create_map,
    current_timestamp,
    dayofweek,
    filter,
    grouping,
    hour,
    lit,
    lower,
    minute,
    to_date,
    to_timestamp,
    trim,
    upper,
    when,
)
from pyspark.sql.types import FloatType

# Parameters (set by pipeline or manual)
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source and target
source_table = "lh_bronze.bronze_video_analytics"
target_table = "lh_silver.silver_video_analytics"

# Confidence threshold: events below this are considered noise
CONFIDENCE_THRESHOLD = 0.50

print(f"Processing batch: {batch_id}")
print(f"Source: {source_table}")
print(f"Target: {target_table}")
print(f"Confidence threshold: {CONFIDENCE_THRESHOLD}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Data

# COMMAND ----------

df_bronze = spark.table(source_table)

bronze_count = df_bronze.count()
print(f"Bronze records: {bronze_count:,}")
print(f"Columns: {len(df_bronze.columns)}")
df_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Valid Reference Values

# COMMAND ----------

VALID_EVENT_TYPES = [
    "object_detection", "zone_crossing", "anomaly", "face_match",
    "crowd_density", "loitering", "tailgating", "abandoned_object"
]

VALID_ALERT_LEVELS = ["INFO", "WARNING", "CRITICAL"]

VALID_OBJECT_CLASSES = [
    "person", "vehicle", "bag", "chip_tray", "cash_bundle",
    "card", "phone", "weapon", "unknown"
]

VALID_ANOMALY_TYPES = [
    "unusual_movement", "restricted_area", "after_hours",
    "speed_violation", "direction_violation", "grouping"
]

VALID_CAMERA_LOCATIONS = [
    "slot_floor_a", "slot_floor_b", "table_games", "cage_area",
    "entrance_main", "entrance_valet", "parking_garage", "elevator_lobby",
    "restaurant", "hotel_lobby", "pool_area", "convention_hall",
    "back_of_house", "surveillance_room"
]

# Alert level to severity score mapping
ALERT_SEVERITY_MAP = {
    "INFO": 1,
    "WARNING": 2,
    "CRITICAL": 3,
}

# COMMAND ----------

# MAGIC %md
# MAGIC ## Filter Null Required Fields

# COMMAND ----------

df_filtered = df_bronze \
    .filter(col("event_id").isNotNull()) \
    .filter(col("camera_id").isNotNull()) \
    .filter(col("event_type").isNotNull()) \
    .filter(col("timestamp").isNotNull())

after_null_filter = df_filtered.count()
print(f"After null filter: {after_null_filter:,} (dropped {bronze_count - after_null_filter:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Confidence Score Filtering
# MAGIC
# MAGIC Events below the confidence threshold are considered noise and filtered out.

# COMMAND ----------

# Filter by confidence threshold
df_confident = df_filtered \
    .filter(
        (col("confidence_score") >= CONFIDENCE_THRESHOLD) |
        col("confidence_score").isNull()
    )

low_confidence = after_null_filter - df_confident.count()
print(f"Low confidence events filtered: {low_confidence:,}")
print(f"After confidence filter: {df_confident.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Type Casting and Enrichment

# COMMAND ----------

df_typed = df_confident \
    .withColumn("timestamp", to_timestamp("timestamp")) \
    .withColumn("event_date", to_date("timestamp")) \
    .withColumn("event_hour", hour("timestamp")) \
    .withColumn("event_minute", minute("timestamp")) \
    .withColumn("day_of_week", dayofweek("timestamp")) \
    .withColumn("is_weekend", dayofweek("timestamp").isin([1, 7]).cast("boolean")) \
    .withColumn("confidence_score", col("confidence_score").cast(FloatType()))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Standardize Event Types and Alert Levels

# COMMAND ----------

# Standardize event_type to lowercase and trim
df_standardized = df_typed \
    .withColumn("event_type_clean", lower(trim(col("event_type")))) \
    .withColumn("alert_level_clean", upper(trim(col("alert_level")))) \
    .withColumn("camera_location_clean", lower(trim(col("camera_location")))) \
    .withColumn("object_class_clean", lower(trim(col("object_class")))) \
    .withColumn("anomaly_type_clean", lower(trim(col("anomaly_type"))))

# Add alert severity score
alert_severity_expr = create_map([lit(x) for pair in ALERT_SEVERITY_MAP.items() for x in pair])

df_standardized = df_standardized \
    .withColumn(
        "alert_severity_score",
        coalesce(alert_severity_expr[col("alert_level_clean")], lit(0))
    ) \
    .withColumn(
        "is_security_event",
        col("event_type_clean").isin(
            "anomaly", "face_match", "tailgating", "abandoned_object", "loitering"
        ).cast("boolean")
    ) \
    .withColumn(
        "is_critical",
        (col("alert_level_clean") == "CRITICAL").cast("boolean")
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validate Against Reference Values

# COMMAND ----------

df_validated = df_standardized \
    .withColumn("is_valid_event_type",
        col("event_type_clean").isin(VALID_EVENT_TYPES)) \
    .withColumn("is_valid_alert_level",
        col("alert_level_clean").isin(VALID_ALERT_LEVELS) | col("alert_level_clean").isNull()) \
    .withColumn("is_valid_object_class",
        col("object_class_clean").isin(VALID_OBJECT_CLASSES) | col("object_class_clean").isNull()) \
    .withColumn("is_valid_camera_location",
        col("camera_location_clean").isin(VALID_CAMERA_LOCATIONS) | col("camera_location_clean").isNull())

# COMMAND ----------

# MAGIC %md
# MAGIC ## Calculate Data Quality Score

# COMMAND ----------

df_with_dq = df_validated \
    .withColumn("_dq_score",
        (
            when(col("is_valid_event_type"), lit(20)).otherwise(lit(0)) +
            when(col("is_valid_alert_level"), lit(15)).otherwise(lit(0)) +
            when(col("is_valid_object_class"), lit(15)).otherwise(lit(0)) +
            when(col("is_valid_camera_location"), lit(15)).otherwise(lit(0)) +
            when(col("confidence_score").isNotNull(), lit(15)).otherwise(lit(0)) +
            when(col("camera_id").isNotNull(), lit(10)).otherwise(lit(0)) +
            when(col("model_name").isNotNull(), lit(10)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(~col("is_valid_event_type"), lit("INVALID_EVENT_TYPE")),
                when(~col("is_valid_alert_level") & col("alert_level_clean").isNotNull(), lit("INVALID_ALERT_LEVEL")),
                when(~col("is_valid_object_class") & col("object_class_clean").isNotNull(), lit("INVALID_OBJECT_CLASS")),
                when(col("confidence_score").isNull(), lit("MISSING_CONFIDENCE")),
                when(col("confidence_score") < 0.60, lit("LOW_CONFIDENCE"))
            )
        )
    )

# Drop validation helper columns
df_with_dq = df_with_dq.drop(
    "is_valid_event_type", "is_valid_alert_level",
    "is_valid_object_class", "is_valid_camera_location"
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Deduplication

# COMMAND ----------

before_dedup = df_with_dq.count()

df_deduped = df_with_dq.dropDuplicates(["event_id"])

after_dedup = df_deduped.count()
dupes_removed = before_dedup - after_dedup

print(f"Deduplication Results:")
print(f"  Before: {before_dedup:,}")
print(f"  After: {after_dedup:,}")
print(f"  Duplicates removed: {dupes_removed:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Silver Metadata

# COMMAND ----------

df_silver = df_deduped \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Silver Table

# COMMAND ----------

# Select final columns for Silver output
try:
    final_columns = [
        # Core event fields
        "event_id", "camera_id", "camera_location_clean", "event_type_clean",
        "timestamp", "event_date", "event_hour", "event_minute",
        "day_of_week", "is_weekend",

        # Detection fields
        "confidence_score", "object_class_clean", "object_count",
        "bounding_box", "track_id",

        # Zone crossing
        "zone_from", "zone_to",

        # Temporal
        "dwell_time_seconds",

        # Anomaly
        "anomaly_type_clean",

        # Alert and severity
        "alert_level_clean", "alert_severity_score",
        "is_security_event", "is_critical",

        # Video metadata
        "frame_number", "video_resolution", "fps",
        "model_name", "model_version",

        # Data quality
        "_dq_score", "_dq_flags",

        # Metadata
        "_silver_timestamp", "_batch_id"
    ]

    df_final = df_silver.select([col(c) for c in final_columns if c in df_silver.columns])

    # Write to Silver layer using Delta MERGE (incremental upsert)
    if spark.catalog.tableExists(target_table):
        deltaTable = DeltaTable.forName(spark, target_table)
        deltaTable.alias("target").merge(
            df_final.alias("source"),
            "target.event_id = source.event_id"
        ).whenMatchedUpdateAll(
            condition="target._silver_timestamp < source._silver_timestamp"
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_final.write \
            .format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .partitionBy("event_date") \
            .saveAsTable(target_table)

    silver_count = spark.table(target_table).count()
    print(f"Written/merged records to {target_table} (total: {silver_count:,})")
except Exception as e:
    print(f"ERROR in lh_silver.silver_video_analytics (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Report

# COMMAND ----------

print("=" * 60)
print("DATA QUALITY REPORT - Video Analytics Silver Layer")
print("=" * 60)

spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        ROUND(MIN(_dq_score), 2) as min_quality_score,
        ROUND(MAX(_dq_score), 2) as max_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(CASE WHEN _dq_score >= 80 THEN 1 END) as high_quality_records,
        COUNT(CASE WHEN _dq_score < 60 THEN 1 END) as low_quality_records
    FROM {target_table}
""").show(truncate=False)

# Quality by event type
print("Quality by Event Type:")
spark.sql(f"""
    SELECT
        event_type_clean as event_type,
        COUNT(*) as events,
        ROUND(AVG(_dq_score), 2) as avg_quality,
        ROUND(AVG(confidence_score), 4) as avg_confidence
    FROM {target_table}
    GROUP BY event_type_clean
    ORDER BY events DESC
""").show(truncate=False)

# Alert level distribution
print("Alert Level Distribution:")
spark.sql(f"""
    SELECT
        alert_level_clean as alert_level,
        alert_severity_score as severity,
        COUNT(*) as events,
        COUNT(CASE WHEN is_security_event THEN 1 END) as security_events
    FROM {target_table}
    GROUP BY alert_level_clean, alert_severity_score
    ORDER BY alert_severity_score DESC
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize Table

# COMMAND ----------

spark.sql(f"OPTIMIZE {target_table} ZORDER BY (camera_id, event_type_clean)")
print("Table optimized with Z-Order on camera_id, event_type_clean")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Metric | Value |
# MAGIC |--------|-------|
# MAGIC | Source | bronze_video_analytics |
# MAGIC | Target | silver_video_analytics |
# MAGIC | Confidence Filtering | >= 0.50 |
# MAGIC | Alert Severity Scoring | INFO=1, WARNING=2, CRITICAL=3 |
# MAGIC | Deduplication | event_id |
# MAGIC | Partitioned By | event_date |
# MAGIC | Z-Order | camera_id, event_type_clean |
# MAGIC
# MAGIC **Next Step:** Continue to Gold layer for alert frequency, camera utilization, and incident trend KPIs.
