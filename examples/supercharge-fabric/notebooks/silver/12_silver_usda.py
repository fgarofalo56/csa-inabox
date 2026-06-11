# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: USDA Crop Production & Food Safety
# MAGIC
# MAGIC This notebook transforms Bronze USDA data into cleansed, validated,
# MAGIC and standardized Silver layer tables for two domains:
# MAGIC
# MAGIC ## Domain 1: Crop Production (silver_usda_crop_production)
# MAGIC - Source: `lh_bronze.bronze_usda_crop_production`
# MAGIC - Schema enforcement and type casting
# MAGIC - FIPS code validation (state and county)
# MAGIC - Commodity and statistic category validation
# MAGIC - Standardization: uppercase commodity, trim strings, normalize state names
# MAGIC - Deduplication on composite key
# MAGIC - Data quality scoring (0-100)
# MAGIC
# MAGIC ## Domain 2: Food Safety (silver_usda_food_safety)
# MAGIC - Source: `lh_bronze.bronze_usda_food_safety`
# MAGIC - Schema enforcement and type casting
# MAGIC - Recall class and product type validation
# MAGIC - Status standardization
# MAGIC - Deduplication on recall_number
# MAGIC - Data quality scoring (0-100)

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
    desc,
    filter,
    lit,
    max,
    to_date,
    trim,
    upper,
    when,
    year,
)
from pyspark.sql.types import DecimalType, IntegerType

# Parameters (set by pipeline or manual)
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source tables (Bronze)
SOURCE_CROP = "lh_bronze.bronze_usda_crop_production"
SOURCE_FOOD_SAFETY = "lh_bronze.bronze_usda_food_safety"

# Target tables (Silver)
TARGET_CROP = "lh_silver.silver_usda_crop_production"
TARGET_FOOD_SAFETY = "lh_silver.silver_usda_food_safety"

