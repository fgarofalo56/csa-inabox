# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Financial Transactions
# MAGIC
# MAGIC Ingests raw financial transaction data (card, ACH, wire) into the Bronze layer.
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet / JSON files
# MAGIC - **Location:** Files/landing/financial/
# MAGIC - **Compliance:** PCI DSS v4.0 (PAN pre-tokenized), SOX (append-only)
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_financial_transactions
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Append (immutable audit trail)

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
    DoubleType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

spark = SparkSession.builder.getOrCreate()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Parameters

# COMMAND ----------

LANDING_PATH = "Files/landing/financial/"
BRONZE_TABLE = "lh_bronze.bronze_financial_transactions"
CHECKPOINT_PATH = "abfss://onelake@{{ADLS_ACCOUNT}}.dfs.core.windows.net/checkpoints/bronze_financial_txns"

# COMMAND ----------

# MAGIC %md
# MAGIC ## Schema Definition

# COMMAND ----------

txn_schema = StructType([
    StructField("txn_id", StringType(), False),
    StructField("txn_timestamp", StringType(), False),
    StructField("acct_id", StringType(), False),
    StructField("card_hash", StringType(), False),
    StructField("channel", StringType(), True),
    StructField("merchant_name", StringType(), True),
    StructField("merchant_mcc", StringType(), True),
    StructField("mcc_category", StringType(), True),
    StructField("amount", DoubleType(), False),
    StructField("currency", StringType(), True),
    StructField("auth_code", StringType(), True),
    StructField("merchant_lat", DoubleType(), True),
    StructField("merchant_lon", DoubleType(), True),
    StructField("is_fraud", BooleanType(), True),
    StructField("fraud_pattern", StringType(), True),
])

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Landing Files

# COMMAND ----------

df_raw = (
    spark.read
    .format("parquet")
    .schema(txn_schema)
    .load(LANDING_PATH)
)

print(f"Records read from landing: {df_raw.count()}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Ingestion Metadata

# COMMAND ----------

df_bronze = (
    df_raw
    .withColumn("_ingested_at", current_timestamp())
    .withColumn("_input_file", input_file_name())
    .withColumn("_source_system", lit("financial_landing"))
    .withColumn("_ingestion_date", lit(datetime.now().strftime("%Y-%m-%d")))
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validate Critical Fields

# COMMAND ----------

# Reject records missing required fields
valid_records = df_bronze.filter(
    col("txn_id").isNotNull()
    & col("acct_id").isNotNull()
    & col("amount").isNotNull()
    & (col("amount") > 0)
)

rejected = df_bronze.count() - valid_records.count()
if rejected > 0:
    print(f"WARNING: {rejected} records rejected due to null txn_id/acct_id or invalid amount")

# COMMAND ----------

# MAGIC %md
# MAGIC ## PCI Compliance Check

# COMMAND ----------

# Verify no raw PAN exists in the data - only card_hash should be present
# card_hash is a SHA-256 hex string (64 chars); raw PAN would be 16 digits
from pyspark.sql.functions import length

pan_check = valid_records.filter(
    (length(col("card_hash")) < 60) | col("card_hash").rlike("^\\d{13,19}$")
)
assert pan_check.count() == 0, "PCI VIOLATION: Raw PAN detected in card_hash column!"

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Bronze Delta Table

# COMMAND ----------

(
    valid_records
    .write
    .format("delta")
    .mode("append")
    .option("mergeSchema", "true")
    .saveAsTable(BRONZE_TABLE)
)

print(f"Bronze ingestion complete: {valid_records.count()} records written to {BRONZE_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Post-Ingestion Summary

# COMMAND ----------

summary = spark.sql(f"""
    SELECT
        COUNT(*) AS total_records,
        COUNT(DISTINCT acct_id) AS unique_accounts,
        MIN(txn_timestamp) AS earliest_txn,
        MAX(txn_timestamp) AS latest_txn,
        SUM(CASE WHEN is_fraud = true THEN 1 ELSE 0 END) AS fraud_count,
        ROUND(AVG(amount), 2) AS avg_amount,
        ROUND(SUM(amount), 2) AS total_volume
    FROM {BRONZE_TABLE}
    WHERE _ingestion_date = '{datetime.now().strftime("%Y-%m-%d")}'
""")

summary.show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Notify Downstream
# MAGIC
# MAGIC Use `mssparkutils` to signal Silver layer readiness.

# COMMAND ----------

from notebookutils import mssparkutils

mssparkutils.notebook.exit(f"bronze_financial_transactions ingested at {datetime.now().isoformat()}")
