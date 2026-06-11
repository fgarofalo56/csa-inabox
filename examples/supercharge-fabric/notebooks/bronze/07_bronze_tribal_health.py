# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Tribal Healthcare Data Ingestion
# MAGIC
# MAGIC This notebook ingests raw tribal healthcare encounter data into the Bronze layer
# MAGIC with full HIPAA compliance verification and audit logging.
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** CSV/Parquet files from IHS (Indian Health Service) systems
# MAGIC - **Location:** Files/landing/tribal_health/
# MAGIC - **Schema:** Tribal health encounter records
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_tribal_health_encounters
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Append
# MAGIC
# MAGIC ## HIPAA Compliance
# MAGIC - PHI masking verification before ingestion
# MAGIC - Consent flag validation (hipaa_consent=True required)
# MAGIC - Full audit trail for all data access

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

import uuid
from datetime import datetime

from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    col,
    concat_ws,
    count,
    current_timestamp,
    input_file_name,
    lit,
    sha2,
    to_timestamp,
    when,
)
from pyspark.sql.types import (
    BooleanType,
    DateType,
    IntegerType,
    Row,
    StringType,
    StructField,
    StructType,
)

# Configuration
SOURCE_PATH = "Files/landing/tribal_health/"
TARGET_TABLE = "lh_bronze.bronze_tribal_health_encounters"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")
RUN_ID = str(uuid.uuid4())

# HIPAA compliance flags
REQUIRE_PHI_MASKED = True
REQUIRE_HIPAA_CONSENT = True

