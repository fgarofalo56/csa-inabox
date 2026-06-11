# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: DOJ Data Ingestion
# MAGIC
# MAGIC This notebook ingests raw DOJ (Department of Justice) data into the Bronze layer
# MAGIC across four domains: Crime Statistics, Federal Cases, Antitrust, and Drug Enforcement.
# MAGIC
# MAGIC ## Data Sources
# MAGIC - **Crime Statistics:** FBI UCR/NIBRS crime incident data
# MAGIC - **Federal Cases:** USSC federal sentencing data
# MAGIC - **Antitrust:** DOJ Antitrust Division case and merger data
# MAGIC - **Drug Enforcement:** DEA drug seizure and operation data
# MAGIC - **Formats:** Parquet (data generator output) with CSV fallback (open data downloads)
# MAGIC
# MAGIC ## Targets
# MAGIC - **bronze_doj_crime_stats** - Crime incident records
# MAGIC - **bronze_doj_federal_cases** - Federal sentencing records
# MAGIC - **bronze_doj_antitrust** - Antitrust case and merger records
# MAGIC - **bronze_doj_drug_enforcement** - Drug seizure records
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
    "crime_stats": "Files/output/doj_crime_stats.parquet",
    "federal_cases": "Files/output/doj_federal_cases.parquet",
    "antitrust": "Files/output/doj_antitrust.parquet",
    "drug_enforcement": "Files/output/doj_drug_enforcement.parquet",
}

# CSV fallback paths - open data downloads
CSV_FALLBACK_PATHS = {
    "crime_stats": "Files/open_data/doj/crime_stats/",
    "federal_cases": "Files/open_data/doj/federal_cases/",
    "antitrust": "Files/open_data/doj/antitrust/",
    "drug_enforcement": "Files/open_data/doj/drug_enforcement/",
}

