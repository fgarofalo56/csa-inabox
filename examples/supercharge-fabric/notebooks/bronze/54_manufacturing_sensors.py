# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Manufacturing Sensor Telemetry
# MAGIC
# MAGIC Ingests raw IoT sensor data from manufacturing floor into the Bronze layer.
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet files (from IoT Hub via Eventstream landing)
# MAGIC - **Location:** Files/landing/manufacturing_sensors/
# MAGIC - **Volume:** ~86M readings/day (200 machines, 5 sensors each)
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_manufacturing_sensors
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Append
# MAGIC - **Compliance:** IEC 62443 (no PII -- OT telemetry only)

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
    DoubleType,
    FloatType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Configuration
SOURCE_PATH = "Files/output/bronze_manufacturing_sensors.parquet"
TARGET_TABLE = "lh_bronze.bronze_manufacturing_sensors"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

print(f"Source: {SOURCE_PATH}")
print(f"Target: {TARGET_TABLE}")
print(f"Batch ID: {BATCH_ID}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Schema

# COMMAND ----------

sensor_schema = StructType([
    StructField("sensor_id", StringType(), False),
    StructField("machine_id", StringType(), False),
    StructField("machine_type", StringType(), False),
    StructField("timestamp", StringType(), False),
    StructField("vibration_mm_s", DoubleType(), True),
    StructField("temperature_c", DoubleType(), True),
    StructField("current_a", DoubleType(), True),
    StructField("pressure_bar", DoubleType(), True),
    StructField("rpm", DoubleType(), True),
    StructField("_ingested_at", StringType(), True),
    StructField("_source", StringType(), True),
    StructField("_batch_id", StringType(), True),
])

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data

# COMMAND ----------

df_raw = spark.read \
    .schema(sensor_schema) \
    .parquet(SOURCE_PATH)

record_count = df_raw.count()
print(f"Source Statistics:")
print(f"  Records: {record_count:,}")
print(f"  Columns: {len(df_raw.columns)}")

df_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Checks (Bronze)
# MAGIC
# MAGIC Minimal checks -- just ensure critical fields are present.

# COMMAND ----------

critical_fields = ["sensor_id", "machine_id", "machine_type", "timestamp"]

print("Critical Field Null Check:")
for field in critical_fields:
    null_count = df_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count} nulls"
    print(f"  {field}: {status}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata

# COMMAND ----------

df_bronze = df_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date")) \
    .withColumn("event_timestamp", to_timestamp(col("timestamp")))

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

display(
    df_verify.select(
        "sensor_id", "machine_id", "machine_type",
        "vibration_mm_s", "temperature_c", "current_a",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Machine Type Distribution

# COMMAND ----------

display(
    df_verify
    .groupBy("machine_type")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Delta Table History

# COMMAND ----------

from delta.tables import DeltaTable

delta_table = DeltaTable.forName(spark, TARGET_TABLE)
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
# MAGIC | Source | Parquet (IoT Hub landing) |
# MAGIC | Target | bronze_manufacturing_sensors |
# MAGIC | Format | Delta Lake |
# MAGIC | Partitioned By | _bronze_load_date |
# MAGIC
# MAGIC **Next Step:** Silver layer aggregation (`54_manufacturing_aggregated.py`).
