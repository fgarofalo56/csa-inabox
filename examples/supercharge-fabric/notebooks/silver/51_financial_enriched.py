# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Financial Transaction Enrichment
# MAGIC
# MAGIC Reads bronze financial transactions, enriches with velocity features,
# MAGIC geo-distance calculations, and merchant category details. Deduplicates
# MAGIC and validates before writing to Silver.
# MAGIC
# MAGIC ## Transformations
# MAGIC - MCC category enrichment and merchant risk classification
# MAGIC - Velocity features: txn count in last 1h, 24h, 7d per card
# MAGIC - Geo-distance (Haversine) between consecutive transactions
# MAGIC - Amount deviation from rolling 30-day average
# MAGIC - Deduplication on txn_id
# MAGIC - Validation: amount > 0, required fields non-null
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** silver_financial_enriched
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Overwrite (full refresh per run)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from datetime import datetime

from pyspark.sql import SparkSession, Window
from pyspark.sql.functions import (
    abs as spark_abs,
    acos,
    avg,
    col,
    cos,
    count,
    current_timestamp,
    lag,
    lit,
    radians,
    row_number,
    sin,
    sqrt,
    stddev,
    to_timestamp,
    when,
)
from pyspark.sql.types import DoubleType

spark = SparkSession.builder.getOrCreate()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Parameters

# COMMAND ----------

BRONZE_TABLE = "lh_bronze.bronze_financial_transactions"
SILVER_TABLE = "lh_silver.silver_financial_enriched"

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Data

# COMMAND ----------

