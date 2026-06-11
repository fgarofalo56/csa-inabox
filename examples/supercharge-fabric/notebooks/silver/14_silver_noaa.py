# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: NOAA Weather & Climate Data Cleansing & Standardization
# MAGIC
# MAGIC This notebook transforms Bronze NOAA data into cleansed, validated,
# MAGIC and enriched Silver layer tables.
# MAGIC
# MAGIC ## Transformations Applied:
# MAGIC - Temperature casting to DoubleType with range validation (-90 to 60 C)
# MAGIC - Humidity validation (0-100), pressure validation, coordinate validation
# MAGIC - Weather condition code standardization
# MAGIC - Storm event damage parsing (K/M/B suffix handling)
# MAGIC - Derived: duration_hours, total_casualties, total_damage
# MAGIC - Climate station deduplication and completeness scoring
# MAGIC - Data quality scoring per record

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

from delta.tables import DeltaTable
from pyspark.sql.functions import (
    array,
    array_compact,
    coalesce,
    col,
    count,
    create_map,
    current_timestamp,
    filter,
    hours,
    lit,
    month,
    regexp_extract,
    regexp_replace,
    round,
    to_date,
    to_timestamp,
    trim,
    upper,
    when,
    year,
)
from pyspark.sql.types import DoubleType, IntegerType

# Parameters (set by pipeline or manual)
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source tables (Bronze)
SOURCE_WEATHER = "lh_bronze.bronze_noaa_weather"
SOURCE_STORM = "lh_bronze.bronze_noaa_storm_events"
SOURCE_CLIMATE = "lh_bronze.bronze_noaa_climate"

# Target tables (Silver)
TARGET_WEATHER = "lh_silver.silver_noaa_weather"
TARGET_STORM = "lh_silver.silver_noaa_storm_events"
TARGET_CLIMATE = "lh_silver.silver_noaa_climate"

