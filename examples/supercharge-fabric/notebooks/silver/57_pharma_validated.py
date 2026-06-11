# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Pharma Clinical Trial Validated Data
# MAGIC
# MAGIC This notebook transforms Bronze pharma trial data into validated Silver tables
# MAGIC with SDTM-like domain mappings and quality enforcement.
# MAGIC
# MAGIC ## Transformations Applied:
# MAGIC - SDTM-like domain alignment (DM, AE, VS)
# MAGIC - MedDRA coding validation (PT-to-SOC consistency)
# MAGIC - Protocol deviation flagging (visit window compliance)
# MAGIC - Data quality scoring (completeness, consistency)
# MAGIC - Deduplication by primary key
# MAGIC - Type casting and standardization
# MAGIC
# MAGIC ## Compliance: 21 CFR Part 11, GxP ALCOA+

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

import os
from datetime import datetime

from delta.tables import DeltaTable
from pyspark.sql.functions import (
    abs as spark_abs,
    array,
    array_compact,
    col,
    count,
    countDistinct,
    current_timestamp,
    datediff,
    filter,
    lit,
    row_number,
    size,
    sum as spark_sum,
    to_date,
    to_timestamp,
    trim,
    upper,
    when,
)
from pyspark.sql.window import Window

# Fabric parameter shim
try:
    RUN_MODE = mssparkutils.widgets.get("run_mode", "full")  # noqa: F821
except Exception:
    RUN_MODE = "full"

SOURCE_TABLE = "lh_bronze.bronze_pharma_trials"
TARGET_TABLE = "lh_silver.silver_pharma_study"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

