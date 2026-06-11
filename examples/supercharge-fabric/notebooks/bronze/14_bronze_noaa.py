# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: NOAA Data Ingestion
# MAGIC
# MAGIC This notebook ingests raw NOAA data into the Bronze layer across three domains:
# MAGIC weather observations, storm events, and climate data.
# MAGIC
# MAGIC ## Data Sources
# MAGIC - **Weather Observations:** Real-time and historical surface weather observations
# MAGIC - **Storm Events:** NCDC storm events database with damage and casualty records
# MAGIC - **Climate Data:** GHCN-Daily station-level climate summaries
# MAGIC - **Formats:** Parquet (data generator output) with CSV fallback (open data downloads)
# MAGIC
# MAGIC ## Targets
# MAGIC - **bronze_noaa_weather** - Weather observation records
# MAGIC - **bronze_noaa_storm_events** - Storm event records
# MAGIC - **bronze_noaa_climate** - Climate data records
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
    "weather": "Files/output/noaa_weather.parquet",
    "storm_events": "Files/output/noaa_storm_events.parquet",
    "climate": "Files/output/noaa_climate.parquet",
}

# CSV fallback paths - open data downloads
CSV_FALLBACK_PATHS = {
    "weather": "Files/open_data/noaa/weather/",
    "storm_events": "Files/open_data/noaa/storm_events/",
    "climate": "Files/open_data/noaa/climate/",
}

