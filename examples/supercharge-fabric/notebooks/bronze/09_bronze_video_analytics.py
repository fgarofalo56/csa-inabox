# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Video Security Analytics Ingestion
# MAGIC
# MAGIC This notebook ingests raw video analytics events from the casino surveillance
# MAGIC infrastructure into the Bronze layer. Events cover object detection, zone crossing,
# MAGIC anomaly detection, face matching, crowd density, loitering, tailgating, and
# MAGIC abandoned object detection across 50 cameras in 14 casino zones.
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet files from video analytics pipeline (YOLO/DeepSORT/RetinaNet)
# MAGIC - **Location:** Files/landing/video_analytics/
# MAGIC - **Schema:** Video analytics event records
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_video_analytics
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
    FloatType,
    IntegerType,
    Row,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Configuration
SOURCE_PATH = "Files/landing/video_analytics/"
TARGET_TABLE = "lh_bronze.bronze_video_analytics"
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
# MAGIC Explicit schema matching video_event_schema.json for validation and performance.

# COMMAND ----------

video_analytics_schema = StructType([
    StructField("event_id", StringType(), False),
    StructField("camera_id", StringType(), False),
    StructField("camera_location", StringType(), True),
    StructField("event_type", StringType(), False),
    StructField("timestamp", TimestampType(), False),
    StructField("confidence_score", FloatType(), True),
    StructField("object_class", StringType(), True),
    StructField("object_count", IntegerType(), True),
    StructField("bounding_box", StringType(), True),
    StructField("track_id", StringType(), True),
    StructField("zone_from", StringType(), True),
    StructField("zone_to", StringType(), True),
    StructField("dwell_time_seconds", FloatType(), True),
    StructField("anomaly_type", StringType(), True),
    StructField("alert_level", StringType(), True),
    StructField("frame_number", IntegerType(), True),
    StructField("video_resolution", StringType(), True),
    StructField("fps", IntegerType(), True),
    StructField("model_name", StringType(), True),
    StructField("model_version", StringType(), True),
    StructField("metadata", StringType(), True),
    StructField("load_time", TimestampType(), True),
])

print(f"Schema fields: {len(video_analytics_schema.fields)}")
for field in video_analytics_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data

# COMMAND ----------

# Attempt to read Parquet first, fall back to CSV
try:
    df_raw = spark.read \
        .schema(video_analytics_schema) \
        .parquet(f"{SOURCE_PATH}*.parquet")
    source_format = "Parquet"
except Exception:
    df_raw = spark.read \
        .schema(video_analytics_schema) \
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
# MAGIC Minimal validation at Bronze - ensure critical fields exist and are non-null.

# COMMAND ----------

critical_fields = ["event_id", "camera_id", "event_type", "timestamp"]

print("Critical Field Null Check:")
for field in critical_fields:
    null_count = df_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count} nulls"
    print(f"  {field}: {status}")

# Filter out records with missing critical fields
df_valid = df_raw \
    .filter(col("event_id").isNotNull()) \
    .filter(col("camera_id").isNotNull()) \
    .filter(col("event_type").isNotNull()) \
    .filter(col("timestamp").isNotNull())

valid_count = df_valid.count()
dropped_count = record_count - valid_count
print(f"\nRecords after null filter: {valid_count:,} (dropped {dropped_count:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validate Event Types and Alert Levels

# COMMAND ----------

VALID_EVENT_TYPES = [
    "object_detection", "zone_crossing", "anomaly", "face_match",
    "crowd_density", "loitering", "tailgating", "abandoned_object"
]

VALID_ALERT_LEVELS = ["INFO", "WARNING", "CRITICAL"]

# Event type distribution
print("Event Type Distribution:")
display(
    df_valid
    .groupBy("event_type")
    .count()
    .orderBy(col("count").desc())
)

# Check for unexpected event types
invalid_events = df_valid.filter(~col("event_type").isin(VALID_EVENT_TYPES)).count()
print(f"\nInvalid event types: {invalid_events}")

# Alert level distribution
print("Alert Level Distribution:")
display(
    df_valid
    .groupBy("alert_level")
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
        "event_id", "camera_id", "camera_location", "event_type",
        "timestamp", "confidence_score", "alert_level",
        "_ingested_at", "_batch_id"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Camera and Location Distribution

# COMMAND ----------

# Camera location distribution
print("Camera Location Distribution:")
display(
    df_verify.filter(col("_batch_id") == BATCH_ID)
    .groupBy("camera_location")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Model name distribution
print("Model Name Distribution:")
display(
    df_verify.filter(col("_batch_id") == BATCH_ID)
    .groupBy("model_name")
    .count()
    .orderBy(col("count").desc())
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
# MAGIC | Source | Video analytics event files |
# MAGIC | Target | bronze_video_analytics |
# MAGIC | Format | Delta Lake |
# MAGIC | Partitioned By | _load_date |
# MAGIC | Event Types | 8 (object_detection, zone_crossing, anomaly, face_match, crowd_density, loitering, tailgating, abandoned_object) |
# MAGIC | Cameras | 50 across 14 zones |
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer for deduplication, confidence filtering, and alert standardization.
