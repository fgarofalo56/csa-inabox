# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Retail POS Transactions
# MAGIC
# MAGIC Ingest raw point-of-sale transaction data into the Bronze layer.
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet files (from POS pipeline)
# MAGIC - **Location:** Files/landing/retail_pos/
# MAGIC - **Compliance:** PCI-DSS — card data is pre-tokenized; no PAN stored
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_retail_pos
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
)
from pyspark.sql.types import (
    DoubleType,
    IntegerType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

SOURCE_PATH = "Files/output/bronze_retail_pos.parquet"
TARGET_TABLE = "lh_bronze.bronze_retail_pos"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

print(f"Source: {SOURCE_PATH}")
print(f"Target: {TARGET_TABLE}")
print(f"Batch ID: {BATCH_ID}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Schema

# COMMAND ----------

pos_schema = StructType([
    StructField("txn_id", StringType(), False),
    StructField("txn_timestamp", StringType(), False),
    StructField("store_id", StringType(), False),
    StructField("sku", StringType(), False),
    StructField("category", StringType(), True),
    StructField("subcategory", StringType(), True),
    StructField("brand", StringType(), True),
    StructField("qty", IntegerType(), False),
    StructField("unit_price", DoubleType(), False),
    StructField("discount_pct", DoubleType(), True),
    StructField("line_total", DoubleType(), True),
    StructField("payment_method", StringType(), True),
    StructField("card_token", StringType(), True),
    StructField("card_last4", StringType(), True),
    StructField("loyalty_id", StringType(), True),
    StructField("customer_segment", StringType(), True),
    StructField("store_format", StringType(), True),
    StructField("region", StringType(), True),
    StructField("_ingested_at", StringType(), True),
    StructField("_source", StringType(), True),
    StructField("_batch_id", StringType(), True),
])

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data

# COMMAND ----------

df_raw = spark.read.schema(pos_schema).parquet(SOURCE_PATH)

record_count = df_raw.count()
print(f"Source Statistics:")
print(f"  Records: {record_count:,}")
print(f"  Columns: {len(df_raw.columns)}")

df_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Checks (Bronze)
# MAGIC
# MAGIC Minimal validation — ensure critical fields are present.

# COMMAND ----------

null_txn = df_raw.filter(col("txn_id").isNull()).count()
null_store = df_raw.filter(col("store_id").isNull()).count()
null_sku = df_raw.filter(col("sku").isNull()).count()

print(f"Quality Checks:")
print(f"  Null txn_id:   {null_txn}")
print(f"  Null store_id: {null_store}")
print(f"  Null sku:      {null_sku}")

assert null_txn == 0, f"Found {null_txn} null txn_id rows"
assert null_store == 0, f"Found {null_store} null store_id rows"

# COMMAND ----------

# MAGIC %md
# MAGIC ## PCI-DSS Validation
# MAGIC
# MAGIC Verify no raw PAN (Primary Account Number) leaked into the data.

# COMMAND ----------

# Card tokens must start with 'tok_' — never a raw 16-digit PAN
if df_raw.filter(col("card_token").isNotNull()).count() > 0:
    pan_leak = df_raw.filter(
        col("card_token").rlike("^[0-9]{13,19}$")
    ).count()
    assert pan_leak == 0, f"PCI-DSS VIOLATION: {pan_leak} rows contain raw PAN"
    print("PCI-DSS check passed: no raw PAN detected")
else:
    print("No card tokens in this batch (cash/mobile only)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Ingestion Metadata & Write

# COMMAND ----------

df_bronze = (
    df_raw
    .withColumn("_fabric_ingested_at", current_timestamp())
    .withColumn("_fabric_batch_id", lit(BATCH_ID))
    .withColumn("_fabric_source_file", input_file_name())
)

df_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .saveAsTable(TARGET_TABLE)

final_count = spark.table(TARGET_TABLE).count()
print(f"Bronze table total rows: {final_count:,}")
print(f"Batch {BATCH_ID} ingested {record_count:,} records")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Post-Ingestion Summary

# COMMAND ----------

display(
    spark.sql(f"""
        SELECT
            store_format,
            region,
            COUNT(*) AS txn_count,
            SUM(line_total) AS total_revenue,
            COUNT(DISTINCT store_id) AS store_count
        FROM {TARGET_TABLE}
        WHERE _fabric_batch_id = '{BATCH_ID}'
        GROUP BY store_format, region
        ORDER BY total_revenue DESC
    """)
)

# COMMAND ----------

# Record checkpoint for downstream
checkpoint_path = "abfss://retail@{{ADLS_ACCOUNT}}.dfs.core.windows.net/checkpoints/bronze_pos"
mssparkutils.fs.put(
    f"{checkpoint_path}/last_batch.txt",
    f"{BATCH_ID}|{record_count}|{datetime.now().isoformat()}",
    True,
)
print(f"Checkpoint written: {checkpoint_path}/last_batch.txt")
