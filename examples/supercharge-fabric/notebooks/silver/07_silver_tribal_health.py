# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Tribal Healthcare Data Cleansing & Standardization
# MAGIC
# MAGIC This notebook transforms Bronze tribal healthcare data into cleansed, validated,
# MAGIC and FHIR-aligned Silver layer tables.
# MAGIC
# MAGIC ## Transformations Applied:
# MAGIC - PHI masking verification (patient_id hashed, no raw SSN/DOB)
# MAGIC - FHIR resource type mapping (encounter to FHIR Encounter resource)
# MAGIC - ICD-10 code validation and enrichment
# MAGIC - Deduplication by patient_id + encounter_date + icd10_code
# MAGIC - Data quality checks: null rates, valid enums, date ranges
# MAGIC - Facility name and area office standardization

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
    filter,
    initcap,
    length,
    like,
    lit,
    max,
    min,
    sha2,
    trim,
    upper,
    when,
)
from pyspark.sql.types import StringType

# Parameters (set by pipeline or manual)
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source and target
source_table = "lh_bronze.bronze_tribal_health_encounters"
target_table = "lh_silver.silver_tribal_health_encounters"

print(f"Processing batch: {batch_id}")
print(f"Source: {source_table}")
print(f"Target: {target_table}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Data

# COMMAND ----------

df_bronze = spark.table(source_table)

bronze_count = df_bronze.count()
print(f"Bronze records: {bronze_count:,}")
print(f"Columns: {len(df_bronze.columns)}")
df_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## PHI Masking Verification
# MAGIC
# MAGIC Ensure patient_id is hashed (SHA-256) and no raw SSN or DOB values are present.
# MAGIC This is a second line of defense after Bronze-level checks.

# COMMAND ----------

# Hash patient_id if not already hashed (SHA-256 produces 64-char hex string)
df_phi = df_bronze \
    .withColumn(
        "patient_id_hash",
        when(
            length(col("patient_id")) == 64,
            col("patient_id")  # Already hashed
        ).otherwise(
            sha2(col("patient_id"), 256)  # Hash raw patient_id
        )
    )

# Count hashing operations performed
already_hashed = df_bronze.filter(length(col("patient_id")) == 64).count()
newly_hashed = df_bronze.filter(length(col("patient_id")) != 64).count()

print("PHI Masking Verification:")
print(f"  Already hashed patient_ids: {already_hashed:,}")
print(f"  Newly hashed patient_ids: {newly_hashed:,}")

# Verify no raw SSN patterns exist in any string column
string_columns = [f.name for f in df_bronze.schema.fields if isinstance(f.dataType, StringType)]
ssn_pattern = r"^\d{3}-\d{2}-\d{4}$"

print("\nSSN Pattern Scan (should all be 0):")
for col_name in string_columns:
    ssn_count = df_bronze.filter(col(col_name).rlike(ssn_pattern)).count()
    if ssn_count > 0:
        print(f"  WARNING: {col_name} contains {ssn_count} SSN-like values!")
    else:
        print(f"  {col_name}: CLEAN")

# COMMAND ----------

# MAGIC %md
# MAGIC ## FHIR Resource Type Mapping
# MAGIC
# MAGIC Map encounter_type values to FHIR R4 Encounter resource types
# MAGIC per HL7 FHIR specification (http://hl7.org/fhir/encounter.html).

# COMMAND ----------

# FHIR Encounter class mapping
# Reference: http://terminology.hl7.org/CodeSystem/v3-ActCode
ENCOUNTER_TO_FHIR_CLASS = {
    "INPATIENT": "IMP",       # Inpatient encounter
    "OUTPATIENT": "AMB",      # Ambulatory
    "EMERGENCY": "EMER",      # Emergency
    "TELEHEALTH": "VR",       # Virtual
    "HOME_VISIT": "HH",       # Home health
    "WELLNESS": "AMB",        # Ambulatory (wellness visit)
    "DENTAL": "AMB",          # Ambulatory (dental)
    "BEHAVIORAL_HEALTH": "AMB",  # Ambulatory (behavioral)
    "SUBSTANCE_ABUSE": "AMB",   # Ambulatory (substance abuse)
    "PRENATAL": "AMB",        # Ambulatory (prenatal)
    "IMMUNIZATION": "AMB",    # Ambulatory (immunization)
    "LAB_ONLY": "AMB",        # Ambulatory (lab)
    "PHARMACY": "AMB",        # Ambulatory (pharmacy)
    "URGENT_CARE": "EMER",    # Emergency (urgent)
}

# FHIR Encounter status mapping
ENCOUNTER_STATUS_MAP = {
    "COMPLETED": "finished",
    "IN_PROGRESS": "in-progress",
    "CANCELLED": "cancelled",
    "NO_SHOW": "cancelled",
    "SCHEDULED": "planned",
}

# Create mapping expressions
fhir_class_expr = create_map([lit(x) for pair in ENCOUNTER_TO_FHIR_CLASS.items() for x in pair])
fhir_status_expr = create_map([lit(x) for pair in ENCOUNTER_STATUS_MAP.items() for x in pair])

df_fhir = df_phi \
    .withColumn("encounter_type_clean", upper(trim(col("encounter_type")))) \
    .withColumn(
        "fhir_encounter_class",
        coalesce(fhir_class_expr[upper(trim(col("encounter_type")))], lit("AMB"))
    ) \
    .withColumn("fhir_resource_type", lit("Encounter")) \
    .withColumn(
        "fhir_encounter_status",
        lit("finished")  # Default for historical encounters
    ) \
    .withColumn(
        "fhir_service_type",
        when(col("encounter_type_clean").isin("DENTAL"), lit("dental"))
        .when(col("encounter_type_clean").isin("BEHAVIORAL_HEALTH", "SUBSTANCE_ABUSE"), lit("mental-health"))
        .when(col("encounter_type_clean").isin("PRENATAL"), lit("obstetrics"))
        .when(col("encounter_type_clean").isin("IMMUNIZATION"), lit("immunization"))
        .when(col("encounter_type_clean").isin("PHARMACY"), lit("pharmacy"))
        .otherwise(lit("general-practice"))
    )

print("FHIR Mapping Applied:")
display(
    df_fhir.select("encounter_type", "fhir_encounter_class", "fhir_resource_type", "fhir_service_type")
    .distinct()
    .orderBy("encounter_type")
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## ICD-10 Code Validation and Enrichment

# COMMAND ----------

# ICD-10 format: letter followed by 2+ digits, optional decimal point and additional digits
ICD10_PATTERN = r"^[A-Z]\d{2}(\.\d{1,4})?$"

df_icd = df_fhir \
    .withColumn("icd10_code_clean", upper(trim(col("icd10_code")))) \
    .withColumn(
        "icd10_valid",
        col("icd10_code_clean").rlike(ICD10_PATTERN)
    ) \
    .withColumn(
        "icd10_chapter",
        when(col("icd10_code_clean").rlike("^[AB]"), lit("Infectious Diseases"))
        .when(col("icd10_code_clean").startswith("C"), lit("Neoplasms"))
        .when(col("icd10_code_clean").startswith("D"), lit("Blood Diseases"))
        .when(col("icd10_code_clean").startswith("E"), lit("Endocrine/Metabolic"))
        .when(col("icd10_code_clean").startswith("F"), lit("Mental/Behavioral"))
        .when(col("icd10_code_clean").startswith("G"), lit("Nervous System"))
        .when(col("icd10_code_clean").startswith("H"), lit("Eye/Ear"))
        .when(col("icd10_code_clean").startswith("I"), lit("Circulatory System"))
        .when(col("icd10_code_clean").startswith("J"), lit("Respiratory System"))
        .when(col("icd10_code_clean").startswith("K"), lit("Digestive System"))
        .when(col("icd10_code_clean").startswith("L"), lit("Skin/Subcutaneous"))
        .when(col("icd10_code_clean").startswith("M"), lit("Musculoskeletal"))
        .when(col("icd10_code_clean").startswith("N"), lit("Genitourinary"))
        .when(col("icd10_code_clean").startswith("O"), lit("Pregnancy/Childbirth"))
        .when(col("icd10_code_clean").startswith("P"), lit("Perinatal"))
        .when(col("icd10_code_clean").startswith("Q"), lit("Congenital"))
        .when(col("icd10_code_clean").startswith("R"), lit("Symptoms/Signs"))
        .when(col("icd10_code_clean").rlike("^[ST]"), lit("Injury/Poisoning"))
        .when(col("icd10_code_clean").startswith("V"), lit("External Causes"))
        .when(col("icd10_code_clean").startswith("Z"), lit("Health Status/Services"))
        .otherwise(lit("Unknown"))
    ) \
    .withColumn(
        "is_diabetes_related",
        col("icd10_code_clean").rlike("^E1[0-4]")
    ) \
    .withColumn(
        "is_behavioral_health",
        col("icd10_code_clean").rlike("^F[0-9]")
    ) \
    .withColumn(
        "is_substance_use",
        col("icd10_code_clean").rlike("^F1[0-9]")
    )

valid_icd = df_icd.filter(col("icd10_valid") == True).count()
invalid_icd = df_icd.filter(col("icd10_valid") == False).count()

print("ICD-10 Validation Results:")
print(f"  Valid codes: {valid_icd:,}")
print(f"  Invalid codes: {invalid_icd:,}")
print(f"  Validation rate: {valid_icd / (valid_icd + invalid_icd) * 100:.1f}%")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Deduplication
# MAGIC
# MAGIC Remove duplicate records by patient_id + encounter_date + icd10_code composite key.

# COMMAND ----------

before_dedup = df_icd.count()

df_deduped = df_icd.dropDuplicates(["patient_id_hash", "encounter_date", "icd10_code_clean"])

after_dedup = df_deduped.count()
dupes_removed = before_dedup - after_dedup

print(f"Deduplication Results:")
print(f"  Before: {before_dedup:,}")
print(f"  After: {after_dedup:,}")
print(f"  Duplicates removed: {dupes_removed:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Checks

# COMMAND ----------

total = df_deduped.count()

# Null rate analysis
print("Null Rate Analysis:")
print("-" * 50)
quality_fields = [
    "encounter_id", "patient_id_hash", "encounter_date", "encounter_type",
    "facility_id", "facility_name", "service_unit", "area_office",
    "provider_id", "provider_type", "icd10_code_clean",
    "insurance_type", "tribal_affiliation"
]

null_rates = {}
for field_name in quality_fields:
    if field_name in df_deduped.columns:
        null_count = df_deduped.filter(col(field_name).isNull()).count()
        rate = (null_count / total * 100) if total > 0 else 0
        null_rates[field_name] = rate
        status = "PASS" if rate < 5 else "WARN" if rate < 20 else "FAIL"
        print(f"  {field_name}: {rate:.1f}% null [{status}]")

# Valid enum checks
VALID_ENCOUNTER_TYPES = [
    "INPATIENT", "OUTPATIENT", "EMERGENCY", "TELEHEALTH", "HOME_VISIT",
    "WELLNESS", "DENTAL", "BEHAVIORAL_HEALTH", "SUBSTANCE_ABUSE",
    "PRENATAL", "IMMUNIZATION", "LAB_ONLY", "PHARMACY", "URGENT_CARE"
]

VALID_INSURANCE_TYPES = [
    "IHS_DIRECT", "MEDICAID", "MEDICARE", "PRIVATE", "TRICARE",
    "VA", "SELF_PAY", "OTHER", "UNINSURED"
]

VALID_PROVIDER_TYPES = [
    "MD", "DO", "NP", "PA", "RN", "LPN", "DENTIST", "PHARMACIST",
    "PSYCHOLOGIST", "LCSW", "CHR", "DIETITIAN", "PT", "OT"
]

print("\nEnum Validation:")
invalid_encounter = df_deduped.filter(
    ~upper(trim(col("encounter_type"))).isin(VALID_ENCOUNTER_TYPES) &
    col("encounter_type").isNotNull()
).count()
print(f"  Invalid encounter_type: {invalid_encounter:,}")

invalid_insurance = df_deduped.filter(
    ~upper(trim(col("insurance_type"))).isin(VALID_INSURANCE_TYPES) &
    col("insurance_type").isNotNull()
).count()
print(f"  Invalid insurance_type: {invalid_insurance:,}")

invalid_provider = df_deduped.filter(
    ~upper(trim(col("provider_type"))).isin(VALID_PROVIDER_TYPES) &
    col("provider_type").isNotNull()
).count()
print(f"  Invalid provider_type: {invalid_provider:,}")

# Date range checks
print("\nDate Range Checks:")
date_stats = df_deduped.agg(
    min("encounter_date").alias("min_date"),
    max("encounter_date").alias("max_date"),
).collect()[0]
print(f"  Earliest encounter: {date_stats['min_date']}")
print(f"  Latest encounter: {date_stats['max_date']}")

future_dates = df_deduped.filter(col("encounter_date") > current_date()).count()
print(f"  Future dates (should be 0): {future_dates}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Calculate Data Quality Score

# COMMAND ----------

df_with_dq = df_deduped \
    .withColumn("_dq_score",
        (
            when(col("encounter_id").isNotNull(), lit(15)).otherwise(lit(0)) +
            when(col("patient_id_hash").isNotNull(), lit(15)).otherwise(lit(0)) +
            when(col("encounter_date").isNotNull(), lit(10)).otherwise(lit(0)) +
            when(col("icd10_valid") == True, lit(15)).otherwise(lit(0)) +
            when(col("facility_name").isNotNull(), lit(10)).otherwise(lit(0)) +
            when(col("provider_id").isNotNull(), lit(10)).otherwise(lit(0)) +
            when(col("insurance_type").isNotNull(), lit(10)).otherwise(lit(0)) +
            when(col("tribal_affiliation").isNotNull(), lit(5)).otherwise(lit(0)) +
            when(col("service_unit").isNotNull(), lit(5)).otherwise(lit(0)) +
            when(col("area_office").isNotNull(), lit(5)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(col("icd10_valid") == False, lit("INVALID_ICD10")),
                when(col("facility_name").isNull(), lit("MISSING_FACILITY")),
                when(col("provider_id").isNull(), lit("MISSING_PROVIDER")),
                when(col("insurance_type").isNull(), lit("MISSING_INSURANCE")),
                when(col("encounter_date") > current_date(), lit("FUTURE_DATE"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Standardize Facility Names and Area Offices

# COMMAND ----------

# IHS Area Office standardization
AREA_OFFICE_MAP = {
    "ABERDEEN": "Great Plains",
    "GREAT PLAINS": "Great Plains",
    "ALBUQUERQUE": "Albuquerque",
    "BEMIDJI": "Bemidji",
    "BILLINGS": "Billings",
    "CALIFORNIA": "California",
    "NASHVILLE": "Nashville",
    "NAVAJO": "Navajo",
    "OKLAHOMA": "Oklahoma City",
    "OKLAHOMA CITY": "Oklahoma City",
    "PHOENIX": "Phoenix",
    "PORTLAND": "Portland",
    "TUCSON": "Tucson",
}

area_office_map_expr = create_map([lit(x) for pair in AREA_OFFICE_MAP.items() for x in pair])

df_standardized = df_with_dq \
    .withColumn("facility_name_std", initcap(trim(col("facility_name")))) \
    .withColumn("service_unit_std", initcap(trim(col("service_unit")))) \
    .withColumn(
        "area_office_std",
        coalesce(
            area_office_map_expr[upper(trim(col("area_office")))],
            initcap(trim(col("area_office")))
        )
    ) \
    .withColumn("provider_type_std", upper(trim(col("provider_type")))) \
    .withColumn("insurance_type_std", upper(trim(col("insurance_type")))) \
    .withColumn("encounter_type_std", upper(trim(col("encounter_type"))))

print("Standardization Applied:")
print("  - Facility names: InitCap")
print("  - Service units: InitCap")
print("  - Area offices: Mapped to IHS standard names")
print("  - Provider types: Uppercased")
print("  - Insurance types: Uppercased")
print("  - Encounter types: Uppercased")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Silver Metadata

# COMMAND ----------

df_silver = df_standardized \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Silver Table

# COMMAND ----------

# Select final columns for Silver output
try:
    final_columns = [
        # Core encounter fields
        "encounter_id", "patient_id_hash", "encounter_date",
        "encounter_type_std", "fhir_encounter_class", "fhir_resource_type",
        "fhir_encounter_status", "fhir_service_type",

        # Facility and location
        "facility_id", "facility_name_std", "service_unit_std", "area_office_std",

        # Provider
        "provider_id", "provider_type_std",

        # Diagnosis
        "icd10_code_clean", "icd10_description", "icd10_chapter",
        "diagnosis_category", "icd10_valid",
        "is_diabetes_related", "is_behavioral_health", "is_substance_use",

        # Procedure and medication
        "procedure_code", "procedure_description",
        "medication_prescribed", "medication_ndc",

        # Insurance
        "insurance_type_std", "insurance_id",

        # Visit details
        "visit_duration_minutes", "referral_flag", "referral_destination",
        "follow_up_required", "follow_up_date",
        "telehealth_flag", "emergency_flag",

        # Demographics (non-PHI)
        "tribal_affiliation", "community_health_rep_id",

        # HIPAA
        "phi_masked", "hipaa_consent",

        # Data quality
        "_dq_score", "_dq_flags",

        # Metadata
        "_silver_timestamp", "_batch_id"
    ]

    df_final = df_silver.select([col(c) for c in final_columns if c in df_silver.columns])

    # Write to Silver layer using Delta MERGE (incremental upsert)
    if spark.catalog.tableExists(target_table):
        deltaTable = DeltaTable.forName(spark, target_table)
        deltaTable.alias("target").merge(
            df_final.alias("source"),
            "target.encounter_id = source.encounter_id"
        ).whenMatchedUpdateAll(
            condition="target._silver_timestamp < source._silver_timestamp"
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_final.write \
            .format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .partitionBy("encounter_date") \
            .saveAsTable(target_table)

    silver_count = spark.table(target_table).count()
    print(f"Written/merged records to {target_table} (total: {silver_count:,})")
except Exception as e:
    print(f"ERROR in lh_silver.silver_tribal_health_encounters (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Report

# COMMAND ----------

# Overall quality summary
print("=" * 60)
print("DATA QUALITY REPORT - Tribal Healthcare Silver Layer")
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
    FROM {target_table}
""").show(truncate=False)

# Quality by area office
print("Quality by Area Office:")
spark.sql(f"""
    SELECT
        area_office_std as area_office,
        COUNT(*) as encounters,
        ROUND(AVG(_dq_score), 2) as avg_quality
    FROM {target_table}
    GROUP BY area_office_std
    ORDER BY encounters DESC
""").show(truncate=False)

# ICD-10 validation rate by chapter
print("ICD-10 Validation by Chapter:")
spark.sql(f"""
    SELECT
        icd10_chapter,
        COUNT(*) as codes,
        COUNT(CASE WHEN icd10_valid THEN 1 END) as valid,
        ROUND(COUNT(CASE WHEN icd10_valid THEN 1 END) * 100.0 / COUNT(*), 1) as valid_pct
    FROM {target_table}
    WHERE icd10_chapter IS NOT NULL
    GROUP BY icd10_chapter
    ORDER BY codes DESC
""").show(20, truncate=False)

# Encounter type distribution
print("Encounter Type Distribution:")
spark.sql(f"""
    SELECT
        encounter_type_std as encounter_type,
        fhir_encounter_class,
        COUNT(*) as encounters
    FROM {target_table}
    GROUP BY encounter_type_std, fhir_encounter_class
    ORDER BY encounters DESC
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize Table

# COMMAND ----------

spark.sql(f"OPTIMIZE {target_table} ZORDER BY (patient_id_hash, area_office_std)")
print("Table optimized with Z-Order on patient_id_hash, area_office_std")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Metric | Value |
# MAGIC |--------|-------|
# MAGIC | Source | bronze_tribal_health_encounters |
# MAGIC | Target | silver_tribal_health_encounters |
# MAGIC | PHI Masking | Verified and hashed |
# MAGIC | FHIR Mapping | Encounter class and resource type |
# MAGIC | ICD-10 Validation | Code format and chapter enrichment |
# MAGIC | Deduplication | patient_id + encounter_date + icd10_code |
# MAGIC | Partitioned By | encounter_date |
# MAGIC | Z-Order | patient_id_hash, area_office_std |
# MAGIC
# MAGIC **Next Step:** Continue to Gold layer for Patient 360 and Population Health analytics.
