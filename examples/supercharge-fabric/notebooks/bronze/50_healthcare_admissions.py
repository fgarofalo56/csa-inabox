# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Healthcare Admissions Ingestion
# MAGIC
# MAGIC Ingests raw hospital admissions data into the Bronze layer Delta table.
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet / CSV files
# MAGIC - **Location:** Files/landing/healthcare/
# MAGIC - **Domain:** Commercial Healthcare Operations
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_healthcare_admissions
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Append
# MAGIC
# MAGIC ## HIPAA Compliance
# MAGIC - MRN is pre-hashed (HMAC-SHA-256) at generation time
# MAGIC - SSN uses 900-series synthetic values, masked to last 4
# MAGIC - No real PHI enters the lakehouse

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

import os
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
    IntegerType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)


def _get_arg(name: str, default=None):
    """Read a notebook parameter from Fabric/Synapse runtime, env var, or default."""
    try:
        import notebookutils
        return notebookutils.notebook.getArgument(name, default)
    except Exception:
        try:
            import mssparkutils
            return mssparkutils.notebook.getArgument(name, default)
        except Exception:
            return os.environ.get(name.upper(), default)


SOURCE_PATH = _get_arg("source_path", "Files/landing/healthcare/")
TARGET_TABLE = "lh_bronze.bronze_healthcare_admissions"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

print(f"Source: {SOURCE_PATH}")
print(f"Target: {TARGET_TABLE}")
print(f"Batch ID: {BATCH_ID}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Schema

# COMMAND ----------

admissions_schema = StructType([
    StructField("encounter_id", StringType(), False),
    StructField("mrn_hash", StringType(), False),
    StructField("ssn_masked", StringType(), True),
    StructField("admit_dt", StringType(), False),
    StructField("discharge_dt", StringType(), True),
    StructField("los", IntegerType(), True),
    StructField("drg_code", StringType(), True),
    StructField("payer", StringType(), True),
    StructField("readmit_flag", IntegerType(), True),
    StructField("ed_arrival_dt", StringType(), True),
    StructField("disposition", StringType(), True),
    StructField("age", IntegerType(), True),
    StructField("gender", StringType(), True),
    StructField("_ingested_at", StringType(), True),
    StructField("_source", StringType(), True),
    StructField("_batch_id", StringType(), True),
])

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data

# COMMAND ----------

df_raw = spark.read \
    .schema(admissions_schema) \
    .option("recursiveFileLookup", "true") \
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

critical_fields = ["encounter_id", "mrn_hash", "admit_dt"]

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

print(f"Successfully wrote {record_count:,} records to {TARGET_TABLE}")

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
        "encounter_id", "mrn_hash", "admit_dt", "drg_code",
        "payer", "los", "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Metric | Value |
# MAGIC |--------|-------|
# MAGIC | Source | Files/landing/healthcare/ |
# MAGIC | Target | bronze_healthcare_admissions |
# MAGIC | Format | Delta Lake |
# MAGIC | Partitioned By | _bronze_load_date |
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer cleansing (`50_healthcare_cleansed.py`).
