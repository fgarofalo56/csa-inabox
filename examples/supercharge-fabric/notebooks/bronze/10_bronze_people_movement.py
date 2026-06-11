# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: People Movement Data Ingestion
# MAGIC
# MAGIC This notebook ingests raw people movement and foot traffic sensor data into the
# MAGIC Bronze layer. Events capture zone occupancy, dwell times, queue detection, and
# MAGIC directional movement from 80 sensors across 30 casino zones on multiple floors.
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet/CSV files from sensor infrastructure (Wi-Fi, BLE, camera, IR, pressure, LiDAR)
# MAGIC - **Location:** Files/landing/people_movement/
# MAGIC - **Schema:** Movement event records
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_people_movement
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Append

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

import uuid
from datetime import datetime

from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    col,
    count,
    current_timestamp,
    input_file_name,
    lit,
    to_timestamp,
    when,
)
from pyspark.sql.types import (
    BooleanType,
    FloatType,
    IntegerType,
    Row,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Configuration
SOURCE_PATH = "Files/landing/people_movement/"
TARGET_TABLE = "lh_bronze.bronze_people_movement"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")
RUN_ID = str(uuid.uuid4())

print(f"Source: {SOURCE_PATH}")
print(f"Target: {TARGET_TABLE}")
print(f"Batch ID: {BATCH_ID}")
print(f"Run ID: {RUN_ID}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Schema
# MAGIC
# MAGIC Explicit schema matching movement_event_schema.json for validation and performance.

# COMMAND ----------

people_movement_schema = StructType([
    StructField("event_id", StringType(), False),
    StructField("sensor_id", StringType(), False),
    StructField("sensor_type", StringType(), True),
    StructField("zone_id", StringType(), False),
    StructField("zone_name", StringType(), True),
    StructField("timestamp", TimestampType(), False),
    StructField("person_count", IntegerType(), True),
    StructField("direction", StringType(), True),
    StructField("dwell_time_seconds", FloatType(), True),
    StructField("velocity_mps", FloatType(), True),
    StructField("x_coordinate", FloatType(), True),
    StructField("y_coordinate", FloatType(), True),
    StructField("floor_level", IntegerType(), True),
    StructField("heat_map_cell", StringType(), True),
    StructField("occupancy_percentage", FloatType(), True),
    StructField("queue_detected", BooleanType(), True),
    StructField("queue_length", IntegerType(), True),
    StructField("queue_wait_minutes", FloatType(), True),
    StructField("device_mac_hash", StringType(), True),
    StructField("signal_strength_dbm", IntegerType(), True),
    StructField("battery_level", IntegerType(), True),
    StructField("calibration_date", StringType(), True),
    StructField("load_time", TimestampType(), True),
])

print(f"Schema fields: {len(people_movement_schema.fields)}")
for field in people_movement_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data

# COMMAND ----------

# Attempt to read Parquet first, fall back to CSV
try:
    df_raw = spark.read \
        .schema(people_movement_schema) \
        .parquet(f"{SOURCE_PATH}*.parquet")
    source_format = "Parquet"
except Exception:
    df_raw = spark.read \
        .schema(people_movement_schema) \
        .option("header", "true") \
        .option("timestampFormat", "yyyy-MM-dd'T'HH:mm:ss") \
        .csv(f"{SOURCE_PATH}*.csv")
    source_format = "CSV"

record_count = df_raw.count()
column_count = len(df_raw.columns)

print(f"Source Format: {source_format}")
print(f"Source Statistics:")
print(f"  Records: {record_count:,}")
print(f"  Columns: {column_count}")

df_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Checks (Bronze)
# MAGIC
# MAGIC Minimal validation - ensure critical fields exist and are non-null.

# COMMAND ----------

critical_fields = ["event_id", "sensor_id", "zone_id", "timestamp"]

print("Critical Field Null Check:")
for field in critical_fields:
    null_count = df_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count} nulls"
    print(f"  {field}: {status}")

# Filter out records missing critical fields
df_valid = df_raw \
    .filter(col("event_id").isNotNull()) \
    .filter(col("sensor_id").isNotNull()) \
    .filter(col("zone_id").isNotNull()) \
    .filter(col("timestamp").isNotNull())

valid_count = df_valid.count()
dropped_count = record_count - valid_count
print(f"\nRecords after null filter: {valid_count:,} (dropped {dropped_count:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validate Sensor Types and Directions

# COMMAND ----------

VALID_SENSOR_TYPES = ["wifi_probe", "ble_beacon", "camera_count", "infrared", "pressure_mat", "lidar"]
VALID_DIRECTIONS = ["entering", "exiting", "stationary", "passing_through"]

# Sensor type distribution
print("Sensor Type Distribution:")
display(
    df_valid
    .groupBy("sensor_type")
    .count()
    .orderBy(col("count").desc())
)

# Direction distribution
print("Direction Distribution:")
display(
    df_valid
    .groupBy("direction")
    .count()
    .orderBy(col("count").desc())
)

# Check for unexpected sensor types
invalid_sensors = df_valid.filter(
    ~col("sensor_type").isin(VALID_SENSOR_TYPES) & col("sensor_type").isNotNull()
).count()
print(f"\nInvalid sensor types: {invalid_sensors}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Queue Detection Summary

# COMMAND ----------

# Queue detection stats
total_events = df_valid.count()
queue_events = df_valid.filter(col("queue_detected") == True).count()
print(f"Queue Detection Summary:")
print(f"  Total events: {total_events:,}")
print(f"  Queue detected events: {queue_events:,}")
print(f"  Queue detection rate: {queue_events / total_events * 100:.1f}%")

# Queue metrics by zone
print("\nQueue Events by Zone:")
display(
    df_valid.filter(col("queue_detected") == True)
    .groupBy("zone_name")
    .agg(
        count("*").alias("queue_events"),
        col("zone_name")
    )
    .drop("zone_name")
    .orderBy(col("queue_events").desc())
    .limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Ingestion Metadata

# COMMAND ----------

df_bronze = df_valid \
    .withColumn("_ingested_at", current_timestamp()) \
    .withColumn("_source_file", input_file_name()) \
    .withColumn("_batch_id", lit(BATCH_ID)) \
    .withColumn("_run_id", lit(RUN_ID)) \
    .withColumn("_source_format", lit(source_format)) \
    .withColumn("_load_date", current_timestamp().cast("date"))

print("Added ingestion metadata columns:")
print("  - _ingested_at")
print("  - _source_file")
print("  - _batch_id")
print("  - _run_id")
print("  - _source_format")
print("  - _load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table

# COMMAND ----------

df_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_load_date") \
    .saveAsTable(TARGET_TABLE)

final_count = spark.table(TARGET_TABLE).count()
print(f"Successfully wrote {final_count:,} records to {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Row Count Validation

# COMMAND ----------

df_verify = spark.table(TARGET_TABLE)

total_in_table = df_verify.count()
latest_batch = df_verify.filter(col("_batch_id") == BATCH_ID).count()

print(f"Table Verification:")
print(f"  Total records in table: {total_in_table:,}")
print(f"  Records from this batch: {latest_batch:,}")
print(f"  Partitions: {df_verify.select('_load_date').distinct().count()}")

assert latest_batch == final_count, \
    f"Row count mismatch: wrote {final_count}, read back {latest_batch}"
print("  Row count validation: PASS")

# Show sample data
print("\nSample Records:")
display(
    df_verify.filter(col("_batch_id") == BATCH_ID)
    .select(
        "event_id", "sensor_id", "sensor_type", "zone_name",
        "timestamp", "person_count", "direction", "occupancy_percentage",
        "_ingested_at", "_batch_id"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Zone and Floor Distribution

# COMMAND ----------

# Zone distribution
print("Zone Distribution:")
display(
    df_verify.filter(col("_batch_id") == BATCH_ID)
    .groupBy("zone_name")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Floor level distribution
print("Floor Level Distribution:")
display(
    df_verify.filter(col("_batch_id") == BATCH_ID)
    .groupBy("floor_level")
    .count()
    .orderBy("floor_level")
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Delta Table History

# COMMAND ----------

from delta.tables import DeltaTable

delta_table = DeltaTable.forName(spark, TARGET_TABLE)

print("Table History:")
display(
    delta_table.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Metric | Value |
# MAGIC |--------|-------|
# MAGIC | Source | People movement sensor files |
# MAGIC | Target | bronze_people_movement |
# MAGIC | Format | Delta Lake |
# MAGIC | Partitioned By | _load_date |
# MAGIC | Sensor Types | 6 (wifi_probe, ble_beacon, camera_count, infrared, pressure_mat, lidar) |
# MAGIC | Zones | 30 across 3 floors |
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer for sensor data cleansing, zone mapping, and queue metric standardization.