# Target Delta tables
TARGET_TABLES = {
    "crime_stats": "lh_bronze.bronze_doj_crime_stats",
    "federal_cases": "lh_bronze.bronze_doj_federal_cases",
    "antitrust": "lh_bronze.bronze_doj_antitrust",
    "drug_enforcement": "lh_bronze.bronze_doj_drug_enforcement",
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
# MAGIC Explicit schemas for all four DOJ domains to enforce structure at ingestion.

# COMMAND ----------

# Crime Statistics schema
crime_stats_schema = StructType([
    StructField("incident_id", StringType(), False),
    StructField("ori_code", StringType(), True),
    StructField("agency_name", StringType(), True),
    StructField("agency_type", StringType(), True),
    StructField("state_code", StringType(), True),
    StructField("incident_date", StringType(), True),
    StructField("offense_code", StringType(), True),
    StructField("offense_category", StringType(), True),
    StructField("offense_description", StringType(), True),
    StructField("victim_count", IntegerType(), True),
    StructField("offender_count", IntegerType(), True),
    StructField("arrest_made", StringType(), True),
    StructField("weapon_involved", StringType(), True),
    StructField("location_type", StringType(), True),
    StructField("clearance_status", StringType(), True),
    StructField("population_group", StringType(), True),
    StructField("reporting_year", IntegerType(), True),
])

print(f"Crime Statistics schema fields: {len(crime_stats_schema.fields)}")
for field in crime_stats_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# Federal Cases schema
federal_cases_schema = StructType([
    StructField("case_id", StringType(), False),
    StructField("district_court", StringType(), True),
    StructField("circuit", StringType(), True),
    StructField("filing_date", StringType(), True),
    StructField("sentencing_date", StringType(), True),
    StructField("primary_offense", StringType(), True),
    StructField("offense_category", StringType(), True),
    StructField("guideline_range_min_months", IntegerType(), True),
    StructField("guideline_range_max_months", IntegerType(), True),
    StructField("sentence_months", IntegerType(), True),
    StructField("departure_type", StringType(), True),
    StructField("fine_amount", DoubleType(), True),
    StructField("restitution_amount", DoubleType(), True),
    StructField("defendant_age", IntegerType(), True),
    StructField("defendant_gender", StringType(), True),
    StructField("defendant_race", StringType(), True),
    StructField("defendant_citizenship", StringType(), True),
    StructField("criminal_history_category", StringType(), True),
    StructField("plea_type", StringType(), True),
    StructField("trial_outcome", StringType(), True),
    StructField("fiscal_year", IntegerType(), True),
])

print(f"\nFederal Cases schema fields: {len(federal_cases_schema.fields)}")
for field in federal_cases_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# Antitrust schema
antitrust_schema = StructType([
    StructField("case_id", StringType(), False),
    StructField("case_type", StringType(), True),
    StructField("filing_date", StringType(), True),
    StructField("resolution_date", StringType(), True),
    StructField("case_status", StringType(), True),
    StructField("industry_sector", StringType(), True),
    StructField("industry_name", StringType(), True),
    StructField("acquiring_party", StringType(), True),
    StructField("target_party", StringType(), True),
    StructField("transaction_value_usd", DoubleType(), True),
    StructField("hhi_pre_merger", IntegerType(), True),
    StructField("hhi_post_merger", IntegerType(), True),
    StructField("hhi_delta", IntegerType(), True),
    StructField("market_definition", StringType(), True),
    StructField("doj_action", StringType(), True),
    StructField("penalty_amount_usd", DoubleType(), True),
    StructField("cartel_type", StringType(), True),
    StructField("affected_commerce_usd", DoubleType(), True),
    StructField("defendant_count", IntegerType(), True),
    StructField("hsr_filing_flag", StringType(), True),
    StructField("second_request_flag", StringType(), True),
    StructField("fiscal_year", IntegerType(), True),
])

print(f"\nAntitrust schema fields: {len(antitrust_schema.fields)}")
for field in antitrust_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# Drug Enforcement schema
drug_enforcement_schema = StructType([
    StructField("seizure_id", StringType(), False),
    StructField("seizure_date", StringType(), True),
    StructField("dea_region", StringType(), True),
    StructField("state_code", StringType(), True),
    StructField("drug_type", StringType(), True),
    StructField("drug_schedule", StringType(), True),
    StructField("quantity_kg", DoubleType(), True),
    StructField("estimated_street_value_usd", DoubleType(), True),
    StructField("seizure_type", StringType(), True),
    StructField("operation_name", StringType(), True),
    StructField("arrests_count", IntegerType(), True),
    StructField("fiscal_year", IntegerType(), True),
    StructField("quarter", IntegerType(), True),
])

print(f"\nDrug Enforcement schema fields: {len(drug_enforcement_schema.fields)}")
for field in drug_enforcement_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - Crime Statistics
# MAGIC
# MAGIC Reads from parquet (data generator output) first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read Crime Statistics data: try parquet first, fallback to CSV
try:
    df_crime_raw = spark.read \
        .schema(crime_stats_schema) \
        .parquet(SOURCE_PATHS["crime_stats"])
    crime_source_format = "Parquet"
    print(f"Crime Statistics: loaded from Parquet ({SOURCE_PATHS['crime_stats']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['crime_stats']}")
    df_crime_raw = spark.read \
        .schema(crime_stats_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["crime_stats"])
    crime_source_format = "CSV"
    print(f"Crime Statistics: loaded from CSV")

crime_record_count = df_crime_raw.count()
crime_column_count = len(df_crime_raw.columns)

print(f"\nCrime Statistics Source Statistics:")
print(f"  Format: {crime_source_format}")
print(f"  Records: {crime_record_count:,}")
print(f"  Columns: {crime_column_count}")

df_crime_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - Federal Cases
# MAGIC
# MAGIC Reads USSC federal sentencing data from parquet first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read Federal Cases data: try parquet first, fallback to CSV
try:
    df_federal_raw = spark.read \
        .schema(federal_cases_schema) \
        .parquet(SOURCE_PATHS["federal_cases"])
    federal_source_format = "Parquet"
    print(f"Federal Cases: loaded from Parquet ({SOURCE_PATHS['federal_cases']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['federal_cases']}")
    df_federal_raw = spark.read \
        .schema(federal_cases_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["federal_cases"])
    federal_source_format = "CSV"
    print(f"Federal Cases: loaded from CSV")

federal_record_count = df_federal_raw.count()
federal_column_count = len(df_federal_raw.columns)

print(f"\nFederal Cases Source Statistics:")
print(f"  Format: {federal_source_format}")
print(f"  Records: {federal_record_count:,}")
print(f"  Columns: {federal_column_count}")

df_federal_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - Antitrust
# MAGIC
# MAGIC Reads DOJ Antitrust Division data from parquet first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read Antitrust data: try parquet first, fallback to CSV
try:
    df_antitrust_raw = spark.read \
        .schema(antitrust_schema) \
        .parquet(SOURCE_PATHS["antitrust"])
    antitrust_source_format = "Parquet"
    print(f"Antitrust: loaded from Parquet ({SOURCE_PATHS['antitrust']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['antitrust']}")
    df_antitrust_raw = spark.read \
        .schema(antitrust_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["antitrust"])
    antitrust_source_format = "CSV"
    print(f"Antitrust: loaded from CSV")

antitrust_record_count = df_antitrust_raw.count()
antitrust_column_count = len(df_antitrust_raw.columns)

print(f"\nAntitrust Source Statistics:")
print(f"  Format: {antitrust_source_format}")
print(f"  Records: {antitrust_record_count:,}")
print(f"  Columns: {antitrust_column_count}")

df_antitrust_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - Drug Enforcement
# MAGIC
# MAGIC Reads DEA seizure data from parquet first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read Drug Enforcement data: try parquet first, fallback to CSV
try:
    df_drug_raw = spark.read \
        .schema(drug_enforcement_schema) \
        .parquet(SOURCE_PATHS["drug_enforcement"])
    drug_source_format = "Parquet"
    print(f"Drug Enforcement: loaded from Parquet ({SOURCE_PATHS['drug_enforcement']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['drug_enforcement']}")
    df_drug_raw = spark.read \
        .schema(drug_enforcement_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["drug_enforcement"])
    drug_source_format = "CSV"
    print(f"Drug Enforcement: loaded from CSV")

drug_record_count = df_drug_raw.count()
drug_column_count = len(df_drug_raw.columns)

print(f"\nDrug Enforcement Source Statistics:")
print(f"  Format: {drug_source_format}")
print(f"  Records: {drug_record_count:,}")
print(f"  Columns: {drug_column_count}")

df_drug_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Bronze Data Quality Checks
# MAGIC
# MAGIC Minimal validation at Bronze layer - verify critical fields are populated.

# COMMAND ----------

# Crime Statistics critical field null checks
crime_critical_fields = ["incident_id", "agency_name", "incident_date"]

print("Crime Statistics - Critical Field Null Check:")
for field in crime_critical_fields:
    null_count = df_crime_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# Federal Cases critical field null checks
federal_critical_fields = ["case_id", "district_court", "primary_offense"]

print("\nFederal Cases - Critical Field Null Check:")
for field in federal_critical_fields:
    null_count = df_federal_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# Antitrust critical field null checks
antitrust_critical_fields = ["case_id", "case_type", "industry_sector"]

print("\nAntitrust - Critical Field Null Check:")
for field in antitrust_critical_fields:
    null_count = df_antitrust_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# Drug Enforcement critical field null checks
drug_critical_fields = ["seizure_id", "drug_type", "seizure_date"]

print("\nDrug Enforcement - Critical Field Null Check:")
for field in drug_critical_fields:
    null_count = df_drug_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - Crime Statistics

# COMMAND ----------

# Add Bronze layer metadata columns to Crime Statistics
df_crime_bronze = df_crime_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to Crime Statistics:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - Federal Cases

# COMMAND ----------

# Add Bronze layer metadata columns to Federal Cases
df_federal_bronze = df_federal_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to Federal Cases:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - Antitrust

# COMMAND ----------

# Add Bronze layer metadata columns to Antitrust
df_antitrust_bronze = df_antitrust_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to Antitrust:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - Drug Enforcement

# COMMAND ----------

# Add Bronze layer metadata columns to Drug Enforcement
df_drug_bronze = df_drug_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to Drug Enforcement:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - Crime Statistics

# COMMAND ----------

# Write Crime Statistics to Bronze Delta table
df_crime_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["crime_stats"])

