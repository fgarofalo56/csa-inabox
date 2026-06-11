# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Geolocation Data Cleansing & Enrichment
# MAGIC
# MAGIC This notebook transforms Bronze geolocation data into cleansed, validated,
# MAGIC and enriched Silver layer tables.
# MAGIC
# MAGIC ## Transformations Applied:
# MAGIC - Deduplication by event_id
# MAGIC - GPS coordinate validation and out-of-range filtering
# MAGIC - H3 index presence verification and resolution tagging
# MAGIC - Geofence event validation and dwell time normalization
# MAGIC - Device type and source system standardization
# MAGIC - Speed and accuracy range validation
# MAGIC - Indoor/outdoor classification
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
    hour,
    lit,
    lower,
    round,
    to_date,
    to_timestamp,
    trim,
    when,
)
from pyspark.sql.types import DoubleType, FloatType, IntegerType

# Parameters (set by pipeline or manual)
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source and target
source_table = "lh_bronze.bronze_geolocation"
target_table = "lh_silver.silver_geolocation"

# Coordinate bounds (Las Vegas metropolitan area)
LAT_MIN, LAT_MAX = 35.5, 36.5
LON_MIN, LON_MAX = -115.5, -114.5

# Maximum reasonable speed for campus (m/s)
MAX_SPEED_MPS = 35.0  # ~78 mph for vehicle
MAX_WALKING_SPEED_MPS = 2.5

print(f"Processing batch: {batch_id}")
print(f"Source: {source_table}")
print(f"Target: {target_table}")
print(f"Coordinate bounds: lat [{LAT_MIN}, {LAT_MAX}], lon [{LON_MIN}, {LON_MAX}]")

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

VALID_DEVICE_TYPES = ["patron_app", "employee_badge", "asset_tag", "vehicle_gps", "shuttle_tracker", "valet_tag"]
VALID_SOURCE_SYSTEMS = ["gps", "wifi_triangulation", "ble_trilateration", "uwb", "hybrid"]
VALID_GEOFENCE_EVENTS = ["enter", "exit", "dwell"]
VALID_PROXIMITY_TRIGGERS = ["marketing_push", "loyalty_offer", "vip_greeting", "safety_alert", "staff_dispatch"]

# Device type to mobility classification
DEVICE_MOBILITY_MAP = {
    "patron_app": "pedestrian",
    "employee_badge": "pedestrian",
    "asset_tag": "stationary",
    "vehicle_gps": "vehicle",
    "shuttle_tracker": "vehicle",
    "valet_tag": "vehicle",
}

# Source system accuracy tiers
SOURCE_ACCURACY_TIER = {
    "uwb": "high",
    "ble_trilateration": "high",
    "hybrid": "medium",
    "gps": "medium",
    "wifi_triangulation": "low",
}

# COMMAND ----------

# MAGIC %md
# MAGIC ## Filter Null Required Fields

# COMMAND ----------

df_filtered = df_bronze \
    .filter(col("event_id").isNotNull()) \
    .filter(col("device_id").isNotNull()) \
    .filter(col("timestamp").isNotNull())

