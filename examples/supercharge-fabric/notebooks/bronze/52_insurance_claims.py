# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Insurance Claims Ingestion
# MAGIC
# MAGIC This notebook ingests raw P&C insurance claims data into the Bronze layer.
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet / CSV files
# MAGIC - **Location:** Files/landing/insurance/
# MAGIC - **Domain:** P&C Insurance Claims (Auto, Home, Commercial, Workers' Comp)
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_insurance_claims
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Append
# MAGIC
# MAGIC ## Compliance
# MAGIC - NAIC Model Audit Rule: data lineage and ingestion audit trail
# MAGIC - PII fields (claimant_name) retained in bronze; masked in silver

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
    BooleanType,
    DateType,
    DoubleType,
    StringType,
    StructField,
    StructType,
)

spark = SparkSession.builder.getOrCreate()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Schema Definition

# COMMAND ----------

insurance_claims_schema = StructType([
    StructField("claim_id", StringType(), False),
    StructField("policy_id", StringType(), False),
    StructField("line_of_business", StringType(), True),
    StructField("state", StringType(), True),
    StructField("loss_dt", DateType(), True),
    StructField("report_dt", DateType(), True),
    StructField("claimant_name", StringType(), True),
    StructField("loss_type", StringType(), True),
    StructField("reserve_amt", DoubleType(), True),
    StructField("paid_amt", DoubleType(), True),
    StructField("status", StringType(), True),
    StructField("fraud_flag", BooleanType(), True),
    StructField("adjuster_id", StringType(), True),
    StructField("agent_id", StringType(), True),
])

# COMMAND ----------

# MAGIC %md
# MAGIC ## Landing Path Configuration

# COMMAND ----------

LANDING_PATH = "Files/landing/insurance/"
BRONZE_TABLE = "lh_bronze.bronze_insurance_claims"

# Use mssparkutils for Fabric-native file operations
from notebookutils import mssparkutils  # noqa: E402

# List available files
try:
    files = mssparkutils.fs.ls(LANDING_PATH)
    print(f"Found {len(files)} items in {LANDING_PATH}")
    for f in files[:10]:
        print(f"  {f.name} ({f.size} bytes)")
except Exception as e:
    print(f"Warning: Could not list landing path: {e}")
    print("Continuing with read attempt...")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Raw Data with Schema Enforcement

# COMMAND ----------

df_raw = (
    spark.read.format("parquet")
    .schema(insurance_claims_schema)
    .load(LANDING_PATH)
)

record_count = df_raw.count()
print(f"Raw records loaded: {record_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Ingestion Metadata

# COMMAND ----------

df_bronze = (
    df_raw
    .withColumn("_ingested_at", current_timestamp())
    .withColumn("_source_file", input_file_name())
    .withColumn("_source_system", lit("insurance_claims_generator"))
    .withColumn("_ingestion_date", lit(datetime.now().strftime("%Y-%m-%d")))
)

print(f"Bronze records with metadata: {df_bronze.count():,}")
df_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Summary (Pre-Write)

# COMMAND ----------

from pyspark.sql.functions import count, countDistinct, sum as spark_sum  # noqa: E402

quality_summary = df_bronze.agg(
    count("*").alias("total_records"),
    countDistinct("claim_id").alias("unique_claims"),
    countDistinct("policy_id").alias("unique_policies"),
    spark_sum(col("reserve_amt")).alias("total_reserves"),
    spark_sum(col("paid_amt")).alias("total_paid"),
    spark_sum(col("fraud_flag").cast("int")).alias("fraud_flagged_count"),
).collect()[0]

print("=== Bronze Ingestion Quality Summary ===")
print(f"  Total records:      {quality_summary['total_records']:,}")
print(f"  Unique claims:      {quality_summary['unique_claims']:,}")
print(f"  Unique policies:    {quality_summary['unique_policies']:,}")
print(f"  Total reserves:     ${quality_summary['total_reserves']:,.2f}")
print(f"  Total paid:         ${quality_summary['total_paid']:,.2f}")
print(f"  Fraud flagged:      {quality_summary['fraud_flagged_count']:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Bronze Delta Table

# COMMAND ----------

(
    df_bronze
    .write.format("delta")
    .mode("append")
    .option("mergeSchema", "true")
    .saveAsTable(BRONZE_TABLE)
)

print(f"Successfully wrote {record_count:,} records to {BRONZE_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Verify Write

# COMMAND ----------

df_verify = spark.sql(f"SELECT COUNT(*) as cnt FROM {BRONZE_TABLE}")
total = df_verify.collect()[0]["cnt"]
print(f"Total records in {BRONZE_TABLE}: {total:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Notebook Complete
# MAGIC
# MAGIC Bronze ingestion for insurance claims is complete.
# MAGIC Proceed to `52_insurance_validated.py` for Silver layer validation.
