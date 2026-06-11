# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: DOI Data Ingestion
# MAGIC
# MAGIC This notebook ingests raw DOI (Department of the Interior) data into the Bronze layer
# MAGIC across three domains: USGS earthquakes, NWIS water data, and NPS park visitation.
# MAGIC
# MAGIC ## Data Sources
# MAGIC - **Earthquakes (USGS):** Real-time and historical earthquake event records
# MAGIC - **Water Data (NWIS):** National Water Information System streamflow and groundwater measurements
# MAGIC - **Park Visitation (NPS):** National Park Service monthly visitation statistics
# MAGIC - **Formats:** Parquet (data generator output) with CSV fallback (open data downloads)
# MAGIC
# MAGIC ## Targets
# MAGIC - **bronze_doi_earthquakes** - USGS earthquake event records
# MAGIC - **bronze_doi_water_data** - NWIS water measurement records
# MAGIC - **bronze_doi_park_visitation** - NPS park visitation records
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
    LongType,
    StringType,
    StructField,
    StructType,
)

# Source paths - data generator parquet output (primary)
SOURCE_PATHS = {
    "earthquakes": "Files/output/doi_earthquakes.parquet",
    "water_data": "Files/output/doi_water_data.parquet",
    "park_visitation": "Files/output/doi_park_visitation.parquet",
}

# CSV fallback paths - open data downloads
CSV_FALLBACK_PATHS = {
    "earthquakes": "Files/open_data/doi/earthquakes/",
    "water_data": "Files/open_data/doi/water_data/",
    "park_visitation": "Files/open_data/doi/park_visitation/",
}

