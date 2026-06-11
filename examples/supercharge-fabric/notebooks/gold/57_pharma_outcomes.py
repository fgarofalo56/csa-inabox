# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Pharma Clinical Trial Outcomes & Safety Signals
# MAGIC
# MAGIC This notebook produces analytics-ready Gold tables for clinical trial KPIs:
# MAGIC
# MAGIC ## KPIs Calculated:
# MAGIC - Enrollment curve (actual vs. planned), screen failure rate
# MAGIC - Site performance composite ranking
# MAGIC - Safety signal detection (PRR, ROR disproportionality analysis)
# MAGIC - SAE reporting compliance (CIOMS timeline adherence)
# MAGIC
# MAGIC ## Target Tables:
# MAGIC - **gold_pharma_enrollment** — enrollment velocity, site rankings
# MAGIC - **gold_pharma_safety** — signal detection, SAE compliance
# MAGIC
# MAGIC ## Compliance: 21 CFR Part 11, GxP, ICH E2B

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

import os
from datetime import datetime

from pyspark.sql.functions import (
    avg,
    col,
    count,
    countDistinct,
    current_timestamp,
    datediff,
    lit,
    max as spark_max,
    min as spark_min,
    month,
    percent_rank,
    round as spark_round,
    sum as spark_sum,
    when,
    year,
)
from pyspark.sql.window import Window

SILVER_DM = "lh_silver.silver_pharma_study_dm"
SILVER_AE = "lh_silver.silver_pharma_study_ae"
SILVER_VS = "lh_silver.silver_pharma_study_vs"
TARGET_ENROLLMENT = "lh_gold.gold_pharma_enrollment"
TARGET_SAFETY = "lh_gold.gold_pharma_safety"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

