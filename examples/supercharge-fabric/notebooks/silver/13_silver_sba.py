# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: SBA Loan Data Cleansing & Standardization
# MAGIC
# MAGIC This notebook transforms Bronze SBA loan data into cleansed, validated,
# MAGIC and enriched Silver layer tables.
# MAGIC
# MAGIC ## Transformations Applied:
# MAGIC - Type casting: loan_amount/forgiveness_amount as DecimalType(18,2), jobs_retained as IntegerType
# MAGIC - NAICS code validation (2-6 digit range)
# MAGIC - Loan status validation against known values
# MAGIC - State abbreviation and business_type standardization
# MAGIC - Deduplication by loan_id
# MAGIC - Derived: forgiveness_rate (forgiveness_amount / loan_amount)
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
SOURCE_PPP = "lh_bronze.bronze_sba_ppp_loans"
SOURCE_7A_504 = "lh_bronze.bronze_sba_7a_504_loans"

# Target tables (Silver)
TARGET_PPP = "lh_silver.silver_sba_ppp_loans"
TARGET_7A_504 = "lh_silver.silver_sba_7a_504_loans"

print(f"Processing batch: {batch_id}")
print(f"Sources: {SOURCE_PPP}, {SOURCE_7A_504}")
print(f"Targets: {TARGET_PPP}, {TARGET_7A_504}")

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

# Known PPP loan statuses
VALID_PPP_LOAN_STATUSES = [
    "ACTIVE", "PAID_IN_FULL", "EXEMPTION_4",
    "CHARGED_OFF", "CANCELLED", "FULLY_FORGIVEN",
    "PARTIALLY_FORGIVEN", "NOT_FORGIVEN",
]

# Known 7(a)/504 loan statuses
VALID_7A_504_STATUSES = [
    "DISBURSED", "APPROVED", "CANCELLED", "CHARGED_OFF",
    "PAID_IN_FULL", "COMMITTED", "EXEMPT",
]

# Known program types for 7(a)/504
VALID_PROGRAM_TYPES = [
    "7A", "504", "COMMUNITY_ADVANTAGE", "SBA_EXPRESS",
    "EXPORT_EXPRESS", "CAPLINES", "MICRO_LOAN",
]

# Business type standardization
BUSINESS_TYPE_MAP = {
    "SOLE PROPRIETORSHIP": "Sole Proprietorship",
    "SOLE PROP": "Sole Proprietorship",
    "PARTNERSHIP": "Partnership",
    "CORPORATION": "Corporation",
    "CORP": "Corporation",
    "C CORP": "C Corporation",
    "C CORPORATION": "C Corporation",
    "S CORP": "S Corporation",
    "S CORPORATION": "S Corporation",
    "LLC": "LLC",
    "LIMITED LIABILITY COMPANY": "LLC",
    "NON-PROFIT": "Non-Profit",
    "NONPROFIT": "Non-Profit",
    "501C3": "Non-Profit",
    "COOPERATIVE": "Cooperative",
    "TRUST": "Trust",
    "TRIBAL": "Tribal Concern",
    "TRIBAL CONCERN": "Tribal Concern",
    "INDEPENDENT CONTRACTOR": "Independent Contractor",
    "SELF-EMPLOYED": "Self-Employed",
    "ESOP": "ESOP",
}

business_type_expr = create_map([lit(x) for pair in BUSINESS_TYPE_MAP.items() for x in pair])