# Target Delta tables
TARGET_TABLES = {
    "earthquakes": "lh_bronze.bronze_doi_earthquakes",
    "water_data": "lh_bronze.bronze_doi_water_data",
    "park_visitation": "lh_bronze.bronze_doi_park_visitation",
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
# MAGIC Explicit schemas for all three DOI domains to enforce structure at ingestion.
# MAGIC Includes geospatial fields (latitude/longitude) for earthquake and water data.

# COMMAND ----------

# Earthquakes (USGS) schema
earthquake_schema = StructType([
    StructField("event_id", StringType(), False),
    StructField("time", StringType(), False),
    StructField("latitude", DoubleType(), True),
    StructField("longitude", DoubleType(), True),
    StructField("depth_km", DoubleType(), True),
    StructField("magnitude", DoubleType(), True),
    StructField("magnitude_type", StringType(), True),
    StructField("place", StringType(), True),
    StructField("tsunami_flag", IntegerType(), True),
    StructField("felt_reports", IntegerType(), True),
    StructField("cdi", DoubleType(), True),
    StructField("mmi", DoubleType(), True),
    StructField("alert_level", StringType(), True),
    StructField("event_type", StringType(), True),
    StructField("status", StringType(), True),
])

print(f"Earthquakes schema fields: {len(earthquake_schema.fields)}")
for field in earthquake_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# Water Data (NWIS) schema
water_data_schema = StructType([
    StructField("site_id", StringType(), False),
    StructField("site_name", StringType(), True),
    StructField("latitude", DoubleType(), True),
    StructField("longitude", DoubleType(), True),
    StructField("state_code", StringType(), True),
    StructField("measurement_date", StringType(), False),
    StructField("parameter_code", StringType(), True),
    StructField("parameter_name", StringType(), True),
    StructField("value", DoubleType(), True),
    StructField("unit", StringType(), True),
    StructField("qualification_code", StringType(), True),
])

print(f"\nWater Data schema fields: {len(water_data_schema.fields)}")
for field in water_data_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# Park Visitation (NPS) schema
park_visitation_schema = StructType([
    StructField("park_code", StringType(), False),
    StructField("park_name", StringType(), False),
    StructField("year", IntegerType(), False),
    StructField("month", IntegerType(), True),
    StructField("recreation_visitors", LongType(), True),
    StructField("non_recreation_visitors", LongType(), True),
    StructField("total_visitors", LongType(), True),
    StructField("camping_visitors", LongType(), True),
    StructField("backcountry_campers", LongType(), True),
    StructField("region", StringType(), True),
])

print(f"\nPark Visitation schema fields: {len(park_visitation_schema.fields)}")
for field in park_visitation_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - Earthquakes
# MAGIC
# MAGIC Reads from parquet (data generator output) first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read earthquake data: try parquet first, fallback to CSV
try:
    df_quake_raw = spark.read \
        .schema(earthquake_schema) \
        .parquet(SOURCE_PATHS["earthquakes"])
    quake_source_format = "Parquet"
    print(f"Earthquakes: loaded from Parquet ({SOURCE_PATHS['earthquakes']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['earthquakes']}")
    df_quake_raw = spark.read \
        .schema(earthquake_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["earthquakes"])
    quake_source_format = "CSV"
    print(f"Earthquakes: loaded from CSV")

quake_record_count = df_quake_raw.count()
quake_column_count = len(df_quake_raw.columns)

print(f"\nEarthquakes Source Statistics:")
print(f"  Format: {quake_source_format}")
print(f"  Records: {quake_record_count:,}")
print(f"  Columns: {quake_column_count}")

df_quake_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - Water Data
# MAGIC
# MAGIC Reads NWIS water measurement data from parquet first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read water data: try parquet first, fallback to CSV
try:
    df_water_raw = spark.read \
        .schema(water_data_schema) \
        .parquet(SOURCE_PATHS["water_data"])
    water_source_format = "Parquet"
    print(f"Water Data: loaded from Parquet ({SOURCE_PATHS['water_data']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['water_data']}")
    df_water_raw = spark.read \
        .schema(water_data_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["water_data"])
    water_source_format = "CSV"
    print(f"Water Data: loaded from CSV")

water_record_count = df_water_raw.count()
water_column_count = len(df_water_raw.columns)

print(f"\nWater Data Source Statistics:")
print(f"  Format: {water_source_format}")
print(f"  Records: {water_record_count:,}")
print(f"  Columns: {water_column_count}")

df_water_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - Park Visitation
# MAGIC
# MAGIC Reads NPS park visitation data from parquet first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read park visitation data: try parquet first, fallback to CSV
try:
    df_park_raw = spark.read \
        .schema(park_visitation_schema) \
        .parquet(SOURCE_PATHS["park_visitation"])
    park_source_format = "Parquet"
    print(f"Park Visitation: loaded from Parquet ({SOURCE_PATHS['park_visitation']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['park_visitation']}")
    df_park_raw = spark.read \
        .schema(park_visitation_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["park_visitation"])
    park_source_format = "CSV"
    print(f"Park Visitation: loaded from CSV")

park_record_count = df_park_raw.count()
park_column_count = len(df_park_raw.columns)

print(f"\nPark Visitation Source Statistics:")
print(f"  Format: {park_source_format}")
print(f"  Records: {park_record_count:,}")
print(f"  Columns: {park_column_count}")

df_park_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Bronze Data Quality Checks
# MAGIC
# MAGIC Minimal validation at Bronze layer - verify critical fields are populated.
# MAGIC Includes geospatial coordinate range validation for earthquake and water data.

# COMMAND ----------

# Earthquakes critical field null checks
quake_critical_fields = ["event_id", "time"]

print("Earthquakes - Critical Field Null Check:")
for field in quake_critical_fields:
    null_count = df_quake_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# Geospatial coordinate range check for earthquakes
lat_out_of_range = df_quake_raw.filter(
    (col("latitude").isNotNull()) &
    ((col("latitude") < -90) | (col("latitude") > 90))
).count()
lon_out_of_range = df_quake_raw.filter(
    (col("longitude").isNotNull()) &
    ((col("longitude") < -180) | (col("longitude") > 180))
).count()
print(f"  latitude out of range [-90, 90]: {'PASS' if lat_out_of_range == 0 else f'WARN: {lat_out_of_range:,}'}")
print(f"  longitude out of range [-180, 180]: {'PASS' if lon_out_of_range == 0 else f'WARN: {lon_out_of_range:,}'}")

# Magnitude sanity check
neg_magnitude = df_quake_raw.filter(
    (col("magnitude").isNotNull()) & (col("magnitude") < -2)
).count()
print(f"  magnitude < -2 (sanity check): {'PASS' if neg_magnitude == 0 else f'WARN: {neg_magnitude:,}'}")

# Water Data critical field null checks
water_critical_fields = ["site_id", "measurement_date"]

print("\nWater Data - Critical Field Null Check:")
for field in water_critical_fields:
    null_count = df_water_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# Geospatial coordinate range check for water data
lat_out_of_range_w = df_water_raw.filter(
    (col("latitude").isNotNull()) &
    ((col("latitude") < -90) | (col("latitude") > 90))
).count()
lon_out_of_range_w = df_water_raw.filter(
    (col("longitude").isNotNull()) &
    ((col("longitude") < -180) | (col("longitude") > 180))
).count()
print(f"  latitude out of range [-90, 90]: {'PASS' if lat_out_of_range_w == 0 else f'WARN: {lat_out_of_range_w:,}'}")
print(f"  longitude out of range [-180, 180]: {'PASS' if lon_out_of_range_w == 0 else f'WARN: {lon_out_of_range_w:,}'}")

# Park Visitation critical field null checks
park_critical_fields = ["park_code", "park_name", "year"]

print("\nPark Visitation - Critical Field Null Check:")
for field in park_critical_fields:
    null_count = df_park_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - Earthquakes

# COMMAND ----------

# Add Bronze layer metadata columns to earthquakes
df_quake_bronze = df_quake_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to Earthquakes:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - Water Data

# COMMAND ----------

# Add Bronze layer metadata columns to water data
df_water_bronze = df_water_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to Water Data:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - Park Visitation

# COMMAND ----------

# Add Bronze layer metadata columns to park visitation
df_park_bronze = df_park_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to Park Visitation:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - Earthquakes

# COMMAND ----------

# Write earthquakes to Bronze Delta table
df_quake_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["earthquakes"])