df_bronze = spark.read.format("delta").table(BRONZE_TABLE)
initial_count = df_bronze.count()
print(f"Bronze records read: {initial_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Deduplicate on txn_id

# COMMAND ----------

window_dedup = Window.partitionBy("txn_id").orderBy(col("_ingested_at").desc())

df_deduped = (
    df_bronze
    .withColumn("_row_num", row_number().over(window_dedup))
    .filter(col("_row_num") == 1)
    .drop("_row_num")
)

dedup_removed = initial_count - df_deduped.count()
print(f"Duplicates removed: {dedup_removed:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validate Records

# COMMAND ----------

df_valid = df_deduped.filter(
    col("txn_id").isNotNull()
    & col("acct_id").isNotNull()
    & col("amount").isNotNull()
    & (col("amount") > 0)
    & col("txn_timestamp").isNotNull()
)

invalid_count = df_deduped.count() - df_valid.count()
if invalid_count > 0:
    print(f"WARNING: {invalid_count:,} invalid records filtered out")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Parse Timestamp

# COMMAND ----------

df_ts = df_valid.withColumn(
    "txn_ts", to_timestamp(col("txn_timestamp"))
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Merchant Risk Classification

# COMMAND ----------

HIGH_RISK_MCCS = ["5933", "5960", "7273", "7995", "6010", "6011", "6051"]

df_merchant = df_ts.withColumn(
    "merchant_risk",
    when(col("merchant_mcc").isin(HIGH_RISK_MCCS), "high")
    .when(col("mcc_category").isin("travel", "entertainment"), "medium")
    .otherwise("low")
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Velocity Features
# MAGIC
# MAGIC Calculate transaction counts per card within 1h, 24h, and 7d windows.

# COMMAND ----------

# Window specs for velocity calculations
window_card_time = Window.partitionBy("card_hash").orderBy("txn_ts")

# For range-based windows, we use seconds-based rangeBetween
SECONDS_1H = 3600
SECONDS_24H = 86400
SECONDS_7D = 604800

window_1h = (
    Window.partitionBy("card_hash")
    .orderBy(col("txn_ts").cast("long"))
    .rangeBetween(-SECONDS_1H, 0)
)
window_24h = (
    Window.partitionBy("card_hash")
    .orderBy(col("txn_ts").cast("long"))
    .rangeBetween(-SECONDS_24H, 0)
)
window_7d = (
    Window.partitionBy("card_hash")
    .orderBy(col("txn_ts").cast("long"))
    .rangeBetween(-SECONDS_7D, 0)
)
window_30d = (
    Window.partitionBy("card_hash")
    .orderBy(col("txn_ts").cast("long"))
    .rangeBetween(-2592000, 0)
)

df_velocity = (
    df_merchant
    .withColumn("txn_count_1h", count("txn_id").over(window_1h))
    .withColumn("txn_count_24h", count("txn_id").over(window_24h))
    .withColumn("txn_count_7d", count("txn_id").over(window_7d))
    .withColumn("avg_amount_30d", avg("amount").over(window_30d))
    .withColumn("stddev_amount_30d", stddev("amount").over(window_30d))
    .withColumn(
        "amount_zscore",
        when(
            col("stddev_amount_30d") > 0,
            (col("amount") - col("avg_amount_30d")) / col("stddev_amount_30d"),
        ).otherwise(0.0),
    )
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Geo-Distance (Haversine)
# MAGIC
# MAGIC Calculate distance in km between current and previous transaction location.

# COMMAND ----------

df_geo = df_velocity.withColumn(
    "prev_lat", lag("merchant_lat").over(window_card_time)
).withColumn(
    "prev_lon", lag("merchant_lon").over(window_card_time)
)

# Haversine formula
EARTH_RADIUS_KM = 6371.0

df_geo = df_geo.withColumn(
    "geo_distance_km",
    when(
        col("prev_lat").isNotNull() & col("prev_lon").isNotNull(),
        (
            lit(2 * EARTH_RADIUS_KM)
            * acos(
                sin(radians(col("merchant_lat"))) * sin(radians(col("prev_lat")))
                + cos(radians(col("merchant_lat")))
                * cos(radians(col("prev_lat")))
                * cos(radians(col("merchant_lon")) - radians(col("prev_lon")))
            )
        ).cast(DoubleType()),
    ).otherwise(0.0),
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Time Since Last Transaction

# COMMAND ----------

df_time = df_geo.withColumn(
    "prev_txn_ts", lag("txn_ts").over(window_card_time)
).withColumn(
    "time_since_last_txn_sec",
    when(
        col("prev_txn_ts").isNotNull(),
        (col("txn_ts").cast("long") - col("prev_txn_ts").cast("long")),
    ).otherwise(lit(None).cast("long")),
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Select Final Columns

# COMMAND ----------

df_silver = df_time.select(
    "txn_id",
    "txn_ts",
    "acct_id",
    "card_hash",
    "channel",
    "merchant_name",
    "merchant_mcc",
    "mcc_category",
    "merchant_risk",
    "amount",
    "currency",
    "auth_code",
    "merchant_lat",
    "merchant_lon",
    "is_fraud",
    "fraud_pattern",
    "txn_count_1h",
    "txn_count_24h",
    "txn_count_7d",
    "avg_amount_30d",
    "amount_zscore",
    "geo_distance_km",
    "time_since_last_txn_sec",
    current_timestamp().alias("_enriched_at"),
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Silver

# COMMAND ----------

(
    df_silver
    .write
    .format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .saveAsTable(SILVER_TABLE)
)

print(f"Silver enrichment complete: {df_silver.count():,} records written to {SILVER_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Enrichment Summary

# COMMAND ----------

summary = spark.sql(f"""
    SELECT
        COUNT(*) AS total_records,
        ROUND(AVG(txn_count_1h), 2) AS avg_velocity_1h,
        ROUND(AVG(txn_count_24h), 2) AS avg_velocity_24h,
        ROUND(AVG(geo_distance_km), 2) AS avg_geo_distance_km,
        ROUND(AVG(amount_zscore), 2) AS avg_amount_zscore,
        SUM(CASE WHEN merchant_risk = 'high' THEN 1 ELSE 0 END) AS high_risk_merchant_txns
    FROM {SILVER_TABLE}
""")

summary.show(truncate=False)

# COMMAND ----------

from notebookutils import mssparkutils

mssparkutils.notebook.exit(f"silver_financial_enriched complete at {datetime.now().isoformat()}")
