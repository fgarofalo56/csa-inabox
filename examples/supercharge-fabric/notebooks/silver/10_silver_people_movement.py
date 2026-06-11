# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: People Movement Data Cleansing & Enrichment
# MAGIC
# MAGIC This notebook transforms Bronze people movement data into cleansed, validated,
# MAGIC and enriched Silver layer tables.
# MAGIC
# MAGIC ## Transformations Applied:
# MAGIC - Deduplication by event_id
# MAGIC - Sensor type validation and standardization
# MAGIC - Zone mapping enrichment (capacity, floor)
# MAGIC - Queue metric normalization
# MAGIC - Occupancy percentage recalculation and capping
# MAGIC - Velocity and dwell time range validation
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
    least,
    lit,
    lower,
    round,
    to_date,
    to_timestamp,
    trim,
    when,
)
from pyspark.sql.types import FloatType, IntegerType

# Parameters (set by pipeline or manual)
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source and target
source_table = "lh_bronze.bronze_people_movement"
target_table = "lh_silver.silver_people_movement"

print(f"Processing batch: {batch_id}")
print(f"Source: {source_table}")
print(f"Target: {target_table}")

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
# MAGIC ## Define Valid Reference Values and Zone Configuration

# COMMAND ----------

VALID_SENSOR_TYPES = ["wifi_probe", "ble_beacon", "camera_count", "infrared", "pressure_mat", "lidar"]
VALID_DIRECTIONS = ["entering", "exiting", "stationary", "passing_through"]

# Zone capacity lookup for occupancy recalculation
ZONE_CAPACITY_MAP = {
    "Main Slot Floor": 400, "High-Limit Slots": 60, "Poker Room": 120,
    "Blackjack Pit A": 100, "Blackjack Pit B": 100, "Craps Area": 80,
    "Roulette Section": 60, "VIP Lounge": 30, "Sports Book": 150,
    "Buffet": 200, "Steakhouse": 80, "Main Bar": 60,
    "Cage Window 1": 20, "Cage Window 2": 20, "Cage Window 3": 20,
    "Cage Window 4": 20, "Cage Window 5": 20,
    "Entrance North": 50, "Entrance South": 50, "Entrance Valet": 40,
    "Elevator Bank A": 25, "Elevator Bank B": 25, "Hotel Check-In": 40,
    "Pool Deck": 100, "Convention Hall A": 300, "Convention Hall B": 300,
    "Back of House Corridor": 30, "Baccarat Salon": 40, "Race Book": 60,
}

# Zone category mapping for analytics
ZONE_CATEGORY_MAP = {
    "Main Slot Floor": "Gaming", "High-Limit Slots": "Gaming",
    "Poker Room": "Gaming", "Blackjack Pit A": "Gaming", "Blackjack Pit B": "Gaming",
    "Craps Area": "Gaming", "Roulette Section": "Gaming", "Baccarat Salon": "Gaming",
    "Sports Book": "Gaming", "Race Book": "Gaming",
    "VIP Lounge": "VIP",
    "Buffet": "Dining", "Steakhouse": "Dining", "Main Bar": "Dining",
    "Cage Window 1": "Cage", "Cage Window 2": "Cage", "Cage Window 3": "Cage",
    "Cage Window 4": "Cage", "Cage Window 5": "Cage",
    "Entrance North": "Entrance", "Entrance South": "Entrance", "Entrance Valet": "Entrance",
    "Elevator Bank A": "Transit", "Elevator Bank B": "Transit",
    "Hotel Check-In": "Hotel", "Pool Deck": "Amenity",
    "Convention Hall A": "Convention", "Convention Hall B": "Convention",
    "Back of House Corridor": "Back of House",
}

# COMMAND ----------

# MAGIC %md
# MAGIC ## Filter Null Required Fields

# COMMAND ----------

df_filtered = df_bronze \
    .filter(col("event_id").isNotNull()) \
    .filter(col("sensor_id").isNotNull()) \
    .filter(col("zone_id").isNotNull()) \
    .filter(col("timestamp").isNotNull())