# Target Delta tables
TARGET_TABLES = {
    "weather": "lh_bronze.bronze_noaa_weather",
    "storm_events": "lh_bronze.bronze_noaa_storm_events",
    "climate": "lh_bronze.bronze_noaa_climate",
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
# MAGIC Explicit schemas for all three NOAA domains to enforce structure at ingestion.
# MAGIC Includes geospatial fields (latitude/longitude) for weather and storm event data.

# COMMAND ----------

# Weather Observations schema
weather_schema = StructType([
    StructField("observation_id", StringType(), False),
    StructField("station_id", StringType(), False),
    StructField("station_name", StringType(), True),
    StructField("latitude", DoubleType(), True),
    StructField("longitude", DoubleType(), True),
    StructField("observation_time", StringType(), False),
    StructField("temperature_c", DoubleType(), True),
    StructField("humidity_pct", DoubleType(), True),
    StructField("wind_speed_mps", DoubleType(), True),
    StructField("wind_direction", StringType(), True),
    StructField("pressure_hpa", DoubleType(), True),
    StructField("precipitation_mm", DoubleType(), True),
    StructField("visibility_km", DoubleType(), True),
    StructField("weather_condition", StringType(), True),
    StructField("alert_type", StringType(), True),
    StructField("alert_severity", StringType(), True),
])

print(f"Weather Observations schema fields: {len(weather_schema.fields)}")
for field in weather_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# Storm Events schema
storm_events_schema = StructType([
    StructField("event_id", StringType(), False),
    StructField("event_type", StringType(), False),
    StructField("state", StringType(), True),
    StructField("county_fips", StringType(), True),
    StructField("begin_date", StringType(), False),
    StructField("end_date", StringType(), True),
    StructField("magnitude", DoubleType(), True),
    StructField("magnitude_type", StringType(), True),
    StructField("injuries_direct", IntegerType(), True),
    StructField("injuries_indirect", IntegerType(), True),
    StructField("deaths_direct", IntegerType(), True),
    StructField("deaths_indirect", IntegerType(), True),
    StructField("damage_property", DoubleType(), True),
    StructField("damage_crops", DoubleType(), True),
    StructField("source", StringType(), True),
    StructField("narrative", StringType(), True),
])

print(f"\nStorm Events schema fields: {len(storm_events_schema.fields)}")
for field in storm_events_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# Climate Data schema (GHCN-Daily)
climate_schema = StructType([
    StructField("station_id", StringType(), False),
    StructField("date", StringType(), False),
    StructField("tmax", DoubleType(), True),
    StructField("tmin", DoubleType(), True),
    StructField("tavg", DoubleType(), True),
    StructField("precipitation", DoubleType(), True),
    StructField("snowfall", DoubleType(), True),
    StructField("snow_depth", DoubleType(), True),
])

print(f"\nClimate Data schema fields: {len(climate_schema.fields)}")
for field in climate_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - Weather Observations
# MAGIC
# MAGIC Reads from parquet (data generator output) first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read weather observations data: try parquet first, fallback to CSV
try:
    df_weather_raw = spark.read \
        .schema(weather_schema) \
        .parquet(SOURCE_PATHS["weather"])
    weather_source_format = "Parquet"
    print(f"Weather: loaded from Parquet ({SOURCE_PATHS['weather']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['weather']}")
    df_weather_raw = spark.read \
        .schema(weather_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["weather"])
    weather_source_format = "CSV"
    print(f"Weather: loaded from CSV")

weather_record_count = df_weather_raw.count()
weather_column_count = len(df_weather_raw.columns)

print(f"\nWeather Observations Source Statistics:")
print(f"  Format: {weather_source_format}")
print(f"  Records: {weather_record_count:,}")
print(f"  Columns: {weather_column_count}")

df_weather_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - Storm Events
# MAGIC
# MAGIC Reads NCDC storm events data from parquet first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read storm events data: try parquet first, fallback to CSV
try:
    df_storm_raw = spark.read \
        .schema(storm_events_schema) \
        .parquet(SOURCE_PATHS["storm_events"])
    storm_source_format = "Parquet"
    print(f"Storm Events: loaded from Parquet ({SOURCE_PATHS['storm_events']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['storm_events']}")
    df_storm_raw = spark.read \
        .schema(storm_events_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["storm_events"])
    storm_source_format = "CSV"
    print(f"Storm Events: loaded from CSV")

storm_record_count = df_storm_raw.count()
storm_column_count = len(df_storm_raw.columns)

print(f"\nStorm Events Source Statistics:")
print(f"  Format: {storm_source_format}")
print(f"  Records: {storm_record_count:,}")
print(f"  Columns: {storm_column_count}")

df_storm_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data - Climate Data
# MAGIC
# MAGIC Reads GHCN-Daily climate data from parquet first, falls back to CSV from open data downloads.

# COMMAND ----------

# Read climate data: try parquet first, fallback to CSV
try:
    df_climate_raw = spark.read \
        .schema(climate_schema) \
        .parquet(SOURCE_PATHS["climate"])
    climate_source_format = "Parquet"
    print(f"Climate: loaded from Parquet ({SOURCE_PATHS['climate']})")
except Exception as e:
    print(f"Parquet read failed: {e}")
    print(f"Falling back to CSV: {CSV_FALLBACK_PATHS['climate']}")
    df_climate_raw = spark.read \
        .schema(climate_schema) \
        .option("header", "true") \
        .option("inferSchema", "false") \
        .option("mode", "PERMISSIVE") \
        .csv(CSV_FALLBACK_PATHS["climate"])
    climate_source_format = "CSV"
    print(f"Climate: loaded from CSV")

climate_record_count = df_climate_raw.count()
climate_column_count = len(df_climate_raw.columns)

print(f"\nClimate Data Source Statistics:")
print(f"  Format: {climate_source_format}")
print(f"  Records: {climate_record_count:,}")
print(f"  Columns: {climate_column_count}")

df_climate_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Bronze Data Quality Checks
# MAGIC
# MAGIC Minimal validation at Bronze layer - verify critical fields are populated.
# MAGIC Includes geospatial coordinate range validation for weather observation data.

# COMMAND ----------

# Weather Observations critical field null checks
weather_critical_fields = ["observation_id", "station_id", "observation_time"]

print("Weather Observations - Critical Field Null Check:")
for field in weather_critical_fields:
    null_count = df_weather_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# Geospatial coordinate range check for weather observations
lat_out_of_range = df_weather_raw.filter(
    (col("latitude").isNotNull()) &
    ((col("latitude") < -90) | (col("latitude") > 90))
).count()
lon_out_of_range = df_weather_raw.filter(
    (col("longitude").isNotNull()) &
    ((col("longitude") < -180) | (col("longitude") > 180))
).count()
print(f"  latitude out of range [-90, 90]: {'PASS' if lat_out_of_range == 0 else f'WARN: {lat_out_of_range:,}'}")
print(f"  longitude out of range [-180, 180]: {'PASS' if lon_out_of_range == 0 else f'WARN: {lon_out_of_range:,}'}")

# Storm Events critical field null checks
storm_critical_fields = ["event_id", "event_type", "begin_date"]

print("\nStorm Events - Critical Field Null Check:")
for field in storm_critical_fields:
    null_count = df_storm_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# Climate Data critical field null checks
climate_critical_fields = ["station_id", "date"]

print("\nClimate Data - Critical Field Null Check:")
for field in climate_critical_fields:
    null_count = df_climate_raw.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count:,} nulls"
    print(f"  {field}: {status}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - Weather Observations

# COMMAND ----------

# Add Bronze layer metadata columns to weather observations
df_weather_bronze = df_weather_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to Weather Observations:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - Storm Events

# COMMAND ----------

# Add Bronze layer metadata columns to storm events
df_storm_bronze = df_storm_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to Storm Events:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Bronze Metadata - Climate Data

# COMMAND ----------

# Add Bronze layer metadata columns to climate data
df_climate_bronze = df_climate_raw \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date"))

print("Added Bronze metadata columns to Climate Data:")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - Weather Observations

# COMMAND ----------

# Write weather observations to Bronze Delta table
df_weather_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["weather"])

