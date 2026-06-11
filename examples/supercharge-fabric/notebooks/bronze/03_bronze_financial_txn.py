# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Financial Transaction Ingestion
# MAGIC
# MAGIC This notebook ingests cage financial transactions with compliance flagging.
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet files
# MAGIC - **Location:** Files/landing/financial/
# MAGIC - **Schema:** Casino cage system exports
# MAGIC - **Update Frequency:** Near real-time / hourly batches
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_financial_txn
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Append
# MAGIC
# MAGIC ## Key Features
# MAGIC - CTR threshold detection ($10,000+)
# MAGIC - Near-CTR detection ($8,000 - $9,999.99) for structuring alerts
# MAGIC - Partitioned by transaction date
# MAGIC - Append-only pattern for audit trail

# COMMAND ----------

# ---------------------------------------------------------------------------
# Fabric/local compatibility shim
# ---------------------------------------------------------------------------
import os

try:
    import notebookutils  # Fabric runtime
    def _get_arg(name, default=None):
        try:
            return notebookutils.notebook.getArgument(name, default)
        except Exception:
            return os.environ.get(name.upper(), default)
    def _notebook_exit(status: str) -> None:
        notebookutils.notebook.exit(status)
except ImportError:
    try:
        import mssparkutils  # legacy Synapse/Fabric runtime
        def _get_arg(name, default=None):
            try:
                return mssparkutils.notebook.getArgument(name, default)
            except Exception:
                return os.environ.get(name.upper(), default)
        def _notebook_exit(status: str) -> None:
            mssparkutils.notebook.exit(status)
    except ImportError:
        def _get_arg(name, default=None):
            return os.environ.get(name.upper(), default)
        def _notebook_exit(status: str) -> None:
            raise SystemExit(status)


# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from datetime import datetime

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.functions import (
    coalesce,
    col,
    current_timestamp,
    input_file_name,
    lit,
    to_date,
    to_timestamp,
    when,
)
from pyspark.sql.functions import count as _count
from pyspark.sql.functions import sum as _sum
from pyspark.sql.types import (
    BooleanType,
    DoubleType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Configuration
SOURCE_PATH = "Files/output/bronze_financial_txn.parquet"
TARGET_TABLE = "lh_bronze.bronze_financial_txn"
SCHEMA_VERSION = "1.0"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

# Compliance thresholds
CTR_THRESHOLD = 10000       # Currency Transaction Report threshold
NEAR_CTR_LOW = 8000         # Lower bound for near-CTR detection (structuring)
SAR_THRESHOLD = 8000        # Suspicious Activity Report consideration threshold

# Valid enum values from schema
VALID_TRANSACTION_TYPES = [
    "CASH_IN", "CASH_OUT", "MARKER", "MARKER_PAYMENT",
    "CHIP_PURCHASE", "CHIP_REDEMPTION", "TICKET_IN",
    "TICKET_OUT", "WIRE_TRANSFER", "CHECK"
]
VALID_PAYMENT_METHODS = ["CASH", "CHECK", "WIRE", "CHIP", "TICKET"]

print(f"Source: {SOURCE_PATH}")
print(f"Target: {TARGET_TABLE}")
print(f"Schema Version: {SCHEMA_VERSION}")
print(f"Batch ID: {BATCH_ID}")
print(f"CTR Threshold: ${CTR_THRESHOLD:,}")
print(f"Near-CTR Range: ${NEAR_CTR_LOW:,} - ${CTR_THRESHOLD - 0.01:,.2f}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Schema
# MAGIC
# MAGIC Explicit schema matching `data_generation/schemas/financial_transaction_schema.json`.

# COMMAND ----------

financial_txn_schema = StructType([
    StructField("transaction_id", StringType(), False),
    StructField("transaction_type", StringType(), False),
    StructField("amount", DoubleType(), False),
    StructField("transaction_timestamp", TimestampType(), False),
    StructField("player_id", StringType(), True),
    StructField("cage_location", StringType(), True),
    StructField("cashier_id", StringType(), True),
    StructField("source_amount", DoubleType(), True),
    StructField("destination_amount", DoubleType(), True),
    StructField("currency", StringType(), True),
    StructField("payment_method", StringType(), True),
    StructField("ctr_required", BooleanType(), True),
    StructField("ctr_filed", BooleanType(), True),
    StructField("marker_number", StringType(), True),
    StructField("approval_code", StringType(), True),
    StructField("notes", StringType(), True),
    StructField("_ingested_at", StringType(), True),
    StructField("_source", StringType(), True),
    StructField("_batch_id", StringType(), True),
])

print(f"Schema defined with {len(financial_txn_schema.fields)} fields")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data

# COMMAND ----------

# Read parquet file with error handling for missing source
try:
    df_raw = spark.read.parquet(SOURCE_PATH)

    # Display statistics
    record_count = df_raw.count()
    column_count = len(df_raw.columns)

    print(f"Source Statistics:")
    print(f"  Records: {record_count:,}")
    print(f"  Columns: {column_count}")

    # Show schema
    df_raw.printSchema()

except Exception as e:
    print(f"ERROR: Failed to read source data from {SOURCE_PATH}")
    print(f"  Exception: {e!s}")
    print(f"  Verify the source file exists and is accessible.")
    _notebook_exit(f"FAILED: Source read error - {e!s}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Schema Enforcement
# MAGIC
# MAGIC Apply the explicit StructType schema to enforce data types and catch mismatches.

# COMMAND ----------

# Apply schema enforcement
schema_fields = [f.name for f in financial_txn_schema.fields if f.name not in ("_ingested_at", "_source", "_batch_id")]
source_columns = df_raw.columns

# Identify missing and extra columns
missing_cols = [f for f in schema_fields if f not in source_columns]
extra_cols = [c for c in source_columns if c not in [f.name for f in financial_txn_schema.fields]]

print("Schema Enforcement Report:")
print(f"  Expected fields: {len(schema_fields)}")
print(f"  Source columns: {len(source_columns)}")
if missing_cols:
    print(f"  Missing columns (will be null): {missing_cols}")
if extra_cols:
    print(f"  Extra columns (will be preserved): {extra_cols}")

# Add missing columns as null
df_enforced = df_raw
for missing in missing_cols:
    field = [f for f in financial_txn_schema.fields if f.name == missing][0]
    df_enforced = df_enforced.withColumn(missing, lit(None).cast(field.dataType))

print("Schema enforcement applied successfully.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Checks (Bronze)
# MAGIC
# MAGIC Validate critical fields, enum values, amount ranges, and compliance flags.

# COMMAND ----------

# Check for null critical fields (required per schema)
critical_fields = ["transaction_id", "transaction_type", "amount", "transaction_timestamp"]

print("=" * 60)
print("DATA QUALITY CHECKS - Financial Transactions")
print("=" * 60)

print("\n1. Critical Field Null Check:")
quality_issues = 0
for field in critical_fields:
    if field in df_enforced.columns:
        null_count = df_enforced.filter(col(field).isNull()).count()
        status = "PASS" if null_count == 0 else f"WARN: {null_count} nulls"
        if null_count > 0:
            quality_issues += 1
        print(f"  {field}: {status}")
    else:
        print(f"  {field}: MISSING FROM SOURCE")
        quality_issues += 1

# Check transaction_type enum validation
print("\n2. Transaction Type Enum Validation:")
if "transaction_type" in df_enforced.columns:
    invalid_types = df_enforced.filter(
        ~col("transaction_type").isin(VALID_TRANSACTION_TYPES) & col("transaction_type").isNotNull()
    ).count()
    print(f"  Valid types: {VALID_TRANSACTION_TYPES}")
    print(f"  Invalid transaction_type values: {invalid_types}")
    if invalid_types > 0:
        quality_issues += 1

# Check payment_method enum validation
print("\n3. Payment Method Enum Validation:")
if "payment_method" in df_enforced.columns:
    invalid_methods = df_enforced.filter(
        ~col("payment_method").isin(VALID_PAYMENT_METHODS) & col("payment_method").isNotNull()
    ).count()
    print(f"  Valid methods: {VALID_PAYMENT_METHODS}")
    print(f"  Invalid payment_method values: {invalid_methods}")

# Check amount range validation (must be >= 0)
print("\n4. Amount Range Validation:")
if "amount" in df_enforced.columns:
    # Single aggregation action: combines negative/zero/max/avg into one Spark job
    # rather than four separate scans across the full dataset.
    _amount_stats = df_enforced.agg(
        F.sum((col("amount") < 0).cast("int")).alias("negative"),
        F.sum((col("amount") == 0).cast("int")).alias("zero"),
        F.max("amount").alias("max_amount"),
        F.avg("amount").alias("avg_amount"),
    ).collect()[0]
    negative_amounts = int(_amount_stats["negative"] or 0)
    zero_amounts = int(_amount_stats["zero"] or 0)
    max_amount = _amount_stats["max_amount"]
    avg_amount = _amount_stats["avg_amount"]
    print(f"  Negative amounts: {negative_amounts}")
    print(f"  Zero amounts: {zero_amounts}")
    print(f"  Max amount: ${max_amount:,.2f}" if max_amount is not None else "  Max amount: N/A")
    print(f"  Avg amount: ${avg_amount:,.2f}" if avg_amount is not None else "  Avg amount: N/A")
    if negative_amounts > 0:
        quality_issues += 1
        print("  WARN: Negative amounts detected - review source data")

# Check for duplicate transaction_ids
print("\n5. Duplicate Check:")
if "transaction_id" in df_enforced.columns:
    total = df_enforced.count()
    distinct = df_enforced.select("transaction_id").distinct().count()
    dupes = total - distinct
    print(f"  Total records: {total:,}")
    print(f"  Distinct transaction_ids: {distinct:,}")
    print(f"  Duplicates: {dupes:,}")
    if dupes > 0:
        quality_issues += 1

print(f"\nTotal quality issues: {quality_issues}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Compliance Flags and Bronze Metadata

# COMMAND ----------

# Add Bronze metadata, compliance flags, and derived columns
df_bronze = df_enforced \
    .withColumn("transaction_date", to_date("transaction_timestamp")) \
    .withColumn("ctr_required",
        when(col("ctr_required").isNotNull(), col("ctr_required"))
        .otherwise(col("amount") >= CTR_THRESHOLD)) \
    .withColumn("near_ctr",
        col("amount").between(NEAR_CTR_LOW, CTR_THRESHOLD - 0.01)) \
    .withColumn("sar_review_candidate",
        col("amount").between(SAR_THRESHOLD, CTR_THRESHOLD - 0.01)) \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date")) \
    .withColumn("_bronze_schema_version", lit(SCHEMA_VERSION))

# Report compliance flag summary
ctr_count = df_bronze.filter(col("ctr_required") == True).count()
near_ctr_count = df_bronze.filter(col("near_ctr") == True).count()
sar_candidate_count = df_bronze.filter(col("sar_review_candidate") == True).count()

print("Compliance Flag Summary:")
print(f"  CTR required (>= ${CTR_THRESHOLD:,}): {ctr_count:,}")
print(f"  Near-CTR (${NEAR_CTR_LOW:,} - ${CTR_THRESHOLD - 0.01:,.2f}): {near_ctr_count:,}")
print(f"  SAR review candidates: {sar_candidate_count:,}")

print("\nAdded Bronze metadata columns:")
print("  - transaction_date (derived)")
print("  - ctr_required, near_ctr, sar_review_candidate (compliance)")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")
print("  - _bronze_schema_version")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table

# COMMAND ----------

# Write to Bronze Delta table with date partitioning
df_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("transaction_date") \
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
print(f"  Partitions: {df_verify.select('transaction_date').distinct().count()}")

# Sample data
print(f"\nSample Records:")
display(
    df_verify.select(
        "transaction_id", "transaction_type", "amount",
        "transaction_timestamp", "ctr_required", "near_ctr",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Table Statistics

# COMMAND ----------

# Transaction type distribution
print("Transaction Type Distribution:")
display(
    df_verify
    .groupBy("transaction_type")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Payment method distribution
print("Payment Method Distribution:")
display(
    df_verify
    .groupBy("payment_method")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Compliance summary by date
print("Compliance Summary by Date:")
display(
    df_verify
    .groupBy("transaction_date")
    .agg(
        _count("*").alias("total_txns"),
        _sum(when(col("ctr_required"), 1).otherwise(0)).alias("ctr_required"),
        _sum(when(col("near_ctr"), 1).otherwise(0)).alias("near_ctr"),
        _sum(col("amount")).alias("total_amount")
    )
    .orderBy(col("transaction_date").desc())
)

# COMMAND ----------

# Amount distribution by transaction type
print("Amount Statistics by Transaction Type:")
display(
    df_verify
    .groupBy("transaction_type")
    .agg(
        _count("*").alias("count"),
        _sum("amount").alias("total_amount"),
        col("transaction_type")  # placeholder for groupBy
    )
    .drop("transaction_type")
    .orderBy(col("total_amount").desc())
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
# MAGIC | Target | bronze_financial_txn |
# MAGIC | Load Pattern | Append |
# MAGIC | Format | Delta Lake |
# MAGIC | Partitioned By | transaction_date |
# MAGIC | CTR Threshold | $10,000 |
# MAGIC | Near-CTR Range | $8,000 - $9,999.99 |
# MAGIC | Schema Version | 1.0 |
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer for transaction reconciliation and compliance enrichment.
