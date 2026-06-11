# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Media Playback Events
# MAGIC
# MAGIC This notebook ingests raw streaming media playback events into the Bronze layer.
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet files from media event generator
# MAGIC - **Location:** Files/output/bronze_media_events.parquet
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_media_events
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Append
# MAGIC
# MAGIC ## Compliance
# MAGIC - COPPA: age_bucket field for downstream filtering
# MAGIC - GDPR: pseudonymized user_id only (no PII)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from datetime import datetime

from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    col,
    current_timestamp,
    input_file_name,
    lit,
)
from pyspark.sql.types import (
    IntegerType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Configuration
SOURCE_PATH = "Files/output/bronze_media_events.parquet"
TARGET_TABLE = "lh_bronze.bronze_media_events"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

print(f"Source: {SOURCE_PATH}")
print(f"Target: {TARGET_TABLE}")
print(f"Batch ID: {BATCH_ID}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Schema

# COMMAND ----------

media_event_schema = StructType([
    StructField("event_id", StringType(), False),
    StructField("user_id", StringType(), False),
    StructField("content_id", StringType(), False),
    StructField("event_type", StringType(), False),
    StructField("event_timestamp", StringType(), False),
    StructField("position_sec", IntegerType(), True),
    StructField("device_type", StringType(), True),
    StructField("bitrate_kbps", IntegerType(), True),
    StructField("plan_tier", StringType(), True),
    StructField("age_bucket", StringType(), True),
    StructField("region", StringType(), True),
    StructField("_ingested_at", StringType(), True),
    StructField("_source", StringType(), True),
    StructField("_batch_id", StringType(), True),
])

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data

# COMMAND ----------

df_raw = spark.read \
    .schema(media_event_schema) \
    .parquet(SOURCE_PATH)

record_count = df_raw.count()
print(f"Source Statistics:")
print(f"  Records: {record_count:,}")
print(f"  Columns: {len(df_raw.columns)}")

df_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Checks (Bronze)

# COMMAND ----------

critical_fields = ["event_id", "user_id", "content_id", "event_type", "event_timestamp"]

print("Critical Field Null Check:")
for field in critical_fields:
    null_count = df_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count} nulls"
    print(f"  {field}: {status}")

# Validate event types
valid_types = {"play", "pause", "seek", "stop", "heartbeat"}
invalid_count = df_raw.filter(~col("event_type").isin(valid_types)).count()
print(f"  event_type valid: {'PASS' if invalid_count == 0 else f'WARN: {invalid_count} invalid'}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata

# COMMAND ----------

df_bronze = df_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table

# COMMAND ----------

df_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLE)

print(f"Successfully wrote {spark.table(TARGET_TABLE).count():,} records to {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Verify Ingestion

# COMMAND ----------

df_verify = spark.table(TARGET_TABLE)

print(f"\nTable Verification:")
print(f"  Total records: {df_verify.count():,}")
print(f"  Partitions: {df_verify.select('_bronze_load_date').distinct().count()}")

print(f"\nEvent Type Distribution:")
display(
    df_verify
    .groupBy("event_type")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Device & Age Bucket Distribution

# COMMAND ----------

print("Device Distribution:")
display(df_verify.groupBy("device_type").count().orderBy(col("count").desc()))

print("\nAge Bucket Distribution (COPPA monitoring):")
display(df_verify.groupBy("age_bucket").count().orderBy(col("count").desc()))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Metric | Value |
# MAGIC |--------|-------|
# MAGIC | Source | Parquet files |
# MAGIC | Target | bronze_media_events |
# MAGIC | Format | Delta Lake |
# MAGIC | Partitioned By | _bronze_load_date |
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer sessionization (`58_media_sessions.py`).