weather_final_count = spark.table(TARGET_TABLES["weather"]).count()
print(f"Successfully wrote {weather_final_count:,} records to {TARGET_TABLES['weather']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - Storm Events

# COMMAND ----------

# Write storm events to Bronze Delta table
df_storm_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["storm_events"])

storm_final_count = df_storm_bronze.count()
print(f"Successfully wrote {storm_final_count:,} records to {TARGET_TABLES['storm_events']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table - Climate Data

# COMMAND ----------

# Write climate data to Bronze Delta table
df_climate_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_bronze_load_date") \
    .saveAsTable(TARGET_TABLES["climate"])

climate_final_count = df_climate_bronze.count()
print(f"Successfully wrote {climate_final_count:,} records to {TARGET_TABLES['climate']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Verify Ingestion

# COMMAND ----------

# Verify weather observations table
df_weather_verify = spark.table(TARGET_TABLES["weather"])

print("Weather Observations Table Verification:")
print(f"  Total records: {df_weather_verify.count():,}")
print(f"  Partitions: {df_weather_verify.select('_bronze_load_date').distinct().count()}")

print("\nWeather Observations Sample Records:")
display(
    df_weather_verify.select(
        "observation_id", "station_id", "observation_time",
        "temperature_c", "humidity_pct", "weather_condition",
        "latitude", "longitude", "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# Verify storm events table
df_storm_verify = spark.table(TARGET_TABLES["storm_events"])

print("Storm Events Table Verification:")
print(f"  Total records: {df_storm_verify.count():,}")
print(f"  Partitions: {df_storm_verify.select('_bronze_load_date').distinct().count()}")

print("\nStorm Events Sample Records:")
display(
    df_storm_verify.select(
        "event_id", "event_type", "state",
        "begin_date", "magnitude", "damage_property",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# Verify climate data table
df_climate_verify = spark.table(TARGET_TABLES["climate"])

print("Climate Data Table Verification:")
print(f"  Total records: {df_climate_verify.count():,}")
print(f"  Partitions: {df_climate_verify.select('_bronze_load_date').distinct().count()}")

print("\nClimate Data Sample Records:")
display(
    df_climate_verify.select(
        "station_id", "date", "tmax", "tmin",
        "precipitation", "snowfall",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Table Statistics

# COMMAND ----------

# Weather Observations - Condition distribution
print("Weather Observations - Weather Condition Distribution:")
display(
    df_weather_verify
    .groupBy("weather_condition")
    .count()
    .orderBy(col("count").desc())
    .limit(20)
)

# COMMAND ----------

# Weather Observations - Alert Severity distribution
print("Weather Observations - Alert Severity Distribution:")
display(
    df_weather_verify
    .filter(col("alert_severity").isNotNull())
    .groupBy("alert_severity")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Storm Events - Event Type distribution
print("Storm Events - Event Type Distribution (Top 20):")
display(
    df_storm_verify
    .groupBy("event_type")
    .count()
    .orderBy(col("count").desc())
    .limit(20)
)

# COMMAND ----------

# Storm Events - State distribution
print("Storm Events - State Distribution (Top 20):")
display(
    df_storm_verify
    .groupBy("state")
    .count()
    .orderBy(col("count").desc())
    .limit(20)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Geospatial Data Summary
# MAGIC
# MAGIC Coordinate coverage for weather observations (lat/lon fields).

# COMMAND ----------

from pyspark.sql.functions import avg as spark_avg
from pyspark.sql.functions import count as spark_count
from pyspark.sql.functions import max as spark_max
from pyspark.sql.functions import min as spark_min

# Geospatial coverage statistics for weather observations
geo_stats = df_weather_verify.select(
    spark_count(col("latitude")).alias("lat_non_null"),
    spark_min(col("latitude")).alias("lat_min"),
    spark_max(col("latitude")).alias("lat_max"),
    spark_avg(col("latitude")).alias("lat_avg"),
    spark_count(col("longitude")).alias("lon_non_null"),
    spark_min(col("longitude")).alias("lon_min"),
    spark_max(col("longitude")).alias("lon_max"),
    spark_avg(col("longitude")).alias("lon_avg"),
)

print("Weather Observations - Geospatial Coverage:")
display(geo_stats)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Delta Table History

# COMMAND ----------

from delta.tables import DeltaTable

# Weather Observations history
weather_delta = DeltaTable.forName(spark, TARGET_TABLES["weather"])

print("Weather Observations - Delta Table History:")
display(
    weather_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# Storm Events history
storm_delta = DeltaTable.forName(spark, TARGET_TABLES["storm_events"])

print("Storm Events - Delta Table History:")
display(
    storm_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# Climate Data history
climate_delta = DeltaTable.forName(spark, TARGET_TABLES["climate"])

print("Climate Data - Delta Table History:")
display(
    climate_delta.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Ingestion Summary
# MAGIC
# MAGIC | Domain | Target Table | Source Format | Records | Partitioned By |
# MAGIC |--------|-------------|--------------|---------|----------------|
# MAGIC | Weather Observations | bronze_noaa_weather | Parquet/CSV | See above | _bronze_load_date |
# MAGIC | Storm Events | bronze_noaa_storm_events | Parquet/CSV | See above | _bronze_load_date |
# MAGIC | Climate Data | bronze_noaa_climate | Parquet/CSV | See above | _bronze_load_date |
# MAGIC
# MAGIC ### Data Sources
# MAGIC - **Weather Observations:** https://www.ncdc.noaa.gov/cdo-web/webservices/v2 (CDO API)
# MAGIC - **Storm Events:** https://www.ncdc.noaa.gov/stormevents/ (Storm Events Database)
# MAGIC - **Climate Data:** https://www.ncei.noaa.gov/products/land-based-station/global-historical-climatology-network-daily (GHCN-Daily)
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer transformation and validation.
