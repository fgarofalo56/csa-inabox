# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Energy AMI Meter Readings
# MAGIC
# MAGIC This notebook ingests raw AMI (Advanced Metering Infrastructure) smart meter
# MAGIC readings into the Bronze layer for a regional electric utility.
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet files from AMI head-end export
# MAGIC - **Location:** Files/landing/energy_meters/
# MAGIC - **Volume:** ~115M records/day (1.2M meters x 96 intervals)
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_energy_meters
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Append
# MAGIC - **Compliance:** NERC CIP audit trail

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
)
from pyspark.sql.types import (
    BooleanType,
    DoubleType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Configuration
SOURCE_PATH = "Files/landing/energy_meters/"
TARGET_TABLE = "lh_bronze.bronze_energy_meters"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")
CHECKPOINT_PATH = "abfss://onelake@{{ADLS_ACCOUNT}}.dfs.core.windows.net/lh_bronze.Lakehouse/Files/checkpoints/energy_meters"

print(f"Source: {SOURCE_PATH}")
print(f"Target: {TARGET_TABLE}")
print(f"Batch ID: {BATCH_ID}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Schema

# COMMAND ----------

meter_schema = StructType([
    StructField("meter_id", StringType(), False),
    StructField("reading_timestamp", StringType(), False),
    StructField("kwh_delivered", DoubleType(), True),
    StructField("kwh_received", DoubleType(), True),
    StructField("voltage_a", DoubleType(), True),
    StructField("power_factor", DoubleType(), True),
    StructField("demand_kw", DoubleType(), True),
    StructField("tamper_flag", BooleanType(), True),
    StructField("read_quality", StringType(), True),
    StructField("rate_class", StringType(), True),
    StructField("district", StringType(), True),
    StructField("feeder_id", StringType(), True),
    StructField("lat", DoubleType(), True),
    StructField("lon", DoubleType(), True),
    StructField("_ingested_at", StringType(), True),
    StructField("_source", StringType(), True),
    StructField("_batch_id", StringType(), True),
])

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data

# COMMAND ----------

df_raw = spark.read \
    .schema(meter_schema) \
    .parquet(SOURCE_PATH)

record_count = df_raw.count()
print(f"Records read: {record_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Ingestion Metadata

# COMMAND ----------

df_bronze = df_raw \
    .withColumn("reading_timestamp", to_timestamp(col("reading_timestamp"))) \
    .withColumn("_fabric_ingested_at", current_timestamp()) \
    .withColumn("_fabric_batch_id", lit(BATCH_ID)) \
    .withColumn("_fabric_source_file", input_file_name()) \
    .withColumn("_fabric_notebook", lit("55_energy_meters"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Checks (Pre-Write)

# COMMAND ----------

null_meter_ids = df_bronze.filter(col("meter_id").isNull()).count()
null_timestamps = df_bronze.filter(col("reading_timestamp").isNull()).count()
negative_kwh = df_bronze.filter(col("kwh_delivered") < 0).count()

print(f"Null meter_ids: {null_meter_ids}")
print(f"Null timestamps: {null_timestamps}")
print(f"Negative kWh: {negative_kwh}")

if null_meter_ids > 0 or null_timestamps > 0:
    print("WARNING: Null key fields detected - records will be quarantined")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Bronze Delta Table

# COMMAND ----------

# Quarantine bad records
df_good = df_bronze.filter(
    col("meter_id").isNotNull() & col("reading_timestamp").isNotNull()
)
df_quarantine = df_bronze.filter(
    col("meter_id").isNull() | col("reading_timestamp").isNull()
)

# Write good records
df_good.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .saveAsTable(TARGET_TABLE)

# Write quarantine
if df_quarantine.count() > 0:
    df_quarantine.write \
        .format("delta") \
        .mode("append") \
        .saveAsTable("lh_bronze.bronze_energy_meters_quarantine")

print(f"Written {df_good.count():,} records to {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Post-Write Validation

# COMMAND ----------

total = spark.table(TARGET_TABLE).count()
print(f"Total records in {TARGET_TABLE}: {total:,}")

# NERC CIP audit log entry
audit_entry = {
    "timestamp": datetime.now().isoformat(),
    "notebook": "55_energy_meters",
    "operation": "BRONZE_INGEST",
    "table": TARGET_TABLE,
    "records_written": df_good.count(),
    "records_quarantined": df_quarantine.count() if df_quarantine.count() > 0 else 0,
    "batch_id": BATCH_ID,
}
print(f"NERC CIP Audit: {audit_entry}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Checkpoint for Incremental Loading

# COMMAND ----------

# Save watermark for next incremental load
try:
    max_ts = df_good.selectExpr("max(reading_timestamp) as max_ts").collect()[0]["max_ts"]
    mssparkutils.fs.put(
        f"{CHECKPOINT_PATH}/watermark.txt",
        str(max_ts),
        True
    )
    print(f"Watermark saved: {max_ts}")
except Exception as e:
    print(f"Watermark save skipped (first run or local): {e}")
