# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Slot Machine Telemetry
# MAGIC
# MAGIC This notebook ingests raw slot machine telemetry data into the Bronze layer.
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet files
# MAGIC - **Location:** Files/landing/slot_telemetry/
# MAGIC - **Schema:** SAS protocol events
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_slot_telemetry
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Append

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
    to_timestamp,
    when,
)
from pyspark.sql.types import (
    DoubleType,
    IntegerType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Configuration
SOURCE_PATH = "Files/output/bronze_slot_telemetry.parquet"
TARGET_TABLE = "lh_bronze.bronze_slot_telemetry"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

print(f"Source: {SOURCE_PATH}")
print(f"Target: {TARGET_TABLE}")
print(f"Batch ID: {BATCH_ID}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Schema
# MAGIC
# MAGIC Explicit schema for validation and performance.

# COMMAND ----------

slot_schema = StructType([
    StructField("event_id", StringType(), False),
    StructField("machine_id", StringType(), False),
    StructField("asset_number", StringType(), True),
    StructField("location_id", StringType(), True),
    StructField("zone", StringType(), True),
    StructField("event_type", StringType(), False),
    StructField("event_timestamp", TimestampType(), False),
    StructField("denomination", DoubleType(), True),
    StructField("coin_in", DoubleType(), True),
    StructField("coin_out", DoubleType(), True),
    StructField("jackpot_amount", DoubleType(), True),
    StructField("games_played", IntegerType(), True),
    StructField("theoretical_hold", DoubleType(), True),
    StructField("actual_hold", DoubleType(), True),
    StructField("player_id", StringType(), True),
    StructField("session_id", StringType(), True),
    StructField("machine_type", StringType(), True),
    StructField("manufacturer", StringType(), True),
    StructField("game_theme", StringType(), True),
    StructField("error_code", StringType(), True),
    StructField("error_message", StringType(), True),
    StructField("_ingested_at", StringType(), True),
    StructField("_source", StringType(), True),
    StructField("_batch_id", StringType(), True),
])

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data

# COMMAND ----------

# Read parquet file
df_raw = spark.read \
    .schema(slot_schema) \
    .parquet(SOURCE_PATH)

# Display statistics
record_count = df_raw.count()
column_count = len(df_raw.columns)

print(f"Source Statistics:")
print(f"  Records: {record_count:,}")
print(f"  Columns: {column_count}")

# Show schema
df_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Checks (Bronze)
# MAGIC
# MAGIC Minimal validation at Bronze - just ensure critical fields exist.

# COMMAND ----------

# Check for null critical fields
critical_fields = ["event_id", "machine_id", "event_type", "event_timestamp"]

print("Critical Field Null Check:")
for field in critical_fields:
    null_count = df_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count} nulls"
    print(f"  {field}: {status}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata

# COMMAND ----------

# Add Bronze layer metadata columns
df_bronze = df_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table

# COMMAND ----------

# Write to Bronze Delta table
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

# Read back and verify
df_verify = spark.table(TARGET_TABLE)

print(f"\nTable Verification:")
print(f"  Total records: {df_verify.count():,}")
print(f"  Partitions: {df_verify.select('_bronze_load_date').distinct().count()}")

# Sample data
print(f"\nSample Records:")
display(
    df_verify.select(
        "event_id", "machine_id", "event_type",
        "event_timestamp", "coin_in", "coin_out",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Table Statistics

# COMMAND ----------

# Event type distribution
print("Event Type Distribution:")
display(
    df_verify
    .groupBy("event_type")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Zone distribution
print("Zone Distribution:")
display(
    df_verify
    .groupBy("zone")
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
# MAGIC | Source | Parquet files |
# MAGIC | Target | bronze_slot_telemetry |
# MAGIC | Records | {record_count:,} |
# MAGIC | Format | Delta Lake |
# MAGIC | Partitioned By | _bronze_load_date |
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer transformation.

# COMMAND ----------

# MAGIC %md
# MAGIC ## Lakehouse Schemas (GA Dec 2025)
# MAGIC
# MAGIC Fabric Lakehouse now supports **schema-based table organization** (GA).
# MAGIC Instead of flat naming (`bronze_slot_telemetry`), tables can be organized
# MAGIC into schemas for better discovery, access control, and multi-domain isolation.
# MAGIC
# MAGIC ### Schema Pattern (Alternative to flat naming)
# MAGIC ```
# MAGIC Flat naming:   bronze_slot_telemetry
# MAGIC Schema naming:  casino.bronze_slot_telemetry
# MAGIC ```
# MAGIC
# MAGIC To adopt schemas, create the schema first, then save tables into it.
# MAGIC Both patterns coexist -- existing flat-named tables remain accessible.

# COMMAND ----------

# --- Lakehouse Schema Pattern (Optional, GA Dec 2025) ---
# Uncomment the following to organize tables within Lakehouse schemas.
# This enables domain-based table isolation and finer-grained access control.
#
# Create schema (idempotent):
# spark.sql("CREATE SCHEMA IF NOT EXISTS casino")
#
# Write to schema-qualified table:
# df_bronze.write \
#     .format("delta") \
#     .mode("append") \
#     .option("mergeSchema", "true") \
#     .partitionBy("_bronze_load_date") \
#     .saveAsTable("casino.bronze_slot_telemetry")
#
# For federal agency isolation:
# spark.sql("CREATE SCHEMA IF NOT EXISTS usda")
# spark.sql("CREATE SCHEMA IF NOT EXISTS noaa")
# spark.sql("CREATE SCHEMA IF NOT EXISTS epa")
# spark.sql("CREATE SCHEMA IF NOT EXISTS doi")
# spark.sql("CREATE SCHEMA IF NOT EXISTS sba")
#
# Schema-based access control:
# GRANT SELECT ON SCHEMA casino TO `casino-analysts@contoso.com`
# GRANT SELECT ON SCHEMA usda TO `usda-data-team@contoso.com`

print("Lakehouse Schema pattern available (see comments above)")
print("Current table uses flat naming for backward compatibility")
