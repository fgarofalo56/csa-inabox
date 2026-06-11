# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Player Profile Ingestion
# MAGIC
# MAGIC This notebook ingests player profile data into the Bronze layer with PII handling.
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet files
# MAGIC - **Location:** Files/landing/player_profiles/
# MAGIC - **Schema:** Casino loyalty/CRM system exports
# MAGIC - **Update Frequency:** Daily full load (dimension data)
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_player_profile
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Overwrite (full load for dimension tables)
# MAGIC
# MAGIC ## Key Features
# MAGIC - SSN hashing at ingestion (never store raw SSN)
# MAGIC - PII field identification and metadata enrichment
# MAGIC - Full load pattern for dimension data
# MAGIC - Loyalty tier validation

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
    input_file_name,
    length,
    lit,
    regexp_extract,
    sha2,
    to_date,
    when,
)
from pyspark.sql.types import BooleanType, StringType, StructField, StructType

# Configuration
SOURCE_PATH = "Files/output/bronze_player_profile.parquet"
TARGET_TABLE = "lh_bronze.bronze_player_profile"
SCHEMA_VERSION = "1.0"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

# Valid enum values from schema
VALID_LOYALTY_TIERS = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"]
VALID_GENDERS = ["M", "F", "O"]

print(f"Source: {SOURCE_PATH}")
print(f"Target: {TARGET_TABLE}")
print(f"Schema Version: {SCHEMA_VERSION}")
print(f"Batch ID: {BATCH_ID}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Schema
# MAGIC
# MAGIC Explicit schema matching `data_generation/schemas/player_profile_schema.json`.
# MAGIC Ensures type safety and documents expected fields at ingestion.

# COMMAND ----------

player_profile_schema = StructType([
    StructField("player_id", StringType(), False),
    StructField("first_name", StringType(), False),
    StructField("last_name", StringType(), False),
    StructField("date_of_birth", StringType(), True),
    StructField("gender", StringType(), True),
    StructField("email", StringType(), True),
    StructField("phone", StringType(), True),
    StructField("address", StringType(), True),
    StructField("city", StringType(), True),
    StructField("state", StringType(), True),
    StructField("zip_code", StringType(), True),
    StructField("loyalty_tier", StringType(), False),
    StructField("enrollment_date", StringType(), True),
    StructField("marketing_opt_in", BooleanType(), True),
    StructField("ssn", StringType(), True),
    StructField("ssn_hash", StringType(), True),
    StructField("_ingested_at", StringType(), True),
    StructField("_source", StringType(), True),
    StructField("_batch_id", StringType(), True),
])

print(f"Schema defined with {len(player_profile_schema.fields)} fields")

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

# Apply schema enforcement by selecting and casting columns
schema_fields = [f.name for f in player_profile_schema.fields if f.name not in ("_ingested_at", "_source", "_batch_id")]
source_columns = df_raw.columns

# Identify missing and extra columns
missing_cols = [f for f in schema_fields if f not in source_columns]
extra_cols = [c for c in source_columns if c not in [f.name for f in player_profile_schema.fields]]

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
    field = [f for f in player_profile_schema.fields if f.name == missing][0]
    df_enforced = df_enforced.withColumn(missing, lit(None).cast(field.dataType))

print("Schema enforcement applied successfully.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Checks (Bronze)
# MAGIC
# MAGIC Validate critical fields, enum values, and data integrity for player profiles.

# COMMAND ----------

# Check for null critical fields (required per schema)
critical_fields = ["player_id", "first_name", "last_name", "loyalty_tier"]

print("=" * 60)
print("DATA QUALITY CHECKS - Player Profile")
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

# Check loyalty_tier enum validation
print("\n2. Loyalty Tier Enum Validation:")
if "loyalty_tier" in df_enforced.columns:
    invalid_tiers = df_enforced.filter(
        ~col("loyalty_tier").isin(VALID_LOYALTY_TIERS) & col("loyalty_tier").isNotNull()
    ).count()
    print(f"  Valid tiers: {VALID_LOYALTY_TIERS}")
    print(f"  Invalid tier values: {invalid_tiers}")
    if invalid_tiers > 0:
        quality_issues += 1
        print("  WARN: Found records with invalid loyalty_tier values")

# Check gender enum validation
print("\n3. Gender Enum Validation:")
if "gender" in df_enforced.columns:
    invalid_genders = df_enforced.filter(
        ~col("gender").isin(VALID_GENDERS) & col("gender").isNotNull()
    ).count()
    print(f"  Valid genders: {VALID_GENDERS}")
    print(f"  Invalid gender values: {invalid_genders}")

# Check player_id format (should match ^P[0-9]+$)
print("\n4. Player ID Format Validation:")
if "player_id" in df_enforced.columns:
    invalid_ids = df_enforced.filter(
        ~col("player_id").rlike("^P[0-9]+$") & col("player_id").isNotNull()
    ).count()
    print(f"  Expected pattern: ^P[0-9]+$")
    print(f"  Invalid player_id values: {invalid_ids}")

# Check for duplicate player_ids
print("\n5. Duplicate Check:")
if "player_id" in df_enforced.columns:
    total = df_enforced.count()
    distinct = df_enforced.select("player_id").distinct().count()
    dupes = total - distinct
    print(f"  Total records: {total:,}")
    print(f"  Distinct player_ids: {distinct:,}")
    print(f"  Duplicates: {dupes:,}")
    if dupes > 0:
        quality_issues += 1

print(f"\nTotal quality issues: {quality_issues}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## PII Handling - Hash SSN
# MAGIC
# MAGIC **CRITICAL:** SSN must be hashed at ingestion. Never store raw SSN in the lakehouse.
# MAGIC This is a compliance requirement for the gaming industry.

# COMMAND ----------

# CRITICAL: Hash SSN immediately - never store raw SSN
# This is a compliance requirement for gaming industry

df_pii_handled = df_enforced \
    .withColumn("ssn_hash",
        when(col("ssn").isNotNull(), sha2(col("ssn"), 256))
        .otherwise(col("ssn_hash"))) \
    .drop("ssn")

ssn_hash_count = df_pii_handled.filter(col("ssn_hash").isNotNull()).count()
print(f"PII Handling Complete:")
print(f"  SSN column dropped (raw SSN never stored)")
print(f"  Records with ssn_hash: {ssn_hash_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata

# COMMAND ----------

# Add Bronze layer metadata columns
df_bronze = df_pii_handled \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date")) \
    .withColumn("_bronze_schema_version", lit(SCHEMA_VERSION))

print("Added Bronze metadata columns:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")
print("  - _bronze_schema_version")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table
# MAGIC
# MAGIC Player profiles use **overwrite** mode as this is dimension data (full load).

# COMMAND ----------

# Write to Bronze Delta table (overwrite for dimension tables)
df_bronze.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
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
print(f"  Column count: {len(df_verify.columns)}")

# Sample data
print(f"\nSample Records:")
display(
    df_verify.select(
        "player_id", "first_name", "last_name",
        "loyalty_tier", "enrollment_date", "ssn_hash",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Table Statistics

# COMMAND ----------

# Loyalty tier distribution
print("Loyalty Tier Distribution:")
display(
    df_verify
    .groupBy("loyalty_tier")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Gender distribution
print("Gender Distribution:")
display(
    df_verify
    .groupBy("gender")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# State distribution (top 15)
print("State Distribution (Top 15):")
display(
    df_verify
    .groupBy("state")
    .count()
    .orderBy(col("count").desc())
    .limit(15)
)

# COMMAND ----------

# Marketing opt-in summary
print("Marketing Opt-In Summary:")
display(
    df_verify
    .groupBy("marketing_opt_in")
    .count()
    .orderBy("marketing_opt_in")
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
# MAGIC | Target | bronze_player_profile |
# MAGIC | Load Pattern | Full overwrite (dimension) |
# MAGIC | Format | Delta Lake |
# MAGIC | PII Handling | SSN hashed (SHA-256), raw dropped |
# MAGIC | Schema Version | 1.0 |
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer transformation for deduplication and standardization.
