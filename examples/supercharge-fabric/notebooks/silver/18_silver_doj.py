# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: DOJ Data Cleansing & Standardization
# MAGIC
# MAGIC This notebook transforms Bronze DOJ data into cleansed, validated,
# MAGIC and enriched Silver layer tables.
# MAGIC
# MAGIC ## Transformations Applied:
# MAGIC - Type casting: victim_count/offender_count as IntegerType, sentence_months as IntegerType, monetary fields as DecimalType(18,2)
# MAGIC - NIBRS offense_code and Federal district validation
# MAGIC - State abbreviation standardization
# MAGIC - Deduplication by incident_id/case_id/seizure_id
# MAGIC - Derived: arrest_rate, crime_severity, merger_presumption, concentration_level
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
    initcap,
    lit,
    max,
    months,
    round,
    substring,
    to_date,
    trim,
    upper,
    when,
    year,
)
from pyspark.sql.types import DateType, DecimalType, IntegerType

# Parameters (set by pipeline or manual)
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source tables (Bronze)
SOURCE_CRIME_STATS = "lh_bronze.bronze_doj_crime_stats"
SOURCE_FEDERAL_CASES = "lh_bronze.bronze_doj_federal_cases"
SOURCE_ANTITRUST = "lh_bronze.bronze_doj_antitrust"
SOURCE_DRUG_ENFORCEMENT = "lh_bronze.bronze_doj_drug_enforcement"

# Target tables (Silver)
TARGET_CRIME_STATS = "lh_silver.silver_doj_crime_stats"
TARGET_FEDERAL_CASES = "lh_silver.silver_doj_federal_cases"
TARGET_ANTITRUST = "lh_silver.silver_doj_antitrust"
TARGET_DRUG_ENFORCEMENT = "lh_silver.silver_doj_drug_enforcement"
TARGET_DISTRICTS = "lh_silver.silver_doj_districts"

print(f"Processing batch: {batch_id}")
print(f"Sources: {SOURCE_CRIME_STATS}, {SOURCE_FEDERAL_CASES}, {SOURCE_ANTITRUST}, {SOURCE_DRUG_ENFORCEMENT}")
print(f"Targets: {TARGET_CRIME_STATS}, {TARGET_FEDERAL_CASES}, {TARGET_ANTITRUST}, {TARGET_DRUG_ENFORCEMENT}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Reference Data: Valid Codes & Mappings

# COMMAND ----------

# Valid US state abbreviations
VALID_STATES = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    "DC", "PR", "VI", "GU", "AS", "MP",
]

# Known NIBRS offense codes (sample - major categories)
VALID_NIBRS_CODES = [
    "100", "200", "210", "220", "240", "250", "260", "270", "280", "290",
    "300", "310", "320", "330", "350", "360", "370", "400", "500", "510",
    "520", "600", "700", "720", "780", "790", "800", "810", "900", "930",
]

# Federal district courts (94 total)
FEDERAL_DISTRICTS = [
    "ALMD", "ALND", "ALSD", "AKAD", "AZAD", "ARED", "ARWD", "CACD", "CAED", "CAND", "CASD",
    "COFD", "CTFD", "DEFD", "DCDC", "FLMD", "FLND", "FLSD", "GAMD", "GAND", "GASD", "HIFD",
    "IDFD", "ILCD", "ILND", "ILSD", "INND", "INSD", "IAFD", "IAND", "IASD", "KSFD", "KYED",
    "KYWD", "LAED", "LAMD", "LAWD", "MEFD", "MDFD", "MAFD", "MIED", "MIWD", "MNFD", "MSND",
    "MSSD", "MOED", "MOWD", "MTFD", "NEFD", "NVFD", "NHFD", "NJFD", "NMFD", "NYED", "NYND",
    "NYSD", "NYWD", "NCED", "NCMD", "NCWD", "NDFD", "OHND", "OHSD", "OKED", "OKND", "OKWD",
    "ORFD", "PAED", "PAMD", "PAWD", "RIFD", "SCFD", "SDFD", "TNED", "TNMD", "TNWD", "TXED",
    "TXND", "TXSD", "TXWD", "UTFD", "VTFD", "VAED", "VAWD", "WAED", "WAWD", "WVND", "WVSD",
    "WIED", "WIWD", "WYFD", "PRFD", "VIFD", "GUFD",
]

# Federal crime clearance status
VALID_CLEARANCE_STATUS = [
    "CLEARED_ARREST", "CLEARED_EXCEPTIONAL", "NOT_CLEARED", "UNDER_INVESTIGATION"
]