crime_final_count = spark.table(TARGET_TABLES["crime_stats"]).count()
print(f"Successfully wrote {crime_final_count:,} records to {TARGET_TABLES['crime_stats']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - Federal Cases

# COMMAND ----------

# Write Federal Cases to Bronze Delta table
df_federal_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["federal_cases"])

federal_final_count = df_federal_bronze.count()
print(f"Successfully wrote {federal_final_count:,} records to {TARGET_TABLES['federal_cases']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - Antitrust

# COMMAND ----------

# Write Antitrust to Bronze Delta table
df_antitrust_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["antitrust"])

antitrust_final_count = df_antitrust_bronze.count()
print(f"Successfully wrote {antitrust_final_count:,} records to {TARGET_TABLES['antitrust']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - Drug Enforcement

# COMMAND ----------

# Write Drug Enforcement to Bronze Delta table
df_drug_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["drug_enforcement"])

drug_final_count = df_drug_bronze.count()
print(f"Successfully wrote {drug_final_count:,} records to {TARGET_TABLES['drug_enforcement']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Verify Ingestion

# COMMAND ----------

# Verify Crime Statistics table
df_crime_verify = spark.table(TARGET_TABLES["crime_stats"])

print("Crime Statistics Table Verification:")
print(f"  Total records: {df_crime_verify.count():,}")
print(f"  Partitions: {df_crime_verify.select('_bronze_load_date').distinct().count()}")

print("\nCrime Statistics Sample Records:")
display(
    df_crime_verify.select(
        "incident_id", "agency_name", "state_code",
        "offense_category", "victim_count", "arrest_made",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# Verify Federal Cases table
df_federal_verify = spark.table(TARGET_TABLES["federal_cases"])

print("Federal Cases Table Verification:")
print(f"  Total records: {df_federal_verify.count():,}")
print(f"  Partitions: {df_federal_verify.select('_bronze_load_date').distinct().count()}")

print("\nFederal Cases Sample Records:")
display(
    df_federal_verify.select(
        "case_id", "district_court", "primary_offense",
        "sentence_months", "defendant_age", "trial_outcome",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# Verify Antitrust table
df_antitrust_verify = spark.table(TARGET_TABLES["antitrust"])

print("Antitrust Table Verification:")
print(f"  Total records: {df_antitrust_verify.count():,}")
print(f"  Partitions: {df_antitrust_verify.select('_bronze_load_date').distinct().count()}")

print("\nAntitrust Sample Records:")
display(
    df_antitrust_verify.select(
        "case_id", "case_type", "industry_sector",
        "transaction_value_usd", "doj_action", "penalty_amount_usd",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# Verify Drug Enforcement table
df_drug_verify = spark.table(TARGET_TABLES["drug_enforcement"])

print("Drug Enforcement Table Verification:")
print(f"  Total records: {df_drug_verify.count():,}")
print(f"  Partitions: {df_drug_verify.select('_bronze_load_date').distinct().count()}")

print("\nDrug Enforcement Sample Records:")
display(
    df_drug_verify.select(
        "seizure_id", "drug_type", "drug_schedule",
        "quantity_kg", "estimated_street_value_usd", "arrests_count",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Table Statistics

# COMMAND ----------

# Crime Statistics - State distribution
print("Crime Statistics - State Distribution (Top 20):")
display(
    df_crime_verify
    .groupBy("state_code")
    .count()
    .orderBy(col("count").desc())
    .limit(20)
)

# COMMAND ----------

# Crime Statistics - Offense Category distribution
print("Crime Statistics - Offense Category Distribution:")
display(
    df_crime_verify
    .groupBy("offense_category")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Federal Cases - District Court distribution
print("Federal Cases - District Court Distribution (Top 20):")
display(
    df_federal_verify
    .groupBy("district_court")
    .count()
    .orderBy(col("count").desc())
    .limit(20)
)

# COMMAND ----------

# Federal Cases - Offense Category distribution
print("Federal Cases - Offense Category Distribution:")
display(
    df_federal_verify
    .groupBy("offense_category")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Antitrust - Case Type distribution
print("Antitrust - Case Type Distribution:")
display(
    df_antitrust_verify
    .groupBy("case_type")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Drug Enforcement - Drug Type distribution
print("Drug Enforcement - Drug Type Distribution:")
display(
    df_drug_verify
    .groupBy("drug_type")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Delta Table History

# COMMAND ----------

from delta.tables import DeltaTable

# Crime Statistics history
crime_delta = DeltaTable.forName(spark, TARGET_TABLES["crime_stats"])

print("Crime Statistics - Delta Table History:")
display(
    crime_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# Federal Cases history
federal_delta = DeltaTable.forName(spark, TARGET_TABLES["federal_cases"])

print("Federal Cases - Delta Table History:")
display(
    federal_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# Antitrust history
antitrust_delta = DeltaTable.forName(spark, TARGET_TABLES["antitrust"])

print("Antitrust - Delta Table History:")
display(
    antitrust_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# Drug Enforcement history
drug_delta = DeltaTable.forName(spark, TARGET_TABLES["drug_enforcement"])

print("Drug Enforcement - Delta Table History:")
display(
    drug_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Ingestion Summary
# MAGIC
# MAGIC | Domain | Target Table | Source Format | Records | Partitioned By |
# MAGIC |--------|-------------|--------------|---------|----------------|
# MAGIC | Crime Statistics | bronze_doj_crime_stats | Parquet/CSV | See above | _bronze_load_date |
# MAGIC | Federal Cases | bronze_doj_federal_cases | Parquet/CSV | See above | _bronze_load_date |
# MAGIC | Antitrust | bronze_doj_antitrust | Parquet/CSV | See above | _bronze_load_date |
# MAGIC | Drug Enforcement | bronze_doj_drug_enforcement | Parquet/CSV | See above | _bronze_load_date |
# MAGIC
# MAGIC ### Data Sources
# MAGIC - **Crime Statistics:** https://crime-data-explorer.app.cloud.gov/pages/downloads (FBI UCR/NIBRS)
# MAGIC - **Federal Cases:** https://www.ussc.gov/research/datafiles/commission-datafiles (USSC)
# MAGIC - **Antitrust:** https://www.justice.gov/atr/public/criminal.html (DOJ Antitrust Division)
# MAGIC - **Drug Enforcement:** https://www.dea.gov/data-and-statistics (DEA)
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer transformation and validation.
