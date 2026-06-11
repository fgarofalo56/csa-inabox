# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Telecom CDR Enrichment
# MAGIC
# MAGIC Enriches raw CDRs with subscriber and cell site reference data.
# MAGIC Deduplicates, validates, and aggregates daily usage.
# MAGIC
# MAGIC ## Source
# MAGIC - **Tables:** bronze_telecom_cdr, bronze_telecom_subscribers, bronze_telecom_cell_sites
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** silver_telecom_usage
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Overwrite (full refresh) / Merge (incremental)
# MAGIC
# MAGIC ## Transformations
# MAGIC - Join CDR with subscriber profile and cell site metadata
# MAGIC - Filter invalid records (duration <= 0 for voice/data, null keys)
# MAGIC - Deduplicate on cdr_id
# MAGIC - Calculate session quality metrics
# MAGIC - Aggregate daily usage per subscriber

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from datetime import datetime

from pyspark.sql import SparkSession, Window
from pyspark.sql.functions import (
    avg,
    col,
    count,
    current_timestamp,
    date_format,
    lit,
    max as spark_max,
    min as spark_min,
    round as spark_round,
    row_number,
    sum as spark_sum,
    to_date,
    to_timestamp,
    when,
)

SOURCE_CDR = "lh_bronze.bronze_telecom_cdr"
SOURCE_SUBSCRIBERS = "lh_bronze.bronze_telecom_subscribers"
SOURCE_CELL_SITES = "lh_bronze.bronze_telecom_cell_sites"
TARGET_TABLE = "lh_silver.silver_telecom_usage"
TARGET_DAILY = "lh_silver.silver_telecom_daily_usage"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

print(f"Source CDR: {SOURCE_CDR}")
print(f"Target: {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Tables

# COMMAND ----------

df_cdr = spark.table(SOURCE_CDR)
df_subs = spark.table(SOURCE_SUBSCRIBERS)
df_cells = spark.table(SOURCE_CELL_SITES)

print(f"CDR records:        {df_cdr.count():,}")
print(f"Subscriber records: {df_subs.count():,}")
print(f"Cell site records:  {df_cells.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Deduplication
# MAGIC
# MAGIC Remove duplicate CDRs by `cdr_id`, keeping the most recently ingested.

# COMMAND ----------

window_dedup = Window.partitionBy("cdr_id").orderBy(col("_bronze_ingested_at").desc())

df_deduped = df_cdr \
    .withColumn("_row_num", row_number().over(window_dedup)) \
    .filter(col("_row_num") == 1) \
    .drop("_row_num")

dedup_removed = df_cdr.count() - df_deduped.count()
print(f"Duplicates removed: {dedup_removed:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation
# MAGIC
# MAGIC - Voice/data calls must have duration > 0
# MAGIC - Required fields must not be null

# COMMAND ----------

df_valid = df_deduped.filter(
    col("cdr_id").isNotNull()
    & col("subscriber_id").isNotNull()
    & col("call_type").isNotNull()
    & (
        (col("call_type") == "sms")
        | (col("duration_sec") > 0)
    )
)

invalid_count = df_deduped.count() - df_valid.count()
print(f"Invalid records filtered: {invalid_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Enrich with Subscriber and Cell Site Data

# COMMAND ----------

df_enriched = df_valid \
    .join(
        df_subs.select(
            "subscriber_id", "plan_type", "tenure_months",
            "monthly_charge", "churn_flag", "cpni_consent",
        ),
        on="subscriber_id",
        how="left",
    ) \
    .join(
        df_cells.select("cell_id", "sector", "latitude", "longitude", "technology"),
        on=["cell_id", "sector"],
        how="left",
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Calculate Session Quality Metrics

# COMMAND ----------

df_with_quality = df_enriched \
    .withColumn("start_timestamp", to_timestamp(col("start_dt"))) \
    .withColumn("call_date", to_date(col("start_timestamp"))) \
    .withColumn(
        "throughput_mbps",
        when(
            (col("call_type") == "data") & (col("duration_sec") > 0),
            spark_round(
                (col("bytes_down") + col("bytes_up")) / col("duration_sec") / 125000.0,
                2,
            ),
        ).otherwise(lit(None)),
    ) \
    .withColumn(
        "data_volume_mb",
        spark_round((col("bytes_down") + col("bytes_up")) / 1048576.0, 2),
    ) \
    .withColumn("_silver_processed_at", current_timestamp()) \
    .withColumn("_silver_batch_id", lit(BATCH_ID))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Enriched CDRs to Silver

# COMMAND ----------

df_with_quality.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(TARGET_TABLE)

print(f"Written {df_with_quality.count():,} enriched CDRs to {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Daily Usage per Subscriber

# COMMAND ----------

df_daily = df_with_quality \
    .groupBy("subscriber_id", "call_date", "plan_type") \
    .agg(
        count("*").alias("total_events"),
        spark_sum(when(col("call_type") == "voice", col("duration_sec")).otherwise(0)).alias("voice_seconds"),
        spark_sum(when(col("call_type") == "voice", 1).otherwise(0)).alias("voice_calls"),
        spark_sum(when(col("call_type") == "sms", 1).otherwise(0)).alias("sms_count"),
        spark_sum(when(col("call_type") == "data", col("bytes_down")).otherwise(0)).alias("data_bytes_down"),
        spark_sum(when(col("call_type") == "data", col("bytes_up")).otherwise(0)).alias("data_bytes_up"),
        spark_sum("rated_amount").alias("total_rated_amount"),
        avg("throughput_mbps").alias("avg_throughput_mbps"),
        spark_sum(when(col("call_type") == "data", col("data_volume_mb")).otherwise(0)).alias("data_volume_mb"),
    ) \
    .withColumn("_silver_processed_at", current_timestamp()) \
    .withColumn("_silver_batch_id", lit(BATCH_ID))

df_daily.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(TARGET_DAILY)

print(f"Written {df_daily.count():,} daily usage records to {TARGET_DAILY}")