# Drug schedules
VALID_DRUG_SCHEDULES = ["I", "II", "III", "IV", "V"]

# Crime severity mapping based on offense category
CRIME_SEVERITY_MAP = {
    "HOMICIDE": "CRITICAL",
    "RAPE": "CRITICAL",
    "ROBBERY": "HIGH",
    "ASSAULT": "HIGH",
    "BURGLARY": "MEDIUM",
    "LARCENY": "MEDIUM",
    "AUTO_THEFT": "MEDIUM",
    "FRAUD": "MEDIUM",
    "DRUG_OFFENSE": "MEDIUM",
    "OTHER": "LOW",
}

crime_severity_expr = create_map([lit(x) for pair in CRIME_SEVERITY_MAP.items() for x in pair])

print("Reference data loaded:")
print(f"  Valid states: {len(VALID_STATES)}")
print(f"  NIBRS offense codes: {len(VALID_NIBRS_CODES)}")
print(f"  Federal districts: {len(FEDERAL_DISTRICTS)}")
print(f"  Clearance statuses: {len(VALID_CLEARANCE_STATUS)}")
print(f"  Drug schedules: {len(VALID_DRUG_SCHEDULES)}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 1: Crime Stats (bronze_doj_crime_stats -> silver_doj_crime_stats)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Read Bronze Crime Stats Data

# COMMAND ----------

df_crime_bronze = spark.table(SOURCE_CRIME_STATS)

crime_bronze_count = df_crime_bronze.count()
print(f"Bronze Crime Stats records: {crime_bronze_count:,}")
print(f"Columns: {len(df_crime_bronze.columns)}")
df_crime_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ### Type Casting

# COMMAND ----------

df_crime_typed = df_crime_bronze \
    .withColumn("victim_count",
        col("victim_count").cast(IntegerType())) \
    .withColumn("offender_count",
        col("offender_count").cast(IntegerType())) \
    .withColumn("reporting_year",
        col("reporting_year").cast(IntegerType())) \
    .withColumn("incident_date",
        to_date(col("incident_date")))

print("Type casting applied:")
print("  victim_count, offender_count -> IntegerType")
print("  reporting_year -> IntegerType")
print("  incident_date -> DateType")

# COMMAND ----------

# MAGIC %md
# MAGIC ### NIBRS Code & State Validation

# COMMAND ----------

df_crime_validated = df_crime_typed \
    .withColumn("offense_code_clean", trim(col("offense_code"))) \
    .withColumn("offense_code_valid",
        col("offense_code_clean").isin(VALID_NIBRS_CODES)) \
    .withColumn("state_clean", upper(trim(col("state")))) \
    .withColumn("state_valid",
        col("state_clean").isin(VALID_STATES)) \
    .withColumn("clearance_status_clean", upper(trim(col("clearance_status")))) \
    .withColumn("clearance_status_valid",
        col("clearance_status_clean").isin(VALID_CLEARANCE_STATUS))

invalid_offense = df_crime_validated.filter(~col("offense_code_valid") & col("offense_code").isNotNull()).count()
invalid_state = df_crime_validated.filter(~col("state_valid") & col("state").isNotNull()).count()
invalid_clearance = df_crime_validated.filter(~col("clearance_status_valid") & col("clearance_status").isNotNull()).count()

print("Crime Stats Validation:")
print(f"  Invalid NIBRS codes: {invalid_offense:,}")
print(f"  Invalid state abbreviations: {invalid_state:,}")
print(f"  Invalid clearance statuses: {invalid_clearance:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Deduplication

# COMMAND ----------

before_dedup = df_crime_validated.count()

df_crime_deduped = df_crime_validated.dropDuplicates(["incident_id"])

after_dedup = df_crime_deduped.count()
dupes_removed = before_dedup - after_dedup

print(f"Crime Stats Deduplication Results:")
print(f"  Before: {before_dedup:,}")
print(f"  After: {after_dedup:,}")
print(f"  Duplicates removed: {dupes_removed:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Derived Fields: Arrest Rate & Crime Severity

# COMMAND ----------

df_crime_derived = df_crime_deduped \
    .withColumn("arrest_rate",
        when(
            col("clearance_status_clean") == "CLEARED_ARREST",
            lit(True)
        ).otherwise(lit(False)).cast("boolean")
    ) \
    .withColumn("crime_severity",
        coalesce(
            crime_severity_expr[upper(trim(col("offense_category")))],
            lit("LOW")
        )
    ) \
    .withColumn("victim_offender_ratio",
        when(
            col("offender_count").isNotNull() & (col("offender_count") > 0),
            round(col("victim_count").cast("double") / col("offender_count").cast("double"), 2)
        ).otherwise(lit(None).cast(DecimalType(18, 2)))
    )

print("Derived fields added:")
print("  arrest_rate = clearance_status == 'CLEARED_ARREST'")
print("  crime_severity = mapped from offense_category")
print("  victim_offender_ratio = victim_count / offender_count")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Crime Stats Data Quality Score

# COMMAND ----------

df_crime_dq = df_crime_derived \
    .withColumn("_dq_score",
        (
            when(col("offense_code_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("state_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("victim_count").isNotNull() & (col("victim_count") >= 0), lit(25)).otherwise(lit(0)) +
            when(col("clearance_status_valid") == True, lit(25)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(col("offense_code_valid") == False, lit("INVALID_NIBRS_CODE")),
                when(col("state_valid") == False, lit("INVALID_STATE")),
                when(col("victim_count").isNull() | (col("victim_count") < 0), lit("INVALID_VICTIM_COUNT")),
                when(col("clearance_status_valid") == False, lit("INVALID_CLEARANCE_STATUS"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Silver Metadata & Write Crime Stats Table

# COMMAND ----------

try:
    df_crime_silver = df_crime_dq \
        .withColumn("_silver_timestamp", current_timestamp()) \
        .withColumn("_batch_id", lit(batch_id))

    crime_columns = [
        # Identifiers
        "incident_id", "agency_id",
        # Location
        "state_clean", "state_valid", "county", "city",
        # Offense details
        "offense_code_clean", "offense_code_valid", "offense_category", "crime_severity",
        "incident_date", "reporting_year",
        # Participants
        "victim_count", "offender_count", "victim_offender_ratio",
        # Resolution
        "clearance_status_clean", "clearance_status_valid", "arrest_rate",
        # Quality & metadata
        "_dq_score", "_dq_flags", "_silver_timestamp", "_batch_id",
    ]

    df_crime_out = df_crime_silver.select(
        [col(c) for c in crime_columns if c in df_crime_silver.columns]
    )

    # Write to Silver layer using Delta MERGE (incremental upsert)
    if spark.catalog.tableExists(TARGET_CRIME_STATS):
        deltaTable = DeltaTable.forName(spark, TARGET_CRIME_STATS)
        deltaTable.alias("target").merge(
            df_crime_out.alias("source"),
            "target.incident_id = source.incident_id"
        ).whenMatchedUpdateAll(
            condition="target._silver_timestamp < source._silver_timestamp"
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_crime_out.write \
            .format("delta") \
            .mode("overwrite") \
            .partitionBy("reporting_year") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_CRIME_STATS)

    crime_silver_count = spark.table(TARGET_CRIME_STATS).count()
    print(f"Written/merged records to {TARGET_CRIME_STATS} (total: {crime_silver_count:,})")
except Exception as e:
    print(f"ERROR in crime stats processing (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 2: Federal Cases (bronze_doj_federal_cases -> silver_doj_federal_cases)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Read Bronze Federal Cases Data

# COMMAND ----------

df_federal_bronze = spark.table(SOURCE_FEDERAL_CASES)

federal_bronze_count = df_federal_bronze.count()
print(f"Bronze Federal Cases records: {federal_bronze_count:,}")
print(f"Columns: {len(df_federal_bronze.columns)}")
df_federal_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ### Type Casting & Cleansing

# COMMAND ----------

df_federal_typed = df_federal_bronze \
    .withColumn("sentence_months",
        col("sentence_months").cast(IntegerType())) \
    .withColumn("guideline_min_months",
        col("guideline_min_months").cast(IntegerType())) \
    .withColumn("guideline_max_months",
        col("guideline_max_months").cast(IntegerType())) \
    .withColumn("fine_amount",
        coalesce(col("fine_amount"), lit(0)).cast(DecimalType(18, 2))) \
    .withColumn("restitution_amount",
        coalesce(col("restitution_amount"), lit(0)).cast(DecimalType(18, 2))) \
    .withColumn("filing_date",
        to_date(col("filing_date"))) \
    .withColumn("disposition_date",
        to_date(col("disposition_date")))

print("Type casting applied to Federal Cases data")

# COMMAND ----------

# MAGIC %md
# MAGIC ### District Court & Guideline Validation

# COMMAND ----------

df_federal_validated = df_federal_typed \
    .withColumn("district_clean", upper(trim(col("district")))) \
    .withColumn("district_valid",
        col("district_clean").isin(FEDERAL_DISTRICTS)) \
    .withColumn("guideline_range_valid",
        col("guideline_max_months").isNotNull() &
        col("guideline_min_months").isNotNull() &
        (col("guideline_max_months") >= col("guideline_min_months"))) \
    .withColumn("sentence_valid",
        col("sentence_months").isNotNull() & (col("sentence_months") >= 0))

invalid_district = df_federal_validated.filter(~col("district_valid") & col("district").isNotNull()).count()
invalid_guidelines = df_federal_validated.filter(~col("guideline_range_valid")).count()

print("Federal Cases Validation:")
print(f"  Invalid districts: {invalid_district:,}")
print(f"  Invalid guideline ranges: {invalid_guidelines:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Sentence Analysis & Departure Calculations

# COMMAND ----------

df_federal_derived = df_federal_validated \
    .withColumn("guideline_midpoint",
        when(
            col("guideline_range_valid"),
            (col("guideline_min_months") + col("guideline_max_months")) / 2
        ).otherwise(lit(None).cast(DecimalType(18, 2)))
    ) \
    .withColumn("within_guidelines",
        when(
            col("guideline_range_valid") & col("sentence_valid"),
            (col("sentence_months") >= col("guideline_min_months")) &
            (col("sentence_months") <= col("guideline_max_months"))
        ).otherwise(lit(None)).cast("boolean")
    ) \
    .withColumn("above_guidelines",
        when(
            col("guideline_range_valid") & col("sentence_valid"),
            col("sentence_months") > col("guideline_max_months")
        ).otherwise(lit(False)).cast("boolean")
    ) \
    .withColumn("below_guidelines",
        when(
            col("guideline_range_valid") & col("sentence_valid"),
            col("sentence_months") < col("guideline_min_months")
        ).otherwise(lit(False)).cast("boolean")
    ) \
    .withColumn("departure_rate",
        when(
            col("guideline_midpoint").isNotNull() & (col("guideline_midpoint") > 0) & col("sentence_valid"),
            round(col("sentence_months").cast("double") / col("guideline_midpoint"), 4)
        ).otherwise(lit(None).cast(DecimalType(18, 4)))
    ) \
    .withColumn("filing_year",
        year(col("filing_date")))

print("Derived fields added for Federal Cases:")
print("  guideline_midpoint = (min + max) / 2")
print("  within/above/below_guidelines flags")
print("  departure_rate = sentence / midpoint")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Deduplication

# COMMAND ----------

before_dedup_fed = df_federal_derived.count()

df_federal_deduped = df_federal_derived.dropDuplicates(["case_id"])

after_dedup_fed = df_federal_deduped.count()
dupes_removed_fed = before_dedup_fed - after_dedup_fed

print(f"Federal Cases Deduplication Results:")
print(f"  Before: {before_dedup_fed:,}")
print(f"  After: {after_dedup_fed:,}")
print(f"  Duplicates removed: {dupes_removed_fed:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Federal Cases Data Quality Score

# COMMAND ----------

df_federal_dq = df_federal_deduped \
    .withColumn("_dq_score",
        (
            when(col("district_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("sentence_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("guideline_range_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("filing_date").isNotNull(), lit(25)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(col("district_valid") == False, lit("INVALID_DISTRICT")),
                when(col("sentence_valid") == False, lit("INVALID_SENTENCE")),
                when(col("guideline_range_valid") == False, lit("INVALID_GUIDELINES")),
                when(col("filing_date").isNull(), lit("MISSING_FILING_DATE"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Federal Cases Table

# COMMAND ----------

df_federal_silver = df_federal_dq \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

federal_columns = [
    # Identifiers
    "case_id", "defendant_id", "district_clean", "district_valid",
    # Case details
    "offense_type", "filing_date", "disposition_date", "filing_year",
    # Sentencing
    "sentence_months", "sentence_valid",
    "guideline_min_months", "guideline_max_months", "guideline_midpoint", "guideline_range_valid",
    "within_guidelines", "above_guidelines", "below_guidelines", "departure_rate",
    "fine_amount", "restitution_amount",
    # Quality & metadata
    "_dq_score", "_dq_flags", "_silver_timestamp", "_batch_id",
]

df_federal_out = df_federal_silver.select(
    [col(c) for c in federal_columns if c in df_federal_silver.columns]
)

# Write to Silver layer using Delta MERGE
if spark.catalog.tableExists(TARGET_FEDERAL_CASES):
    deltaTable = DeltaTable.forName(spark, TARGET_FEDERAL_CASES)
    deltaTable.alias("target").merge(
        df_federal_out.alias("source"),
        "target.case_id = source.case_id"
    ).whenMatchedUpdateAll(
        condition="target._silver_timestamp < source._silver_timestamp"
    ).whenNotMatchedInsertAll(
    ).execute()
else:
    df_federal_out.write \
        .format("delta") \
        .mode("overwrite") \
        .partitionBy("filing_year") \
        .option("overwriteSchema", "true") \
        .saveAsTable(TARGET_FEDERAL_CASES)

federal_silver_count = spark.table(TARGET_FEDERAL_CASES).count()
print(f"Written/merged records to {TARGET_FEDERAL_CASES} (total: {federal_silver_count:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 3: Antitrust (bronze_doj_antitrust -> silver_doj_antitrust)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Read Bronze Antitrust Data

# COMMAND ----------

df_antitrust_bronze = spark.table(SOURCE_ANTITRUST)

antitrust_bronze_count = df_antitrust_bronze.count()
print(f"Bronze Antitrust records: {antitrust_bronze_count:,}")
print(f"Columns: {len(df_antitrust_bronze.columns)}")
df_antitrust_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ### Type Casting & HHI Validation

# COMMAND ----------

df_antitrust_typed = df_antitrust_bronze \
    .withColumn("transaction_value",
        coalesce(col("transaction_value"), lit(0)).cast(DecimalType(18, 2))) \
    .withColumn("penalty_amount",
        coalesce(col("penalty_amount"), lit(0)).cast(DecimalType(18, 2))) \
    .withColumn("hhi_pre_merger",
        col("hhi_pre_merger").cast(IntegerType())) \
    .withColumn("hhi_post_merger",
        col("hhi_post_merger").cast(IntegerType())) \
    .withColumn("hhi_delta",
        col("hhi_delta").cast(IntegerType())) \
    .withColumn("filing_date",
        to_date(col("filing_date")))

# Cross-field HHI validation
df_antitrust_validated = df_antitrust_typed \
    .withColumn("hhi_calculation_valid",
        col("hhi_post_merger").isNotNull() &
        col("hhi_pre_merger").isNotNull() &
        col("hhi_delta").isNotNull() &
        (col("hhi_post_merger") == (col("hhi_pre_merger") + col("hhi_delta")))
    ) \
    .withColumn("naics_sector_clean", trim(substring(col("industry_sector"), 1, 2))) \
    .withColumn("naics_sector_valid",
        col("naics_sector_clean").rlike(r"^\d{2}$"))

print("Type casting and HHI validation applied to Antitrust data")

# COMMAND ----------

# MAGIC %md
# MAGIC ### HHI Concentration Classification (2023 Merger Guidelines)

# COMMAND ----------

df_antitrust_derived = df_antitrust_validated \
    .withColumn("concentration_level",
        when(col("hhi_post_merger") < 1500, lit("UNCONCENTRATED"))
        .when((col("hhi_post_merger") >= 1500) & (col("hhi_post_merger") <= 2500), lit("MODERATELY_CONCENTRATED"))
        .when(col("hhi_post_merger") > 2500, lit("HIGHLY_CONCENTRATED"))
        .otherwise(lit("UNKNOWN"))
    ) \
    .withColumn("merger_presumption",
        when(
            col("hhi_post_merger").isNotNull() & col("hhi_delta").isNotNull(),
            (col("hhi_post_merger") > 2500) & (col("hhi_delta") > 200)
        ).otherwise(lit(False)).cast("boolean")
    ) \
    .withColumn("filing_year",
        year(col("filing_date")))

print("HHI concentration and merger presumption analysis applied")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Deduplication

# COMMAND ----------

before_dedup_anti = df_antitrust_derived.count()

df_antitrust_deduped = df_antitrust_derived.dropDuplicates(["case_id"])

after_dedup_anti = df_antitrust_deduped.count()
dupes_removed_anti = before_dedup_anti - after_dedup_anti

print(f"Antitrust Deduplication Results:")
print(f"  Before: {before_dedup_anti:,}")
print(f"  After: {after_dedup_anti:,}")
print(f"  Duplicates removed: {dupes_removed_anti:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Antitrust Data Quality Score

# COMMAND ----------

df_antitrust_dq = df_antitrust_deduped \
    .withColumn("_dq_score",
        (
            when(col("hhi_calculation_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("naics_sector_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("transaction_value").isNotNull() & (col("transaction_value") >= 0), lit(25)).otherwise(lit(0)) +
            when(col("filing_date").isNotNull(), lit(25)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(col("hhi_calculation_valid") == False, lit("INVALID_HHI_CALCULATION")),
                when(col("naics_sector_valid") == False, lit("INVALID_NAICS_SECTOR")),
                when(col("transaction_value").isNull() | (col("transaction_value") < 0), lit("INVALID_TRANSACTION_VALUE")),
                when(col("filing_date").isNull(), lit("MISSING_FILING_DATE"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Antitrust Table

# COMMAND ----------

df_antitrust_silver = df_antitrust_dq \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

antitrust_columns = [
    # Identifiers
    "case_id", "filing_date", "filing_year",
    # Market concentration
    "hhi_pre_merger", "hhi_post_merger", "hhi_delta", "hhi_calculation_valid",
    "concentration_level", "merger_presumption",
    # Industry
    "industry_sector", "naics_sector_clean", "naics_sector_valid",
    # Financial
    "transaction_value", "penalty_amount",
    # Case details
    "case_type", "case_status",
    # Quality & metadata
    "_dq_score", "_dq_flags", "_silver_timestamp", "_batch_id",
]

df_antitrust_out = df_antitrust_silver.select(
    [col(c) for c in antitrust_columns if c in df_antitrust_silver.columns]
)

# Write to Silver layer using Delta MERGE
if spark.catalog.tableExists(TARGET_ANTITRUST):
    deltaTable = DeltaTable.forName(spark, TARGET_ANTITRUST)
    deltaTable.alias("target").merge(
        df_antitrust_out.alias("source"),
        "target.case_id = source.case_id"
    ).whenMatchedUpdateAll(
        condition="target._silver_timestamp < source._silver_timestamp"
    ).whenNotMatchedInsertAll(
    ).execute()
else:
    df_antitrust_out.write \
        .format("delta") \
        .mode("overwrite") \
        .partitionBy("filing_year") \
        .option("overwriteSchema", "true") \
        .saveAsTable(TARGET_ANTITRUST)

antitrust_silver_count = spark.table(TARGET_ANTITRUST).count()
print(f"Written/merged records to {TARGET_ANTITRUST} (total: {antitrust_silver_count:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 4: Drug Enforcement (bronze_doj_drug_enforcement -> silver_doj_drug_enforcement)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Read Bronze Drug Enforcement Data

# COMMAND ----------

df_drug_bronze = spark.table(SOURCE_DRUG_ENFORCEMENT)

drug_bronze_count = df_drug_bronze.count()
print(f"Bronze Drug Enforcement records: {drug_bronze_count:,}")
print(f"Columns: {len(df_drug_bronze.columns)}")
df_drug_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ### Type Casting & Validation

# COMMAND ----------

df_drug_typed = df_drug_bronze \
    .withColumn("quantity_kg",
        col("quantity_kg").cast(DecimalType(18, 4))) \
    .withColumn("street_value",
        col("street_value").cast(DecimalType(18, 4))) \
    .withColumn("seizure_date",
        to_date(col("seizure_date"))) \
    .withColumn("seizure_year",
        year(col("seizure_date"))) \
    .withColumn("quarter",
        col("quarter").cast(IntegerType())) \
    .withColumn("drug_schedule_clean", upper(trim(col("drug_schedule")))) \
    .withColumn("drug_schedule_valid",
        col("drug_schedule_clean").isin(VALID_DRUG_SCHEDULES)) \
    .withColumn("quarter_valid",
        col("quarter").isNotNull() &
        (col("quarter") >= 1) & (col("quarter") <= 4)) \
    .withColumn("state_clean", upper(trim(col("state")))) \
    .withColumn("state_valid",
        col("state_clean").isin(VALID_STATES))

print("Type casting and basic validation applied to Drug Enforcement data")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Street Value Analysis & Outlier Detection

# COMMAND ----------

df_drug_derived = df_drug_typed \
    .withColumn("street_value_per_kg",
        when(
            col("quantity_kg").isNotNull() & (col("quantity_kg") > 0),
            round(col("street_value") / col("quantity_kg"), 2)
        ).otherwise(lit(None).cast(DecimalType(18, 2)))
    ) \
    .withColumn("quantity_valid",
        col("quantity_kg").isNotNull() & (col("quantity_kg") > 0)) \
    .withColumn("street_value_valid",
        col("street_value").isNotNull() & (col("street_value") >= 0))

# Flag outliers (simplified approach - values > 10x median would be flagged in production)
df_drug_derived = df_drug_derived \
    .withColumn("street_value_outlier",
        when(
            col("street_value_per_kg").isNotNull(),
            col("street_value_per_kg") > 1000000  # Flag if > $1M per kg
        ).otherwise(lit(False)).cast("boolean")
    )

print("Street value analysis and outlier detection applied")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Deduplication

# COMMAND ----------

before_dedup_drug = df_drug_derived.count()

df_drug_deduped = df_drug_derived.dropDuplicates(["seizure_id"])

after_dedup_drug = df_drug_deduped.count()
dupes_removed_drug = before_dedup_drug - after_dedup_drug

print(f"Drug Enforcement Deduplication Results:")
print(f"  Before: {before_dedup_drug:,}")
print(f"  After: {after_dedup_drug:,}")
print(f"  Duplicates removed: {dupes_removed_drug:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Drug Enforcement Data Quality Score

# COMMAND ----------

df_drug_dq = df_drug_deduped \
    .withColumn("_dq_score",
        (
            when(col("drug_schedule_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("quantity_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("street_value_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("state_valid") == True, lit(25)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(col("drug_schedule_valid") == False, lit("INVALID_DRUG_SCHEDULE")),
                when(col("quantity_valid") == False, lit("INVALID_QUANTITY")),
                when(col("street_value_valid") == False, lit("INVALID_STREET_VALUE")),
                when(col("state_valid") == False, lit("INVALID_STATE")),
                when(col("quarter_valid") == False, lit("INVALID_QUARTER")),
                when(col("street_value_outlier") == True, lit("STREET_VALUE_OUTLIER"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Drug Enforcement Table

# COMMAND ----------

df_drug_silver = df_drug_dq \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

drug_columns = [
    # Identifiers
    "seizure_id", "agency_id",
    # Location & timing
    "state_clean", "state_valid", "seizure_date", "seizure_year", "quarter", "quarter_valid",
    # Drug details
    "drug_type", "drug_schedule_clean", "drug_schedule_valid",
    "quantity_kg", "quantity_valid",
    # Financial
    "street_value", "street_value_valid", "street_value_per_kg", "street_value_outlier",
    # Quality & metadata
    "_dq_score", "_dq_flags", "_silver_timestamp", "_batch_id",
]

df_drug_out = df_drug_silver.select(
    [col(c) for c in drug_columns if c in df_drug_silver.columns]
)

# Write to Silver layer using Delta MERGE
if spark.catalog.tableExists(TARGET_DRUG_ENFORCEMENT):
    deltaTable = DeltaTable.forName(spark, TARGET_DRUG_ENFORCEMENT)
    deltaTable.alias("target").merge(
        df_drug_out.alias("source"),
        "target.seizure_id = source.seizure_id"
    ).whenMatchedUpdateAll(
        condition="target._silver_timestamp < source._silver_timestamp"
    ).whenNotMatchedInsertAll(
    ).execute()
else:
    df_drug_out.write \
        .format("delta") \
        .mode("overwrite") \
        .partitionBy("seizure_year") \
        .option("overwriteSchema", "true") \
        .saveAsTable(TARGET_DRUG_ENFORCEMENT)

drug_silver_count = spark.table(TARGET_DRUG_ENFORCEMENT).count()
print(f"Written/merged records to {TARGET_DRUG_ENFORCEMENT} (total: {drug_silver_count:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Create District Lookup Table

# COMMAND ----------

# Create federal district to circuit/state mapping lookup table
district_data = [
    ("ALMD", "11th", "AL"), ("ALND", "11th", "AL"), ("ALSD", "11th", "AL"),
    ("AKAD", "9th", "AK"), ("AZAD", "9th", "AZ"), ("ARED", "8th", "AR"), ("ARWD", "8th", "AR"),
    ("CACD", "9th", "CA"), ("CAED", "9th", "CA"), ("CAND", "9th", "CA"), ("CASD", "9th", "CA"),
    ("COFD", "10th", "CO"), ("CTFD", "2nd", "CT"), ("DEFD", "3rd", "DE"), ("DCDC", "DC", "DC"),
    ("FLMD", "11th", "FL"), ("FLND", "11th", "FL"), ("FLSD", "11th", "FL"),
    ("GAMD", "11th", "GA"), ("GAND", "11th", "GA"), ("GASD", "11th", "GA"),
    # Add more as needed - showing pattern
]

df_districts = spark.createDataFrame(district_data, ["district", "circuit", "state"]) \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# Write district lookup table
df_districts.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(TARGET_DISTRICTS)

print(f"Created district lookup table: {TARGET_DISTRICTS}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Report

# COMMAND ----------

print("=" * 60)
print("DOJ Silver Layer - Data Quality Report")
print("=" * 60)

# Crime Stats quality
print(f"\n--- {TARGET_CRIME_STATS} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        ROUND(MIN(_dq_score), 2) as min_quality_score,
        ROUND(MAX(_dq_score), 2) as max_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(CASE WHEN _dq_score >= 75 THEN 1 END) as high_quality_records,
        COUNT(CASE WHEN _dq_score < 50 THEN 1 END) as low_quality_records
    FROM {TARGET_CRIME_STATS}
""").show(truncate=False)

# COMMAND ----------

# Federal Cases quality
print(f"\n--- {TARGET_FEDERAL_CASES} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        COUNT(CASE WHEN within_guidelines = true THEN 1 END) as within_guidelines,
        COUNT(CASE WHEN above_guidelines = true THEN 1 END) as above_guidelines,
        COUNT(CASE WHEN below_guidelines = true THEN 1 END) as below_guidelines,
        ROUND(AVG(departure_rate), 3) as avg_departure_rate
    FROM {TARGET_FEDERAL_CASES}
""").show(truncate=False)

# COMMAND ----------

# Antitrust quality
print(f"\n--- {TARGET_ANTITRUST} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        COUNT(CASE WHEN merger_presumption = true THEN 1 END) as presumptive_mergers,
        COUNT(CASE WHEN concentration_level = 'HIGHLY_CONCENTRATED' THEN 1 END) as highly_concentrated,
        COUNT(CASE WHEN concentration_level = 'UNCONCENTRATED' THEN 1 END) as unconcentrated
    FROM {TARGET_ANTITRUST}
""").show(truncate=False)

# COMMAND ----------

# Drug Enforcement quality
print(f"\n--- {TARGET_DRUG_ENFORCEMENT} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        COUNT(CASE WHEN street_value_outlier = true THEN 1 END) as value_outliers,
        ROUND(SUM(quantity_kg), 2) as total_kg_seized,
        ROUND(SUM(street_value), 2) as total_street_value
    FROM {TARGET_DRUG_ENFORCEMENT}
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize Tables

# COMMAND ----------

spark.sql(f"OPTIMIZE {TARGET_CRIME_STATS} ZORDER BY (incident_id, state_clean)")
print(f"Optimized {TARGET_CRIME_STATS} with Z-Order on incident_id, state_clean")

spark.sql(f"OPTIMIZE {TARGET_FEDERAL_CASES} ZORDER BY (case_id, district_clean)")
print(f"Optimized {TARGET_FEDERAL_CASES} with Z-Order on case_id, district_clean")

spark.sql(f"OPTIMIZE {TARGET_ANTITRUST} ZORDER BY (case_id, concentration_level)")
print(f"Optimized {TARGET_ANTITRUST} with Z-Order on case_id, concentration_level")

spark.sql(f"OPTIMIZE {TARGET_DRUG_ENFORCEMENT} ZORDER BY (seizure_id, state_clean)")
print(f"Optimized {TARGET_DRUG_ENFORCEMENT} with Z-Order on seizure_id, state_clean")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation Queries

# COMMAND ----------

# Verify no duplicates
for table_name, id_col in [
    (TARGET_CRIME_STATS, "incident_id"),
    (TARGET_FEDERAL_CASES, "case_id"),
    (TARGET_ANTITRUST, "case_id"),
    (TARGET_DRUG_ENFORCEMENT, "seizure_id")
]:
    dup_check = spark.sql(f"""
        SELECT {id_col}, COUNT(*) as cnt
        FROM {table_name}
        GROUP BY {id_col}
        HAVING cnt > 1
    """)
    print(f"{table_name} duplicate {id_col}s (should be 0): {dup_check.count()}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Source Table | Target Table | Key Transformations |
# MAGIC |-------------|-------------|---------------------|
# MAGIC | bronze_doj_crime_stats | silver_doj_crime_stats | NIBRS validation, arrest_rate calculation, crime_severity mapping |
# MAGIC | bronze_doj_federal_cases | silver_doj_federal_cases | District validation, guideline analysis, departure calculations |
# MAGIC | bronze_doj_antitrust | silver_doj_antitrust | HHI validation, concentration classification, merger presumption |
# MAGIC | bronze_doj_drug_enforcement | silver_doj_drug_enforcement | Drug schedule validation, street value analysis, outlier detection |
# MAGIC
# MAGIC **Partitioned By:** reporting_year/filing_year/seizure_year
# MAGIC
# MAGIC **Lookup Tables:** silver_doj_districts (district → circuit → state mapping)
# MAGIC
# MAGIC **Next Step:** Continue to Gold layer for DOJ justice analytics.
