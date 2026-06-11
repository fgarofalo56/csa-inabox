# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: DOI (Department of Interior) Data Cleansing & Standardization
# MAGIC
# MAGIC This notebook transforms Bronze DOI data into cleansed, validated,
# MAGIC and enriched Silver layer tables.
# MAGIC
# MAGIC ## Transformations Applied:
# MAGIC - Earthquake magnitude validation (0-10), depth > 0, coordinate validation
# MAGIC - Magnitude type standardization, event type validation
# MAGIC - Derived: is_significant (mag >= 4.5), region classification
# MAGIC - Water data parameter validation against known ranges, unit standardization
# MAGIC - Park visitation: visitor count >= 0, month 1-12, avg_daily_visitors
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
    current_date,
    current_timestamp,
    desc,
    filter,
    lit,
    max,
    min,
    month,
    months,
    regexp_replace,
    round,
    to_date,
    to_timestamp,
    trim,
    upper,
    when,
    year,
    years,
)
from pyspark.sql.types import DoubleType, IntegerType, LongType

# Parameters (set by pipeline or manual)
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source tables (Bronze)
SOURCE_EARTHQUAKES = "lh_bronze.bronze_doi_earthquakes"
SOURCE_WATER = "lh_bronze.bronze_doi_water_data"
SOURCE_PARKS = "lh_bronze.bronze_doi_park_visitation"

# Target tables (Silver)
TARGET_EARTHQUAKES = "lh_silver.silver_doi_earthquakes"
TARGET_WATER = "lh_silver.silver_doi_water_data"
TARGET_PARKS = "lh_silver.silver_doi_park_visitation"

