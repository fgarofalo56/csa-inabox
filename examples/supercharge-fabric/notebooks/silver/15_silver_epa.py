# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: EPA Environmental Data Cleansing & Standardization
# MAGIC
# MAGIC This notebook transforms Bronze EPA data into cleansed, validated,
# MAGIC and enriched Silver layer tables.
# MAGIC
# MAGIC ## Transformations Applied:
# MAGIC - AQI validation (0-500) and category mapping
# MAGIC - EPA standard parameter name validation
# MAGIC - CAS number format validation for toxic releases
# MAGIC - Release total = sum of media releases verification
# MAGIC - Chemical name standardization
# MAGIC - Contaminant and MCL violation validation for water quality
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
    abs,
    array,
    array_compact,
    coalesce,
    col,
    count,
    create_map,
    current_timestamp,
    desc,
    filter,
    greatest,
    initcap,
    length,
    lit,
    max,
    round,
    to_date,
    trim,
    upper,
    when,
    year,
)
from pyspark.sql.types import DoubleType, IntegerType

# Parameters (set by pipeline or manual)
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source tables (Bronze)
SOURCE_AIR = "lh_bronze.bronze_epa_air_quality"
SOURCE_TRI = "lh_bronze.bronze_epa_toxic_releases"
SOURCE_WATER = "lh_bronze.bronze_epa_water_quality"

# Target tables (Silver)
TARGET_AIR = "lh_silver.silver_epa_air_quality"
TARGET_TRI = "lh_silver.silver_epa_toxic_releases"
TARGET_WATER = "lh_silver.silver_epa_water_quality"

