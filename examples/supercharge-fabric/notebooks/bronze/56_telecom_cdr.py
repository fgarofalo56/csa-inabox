# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Telecom CDR Ingestion
# MAGIC
# MAGIC Ingests raw Call Detail Records (CDR/xDR) into the Bronze layer for a
# MAGIC regional wireless carrier with 3.5M subscribers and 8,000 cell sites.
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet files (CDR feed)
# MAGIC - **Location:** Files/landing/telecom_cdr/
# MAGIC - **Volume:** ~50K events/sec peak
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_telecom_cdr
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Append
# MAGIC
# MAGIC ## Compliance
# MAGIC - CPNI (47 CFR 64.2001-2009): raw subscriber data, restricted access
# MAGIC - GDPR: EU roaming records flagged for residency controls

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
    DoubleType,
    IntegerType,
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Configuration
SOURCE_PATH = "Files/output/telecom_cdr_sample.parquet"
TARGET_TABLE = "lh_bronze.bronze_telecom_cdr"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")
CHECKPOINT_PATH = "abfss://onelake/checkpoints/bronze_telecom_cdr"

print(f"Source: {SOURCE_PATH}")
print(f"Target: {TARGET_TABLE}")
print(f"Batch ID: {BATCH_ID}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Schema

# COMMAND ----------

cdr_schema = StructType([
    StructField("cdr_id", StringType(), False),
    StructField("subscriber_id", StringType(), False),
    StructField("call_type", StringType(), False),
    StructField("start_dt", StringType(), False),
    StructField("duration_sec", IntegerType(), True),
    StructField("bytes_up", LongType(), True),
    StructField("bytes_down", LongType(), True),
    StructField("cell_id", StringType(), True),
    StructField("sector", StringType(), True),
    StructField("rat_type", StringType(), True),
    StructField("rated_amount", DoubleType(), True),
    StructField("_ingested_at", StringType(), True),
    StructField("_source", StringType(), True),
    StructField("_batch_id", StringType(), True),
])

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data

# COMMAND ----------

df_raw = spark.read \
    .schema(cdr_schema) \
    .parquet(SOURCE_PATH)

record_count = df_raw.count()
print(f"Records read: {record_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata

# COMMAND ----------

df_bronze = df_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_source_file", input_file_name())

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Checks (Pre-Write)

# COMMAND ----------

null_cdr_id = df_bronze.filter(col("cdr_id").isNull()).count()
null_subscriber = df_bronze.filter(col("subscriber_id").isNull()).count()
null_call_type = df_bronze.filter(col("call_type").isNull()).count()

print(f"Null cdr_id:        {null_cdr_id}")
print(f"Null subscriber_id: {null_subscriber}")
print(f"Null call_type:     {null_call_type}")

if null_cdr_id > 0 or null_subscriber > 0:
    print("WARNING: Null values in required fields detected")

# Call type distribution
print("\nCall type distribution:")
df_bronze.groupBy("call_type").count().orderBy("call_type").show()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Bronze Delta Table

# COMMAND ----------

df_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .saveAsTable(TARGET_TABLE)

final_count = spark.table(TARGET_TABLE).count()
print(f"Total records in {TARGET_TABLE}: {final_count:,}")
print(f"Batch {BATCH_ID} complete: {record_count:,} records appended")

# COMMAND ----------

# MAGIC %md
# MAGIC ## CPNI Access Logging
# MAGIC
# MAGIC Log this ingestion event for CPNI audit trail.

# COMMAND ----------

from pyspark.sql import Row

audit_record = Row(
    event_type="BRONZE_INGESTION",
    table_name=TARGET_TABLE,
    batch_id=BATCH_ID,
    record_count=record_count,
    timestamp=datetime.now().isoformat(),
    user=mssparkutils.credentials.getCurrentUser() if hasattr(mssparkutils, 'credentials') else "notebook_user",
    contains_cpni=True,
)
print(f"CPNI Audit: {audit_record}")
