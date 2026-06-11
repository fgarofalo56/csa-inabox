# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Insurance Claims Validated
# MAGIC
# MAGIC Reads bronze insurance claims and applies validation, deduplication,
# MAGIC enrichment, and standardization for the Silver layer.
# MAGIC
# MAGIC ## Transformations
# MAGIC - Deduplicate on claim_id (keep latest ingestion)
# MAGIC - Validate policy-claim linkage
# MAGIC - Calculate report_lag (report_dt - loss_dt)
# MAGIC - Calculate development_age (months since loss)
# MAGIC - Standardize loss_type codes
# MAGIC - Validate reserves > 0 for open/reserved claims
# MAGIC - Mask PII (claimant_name)
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** silver_insurance_claims
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Overwrite

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from pyspark.sql import SparkSession, Window
from pyspark.sql.functions import (
    col,
    current_timestamp,
    datediff,
    lit,
    lower,
    months_between,
    regexp_replace,
    row_number,
    sha2,
    trim,
    when,
)

spark = SparkSession.builder.getOrCreate()

BRONZE_TABLE = "lh_bronze.bronze_insurance_claims"
SILVER_TABLE = "lh_silver.silver_insurance_claims"

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Data

# COMMAND ----------

df_bronze = spark.table(BRONZE_TABLE)
initial_count = df_bronze.count()
print(f"Bronze records read: {initial_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 1: Deduplicate on claim_id

# COMMAND ----------

dedup_window = Window.partitionBy("claim_id").orderBy(col("_ingested_at").desc())

df_dedup = (
    df_bronze
    .withColumn("_row_num", row_number().over(dedup_window))
    .filter(col("_row_num") == 1)
    .drop("_row_num")
)

dedup_count = df_dedup.count()
dupes_removed = initial_count - dedup_count
print(f"After deduplication: {dedup_count:,} (removed {dupes_removed:,} duplicates)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 2: Validate Policy-Claim Linkage

# COMMAND ----------

# Flag claims with missing or null policy_id
df_validated = df_dedup.withColumn(
    "_policy_valid",
    when(col("policy_id").isNotNull() & (col("policy_id") != ""), True).otherwise(False),
)

invalid_policy_count = df_validated.filter(~col("_policy_valid")).count()
print(f"Claims with invalid policy linkage: {invalid_policy_count:,}")

# Keep only valid policy links
df_validated = df_validated.filter(col("_policy_valid")).drop("_policy_valid")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 3: Calculate Report Lag and Development Age

# COMMAND ----------

df_enriched = (
    df_validated
    .withColumn(
        "report_lag_days",
        datediff(col("report_dt"), col("loss_dt")),
    )
    .withColumn(
        "development_age_months",
        months_between(current_timestamp(), col("loss_dt")).cast("int"),
    )
)

# Validate report_lag >= 0 (report_dt should be >= loss_dt)
negative_lag = df_enriched.filter(col("report_lag_days") < 0).count()
print(f"Records with negative report lag (data quality issue): {negative_lag:,}")

# Remove records with negative lag (bad data)
df_enriched = df_enriched.filter(col("report_lag_days") >= 0)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 4: Standardize Loss Type Codes

# COMMAND ----------

# Normalize loss_type: lowercase, trim, replace spaces with underscores
df_standardized = (
    df_enriched
    .withColumn("loss_type", lower(trim(col("loss_type"))))
    .withColumn("loss_type", regexp_replace(col("loss_type"), r"\s+", "_"))
)

# Show distinct loss types for verification
print("Standardized loss types:")
df_standardized.select("loss_type").distinct().orderBy("loss_type").show(30, truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 5: Validate Reserves

# COMMAND ----------

# For open/reserved/under_investigation claims, reserve must be > 0
active_statuses = ["open", "under_investigation", "reserved", "reopened"]

df_reserve_check = df_standardized.withColumn(
    "_reserve_valid",
    when(
        col("status").isin(active_statuses) & (col("reserve_amt") <= 0),
        False,
    ).otherwise(True),
)

invalid_reserves = df_reserve_check.filter(~col("_reserve_valid")).count()
print(f"Active claims with zero/negative reserves: {invalid_reserves:,}")

# Flag but don't remove -- actuaries need to review
df_reserve_check = df_reserve_check.withColumn(
    "reserve_warning",
    when(~col("_reserve_valid"), lit("ZERO_RESERVE_ACTIVE_CLAIM")).otherwise(lit(None)),
).drop("_reserve_valid")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 6: Mask PII

# COMMAND ----------

# Hash claimant name for privacy; original retained only in bronze
df_masked = df_reserve_check.withColumn(
    "claimant_name_hash",
    sha2(col("claimant_name"), 256),
).drop("claimant_name")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 7: Add Silver Metadata

# COMMAND ----------

df_silver = (
    df_masked
    .withColumn("_validated_at", current_timestamp())
    .withColumn("_silver_version", lit("1.0"))
    .drop("_source_file", "_source_system", "_ingestion_date")
)

silver_count = df_silver.count()
print(f"Silver records to write: {silver_count:,}")
df_silver.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Silver Delta Table

# COMMAND ----------

(
    df_silver
    .write.format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .saveAsTable(SILVER_TABLE)
)

print(f"Successfully wrote {silver_count:,} records to {SILVER_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Quality Summary

# COMMAND ----------

from pyspark.sql.functions import avg, count, max as spark_max, min as spark_min  # noqa: E402

summary = df_silver.agg(
    count("*").alias("total_records"),
    avg("report_lag_days").alias("avg_report_lag_days"),
    avg("reserve_amt").alias("avg_reserve"),
    avg("paid_amt").alias("avg_paid"),
    spark_min("loss_dt").alias("earliest_loss"),
    spark_max("loss_dt").alias("latest_loss"),
).collect()[0]

print("=== Silver Quality Summary ===")
print(f"  Total records:        {summary['total_records']:,}")
print(f"  Avg report lag:       {summary['avg_report_lag_days']:.1f} days")
print(f"  Avg reserve:          ${summary['avg_reserve']:,.2f}")
print(f"  Avg paid:             ${summary['avg_paid']:,.2f}")
print(f"  Loss date range:      {summary['earliest_loss']} to {summary['latest_loss']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Notebook Complete
# MAGIC
# MAGIC Silver validation for insurance claims is complete.
# MAGIC Proceed to `52_insurance_predictions.py` for Gold layer analytics.
