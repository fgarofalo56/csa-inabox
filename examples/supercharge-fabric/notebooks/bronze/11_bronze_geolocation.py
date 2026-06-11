# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Geolocation Data Ingestion
# MAGIC
# MAGIC This notebook ingests raw geolocation analytics events from the casino resort
# MAGIC tracking infrastructure into the Bronze layer. Events include GPS pings, geofence
# MAGIC crossings, indoor positioning, and proximity-triggered events from 200 tracked
# MAGIC devices across the Las Vegas resort campus.
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet/CSV files from location tracking systems (GPS, Wi-Fi, BLE, UWB)
# MAGIC - **Location:** Files/landing/geolocation/
# MAGIC - **Schema:** Geolocation event records
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_geolocation
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
    DoubleType,
    FloatType,
    IntegerType,
    Row,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Configuration
SOURCE_PATH = "Files/landing/geolocation/"
TARGET_TABLE = "lh_bronze.bronze_geolocation"
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
# MAGIC Explicit schema matching geolocation_schema.json for validation and performance.

# COMMAND ----------

geolocation_schema = StructType([
    StructField("event_id", StringType(), False),
    StructField("device_id", StringType(), False),
    StructField("device_type", StringType(), True),
    StructField("timestamp", TimestampType(), False),
    StructField("latitude", DoubleType(), True),
    StructField("longitude", DoubleType(), True),
    StructField("altitude_meters", FloatType(), True),
    StructField("accuracy_meters", FloatType(), True),
    StructField("speed_mps", FloatType(), True),
    StructField("heading_degrees", FloatType(), True),
    StructField("h3_index", StringType(), True),
    StructField("geofence_id", StringType(), True),
    StructField("geofence_name", StringType(), True),
    StructField("geofence_event", StringType(), True),
    StructField("geofence_dwell_seconds", IntegerType(), True),
    StructField("poi_name", StringType(), True),
    StructField("poi_distance_meters", FloatType(), True),
    StructField("floor_level", IntegerType(), True),
    StructField("indoor_zone", StringType(), True),
    StructField("proximity_trigger", StringType(), True),
    StructField("source_system", StringType(), True),
    StructField("battery_level", IntegerType(), True),
    StructField("load_time", TimestampType(), True),
])

print(f"Schema fields: {len(geolocation_schema.fields)}")
for field in geolocation_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data

# COMMAND ----------

# Attempt to read Parquet first, fall back to CSV
try:
    df_raw = spark.read \
        .schema(geolocation_schema) \
        .parquet(f"{SOURCE_PATH}*.parquet")
    source_format = "Parquet"
except Exception:
    df_raw = spark.read \
        .schema(geolocation_schema) \
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
# MAGIC Minimal validation - ensure critical fields exist and coordinates are reasonable.

# COMMAND ----------

critical_fields = ["event_id", "device_id", "timestamp"]

print("Critical Field Null Check:")
for field in critical_fields:
    null_count = df_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count} nulls"
    print(f"  {field}: {status}")

# Filter out records missing critical fields
df_valid = df_raw \
    .filter(col("event_id").isNotNull()) \
    .filter(col("device_id").isNotNull()) \
    .filter(col("timestamp").isNotNull())

valid_count = df_valid.count()
dropped_count = record_count - valid_count
print(f"\nRecords after null filter: {valid_count:,} (dropped {dropped_count:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Coordinate Validation

# COMMAND ----------

# Check lat/lon ranges (Las Vegas area: ~36.0-36.3, ~-115.3 to -115.0)
coord_stats = df_valid.agg(
    col("latitude").alias("lat"),
    col("longitude").alias("lon"),
).select(
    "lat", "lon"
)

print("Coordinate Range Check:")
lat_stats = df_valid.agg(
    min("latitude").alias("min_lat"),
    max("latitude").alias("max_lat"),
    min("longitude").alias("min_lon"),
    max("longitude").alias("max_lon"),
).collect()[0]

print(f"  Latitude range: {lat_stats['min_lat']:.6f} to {lat_stats['max_lat']:.6f}")
print(f"  Longitude range: {lat_stats['min_lon']:.6f} to {lat_stats['max_lon']:.6f}")

# Flag records with out-of-range coordinates
from pyspark.sql.functions import avg, max, min

out_of_range = df_valid.filter(
    (col("latitude") < 35.0) | (col("latitude") > 37.0) |
    (col("longitude") < -116.0) | (col("longitude") > -114.0)
).count()
print(f"  Out-of-range coordinates: {out_of_range}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Device Type and Source System Distribution

# COMMAND ----------

VALID_DEVICE_TYPES = ["patron_app", "employee_badge", "asset_tag", "vehicle_gps", "shuttle_tracker", "valet_tag"]
VALID_SOURCE_SYSTEMS = ["gps", "wifi_triangulation", "ble_trilateration", "uwb", "hybrid"]

# Device type distribution
print("Device Type Distribution:")
display(
    df_valid
    .groupBy("device_type")
    .count()
    .orderBy(col("count").desc())
)

# Source system distribution
print("Source System Distribution:")
display(
    df_valid
    .groupBy("source_system")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Geofence Event Summary

# COMMAND ----------

# Geofence interaction stats
geofence_events = df_valid.filter(col("geofence_id").isNotNull()).count()
print(f"Geofence Interaction Summary:")
print(f"  Total events: {valid_count:,}")
print(f"  Geofence events: {geofence_events:,}")
print(f"  Geofence interaction rate: {geofence_events / valid_count * 100:.1f}%")

# Geofence event type distribution
print("\nGeofence Event Types:")
display(
    df_valid.filter(col("geofence_event").isNotNull())
    .groupBy("geofence_event")
    .count()
    .orderBy(col("count").desc())
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
        "event_id", "device_id", "device_type", "timestamp",
        "latitude", "longitude", "geofence_name", "source_system",
        "_ingested_at", "_batch_id"
    ).limit(10)
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
# MAGIC | Source | Geolocation analytics event files |
# MAGIC | Target | bronze_geolocation |
# MAGIC | Format | Delta Lake |
# MAGIC | Partitioned By | _load_date |
# MAGIC | Device Types | 6 (patron_app, employee_badge, asset_tag, vehicle_gps, shuttle_tracker, valet_tag) |
# MAGIC | Source Systems | 5 (GPS, Wi-Fi, BLE, UWB, Hybrid) |
# MAGIC | Geofences | 20 defined zones |
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer for GPS cleansing, H3 standardization, and geofence validation.
