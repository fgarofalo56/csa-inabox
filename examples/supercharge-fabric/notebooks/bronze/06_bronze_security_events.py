# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Security Events Ingestion
# MAGIC
# MAGIC This notebook ingests security and surveillance events from the casino security system.
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet files
# MAGIC - **Location:** Files/landing/security/
# MAGIC - **Schema:** Security management system exports
# MAGIC - **Update Frequency:** Near real-time / 15-minute batches
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_security_events
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Append
# MAGIC
# MAGIC ## Event Categories
# MAGIC - Access control (door entries, badge swipes)
# MAGIC - Surveillance alerts (camera triggers, motion detection)
# MAGIC - Incident reports (altercations, medical emergencies)
# MAGIC - Player exclusion events (self-exclusion, state-mandated)
# MAGIC - Threat detection (trespass, weapon detection)

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

from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    coalesce,
    col,
    current_timestamp,
    hour,
    input_file_name,
    lit,
    to_date,
    when,
)
from pyspark.sql.functions import count as _count
from pyspark.sql.functions import sum as _sum
from pyspark.sql.types import (
    BooleanType,
    DoubleType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Configuration
SOURCE_PATH = "Files/output/bronze_security_events.parquet"
TARGET_TABLE = "lh_bronze.bronze_security_events"
SCHEMA_VERSION = "1.0"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

# Valid enum values from schema
VALID_EVENT_TYPES = [
    "BADGE_SWIPE", "DOOR_ENTRY", "ACCESS_GRANTED", "ACCESS_DENIED",
    "CAMERA_ALERT", "MOTION_DETECTED", "CAMERA_OBSTRUCTION",
    "EXCLUSION_CHECK", "EXCLUSION_VIOLATION",
    "INCIDENT_REPORT", "ALTERCATION", "MEDICAL_EMERGENCY",
    "THREAT_DETECTED", "WEAPON_DETECTED", "TRESPASS",
    "UNAUTHORIZED_ACCESS", "SUSPICIOUS_ACTIVITY",
    "PATRON_COMPLAINT", "ESCORT_REQUEST", "SECURITY_PATROL"
]
VALID_SEVERITY_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"]
VALID_LOCATION_TYPES = [
    "GAMING_FLOOR", "CAGE", "COUNT_ROOM", "VAULT", "ENTRANCE",
    "EXIT", "PARKING", "RESTAURANT", "HOTEL", "BACK_OF_HOUSE",
    "SURVEILLANCE_ROOM", "SERVER_ROOM"
]
VALID_PERSON_TYPES = ["EMPLOYEE", "PATRON", "VENDOR", "CONTRACTOR", "UNKNOWN"]
VALID_RESOLUTION_STATUSES = ["PENDING", "IN_PROGRESS", "RESOLVED", "ESCALATED", "FALSE_ALARM"]

print(f"Source: {SOURCE_PATH}")
print(f"Target: {TARGET_TABLE}")
print(f"Schema Version: {SCHEMA_VERSION}")
print(f"Batch ID: {BATCH_ID}")
print(f"Valid Event Types: {len(VALID_EVENT_TYPES)} types defined")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Schema
# MAGIC
# MAGIC Explicit schema matching `data_generation/schemas/security_events_schema.json`.
# MAGIC Comprehensive field definitions for the security domain.

# COMMAND ----------

security_events_schema = StructType([
    StructField("event_id", StringType(), False),
    StructField("event_type", StringType(), False),
    StructField("event_timestamp", TimestampType(), False),
    StructField("location_id", StringType(), False),
    StructField("location_type", StringType(), True),
    StructField("severity_level", StringType(), True),
    StructField("person_id", StringType(), True),
    StructField("person_type", StringType(), True),
    StructField("description", StringType(), True),
    StructField("camera_id", StringType(), True),
    StructField("badge_id", StringType(), True),
    StructField("door_id", StringType(), True),
    StructField("responding_officer_id", StringType(), True),
    StructField("response_timestamp", TimestampType(), True),
    StructField("resolution_timestamp", TimestampType(), True),
    StructField("resolution_status", StringType(), True),
    StructField("resolution_notes", StringType(), True),
    StructField("exclusion_info", StringType(), True),
    StructField("incident_info", StringType(), True),
    StructField("gaming_related", BooleanType(), True),
    StructField("table_id", StringType(), True),
    StructField("machine_id", StringType(), True),
    StructField("amount_involved", DoubleType(), True),
    StructField("attachments", StringType(), True),
    StructField("_ingested_at", StringType(), True),
    StructField("_source", StringType(), True),
    StructField("_batch_id", StringType(), True),
])

print(f"Schema defined with {len(security_events_schema.fields)} fields")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data

# COMMAND ----------

# Read parquet file with error handling for missing source
try:
    df_raw = spark.read.parquet(SOURCE_PATH)

    # Display statistics
    record_count = df_raw.count()
    column_count = len(df_raw.columns)

    print(f"Source Statistics:")
    print(f"  Records: {record_count:,}")
    print(f"  Columns: {column_count}")

    # Show schema
    df_raw.printSchema()

except Exception as e:
    print(f"ERROR: Failed to read source data from {SOURCE_PATH}")
    print(f"  Exception: {e!s}")
    print(f"  Verify the source file exists and is accessible.")
    _notebook_exit(f"FAILED: Source read error - {e!s}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Schema Enforcement
# MAGIC
# MAGIC Apply the explicit StructType schema to enforce data types and catch mismatches.

# COMMAND ----------

# Apply schema enforcement
schema_fields = [f.name for f in security_events_schema.fields if f.name not in ("_ingested_at", "_source", "_batch_id")]
source_columns = df_raw.columns

# Identify missing and extra columns
missing_cols = [f for f in schema_fields if f not in source_columns]
extra_cols = [c for c in source_columns if c not in [f.name for f in security_events_schema.fields]]

print("Schema Enforcement Report:")
print(f"  Expected fields: {len(schema_fields)}")
print(f"  Source columns: {len(source_columns)}")
if missing_cols:
    print(f"  Missing columns (will be null): {missing_cols}")
if extra_cols:
    print(f"  Extra columns (will be preserved): {extra_cols}")

# Add missing columns as null
df_enforced = df_raw
for missing in missing_cols:
    field = [f for f in security_events_schema.fields if f.name == missing][0]
    df_enforced = df_enforced.withColumn(missing, lit(None).cast(field.dataType))

print("Schema enforcement applied successfully.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Checks (Bronze)
# MAGIC
# MAGIC Validate critical fields, enum values, severity levels, and location integrity.

# COMMAND ----------

# Check for null critical fields (required per schema)
critical_fields = ["event_id", "event_type", "event_timestamp", "location_id"]

print("=" * 60)
print("DATA QUALITY CHECKS - Security Events")
print("=" * 60)

print("\n1. Critical Field Null Check:")
quality_issues = 0
for field in critical_fields:
    if field in df_enforced.columns:
        null_count = df_enforced.filter(col(field).isNull()).count()
        status = "PASS" if null_count == 0 else f"WARN: {null_count} nulls"
        if null_count > 0:
            quality_issues += 1
        print(f"  {field}: {status}")
    else:
        print(f"  {field}: MISSING FROM SOURCE")
        quality_issues += 1

# Check event_type enum validation
print("\n2. Event Type Enum Validation:")
if "event_type" in df_enforced.columns:
    invalid_events = df_enforced.filter(
        ~col("event_type").isin(VALID_EVENT_TYPES) & col("event_type").isNotNull()
    ).count()
    print(f"  Valid event types: {len(VALID_EVENT_TYPES)} defined")
    print(f"  Invalid event_type values: {invalid_events}")
    if invalid_events > 0:
        quality_issues += 1

# Check severity_level enum validation
print("\n3. Severity Level Enum Validation:")
if "severity_level" in df_enforced.columns:
    invalid_severity = df_enforced.filter(
        ~col("severity_level").isin(VALID_SEVERITY_LEVELS) & col("severity_level").isNotNull()
    ).count()
    print(f"  Valid levels: {VALID_SEVERITY_LEVELS}")
    print(f"  Invalid severity_level values: {invalid_severity}")
    if invalid_severity > 0:
        quality_issues += 1

# Check location_type enum validation
print("\n4. Location Type Enum Validation:")
if "location_type" in df_enforced.columns:
    invalid_loc_types = df_enforced.filter(
        ~col("location_type").isin(VALID_LOCATION_TYPES) & col("location_type").isNotNull()
    ).count()
    print(f"  Valid location types: {len(VALID_LOCATION_TYPES)} defined")
    print(f"  Invalid location_type values: {invalid_loc_types}")
    if invalid_loc_types > 0:
        quality_issues += 1

# Check person_type enum validation
print("\n5. Person Type Enum Validation:")
if "person_type" in df_enforced.columns:
    invalid_person_types = df_enforced.filter(
        ~col("person_type").isin(VALID_PERSON_TYPES) & col("person_type").isNotNull()
    ).count()
    print(f"  Valid person types: {VALID_PERSON_TYPES}")
    print(f"  Invalid person_type values: {invalid_person_types}")

# Check resolution_status enum validation
print("\n6. Resolution Status Enum Validation:")
if "resolution_status" in df_enforced.columns:
    invalid_res_statuses = df_enforced.filter(
        ~col("resolution_status").isin(VALID_RESOLUTION_STATUSES) & col("resolution_status").isNotNull()
    ).count()
    print(f"  Valid statuses: {VALID_RESOLUTION_STATUSES}")
    print(f"  Invalid resolution_status values: {invalid_res_statuses}")

# Check location_id format (should match ^LOC-[A-Z0-9]{3,10}$)
print("\n7. Location ID Format Validation:")
if "location_id" in df_enforced.columns:
    invalid_loc_ids = df_enforced.filter(
        ~col("location_id").rlike("^LOC-[A-Z0-9]{3,10}$") & col("location_id").isNotNull()
    ).count()
    print(f"  Expected pattern: ^LOC-[A-Z0-9]{{3,10}}$")
    print(f"  Invalid location_id values: {invalid_loc_ids}")

# Check amount_involved range (must be >= 0)
print("\n8. Amount Involved Range Validation:")
if "amount_involved" in df_enforced.columns:
    negative_amounts = df_enforced.filter(col("amount_involved") < 0).count()
    print(f"  Negative amounts: {negative_amounts}")
    if negative_amounts > 0:
        quality_issues += 1

# Check for duplicate event_ids
print("\n9. Duplicate Check:")
if "event_id" in df_enforced.columns:
    total = df_enforced.count()
    distinct = df_enforced.select("event_id").distinct().count()
    dupes = total - distinct
    print(f"  Total records: {total:,}")
    print(f"  Distinct event_ids: {distinct:,}")
    print(f"  Duplicates: {dupes:,}")
    if dupes > 0:
        quality_issues += 1

print(f"\nTotal quality issues: {quality_issues}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Severity Classification and Bronze Metadata

# COMMAND ----------

# Security event severity mapping and categorization
df_bronze = df_enforced \
    .withColumn("event_date", to_date("event_timestamp")) \
    .withColumn("event_hour", hour("event_timestamp")) \
    .withColumn("severity_level",
        when(col("severity_level").isNotNull(), col("severity_level"))
        .when(col("event_type").isin("THREAT_DETECTED", "EXCLUSION_VIOLATION", "TRESPASS", "WEAPON_DETECTED"), "CRITICAL")
        .when(col("event_type").isin("SUSPICIOUS_ACTIVITY", "UNAUTHORIZED_ACCESS", "ALTERCATION"), "HIGH")
        .when(col("event_type").isin("ACCESS_DENIED", "CAMERA_OBSTRUCTION", "PATRON_COMPLAINT"), "MEDIUM")
        .otherwise("LOW")) \
    .withColumn("requires_response",
        col("event_type").isin(
            "THREAT_DETECTED", "EXCLUSION_VIOLATION", "TRESPASS",
            "UNAUTHORIZED_ACCESS", "ALTERCATION", "MEDICAL_EMERGENCY",
            "WEAPON_DETECTED"
        )) \
    .withColumn("event_category",
        when(col("event_type").isin("BADGE_SWIPE", "DOOR_ENTRY", "ACCESS_GRANTED", "ACCESS_DENIED"), "ACCESS_CONTROL")
        .when(col("event_type").isin("CAMERA_ALERT", "MOTION_DETECTED", "CAMERA_OBSTRUCTION"), "SURVEILLANCE")
        .when(col("event_type").isin("EXCLUSION_CHECK", "EXCLUSION_VIOLATION"), "EXCLUSION")
        .when(col("event_type").isin("INCIDENT_REPORT", "ALTERCATION", "MEDICAL_EMERGENCY"), "INCIDENT")
        .when(col("event_type").isin("THREAT_DETECTED", "WEAPON_DETECTED", "TRESPASS"), "THREAT")
        .when(col("event_type").isin("SUSPICIOUS_ACTIVITY", "UNAUTHORIZED_ACCESS"), "SUSPICIOUS")
        .when(col("event_type").isin("PATRON_COMPLAINT", "ESCORT_REQUEST"), "SERVICE")
        .when(col("event_type") == "SECURITY_PATROL", "PATROL")
        .otherwise("OTHER")) \
    .withColumn("is_gaming_floor_event",
        coalesce(col("gaming_related"), lit(False))
        | col("table_id").isNotNull()
        | col("machine_id").isNotNull()) \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date")) \
    .withColumn("_bronze_schema_version", lit(SCHEMA_VERSION))

# Report severity breakdown
print("Severity Breakdown (this batch):")
for level in VALID_SEVERITY_LEVELS:
    cnt = df_bronze.filter(col("severity_level") == level).count()
    print(f"  {level}: {cnt:,}")

print("\nAdded derived columns and Bronze metadata:")
print("  - event_date, event_hour (temporal)")
print("  - severity_level (derived/preserved)")
print("  - requires_response (critical events)")
print("  - event_category (ACCESS_CONTROL / SURVEILLANCE / etc.)")
print("  - is_gaming_floor_event (gaming relevance)")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")
print("  - _bronze_schema_version")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table

# COMMAND ----------

# Write to Bronze with date and severity partitioning
df_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("event_date", "severity_level") \
    .saveAsTable(TARGET_TABLE)

print(f"Successfully wrote {spark.table(TARGET_TABLE).count():,} records to {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Verify Ingestion

# COMMAND ----------

# Read back and verify
df_verify = spark.table(TARGET_TABLE)

print(f"\nTable Verification:")
print(f"  Total records: {df_verify.count():,}")
print(f"  Date partitions: {df_verify.select('event_date').distinct().count()}")
print(f"  Severity partitions: {df_verify.select('severity_level').distinct().count()}")

# Sample data
print(f"\nSample Records:")
display(
    df_verify.select(
        "event_id", "event_type", "severity_level",
        "event_category", "location_id", "requires_response",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Table Statistics

# COMMAND ----------

# Summary by severity
print("Severity Distribution:")
display(
    df_verify
    .groupBy("severity_level")
    .agg(
        _count("*").alias("event_count"),
        _sum(when(col("requires_response"), 1).otherwise(0)).alias("requires_response_count")
    )
    .orderBy(
        when(col("severity_level") == "CRITICAL", 1)
        .when(col("severity_level") == "HIGH", 2)
        .when(col("severity_level") == "MEDIUM", 3)
        .otherwise(4)
    )
)

# COMMAND ----------

# Event category distribution
print("Event Category Distribution:")
display(
    df_verify
    .groupBy("event_category")
    .agg(
        _count("*").alias("count"),
    )
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Event type detail
print("Event Type Detail:")
display(
    df_verify
    .groupBy("event_category", "event_type")
    .count()
    .orderBy("event_category", col("count").desc())
)

# COMMAND ----------

# Location type distribution
print("Location Type Distribution:")
display(
    df_verify
    .groupBy("location_type")
    .agg(
        _count("*").alias("event_count"),
        _sum(when(col("severity_level").isin("CRITICAL", "HIGH"), 1).otherwise(0)).alias("critical_high_count")
    )
    .orderBy(col("event_count").desc())
)

# COMMAND ----------

# Critical/High events requiring attention
print("CRITICAL/HIGH SEVERITY EVENTS (Latest 20):")
critical_events = df_verify \
    .filter(col("severity_level").isin("CRITICAL", "HIGH")) \
    .select(
        "event_timestamp", "event_type", "severity_level",
        "location_id", "location_type", "description",
        "resolution_status"
    ) \
    .orderBy(col("event_timestamp").desc()) \
    .limit(20)

if critical_events.count() > 0:
    display(critical_events)
else:
    print("No critical or high severity events in this batch.")

# COMMAND ----------

# Resolution status summary
print("Resolution Status Summary:")
display(
    df_verify
    .filter(col("resolution_status").isNotNull())
    .groupBy("severity_level", "resolution_status")
    .count()
    .orderBy(
        when(col("severity_level") == "CRITICAL", 1)
        .when(col("severity_level") == "HIGH", 2)
        .when(col("severity_level") == "MEDIUM", 3)
        .otherwise(4),
        "resolution_status"
    )
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Delta Table History

# COMMAND ----------

from delta.tables import DeltaTable

delta_table = DeltaTable.forName(spark, TARGET_TABLE)

print("Table History:")
display(
    delta_table.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Metric | Value |
# MAGIC |--------|-------|
# MAGIC | Source | Parquet files |
# MAGIC | Target | bronze_security_events |
# MAGIC | Load Pattern | Append |
# MAGIC | Format | Delta Lake |
# MAGIC | Partitioned By | event_date, severity_level |
# MAGIC | Event Types | 20 distinct types |
# MAGIC | Categories | ACCESS_CONTROL, SURVEILLANCE, EXCLUSION, INCIDENT, THREAT, SUSPICIOUS, SERVICE, PATROL |
# MAGIC | Schema Version | 1.0 |
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer for incident correlation, response time analysis, and exclusion matching.