print(f"Processing batch: {batch_id}")
print(f"Sources: {SOURCE_WEATHER}, {SOURCE_STORM}, {SOURCE_CLIMATE}")
print(f"Targets: {TARGET_WEATHER}, {TARGET_STORM}, {TARGET_CLIMATE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Reference Data: Valid Codes & Ranges

# COMMAND ----------

# NOAA standard weather condition codes
VALID_WEATHER_CONDITIONS = [
    "CLEAR", "PARTLY_CLOUDY", "CLOUDY", "OVERCAST",
    "FOG", "MIST", "HAZE", "SMOKE",
    "RAIN", "DRIZZLE", "HEAVY_RAIN", "FREEZING_RAIN",
    "SNOW", "HEAVY_SNOW", "SLEET", "ICE_PELLETS", "BLIZZARD",
    "THUNDERSTORM", "SEVERE_THUNDERSTORM", "TORNADO",
    "HURRICANE", "TROPICAL_STORM",
    "WINDY", "CALM",
]

# Weather condition standardization map
WEATHER_CONDITION_MAP = {
    "CLR": "CLEAR", "CLEAR SKY": "CLEAR", "FAIR": "CLEAR",
    "PTLY CLOUDY": "PARTLY_CLOUDY", "SCATTERED CLOUDS": "PARTLY_CLOUDY", "FEW CLOUDS": "PARTLY_CLOUDY",
    "BROKEN CLOUDS": "CLOUDY", "BKN": "CLOUDY",
    "OVC": "OVERCAST", "OVERCAST CLOUDS": "OVERCAST",
    "FG": "FOG", "BR": "MIST", "HZ": "HAZE",
    "RA": "RAIN", "DZ": "DRIZZLE", "+RA": "HEAVY_RAIN", "FZRA": "FREEZING_RAIN",
    "SN": "SNOW", "+SN": "HEAVY_SNOW", "PL": "ICE_PELLETS",
    "TS": "THUNDERSTORM", "+TS": "SEVERE_THUNDERSTORM",
}

weather_cond_expr = create_map([lit(x) for pair in WEATHER_CONDITION_MAP.items() for x in pair])

# NOAA storm event types (standard NWS categories)
VALID_STORM_EVENT_TYPES = [
    "TORNADO", "HAIL", "THUNDERSTORM_WIND", "FLASH_FLOOD", "FLOOD",
    "HURRICANE", "TROPICAL_STORM", "TROPICAL_DEPRESSION",
    "HIGH_WIND", "STRONG_WIND", "BLIZZARD", "HEAVY_SNOW", "ICE_STORM",
    "WINTER_STORM", "WINTER_WEATHER", "COLD_WIND_CHILL", "EXTREME_COLD",
    "HEAT", "EXCESSIVE_HEAT", "DROUGHT", "DUST_STORM",
    "WILDFIRE", "DENSE_FOG", "LIGHTNING", "TSUNAMI", "RIP_CURRENT",
    "COASTAL_FLOOD", "LAKE_EFFECT_SNOW", "AVALANCHE", "DEBRIS_FLOW",
    "WATERSPOUT", "FUNNEL_CLOUD", "FREEZING_FOG", "MARINE_THUNDERSTORM_WIND",
]

# Physical constant ranges
TEMP_MIN_C = -90.0
TEMP_MAX_C = 60.0
HUMIDITY_MIN = 0
HUMIDITY_MAX = 100
PRESSURE_MIN_HPA = 870.0
PRESSURE_MAX_HPA = 1084.0
LAT_MIN = -90.0
LAT_MAX = 90.0
LON_MIN = -180.0
LON_MAX = 180.0

print("Reference data loaded:")
print(f"  Weather conditions: {len(VALID_WEATHER_CONDITIONS)}")
print(f"  Weather condition mappings: {len(WEATHER_CONDITION_MAP)}")
print(f"  Storm event types: {len(VALID_STORM_EVENT_TYPES)}")
print(f"  Temperature range: {TEMP_MIN_C}C to {TEMP_MAX_C}C")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 1: Weather Observations (bronze_noaa_weather -> silver_noaa_weather)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Read Bronze Weather Data

# COMMAND ----------

df_weather_bronze = spark.table(SOURCE_WEATHER)

weather_bronze_count = df_weather_bronze.count()
print(f"Bronze weather records: {weather_bronze_count:,}")
print(f"Columns: {len(df_weather_bronze.columns)}")
df_weather_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ### Type Casting & Range Validation

# COMMAND ----------

df_weather_typed = df_weather_bronze \
    .withColumn("temperature_c",
        col("temperature_c").cast(DoubleType())) \
    .withColumn("humidity",
        col("humidity").cast(DoubleType())) \
    .withColumn("pressure_hpa",
        col("pressure_hpa").cast(DoubleType())) \
    .withColumn("wind_speed_ms",
        col("wind_speed_ms").cast(DoubleType())) \
    .withColumn("latitude",
        col("latitude").cast(DoubleType())) \
    .withColumn("longitude",
        col("longitude").cast(DoubleType())) \
    .withColumn("observation_time",
        to_timestamp(col("observation_time")))

# Range validation flags
df_weather_validated = df_weather_typed \
    .withColumn("temp_valid",
        col("temperature_c").isNotNull() &
        (col("temperature_c") >= TEMP_MIN_C) &
        (col("temperature_c") <= TEMP_MAX_C)) \
    .withColumn("humidity_valid",
        col("humidity").isNotNull() &
        (col("humidity") >= HUMIDITY_MIN) &
        (col("humidity") <= HUMIDITY_MAX)) \
    .withColumn("pressure_valid",
        col("pressure_hpa").isNull() |  # Allow null pressure
        ((col("pressure_hpa") >= PRESSURE_MIN_HPA) &
         (col("pressure_hpa") <= PRESSURE_MAX_HPA))) \
    .withColumn("coords_valid",
        col("latitude").isNotNull() &
        col("longitude").isNotNull() &
        (col("latitude") >= LAT_MIN) & (col("latitude") <= LAT_MAX) &
        (col("longitude") >= LON_MIN) & (col("longitude") <= LON_MAX))

invalid_temp = df_weather_validated.filter(~col("temp_valid")).count()
invalid_humidity = df_weather_validated.filter(~col("humidity_valid")).count()
invalid_pressure = df_weather_validated.filter(~col("pressure_valid")).count()
invalid_coords = df_weather_validated.filter(~col("coords_valid")).count()

print("Weather Range Validation:")
print(f"  Invalid temperatures: {invalid_temp:,}")
print(f"  Invalid humidity: {invalid_humidity:,}")
print(f"  Invalid pressure: {invalid_pressure:,}")
print(f"  Invalid coordinates: {invalid_coords:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Weather Condition Standardization

# COMMAND ----------

df_weather_std = df_weather_validated \
    .withColumn("weather_condition_raw", upper(trim(col("weather_condition")))) \
    .withColumn("weather_condition_std",
        coalesce(
            weather_cond_expr[upper(trim(col("weather_condition")))],
            when(upper(trim(col("weather_condition"))).isin(VALID_WEATHER_CONDITIONS),
                 upper(trim(col("weather_condition")))),
            lit("UNKNOWN")
        ))

print("Weather Condition Standardization:")
display(
    df_weather_std
    .select("weather_condition_raw", "weather_condition_std")
    .distinct()
    .orderBy("weather_condition_raw")
)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Deduplication
# MAGIC
# MAGIC Remove duplicates by (station_id, observation_time) composite key.

# COMMAND ----------

before_dedup = df_weather_std.count()

df_weather_deduped = df_weather_std.dropDuplicates(["station_id", "observation_time"])

after_dedup = df_weather_deduped.count()
dupes_removed = before_dedup - after_dedup

print(f"Weather Deduplication Results:")
print(f"  Before: {before_dedup:,}")
print(f"  After: {after_dedup:,}")
print(f"  Duplicates removed: {dupes_removed:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Weather Data Quality Score
# MAGIC
# MAGIC | Check | Points |
# MAGIC |-------|--------|
# MAGIC | Valid temperature | 20 |
# MAGIC | Valid humidity | 20 |
# MAGIC | Valid coordinates | 20 |
# MAGIC | Valid pressure | 20 |
# MAGIC | Complete record (no nulls) | 20 |

# COMMAND ----------

df_weather_dq = df_weather_deduped \
    .withColumn("_dq_score",
        (
            when(col("temp_valid") == True, lit(20)).otherwise(lit(0)) +
            when(col("humidity_valid") == True, lit(20)).otherwise(lit(0)) +
            when(col("coords_valid") == True, lit(20)).otherwise(lit(0)) +
            when(col("pressure_valid") == True, lit(20)).otherwise(lit(0)) +
            when(
                col("station_id").isNotNull() &
                col("observation_time").isNotNull() &
                col("weather_condition_std").isNotNull() &
                (col("weather_condition_std") != "UNKNOWN"),
                lit(20)
            ).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(~col("temp_valid"), lit("INVALID_TEMPERATURE")),
                when(~col("humidity_valid"), lit("INVALID_HUMIDITY")),
                when(~col("coords_valid"), lit("INVALID_COORDINATES")),
                when(~col("pressure_valid"), lit("INVALID_PRESSURE")),
                when(col("weather_condition_std") == "UNKNOWN", lit("UNKNOWN_WEATHER_CONDITION"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Silver Metadata & Write Weather Table

# COMMAND ----------

try:
    df_weather_silver = df_weather_dq \
        .withColumn("_silver_timestamp", current_timestamp()) \
        .withColumn("_batch_id", lit(batch_id)) \
        .withColumn("observation_date", to_date(col("observation_time")))

    weather_columns = [
        # Identifiers
        "station_id", "station_name",
        # Observation
        "observation_time", "observation_date",
        # Weather values
        "temperature_c", "temp_valid",
        "humidity", "humidity_valid",
        "pressure_hpa", "pressure_valid",
        "wind_speed_ms", "wind_direction_deg",
        "precipitation_mm", "visibility_km",
        "weather_condition_std",
        # Location
        "latitude", "longitude", "coords_valid",
        "elevation_m", "state", "country",
        # Quality & metadata
        "_dq_score", "_dq_flags", "_silver_timestamp", "_batch_id",
    ]

    df_weather_out = df_weather_silver.select(
        [col(c) for c in weather_columns if c in df_weather_silver.columns]
    )

    # Write to Silver layer using Delta MERGE (incremental upsert)
    if spark.catalog.tableExists(TARGET_WEATHER):
        deltaTable = DeltaTable.forName(spark, TARGET_WEATHER)
        deltaTable.alias("target").merge(
            df_weather_out.alias("source"),
            "target.station_id = source.station_id AND target.observation_time = source.observation_time"
        ).whenMatchedUpdateAll(
            condition="target._silver_timestamp < source._silver_timestamp"
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_weather_out.write \
            .format("delta") \
            .mode("overwrite") \
            .partitionBy("observation_date") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_WEATHER)

    weather_silver_count = spark.table(TARGET_WEATHER).count()
    print(f"Written/merged records to {TARGET_WEATHER} (total: {weather_silver_count:,})")
except Exception as e:
    print(f"ERROR in unknown (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 2: Storm Events (bronze_noaa_storm_events -> silver_noaa_storm_events)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Read Bronze Storm Event Data

# COMMAND ----------

df_storm_bronze = spark.table(SOURCE_STORM)

storm_bronze_count = df_storm_bronze.count()
print(f"Bronze storm event records: {storm_bronze_count:,}")
print(f"Columns: {len(df_storm_bronze.columns)}")
df_storm_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ### Parse Damage Values (K/M/B Suffix Handling)
# MAGIC
# MAGIC NOAA damage fields use suffixes: K = thousands, M = millions, B = billions.
# MAGIC Example: "25K" = 25,000, "1.5M" = 1,500,000

# COMMAND ----------

def parse_damage_expr(col_name):
    """Create expression to parse NOAA damage values with K/M/B suffixes."""
    c = col(col_name)
    cleaned = upper(trim(c))
    return (
        when(cleaned.isNull() | (cleaned == ""), lit(0.0))
        .when(cleaned.endswith("B"),
            regexp_extract(cleaned, r"([\d.]+)", 1).cast(DoubleType()) * 1000000000)
        .when(cleaned.endswith("M"),
            regexp_extract(cleaned, r"([\d.]+)", 1).cast(DoubleType()) * 1000000)
        .when(cleaned.endswith("K"),
            regexp_extract(cleaned, r"([\d.]+)", 1).cast(DoubleType()) * 1000)
        .otherwise(cleaned.cast(DoubleType()))
    )

df_storm_parsed = df_storm_bronze \
    .withColumn("damage_property_amt", parse_damage_expr("damage_property")) \
    .withColumn("damage_crops_amt", parse_damage_expr("damage_crops"))

print("Damage parsing applied:")
display(
    df_storm_parsed
    .select("damage_property", "damage_property_amt", "damage_crops", "damage_crops_amt")
    .filter(col("damage_property").isNotNull())
    .limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Event Type Validation & Date Validation

# COMMAND ----------

df_storm_validated = df_storm_parsed \
    .withColumn("event_type_clean",
        upper(regexp_replace(trim(col("event_type")), r"[\s/]+", "_"))) \
    .withColumn("event_type_valid",
        col("event_type_clean").isin(VALID_STORM_EVENT_TYPES)) \
    .withColumn("begin_date_parsed", to_timestamp(col("begin_date"))) \
    .withColumn("end_date_parsed", to_timestamp(col("end_date"))) \
    .withColumn("dates_valid",
        col("begin_date_parsed").isNotNull() &
        (col("end_date_parsed").isNull() | (col("end_date_parsed") >= col("begin_date_parsed"))) &
        (col("begin_date_parsed") <= current_timestamp())) \
    .withColumn("coords_valid",
        col("latitude").isNotNull() &
        col("longitude").isNotNull() &
        (col("latitude").cast(DoubleType()) >= LAT_MIN) &
        (col("latitude").cast(DoubleType()) <= LAT_MAX) &
        (col("longitude").cast(DoubleType()) >= LON_MIN) &
        (col("longitude").cast(DoubleType()) <= LON_MAX)) \
    .withColumn("has_location",
        col("state").isNotNull() | col("coords_valid")) \
    .withColumn("has_damage_data",
        col("damage_property_amt").isNotNull() | col("damage_crops_amt").isNotNull())

invalid_events = df_storm_validated.filter(~col("event_type_valid") & col("event_type").isNotNull()).count()
invalid_dates = df_storm_validated.filter(~col("dates_valid")).count()

print("Storm Event Validation:")
print(f"  Invalid event types: {invalid_events:,}")
print(f"  Invalid dates: {invalid_dates:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Deduplication

# COMMAND ----------

before_dedup_storm = df_storm_validated.count()

df_storm_deduped = df_storm_validated.dropDuplicates(["event_id"])

after_dedup_storm = df_storm_deduped.count()
dupes_removed_storm = before_dedup_storm - after_dedup_storm

print(f"Storm Event Deduplication Results:")
print(f"  Before: {before_dedup_storm:,}")
print(f"  After: {after_dedup_storm:,}")
print(f"  Duplicates removed: {dupes_removed_storm:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Derived Fields
# MAGIC
# MAGIC - duration_hours: time between begin_date and end_date
# MAGIC - total_casualties: injuries_direct + injuries_indirect + deaths_direct + deaths_indirect
# MAGIC - total_damage: damage_property_amt + damage_crops_amt

# COMMAND ----------

df_storm_derived = df_storm_deduped \
    .withColumn("duration_hours",
        when(
            col("begin_date_parsed").isNotNull() & col("end_date_parsed").isNotNull(),
            round(
                (col("end_date_parsed").cast("long") - col("begin_date_parsed").cast("long")) / 3600.0,
                2
            )
        ).otherwise(lit(None).cast(DoubleType()))
    ) \
    .withColumn("total_casualties",
        (
            coalesce(col("injuries_direct"), lit(0)) +
            coalesce(col("injuries_indirect"), lit(0)) +
            coalesce(col("deaths_direct"), lit(0)) +
            coalesce(col("deaths_indirect"), lit(0))
        ).cast(IntegerType())
    ) \
    .withColumn("total_damage",
        round(
            coalesce(col("damage_property_amt"), lit(0.0)) +
            coalesce(col("damage_crops_amt"), lit(0.0)),
            2
        )
    ) \
    .withColumn("event_year", year(col("begin_date_parsed"))) \
    .withColumn("event_month", month(col("begin_date_parsed")))

print("Derived fields added:")
print("  duration_hours = (end_date - begin_date) in hours")
print("  total_casualties = injuries_direct + injuries_indirect + deaths_direct + deaths_indirect")
print("  total_damage = damage_property_amt + damage_crops_amt")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Storm Event Data Quality Score
# MAGIC
# MAGIC | Check | Points |
# MAGIC |-------|--------|
# MAGIC | Valid event type | 25 |
# MAGIC | Valid dates | 25 |
# MAGIC | Has location data | 25 |
# MAGIC | Has damage data | 25 |

# COMMAND ----------

df_storm_dq = df_storm_derived \
    .withColumn("_dq_score",
        (
            when(col("event_type_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("dates_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("has_location") == True, lit(25)).otherwise(lit(0)) +
            when(col("has_damage_data") == True, lit(25)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(col("event_type_valid") == False, lit("INVALID_EVENT_TYPE")),
                when(col("dates_valid") == False, lit("INVALID_DATES")),
                when(col("has_location") == False, lit("MISSING_LOCATION")),
                when(col("has_damage_data") == False, lit("MISSING_DAMAGE_DATA")),
                when(col("duration_hours").isNotNull() & (col("duration_hours") < 0), lit("NEGATIVE_DURATION"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Silver Metadata & Write Storm Events Table

# COMMAND ----------

df_storm_silver = df_storm_dq \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

storm_columns = [
    # Identifiers
    "event_id", "episode_id",
    # Event details
    "event_type_clean", "event_type_valid",
    "begin_date_parsed", "end_date_parsed", "event_year", "event_month",
    "duration_hours",
    # Location
    "state", "county", "timezone",
    "latitude", "longitude", "coords_valid",
    # Impact
    "injuries_direct", "injuries_indirect", "deaths_direct", "deaths_indirect",
    "total_casualties",
    "damage_property", "damage_property_amt",
    "damage_crops", "damage_crops_amt",
    "total_damage",
    # Conditions
    "magnitude", "magnitude_type", "flood_cause", "tor_f_scale",
    # Narrative
    "event_narrative", "episode_narrative",
    # Source
    "source", "data_source",
    # Quality & metadata
    "_dq_score", "_dq_flags", "_silver_timestamp", "_batch_id",
]

df_storm_out = df_storm_silver.select(
    [col(c) for c in storm_columns if c in df_storm_silver.columns]
)

# Write to Silver layer using Delta MERGE (incremental upsert)
if spark.catalog.tableExists(TARGET_STORM):
    deltaTable = DeltaTable.forName(spark, TARGET_STORM)
    deltaTable.alias("target").merge(
        df_storm_out.alias("source"),
        "target.event_id = source.event_id"
    ).whenMatchedUpdateAll(
        condition="target._silver_timestamp < source._silver_timestamp"
    ).whenNotMatchedInsertAll(
    ).execute()
else:
    df_storm_out.write \
        .format("delta") \
        .mode("overwrite") \
        .partitionBy("event_year") \
        .option("overwriteSchema", "true") \
        .saveAsTable(TARGET_STORM)

storm_silver_count = spark.table(TARGET_STORM).count()
print(f"Written/merged records to {TARGET_STORM} (total: {storm_silver_count:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 3: Climate Data (bronze_noaa_climate -> silver_noaa_climate)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Read Bronze Climate Data

# COMMAND ----------

df_climate_bronze = spark.table(SOURCE_CLIMATE)

climate_bronze_count = df_climate_bronze.count()
print(f"Bronze climate records: {climate_bronze_count:,}")
print(f"Columns: {len(df_climate_bronze.columns)}")
df_climate_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ### Validation & Cleansing

# COMMAND ----------

df_climate_validated = df_climate_bronze \
    .withColumn("temperature_avg",
        col("temperature_avg").cast(DoubleType())) \
    .withColumn("temperature_max",
        col("temperature_max").cast(DoubleType())) \
    .withColumn("temperature_min",
        col("temperature_min").cast(DoubleType())) \
    .withColumn("precipitation",
        col("precipitation").cast(DoubleType())) \
    .withColumn("date_parsed", to_date(col("date"))) \
    .withColumn("temp_avg_valid",
        col("temperature_avg").isNull() |
        ((col("temperature_avg") >= TEMP_MIN_C) & (col("temperature_avg") <= TEMP_MAX_C))) \
    .withColumn("temp_max_valid",
        col("temperature_max").isNull() |
        ((col("temperature_max") >= TEMP_MIN_C) & (col("temperature_max") <= TEMP_MAX_C))) \
    .withColumn("temp_min_valid",
        col("temperature_min").isNull() |
        ((col("temperature_min") >= TEMP_MIN_C) & (col("temperature_min") <= TEMP_MAX_C))) \
    .withColumn("precip_valid",
        col("precipitation").isNull() | (col("precipitation") >= 0)) \
    .withColumn("temp_range_valid",
        (col("temperature_max").isNull() | col("temperature_min").isNull()) |
        (col("temperature_max") >= col("temperature_min")))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Deduplication

# COMMAND ----------

before_dedup_climate = df_climate_validated.count()

df_climate_deduped = df_climate_validated.dropDuplicates(["station_id", "date_parsed"])

after_dedup_climate = df_climate_deduped.count()
dupes_removed_climate = before_dedup_climate - after_dedup_climate

print(f"Climate Deduplication Results:")
print(f"  Before: {before_dedup_climate:,}")
print(f"  After: {after_dedup_climate:,}")
print(f"  Duplicates removed: {dupes_removed_climate:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Climate Data Quality Score (Completeness-Based)

# COMMAND ----------

df_climate_dq = df_climate_deduped \
    .withColumn("_dq_score",
        (
            when(col("station_id").isNotNull(), lit(15)).otherwise(lit(0)) +
            when(col("date_parsed").isNotNull(), lit(15)).otherwise(lit(0)) +
            when(col("temp_avg_valid") == True, lit(15)).otherwise(lit(0)) +
            when(col("temp_max_valid") == True & col("temp_min_valid") == True, lit(15)).otherwise(lit(0)) +
            when(col("precip_valid") == True, lit(15)).otherwise(lit(0)) +
            when(col("temp_range_valid") == True, lit(10)).otherwise(lit(0)) +
            when(col("snow_depth").isNotNull() | col("wind_speed").isNotNull(), lit(15)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(col("temp_avg_valid") == False, lit("INVALID_TEMP_AVG")),
                when(col("temp_max_valid") == False, lit("INVALID_TEMP_MAX")),
                when(col("temp_min_valid") == False, lit("INVALID_TEMP_MIN")),
                when(col("precip_valid") == False, lit("NEGATIVE_PRECIPITATION")),
                when(col("temp_range_valid") == False, lit("TEMP_MAX_BELOW_MIN"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Silver Metadata & Write Climate Table

# COMMAND ----------

df_climate_silver = df_climate_dq \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id)) \
    .withColumn("observation_year", year(col("date_parsed"))) \
    .withColumn("observation_month", month(col("date_parsed")))

climate_columns = [
    # Identifiers
    "station_id", "station_name",
    # Date
    "date_parsed", "observation_year", "observation_month",
    # Temperature
    "temperature_avg", "temperature_max", "temperature_min",
    "temp_avg_valid", "temp_max_valid", "temp_min_valid", "temp_range_valid",
    # Precipitation & snow
    "precipitation", "precip_valid",
    "snow_depth", "snow_fall",
    # Wind
    "wind_speed", "wind_direction",
    # Location
    "latitude", "longitude", "elevation",
    "state", "country",
    # Quality & metadata
    "_dq_score", "_dq_flags", "_silver_timestamp", "_batch_id",
]

df_climate_out = df_climate_silver.select(
    [col(c) for c in climate_columns if c in df_climate_silver.columns]
)

# Write to Silver layer using Delta MERGE (incremental upsert)
if spark.catalog.tableExists(TARGET_CLIMATE):
    deltaTable = DeltaTable.forName(spark, TARGET_CLIMATE)
    deltaTable.alias("target").merge(
        df_climate_out.alias("source"),
        "target.station_id = source.station_id AND target.date_parsed = source.date_parsed"
    ).whenMatchedUpdateAll(
        condition="target._silver_timestamp < source._silver_timestamp"
    ).whenNotMatchedInsertAll(
    ).execute()
else:
    df_climate_out.write \
        .format("delta") \
        .mode("overwrite") \
        .partitionBy("observation_year") \
        .option("overwriteSchema", "true") \
        .saveAsTable(TARGET_CLIMATE)

climate_silver_count = spark.table(TARGET_CLIMATE).count()
print(f"Written/merged records to {TARGET_CLIMATE} (total: {climate_silver_count:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Report

# COMMAND ----------

print("=" * 60)
print("NOAA Silver Layer - Data Quality Report")
print("=" * 60)

# Weather quality
print(f"\n--- {TARGET_WEATHER} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        ROUND(MIN(_dq_score), 2) as min_quality_score,
        ROUND(MAX(_dq_score), 2) as max_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(CASE WHEN _dq_score < 40 THEN 1 END) as low_quality_records
    FROM {TARGET_WEATHER}
""").show(truncate=False)

# COMMAND ----------

# Storm events quality
print(f"\n--- {TARGET_STORM} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(DISTINCT event_type_clean) as event_types,
        SUM(total_casualties) as total_casualties,
        ROUND(SUM(total_damage), 2) as total_damage_usd
    FROM {TARGET_STORM}
""").show(truncate=False)

# COMMAND ----------

# Storm events by type
print("Storm Events by Type:")
spark.sql(f"""
    SELECT
        event_type_clean as event_type,
        COUNT(*) as events,
        SUM(total_casualties) as casualties,
        ROUND(SUM(total_damage), 2) as total_damage,
        ROUND(AVG(duration_hours), 1) as avg_duration_hrs
    FROM {TARGET_STORM}
    GROUP BY event_type_clean
    ORDER BY events DESC
    LIMIT 15
""").show(truncate=False)

# COMMAND ----------

# Climate quality
print(f"\n--- {TARGET_CLIMATE} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(CASE WHEN _dq_score < 50 THEN 1 END) as low_quality_records,
        COUNT(DISTINCT station_id) as unique_stations
    FROM {TARGET_CLIMATE}
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize Tables

# COMMAND ----------

spark.sql(f"OPTIMIZE {TARGET_WEATHER} ZORDER BY (station_id, weather_condition_std)")
print(f"Optimized {TARGET_WEATHER} with Z-Order on station_id, weather_condition_std")

spark.sql(f"OPTIMIZE {TARGET_STORM} ZORDER BY (event_type_clean, state)")
print(f"Optimized {TARGET_STORM} with Z-Order on event_type_clean, state")

spark.sql(f"OPTIMIZE {TARGET_CLIMATE} ZORDER BY (station_id)")
print(f"Optimized {TARGET_CLIMATE} with Z-Order on station_id")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation Queries

# COMMAND ----------

# Verify no duplicate keys in weather
weather_dup = spark.sql(f"""
    SELECT station_id, observation_time, COUNT(*) as cnt
    FROM {TARGET_WEATHER}
    GROUP BY station_id, observation_time
    HAVING cnt > 1
""")
print(f"Weather duplicate (station_id, observation_time) (should be 0): {weather_dup.count()}")

# Verify no duplicate event_ids in storm events
storm_dup = spark.sql(f"""
    SELECT event_id, COUNT(*) as cnt
    FROM {TARGET_STORM}
    GROUP BY event_id
    HAVING cnt > 1
""")
print(f"Storm duplicate event_ids (should be 0): {storm_dup.count()}")

# Verify no duplicate keys in climate
climate_dup = spark.sql(f"""
    SELECT station_id, date_parsed, COUNT(*) as cnt
    FROM {TARGET_CLIMATE}
    GROUP BY station_id, date_parsed
    HAVING cnt > 1
""")
print(f"Climate duplicate (station_id, date) (should be 0): {climate_dup.count()}")

# Verify temperature ranges
out_of_range = spark.sql(f"""
    SELECT COUNT(*) as cnt
    FROM {TARGET_WEATHER}
    WHERE temp_valid = false
""").collect()[0]["cnt"]
print(f"Weather records with out-of-range temperature: {out_of_range}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Source Table | Target Table | Key Transformations |
# MAGIC |-------------|-------------|---------------------|
# MAGIC | bronze_noaa_weather | silver_noaa_weather | Temp/humidity/pressure range validation, weather code standardization, DQ scoring |
# MAGIC | bronze_noaa_storm_events | silver_noaa_storm_events | Damage K/M/B parsing, event type validation, derived: duration_hours, total_casualties, total_damage |
# MAGIC | bronze_noaa_climate | silver_noaa_climate | Temperature range validation, precipitation >= 0 check, completeness-based DQ scoring |
# MAGIC
# MAGIC **Next Step:** Continue to Gold layer for NOAA climate and severe weather analytics.
