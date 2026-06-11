# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: USDA Data Ingestion
# MAGIC
# MAGIC This notebook ingests raw USDA data into the Bronze layer across two domains:
# MAGIC crop production statistics and food safety recall records.
# MAGIC
# MAGIC ## Data Sources
# MAGIC - **Crop Production (NASS QuickStats):** Annual/monthly crop statistics by state and county
# MAGIC - **Food Safety (FSIS Recalls):** USDA FSIS recall cases with risk classification
# MAGIC - **Formats:** Parquet (data generator output) with CSV fallback (open data downloads)
# MAGIC
# MAGIC ## Targets
# MAGIC - **bronze_usda_crop_production** - NASS crop production records
# MAGIC - **bronze_usda_food_safety** - FSIS food safety recall records
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
    "crop_production": "Files/output/usda_crop_production.parquet",
    "food_safety": "Files/output/usda_food_safety.parquet",
}

# CSV fallback paths - open data downloads
CSV_FALLBACK_PATHS = {
    "crop_production": "Files/open_data/usda/crop_production/",
    "food_safety": "Files/open_data/usda/food_safety/",
}

# Target Delta tables
TARGET_TABLES = {
    "crop_production": "lh_bronze.bronze_usda_crop_production",
    "food_safety": "lh_bronze.bronze_usda_food_safety",
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
# MAGIC Explicit schemas for both USDA domains to enforce structure at ingestion.

# COMMAND ----------

# NASS QuickStats - Crop Production schema
crop_production_schema = StructType([
    StructField("commodity", StringType(), False),
    StructField("year", IntegerType(), False),
    StructField("state_fips", StringType(), False),
    StructField("state_name", StringType(), False),
    StructField("county_fips", StringType(), True),
    StructField("county_name", StringType(), True),
    StructField("statisticcat_desc", StringType(), True),
    StructField("unit_desc", StringType(), True),
    StructField("value", DoubleType(), True),
    StructField("cv_percent", DoubleType(), True),
    StructField("source_desc", StringType(), True),
    StructField("agg_level_desc", StringType(), True),
    StructField("domain_desc", StringType(), True),
    StructField("reference_period_desc", StringType(), True),
])

print(f"Crop Production schema fields: {len(crop_production_schema.fields)}")
for field in crop_production_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# FSIS Recalls - Food Safety schema
food_safety_schema = StructType([
    StructField("recall_id", StringType(), False),
    StructField("recall_number", StringType(), False),
    StructField("recall_date", StringType(), False),
    StructField("product_type", StringType(), True),
    StructField("recall_class", StringType(), True),
    StructField("reason", StringType(), True),
    StructField("risk_level", StringType(), True),
    StructField("company_name", StringType(), True),
    StructField("establishment_number", StringType(), True),
    StructField("city", StringType(), True),
    StructField("state", StringType(), True),
    StructField("pounds_recalled", DoubleType(), True),
    StructField("distribution", StringType(), True),
    StructField("status", StringType(), True),
])

print(f"\nFood Safety schema fields: {len(food_safety_schema.fields)}")
for field in food_safety_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - Crop Production
# MAGIC
# MAGIC Reads from parquet (data generator output) first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read crop production data: try parquet first, fallback to CSV
try:
    df_crop_raw = spark.read \
        .schema(crop_production_schema) \
        .parquet(SOURCE_PATHS["crop_production"])
    crop_source_format = "Parquet"
    print(f"Crop Production: loaded from Parquet ({SOURCE_PATHS['crop_production']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['crop_production']}")
    df_crop_raw = spark.read \
        .schema(crop_production_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["crop_production"])
    crop_source_format = "CSV"
    print(f"Crop Production: loaded from CSV")

crop_record_count = df_crop_raw.count()
crop_column_count = len(df_crop_raw.columns)

print(f"\nCrop Production Source Statistics:")
print(f"  Format: {crop_source_format}")
print(f"  Records: {crop_record_count:,}")
print(f"  Columns: {crop_column_count}")

df_crop_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - Food Safety
# MAGIC
# MAGIC Reads FSIS recall data from parquet first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read food safety data: try parquet first, fallback to CSV
try:
    df_safety_raw = spark.read \
        .schema(food_safety_schema) \
        .parquet(SOURCE_PATHS["food_safety"])
    safety_source_format = "Parquet"
    print(f"Food Safety: loaded from Parquet ({SOURCE_PATHS['food_safety']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['food_safety']}")
    df_safety_raw = spark.read \
        .schema(food_safety_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["food_safety"])
    safety_source_format = "CSV"
    print(f"Food Safety: loaded from CSV")

safety_record_count = df_safety_raw.count()
safety_column_count = len(df_safety_raw.columns)

print(f"\nFood Safety Source Statistics:")
print(f"  Format: {safety_source_format}")
print(f"  Records: {safety_record_count:,}")
print(f"  Columns: {safety_column_count}")

df_safety_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Bronze Data Quality Checks
# MAGIC
# MAGIC Minimal validation at Bronze layer - verify critical fields are populated.

# COMMAND ----------

# Crop Production critical field null checks
crop_critical_fields = ["commodity", "year", "state_fips", "state_name"]

print("Crop Production - Critical Field Null Check:")
for field in crop_critical_fields:
    null_count = df_crop_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# Food Safety critical field null checks
safety_critical_fields = ["recall_id", "recall_number", "recall_date"]

print("\nFood Safety - Critical Field Null Check:")
for field in safety_critical_fields:
    null_count = df_safety_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - Crop Production

# COMMAND ----------

# Add Bronze layer metadata columns to crop production
df_crop_bronze = df_crop_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to Crop Production:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - Food Safety

# COMMAND ----------

# Add Bronze layer metadata columns to food safety
df_safety_bronze = df_safety_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to Food Safety:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - Crop Production

# COMMAND ----------

# Write crop production to Bronze Delta table
df_crop_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["crop_production"])