after_null_filter = df_filtered.count()
print(f"After null filter: {after_null_filter:,} (dropped {bronze_count - after_null_filter:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Type Casting and Time Enrichment

# COMMAND ----------

df_typed = df_filtered \
    .withColumn("timestamp", to_timestamp("timestamp")) \
    .withColumn("event_date", to_date("timestamp")) \
    .withColumn("event_hour", hour("timestamp")) \
    .withColumn("day_of_week", dayofweek("timestamp")) \
    .withColumn("is_weekend", dayofweek("timestamp").isin([1, 7]).cast("boolean")) \
    .withColumn("person_count", col("person_count").cast(IntegerType())) \
    .withColumn("dwell_time_seconds", col("dwell_time_seconds").cast(FloatType())) \
    .withColumn("velocity_mps", col("velocity_mps").cast(FloatType())) \
    .withColumn("occupancy_percentage", col("occupancy_percentage").cast(FloatType())) \
    .withColumn("queue_wait_minutes", col("queue_wait_minutes").cast(FloatType()))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Standardize Sensor Types and Directions

# COMMAND ----------

df_standardized = df_typed \
    .withColumn("sensor_type_clean", lower(trim(col("sensor_type")))) \
    .withColumn("direction_clean", lower(trim(col("direction")))) \
    .withColumn("zone_name_clean", trim(col("zone_name")))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Zone Enrichment
# MAGIC
# MAGIC Add zone capacity, category, and recalculate occupancy.

# COMMAND ----------

# Build zone capacity map expression
zone_capacity_expr = create_map([lit(x) for pair in ZONE_CAPACITY_MAP.items() for x in pair])
zone_category_expr = create_map([lit(x) for pair in ZONE_CATEGORY_MAP.items() for x in pair])

df_enriched = df_standardized \
    .withColumn(
        "zone_capacity",
        coalesce(zone_capacity_expr[col("zone_name_clean")], lit(100))
    ) \
    .withColumn(
        "zone_category",
        coalesce(zone_category_expr[col("zone_name_clean")], lit("Unknown"))
    ) \
    .withColumn(
        "occupancy_pct_recalculated",
        when(
            col("zone_capacity") > 0,
            least(
                round(col("person_count") / col("zone_capacity") * 100.0, 1),
                lit(100.0)
            )
        ).otherwise(col("occupancy_percentage"))
    ) \
    .withColumn(
        "occupancy_status",
        when(col("occupancy_pct_recalculated") >= 90, lit("CRITICAL"))
        .when(col("occupancy_pct_recalculated") >= 70, lit("HIGH"))
        .when(col("occupancy_pct_recalculated") >= 40, lit("MODERATE"))
        .otherwise(lit("LOW"))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validate and Clean Metrics

# COMMAND ----------

# Clamp velocity to valid range [0, 3.0] m/s (walking speed max)
df_cleaned = df_enriched \
    .withColumn("velocity_mps",
        when(col("velocity_mps") < 0, lit(0.0))
        .when(col("velocity_mps") > 3.0, lit(3.0))
        .otherwise(col("velocity_mps"))
    ) \
    .withColumn("person_count",
        when(col("person_count") < 0, lit(0))
        .otherwise(col("person_count"))
    ) \
    .withColumn("dwell_time_seconds",
        when(col("dwell_time_seconds") < 0, lit(0.0))
        .otherwise(col("dwell_time_seconds"))
    ) \
    .withColumn("dwell_time_minutes",
        round(col("dwell_time_seconds") / 60.0, 1)
    )

# Normalize queue metrics
df_cleaned = df_cleaned \
    .withColumn("queue_detected",
        when(col("queue_detected").isNull(), lit(False))
        .otherwise(col("queue_detected"))
    ) \
    .withColumn("queue_length",
        when(col("queue_detected") == False, lit(None).cast(IntegerType()))
        .otherwise(col("queue_length"))
    ) \
    .withColumn("queue_wait_minutes",
        when(col("queue_detected") == False, lit(None).cast(FloatType()))
        .otherwise(col("queue_wait_minutes"))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validate Against Reference Values

# COMMAND ----------

df_validated = df_cleaned \
    .withColumn("is_valid_sensor_type",
        col("sensor_type_clean").isin(VALID_SENSOR_TYPES)) \
    .withColumn("is_valid_direction",
        col("direction_clean").isin(VALID_DIRECTIONS) | col("direction_clean").isNull())

# COMMAND ----------

# MAGIC %md
# MAGIC ## Calculate Data Quality Score

# COMMAND ----------

df_with_dq = df_validated \
    .withColumn("_dq_score",
        (
            when(col("is_valid_sensor_type"), lit(20)).otherwise(lit(0)) +
            when(col("is_valid_direction"), lit(15)).otherwise(lit(0)) +
            when(col("person_count").isNotNull() & (col("person_count") >= 0), lit(20)).otherwise(lit(0)) +
            when(col("zone_name_clean").isNotNull(), lit(15)).otherwise(lit(0)) +
            when(col("occupancy_percentage").isNotNull(), lit(10)).otherwise(lit(0)) +
            when(col("dwell_time_seconds").isNotNull(), lit(10)).otherwise(lit(0)) +
            when(col("calibration_date").isNotNull(), lit(10)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(~col("is_valid_sensor_type"), lit("INVALID_SENSOR_TYPE")),
                when(~col("is_valid_direction") & col("direction_clean").isNotNull(), lit("INVALID_DIRECTION")),
                when(col("person_count").isNull(), lit("MISSING_PERSON_COUNT")),
                when(col("calibration_date").isNull(), lit("MISSING_CALIBRATION")),
                when(col("occupancy_pct_recalculated") > 100, lit("OVER_CAPACITY"))
            )
        )
    )

# Drop validation helper columns
df_with_dq = df_with_dq.drop("is_valid_sensor_type", "is_valid_direction")

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
        "event_id", "sensor_id", "sensor_type_clean", "zone_id", "zone_name_clean",
        "timestamp", "event_date", "event_hour", "day_of_week", "is_weekend",

        # Movement metrics
        "person_count", "direction_clean", "dwell_time_seconds", "dwell_time_minutes",
        "velocity_mps", "x_coordinate", "y_coordinate",

        # Zone enrichment
        "floor_level", "heat_map_cell", "zone_capacity", "zone_category",
        "occupancy_pct_recalculated", "occupancy_status",

        # Queue metrics
        "queue_detected", "queue_length", "queue_wait_minutes",

        # Sensor metadata
        "device_mac_hash", "signal_strength_dbm", "battery_level", "calibration_date",

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
    print(f"ERROR in lh_silver.silver_people_movement (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Report

# COMMAND ----------

print("=" * 60)
print("DATA QUALITY REPORT - People Movement Silver Layer")
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

# Quality by sensor type
print("Quality by Sensor Type:")
spark.sql(f"""
    SELECT
        sensor_type_clean as sensor_type,
        COUNT(*) as events,
        ROUND(AVG(_dq_score), 2) as avg_quality
    FROM {target_table}
    GROUP BY sensor_type_clean
    ORDER BY events DESC
""").show(truncate=False)

# Occupancy status distribution
print("Occupancy Status Distribution:")
spark.sql(f"""
    SELECT
        occupancy_status,
        zone_category,
        COUNT(*) as readings,
        ROUND(AVG(person_count), 1) as avg_person_count
    FROM {target_table}
    GROUP BY occupancy_status, zone_category
    ORDER BY occupancy_status, readings DESC
""").show(20, truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize Table

# COMMAND ----------

spark.sql(f"OPTIMIZE {target_table} ZORDER BY (zone_id, sensor_type_clean)")
print("Table optimized with Z-Order on zone_id, sensor_type_clean")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Metric | Value |
# MAGIC |--------|-------|
# MAGIC | Source | bronze_people_movement |
# MAGIC | Target | silver_people_movement |
# MAGIC | Zone Enrichment | Capacity, category, occupancy status |
# MAGIC | Queue Normalization | Cleaned queue metrics for non-queue zones |
# MAGIC | Deduplication | event_id |
# MAGIC | Partitioned By | event_date |
# MAGIC | Z-Order | zone_id, sensor_type_clean |
# MAGIC
# MAGIC **Next Step:** Continue to Gold layer for zone heat maps, peak traffic analysis, and dwell time summaries.
