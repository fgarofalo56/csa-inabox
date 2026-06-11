# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: EPA Data Ingestion
# MAGIC
# MAGIC This notebook ingests raw EPA (Environmental Protection Agency) data into the Bronze layer
# MAGIC across three domains: air quality measurements, toxic release inventory, and water quality.
# MAGIC
# MAGIC ## Data Sources
# MAGIC - **Air Quality (AQS):** AQI measurements and criteria pollutant concentrations
# MAGIC - **Toxic Releases (TRI):** Toxics Release Inventory facility-level release data
# MAGIC - **Water Quality (SDWIS):** Safe Drinking Water Information System violations
# MAGIC - **Formats:** Parquet (data generator output) with CSV fallback (open data downloads)
# MAGIC
# MAGIC ## Targets
# MAGIC - **bronze_epa_air_quality** - Air quality measurement records
# MAGIC - **bronze_epa_toxic_releases** - TRI release records
# MAGIC - **bronze_epa_water_quality** - Water quality sample records
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
    BooleanType,
    DoubleType,
    IntegerType,
    StringType,
    StructField,
    StructType,
)

# Source paths - data generator parquet output (primary)
SOURCE_PATHS = {
    "air_quality": "Files/output/epa_air_quality.parquet",
    "toxic_releases": "Files/output/epa_toxic_releases.parquet",
    "water_quality": "Files/output/epa_water_quality.parquet",
}

# CSV fallback paths - open data downloads
CSV_FALLBACK_PATHS = {
    "air_quality": "Files/open_data/epa/air_quality/",
    "toxic_releases": "Files/open_data/epa/toxic_releases/",
    "water_quality": "Files/open_data/epa/water_quality/",
}