after_null_filter = df_filtered.count()
print(f"After null filter: {after_null_filter:,} (dropped {bronze_count - after_null_filter:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## GPS Coordinate Validation
# MAGIC
# MAGIC Filter out records with coordinates outside the Las Vegas metropolitan area.

# COMMAND ----------

# Count coordinate issues
null_coords = df_filtered.filter(
    col("latitude").isNull() | col("longitude").isNull()
).count()

out_of_bounds = df_filtered.filter(
    col("latitude").isNotNull() & col("longitude").isNotNull() &
    (
        (col("latitude") < LAT_MIN) | (col("latitude") > LAT_MAX) |
        (col("longitude") < LON_MIN) | (col("longitude") > LON_MAX)
    )
).count()

print(f"Coordinate Validation:")
print(f"  Null coordinates: {null_coords:,}")
print(f"  Out-of-bounds coordinates: {out_of_bounds:,}")

# Keep records with valid or null coordinates (null coordinates from indoor positioning)
df_coord_valid = df_filtered.filter(
    col("latitude").isNull() | col("longitude").isNull() |
    (
        (col("latitude") >= LAT_MIN) & (col("latitude") <= LAT_MAX) &
        (col("longitude") >= LON_MIN) & (col("longitude") <= LON_MAX)
    )
)

print(f"After coordinate validation: {df_coord_valid.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Type Casting and Time Enrichment

# COMMAND ----------

df_typed = df_coord_valid \
    .withColumn("timestamp", to_timestamp("timestamp")) \
    .withColumn("event_date", to_date("timestamp")) \
    .withColumn("event_hour", hour("timestamp")) \
    .withColumn("day_of_week", dayofweek("timestamp")) \
    .withColumn("is_weekend", dayofweek("timestamp").isin([1, 7]).cast("boolean")) \
    .withColumn("latitude", col("latitude").cast(DoubleType())) \
    .withColumn("longitude", col("longitude").cast(DoubleType())) \
    .withColumn("accuracy_meters", col("accuracy_meters").cast(FloatType())) \
    .withColumn("speed_mps", col("speed_mps").cast(FloatType()))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Standardize Device Types and Source Systems

# COMMAND ----------

device_mobility_expr = create_map([lit(x) for pair in DEVICE_MOBILITY_MAP.items() for x in pair])
source_accuracy_expr = create_map([lit(x) for pair in SOURCE_ACCURACY_TIER.items() for x in pair])

df_standardized = df_typed \
    .withColumn("device_type_clean", lower(trim(col("device_type")))) \
    .withColumn("source_system_clean", lower(trim(col("source_system")))) \
    .withColumn("geofence_event_clean", lower(trim(col("geofence_event")))) \
    .withColumn("indoor_zone_clean", trim(col("indoor_zone"))) \
    .withColumn(
        "mobility_class",
        coalesce(device_mobility_expr[lower(trim(col("device_type")))], lit("unknown"))
    ) \
    .withColumn(
        "accuracy_tier",
        coalesce(source_accuracy_expr[lower(trim(col("source_system")))], lit("unknown"))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Indoor/Outdoor Classification

# COMMAND ----------

df_classified = df_standardized \
    .withColumn(
        "location_type",
        when(col("floor_level").isNotNull() | col("indoor_zone_clean").isNotNull(), lit("indoor"))
        .otherwise(lit("outdoor"))
    ) \
    .withColumn(
        "has_h3_index",
        col("h3_index").isNotNull().cast("boolean")
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Speed and Accuracy Validation

# COMMAND ----------

df_cleaned = df_classified \
    .withColumn("speed_mps",
        when(col("speed_mps").isNull(), lit(None).cast(FloatType()))
        .when(col("speed_mps") < 0, lit(0.0))
        .when(col("speed_mps") > MAX_SPEED_MPS, lit(None).cast(FloatType()))
        .otherwise(col("speed_mps"))
    ) \
    .withColumn("speed_kmh",
        when(col("speed_mps").isNotNull(), round(col("speed_mps") * 3.6, 1))
    ) \
    .withColumn(
        "is_stationary",
        (coalesce(col("speed_mps"), lit(0.0)) < 0.1).cast("boolean")
    ) \
    .withColumn(
        "is_walking",
        (col("speed_mps").isNotNull() &
         (col("speed_mps") >= 0.1) &
         (col("speed_mps") <= MAX_WALKING_SPEED_MPS)).cast("boolean")
    ) \
    .withColumn(
        "is_vehicle_speed",
        (col("speed_mps").isNotNull() &
         (col("speed_mps") > MAX_WALKING_SPEED_MPS)).cast("boolean")
    )

# Normalize geofence dwell seconds
df_cleaned = df_cleaned \
    .withColumn("geofence_dwell_seconds",
        when(col("geofence_event_clean") != "dwell", lit(None).cast(IntegerType()))
        .otherwise(col("geofence_dwell_seconds"))
    ) \
    .withColumn("geofence_dwell_minutes",
        when(col("geofence_dwell_seconds").isNotNull(),
             round(col("geofence_dwell_seconds") / 60.0, 1))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validate Against Reference Values

# COMMAND ----------

df_validated = df_cleaned \
    .withColumn("is_valid_device_type",
        col("device_type_clean").isin(VALID_DEVICE_TYPES)) \
    .withColumn("is_valid_source_system",
        col("source_system_clean").isin(VALID_SOURCE_SYSTEMS) | col("source_system_clean").isNull()) \
    .withColumn("is_valid_geofence_event",
        col("geofence_event_clean").isin(VALID_GEOFENCE_EVENTS) | col("geofence_event_clean").isNull()) \
    .withColumn("is_valid_coordinates",
        col("latitude").isNotNull() & col("longitude").isNotNull())

# COMMAND ----------

# MAGIC %md
# MAGIC ## Calculate Data Quality Score

# COMMAND ----------

df_with_dq = df_validated \
    .withColumn("_dq_score",
        (
            when(col("is_valid_device_type"), lit(15)).otherwise(lit(0)) +
            when(col("is_valid_source_system"), lit(15)).otherwise(lit(0)) +
            when(col("is_valid_coordinates"), lit(20)).otherwise(lit(0)) +
            when(col("accuracy_meters").isNotNull() & (col("accuracy_meters") <= 50), lit(15)).otherwise(lit(5)) +
            when(col("has_h3_index"), lit(10)).otherwise(lit(0)) +
            when(col("is_valid_geofence_event"), lit(10)).otherwise(lit(0)) +
            when(col("battery_level").isNotNull(), lit(5)).otherwise(lit(0)) +
            when(col("speed_mps").isNotNull(), lit(5)).otherwise(lit(0)) +
            when(col("poi_name").isNotNull(), lit(5)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(~col("is_valid_device_type"), lit("INVALID_DEVICE_TYPE")),
                when(~col("is_valid_coordinates"), lit("MISSING_COORDINATES")),
                when(~col("is_valid_source_system") & col("source_system_clean").isNotNull(), lit("INVALID_SOURCE_SYSTEM")),
                when(col("accuracy_meters").isNotNull() & (col("accuracy_meters") > 50), lit("LOW_ACCURACY")),
                when(~col("has_h3_index"), lit("MISSING_H3_INDEX"))
            )
        )
    )

# Drop validation helper columns
df_with_dq = df_with_dq.drop(
    "is_valid_device_type", "is_valid_source_system",
    "is_valid_geofence_event", "is_valid_coordinates"
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
        "event_id", "device_id", "device_type_clean",
        "timestamp", "event_date", "event_hour", "day_of_week", "is_weekend",

        # Location
        "latitude", "longitude", "altitude_meters",
        "accuracy_meters", "accuracy_tier",
        "h3_index", "has_h3_index",

        # Movement
        "speed_mps", "speed_kmh", "heading_degrees",
        "mobility_class", "is_stationary", "is_walking", "is_vehicle_speed",

        # Geofence
        "geofence_id", "geofence_name", "geofence_event_clean",
        "geofence_dwell_seconds", "geofence_dwell_minutes",

        # Points of interest
        "poi_name", "poi_distance_meters",

        # Indoor positioning
        "floor_level", "indoor_zone_clean", "location_type",

        # Triggers
        "proximity_trigger",

        # Source and device metadata
        "source_system_clean", "battery_level",

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
    print(f"ERROR in lh_silver.silver_geolocation (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Report

# COMMAND ----------

print("=" * 60)
print("DATA QUALITY REPORT - Geolocation Silver Layer")
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

# Quality by device type
print("Quality by Device Type:")
spark.sql(f"""
    SELECT
        device_type_clean as device_type,
        mobility_class,
        COUNT(*) as events,
        ROUND(AVG(_dq_score), 2) as avg_quality,
        ROUND(AVG(accuracy_meters), 2) as avg_accuracy_m
    FROM {target_table}
    GROUP BY device_type_clean, mobility_class
    ORDER BY events DESC
""").show(truncate=False)

# Location type distribution
print("Location Type Distribution:")
spark.sql(f"""
    SELECT
        location_type,
        accuracy_tier,
        COUNT(*) as events,
        SUM(CASE WHEN has_h3_index THEN 1 ELSE 0 END) as with_h3
    FROM {target_table}
    GROUP BY location_type, accuracy_tier
    ORDER BY events DESC
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize Table

# COMMAND ----------

spark.sql(f"OPTIMIZE {target_table} ZORDER BY (device_id, device_type_clean)")
print("Table optimized with Z-Order on device_id, device_type_clean")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Metric | Value |
# MAGIC |--------|-------|
# MAGIC | Source | bronze_geolocation |
# MAGIC | Target | silver_geolocation |
# MAGIC | Coordinate Validation | Las Vegas metro area bounds |
# MAGIC | H3 Index | Presence verified |
# MAGIC | Speed Classification | Stationary / Walking / Vehicle |
# MAGIC | Geofence Normalization | Dwell time cleaned for non-dwell events |
# MAGIC | Deduplication | event_id |
# MAGIC | Partitioned By | event_date |
# MAGIC | Z-Order | device_id, device_type_clean |
# MAGIC
# MAGIC **Next Step:** Continue to Gold layer for geofence breach summaries, device tracking, and H3 density analysis.