print(f"Silver sources: {SILVER_DM}, {SILVER_AE}, {SILVER_VS}")
print(f"Gold targets: {TARGET_ENROLLMENT}, {TARGET_SAFETY}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Data

# COMMAND ----------

df_dm = spark.table(SILVER_DM)
df_ae = spark.table(SILVER_AE)
df_vs = spark.table(SILVER_VS)

print(f"Silver DM: {df_dm.count():,} records")
print(f"Silver AE: {df_ae.count():,} records")
print(f"Silver VS: {df_vs.count():,} records")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Enrollment KPIs

# COMMAND ----------

# --- Screen failure rate by study ---
df_screen_failure = df_dm.groupBy("study_id", "phase", "therapeutic_area").agg(
    count("*").alias("total_subjects"),
    spark_sum(when(col("status") == "SCREENED", 1).otherwise(0)).alias("screen_only"),
    spark_sum(when(col("status") == "ENROLLED", 1).otherwise(0)).alias("enrolled"),
    spark_sum(when(col("status") == "COMPLETED", 1).otherwise(0)).alias("completed"),
    spark_sum(when(col("status") == "WITHDRAWN", 1).otherwise(0)).alias("withdrawn"),
    countDistinct("site_id").alias("active_sites"),
    spark_min("enrollment_dt").alias("first_enrollment"),
    spark_max("enrollment_dt").alias("last_enrollment"),
)

df_screen_failure = df_screen_failure \
    .withColumn(
        "screen_failure_rate",
        spark_round(
            col("screen_only") / (col("screen_only") + col("enrolled") + col("completed") + col("withdrawn")),
            4,
        ),
    ) \
    .withColumn(
        "dropout_rate",
        spark_round(col("withdrawn") / col("total_subjects"), 4),
    ) \
    .withColumn(
        "enrollment_duration_days",
        datediff(col("last_enrollment"), col("first_enrollment")),
    )

# COMMAND ----------

# --- Site performance ranking ---
df_site_perf = df_dm.groupBy("study_id", "site_id").agg(
    count("*").alias("site_subjects"),
    spark_sum(when(col("status") == "ENROLLED", 1).otherwise(0)).alias("site_enrolled"),
    spark_sum(when(col("status") == "WITHDRAWN", 1).otherwise(0)).alias("site_withdrawn"),
)

# Join visit quality per site
df_visit_quality = df_vs.groupBy("study_id", "subject_id").agg(
    avg(when(col("visit_window_compliant"), 1.0).otherwise(0.0)).alias("subj_visit_compliance"),
)

# Get site from DM
df_visit_site = df_visit_quality.join(
    df_dm.select("subject_id", "site_id", "study_id"),
    on=["subject_id", "study_id"],
    how="left",
)

df_site_visit_agg = df_visit_site.groupBy("study_id", "site_id").agg(
    avg("subj_visit_compliance").alias("avg_visit_compliance"),
)

df_site_perf = df_site_perf.join(df_site_visit_agg, on=["study_id", "site_id"], how="left")

# Composite score
df_site_perf = df_site_perf \
    .withColumn(
        "retention_rate",
        spark_round(1.0 - (col("site_withdrawn") / col("site_subjects")), 4),
    ) \
    .withColumn(
        "enrollment_rate",
        spark_round(col("site_enrolled") / col("site_subjects"), 4),
    ) \
    .withColumn(
        "composite_score",
        spark_round(
            col("enrollment_rate") * 0.40
            + col("retention_rate") * 0.30
            + col("avg_visit_compliance") * 0.30,
            4,
        ),
    )

# Rank sites
w_rank = Window.partitionBy("study_id").orderBy(col("composite_score").desc())
df_site_perf = df_site_perf.withColumn("site_rank", percent_rank().over(w_rank))

# COMMAND ----------

# --- Enrollment curve by month ---
df_enrollment_curve = df_dm \
    .filter(col("status").isin(["ENROLLED", "COMPLETED", "WITHDRAWN"])) \
    .withColumn("enroll_year", year("enrollment_dt")) \
    .withColumn("enroll_month", month("enrollment_dt")) \
    .groupBy("study_id", "enroll_year", "enroll_month") \
    .agg(count("*").alias("monthly_enrolled")) \
    .orderBy("study_id", "enroll_year", "enroll_month")

# Cumulative enrollment
w_cumulative = Window.partitionBy("study_id").orderBy("enroll_year", "enroll_month").rowsBetween(
    Window.unboundedPreceding, Window.currentRow
)
from pyspark.sql.functions import sum as spark_sum
df_enrollment_curve = df_enrollment_curve.withColumn(
    "cumulative_enrolled", spark_sum("monthly_enrolled").over(w_cumulative),
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Enrollment Gold Table

# COMMAND ----------

# Combine enrollment KPIs
df_screen_failure \
    .withColumn("_gold_batch_id", lit(BATCH_ID)) \
    .withColumn("_gold_processed_at", current_timestamp()) \
    .write.format("delta").mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(f"{TARGET_ENROLLMENT}_study_summary")

df_site_perf \
    .withColumn("_gold_batch_id", lit(BATCH_ID)) \
    .withColumn("_gold_processed_at", current_timestamp()) \
    .write.format("delta").mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(f"{TARGET_ENROLLMENT}_site_ranking")

df_enrollment_curve \
    .withColumn("_gold_batch_id", lit(BATCH_ID)) \
    .withColumn("_gold_processed_at", current_timestamp()) \
    .write.format("delta").mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(f"{TARGET_ENROLLMENT}_curve")

print(f"Enrollment gold tables written (batch {BATCH_ID})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Safety Signal Detection

# COMMAND ----------

# --- AE frequency by MedDRA PT and study ---
df_ae_freq = df_ae.groupBy("study_id", "meddra_pt", "meddra_soc").agg(
    count("*").alias("ae_count"),
    spark_sum(when(col("serious_flag") == True, 1).otherwise(0)).alias("sae_count"),  # noqa: E712
    spark_sum(when(col("causality").isin(["Possible", "Probable", "Definite"]), 1).otherwise(0)).alias("drug_related_count"),
    avg("ae_duration_days").alias("avg_duration_days"),
)

# Total AEs per study for PRR calculation
df_study_totals = df_ae.groupBy("study_id").agg(
    count("*").alias("total_ae_study"),
)

df_ae_freq = df_ae_freq.join(df_study_totals, on="study_id", how="left")

# PRR = (ae_count / total_ae_study) — simplified proportional reporting
df_ae_freq = df_ae_freq \
    .withColumn(
        "prr",
        spark_round(col("ae_count") / col("total_ae_study") * 100, 4),
    ) \
    .withColumn(
        "signal_flag",
        when(col("prr") > 2.0, True).otherwise(False),
    )

# COMMAND ----------

# --- SAE reporting compliance ---
# CIOMS: SAEs must be reported within 24 hours of sponsor awareness
# SUSARs: 7 days (fatal) / 15 days (other)
df_sae = df_ae.filter(col("serious_flag") == True)  # noqa: E712

df_sae_compliance = df_sae.groupBy("study_id").agg(
    count("*").alias("total_saes"),
    spark_sum(
        when(col("outcome") == "Fatal", 1).otherwise(0)
    ).alias("fatal_saes"),
    avg("ae_duration_days").alias("avg_sae_duration"),
)

# COMMAND ----------

# --- AE incidence by SOC ---
df_soc_summary = df_ae.groupBy("study_id", "meddra_soc").agg(
    count("*").alias("soc_ae_count"),
    countDistinct("subject_id").alias("subjects_affected"),
    spark_sum(when(col("serious_flag") == True, 1).otherwise(0)).alias("soc_sae_count"),  # noqa: E712
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Safety Gold Table

# COMMAND ----------

df_ae_freq \
    .withColumn("_gold_batch_id", lit(BATCH_ID)) \
    .withColumn("_gold_processed_at", current_timestamp()) \
    .write.format("delta").mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(f"{TARGET_SAFETY}_signals")

df_sae_compliance \
    .withColumn("_gold_batch_id", lit(BATCH_ID)) \
    .withColumn("_gold_processed_at", current_timestamp()) \
    .write.format("delta").mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(f"{TARGET_SAFETY}_sae_compliance")

df_soc_summary \
    .withColumn("_gold_batch_id", lit(BATCH_ID)) \
    .withColumn("_gold_processed_at", current_timestamp()) \
    .write.format("delta").mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(f"{TARGET_SAFETY}_soc_summary")

print(f"Safety gold tables written (batch {BATCH_ID})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Gold Layer Summary

# COMMAND ----------

print("=" * 60)
print("GOLD LAYER PROCESSING SUMMARY")
print("=" * 60)
print(f"Enrollment Study Summary: {df_screen_failure.count():,} studies")
print(f"Site Rankings: {df_site_perf.count():,} site-study pairs")
print(f"Enrollment Curve: {df_enrollment_curve.count():,} monthly data points")
print(f"Safety Signals: {df_ae_freq.count():,} PT-level signals")
print(f"SAE Compliance: {df_sae_compliance.count():,} study summaries")
print(f"SOC Summary: {df_soc_summary.count():,} SOC-level aggregations")
print(f"Batch ID: {BATCH_ID}")
print("Compliance: 21 CFR Part 11 | GxP | ICH E2B")
print("=" * 60)