# Target Delta tables
TARGET_TABLES = {
    "air_quality": "lh_bronze.bronze_epa_air_quality",
    "toxic_releases": "lh_bronze.bronze_epa_toxic_releases",
    "water_quality": "lh_bronze.bronze_epa_water_quality",
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
# MAGIC Explicit schemas for all three EPA domains to enforce structure at ingestion.

# COMMAND ----------

# Air Quality (AQS) schema
air_quality_schema = StructType([
    StructField("measurement_id", StringType(), False),
    StructField("station_id", StringType(), False),
    StructField("parameter_name", StringType(), False),
    StructField("aqi_value", IntegerType(), True),
    StructField("concentration", DoubleType(), True),
    StructField("units", StringType(), True),
    StructField("measurement_date", StringType(), True),
    StructField("measurement_hour", IntegerType(), True),
    StructField("latitude", DoubleType(), True),
    StructField("longitude", DoubleType(), True),
    StructField("state_code", StringType(), True),
    StructField("county_code", StringType(), True),
    StructField("site_number", StringType(), True),
    StructField("category", StringType(), True),
])

print(f"Air Quality schema fields: {len(air_quality_schema.fields)}")
for field in air_quality_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# Toxic Release Inventory (TRI) schema
toxic_releases_schema = StructType([
    StructField("release_id", StringType(), False),
    StructField("facility_name", StringType(), False),
    StructField("facility_id", StringType(), False),
    StructField("street_address", StringType(), True),
    StructField("city", StringType(), True),
    StructField("state", StringType(), True),
    StructField("zip_code", StringType(), True),
    StructField("latitude", DoubleType(), True),
    StructField("longitude", DoubleType(), True),
    StructField("chemical_name", StringType(), True),
    StructField("cas_number", StringType(), True),
    StructField("total_releases_lbs", DoubleType(), True),
    StructField("air_releases", DoubleType(), True),
    StructField("water_releases", DoubleType(), True),
    StructField("land_releases", DoubleType(), True),
    StructField("reporting_year", IntegerType(), True),
    StructField("industry_sector", StringType(), True),
    StructField("naics_code", StringType(), True),
])

print(f"\nToxic Releases schema fields: {len(toxic_releases_schema.fields)}")
for field in toxic_releases_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# Water Quality (SDWIS) schema
water_quality_schema = StructType([
    StructField("sample_id", StringType(), False),
    StructField("system_id", StringType(), False),
    StructField("system_name", StringType(), True),
    StructField("state", StringType(), True),
    StructField("contaminant", StringType(), True),
    StructField("concentration", DoubleType(), True),
    StructField("mcl_violation", BooleanType(), True),
    StructField("sample_date", StringType(), True),
    StructField("source_type", StringType(), True),
])

print(f"\nWater Quality schema fields: {len(water_quality_schema.fields)}")
for field in water_quality_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - Air Quality
# MAGIC
# MAGIC Reads from parquet (data generator output) first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read air quality data: try parquet first, fallback to CSV
try:
    df_air_raw = spark.read \
        .schema(air_quality_schema) \
        .parquet(SOURCE_PATHS["air_quality"])
    air_source_format = "Parquet"
    print(f"Air Quality: loaded from Parquet ({SOURCE_PATHS['air_quality']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['air_quality']}")
    df_air_raw = spark.read \
        .schema(air_quality_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["air_quality"])
    air_source_format = "CSV"
    print(f"Air Quality: loaded from CSV")

air_record_count = df_air_raw.count()
air_column_count = len(df_air_raw.columns)

print(f"\nAir Quality Source Statistics:")
print(f"  Format: {air_source_format}")
print(f"  Records: {air_record_count:,}")
print(f"  Columns: {air_column_count}")

df_air_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - Toxic Releases
# MAGIC
# MAGIC Reads TRI data from parquet first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read toxic releases data: try parquet first, fallback to CSV
try:
    df_tri_raw = spark.read \
        .schema(toxic_releases_schema) \
        .parquet(SOURCE_PATHS["toxic_releases"])
    tri_source_format = "Parquet"
    print(f"Toxic Releases: loaded from Parquet ({SOURCE_PATHS['toxic_releases']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['toxic_releases']}")
    df_tri_raw = spark.read \
        .schema(toxic_releases_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["toxic_releases"])
    tri_source_format = "CSV"
    print(f"Toxic Releases: loaded from CSV")

tri_record_count = df_tri_raw.count()
tri_column_count = len(df_tri_raw.columns)

print(f"\nToxic Releases Source Statistics:")
print(f"  Format: {tri_source_format}")
print(f"  Records: {tri_record_count:,}")
print(f"  Columns: {tri_column_count}")

df_tri_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - Water Quality
# MAGIC
# MAGIC Reads SDWIS water quality data from parquet first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read water quality data: try parquet first, fallback to CSV
try:
    df_water_raw = spark.read \
        .schema(water_quality_schema) \
        .parquet(SOURCE_PATHS["water_quality"])
    water_source_format = "Parquet"
    print(f"Water Quality: loaded from Parquet ({SOURCE_PATHS['water_quality']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['water_quality']}")
    df_water_raw = spark.read \
        .schema(water_quality_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["water_quality"])
    water_source_format = "CSV"
    print(f"Water Quality: loaded from CSV")

water_record_count = df_water_raw.count()
water_column_count = len(df_water_raw.columns)

print(f"\nWater Quality Source Statistics:")
print(f"  Format: {water_source_format}")
print(f"  Records: {water_record_count:,}")
print(f"  Columns: {water_column_count}")

df_water_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Bronze Data Quality Checks
# MAGIC
# MAGIC Minimal validation at Bronze layer - verify critical fields are populated.

# COMMAND ----------

# Air Quality critical field null checks
air_critical_fields = ["measurement_id", "station_id", "parameter_name"]

print("Air Quality - Critical Field Null Check:")
for field in air_critical_fields:
    null_count = df_air_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# AQI category distribution check
print("\nAir Quality - AQI Category Distribution:")
aqi_categories = df_air_raw.filter(col("category").isNotNull()) \
    .groupBy("category").count().collect()
for row in aqi_categories:
    print(f"  {row['category']}: {row['count']:,}")

# Toxic Releases critical field null checks
tri_critical_fields = ["release_id", "facility_name", "facility_id"]

print("\nToxic Releases - Critical Field Null Check:")
for field in tri_critical_fields:
    null_count = df_tri_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# Water Quality critical field null checks
water_critical_fields = ["sample_id", "system_id"]

print("\nWater Quality - Critical Field Null Check:")
for field in water_critical_fields:
    null_count = df_water_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - Air Quality

# COMMAND ----------

# Add Bronze layer metadata columns to air quality
df_air_bronze = df_air_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to Air Quality:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - Toxic Releases

# COMMAND ----------

# Add Bronze layer metadata columns to toxic releases
df_tri_bronze = df_tri_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to Toxic Releases:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - Water Quality

# COMMAND ----------

# Add Bronze layer metadata columns to water quality
df_water_bronze = df_water_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to Water Quality:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - Air Quality

# COMMAND ----------

# Write air quality to Bronze Delta table
df_air_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["air_quality"])

air_final_count = spark.table(TARGET_TABLES["air_quality"]).count()
print(f"Successfully wrote {air_final_count:,} records to {TARGET_TABLES['air_quality']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - Toxic Releases

# COMMAND ----------

# Write toxic releases to Bronze Delta table
df_tri_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["toxic_releases"])

tri_final_count = df_tri_bronze.count()
print(f"Successfully wrote {tri_final_count:,} records to {TARGET_TABLES['toxic_releases']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - Water Quality

# COMMAND ----------

# Write water quality to Bronze Delta table
df_water_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["water_quality"])