print(f"Processing batch: {batch_id}")
print(f"Sources: {SOURCE_EARTHQUAKES}, {SOURCE_WATER}, {SOURCE_PARKS}")
print(f"Targets: {TARGET_EARTHQUAKES}, {TARGET_WATER}, {TARGET_PARKS}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Reference Data: Valid Codes & Ranges

# COMMAND ----------

# Earthquake magnitude ranges
MAG_MIN = 0.0
MAG_MAX = 10.0
SIGNIFICANT_MAG_THRESHOLD = 4.5

# Valid magnitude types (USGS standard)
VALID_MAGNITUDE_TYPES = [
    "ML", "MB", "MS", "MW", "MWW", "MWC", "MWB", "MWR",
    "MD", "MH", "MI", "MFA", "ME",
]

# Magnitude type standardization
MAG_TYPE_MAP = {
    "ML": "ML",   # Local/Richter
    "MB": "MB",   # Body wave
    "MS": "MS",   # Surface wave
    "MW": "MW",   # Moment
    "MWW": "MW",  # Moment (W-phase)
    "MWC": "MW",  # Moment (centroid)
    "MWB": "MW",  # Moment (body wave)
    "MWR": "MW",  # Moment (regional)
    "MD": "MD",   # Duration
    "MH": "MH",   # Historic
}

mag_type_expr = create_map([lit(x) for pair in MAG_TYPE_MAP.items() for x in pair])

# Valid earthquake event types
VALID_EVENT_TYPES = [
    "EARTHQUAKE", "QUARRY_BLAST", "EXPLOSION", "SONIC_BOOM",
    "MINING_EXPLOSION", "NUCLEAR_EXPLOSION", "ROCK_BURST",
    "ICE_QUAKE", "LANDSLIDE", "VOLCANIC_ERUPTION",
]

# Region classification by latitude/longitude (simplified US regions)
# Detailed classification happens in Gold layer
REGION_CLASSIFICATIONS = {
    "ALASKA": {"lat_min": 51.0, "lat_max": 72.0, "lon_min": -180.0, "lon_max": -130.0},
    "HAWAII": {"lat_min": 18.0, "lat_max": 23.0, "lon_min": -162.0, "lon_max": -154.0},
    "WEST_COAST": {"lat_min": 32.0, "lat_max": 49.0, "lon_min": -125.0, "lon_max": -114.0},
    "CENTRAL_US": {"lat_min": 25.0, "lat_max": 49.0, "lon_min": -114.0, "lon_max": -80.0},
    "EAST_COAST": {"lat_min": 25.0, "lat_max": 49.0, "lon_min": -80.0, "lon_max": -66.0},
}

# Coordinate validation
LAT_MIN, LAT_MAX = -90.0, 90.0
LON_MIN, LON_MAX = -180.0, 180.0

# USGS water parameter codes and known ranges
WATER_PARAMETER_RANGES = {
    "00060": {"name": "Discharge (cfs)", "min": 0, "max": 5000000},
    "00065": {"name": "Gage Height (ft)", "min": -50, "max": 200},
    "00010": {"name": "Temperature (C)", "min": -5, "max": 50},
    "00095": {"name": "Specific Conductance", "min": 0, "max": 100000},
    "00300": {"name": "Dissolved Oxygen (mg/L)", "min": 0, "max": 30},
    "00400": {"name": "pH", "min": 0, "max": 14},
    "00045": {"name": "Precipitation (in)", "min": 0, "max": 50},
    "63680": {"name": "Turbidity (NTU)", "min": 0, "max": 10000},
}

# Days in each month (non-leap year; leap year handled in logic)
DAYS_IN_MONTH = {1: 31, 2: 28, 3: 31, 4: 30, 5: 31, 6: 30,
                 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31}

print("Reference data loaded:")
print(f"  Magnitude range: {MAG_MIN}-{MAG_MAX}")
print(f"  Significant threshold: >= {SIGNIFICANT_MAG_THRESHOLD}")
print(f"  Magnitude types: {len(VALID_MAGNITUDE_TYPES)}")
print(f"  Event types: {len(VALID_EVENT_TYPES)}")
print(f"  Water parameter codes: {len(WATER_PARAMETER_RANGES)}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 1: Earthquakes (bronze_doi_earthquakes -> silver_doi_earthquakes)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Read Bronze Earthquake Data

# COMMAND ----------

df_eq_bronze = spark.table(SOURCE_EARTHQUAKES)

eq_bronze_count = df_eq_bronze.count()
print(f"Bronze earthquake records: {eq_bronze_count:,}")
print(f"Columns: {len(df_eq_bronze.columns)}")
df_eq_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ### Magnitude & Depth Validation

# COMMAND ----------

df_eq_validated = df_eq_bronze \
    .withColumn("magnitude",
        col("magnitude").cast(DoubleType())) \
    .withColumn("depth_km",
        col("depth_km").cast(DoubleType())) \
    .withColumn("latitude",
        col("latitude").cast(DoubleType())) \
    .withColumn("longitude",
        col("longitude").cast(DoubleType())) \
    .withColumn("event_time",
        to_timestamp(col("event_time"))) \
    .withColumn("magnitude_valid",
        col("magnitude").isNotNull() &
        (col("magnitude") >= MAG_MIN) &
        (col("magnitude") <= MAG_MAX)) \
    .withColumn("depth_valid",
        col("depth_km").isNotNull() & (col("depth_km") > 0)) \
    .withColumn("coords_valid",
        col("latitude").isNotNull() &
        col("longitude").isNotNull() &
        (col("latitude") >= LAT_MIN) & (col("latitude") <= LAT_MAX) &
        (col("longitude") >= LON_MIN) & (col("longitude") <= LON_MAX))

invalid_mag = df_eq_validated.filter(~col("magnitude_valid")).count()
invalid_depth = df_eq_validated.filter(~col("depth_valid")).count()
invalid_coords = df_eq_validated.filter(~col("coords_valid")).count()

print("Earthquake Validation:")
print(f"  Invalid magnitude: {invalid_mag:,}")
print(f"  Invalid depth: {invalid_depth:,}")
print(f"  Invalid coordinates: {invalid_coords:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Magnitude Type Standardization & Event Type Validation

# COMMAND ----------

df_eq_std = df_eq_validated \
    .withColumn("magnitude_type_raw", upper(trim(col("magnitude_type")))) \
    .withColumn("magnitude_type_std",
        coalesce(
            mag_type_expr[upper(trim(col("magnitude_type")))],
            upper(trim(col("magnitude_type")))
        )) \
    .withColumn("event_type_clean",
        upper(regexp_replace(trim(col("event_type")), r"[\s/]+", "_"))) \
    .withColumn("event_type_valid",
        col("event_type_clean").isin(VALID_EVENT_TYPES))

invalid_event_type = df_eq_std.filter(~col("event_type_valid") & col("event_type").isNotNull()).count()
print(f"Invalid event types: {invalid_event_type:,}")

print("\nMagnitude Type Distribution:")
display(
    df_eq_std
    .groupBy("magnitude_type_raw", "magnitude_type_std")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Deduplication

# COMMAND ----------

before_dedup_eq = df_eq_std.count()

df_eq_deduped = df_eq_std.dropDuplicates(["event_id"])

after_dedup_eq = df_eq_deduped.count()
dupes_removed_eq = before_dedup_eq - after_dedup_eq

print(f"Earthquake Deduplication Results:")
print(f"  Before: {before_dedup_eq:,}")
print(f"  After: {after_dedup_eq:,}")
print(f"  Duplicates removed: {dupes_removed_eq:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Derived Fields
# MAGIC
# MAGIC - is_significant: magnitude >= 4.5
# MAGIC - region_classification: based on latitude/longitude

# COMMAND ----------

df_eq_derived = df_eq_deduped \
    .withColumn("is_significant",
        (col("magnitude") >= SIGNIFICANT_MAG_THRESHOLD).cast("boolean")) \
    .withColumn("region_classification",
        when(
            (col("latitude") >= 51.0) & (col("latitude") <= 72.0) &
            (col("longitude") >= -180.0) & (col("longitude") <= -130.0),
            lit("ALASKA")
        ).when(
            (col("latitude") >= 18.0) & (col("latitude") <= 23.0) &
            (col("longitude") >= -162.0) & (col("longitude") <= -154.0),
            lit("HAWAII")
        ).when(
            (col("latitude") >= 32.0) & (col("latitude") <= 49.0) &
            (col("longitude") >= -125.0) & (col("longitude") <= -114.0),
            lit("WEST_COAST")
        ).when(
            (col("latitude") >= 25.0) & (col("latitude") <= 49.0) &
            (col("longitude") >= -114.0) & (col("longitude") <= -80.0),
            lit("CENTRAL_US")
        ).when(
            (col("latitude") >= 25.0) & (col("latitude") <= 49.0) &
            (col("longitude") >= -80.0) & (col("longitude") <= -66.0),
            lit("EAST_COAST")
        ).otherwise(lit("INTERNATIONAL"))
    ) \
    .withColumn("event_date", to_date(col("event_time"))) \
    .withColumn("event_year", year(col("event_time"))) \
    .withColumn("event_month", month(col("event_time"))) \
    .withColumn("magnitude_class",
        when(col("magnitude") < 2.0, lit("MICRO"))
        .when(col("magnitude") < 4.0, lit("MINOR"))
        .when(col("magnitude") < 5.0, lit("LIGHT"))
        .when(col("magnitude") < 6.0, lit("MODERATE"))
        .when(col("magnitude") < 7.0, lit("STRONG"))
        .when(col("magnitude") < 8.0, lit("MAJOR"))
        .otherwise(lit("GREAT"))
    )

print("Derived fields added:")
print(f"  is_significant: magnitude >= {SIGNIFICANT_MAG_THRESHOLD}")
print("  region_classification: ALASKA, HAWAII, WEST_COAST, CENTRAL_US, EAST_COAST, INTERNATIONAL")
print("  magnitude_class: MICRO, MINOR, LIGHT, MODERATE, STRONG, MAJOR, GREAT")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Earthquake Data Quality Score
# MAGIC
# MAGIC | Check | Points |
# MAGIC |-------|--------|
# MAGIC | Valid magnitude (0-10) | 25 |
# MAGIC | Valid coordinates | 25 |
# MAGIC | Valid depth (> 0) | 25 |
# MAGIC | Complete metadata (event_time, place, source) | 25 |

# COMMAND ----------

df_eq_dq = df_eq_derived \
    .withColumn("_dq_score",
        (
            when(col("magnitude_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("coords_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("depth_valid") == True, lit(25)).otherwise(lit(0)) +
            when(
                col("event_time").isNotNull() &
                col("place").isNotNull() &
                col("source").isNotNull(),
                lit(25)
            ).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(col("magnitude_valid") == False, lit("INVALID_MAGNITUDE")),
                when(col("coords_valid") == False, lit("INVALID_COORDINATES")),
                when(col("depth_valid") == False, lit("INVALID_DEPTH")),
                when(col("event_time").isNull(), lit("MISSING_EVENT_TIME")),
                when(col("place").isNull(), lit("MISSING_PLACE")),
                when(col("event_type_valid") == False, lit("INVALID_EVENT_TYPE"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Silver Metadata & Write Earthquake Table

# COMMAND ----------

try:
    df_eq_silver = df_eq_dq \
        .withColumn("_silver_timestamp", current_timestamp()) \
        .withColumn("_batch_id", lit(batch_id))

    eq_columns = [
        # Identifiers
        "event_id",
        # Event details
        "event_time", "event_date", "event_year", "event_month",
        "event_type_clean", "event_type_valid",
        # Magnitude
        "magnitude", "magnitude_valid", "magnitude_type_std",
        "magnitude_class", "is_significant",
        # Location
        "latitude", "longitude", "coords_valid",
        "depth_km", "depth_valid",
        "place", "region_classification",
        # Source
        "source", "status", "net",
        "nst", "gap", "dmin", "rms",
        # Impact
        "felt", "cdi", "mmi", "tsunami", "sig",
        # Quality & metadata
        "_dq_score", "_dq_flags", "_silver_timestamp", "_batch_id",
    ]

    df_eq_out = df_eq_silver.select(
        [col(c) for c in eq_columns if c in df_eq_silver.columns]
    )

    # Write to Silver layer using Delta MERGE (incremental upsert)
    if spark.catalog.tableExists(TARGET_EARTHQUAKES):
        deltaTable = DeltaTable.forName(spark, TARGET_EARTHQUAKES)
        deltaTable.alias("target").merge(
            df_eq_out.alias("source"),
            "target.event_id = source.event_id"
        ).whenMatchedUpdateAll(
            condition="target._silver_timestamp < source._silver_timestamp"
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_eq_out.write \
            .format("delta") \
            .mode("overwrite") \
            .partitionBy("event_year") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_EARTHQUAKES)

    eq_silver_count = spark.table(TARGET_EARTHQUAKES).count()
    print(f"Written/merged records to {TARGET_EARTHQUAKES} (total: {eq_silver_count:,})")
except Exception as e:
    print(f"ERROR in unknown (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 2: Water Data (bronze_doi_water_data -> silver_doi_water_data)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Read Bronze Water Data

# COMMAND ----------

df_water_bronze = spark.table(SOURCE_WATER)

water_bronze_count = df_water_bronze.count()
print(f"Bronze water data records: {water_bronze_count:,}")
print(f"Columns: {len(df_water_bronze.columns)}")
df_water_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ### Parameter Value Validation & Unit Standardization

# COMMAND ----------

# Build parameter range validation expression
# Check if value is within known range for the parameter code
param_range_conditions = [
    when(
        (col("parameter_code") == code) &
        (col("value").cast(DoubleType()) >= info["min"]) &
        (col("value").cast(DoubleType()) <= info["max"]),
        lit(True)
    )
    for code, info in WATER_PARAMETER_RANGES.items()
]

df_water_validated = df_water_bronze \
    .withColumn("value_numeric",
        col("value").cast(DoubleType())) \
    .withColumn("measurement_date_parsed",
        to_date(col("measurement_date"))) \
    .withColumn("latitude",
        col("latitude").cast(DoubleType())) \
    .withColumn("longitude",
        col("longitude").cast(DoubleType())) \
    .withColumn("parameter_code_clean", trim(col("parameter_code"))) \
    .withColumn("value_in_range",
        coalesce(*param_range_conditions, lit(True))  # Default True for unknown params
    ) \
    .withColumn("coords_valid",
        col("latitude").isNotNull() &
        col("longitude").isNotNull() &
        (col("latitude") >= LAT_MIN) & (col("latitude") <= LAT_MAX) &
        (col("longitude") >= LON_MIN) & (col("longitude") <= LON_MAX)) \
    .withColumn("unit_std",
        coalesce(trim(col("unit")), lit("unknown")))

# Map parameter codes to human-readable names
param_name_conditions = [
    when(col("parameter_code_clean") == code, lit(info["name"]))
    for code, info in WATER_PARAMETER_RANGES.items()
]

df_water_named = df_water_validated \
    .withColumn("parameter_name_derived",
        coalesce(*param_name_conditions, col("parameter_name"), lit("Unknown Parameter")))

out_of_range = df_water_named.filter(col("value_in_range") == False).count()
print(f"Records with values out of known range: {out_of_range:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Deduplication

# COMMAND ----------

before_dedup_water = df_water_named.count()

df_water_deduped = df_water_named.dropDuplicates([
    "site_id", "measurement_date_parsed", "parameter_code_clean"
])

after_dedup_water = df_water_deduped.count()
dupes_removed_water = before_dedup_water - after_dedup_water

print(f"Water Data Deduplication Results:")
print(f"  Before: {before_dedup_water:,}")
print(f"  After: {after_dedup_water:,}")
print(f"  Duplicates removed: {dupes_removed_water:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Water Data Quality Score

# COMMAND ----------

df_water_dq = df_water_deduped \
    .withColumn("_dq_score",
        (
            when(col("site_id").isNotNull(), lit(20)).otherwise(lit(0)) +
            when(col("parameter_code_clean").isNotNull(), lit(20)).otherwise(lit(0)) +
            when(col("value_numeric").isNotNull(), lit(20)).otherwise(lit(0)) +
            when(col("value_in_range") == True, lit(20)).otherwise(lit(0)) +
            when(col("coords_valid") == True, lit(20)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(col("site_id").isNull(), lit("MISSING_SITE_ID")),
                when(col("parameter_code_clean").isNull(), lit("MISSING_PARAMETER_CODE")),
                when(col("value_numeric").isNull(), lit("MISSING_VALUE")),
                when(col("value_in_range") == False, lit("VALUE_OUT_OF_RANGE")),
                when(col("coords_valid") == False, lit("INVALID_COORDINATES"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Silver Metadata & Write Water Data Table

# COMMAND ----------

df_water_silver = df_water_dq \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id)) \
    .withColumn("measurement_year", year(col("measurement_date_parsed")))

water_columns = [
    # Identifiers
    "site_id", "site_name", "agency_code",
    # Measurement
    "parameter_code_clean", "parameter_name_derived",
    "value_numeric", "value_in_range",
    "unit_std", "qualification_code",
    "measurement_date_parsed", "measurement_year",
    # Location
    "latitude", "longitude", "coords_valid",
    "state", "county", "huc_code",
    # Quality & metadata
    "_dq_score", "_dq_flags", "_silver_timestamp", "_batch_id",
]

df_water_out = df_water_silver.select(
    [col(c) for c in water_columns if c in df_water_silver.columns]
)

# Write to Silver layer using Delta MERGE (incremental upsert)
if spark.catalog.tableExists(TARGET_WATER):
    deltaTable = DeltaTable.forName(spark, TARGET_WATER)
    deltaTable.alias("target").merge(
        df_water_out.alias("source"),
        "target.site_id = source.site_id AND target.measurement_date_parsed = source.measurement_date_parsed AND target.parameter_code_clean = source.parameter_code_clean"
    ).whenMatchedUpdateAll(
        condition="target._silver_timestamp < source._silver_timestamp"
    ).whenNotMatchedInsertAll(
    ).execute()
else:
    df_water_out.write \
        .format("delta") \
        .mode("overwrite") \
        .partitionBy("measurement_year") \
        .option("overwriteSchema", "true") \
        .saveAsTable(TARGET_WATER)

water_silver_count = spark.table(TARGET_WATER).count()
print(f"Written/merged records to {TARGET_WATER} (total: {water_silver_count:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 3: Park Visitation (bronze_doi_park_visitation -> silver_doi_park_visitation)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Read Bronze Park Visitation Data

# COMMAND ----------

df_parks_bronze = spark.table(SOURCE_PARKS)

parks_bronze_count = df_parks_bronze.count()
print(f"Bronze park visitation records: {parks_bronze_count:,}")
print(f"Columns: {len(df_parks_bronze.columns)}")
df_parks_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ### Visitor Count & Month Validation

# COMMAND ----------

df_parks_validated = df_parks_bronze \
    .withColumn("visitor_count",
        col("visitor_count").cast(LongType())) \
    .withColumn("year_val",
        col("year").cast(IntegerType())) \
    .withColumn("month_val",
        col("month").cast(IntegerType())) \
    .withColumn("park_code_clean", upper(trim(col("park_code")))) \
    .withColumn("visitor_count_valid",
        col("visitor_count").isNotNull() & (col("visitor_count") >= 0)) \
    .withColumn("month_valid",
        col("month_val").isNotNull() &
        (col("month_val") >= 1) & (col("month_val") <= 12)) \
    .withColumn("year_valid",
        col("year_val").isNotNull() &
        (col("year_val") >= 1900) & (col("year_val") <= year(current_date())))

invalid_visitors = df_parks_validated.filter(~col("visitor_count_valid")).count()
invalid_months = df_parks_validated.filter(~col("month_valid")).count()
invalid_years = df_parks_validated.filter(~col("year_valid")).count()

print("Park Visitation Validation:")
print(f"  Invalid visitor counts: {invalid_visitors:,}")
print(f"  Invalid months: {invalid_months:,}")
print(f"  Invalid years: {invalid_years:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Deduplication

# COMMAND ----------

before_dedup_parks = df_parks_validated.count()

df_parks_deduped = df_parks_validated.dropDuplicates([
    "park_code_clean", "year_val", "month_val"
])

after_dedup_parks = df_parks_deduped.count()
dupes_removed_parks = before_dedup_parks - after_dedup_parks

print(f"Park Visitation Deduplication Results:")
print(f"  Before: {before_dedup_parks:,}")
print(f"  After: {after_dedup_parks:,}")
print(f"  Duplicates removed: {dupes_removed_parks:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Derived Fields: Average Daily Visitors
# MAGIC
# MAGIC Calculate avg_daily_visitors = visitor_count / days_in_month.
# MAGIC Accounts for leap years in February.

# COMMAND ----------

# Build days_in_month expression
days_in_month_expr = (
    when(col("month_val") == 2,
        when(
            (col("year_val") % 4 == 0) &
            ((col("year_val") % 100 != 0) | (col("year_val") % 400 == 0)),
            lit(29)
        ).otherwise(lit(28))
    )
    .when(col("month_val").isin(4, 6, 9, 11), lit(30))
    .otherwise(lit(31))
)

df_parks_derived = df_parks_deduped \
    .withColumn("days_in_month", days_in_month_expr) \
    .withColumn("avg_daily_visitors",
        when(
            col("visitor_count_valid") & col("month_valid") & (col("days_in_month") > 0),
            round(col("visitor_count") / col("days_in_month"), 0).cast(LongType())
        ).otherwise(lit(None).cast(LongType()))
    )

print("Derived fields added:")
print("  days_in_month: Based on month + leap year logic")
print("  avg_daily_visitors: visitor_count / days_in_month")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Park Visitation Data Quality Score

# COMMAND ----------

df_parks_dq = df_parks_derived \
    .withColumn("_dq_score",
        (
            when(col("park_code_clean").isNotNull(), lit(20)).otherwise(lit(0)) +
            when(col("visitor_count_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("month_valid") == True, lit(20)).otherwise(lit(0)) +
            when(col("year_valid") == True, lit(20)).otherwise(lit(0)) +
            when(col("park_name").isNotNull(), lit(15)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(col("park_code_clean").isNull(), lit("MISSING_PARK_CODE")),
                when(col("visitor_count_valid") == False, lit("INVALID_VISITOR_COUNT")),
                when(col("month_valid") == False, lit("INVALID_MONTH")),
                when(col("year_valid") == False, lit("INVALID_YEAR")),
                when(col("park_name").isNull(), lit("MISSING_PARK_NAME"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Silver Metadata & Write Park Visitation Table

# COMMAND ----------

df_parks_silver = df_parks_dq \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

parks_columns = [
    # Identifiers
    "park_code_clean", "park_name",
    # Visitation
    "year_val", "month_val", "days_in_month",
    "visitor_count", "visitor_count_valid",
    "avg_daily_visitors",
    # Park info
    "park_type", "region", "state",
    # Validation
    "month_valid", "year_valid",
    # Quality & metadata
    "_dq_score", "_dq_flags", "_silver_timestamp", "_batch_id",
]

df_parks_out = df_parks_silver.select(
    [col(c) for c in parks_columns if c in df_parks_silver.columns]
)

# Write to Silver layer using Delta MERGE (incremental upsert)
if spark.catalog.tableExists(TARGET_PARKS):
    deltaTable = DeltaTable.forName(spark, TARGET_PARKS)
    deltaTable.alias("target").merge(
        df_parks_out.alias("source"),
        "target.park_code_clean = source.park_code_clean AND target.year_val = source.year_val AND target.month_val = source.month_val"
    ).whenMatchedUpdateAll(
        condition="target._silver_timestamp < source._silver_timestamp"
    ).whenNotMatchedInsertAll(
    ).execute()
else:
    df_parks_out.write \
        .format("delta") \
        .mode("overwrite") \
        .partitionBy("year_val") \
        .option("overwriteSchema", "true") \
        .saveAsTable(TARGET_PARKS)

parks_silver_count = spark.table(TARGET_PARKS).count()
print(f"Written/merged records to {TARGET_PARKS} (total: {parks_silver_count:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Report

# COMMAND ----------

print("=" * 60)
print("DOI Silver Layer - Data Quality Report")
print("=" * 60)

# Earthquake quality
print(f"\n--- {TARGET_EARTHQUAKES} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        ROUND(MIN(_dq_score), 2) as min_quality_score,
        ROUND(MAX(_dq_score), 2) as max_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(CASE WHEN _dq_score < 50 THEN 1 END) as low_quality_records,
        COUNT(CASE WHEN is_significant THEN 1 END) as significant_events
    FROM {TARGET_EARTHQUAKES}
""").show(truncate=False)

# COMMAND ----------

# Earthquake magnitude distribution
print("Earthquake Magnitude Class Distribution:")
spark.sql(f"""
    SELECT
        magnitude_class,
        COUNT(*) as events,
        ROUND(AVG(magnitude), 2) as avg_magnitude,
        ROUND(MAX(magnitude), 2) as max_magnitude,
        COUNT(CASE WHEN is_significant THEN 1 END) as significant
    FROM {TARGET_EARTHQUAKES}
    GROUP BY magnitude_class
    ORDER BY avg_magnitude
""").show(truncate=False)

# COMMAND ----------

# Earthquake region distribution
print("Earthquake Region Distribution:")
spark.sql(f"""
    SELECT
        region_classification,
        COUNT(*) as events,
        ROUND(AVG(magnitude), 2) as avg_magnitude,
        ROUND(MAX(magnitude), 2) as max_magnitude
    FROM {TARGET_EARTHQUAKES}
    GROUP BY region_classification
    ORDER BY events DESC
""").show(truncate=False)

# COMMAND ----------

# Water data quality
print(f"\n--- {TARGET_WATER} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(CASE WHEN value_in_range = false THEN 1 END) as out_of_range,
        COUNT(DISTINCT site_id) as unique_sites,
        COUNT(DISTINCT parameter_code_clean) as unique_parameters
    FROM {TARGET_WATER}
""").show(truncate=False)

# COMMAND ----------

# Park visitation quality
print(f"\n--- {TARGET_PARKS} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(DISTINCT park_code_clean) as unique_parks,
        SUM(visitor_count) as total_visitors
    FROM {TARGET_PARKS}
""").show(truncate=False)

# COMMAND ----------

# Top parks by total visitation
print("Top 10 Parks by Total Visitation:")
spark.sql(f"""
    SELECT
        park_code_clean as park_code,
        park_name,
        SUM(visitor_count) as total_visitors,
        ROUND(AVG(avg_daily_visitors), 0) as avg_daily
    FROM {TARGET_PARKS}
    WHERE visitor_count_valid = true
    GROUP BY park_code_clean, park_name
    ORDER BY total_visitors DESC
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize Tables

# COMMAND ----------

spark.sql(f"OPTIMIZE {TARGET_EARTHQUAKES} ZORDER BY (event_id, region_classification)")
print(f"Optimized {TARGET_EARTHQUAKES} with Z-Order on event_id, region_classification")

spark.sql(f"OPTIMIZE {TARGET_WATER} ZORDER BY (site_id, parameter_code_clean)")
print(f"Optimized {TARGET_WATER} with Z-Order on site_id, parameter_code_clean")

spark.sql(f"OPTIMIZE {TARGET_PARKS} ZORDER BY (park_code_clean)")
print(f"Optimized {TARGET_PARKS} with Z-Order on park_code_clean")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation Queries

# COMMAND ----------

# Verify no duplicate event_ids in earthquakes
eq_dup = spark.sql(f"""
    SELECT event_id, COUNT(*) as cnt
    FROM {TARGET_EARTHQUAKES}
    GROUP BY event_id
    HAVING cnt > 1
""")
print(f"Earthquake duplicate event_ids (should be 0): {eq_dup.count()}")

# Verify no duplicate keys in water data
water_dup = spark.sql(f"""
    SELECT site_id, measurement_date_parsed, parameter_code_clean, COUNT(*) as cnt
    FROM {TARGET_WATER}
    GROUP BY site_id, measurement_date_parsed, parameter_code_clean
    HAVING cnt > 1
""")
print(f"Water data duplicate keys (should be 0): {water_dup.count()}")

# Verify no duplicate keys in park visitation
parks_dup = spark.sql(f"""
    SELECT park_code_clean, year_val, month_val, COUNT(*) as cnt
    FROM {TARGET_PARKS}
    GROUP BY park_code_clean, year_val, month_val
    HAVING cnt > 1
""")
print(f"Park visitation duplicate keys (should be 0): {parks_dup.count()}")

# Verify magnitude ranges
mag_out = spark.sql(f"""
    SELECT COUNT(*) as cnt
    FROM {TARGET_EARTHQUAKES}
    WHERE magnitude_valid = false
""").collect()[0]["cnt"]
print(f"Earthquake records with invalid magnitude: {mag_out}")

# Verify visitor counts are non-negative
neg_visitors = spark.sql(f"""
    SELECT COUNT(*) as cnt
    FROM {TARGET_PARKS}
    WHERE visitor_count < 0
""").collect()[0]["cnt"]
print(f"Park records with negative visitor count (should be 0): {neg_visitors}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Source Table | Target Table | Key Transformations |
# MAGIC |-------------|-------------|---------------------|
# MAGIC | bronze_doi_earthquakes | silver_doi_earthquakes | Magnitude validation 0-10, depth > 0, coords validation, region classification, is_significant |
# MAGIC | bronze_doi_water_data | silver_doi_water_data | Parameter value range validation, unit standardization, coords validation |
# MAGIC | bronze_doi_park_visitation | silver_doi_park_visitation | Visitor count >= 0, month 1-12, avg_daily_visitors derived |
# MAGIC
# MAGIC **Next Step:** Continue to Gold layer for DOI analytics (seismic risk, hydrology, park trends).