print(f"Processing batch: {batch_id}")
print(f"Sources: {SOURCE_AIR}, {SOURCE_TRI}, {SOURCE_WATER}")
print(f"Targets: {TARGET_AIR}, {TARGET_TRI}, {TARGET_WATER}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Reference Data: EPA Standards & Validation

# COMMAND ----------

# EPA AQI categories and breakpoints
AQI_MIN = 0
AQI_MAX = 500

AQI_CATEGORIES = {
    (0, 50): "Good",
    (51, 100): "Moderate",
    (101, 150): "Unhealthy for Sensitive Groups",
    (151, 200): "Unhealthy",
    (201, 300): "Very Unhealthy",
    (301, 500): "Hazardous",
}

# EPA standard air quality parameters (criteria pollutants + common others)
VALID_AIR_PARAMETERS = [
    "PM2.5", "PM10", "OZONE", "O3",
    "NO2", "SO2", "CO", "LEAD", "PB",
    "PM2.5_LOCAL", "PM10_LOCAL",
    "NOX", "VOC", "HAP",
    "AQI",
]

# CAS number format: digits-digits-digit (e.g., 50-00-0 for formaldehyde)
CAS_PATTERN = r"^\d{2,7}-\d{2}-\d$"

# Common chemical name standardization
CHEMICAL_NAME_MAP = {
    "FORMALDEHYDE": "Formaldehyde",
    "METHANOL": "Methanol",
    "TOLUENE": "Toluene",
    "XYLENE": "Xylene (Mixed Isomers)",
    "BENZENE": "Benzene",
    "LEAD": "Lead",
    "LEAD COMPOUNDS": "Lead Compounds",
    "MERCURY": "Mercury",
    "MERCURY COMPOUNDS": "Mercury Compounds",
    "AMMONIA": "Ammonia",
    "HYDROCHLORIC ACID": "Hydrochloric Acid",
    "SULFURIC ACID": "Sulfuric Acid",
    "NITRIC ACID": "Nitric Acid",
    "CHLORINE": "Chlorine",
    "STYRENE": "Styrene",
    "ETHYLENE": "Ethylene",
    "MANGANESE": "Manganese",
    "MANGANESE COMPOUNDS": "Manganese Compounds",
    "ZINC COMPOUNDS": "Zinc Compounds",
    "COPPER COMPOUNDS": "Copper Compounds",
    "CHROMIUM COMPOUNDS": "Chromium Compounds",
    "NICKEL COMPOUNDS": "Nickel Compounds",
    "BARIUM COMPOUNDS": "Barium Compounds",
    "N-HEXANE": "n-Hexane",
    "METHYL ETHYL KETONE": "Methyl Ethyl Ketone",
    "GLYCOL ETHERS": "Glycol Ethers",
    "CERTAIN GLYCOL ETHERS": "Certain Glycol Ethers",
}

chemical_name_expr = create_map([lit(x) for pair in CHEMICAL_NAME_MAP.items() for x in pair])

# NAICS pattern for TRI facilities
NAICS_PATTERN = r"^\d{2,6}$"

# Coordinate validation
LAT_MIN, LAT_MAX = -90.0, 90.0
LON_MIN, LON_MAX = -180.0, 180.0

print("Reference data loaded:")
print(f"  AQI range: {AQI_MIN}-{AQI_MAX}")
print(f"  Air parameters: {len(VALID_AIR_PARAMETERS)}")
print(f"  Chemical name mappings: {len(CHEMICAL_NAME_MAP)}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 1: Air Quality (bronze_epa_air_quality -> silver_epa_air_quality)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Read Bronze Air Quality Data

# COMMAND ----------

df_air_bronze = spark.table(SOURCE_AIR)

air_bronze_count = df_air_bronze.count()
print(f"Bronze air quality records: {air_bronze_count:,}")
print(f"Columns: {len(df_air_bronze.columns)}")
df_air_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ### AQI Validation & Category Mapping

# COMMAND ----------

df_air_validated = df_air_bronze \
    .withColumn("aqi_value",
        col("aqi").cast(IntegerType())) \
    .withColumn("aqi_valid",
        col("aqi_value").isNotNull() &
        (col("aqi_value") >= AQI_MIN) &
        (col("aqi_value") <= AQI_MAX)) \
    .withColumn("aqi_category_derived",
        when((col("aqi_value") >= 0) & (col("aqi_value") <= 50), lit("Good"))
        .when((col("aqi_value") >= 51) & (col("aqi_value") <= 100), lit("Moderate"))
        .when((col("aqi_value") >= 101) & (col("aqi_value") <= 150), lit("Unhealthy for Sensitive Groups"))
        .when((col("aqi_value") >= 151) & (col("aqi_value") <= 200), lit("Unhealthy"))
        .when((col("aqi_value") >= 201) & (col("aqi_value") <= 300), lit("Very Unhealthy"))
        .when((col("aqi_value") >= 301) & (col("aqi_value") <= 500), lit("Hazardous"))
        .otherwise(lit("Unknown"))
    ) \
    .withColumn("aqi_category_final",
        coalesce(col("aqi_category"), col("aqi_category_derived")))

invalid_aqi = df_air_validated.filter(~col("aqi_valid") & col("aqi").isNotNull()).count()
print(f"Records with invalid AQI (should be 0): {invalid_aqi:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Parameter Name Validation

# COMMAND ----------

df_air_param = df_air_validated \
    .withColumn("parameter_name_clean", upper(trim(col("parameter_name")))) \
    .withColumn("parameter_valid",
        col("parameter_name_clean").isin(VALID_AIR_PARAMETERS))

invalid_params = df_air_param.filter(~col("parameter_valid") & col("parameter_name").isNotNull()).count()
print(f"Records with invalid parameter names: {invalid_params:,}")

print("\nParameter Distribution:")
display(
    df_air_param
    .groupBy("parameter_name_clean", "parameter_valid")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Coordinate Validation & Timestamp Processing

# COMMAND ----------

df_air_coords = df_air_param \
    .withColumn("latitude", col("latitude").cast(DoubleType())) \
    .withColumn("longitude", col("longitude").cast(DoubleType())) \
    .withColumn("coords_valid",
        col("latitude").isNotNull() &
        col("longitude").isNotNull() &
        (col("latitude") >= LAT_MIN) & (col("latitude") <= LAT_MAX) &
        (col("longitude") >= LON_MIN) & (col("longitude") <= LON_MAX)) \
    .withColumn("measurement_date",
        to_date(col("measurement_date"))) \
    .withColumn("measurement_hour",
        col("measurement_hour").cast(IntegerType())) \
    .withColumn("timestamp_complete",
        col("measurement_date").isNotNull() &
        col("measurement_hour").isNotNull() &
        (col("measurement_hour") >= 0) & (col("measurement_hour") <= 23))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Deduplication

# COMMAND ----------

before_dedup_air = df_air_coords.count()

df_air_deduped = df_air_coords.dropDuplicates([
    "station_id", "parameter_name_clean", "measurement_date", "measurement_hour"
])

after_dedup_air = df_air_deduped.count()
dupes_removed_air = before_dedup_air - after_dedup_air

print(f"Air Quality Deduplication Results:")
print(f"  Before: {before_dedup_air:,}")
print(f"  After: {after_dedup_air:,}")
print(f"  Duplicates removed: {dupes_removed_air:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Air Quality Data Quality Score
# MAGIC
# MAGIC | Check | Points |
# MAGIC |-------|--------|
# MAGIC | Valid AQI (0-500) | 25 |
# MAGIC | Valid parameter name | 25 |
# MAGIC | Valid coordinates | 25 |
# MAGIC | Complete timestamps | 25 |

# COMMAND ----------

df_air_dq = df_air_deduped \
    .withColumn("_dq_score",
        (
            when(col("aqi_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("parameter_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("coords_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("timestamp_complete") == True, lit(25)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(col("aqi_valid") == False, lit("INVALID_AQI")),
                when(col("parameter_valid") == False, lit("INVALID_PARAMETER")),
                when(col("coords_valid") == False, lit("INVALID_COORDINATES")),
                when(col("timestamp_complete") == False, lit("INCOMPLETE_TIMESTAMP"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Silver Metadata & Write Air Quality Table

# COMMAND ----------

try:
    df_air_silver = df_air_dq \
        .withColumn("_silver_timestamp", current_timestamp()) \
        .withColumn("_batch_id", lit(batch_id))

    air_columns = [
        # Identifiers
        "station_id", "station_name", "site_number",
        # Measurement
        "parameter_name_clean", "parameter_valid",
        "aqi_value", "aqi_valid", "aqi_category_final",
        "measurement_value", "units_of_measure",
        "measurement_date", "measurement_hour", "timestamp_complete",
        # Location
        "latitude", "longitude", "coords_valid",
        "state_code", "county_code", "city", "state",
        # Quality & metadata
        "_dq_score", "_dq_flags", "_silver_timestamp", "_batch_id",
    ]

    df_air_out = df_air_silver.select(
        [col(c) for c in air_columns if c in df_air_silver.columns]
    )

    # Write to Silver layer using Delta MERGE (incremental upsert)
    if spark.catalog.tableExists(TARGET_AIR):
        deltaTable = DeltaTable.forName(spark, TARGET_AIR)
        deltaTable.alias("target").merge(
            df_air_out.alias("source"),
            "target.station_id = source.station_id AND target.parameter_name_clean = source.parameter_name_clean AND target.measurement_date = source.measurement_date AND target.measurement_hour = source.measurement_hour"
        ).whenMatchedUpdateAll(
            condition="target._silver_timestamp < source._silver_timestamp"
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_air_out.write \
            .format("delta") \
            .mode("overwrite") \
            .partitionBy("measurement_date") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_AIR)

    air_silver_count = spark.table(TARGET_AIR).count()
    print(f"Written/merged records to {TARGET_AIR} (total: {air_silver_count:,})")
except Exception as e:
    print(f"ERROR in unknown (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 2: Toxic Releases (bronze_epa_toxic_releases -> silver_epa_toxic_releases)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Read Bronze TRI Data

# COMMAND ----------

df_tri_bronze = spark.table(SOURCE_TRI)

tri_bronze_count = df_tri_bronze.count()
print(f"Bronze TRI records: {tri_bronze_count:,}")
print(f"Columns: {len(df_tri_bronze.columns)}")
df_tri_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ### CAS Number Validation & Chemical Name Standardization

# COMMAND ----------

df_tri_validated = df_tri_bronze \
    .withColumn("cas_number_clean", trim(col("cas_number"))) \
    .withColumn("cas_valid",
        col("cas_number_clean").rlike(CAS_PATTERN)) \
    .withColumn("chemical_name_upper", upper(trim(col("chemical_name")))) \
    .withColumn("chemical_name_std",
        coalesce(
            chemical_name_expr[upper(trim(col("chemical_name")))],
            initcap(trim(col("chemical_name")))
        ))

valid_cas = df_tri_validated.filter(col("cas_valid") == True).count()
invalid_cas = df_tri_validated.filter(col("cas_valid") == False).count()

print("CAS Number Validation:")
print(f"  Valid CAS numbers: {valid_cas:,}")
print(f"  Invalid CAS numbers: {invalid_cas:,}")
print(f"  Validation rate: {valid_cas / max(valid_cas + invalid_cas, 1) * 100:.1f}%")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Release Total Validation & Coordinate Validation
# MAGIC
# MAGIC Verify that total_release = sum of individual media releases (air, water, land, etc.)

# COMMAND ----------

df_tri_releases = df_tri_validated \
    .withColumn("fugitive_air",
        coalesce(col("fugitive_air_releases"), lit(0.0)).cast(DoubleType())) \
    .withColumn("stack_air",
        coalesce(col("stack_air_releases"), lit(0.0)).cast(DoubleType())) \
    .withColumn("water_releases_val",
        coalesce(col("water_releases"), lit(0.0)).cast(DoubleType())) \
    .withColumn("underground_releases_val",
        coalesce(col("underground_releases"), lit(0.0)).cast(DoubleType())) \
    .withColumn("land_releases_val",
        coalesce(col("land_releases"), lit(0.0)).cast(DoubleType())) \
    .withColumn("total_releases_reported",
        coalesce(col("total_releases"), lit(0.0)).cast(DoubleType())) \
    .withColumn("total_calculated_releases",
        round(
            col("fugitive_air") + col("stack_air") +
            col("water_releases_val") + col("underground_releases_val") +
            col("land_releases_val"),
            4
        )
    ) \
    .withColumn("totals_balanced",
        (col("total_releases_reported") == 0) |
        (abs(col("total_calculated_releases") - col("total_releases_reported")) /
         greatest(col("total_releases_reported"), lit(0.001)) < 0.05)
    )

# Release media breakdown percentages
df_tri_pct = df_tri_releases \
    .withColumn("pct_fugitive_air",
        when(col("total_calculated_releases") > 0,
            round(col("fugitive_air") / col("total_calculated_releases") * 100, 2))
        .otherwise(lit(0.0))) \
    .withColumn("pct_stack_air",
        when(col("total_calculated_releases") > 0,
            round(col("stack_air") / col("total_calculated_releases") * 100, 2))
        .otherwise(lit(0.0))) \
    .withColumn("pct_water",
        when(col("total_calculated_releases") > 0,
            round(col("water_releases_val") / col("total_calculated_releases") * 100, 2))
        .otherwise(lit(0.0))) \
    .withColumn("pct_land",
        when(col("total_calculated_releases") > 0,
            round(col("land_releases_val") / col("total_calculated_releases") * 100, 2))
        .otherwise(lit(0.0)))

# Coordinate validation
df_tri_coords = df_tri_pct \
    .withColumn("latitude", col("latitude").cast(DoubleType())) \
    .withColumn("longitude", col("longitude").cast(DoubleType())) \
    .withColumn("coords_valid",
        col("latitude").isNotNull() &
        col("longitude").isNotNull() &
        (col("latitude") >= LAT_MIN) & (col("latitude") <= LAT_MAX) &
        (col("longitude") >= LON_MIN) & (col("longitude") <= LON_MAX))

# NAICS validation
df_tri_naics = df_tri_coords \
    .withColumn("naics_code_clean", trim(col("naics_code"))) \
    .withColumn("naics_valid",
        col("naics_code_clean").rlike(NAICS_PATTERN))

unbalanced = df_tri_naics.filter(~col("totals_balanced")).count()
print(f"Records with unbalanced totals (>5% discrepancy): {unbalanced:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Deduplication

# COMMAND ----------

before_dedup_tri = df_tri_naics.count()

df_tri_deduped = df_tri_naics.dropDuplicates([
    "facility_id", "chemical_name_std", "reporting_year"
])

after_dedup_tri = df_tri_deduped.count()
dupes_removed_tri = before_dedup_tri - after_dedup_tri

print(f"TRI Deduplication Results:")
print(f"  Before: {before_dedup_tri:,}")
print(f"  After: {after_dedup_tri:,}")
print(f"  Duplicates removed: {dupes_removed_tri:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### TRI Data Quality Score
# MAGIC
# MAGIC | Check | Points |
# MAGIC |-------|--------|
# MAGIC | Valid CAS number | 25 |
# MAGIC | Balanced totals | 25 |
# MAGIC | Valid coordinates | 25 |
# MAGIC | Valid NAICS code | 25 |

# COMMAND ----------

df_tri_dq = df_tri_deduped \
    .withColumn("_dq_score",
        (
            when(col("cas_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("totals_balanced") == True, lit(25)).otherwise(lit(0)) +
            when(col("coords_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("naics_valid") == True, lit(25)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(col("cas_valid") == False, lit("INVALID_CAS_NUMBER")),
                when(col("totals_balanced") == False, lit("UNBALANCED_RELEASE_TOTALS")),
                when(col("coords_valid") == False, lit("INVALID_COORDINATES")),
                when(col("naics_valid") == False, lit("INVALID_NAICS"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Silver Metadata & Write TRI Table

# COMMAND ----------

df_tri_silver = df_tri_dq \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

tri_columns = [
    # Identifiers
    "facility_id", "facility_name", "tri_facility_id",
    # Chemical
    "chemical_name_std", "cas_number_clean", "cas_valid",
    "chemical_classification",
    # NAICS
    "naics_code_clean", "naics_valid",
    # Releases (raw)
    "fugitive_air", "stack_air",
    "water_releases_val", "underground_releases_val", "land_releases_val",
    "total_releases_reported", "total_calculated_releases", "totals_balanced",
    # Releases (percentages)
    "pct_fugitive_air", "pct_stack_air", "pct_water", "pct_land",
    # Location
    "latitude", "longitude", "coords_valid",
    "state", "county", "city", "zip_code",
    # Reporting
    "reporting_year",
    # Quality & metadata
    "_dq_score", "_dq_flags", "_silver_timestamp", "_batch_id",
]

df_tri_out = df_tri_silver.select(
    [col(c) for c in tri_columns if c in df_tri_silver.columns]
)

# Write to Silver layer using Delta MERGE (incremental upsert)
if spark.catalog.tableExists(TARGET_TRI):
    deltaTable = DeltaTable.forName(spark, TARGET_TRI)
    deltaTable.alias("target").merge(
        df_tri_out.alias("source"),
        "target.facility_id = source.facility_id AND target.chemical_name_std = source.chemical_name_std AND target.reporting_year = source.reporting_year"
    ).whenMatchedUpdateAll(
        condition="target._silver_timestamp < source._silver_timestamp"
    ).whenNotMatchedInsertAll(
    ).execute()
else:
    df_tri_out.write \
        .format("delta") \
        .mode("overwrite") \
        .partitionBy("reporting_year") \
        .option("overwriteSchema", "true") \
        .saveAsTable(TARGET_TRI)

tri_silver_count = spark.table(TARGET_TRI).count()
print(f"Written/merged records to {TARGET_TRI} (total: {tri_silver_count:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 3: Water Quality (bronze_epa_water_quality -> silver_epa_water_quality)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Read Bronze Water Quality Data

# COMMAND ----------

df_water_bronze = spark.table(SOURCE_WATER)

water_bronze_count = df_water_bronze.count()
print(f"Bronze water quality records: {water_bronze_count:,}")
print(f"Columns: {len(df_water_bronze.columns)}")
df_water_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ### Contaminant Validation & MCL Violation Check
# MAGIC
# MAGIC MCL (Maximum Contaminant Level) violations occur when measured value exceeds
# MAGIC the EPA-defined MCL for that contaminant.

# COMMAND ----------

df_water_validated = df_water_bronze \
    .withColumn("contaminant_clean", upper(trim(col("contaminant")))) \
    .withColumn("contaminant_valid",
        col("contaminant_clean").isNotNull() & (length(col("contaminant_clean")) > 0)) \
    .withColumn("measurement_value",
        col("measurement_value").cast(DoubleType())) \
    .withColumn("mcl_value",
        col("mcl").cast(DoubleType())) \
    .withColumn("sample_date_parsed",
        to_date(col("sample_date"))) \
    .withColumn("mcl_violation_calculated",
        when(
            col("measurement_value").isNotNull() & col("mcl_value").isNotNull() & (col("mcl_value") > 0),
            col("measurement_value") > col("mcl_value")
        ).otherwise(lit(None).cast("boolean"))
    ) \
    .withColumn("mcl_violation_final",
        coalesce(col("mcl_violation"), col("mcl_violation_calculated"))) \
    .withColumn("measurement_valid",
        col("measurement_value").isNotNull() & (col("measurement_value") >= 0))

invalid_contaminants = df_water_validated.filter(~col("contaminant_valid")).count()
mcl_violations = df_water_validated.filter(col("mcl_violation_final") == True).count()

print("Water Quality Validation:")
print(f"  Invalid contaminant names: {invalid_contaminants:,}")
print(f"  MCL violations detected: {mcl_violations:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Deduplication

# COMMAND ----------

before_dedup_water = df_water_validated.count()

df_water_deduped = df_water_validated.dropDuplicates([
    "system_id", "contaminant_clean", "sample_date_parsed"
])

after_dedup_water = df_water_deduped.count()
dupes_removed_water = before_dedup_water - after_dedup_water

print(f"Water Quality Deduplication Results:")
print(f"  Before: {before_dedup_water:,}")
print(f"  After: {after_dedup_water:,}")
print(f"  Duplicates removed: {dupes_removed_water:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Water Quality Data Quality Score (Completeness & Validity)

# COMMAND ----------

df_water_dq = df_water_deduped \
    .withColumn("_dq_score",
        (
            when(col("system_id").isNotNull(), lit(20)).otherwise(lit(0)) +
            when(col("contaminant_valid") == True, lit(20)).otherwise(lit(0)) +
            when(col("measurement_valid") == True, lit(20)).otherwise(lit(0)) +
            when(col("sample_date_parsed").isNotNull(), lit(20)).otherwise(lit(0)) +
            when(col("mcl_value").isNotNull(), lit(20)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(col("system_id").isNull(), lit("MISSING_SYSTEM_ID")),
                when(col("contaminant_valid") == False, lit("INVALID_CONTAMINANT")),
                when(col("measurement_valid") == False, lit("INVALID_MEASUREMENT")),
                when(col("sample_date_parsed").isNull(), lit("MISSING_SAMPLE_DATE")),
                when(col("mcl_violation_final") == True, lit("MCL_VIOLATION"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Silver Metadata & Write Water Quality Table

# COMMAND ----------

df_water_silver = df_water_dq \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id)) \
    .withColumn("sample_year", year(col("sample_date_parsed")))

water_columns = [
    # Identifiers
    "system_id", "system_name", "facility_id",
    # Contaminant
    "contaminant_clean", "contaminant_valid",
    "measurement_value", "measurement_valid",
    "units", "mcl_value",
    "mcl_violation_final",
    # Sample
    "sample_date_parsed", "sample_year",
    "sample_type", "sample_point",
    # System info
    "system_type", "population_served",
    "state", "county",
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
        "target.system_id = source.system_id AND target.contaminant_clean = source.contaminant_clean AND target.sample_date_parsed = source.sample_date_parsed"
    ).whenMatchedUpdateAll(
        condition="target._silver_timestamp < source._silver_timestamp"
    ).whenNotMatchedInsertAll(
    ).execute()
else:
    df_water_out.write \
        .format("delta") \
        .mode("overwrite") \
        .partitionBy("sample_year") \
        .option("overwriteSchema", "true") \
        .saveAsTable(TARGET_WATER)

water_silver_count = spark.table(TARGET_WATER).count()
print(f"Written/merged records to {TARGET_WATER} (total: {water_silver_count:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Report

# COMMAND ----------

print("=" * 60)
print("EPA Silver Layer - Data Quality Report")
print("=" * 60)

# Air quality
print(f"\n--- {TARGET_AIR} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        ROUND(MIN(_dq_score), 2) as min_quality_score,
        ROUND(MAX(_dq_score), 2) as max_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(CASE WHEN _dq_score < 50 THEN 1 END) as low_quality_records,
        COUNT(DISTINCT parameter_name_clean) as unique_parameters
    FROM {TARGET_AIR}
""").show(truncate=False)

# COMMAND ----------

# Air quality AQI category distribution
print("AQI Category Distribution:")
spark.sql(f"""
    SELECT
        aqi_category_final as category,
        COUNT(*) as observations,
        ROUND(AVG(aqi_value), 1) as avg_aqi,
        MIN(aqi_value) as min_aqi,
        MAX(aqi_value) as max_aqi
    FROM {TARGET_AIR}
    WHERE aqi_category_final IS NOT NULL
    GROUP BY aqi_category_final
    ORDER BY avg_aqi
""").show(truncate=False)

# COMMAND ----------

# TRI quality
print(f"\n--- {TARGET_TRI} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(CASE WHEN totals_balanced = false THEN 1 END) as unbalanced_totals,
        COUNT(DISTINCT chemical_name_std) as unique_chemicals,
        COUNT(DISTINCT facility_id) as unique_facilities
    FROM {TARGET_TRI}
""").show(truncate=False)

# COMMAND ----------

# Top releasing chemicals
print("Top 10 Chemicals by Total Releases:")
spark.sql(f"""
    SELECT
        chemical_name_std,
        COUNT(DISTINCT facility_id) as facilities,
        ROUND(SUM(total_calculated_releases), 2) as total_lbs,
        ROUND(AVG(pct_fugitive_air), 1) as avg_pct_air,
        ROUND(AVG(pct_water), 1) as avg_pct_water
    FROM {TARGET_TRI}
    GROUP BY chemical_name_std
    ORDER BY total_lbs DESC
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# Water quality
print(f"\n--- {TARGET_WATER} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(CASE WHEN mcl_violation_final = true THEN 1 END) as mcl_violations,
        COUNT(DISTINCT system_id) as unique_systems,
        COUNT(DISTINCT contaminant_clean) as unique_contaminants
    FROM {TARGET_WATER}
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize Tables

# COMMAND ----------

spark.sql(f"OPTIMIZE {TARGET_AIR} ZORDER BY (station_id, parameter_name_clean)")
print(f"Optimized {TARGET_AIR} with Z-Order on station_id, parameter_name_clean")

spark.sql(f"OPTIMIZE {TARGET_TRI} ZORDER BY (facility_id, chemical_name_std)")
print(f"Optimized {TARGET_TRI} with Z-Order on facility_id, chemical_name_std")

spark.sql(f"OPTIMIZE {TARGET_WATER} ZORDER BY (system_id, contaminant_clean)")
print(f"Optimized {TARGET_WATER} with Z-Order on system_id, contaminant_clean")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation Queries

# COMMAND ----------

# Verify no duplicate keys in air quality
air_dup = spark.sql(f"""
    SELECT station_id, parameter_name_clean, measurement_date, measurement_hour, COUNT(*) as cnt
    FROM {TARGET_AIR}
    GROUP BY station_id, parameter_name_clean, measurement_date, measurement_hour
    HAVING cnt > 1
""")
print(f"Air quality duplicate keys (should be 0): {air_dup.count()}")

# Verify no duplicate keys in TRI
tri_dup = spark.sql(f"""
    SELECT facility_id, chemical_name_std, reporting_year, COUNT(*) as cnt
    FROM {TARGET_TRI}
    GROUP BY facility_id, chemical_name_std, reporting_year
    HAVING cnt > 1
""")
print(f"TRI duplicate keys (should be 0): {tri_dup.count()}")

# Verify no duplicate keys in water quality
water_dup = spark.sql(f"""
    SELECT system_id, contaminant_clean, sample_date_parsed, COUNT(*) as cnt
    FROM {TARGET_WATER}
    GROUP BY system_id, contaminant_clean, sample_date_parsed
    HAVING cnt > 1
""")
print(f"Water quality duplicate keys (should be 0): {water_dup.count()}")

# Verify AQI range
aqi_out_of_range = spark.sql(f"""
    SELECT COUNT(*) as cnt
    FROM {TARGET_AIR}
    WHERE aqi_valid = false AND aqi_value IS NOT NULL
""").collect()[0]["cnt"]
print(f"Air quality records with out-of-range AQI: {aqi_out_of_range}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Source Table | Target Table | Key Transformations |
# MAGIC |-------------|-------------|---------------------|
# MAGIC | bronze_epa_air_quality | silver_epa_air_quality | AQI validation 0-500, parameter name validation, AQI category mapping, DQ scoring |
# MAGIC | bronze_epa_toxic_releases | silver_epa_toxic_releases | CAS number validation, release total balancing, chemical standardization, media breakdown % |
# MAGIC | bronze_epa_water_quality | silver_epa_water_quality | Contaminant validation, MCL violation logic, completeness-based DQ scoring |
# MAGIC
# MAGIC **Next Step:** Continue to Gold layer for EPA environmental analytics.