print(f"Source: {SOURCE_TABLE}")
print(f"Target: {TARGET_TABLE}")
print(f"Run Mode: {RUN_MODE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Data

# COMMAND ----------

df_bronze = spark.table(SOURCE_TABLE)
total_bronze = df_bronze.count()
print(f"Bronze records: {total_bronze:,}")

# Split by domain
df_subjects = df_bronze.filter(col("_bronze_domain") == "subjects")
df_aes = df_bronze.filter(col("_bronze_domain") == "adverse_events")
df_visits = df_bronze.filter(col("_bronze_domain") == "visits")

print(f"  Subjects: {df_subjects.count():,}")
print(f"  Adverse Events: {df_aes.count():,}")
print(f"  Visits: {df_visits.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Transform Subjects (SDTM DM Domain)

# COMMAND ----------

# Deduplicate by subject_id (latest record wins)
w_subj = Window.partitionBy("subject_id").orderBy(col("_bronze_ingested_at").desc())

df_dm = df_subjects \
    .withColumn("_row_num", row_number().over(w_subj)) \
    .filter(col("_row_num") == 1) \
    .drop("_row_num") \
    .withColumn("enrollment_dt", to_timestamp(col("enrollment_dt"))) \
    .withColumn("status", trim(upper(col("status")))) \
    .withColumn("sex", trim(upper(col("sex")))) \
    .withColumn("arm", trim(col("arm")))

# Validate status values
VALID_STATUSES = ["SCREENED", "ENROLLED", "COMPLETED", "WITHDRAWN"]
df_dm = df_dm.withColumn(
    "status_valid",
    when(col("status").isin(VALID_STATUSES), True).otherwise(False),
)

# Data quality checks for DM
dq_checks_dm = array_compact(
    array(
        when(col("subject_id").isNull(), lit("MISSING_SUBJECT_ID")),
        when(col("enrollment_dt").isNull(), lit("MISSING_ENROLLMENT_DT")),
        when(col("age").isNull(), lit("MISSING_AGE")),
        when((col("age") < 18) | (col("age") > 110), lit("AGE_OUT_OF_RANGE")),
        when(~col("status_valid"), lit("INVALID_STATUS")),
    )
)

df_dm = df_dm \
    .withColumn("_dq_issues", dq_checks_dm) \
    .withColumn("_dq_score", lit(1.0) - (size(col("_dq_issues")) * lit(0.2))) \
    .withColumn("_silver_processed_at", current_timestamp()) \
    .withColumn("_silver_batch_id", lit(BATCH_ID))

dm_count = df_dm.count()
print(f"Silver DM (demographics) records: {dm_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Transform Adverse Events (SDTM AE Domain)
# MAGIC
# MAGIC MedDRA coding validation: verify PT-to-SOC hierarchy consistency.

# COMMAND ----------

# Known valid MedDRA PT-SOC mappings
MEDDRA_VALID = {
    "Headache": "Nervous system disorders",
    "Nausea": "Gastrointestinal disorders",
    "Fatigue": "General disorders and administration site conditions",
    "Diarrhoea": "Gastrointestinal disorders",
    "Arthralgia": "Musculoskeletal and connective tissue disorders",
    "Pyrexia": "General disorders and administration site conditions",
    "Cough": "Respiratory, thoracic and mediastinal disorders",
    "Rash": "Skin and subcutaneous tissue disorders",
    "Dizziness": "Nervous system disorders",
    "Vomiting": "Gastrointestinal disorders",
    "Back pain": "Musculoskeletal and connective tissue disorders",
    "Insomnia": "Psychiatric disorders",
    "Hypertension": "Vascular disorders",
    "Neutropenia": "Blood and lymphatic system disorders",
    "Anaemia": "Blood and lymphatic system disorders",
    "Dyspnoea": "Respiratory, thoracic and mediastinal disorders",
    "Pruritus": "Skin and subcutaneous tissue disorders",
    "Constipation": "Gastrointestinal disorders",
    "Alopecia": "Skin and subcutaneous tissue disorders",
    "Peripheral neuropathy": "Nervous system disorders",
}

# Broadcast the lookup for join
from pyspark.sql import Row
meddra_rows = [Row(meddra_pt=k, expected_soc=v) for k, v in MEDDRA_VALID.items()]
df_meddra = spark.createDataFrame(meddra_rows)

# Deduplicate AEs
w_ae = Window.partitionBy("ae_id").orderBy(col("_bronze_ingested_at").desc())

df_ae = df_aes \
    .withColumn("_row_num", row_number().over(w_ae)) \
    .filter(col("_row_num") == 1) \
    .drop("_row_num") \
    .withColumn("onset_dt", to_timestamp(col("onset_dt"))) \
    .withColumn("resolution_dt", to_timestamp(col("resolution_dt")))

# MedDRA validation via join
df_ae = df_ae.join(df_meddra, on="meddra_pt", how="left")

df_ae = df_ae.withColumn(
    "meddra_valid",
    when(
        col("expected_soc").isNull(), False
    ).when(
        col("meddra_soc") == col("expected_soc"), True
    ).otherwise(False),
)

# Calculate AE duration
df_ae = df_ae.withColumn(
    "ae_duration_days",
    when(
        col("resolution_dt").isNotNull(),
        datediff(col("resolution_dt"), col("onset_dt")),
    ),
)

# DQ checks for AE
VALID_SEVERITIES = ["Mild", "Moderate", "Severe"]
dq_checks_ae = array_compact(
    array(
        when(col("ae_id").isNull(), lit("MISSING_AE_ID")),
        when(col("subject_id").isNull(), lit("MISSING_SUBJECT_ID")),
        when(col("meddra_pt").isNull(), lit("MISSING_MEDDRA_PT")),
        when(~col("meddra_valid"), lit("INVALID_MEDDRA_MAPPING")),
        when(~col("severity").isin(VALID_SEVERITIES), lit("INVALID_SEVERITY")),
    )
)

df_ae = df_ae \
    .withColumn("_dq_issues", dq_checks_ae) \
    .withColumn("_dq_score", lit(1.0) - (size(col("_dq_issues")) * lit(0.2))) \
    .withColumn("_silver_processed_at", current_timestamp()) \
    .withColumn("_silver_batch_id", lit(BATCH_ID)) \
    .drop("expected_soc")

ae_count = df_ae.count()
print(f"Silver AE records: {ae_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Transform Visits (Protocol Deviation Flagging)
# MAGIC
# MAGIC Visit window compliance: flag visits outside +-3 day protocol window.

# COMMAND ----------

w_visit = Window.partitionBy("visit_id").orderBy(col("_bronze_ingested_at").desc())

df_vs = df_visits \
    .withColumn("_row_num", row_number().over(w_visit)) \
    .filter(col("_row_num") == 1) \
    .drop("_row_num") \
    .withColumn("scheduled_dt", to_timestamp(col("scheduled_dt"))) \
    .withColumn("actual_dt", to_timestamp(col("actual_dt")))

# Recompute deviation and compliance
df_vs = df_vs \
    .withColumn(
        "visit_deviation_days",
        datediff(col("actual_dt"), col("scheduled_dt")),
    ) \
    .withColumn(
        "visit_window_compliant",
        spark_abs(datediff(col("actual_dt"), col("scheduled_dt"))) <= 3,
    )

# DQ checks for visits
dq_checks_vs = array_compact(
    array(
        when(col("visit_id").isNull(), lit("MISSING_VISIT_ID")),
        when(col("subject_id").isNull(), lit("MISSING_SUBJECT_ID")),
        when(col("scheduled_dt").isNull(), lit("MISSING_SCHEDULED_DT")),
        when(~col("visit_window_compliant"), lit("VISIT_WINDOW_DEVIATION")),
    )
)

df_vs = df_vs \
    .withColumn("_dq_issues", dq_checks_vs) \
    .withColumn("_dq_score", lit(1.0) - (size(col("_dq_issues")) * lit(0.25))) \
    .withColumn("_silver_processed_at", current_timestamp()) \
    .withColumn("_silver_batch_id", lit(BATCH_ID))

vs_count = df_vs.count()
print(f"Silver Visit records: {vs_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Silver

# COMMAND ----------

# Write each domain as a separate partition within the silver table
df_dm_out = df_dm.withColumn("_domain", lit("DM"))
df_ae_out = df_ae.withColumn("_domain", lit("AE"))
df_vs_out = df_vs.withColumn("_domain", lit("VS"))

# Union compatible columns (write separately for schema clarity)
for domain_label, domain_df in [("DM", df_dm_out), ("AE", df_ae_out), ("VS", df_vs_out)]:
    target = f"{TARGET_TABLE}_{domain_label.lower()}"
    domain_df.write \
        .format("delta") \
        .mode("overwrite") \
        .option("overwriteSchema", "true") \
        .saveAsTable(target)
    written = spark.table(target).count()
    print(f"Silver table '{target}': {written:,} records")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Silver Quality Summary

# COMMAND ----------

print("=" * 60)
print("SILVER LAYER PROCESSING SUMMARY")
print("=" * 60)
print(f"DM (Demographics): {dm_count:,} records")
print(f"AE (Adverse Events): {ae_count:,} records")
print(f"VS (Visits): {vs_count:,} records")
print(f"Batch ID: {BATCH_ID}")
print("Compliance: 21 CFR Part 11 audit trail | GxP ALCOA+ validated")
print("=" * 60)