print("Reference data loaded:")
print(f"  Valid states: {len(VALID_STATES)}")
print(f"  PPP loan statuses: {len(VALID_PPP_LOAN_STATUSES)}")
print(f"  7(a)/504 statuses: {len(VALID_7A_504_STATUSES)}")
print(f"  Program types: {len(VALID_PROGRAM_TYPES)}")
print(f"  Business type mappings: {len(BUSINESS_TYPE_MAP)}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 1: PPP Loans (bronze_sba_ppp_loans -> silver_sba_ppp_loans)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Read Bronze PPP Data

# COMMAND ----------

df_ppp_bronze = spark.table(SOURCE_PPP)

ppp_bronze_count = df_ppp_bronze.count()
print(f"Bronze PPP records: {ppp_bronze_count:,}")
print(f"Columns: {len(df_ppp_bronze.columns)}")
df_ppp_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ### Type Casting

# COMMAND ----------

df_ppp_typed = df_ppp_bronze \
    .withColumn("loan_amount",
        col("loan_amount").cast(DecimalType(18, 2))) \
    .withColumn("forgiveness_amount",
        coalesce(col("forgiveness_amount"), lit(0)).cast(DecimalType(18, 2))) \
    .withColumn("jobs_retained",
        col("jobs_retained").cast(IntegerType())) \
    .withColumn("approval_date",
        to_date(col("approval_date"))) \
    .withColumn("forgiveness_date",
        to_date(col("forgiveness_date")))

print("Type casting applied:")
print("  loan_amount -> DecimalType(18,2)")
print("  forgiveness_amount -> DecimalType(18,2)")
print("  jobs_retained -> IntegerType")
print("  approval_date, forgiveness_date -> DateType")

# COMMAND ----------

# MAGIC %md
# MAGIC ### NAICS Code Validation
# MAGIC
# MAGIC NAICS codes must be between 2 and 6 digits.

# COMMAND ----------

NAICS_PATTERN = r"^\d{2,6}$"

df_ppp_naics = df_ppp_typed \
    .withColumn("naics_code_clean", trim(col("naics_code"))) \
    .withColumn("naics_valid",
        col("naics_code_clean").rlike(NAICS_PATTERN)) \
    .withColumn("naics_sector",
        when(col("naics_valid"), substring(col("naics_code_clean"), 1, 2))
        .otherwise(lit(None)))

valid_naics = df_ppp_naics.filter(col("naics_valid") == True).count()
invalid_naics = df_ppp_naics.filter(col("naics_valid") == False).count()

print("NAICS Code Validation:")
print(f"  Valid codes: {valid_naics:,}")
print(f"  Invalid codes: {invalid_naics:,}")
print(f"  Validation rate: {valid_naics / max(valid_naics + invalid_naics, 1) * 100:.1f}%")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Loan Status & State Validation

# COMMAND ----------

df_ppp_validated = df_ppp_naics \
    .withColumn("loan_status_clean", upper(trim(col("loan_status")))) \
    .withColumn("loan_status_valid",
        col("loan_status_clean").isin(VALID_PPP_LOAN_STATUSES)) \
    .withColumn("state_clean", upper(trim(col("state")))) \
    .withColumn("state_valid",
        col("state_clean").isin(VALID_STATES)) \
    .withColumn("business_type_clean", upper(trim(col("business_type")))) \
    .withColumn("business_type_std",
        coalesce(
            business_type_expr[upper(trim(col("business_type")))],
            initcap(trim(col("business_type")))
        ))

invalid_status = df_ppp_validated.filter(~col("loan_status_valid") & col("loan_status").isNotNull()).count()
invalid_state = df_ppp_validated.filter(~col("state_valid") & col("state").isNotNull()).count()

print("Status & State Validation:")
print(f"  Invalid loan statuses: {invalid_status:,}")
print(f"  Invalid state abbreviations: {invalid_state:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Deduplication
# MAGIC
# MAGIC Remove duplicate PPP loan records by loan_id.

# COMMAND ----------

before_dedup = df_ppp_validated.count()

df_ppp_deduped = df_ppp_validated.dropDuplicates(["loan_id"])

after_dedup = df_ppp_deduped.count()
dupes_removed = before_dedup - after_dedup

print(f"PPP Deduplication Results:")
print(f"  Before: {before_dedup:,}")
print(f"  After: {after_dedup:,}")
print(f"  Duplicates removed: {dupes_removed:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Derived Fields: Forgiveness Rate

# COMMAND ----------

df_ppp_derived = df_ppp_deduped \
    .withColumn("forgiveness_rate",
        when(
            col("loan_amount").isNotNull() & (col("loan_amount") > 0),
            round(col("forgiveness_amount") / col("loan_amount"), 4)
        ).otherwise(lit(None).cast(DecimalType(18, 4)))
    ) \
    .withColumn("is_fully_forgiven",
        (col("forgiveness_rate") >= 0.9999).cast("boolean")) \
    .withColumn("approval_year",
        year(col("approval_date")))

print("Derived fields added:")
print("  forgiveness_rate = forgiveness_amount / loan_amount")
print("  is_fully_forgiven = forgiveness_rate >= 0.9999")
print("  approval_year = year(approval_date)")

# COMMAND ----------

# MAGIC %md
# MAGIC ### PPP Data Quality Score
# MAGIC
# MAGIC | Check | Points |
# MAGIC |-------|--------|
# MAGIC | Valid NAICS code | 25 |
# MAGIC | loan_amount > 0 | 25 |
# MAGIC | Valid state abbreviation | 25 |
# MAGIC | Has jobs_retained value | 25 |

# COMMAND ----------

df_ppp_dq = df_ppp_derived \
    .withColumn("_dq_score",
        (
            when(col("naics_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("loan_amount").isNotNull() & (col("loan_amount") > 0), lit(25)).otherwise(lit(0)) +
            when(col("state_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("jobs_retained").isNotNull(), lit(25)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(col("naics_valid") == False, lit("INVALID_NAICS")),
                when(col("loan_amount").isNull() | (col("loan_amount") <= 0), lit("INVALID_LOAN_AMOUNT")),
                when(col("state_valid") == False, lit("INVALID_STATE")),
                when(col("jobs_retained").isNull(), lit("MISSING_JOBS_RETAINED")),
                when(col("loan_status_valid") == False, lit("INVALID_LOAN_STATUS"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Silver Metadata & Write PPP Table

# COMMAND ----------

try:
    df_ppp_silver = df_ppp_dq \
        .withColumn("_silver_timestamp", current_timestamp()) \
        .withColumn("_batch_id", lit(batch_id))

    ppp_columns = [
        # Identifiers
        "loan_id", "sba_office_code",
        # Borrower
        "business_name", "business_type_std", "naics_code_clean", "naics_sector", "naics_valid",
        "state_clean", "state_valid", "city", "zip_code",
        # Loan details
        "loan_amount", "forgiveness_amount", "forgiveness_rate", "is_fully_forgiven",
        "loan_status_clean", "loan_status_valid",
        "approval_date", "forgiveness_date", "approval_year",
        "lender_name", "lender_state",
        # Jobs
        "jobs_retained",
        # Quality & metadata
        "_dq_score", "_dq_flags", "_silver_timestamp", "_batch_id",
    ]

    df_ppp_out = df_ppp_silver.select(
        [col(c) for c in ppp_columns if c in df_ppp_silver.columns]
    )

    # Write to Silver layer using Delta MERGE (incremental upsert)
    if spark.catalog.tableExists(TARGET_PPP):
        deltaTable = DeltaTable.forName(spark, TARGET_PPP)
        deltaTable.alias("target").merge(
            df_ppp_out.alias("source"),
            "target.loan_id = source.loan_id"
        ).whenMatchedUpdateAll(
            condition="target._silver_timestamp < source._silver_timestamp"
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_ppp_out.write \
            .format("delta") \
            .mode("overwrite") \
            .partitionBy("approval_year") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_PPP)

    ppp_silver_count = spark.table(TARGET_PPP).count()
    print(f"Written/merged records to {TARGET_PPP} (total: {ppp_silver_count:,})")
except Exception as e:
    print(f"ERROR in unknown (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 2: 7(a)/504 Loans (bronze_sba_7a_504_loans -> silver_sba_7a_504_loans)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Read Bronze 7(a)/504 Data

# COMMAND ----------

df_7a_bronze = spark.table(SOURCE_7A_504)

bronze_7a_count = df_7a_bronze.count()
print(f"Bronze 7(a)/504 records: {bronze_7a_count:,}")
print(f"Columns: {len(df_7a_bronze.columns)}")
df_7a_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ### Type Casting & Cleansing

# COMMAND ----------

df_7a_typed = df_7a_bronze \
    .withColumn("approval_amount",
        col("approval_amount").cast(DecimalType(18, 2))) \
    .withColumn("gross_charge_off_amount",
        coalesce(col("gross_charge_off_amount"), lit(0)).cast(DecimalType(18, 2))) \
    .withColumn("term_months",
        col("term_months").cast(IntegerType())) \
    .withColumn("jobs_supported",
        col("jobs_supported").cast(IntegerType())) \
    .withColumn("approval_date",
        to_date(col("approval_date"))) \
    .withColumn("naics_code_clean", trim(col("naics_code"))) \
    .withColumn("naics_valid",
        col("naics_code_clean").rlike(NAICS_PATTERN)) \
    .withColumn("naics_sector",
        when(col("naics_code_clean").rlike(NAICS_PATTERN), substring(col("naics_code_clean"), 1, 2))
        .otherwise(lit(None)))

print("Type casting applied to 7(a)/504 data")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Program Type & State Validation

# COMMAND ----------

df_7a_validated = df_7a_typed \
    .withColumn("program_type_clean", upper(trim(col("program_type")))) \
    .withColumn("program_type_valid",
        col("program_type_clean").isin(VALID_PROGRAM_TYPES)) \
    .withColumn("loan_status_clean", upper(trim(col("loan_status")))) \
    .withColumn("loan_status_valid",
        col("loan_status_clean").isin(VALID_7A_504_STATUSES)) \
    .withColumn("state_clean", upper(trim(col("state")))) \
    .withColumn("state_valid",
        col("state_clean").isin(VALID_STATES)) \
    .withColumn("business_type_std",
        coalesce(
            business_type_expr[upper(trim(col("business_type")))],
            initcap(trim(col("business_type")))
        ))

# Validate term_months range (reasonable: 1 to 600 months / 50 years)
df_7a_validated = df_7a_validated \
    .withColumn("term_months_valid",
        col("term_months").isNotNull() &
        (col("term_months") >= 1) &
        (col("term_months") <= 600)) \
    .withColumn("approval_amount_valid",
        col("approval_amount").isNotNull() &
        (col("approval_amount") > 0))

invalid_program = df_7a_validated.filter(~col("program_type_valid") & col("program_type").isNotNull()).count()
invalid_state = df_7a_validated.filter(~col("state_valid") & col("state").isNotNull()).count()
invalid_term = df_7a_validated.filter(~col("term_months_valid")).count()

print("7(a)/504 Validation Results:")
print(f"  Invalid program types: {invalid_program:,}")
print(f"  Invalid state abbreviations: {invalid_state:,}")
print(f"  Invalid term months: {invalid_term:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Deduplication

# COMMAND ----------

before_dedup_7a = df_7a_validated.count()

df_7a_deduped = df_7a_validated.dropDuplicates(["loan_id"])

after_dedup_7a = df_7a_deduped.count()
dupes_removed_7a = before_dedup_7a - after_dedup_7a

print(f"7(a)/504 Deduplication Results:")
print(f"  Before: {before_dedup_7a:,}")
print(f"  After: {after_dedup_7a:,}")
print(f"  Duplicates removed: {dupes_removed_7a:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Derived Fields & Approval Year

# COMMAND ----------

df_7a_derived = df_7a_deduped \
    .withColumn("approval_year",
        year(col("approval_date"))) \
    .withColumn("charge_off_rate",
        when(
            col("approval_amount").isNotNull() & (col("approval_amount") > 0),
            round(col("gross_charge_off_amount") / col("approval_amount"), 4)
        ).otherwise(lit(None).cast(DecimalType(18, 4)))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### 7(a)/504 Data Quality Score
# MAGIC
# MAGIC | Check | Points |
# MAGIC |-------|--------|
# MAGIC | Valid program type | 25 |
# MAGIC | Valid approval amount | 25 |
# MAGIC | Valid state abbreviation | 25 |
# MAGIC | Valid NAICS code | 25 |

# COMMAND ----------

df_7a_dq = df_7a_derived \
    .withColumn("_dq_score",
        (
            when(col("program_type_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("approval_amount_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("state_valid") == True, lit(25)).otherwise(lit(0)) +
            when(col("naics_valid") == True, lit(25)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(col("program_type_valid") == False, lit("INVALID_PROGRAM_TYPE")),
                when(col("approval_amount_valid") == False, lit("INVALID_APPROVAL_AMOUNT")),
                when(col("state_valid") == False, lit("INVALID_STATE")),
                when(col("naics_valid") == False, lit("INVALID_NAICS")),
                when(col("term_months_valid") == False, lit("INVALID_TERM_MONTHS"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Silver Metadata & Write 7(a)/504 Table

# COMMAND ----------

df_7a_silver = df_7a_dq \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

columns_7a = [
    # Identifiers
    "loan_id", "sba_office_code",
    # Borrower
    "business_name", "business_type_std", "naics_code_clean", "naics_sector", "naics_valid",
    "state_clean", "state_valid", "city", "zip_code",
    # Loan details
    "program_type_clean", "program_type_valid",
    "approval_amount", "approval_amount_valid",
    "gross_charge_off_amount", "charge_off_rate",
    "term_months", "term_months_valid",
    "interest_rate",
    "loan_status_clean", "loan_status_valid",
    "approval_date", "approval_year",
    "lender_name", "lender_state",
    # Jobs
    "jobs_supported",
    # Quality & metadata
    "_dq_score", "_dq_flags", "_silver_timestamp", "_batch_id",
]

df_7a_out = df_7a_silver.select(
    [col(c) for c in columns_7a if c in df_7a_silver.columns]
)

# Write to Silver layer using Delta MERGE (incremental upsert)
if spark.catalog.tableExists(TARGET_7A_504):
    deltaTable = DeltaTable.forName(spark, TARGET_7A_504)
    deltaTable.alias("target").merge(
        df_7a_out.alias("source"),
        "target.loan_id = source.loan_id"
    ).whenMatchedUpdateAll(
        condition="target._silver_timestamp < source._silver_timestamp"
    ).whenNotMatchedInsertAll(
    ).execute()
else:
    df_7a_out.write \
        .format("delta") \
        .mode("overwrite") \
        .partitionBy("approval_year") \
        .option("overwriteSchema", "true") \
        .saveAsTable(TARGET_7A_504)

silver_7a_count = spark.table(TARGET_7A_504).count()
print(f"Written/merged records to {TARGET_7A_504} (total: {silver_7a_count:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Report

# COMMAND ----------

print("=" * 60)
print("SBA Silver Layer - Data Quality Report")
print("=" * 60)

# PPP quality
print(f"\n--- {TARGET_PPP} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        ROUND(MIN(_dq_score), 2) as min_quality_score,
        ROUND(MAX(_dq_score), 2) as max_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(CASE WHEN _dq_score >= 75 THEN 1 END) as high_quality_records,
        COUNT(CASE WHEN _dq_score < 50 THEN 1 END) as low_quality_records
    FROM {TARGET_PPP}
""").show(truncate=False)

# COMMAND ----------

# PPP forgiveness summary
print("PPP Forgiveness Summary:")
spark.sql(f"""
    SELECT
        loan_status_clean as loan_status,
        COUNT(*) as loans,
        ROUND(SUM(loan_amount), 2) as total_loan_amount,
        ROUND(SUM(forgiveness_amount), 2) as total_forgiven,
        ROUND(AVG(forgiveness_rate) * 100, 2) as avg_forgiveness_pct
    FROM {TARGET_PPP}
    GROUP BY loan_status_clean
    ORDER BY loans DESC
""").show(truncate=False)

# COMMAND ----------

# 7(a)/504 quality
print(f"\n--- {TARGET_7A_504} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(CASE WHEN _dq_score < 50 THEN 1 END) as low_quality_records,
        COUNT(DISTINCT program_type_clean) as program_types,
        COUNT(DISTINCT state_clean) as states
    FROM {TARGET_7A_504}
""").show(truncate=False)

# COMMAND ----------

# 7(a)/504 program type breakdown
print("7(a)/504 Program Type Distribution:")
spark.sql(f"""
    SELECT
        program_type_clean as program_type,
        COUNT(*) as loans,
        ROUND(SUM(approval_amount), 2) as total_approved,
        ROUND(AVG(term_months), 1) as avg_term_months,
        ROUND(AVG(_dq_score), 2) as avg_quality
    FROM {TARGET_7A_504}
    GROUP BY program_type_clean
    ORDER BY loans DESC
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize Tables

# COMMAND ----------

spark.sql(f"OPTIMIZE {TARGET_PPP} ZORDER BY (loan_id, state_clean)")
print(f"Optimized {TARGET_PPP} with Z-Order on loan_id, state_clean")

spark.sql(f"OPTIMIZE {TARGET_7A_504} ZORDER BY (loan_id, program_type_clean)")
print(f"Optimized {TARGET_7A_504} with Z-Order on loan_id, program_type_clean")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation Queries

# COMMAND ----------

# Verify no duplicate loan_ids in PPP
ppp_dup_check = spark.sql(f"""
    SELECT loan_id, COUNT(*) as cnt
    FROM {TARGET_PPP}
    GROUP BY loan_id
    HAVING cnt > 1
""")
print(f"PPP duplicate loan_ids (should be 0): {ppp_dup_check.count()}")

# Verify no duplicate loan_ids in 7(a)/504
loan_7a_dup_check = spark.sql(f"""
    SELECT loan_id, COUNT(*) as cnt
    FROM {TARGET_7A_504}
    GROUP BY loan_id
    HAVING cnt > 1
""")
print(f"7(a)/504 duplicate loan_ids (should be 0): {loan_7a_dup_check.count()}")

# Verify forgiveness_rate range in PPP
invalid_forgiveness = spark.sql(f"""
    SELECT COUNT(*) as cnt
    FROM {TARGET_PPP}
    WHERE forgiveness_rate < 0 OR forgiveness_rate > 1.01
""").collect()[0]["cnt"]
print(f"PPP records with forgiveness_rate out of [0, 1.01] (should be 0): {invalid_forgiveness}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Source Table | Target Table | Key Transformations |
# MAGIC |-------------|-------------|---------------------|
# MAGIC | bronze_sba_ppp_loans | silver_sba_ppp_loans | Type casting, NAICS validation, state standardization, forgiveness_rate, DQ scoring |
# MAGIC | bronze_sba_7a_504_loans | silver_sba_7a_504_loans | Program type validation, amount validation, term_months range check, DQ scoring |
# MAGIC
# MAGIC **Partitioned By:** approval_year (both tables)
# MAGIC
# MAGIC **Next Step:** Continue to Gold layer for SBA lending analytics.