water_final_count = df_water_bronze.count()
print(f"Successfully wrote {water_final_count:,} records to {TARGET_TABLES['water_quality']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Verify Ingestion

# COMMAND ----------

# Verify air quality table
df_air_verify = spark.table(TARGET_TABLES["air_quality"])

print("Air Quality Table Verification:")
print(f"  Total records: {df_air_verify.count():,}")
print(f"  Partitions: {df_air_verify.select('_bronze_load_date').distinct().count()}")

print("\nAir Quality Sample Records:")
display(
    df_air_verify.select(
        "measurement_id", "station_id", "parameter_name",
        "aqi_value", "concentration", "category",
        "latitude", "longitude", "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# Verify toxic releases table
df_tri_verify = spark.table(TARGET_TABLES["toxic_releases"])

print("Toxic Releases Table Verification:")
print(f"  Total records: {df_tri_verify.count():,}")
print(f"  Partitions: {df_tri_verify.select('_bronze_load_date').distinct().count()}")

print("\nToxic Releases Sample Records:")
display(
    df_tri_verify.select(
        "release_id", "facility_name", "chemical_name",
        "total_releases_lbs", "state", "reporting_year",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# Verify water quality table
df_water_verify = spark.table(TARGET_TABLES["water_quality"])

print("Water Quality Table Verification:")
print(f"  Total records: {df_water_verify.count():,}")
print(f"  Partitions: {df_water_verify.select('_bronze_load_date').distinct().count()}")

print("\nWater Quality Sample Records:")
display(
    df_water_verify.select(
        "sample_id", "system_id", "system_name",
        "contaminant", "concentration", "mcl_violation",
        "sample_date", "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Table Statistics

# COMMAND ----------

# Air Quality - Parameter distribution (criteria pollutants)
print("Air Quality - Parameter Distribution:")
display(
    df_air_verify
    .groupBy("parameter_name")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Air Quality - AQI Category distribution
print("Air Quality - AQI Category Distribution:")
display(
    df_air_verify
    .groupBy("category")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Toxic Releases - Top chemicals by total release volume
print("Toxic Releases - Top 20 Chemicals by Total Releases:")
display(
    df_tri_verify
    .groupBy("chemical_name")
    .agg({"total_releases_lbs": "sum", "*": "count"})
    .withColumnRenamed("sum(total_releases_lbs)", "total_lbs")
    .withColumnRenamed("count(1)", "facility_count")
    .orderBy(col("total_lbs").desc())
    .limit(20)
)

# COMMAND ----------

# Toxic Releases - State distribution
print("Toxic Releases - State Distribution (Top 20):")
display(
    df_tri_verify
    .groupBy("state")
    .count()
    .orderBy(col("count").desc())
    .limit(20)
)

# COMMAND ----------

# Water Quality - MCL Violation distribution
print("Water Quality - MCL Violation Distribution:")
display(
    df_water_verify
    .groupBy("mcl_violation")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Water Quality - Top contaminants
print("Water Quality - Top 20 Contaminants:")
display(
    df_water_verify
    .groupBy("contaminant")
    .count()
    .orderBy(col("count").desc())
    .limit(20)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Delta Table History

# COMMAND ----------

from delta.tables import DeltaTable

# Air Quality history
air_delta = DeltaTable.forName(spark, TARGET_TABLES["air_quality"])

print("Air Quality - Delta Table History:")
display(
    air_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# Toxic Releases history
tri_delta = DeltaTable.forName(spark, TARGET_TABLES["toxic_releases"])

print("Toxic Releases - Delta Table History:")
display(
    tri_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# Water Quality history
water_delta = DeltaTable.forName(spark, TARGET_TABLES["water_quality"])

print("Water Quality - Delta Table History:")
display(
    water_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Ingestion Summary
# MAGIC
# MAGIC | Domain | Target Table | Source Format | Records | Partitioned By |
# MAGIC |--------|-------------|--------------|---------|----------------|
# MAGIC | Air Quality | bronze_epa_air_quality | Parquet/CSV | See above | _bronze_load_date |
# MAGIC | Toxic Releases | bronze_epa_toxic_releases | Parquet/CSV | See above | _bronze_load_date |
# MAGIC | Water Quality | bronze_epa_water_quality | Parquet/CSV | See above | _bronze_load_date |
# MAGIC
# MAGIC ### Data Sources
# MAGIC - **Air Quality (AQS):** https://aqs.epa.gov/aqsweb/documents/data_api.html (AQS API)
# MAGIC - **Toxic Releases (TRI):** https://www.epa.gov/toxics-release-inventory-tri-program/tri-data-and-tools (TRI Explorer)
# MAGIC - **Water Quality (SDWIS):** https://www.epa.gov/ground-water-and-drinking-water/safe-drinking-water-information-system-sdwis-federal-reporting
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer transformation and validation.