crop_final_count = spark.table(TARGET_TABLES["crop_production"]).count()
print(f"Successfully wrote {crop_final_count:,} records to {TARGET_TABLES['crop_production']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - Food Safety

# COMMAND ----------

# Write food safety to Bronze Delta table
df_safety_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["food_safety"])

safety_final_count = df_safety_bronze.count()
print(f"Successfully wrote {safety_final_count:,} records to {TARGET_TABLES['food_safety']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Verify Ingestion

# COMMAND ----------

# Verify crop production table
df_crop_verify = spark.table(TARGET_TABLES["crop_production"])

print("Crop Production Table Verification:")
print(f"  Total records: {df_crop_verify.count():,}")
print(f"  Partitions: {df_crop_verify.select('_bronze_load_date').distinct().count()}")

print("\nCrop Production Sample Records:")
display(
    df_crop_verify.select(
        "commodity", "year", "state_name",
        "statisticcat_desc", "value", "unit_desc",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# Verify food safety table
df_safety_verify = spark.table(TARGET_TABLES["food_safety"])

print("Food Safety Table Verification:")
print(f"  Total records: {df_safety_verify.count():,}")
print(f"  Partitions: {df_safety_verify.select('_bronze_load_date').distinct().count()}")

print("\nFood Safety Sample Records:")
display(
    df_safety_verify.select(
        "recall_id", "recall_number", "recall_date",
        "product_type", "recall_class", "risk_level",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Table Statistics

# COMMAND ----------

# Crop Production - Commodity distribution
print("Crop Production - Commodity Distribution:")
display(
    df_crop_verify
    .groupBy("commodity")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Crop Production - State distribution
print("Crop Production - State Distribution (Top 20):")
display(
    df_crop_verify
    .groupBy("state_name")
    .count()
    .orderBy(col("count").desc())
    .limit(20)
)

# COMMAND ----------

# Food Safety - Recall Class distribution
print("Food Safety - Recall Class Distribution:")
display(
    df_safety_verify
    .groupBy("recall_class")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Food Safety - Risk Level distribution
print("Food Safety - Risk Level Distribution:")
display(
    df_safety_verify
    .groupBy("risk_level")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Delta Table History

# COMMAND ----------

from delta.tables import DeltaTable

# Crop Production history
crop_delta = DeltaTable.forName(spark, TARGET_TABLES["crop_production"])

print("Crop Production - Delta Table History:")
display(
    crop_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# Food Safety history
safety_delta = DeltaTable.forName(spark, TARGET_TABLES["food_safety"])

print("Food Safety - Delta Table History:")
display(
    safety_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Ingestion Summary
# MAGIC
# MAGIC | Domain | Target Table | Source Format | Records | Partitioned By |
# MAGIC |--------|-------------|--------------|---------|----------------|
# MAGIC | Crop Production | bronze_usda_crop_production | Parquet/CSV | See above | _bronze_load_date |
# MAGIC | Food Safety | bronze_usda_food_safety | Parquet/CSV | See above | _bronze_load_date |
# MAGIC
# MAGIC ### Data Sources
# MAGIC - **NASS QuickStats:** https://quickstats.nass.usda.gov/api (API key required)
# MAGIC - **FSIS Recalls:** https://www.fsis.usda.gov/recalls (no API key required)
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer transformation and validation.
