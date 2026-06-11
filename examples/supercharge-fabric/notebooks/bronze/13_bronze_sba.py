# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: SBA Data Ingestion
# MAGIC
# MAGIC This notebook ingests raw SBA (Small Business Administration) data into the Bronze layer
# MAGIC across two domains: PPP Loans and 7(a)/504 Loans.
# MAGIC
# MAGIC ## Data Sources
# MAGIC - **PPP Loans:** Paycheck Protection Program loan-level data
# MAGIC - **7(a)/504 Loans:** SBA 7(a) and 504 standard loan program data
# MAGIC - **Formats:** Parquet (data generator output) with CSV fallback (open data downloads)
# MAGIC
# MAGIC ## Targets
# MAGIC - **bronze_sba_ppp_loans** - PPP loan records
# MAGIC - **bronze_sba_7a_504_loans** - 7(a) and 504 loan records
# MAGIC - **Format:** Delta Lake (Append)
# MAGIC - **Partitioned By:** _bronze_load_date

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
    when,
)
from pyspark.sql.types import (
    DoubleType,
    IntegerType,
    StringType,
    StructField,
    StructType,
)

# Source paths - data generator parquet output (primary)
SOURCE_PATHS = {
    "ppp_loans": "Files/output/sba_ppp_loans.parquet",
    "7a_504_loans": "Files/output/sba_7a_504_loans.parquet",
}

# CSV fallback paths - open data downloads
CSV_FALLBACK_PATHS = {
    "ppp_loans": "Files/open_data/sba/ppp_loans/",
    "7a_504_loans": "Files/open_data/sba/7a_504_loans/",
}

# Target Delta tables
TARGET_TABLES = {
    "ppp_loans": "lh_bronze.bronze_sba_ppp_loans",
    "7a_504_loans": "lh_bronze.bronze_sba_7a_504_loans",
}

BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

print(f"Batch ID: {BATCH_ID}")
print(f"\nSource Paths (Parquet):")
for domain, path in SOURCE_PATHS.items():
    print(f"  {domain}: {path}")
print(f"\nCSV Fallback Paths:")
for domain, path in CSV_FALLBACK_PATHS.items():
    print(f"  {domain}: {path}")
print(f"\nTarget Tables:")
for domain, table in TARGET_TABLES.items():
    print(f"  {domain}: {table}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Schemas
# MAGIC
# MAGIC Explicit schemas for both SBA domains to enforce structure at ingestion.

# COMMAND ----------

# PPP Loans schema
ppp_loans_schema = StructType([
    StructField("loan_id", StringType(), False),
    StructField("borrower_name", StringType(), False),
    StructField("borrower_address", StringType(), True),
    StructField("borrower_city", StringType(), True),
    StructField("borrower_state", StringType(), True),
    StructField("borrower_zip", StringType(), True),
    StructField("loan_amount", DoubleType(), False),
    StructField("jobs_retained", IntegerType(), True),
    StructField("naics_code", StringType(), True),
    StructField("business_type", StringType(), True),
    StructField("loan_status", StringType(), True),
    StructField("forgiveness_amount", DoubleType(), True),
    StructField("lender_name", StringType(), True),
    StructField("approval_date", StringType(), True),
    StructField("forgiveness_date", StringType(), True),
])

print(f"PPP Loans schema fields: {len(ppp_loans_schema.fields)}")
for field in ppp_loans_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# 7(a)/504 Loans schema
loan_7a_504_schema = StructType([
    StructField("loan_id", StringType(), False),
    StructField("program_type", StringType(), False),
    StructField("borrower_name", StringType(), False),
    StructField("borrower_state", StringType(), True),
    StructField("naics_code", StringType(), True),
    StructField("approval_amount", DoubleType(), True),
    StructField("gross_approval", DoubleType(), True),
    StructField("term_months", IntegerType(), True),
    StructField("jobs_supported", IntegerType(), True),
    StructField("approval_date", StringType(), True),
    StructField("paid_in_full_date", StringType(), True),
    StructField("charge_off_date", StringType(), True),
    StructField("loan_status", StringType(), True),
])

print(f"\n7(a)/504 Loans schema fields: {len(loan_7a_504_schema.fields)}")
for field in loan_7a_504_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - PPP Loans
# MAGIC
# MAGIC Reads from parquet (data generator output) first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read PPP loans data: try parquet first, fallback to CSV
try:
    df_ppp_raw = spark.read \
        .schema(ppp_loans_schema) \
        .parquet(SOURCE_PATHS["ppp_loans"])
    ppp_source_format = "Parquet"
    print(f"PPP Loans: loaded from Parquet ({SOURCE_PATHS['ppp_loans']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['ppp_loans']}")
    df_ppp_raw = spark.read \
        .schema(ppp_loans_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["ppp_loans"])
    ppp_source_format = "CSV"
    print(f"PPP Loans: loaded from CSV")

ppp_record_count = df_ppp_raw.count()
ppp_column_count = len(df_ppp_raw.columns)

print(f"\nPPP Loans Source Statistics:")
print(f"  Format: {ppp_source_format}")
print(f"  Records: {ppp_record_count:,}")
print(f"  Columns: {ppp_column_count}")

df_ppp_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - 7(a)/504 Loans
# MAGIC
# MAGIC Reads SBA 7(a) and 504 loan data from parquet first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read 7(a)/504 loans data: try parquet first, fallback to CSV
try:
    df_7a_raw = spark.read \
        .schema(loan_7a_504_schema) \
        .parquet(SOURCE_PATHS["7a_504_loans"])
    loan_7a_source_format = "Parquet"
    print(f"7(a)/504 Loans: loaded from Parquet ({SOURCE_PATHS['7a_504_loans']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['7a_504_loans']}")
    df_7a_raw = spark.read \
        .schema(loan_7a_504_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["7a_504_loans"])
    loan_7a_source_format = "CSV"
    print(f"7(a)/504 Loans: loaded from CSV")

loan_7a_record_count = df_7a_raw.count()
loan_7a_column_count = len(df_7a_raw.columns)

print(f"\n7(a)/504 Loans Source Statistics:")
print(f"  Format: {loan_7a_source_format}")
print(f"  Records: {loan_7a_record_count:,}")
print(f"  Columns: {loan_7a_column_count}")

df_7a_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Bronze Data Quality Checks
# MAGIC
# MAGIC Minimal validation at Bronze layer - verify critical fields are populated.

# COMMAND ----------

# PPP Loans critical field null checks
ppp_critical_fields = ["loan_id", "borrower_name", "loan_amount"]

print("PPP Loans - Critical Field Null Check:")
for field in ppp_critical_fields:
    null_count = df_ppp_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# 7(a)/504 Loans critical field null checks
loan_7a_critical_fields = ["loan_id", "program_type", "borrower_name"]

print("\n7(a)/504 Loans - Critical Field Null Check:")
for field in loan_7a_critical_fields:
    null_count = df_7a_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - PPP Loans

# COMMAND ----------

# Add Bronze layer metadata columns to PPP loans
df_ppp_bronze = df_ppp_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to PPP Loans:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - 7(a)/504 Loans

# COMMAND ----------

# Add Bronze layer metadata columns to 7(a)/504 loans
df_7a_bronze = df_7a_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to 7(a)/504 Loans:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - PPP Loans

# COMMAND ----------

# Write PPP loans to Bronze Delta table
df_ppp_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["ppp_loans"])