print(f"Processing batch: {batch_id}")
print(f"Sources: {SOURCE_CROP}, {SOURCE_FOOD_SAFETY}")
print(f"Targets: {TARGET_CROP}, {TARGET_FOOD_SAFETY}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Reference Data: Valid Codes & Mappings

# COMMAND ----------

# Valid US State FIPS codes (agriculturally significant states)
VALID_STATE_FIPS = {
    "01": "ALABAMA",
    "04": "ARIZONA",
    "05": "ARKANSAS",
    "06": "CALIFORNIA",
    "08": "COLORADO",
    "09": "CONNECTICUT",
    "10": "DELAWARE",
    "12": "FLORIDA",
    "13": "GEORGIA",
    "16": "IDAHO",
    "17": "ILLINOIS",
    "18": "INDIANA",
    "19": "IOWA",
    "20": "KANSAS",
    "21": "KENTUCKY",
    "22": "LOUISIANA",
    "23": "MAINE",
    "24": "MARYLAND",
    "25": "MASSACHUSETTS",
    "26": "MICHIGAN",
    "27": "MINNESOTA",
    "28": "MISSISSIPPI",
    "29": "MISSOURI",
    "30": "MONTANA",
    "31": "NEBRASKA",
    "32": "NEVADA",
    "33": "NEW HAMPSHIRE",
    "34": "NEW JERSEY",
    "35": "NEW MEXICO",
    "36": "NEW YORK",
    "37": "NORTH CAROLINA",
    "38": "NORTH DAKOTA",
    "39": "OHIO",
    "40": "OKLAHOMA",
    "41": "OREGON",
    "42": "PENNSYLVANIA",
    "44": "RHODE ISLAND",
    "45": "SOUTH CAROLINA",
    "46": "SOUTH DAKOTA",
    "47": "TENNESSEE",
    "48": "TEXAS",
    "49": "UTAH",
    "50": "VERMONT",
    "51": "VIRGINIA",
    "53": "WASHINGTON",
    "54": "WEST VIRGINIA",
    "55": "WISCONSIN",
    "56": "WYOMING",
}

VALID_STATE_FIPS_LIST = list(VALID_STATE_FIPS.keys())

# Valid commodities per NASS QuickStats
VALID_COMMODITIES = [
    "CORN", "SOYBEANS", "WHEAT", "COTTON", "RICE",
    "BARLEY", "OATS", "SORGHUM", "HAY", "POTATOES",
]

# Valid statistic categories
VALID_STATISTIC_CATEGORIES = [
    "AREA PLANTED", "AREA HARVESTED", "YIELD", "PRODUCTION", "PRICE RECEIVED",
]

# Valid aggregation levels
VALID_AGG_LEVELS = ["NATIONAL", "STATE", "COUNTY"]

# Valid source descriptions
VALID_SOURCE_DESCS = ["SURVEY", "CENSUS"]

# Food safety: valid recall classes
VALID_RECALL_CLASSES = ["Class I", "Class II", "Class III"]

# Food safety: valid product types
VALID_PRODUCT_TYPES = [
    "BEEF", "POULTRY", "PORK", "PROCESSED",
    "READY-TO-EAT", "IMPORTED", "OTHER",
]

# Food safety: valid statuses
VALID_STATUSES = ["OPEN", "CLOSED", "EXPANDED"]

# State FIPS to name mapping for normalization
state_fips_map_expr = create_map(
    [lit(x) for pair in VALID_STATE_FIPS.items() for x in pair]
)

print("Reference data loaded:")
print(f"  Valid state FIPS codes: {len(VALID_STATE_FIPS)}")
print(f"  Valid commodities: {len(VALID_COMMODITIES)}")
print(f"  Valid statistic categories: {len(VALID_STATISTIC_CATEGORIES)}")
print(f"  Valid recall classes: {len(VALID_RECALL_CLASSES)}")
print(f"  Valid product types: {len(VALID_PRODUCT_TYPES)}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Domain 1: Crop Production
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Crop Production Data

# COMMAND ----------

df_crop_bronze = spark.table(SOURCE_CROP)

crop_bronze_count = df_crop_bronze.count()
print(f"Bronze crop production records: {crop_bronze_count:,}")
print(f"Columns: {len(df_crop_bronze.columns)}")
df_crop_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Schema Enforcement & Type Casting

# COMMAND ----------

df_crop_typed = df_crop_bronze \
    .withColumn("value", col("value").cast(DecimalType(18, 2))) \
    .withColumn("cv_percent", col("cv_percent").cast(DecimalType(8, 2))) \
    .withColumn("year", col("year").cast(IntegerType()))

# Verify type casting results
null_after_cast = df_crop_typed.filter(
    col("value").isNull() & df_crop_bronze["value"].isNotNull()
).count()
print(f"Records with value lost during cast: {null_after_cast}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Null Handling & Field Coalescing

# COMMAND ----------

# cv_percent defaults to null if missing (already handled by cast)
# Coalesce county fields: county_fips and county_name may be null for non-county aggregations
df_crop_nulls = df_crop_typed \
    .withColumn("county_fips",
        when(col("agg_level_desc") == "COUNTY", coalesce(col("county_fips"), lit("UNKNOWN")))
        .otherwise(lit(None))
    ) \
    .withColumn("county_name",
        when(col("agg_level_desc") == "COUNTY", coalesce(col("county_name"), lit("Unknown County")))
        .otherwise(lit(None))
    )

print("Null handling applied:")
print("  - cv_percent: null if missing (no default override)")
print("  - county_fips: coalesced to 'UNKNOWN' for COUNTY-level records")
print("  - county_name: coalesced to 'Unknown County' for COUNTY-level records")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Validation

# COMMAND ----------

# Validate state_fips against known FIPS codes
df_crop_validated = df_crop_nulls \
    .withColumn("_valid_state",
        col("state_fips").isin(VALID_STATE_FIPS_LIST)
    ) \
    .withColumn("_valid_commodity",
        upper(trim(col("commodity"))).isin(VALID_COMMODITIES)
    ) \
    .withColumn("_valid_stat_category",
        upper(trim(col("statisticcat_desc"))).isin(VALID_STATISTIC_CATEGORIES)
    ) \
    .withColumn("_valid_agg_level",
        upper(trim(col("agg_level_desc"))).isin(VALID_AGG_LEVELS)
    ) \
    .withColumn("_value_not_null",
        col("value").isNotNull()
    )

# Print validation summary
total_crop = df_crop_validated.count()
valid_state = df_crop_validated.filter(col("_valid_state")).count()
valid_commodity = df_crop_validated.filter(col("_valid_commodity")).count()
valid_stat = df_crop_validated.filter(col("_valid_stat_category")).count()
valid_agg = df_crop_validated.filter(col("_valid_agg_level")).count()
value_present = df_crop_validated.filter(col("_value_not_null")).count()

print("Crop Production Validation Summary:")
print(f"  Valid state_fips:       {valid_state:,}/{total_crop:,} ({valid_state/max(total_crop,1)*100:.1f}%)")
print(f"  Valid commodity:        {valid_commodity:,}/{total_crop:,} ({valid_commodity/max(total_crop,1)*100:.1f}%)")
print(f"  Valid stat category:    {valid_stat:,}/{total_crop:,} ({valid_stat/max(total_crop,1)*100:.1f}%)")
print(f"  Valid agg level:        {valid_agg:,}/{total_crop:,} ({valid_agg/max(total_crop,1)*100:.1f}%)")
print(f"  Value not null:         {value_present:,}/{total_crop:,} ({value_present/max(total_crop,1)*100:.1f}%)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Standardization

# COMMAND ----------

df_crop_std = df_crop_validated \
    .withColumn("commodity", upper(trim(col("commodity")))) \
    .withColumn("statisticcat_desc", upper(trim(col("statisticcat_desc")))) \
    .withColumn("source_desc", upper(trim(col("source_desc")))) \
    .withColumn("agg_level_desc", upper(trim(col("agg_level_desc")))) \
    .withColumn("domain_desc", upper(trim(col("domain_desc")))) \
    .withColumn("reference_period_desc", upper(trim(col("reference_period_desc")))) \
    .withColumn("unit_desc", upper(trim(col("unit_desc")))) \
    .withColumn("state_fips", trim(col("state_fips"))) \
    .withColumn("county_fips", trim(col("county_fips"))) \
    .withColumn("county_name", trim(col("county_name"))) \
    .withColumn("state_name_normalized",
        coalesce(
            state_fips_map_expr[col("state_fips")],
            upper(trim(col("state_name")))
        )
    )

print("Standardization applied:")
print("  - commodity: UPPERCASED and TRIMMED")
print("  - statisticcat_desc: UPPERCASED and TRIMMED")
print("  - source_desc, agg_level_desc, domain_desc: UPPERCASED and TRIMMED")
print("  - state_name: Normalized via FIPS lookup, fallback to UPPER(TRIM())")
print("  - All string fields: TRIMMED")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Deduplication

# COMMAND ----------

crop_before_dedup = df_crop_std.count()

df_crop_deduped = df_crop_std.dropDuplicates([
    "commodity", "year", "state_fips", "county_fips",
    "statisticcat_desc", "source_desc"
])

crop_after_dedup = df_crop_deduped.count()
crop_dupes = crop_before_dedup - crop_after_dedup

print(f"Crop Production Deduplication:")
print(f"  Before: {crop_before_dedup:,}")
print(f"  After:  {crop_after_dedup:,}")
print(f"  Duplicates removed: {crop_dupes:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Score (0-100)

# COMMAND ----------

df_crop_dq = df_crop_deduped \
    .withColumn("_dq_score",
        (
            when(col("_valid_commodity"), lit(20)).otherwise(lit(0)) +
            when(col("_valid_state"), lit(20)).otherwise(lit(0)) +
            when(col("_value_not_null"), lit(20)).otherwise(lit(0)) +
            when(col("_valid_stat_category"), lit(20)).otherwise(lit(0)) +
            when(col("_valid_agg_level"), lit(20)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(~col("_valid_commodity"), lit("INVALID_COMMODITY")),
                when(~col("_valid_state"), lit("INVALID_STATE_FIPS")),
                when(~col("_value_not_null"), lit("NULL_VALUE")),
                when(~col("_valid_stat_category"), lit("INVALID_STAT_CATEGORY")),
                when(~col("_valid_agg_level"), lit("INVALID_AGG_LEVEL"))
            )
        )
    )

# Score distribution
print("Crop Production - DQ Score Distribution:")
display(
    df_crop_dq.groupBy("_dq_score")
    .count()
    .orderBy(col("_dq_score").desc())
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Silver Metadata

# COMMAND ----------

df_crop_silver = df_crop_dq \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id)) \
    .drop("_valid_state", "_valid_commodity", "_valid_stat_category",
          "_valid_agg_level", "_value_not_null")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Silver Crop Production Table

# COMMAND ----------

try:
    crop_columns = [
        # Core fields
        "record_id", "commodity", "year",
        # Geography
        "state_fips", "state_name_normalized", "county_fips", "county_name",
        # Statistics
        "statisticcat_desc", "unit_desc", "value", "cv_percent",
        "source_desc", "agg_level_desc", "domain_desc", "reference_period_desc",
        # Data quality
        "_dq_score", "_dq_flags",
        # Metadata
        "_silver_timestamp", "_batch_id",
    ]

    df_crop_out = df_crop_silver.select(
        [col(c) for c in crop_columns if c in df_crop_silver.columns]
    )

    # Write to Silver layer using Delta MERGE (incremental upsert)
    if spark.catalog.tableExists(TARGET_CROP):
        deltaTable = DeltaTable.forName(spark, TARGET_CROP)
        deltaTable.alias("target").merge(
            df_crop_out.alias("source"),
            "target.record_id = source.record_id"
        ).whenMatchedUpdateAll(
            condition="target._silver_timestamp < source._silver_timestamp"
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_crop_out.write \
            .format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .partitionBy("year") \
            .saveAsTable(TARGET_CROP)

    crop_silver_count = spark.table(TARGET_CROP).count()
    print(f"Written/merged records to {TARGET_CROP} (total: {crop_silver_count:,})")
except Exception as e:
    print(f"ERROR in unknown (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize Crop Production Table

# COMMAND ----------

spark.sql(f"OPTIMIZE {TARGET_CROP} ZORDER BY (commodity, state_fips)")
print(f"Optimized {TARGET_CROP} with Z-Order on commodity, state_fips")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Domain 2: Food Safety
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Food Safety Data

# COMMAND ----------

df_food_bronze = spark.table(SOURCE_FOOD_SAFETY)

food_bronze_count = df_food_bronze.count()
print(f"Bronze food safety records: {food_bronze_count:,}")
print(f"Columns: {len(df_food_bronze.columns)}")
df_food_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Schema Enforcement & Type Casting

# COMMAND ----------

df_food_typed = df_food_bronze \
    .withColumn("recall_date", to_date(col("recall_date"))) \
    .withColumn("pounds_recalled", col("pounds_recalled").cast(DecimalType(18, 2)))

# Verify casting results
null_date_after_cast = df_food_typed.filter(
    col("recall_date").isNull() & df_food_bronze["recall_date"].isNotNull()
).count()
null_pounds_after_cast = df_food_typed.filter(
    col("pounds_recalled").isNull() & df_food_bronze["pounds_recalled"].isNotNull()
).count()

print(f"Records with recall_date lost during cast: {null_date_after_cast}")
print(f"Records with pounds_recalled lost during cast: {null_pounds_after_cast}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validate Recall Class & Product Type

# COMMAND ----------

df_food_validated = df_food_typed \
    .withColumn("_valid_recall_class",
        col("recall_class").isin(VALID_RECALL_CLASSES)
    ) \
    .withColumn("_valid_product_type",
        upper(trim(col("product_type"))).isin(VALID_PRODUCT_TYPES)
    ) \
    .withColumn("_pounds_not_null",
        col("pounds_recalled").isNotNull()
    ) \
    .withColumn("_distribution_not_null",
        col("distribution").isNotNull()
    )

# Print validation summary
total_food = df_food_validated.count()
valid_class = df_food_validated.filter(col("_valid_recall_class")).count()
valid_prod = df_food_validated.filter(col("_valid_product_type")).count()
pounds_present = df_food_validated.filter(col("_pounds_not_null")).count()
dist_present = df_food_validated.filter(col("_distribution_not_null")).count()

print("Food Safety Validation Summary:")
print(f"  Valid recall_class:     {valid_class:,}/{total_food:,} ({valid_class/max(total_food,1)*100:.1f}%)")
print(f"  Valid product_type:     {valid_prod:,}/{total_food:,} ({valid_prod/max(total_food,1)*100:.1f}%)")
print(f"  Pounds not null:        {pounds_present:,}/{total_food:,} ({pounds_present/max(total_food,1)*100:.1f}%)")
print(f"  Distribution not null:  {dist_present:,}/{total_food:,} ({dist_present/max(total_food,1)*100:.1f}%)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Standardize Status Values

# COMMAND ----------

df_food_std = df_food_validated \
    .withColumn("status", upper(trim(col("status")))) \
    .withColumn("product_type", upper(trim(col("product_type")))) \
    .withColumn("company_name", trim(col("company_name"))) \
    .withColumn("city", trim(col("city"))) \
    .withColumn("state", upper(trim(col("state")))) \
    .withColumn("reason", trim(col("reason"))) \
    .withColumn("distribution", trim(col("distribution"))) \
    .withColumn("risk_level", upper(trim(col("risk_level")))) \
    .withColumn("establishment_number", trim(col("establishment_number")))

print("Standardization applied:")
print("  - status: UPPERCASED and TRIMMED")
print("  - product_type: UPPERCASED and TRIMMED")
print("  - state: UPPERCASED and TRIMMED")
print("  - risk_level: UPPERCASED and TRIMMED")
print("  - company_name, city, reason, distribution, establishment_number: TRIMMED")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Deduplication

# COMMAND ----------

food_before_dedup = df_food_std.count()

df_food_deduped = df_food_std.dropDuplicates(["recall_number"])

food_after_dedup = df_food_deduped.count()
food_dupes = food_before_dedup - food_after_dedup

print(f"Food Safety Deduplication:")
print(f"  Before: {food_before_dedup:,}")
print(f"  After:  {food_after_dedup:,}")
print(f"  Duplicates removed: {food_dupes:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Score (0-100)

# COMMAND ----------

df_food_dq = df_food_deduped \
    .withColumn("_dq_score",
        (
            when(col("_valid_recall_class"), lit(25)).otherwise(lit(0)) +
            when(col("_valid_product_type"), lit(25)).otherwise(lit(0)) +
            when(col("_pounds_not_null"), lit(25)).otherwise(lit(0)) +
            when(col("_distribution_not_null"), lit(25)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(~col("_valid_recall_class"), lit("INVALID_RECALL_CLASS")),
                when(~col("_valid_product_type"), lit("INVALID_PRODUCT_TYPE")),
                when(~col("_pounds_not_null"), lit("NULL_POUNDS_RECALLED")),
                when(~col("_distribution_not_null"), lit("NULL_DISTRIBUTION"))
            )
        )
    )

# Score distribution
print("Food Safety - DQ Score Distribution:")
display(
    df_food_dq.groupBy("_dq_score")
    .count()
    .orderBy(col("_dq_score").desc())
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Silver Metadata

# COMMAND ----------

# Extract recall year for partitioning
df_food_silver = df_food_dq \
    .withColumn("recall_year", year(col("recall_date"))) \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id)) \
    .drop("_valid_recall_class", "_valid_product_type",
          "_pounds_not_null", "_distribution_not_null")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Silver Food Safety Table

# COMMAND ----------

food_columns = [
    # Core fields
    "recall_id", "recall_number", "recall_date", "recall_year",
    # Product details
    "product_type", "recall_class", "reason", "risk_level",
    # Company and location
    "company_name", "establishment_number", "city", "state",
    # Recall details
    "pounds_recalled", "distribution", "status",
    # Reference
    "press_release_url",
    # Data quality
    "_dq_score", "_dq_flags",
    # Metadata
    "_silver_timestamp", "_batch_id",
]

df_food_out = df_food_silver.select(
    [col(c) for c in food_columns if c in df_food_silver.columns]
)

# Write to Silver layer using Delta MERGE (incremental upsert)
if spark.catalog.tableExists(TARGET_FOOD_SAFETY):
    deltaTable = DeltaTable.forName(spark, TARGET_FOOD_SAFETY)
    deltaTable.alias("target").merge(
        df_food_out.alias("source"),
        "target.recall_id = source.recall_id"
    ).whenMatchedUpdateAll(
        condition="target._silver_timestamp < source._silver_timestamp"
    ).whenNotMatchedInsertAll(
    ).execute()
else:
    df_food_out.write \
        .format("delta") \
        .mode("overwrite") \
        .option("overwriteSchema", "true") \
        .partitionBy("recall_year") \
        .saveAsTable(TARGET_FOOD_SAFETY)

food_silver_count = spark.table(TARGET_FOOD_SAFETY).count()
print(f"Written/merged records to {TARGET_FOOD_SAFETY} (total: {food_silver_count:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize Food Safety Table

# COMMAND ----------

spark.sql(f"OPTIMIZE {TARGET_FOOD_SAFETY} ZORDER BY (recall_class, product_type)")
print(f"Optimized {TARGET_FOOD_SAFETY} with Z-Order on recall_class, product_type")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Validation: Data Quality Summaries
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Crop Production Quality Summary

# COMMAND ----------

print("=" * 60)
print("DATA QUALITY REPORT - USDA Crop Production Silver Layer")
print("=" * 60)

spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        ROUND(MIN(_dq_score), 2) as min_quality_score,
        ROUND(MAX(_dq_score), 2) as max_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(CASE WHEN _dq_score >= 80 THEN 1 END) as high_quality_records,
        COUNT(CASE WHEN _dq_score < 60 THEN 1 END) as low_quality_records
    FROM {TARGET_CROP}
""").show(truncate=False)

# COMMAND ----------

# Quality by commodity
print("Crop Production - Quality by Commodity:")
spark.sql(f"""
    SELECT
        commodity,
        COUNT(*) as records,
        ROUND(AVG(_dq_score), 2) as avg_quality,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect
    FROM {TARGET_CROP}
    GROUP BY commodity
    ORDER BY records DESC
""").show(truncate=False)

# COMMAND ----------

# Quality by state
print("Crop Production - Quality by State (Top 15):")
spark.sql(f"""
    SELECT
        state_fips,
        state_name_normalized as state_name,
        COUNT(*) as records,
        ROUND(AVG(_dq_score), 2) as avg_quality
    FROM {TARGET_CROP}
    GROUP BY state_fips, state_name_normalized
    ORDER BY records DESC
    LIMIT 15
""").show(truncate=False)

# COMMAND ----------

# Distribution by statistic category and aggregation level
print("Crop Production - Records by Statistic Category:")
spark.sql(f"""
    SELECT
        statisticcat_desc,
        agg_level_desc,
        COUNT(*) as records,
        ROUND(AVG(value), 2) as avg_value
    FROM {TARGET_CROP}
    GROUP BY statisticcat_desc, agg_level_desc
    ORDER BY statisticcat_desc, agg_level_desc
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Food Safety Quality Summary

# COMMAND ----------

print("=" * 60)
print("DATA QUALITY REPORT - USDA Food Safety Silver Layer")
print("=" * 60)

spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        ROUND(MIN(_dq_score), 2) as min_quality_score,
        ROUND(MAX(_dq_score), 2) as max_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(CASE WHEN _dq_score >= 80 THEN 1 END) as high_quality_records,
        COUNT(CASE WHEN _dq_score < 60 THEN 1 END) as low_quality_records
    FROM {TARGET_FOOD_SAFETY}
""").show(truncate=False)

# COMMAND ----------

# Quality by recall class
print("Food Safety - Quality by Recall Class:")
spark.sql(f"""
    SELECT
        recall_class,
        COUNT(*) as recalls,
        ROUND(AVG(_dq_score), 2) as avg_quality,
        ROUND(SUM(pounds_recalled), 0) as total_pounds_recalled,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect
    FROM {TARGET_FOOD_SAFETY}
    GROUP BY recall_class
    ORDER BY recalls DESC
""").show(truncate=False)

# COMMAND ----------

# Quality by product type
print("Food Safety - Quality by Product Type:")
spark.sql(f"""
    SELECT
        product_type,
        COUNT(*) as recalls,
        ROUND(AVG(_dq_score), 2) as avg_quality,
        ROUND(AVG(pounds_recalled), 0) as avg_pounds_recalled
    FROM {TARGET_FOOD_SAFETY}
    GROUP BY product_type
    ORDER BY recalls DESC
""").show(truncate=False)

# COMMAND ----------

# Recalls by year and status
print("Food Safety - Recalls by Year and Status:")
spark.sql(f"""
    SELECT
        recall_year,
        status,
        COUNT(*) as recalls,
        ROUND(SUM(pounds_recalled), 0) as total_pounds
    FROM {TARGET_FOOD_SAFETY}
    GROUP BY recall_year, status
    ORDER BY recall_year DESC, recalls DESC
""").show(20, truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Source Table | Target Table | Key Transformations |
# MAGIC |-------------|-------------|---------------------|
# MAGIC | bronze_usda_crop_production | silver_usda_crop_production | Type casting, FIPS validation, commodity validation, state normalization, dedup on composite key |
# MAGIC | bronze_usda_food_safety | silver_usda_food_safety | Date/decimal casting, recall class validation, product type validation, status standardization, dedup on recall_number |
# MAGIC
# MAGIC | Domain | DQ Scoring | Partition | Z-Order |
# MAGIC |--------|-----------|-----------|---------|
# MAGIC | Crop Production | valid commodity (20) + valid state (20) + value not null (20) + valid stat category (20) + valid agg level (20) | year | commodity, state_fips |
# MAGIC | Food Safety | valid recall class (25) + valid product type (25) + pounds_recalled not null (25) + distribution not null (25) | recall_year | recall_class, product_type |
# MAGIC
# MAGIC **Next Step:** Continue to Gold layer for USDA analytics (`12_gold_usda_analytics`).