quake_final_count = spark.table(TARGET_TABLES["earthquakes"]).count()
print(f"Successfully wrote {quake_final_count:,} records to {TARGET_TABLES['earthquakes']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - Water Data

# COMMAND ----------

# Write water data to Bronze Delta table
df_water_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["water_data"])

water_final_count = df_water_bronze.count()
print(f"Successfully wrote {water_final_count:,} records to {TARGET_TABLES['water_data']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - Park Visitation

# COMMAND ----------

# Write park visitation to Bronze Delta table
df_park_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["park_visitation"])

park_final_count = df_park_bronze.count()
print(f"Successfully wrote {park_final_count:,} records to {TARGET_TABLES['park_visitation']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Verify Ingestion

# COMMAND ----------

# Verify earthquakes table
df_quake_verify = spark.table(TARGET_TABLES["earthquakes"])

print("Earthquakes Table Verification:")
print(f"  Total records: {df_quake_verify.count():,}")
print(f"  Partitions: {df_quake_verify.select('_bronze_load_date').distinct().count()}")

print("\nEarthquakes Sample Records:")
display(
    df_quake_verify.select(
        "event_id", "time", "latitude", "longitude",
        "depth_km", "magnitude", "place",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# Verify water data table
df_water_verify = spark.table(TARGET_TABLES["water_data"])

print("Water Data Table Verification:")
print(f"  Total records: {df_water_verify.count():,}")
print(f"  Partitions: {df_water_verify.select('_bronze_load_date').distinct().count()}")

print("\nWater Data Sample Records:")
display(
    df_water_verify.select(
        "site_id", "site_name", "measurement_date",
        "parameter_name", "value", "unit",
        "latitude", "longitude", "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# Verify park visitation table
df_park_verify = spark.table(TARGET_TABLES["park_visitation"])

print("Park Visitation Table Verification:")
print(f"  Total records: {df_park_verify.count():,}")
print(f"  Partitions: {df_park_verify.select('_bronze_load_date').distinct().count()}")

print("\nPark Visitation Sample Records:")
display(
    df_park_verify.select(
        "park_code", "park_name", "year", "month",
        "recreation_visitors", "total_visitors", "region",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Table Statistics

# COMMAND ----------

# Earthquakes - Magnitude distribution
print("Earthquakes - Magnitude Type Distribution:")
display(
    df_quake_verify
    .groupBy("magnitude_type")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Earthquakes - Alert Level distribution
print("Earthquakes - Alert Level Distribution:")
display(
    df_quake_verify
    .filter(col("alert_level").isNotNull())
    .groupBy("alert_level")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Earthquakes - Event Type distribution
print("Earthquakes - Event Type Distribution:")
display(
    df_quake_verify
    .groupBy("event_type")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Water Data - Parameter distribution
print("Water Data - Parameter Distribution (Top 20):")
display(
    df_water_verify
    .groupBy("parameter_name")
    .count()
    .orderBy(col("count").desc())
    .limit(20)
)

# COMMAND ----------

# Water Data - State distribution
print("Water Data - State Distribution (Top 20):")
display(
    df_water_verify
    .groupBy("state_code")
    .count()
    .orderBy(col("count").desc())
    .limit(20)
)

# COMMAND ----------

# Park Visitation - Top parks by total visitors
print("Park Visitation - Top 20 Parks by Total Visitors:")
display(
    df_park_verify
    .groupBy("park_code", "park_name")
    .agg({"total_visitors": "sum"})
    .withColumnRenamed("sum(total_visitors)", "total_visitors_sum")
    .orderBy(col("total_visitors_sum").desc())
    .limit(20)
)

# COMMAND ----------

# Park Visitation - Region distribution
print("Park Visitation - Region Distribution:")
display(
    df_park_verify
    .groupBy("region")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Geospatial Data Summary
# MAGIC
# MAGIC Coordinate coverage for earthquakes and water data (lat/lon fields).

# COMMAND ----------

from pyspark.sql.functions import avg as spark_avg
from pyspark.sql.functions import count as spark_count
from pyspark.sql.functions import max as spark_max
from pyspark.sql.functions import min as spark_min

# Geospatial coverage statistics for earthquakes
quake_geo_stats = df_quake_verify.select(
    spark_count(col("latitude")).alias("lat_non_null"),
    spark_min(col("latitude")).alias("lat_min"),
    spark_max(col("latitude")).alias("lat_max"),
    spark_avg(col("latitude")).alias("lat_avg"),
    spark_count(col("longitude")).alias("lon_non_null"),
    spark_min(col("longitude")).alias("lon_min"),
    spark_max(col("longitude")).alias("lon_max"),
    spark_avg(col("longitude")).alias("lon_avg"),
)

print("Earthquakes - Geospatial Coverage:")
display(quake_geo_stats)

# COMMAND ----------

# Geospatial coverage statistics for water data
water_geo_stats = df_water_verify.select(
    spark_count(col("latitude")).alias("lat_non_null"),
    spark_min(col("latitude")).alias("lat_min"),
    spark_max(col("latitude")).alias("lat_max"),
    spark_avg(col("latitude")).alias("lat_avg"),
    spark_count(col("longitude")).alias("lon_non_null"),
    spark_min(col("longitude")).alias("lon_min"),
    spark_max(col("longitude")).alias("lon_max"),
    spark_avg(col("longitude")).alias("lon_avg"),
)

print("Water Data - Geospatial Coverage:")
display(water_geo_stats)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Delta Table History

# COMMAND ----------

from delta.tables import DeltaTable

# Earthquakes history
quake_delta = DeltaTable.forName(spark, TARGET_TABLES["earthquakes"])

print("Earthquakes - Delta Table History:")
display(
    quake_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# Water Data history
water_delta = DeltaTable.forName(spark, TARGET_TABLES["water_data"])

print("Water Data - Delta Table History:")
display(
    water_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# Park Visitation history
park_delta = DeltaTable.forName(spark, TARGET_TABLES["park_visitation"])

print("Park Visitation - Delta Table History:")
display(
    park_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Ingestion Summary
# MAGIC
# MAGIC | Domain | Target Table | Source Format | Records | Partitioned By |
# MAGIC |--------|-------------|--------------|---------|----------------|
# MAGIC | Earthquakes (USGS) | bronze_doi_earthquakes | Parquet/CSV | See above | _bronze_load_date |
# MAGIC | Water Data (NWIS) | bronze_doi_water_data | Parquet/CSV | See above | _bronze_load_date |
# MAGIC | Park Visitation (NPS) | bronze_doi_park_visitation | Parquet/CSV | See above | _bronze_load_date |
# MAGIC
# MAGIC ### Data Sources
# MAGIC - **Earthquakes (USGS):** https://earthquake.usgs.gov/fdsnws/event/1/ (FDSN Event Web Service)
# MAGIC - **Water Data (NWIS):** https://waterservices.usgs.gov/ (USGS Water Services)
# MAGIC - **Park Visitation (NPS):** https://irma.nps.gov/STATS/ (NPS Integrated Resource Management Applications)
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer transformation and validation.