ppp_final_count = spark.table(TARGET_TABLES["ppp_loans"]).count()
print(f"Successfully wrote {ppp_final_count:,} records to {TARGET_TABLES['ppp_loans']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - 7(a)/504 Loans

# COMMAND ----------

# Write 7(a)/504 loans to Bronze Delta table
df_7a_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["7a_504_loans"])

loan_7a_final_count = df_7a_bronze.count()
print(f"Successfully wrote {loan_7a_final_count:,} records to {TARGET_TABLES['7a_504_loans']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Verify Ingestion

# COMMAND ----------

# Verify PPP loans table
df_ppp_verify = spark.table(TARGET_TABLES["ppp_loans"])

print("PPP Loans Table Verification:")
print(f"  Total records: {df_ppp_verify.count():,}")
print(f"  Partitions: {df_ppp_verify.select('_bronze_load_date').distinct().count()}")

print("\nPPP Loans Sample Records:")
display(
    df_ppp_verify.select(
        "loan_id", "borrower_name", "borrower_state",
        "loan_amount", "loan_status", "lender_name",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# Verify 7(a)/504 loans table
df_7a_verify = spark.table(TARGET_TABLES["7a_504_loans"])

print("7(a)/504 Loans Table Verification:")
print(f"  Total records: {df_7a_verify.count():,}")
print(f"  Partitions: {df_7a_verify.select('_bronze_load_date').distinct().count()}")

print("\n7(a)/504 Loans Sample Records:")
display(
    df_7a_verify.select(
        "loan_id", "program_type", "borrower_name",
        "borrower_state", "approval_amount", "loan_status",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Table Statistics

# COMMAND ----------

# PPP Loans - State distribution
print("PPP Loans - State Distribution (Top 20):")
display(
    df_ppp_verify
    .groupBy("borrower_state")
    .count()
    .orderBy(col("count").desc())
    .limit(20)
)

# COMMAND ----------

# PPP Loans - Loan Status distribution
print("PPP Loans - Loan Status Distribution:")
display(
    df_ppp_verify
    .groupBy("loan_status")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# 7(a)/504 Loans - Program Type distribution
print("7(a)/504 Loans - Program Type Distribution:")
display(
    df_7a_verify
    .groupBy("program_type")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# 7(a)/504 Loans - Loan Status distribution
print("7(a)/504 Loans - Loan Status Distribution:")
display(
    df_7a_verify
    .groupBy("loan_status")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Delta Table History

# COMMAND ----------

from delta.tables import DeltaTable

# PPP Loans history
ppp_delta = DeltaTable.forName(spark, TARGET_TABLES["ppp_loans"])

print("PPP Loans - Delta Table History:")
display(
    ppp_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# 7(a)/504 Loans history
loan_7a_delta = DeltaTable.forName(spark, TARGET_TABLES["7a_504_loans"])

print("7(a)/504 Loans - Delta Table History:")
display(
    loan_7a_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Ingestion Summary
# MAGIC
# MAGIC | Domain | Target Table | Source Format | Records | Partitioned By |
# MAGIC |--------|-------------|--------------|---------|----------------|
# MAGIC | PPP Loans | bronze_sba_ppp_loans | Parquet/CSV | See above | _bronze_load_date |
# MAGIC | 7(a)/504 Loans | bronze_sba_7a_504_loans | Parquet/CSV | See above | _bronze_load_date |
# MAGIC
# MAGIC ### Data Sources
# MAGIC - **PPP Loans:** https://data.sba.gov/dataset/ppp-foia (FOIA release)
# MAGIC - **7(a)/504 Loans:** https://data.sba.gov/dataset/7-a-504-foia (FOIA release)
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer transformation and validation.
