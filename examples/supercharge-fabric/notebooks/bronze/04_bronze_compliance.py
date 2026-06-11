# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Compliance Filings Ingestion
# MAGIC
# MAGIC This notebook ingests regulatory compliance filings (CTR, SAR, W-2G).
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet files
# MAGIC - **Location:** Files/landing/compliance/
# MAGIC - **Schema:** Regulatory filing system exports
# MAGIC - **Update Frequency:** Daily batch
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_compliance
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Append
# MAGIC
# MAGIC ## Regulatory Context
# MAGIC - **CTR**: Currency Transaction Report (FinCEN) - $10,000+ cash transactions
# MAGIC - **SAR**: Suspicious Activity Report (FinCEN) - Structuring, unusual patterns
# MAGIC - **W-2G**: IRS Form for gambling winnings >= $1,200 (slots), $600 (keno), $5,000 (poker)

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
from pyspark.sql.functions import (
    coalesce,
    col,
    current_timestamp,
    datediff,
    input_file_name,
    lit,
    to_date,
    to_timestamp,
    when,
)
from pyspark.sql.functions import count as _count
from pyspark.sql.functions import sum as _sum
from pyspark.sql.types import (
    DoubleType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Configuration
SOURCE_PATH = "Files/output/bronze_compliance_filings.parquet"
TARGET_TABLE = "lh_bronze.bronze_compliance"
SCHEMA_VERSION = "1.0"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

# Valid enum values from schema
VALID_FILING_TYPES = ["CTR", "SAR", "W2G"]
VALID_FILING_STATUSES = ["PENDING", "SUBMITTED", "ACCEPTED", "REJECTED"]

# Regulatory thresholds
CTR_AMOUNT_THRESHOLD = 10000
W2G_SLOT_THRESHOLD = 1200
W2G_KENO_THRESHOLD = 600
W2G_POKER_THRESHOLD = 5000

print(f"Source: {SOURCE_PATH}")
print(f"Target: {TARGET_TABLE}")
print(f"Schema Version: {SCHEMA_VERSION}")
print(f"Batch ID: {BATCH_ID}")
print(f"Valid Filing Types: {VALID_FILING_TYPES}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Schema
# MAGIC
# MAGIC Explicit schema matching `data_generation/schemas/compliance_filing_schema.json`.

# COMMAND ----------

compliance_schema = StructType([
    StructField("filing_id", StringType(), False),
    StructField("filing_type", StringType(), False),
    StructField("filing_timestamp", TimestampType(), False),
    StructField("player_id", StringType(), True),
    StructField("amount", DoubleType(), False),
    StructField("transaction_date", StringType(), True),
    StructField("gaming_day", StringType(), True),
    StructField("transaction_type", StringType(), True),
    StructField("cage_location", StringType(), True),
    StructField("cashier_id", StringType(), True),
    StructField("suspicious_activity_type", StringType(), True),
    StructField("narrative", StringType(), True),
    StructField("game_type", StringType(), True),
    StructField("machine_id", StringType(), True),
    StructField("wager_amount", DoubleType(), True),
    StructField("filing_status", StringType(), True),
    StructField("due_date", StringType(), True),
    StructField("_ingested_at", StringType(), True),
    StructField("_source", StringType(), True),
    StructField("_batch_id", StringType(), True),
])

print(f"Schema defined with {len(compliance_schema.fields)} fields")

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
schema_fields = [f.name for f in compliance_schema.fields if f.name not in ("_ingested_at", "_source", "_batch_id")]
source_columns = df_raw.columns

# Identify missing and extra columns
missing_cols = [f for f in schema_fields if f not in source_columns]
extra_cols = [c for c in source_columns if c not in [f.name for f in compliance_schema.fields]]

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
    field = [f for f in compliance_schema.fields if f.name == missing][0]
    df_enforced = df_enforced.withColumn(missing, lit(None).cast(field.dataType))

print("Schema enforcement applied successfully.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Checks (Bronze)
# MAGIC
# MAGIC Validate critical fields, enum values, amount thresholds, and regulatory consistency.

# COMMAND ----------

# Check for null critical fields (required per schema)
critical_fields = ["filing_id", "filing_type", "filing_timestamp", "amount"]

print("=" * 60)
print("DATA QUALITY CHECKS - Compliance Filings")
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

# Check filing_type enum validation
print("\n2. Filing Type Enum Validation:")
if "filing_type" in df_enforced.columns:
    invalid_types = df_enforced.filter(
        ~col("filing_type").isin(VALID_FILING_TYPES) & col("filing_type").isNotNull()
    ).count()
    print(f"  Valid types: {VALID_FILING_TYPES}")
    print(f"  Invalid filing_type values: {invalid_types}")
    if invalid_types > 0:
        quality_issues += 1

# Check filing_status enum validation
print("\n3. Filing Status Enum Validation:")
if "filing_status" in df_enforced.columns:
    invalid_statuses = df_enforced.filter(
        ~col("filing_status").isin(VALID_FILING_STATUSES) & col("filing_status").isNotNull()
    ).count()
    print(f"  Valid statuses: {VALID_FILING_STATUSES}")
    print(f"  Invalid filing_status values: {invalid_statuses}")
    if invalid_statuses > 0:
        quality_issues += 1

# Check amount range validation (must be >= 0)
print("\n4. Amount Range Validation:")
if "amount" in df_enforced.columns:
    negative_amounts = df_enforced.filter(col("amount") < 0).count()
    print(f"  Negative amounts: {negative_amounts}")
    if negative_amounts > 0:
        quality_issues += 1

# CTR amount consistency check
print("\n5. CTR Amount Consistency:")
if "filing_type" in df_enforced.columns and "amount" in df_enforced.columns:
    ctr_below_threshold = df_enforced.filter(
        (col("filing_type") == "CTR") & (col("amount") < CTR_AMOUNT_THRESHOLD)
    ).count()
    print(f"  CTR filings below ${CTR_AMOUNT_THRESHOLD:,}: {ctr_below_threshold}")
    if ctr_below_threshold > 0:
        quality_issues += 1
        print(f"  WARN: CTR filings with amount below threshold detected")

# W-2G amount consistency check
print("\n6. W-2G Amount Consistency:")
if "filing_type" in df_enforced.columns and "amount" in df_enforced.columns:
    w2g_below_min = df_enforced.filter(
        (col("filing_type") == "W2G") & (col("amount") < W2G_KENO_THRESHOLD)
    ).count()
    print(f"  W-2G filings below ${W2G_KENO_THRESHOLD}: {w2g_below_min}")

# Check for duplicate filing_ids
print("\n7. Duplicate Check:")
if "filing_id" in df_enforced.columns:
    total = df_enforced.count()
    distinct = df_enforced.select("filing_id").distinct().count()
    dupes = total - distinct
    print(f"  Total records: {total:,}")
    print(f"  Distinct filing_ids: {distinct:,}")
    print(f"  Duplicates: {dupes:,}")
    if dupes > 0:
        quality_issues += 1

print(f"\nTotal quality issues: {quality_issues}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Regulatory Categorization and Bronze Metadata

# COMMAND ----------

# Add metadata and categorization
df_bronze = df_enforced \
    .withColumn("filing_date", to_date("filing_timestamp")) \
    .withColumn("_regulatory_agency",
        when(col("filing_type").isin("CTR", "SAR"), "FinCEN")
        .when(col("filing_type") == "W2G", "IRS")
        .otherwise("Other")) \
    .withColumn("_filing_urgency",
        when(col("filing_type") == "SAR", "HIGH")
        .when(col("filing_type") == "CTR", "MEDIUM")
        .when(col("filing_type") == "W2G", "STANDARD")
        .otherwise("UNKNOWN")) \
    .withColumn("_days_until_due",
        when(col("due_date").isNotNull(),
             datediff(to_date("due_date"), current_timestamp().cast("date")))
        .otherwise(lit(None))) \
    .withColumn("_is_overdue",
        when(col("due_date").isNotNull(),
             to_date("due_date") < current_timestamp().cast("date"))
        .otherwise(lit(False))) \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date")) \
    .withColumn("_bronze_schema_version", lit(SCHEMA_VERSION))

print("Added Bronze metadata and regulatory columns:")
print("  - filing_date (derived)")
print("  - _regulatory_agency (FinCEN / IRS)")
print("  - _filing_urgency (HIGH / MEDIUM / STANDARD)")
print("  - _days_until_due, _is_overdue (deadline tracking)")
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
    .partitionBy("filing_date") \
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
print(f"  Partitions: {df_verify.select('filing_date').distinct().count()}")

# Sample data
print(f"\nSample Records:")
display(
    df_verify.select(
        "filing_id", "filing_type", "amount",
        "filing_timestamp", "filing_status", "_regulatory_agency",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Table Statistics

# COMMAND ----------

# Filing type distribution with regulatory agency
print("Filing Type Distribution:")
display(
    df_verify
    .groupBy("filing_type", "_regulatory_agency")
    .agg(
        _count("*").alias("count"),
        _sum("amount").alias("total_amount")
    )
    .orderBy("filing_type")
)

# COMMAND ----------

# Filing status distribution
print("Filing Status Distribution:")
display(
    df_verify
    .groupBy("filing_type", "filing_status")
    .count()
    .orderBy("filing_type", "filing_status")
)

# COMMAND ----------

# Overdue filings report
print("Overdue Filings Report:")
display(
    df_verify
    .filter(col("_is_overdue") == True)
    .groupBy("filing_type", "filing_status")
    .agg(
        _count("*").alias("overdue_count"),
        _sum("amount").alias("total_amount")
    )
    .orderBy("filing_type")
)

# COMMAND ----------

# SAR suspicious activity types
print("SAR Suspicious Activity Types:")
display(
    df_verify
    .filter(col("filing_type") == "SAR")
    .groupBy("suspicious_activity_type")
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
# MAGIC | Target | bronze_compliance |
# MAGIC | Load Pattern | Append |
# MAGIC | Format | Delta Lake |
# MAGIC | Partitioned By | filing_date |
# MAGIC | Filing Types | CTR, SAR, W-2G |
# MAGIC | Regulatory Agencies | FinCEN, IRS |
# MAGIC | Schema Version | 1.0 |
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer for filing validation, deadline tracking, and regulatory enrichment.