print(f"Source: {SOURCE_PATH}")
print(f"Target: {TARGET_TABLE}")
print(f"Batch ID: {BATCH_ID}")
print(f"Run ID: {RUN_ID}")
print(f"HIPAA PHI Masking Required: {REQUIRE_PHI_MASKED}")
print(f"HIPAA Consent Required: {REQUIRE_HIPAA_CONSENT}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Schema
# MAGIC
# MAGIC Explicit schema matching tribal_health_schema.json fields for validation and performance.

# COMMAND ----------

tribal_health_schema = StructType([
    StructField("encounter_id", StringType(), False),
    StructField("patient_id", StringType(), False),
    StructField("encounter_date", DateType(), False),
    StructField("encounter_type", StringType(), True),
    StructField("facility_id", StringType(), True),
    StructField("facility_name", StringType(), True),
    StructField("service_unit", StringType(), True),
    StructField("area_office", StringType(), True),
    StructField("provider_id", StringType(), True),
    StructField("provider_type", StringType(), True),
    StructField("icd10_code", StringType(), True),
    StructField("icd10_description", StringType(), True),
    StructField("diagnosis_category", StringType(), True),
    StructField("procedure_code", StringType(), True),
    StructField("procedure_description", StringType(), True),
    StructField("medication_prescribed", StringType(), True),
    StructField("medication_ndc", StringType(), True),
    StructField("insurance_type", StringType(), True),
    StructField("insurance_id", StringType(), True),
    StructField("visit_duration_minutes", IntegerType(), True),
    StructField("referral_flag", BooleanType(), True),
    StructField("referral_destination", StringType(), True),
    StructField("follow_up_required", BooleanType(), True),
    StructField("follow_up_date", DateType(), True),
    StructField("phi_masked", BooleanType(), True),
    StructField("hipaa_consent", BooleanType(), True),
    StructField("tribal_affiliation", StringType(), True),
    StructField("community_health_rep_id", StringType(), True),
    StructField("telehealth_flag", BooleanType(), True),
    StructField("emergency_flag", BooleanType(), True),
])

print(f"Schema fields: {len(tribal_health_schema.fields)}")
for field in tribal_health_schema.fields:
    nullable = "nullable" if field.nullable else "required"
    print(f"  {field.name}: {field.dataType.simpleString()} ({nullable})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data

# COMMAND ----------

# Attempt to read Parquet first, fall back to CSV
try:
    df_raw = spark.read \
        .schema(tribal_health_schema) \
        .parquet(f"{SOURCE_PATH}*.parquet")
    source_format = "Parquet"
except Exception:
    df_raw = spark.read \
        .schema(tribal_health_schema) \
        .option("header", "true") \
        .option("dateFormat", "yyyy-MM-dd") \
        .csv(f"{SOURCE_PATH}*.csv")
    source_format = "CSV"

record_count = df_raw.count()
column_count = len(df_raw.columns)

print(f"Source Format: {source_format}")
print(f"Source Statistics:")
print(f"  Records: {record_count:,}")
print(f"  Columns: {column_count}")

df_raw.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## HIPAA Compliance Verification
# MAGIC
# MAGIC **CRITICAL:** All records must have `phi_masked=True` and `hipaa_consent=True`
# MAGIC before ingestion. Non-compliant records are quarantined, not ingested.

# COMMAND ----------

# Check phi_masked flag
phi_violations = df_raw.filter(
    (col("phi_masked").isNull()) | (col("phi_masked") == False)
).count()

# Check hipaa_consent flag
consent_violations = df_raw.filter(
    (col("hipaa_consent").isNull()) | (col("hipaa_consent") == False)
).count()

print("HIPAA Compliance Check:")
print(f"  PHI Masking Violations: {phi_violations}")
print(f"  Consent Violations: {consent_violations}")

if phi_violations > 0 and REQUIRE_PHI_MASKED:
    print(f"  WARNING: {phi_violations} records have unmasked PHI - quarantining")

if consent_violations > 0 and REQUIRE_HIPAA_CONSENT:
    print(f"  WARNING: {consent_violations} records lack HIPAA consent - quarantining")

# Separate compliant and non-compliant records
df_compliant = df_raw.filter(
    (col("phi_masked") == True) & (col("hipaa_consent") == True)
)

df_quarantined = df_raw.filter(
    (col("phi_masked") != True) | (col("hipaa_consent") != True) |
    col("phi_masked").isNull() | col("hipaa_consent").isNull()
)

compliant_count = df_compliant.count()
quarantined_count = df_quarantined.count()

print(f"\n  Compliant records: {compliant_count:,}")
print(f"  Quarantined records: {quarantined_count:,}")

if compliant_count == 0:
    raise Exception("HIPAA BLOCK: Zero compliant records found. Ingestion halted.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Critical Field Null Checks

# COMMAND ----------

critical_fields = ["encounter_id", "patient_id", "encounter_date"]

print("Critical Field Null Check:")
for field in critical_fields:
    null_count = df_compliant.filter(col(field).isNull()).count()
    status = "PASS" if null_count == 0 else f"WARN: {null_count} nulls"
    print(f"  {field}: {status}")

# Filter out records missing critical fields
df_valid = df_compliant \
    .filter(col("encounter_id").isNotNull()) \
    .filter(col("patient_id").isNotNull()) \
    .filter(col("encounter_date").isNotNull())

valid_count = df_valid.count()
dropped_count = compliant_count - valid_count
print(f"\nRecords after null filter: {valid_count:,} (dropped {dropped_count:,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Ingestion Metadata

# COMMAND ----------

df_bronze = df_valid \
    .withColumn("_ingested_at", current_timestamp()) \
    .withColumn("_source_file", input_file_name()) \
    .withColumn("_batch_id", lit(BATCH_ID)) \
    .withColumn("_run_id", lit(RUN_ID)) \
    .withColumn("_source_format", lit(source_format)) \
    .withColumn("_load_date", current_timestamp().cast("date"))

print("Added ingestion metadata columns:")
print("  - _ingested_at")
print("  - _source_file")
print("  - _batch_id")
print("  - _run_id")
print("  - _source_format")
print("  - _load_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table

# COMMAND ----------

df_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("_load_date") \
    .saveAsTable(TARGET_TABLE)

final_count = spark.table(TARGET_TABLE).count()
print(f"Successfully wrote {final_count:,} records to {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Row Count Validation

# COMMAND ----------

df_verify = spark.table(TARGET_TABLE)

total_in_table = df_verify.count()
latest_batch = df_verify.filter(col("_batch_id") == BATCH_ID).count()

print(f"Table Verification:")
print(f"  Total records in table: {total_in_table:,}")
print(f"  Records from this batch: {latest_batch:,}")
print(f"  Partitions: {df_verify.select('_load_date').distinct().count()}")

assert latest_batch == final_count, \
    f"Row count mismatch: wrote {final_count}, read back {latest_batch}"
print("  Row count validation: PASS")

# Show sample data
print("\nSample Records:")
display(
    df_verify.filter(col("_batch_id") == BATCH_ID)
    .select(
        "encounter_id", "patient_id", "encounter_date",
        "facility_name", "icd10_code", "encounter_type",
        "_ingested_at", "_batch_id"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## HIPAA Audit Log Entry
# MAGIC
# MAGIC Write an audit record documenting this data access event per HIPAA requirements.

# COMMAND ----------

audit_entry = spark.createDataFrame([{
    "audit_id": RUN_ID,
    "audit_timestamp": datetime.utcnow().isoformat(),
    "action": "BRONZE_INGESTION",
    "table_name": TARGET_TABLE,
    "batch_id": BATCH_ID,
    "records_ingested": final_count,
    "records_quarantined": quarantined_count,
    "phi_violations_detected": phi_violations,
    "consent_violations_detected": consent_violations,
    "hipaa_compliant": True,
    "source_path": SOURCE_PATH,
    "source_format": source_format,
    "data_classification": "PHI - HIPAA Protected",
    "access_justification": "Automated Bronze layer ingestion pipeline",
}])

# Write audit log (append to audit table)
audit_entry.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .saveAsTable("lh_bronze.tribal_health_hipaa_audit_log")

print("HIPAA Audit Log Entry Written:")
print(f"  Audit ID: {RUN_ID}")
print(f"  Records Ingested: {final_count:,}")
print(f"  Records Quarantined: {quarantined_count:,}")
print(f"  PHI Violations: {phi_violations}")
print(f"  Consent Violations: {consent_violations}")
print(f"  Data Classification: PHI - HIPAA Protected")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Metric | Value |
# MAGIC |--------|-------|
# MAGIC | Source | Tribal healthcare encounter files |
# MAGIC | Target | bronze_tribal_health_encounters |
# MAGIC | Format | Delta Lake |
# MAGIC | Partitioned By | _load_date |
# MAGIC | HIPAA Compliant | Yes |
# MAGIC | PHI Masked | Verified |
# MAGIC | Audit Logged | Yes |
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer cleansing and FHIR standardization.
