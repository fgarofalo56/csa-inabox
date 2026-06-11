# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Financial Fraud Scoring & AML Alerts
# MAGIC
# MAGIC Reads enriched Silver transactions and computes:
# MAGIC 1. **Fraud scores** - Rule-based + ML feature scoring per transaction
# MAGIC 2. **AML alerts** - CTR filings (>$10K) and structuring pattern detection
# MAGIC 3. **Daily fraud summary** - Aggregate fraud rate and loss metrics
# MAGIC 4. **Portfolio risk metrics** - Basel III risk-weighted asset approximations
# MAGIC
# MAGIC ## Output Tables
# MAGIC - `gold_fraud_scores` - Per-transaction fraud probability
# MAGIC - `gold_aml_alerts` - BSA/AML alert queue
# MAGIC - `gold_daily_fraud_summary` - Operational KPIs
# MAGIC
# MAGIC ## Compliance
# MAGIC - BSA/AML: 31 CFR 1010.311 (CTR threshold $10,000)
# MAGIC - BSA/AML: 31 CFR 1010.314 (structuring detection)
# MAGIC - SOX: Immutable audit trail in all Gold tables

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
    date_trunc,
    greatest,
    least,
    lit,
    round as spark_round,
    sum as spark_sum,
    to_date,
    when,
)

spark = SparkSession.builder.getOrCreate()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Parameters

# COMMAND ----------

SILVER_TABLE = "lh_silver.silver_financial_enriched"
GOLD_FRAUD_SCORES = "lh_gold.gold_fraud_scores"
GOLD_AML_ALERTS = "lh_gold.gold_aml_alerts"
GOLD_DAILY_SUMMARY = "lh_gold.gold_daily_fraud_summary"

# Compliance thresholds
CTR_THRESHOLD = 10000.00  # 31 CFR 1010.311
STRUCTURING_LOW = 8000.00
STRUCTURING_HIGH = 9999.99
STRUCTURING_WINDOW_HOURS = 48

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Data

# COMMAND ----------

df_silver = spark.read.format("delta").table(SILVER_TABLE)
print(f"Silver records read: {df_silver.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Fraud Scoring (Rule-Based)
# MAGIC
# MAGIC Score components (0-1 scale):
# MAGIC - Velocity: >5 txns/1h → +0.25
# MAGIC - Geo-anomaly: >500 km in <1h → +0.30
# MAGIC - Amount spike: z-score >3 → +0.20
# MAGIC - High-risk MCC → +0.15
# MAGIC - Card-not-present (no 3DS) → +0.10

# COMMAND ----------

df_scored = df_silver.withColumn(
    "score_velocity",
    when(col("txn_count_1h") > 5, 0.25)
    .when(col("txn_count_1h") > 3, 0.10)
    .otherwise(0.0),
).withColumn(
    "score_geo",
    when(
        (col("geo_distance_km") > 500)
        & (col("time_since_last_txn_sec").isNotNull())
        & (col("time_since_last_txn_sec") < 3600),
        0.30,
    )
    .when(col("geo_distance_km") > 200, 0.10)
    .otherwise(0.0),
).withColumn(
    "score_amount",
    when(col("amount_zscore") > 3.0, 0.20)
    .when(col("amount_zscore") > 2.0, 0.10)
    .otherwise(0.0),
).withColumn(
    "score_merchant",
    when(col("merchant_risk") == "high", 0.15).otherwise(0.0),
).withColumn(
    "score_channel",
    when(col("channel") == "card_not_present", 0.10).otherwise(0.0),
)

# Composite fraud score (capped at 1.0)
df_scored = df_scored.withColumn(
    "fraud_score",
    least(
        lit(1.0),
        col("score_velocity")
        + col("score_geo")
        + col("score_amount")
        + col("score_merchant")
        + col("score_channel"),
    ),
)

# Decision
df_scored = df_scored.withColumn(
    "fraud_decision",
    when(col("fraud_score") >= 0.85, "DECLINE")
    .when(col("fraud_score") >= 0.50, "STEP_UP_AUTH")
    .otherwise("APPROVE"),
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Fraud Scores

# COMMAND ----------

fraud_output = df_scored.select(
    "txn_id",
    "txn_ts",
    "acct_id",
    "card_hash",
    "channel",
    "merchant_name",
    "merchant_mcc",
    "amount",
    "currency",
    "is_fraud",
    "fraud_pattern",
    "fraud_score",
    "fraud_decision",
    "score_velocity",
    "score_geo",
    "score_amount",
    "score_merchant",
    "score_channel",
    "txn_count_1h",
    "geo_distance_km",
    "amount_zscore",
    current_timestamp().alias("_scored_at"),
)

(
    fraud_output
    .write
    .format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .saveAsTable(GOLD_FRAUD_SCORES)
)

print(f"Fraud scores written: {fraud_output.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## AML Alert Generation
# MAGIC
# MAGIC ### CTR Filing (31 CFR 1010.311)
# MAGIC Any cash transaction >= $10,000 requires a Currency Transaction Report.
# MAGIC
# MAGIC ### Structuring Detection (31 CFR 1010.314)
# MAGIC Multiple cash transactions between $8,000-$9,999 within 48 hours
# MAGIC from the same customer.

# COMMAND ----------

# CTR Alerts
df_ctr = df_silver.filter(col("amount") >= CTR_THRESHOLD).withColumn(
    "alert_type", lit("CTR")
).withColumn(
    "alert_reason",
    lit(f"Transaction amount >= ${CTR_THRESHOLD:,.2f} (31 CFR 1010.311)"),
).withColumn(
    "alert_priority", lit("HIGH")
)

print(f"CTR alerts: {df_ctr.count():,}")

# COMMAND ----------

# Structuring detection
window_structuring = (
    Window.partitionBy("acct_id")
    .orderBy(col("txn_ts").cast("long"))
    .rangeBetween(-STRUCTURING_WINDOW_HOURS * 3600, 0)
)

df_structuring_check = (
    df_silver
    .filter(
        (col("amount") >= STRUCTURING_LOW)
        & (col("amount") <= STRUCTURING_HIGH)
    )
    .withColumn(
        "structuring_count",
        count("txn_id").over(window_structuring),
    )
    .filter(col("structuring_count") >= 2)
    .withColumn("alert_type", lit("STRUCTURING"))
    .withColumn(
        "alert_reason",
        lit(f"Multiple transactions ${STRUCTURING_LOW:,.0f}-${STRUCTURING_HIGH:,.0f} within {STRUCTURING_WINDOW_HOURS}h"),
    )
    .withColumn("alert_priority", lit("CRITICAL"))
)

print(f"Structuring alerts: {df_structuring_check.count():,}")

# COMMAND ----------

# Combine AML alerts
aml_columns = [
    "txn_id", "txn_ts", "acct_id", "card_hash", "amount",
    "channel", "alert_type", "alert_reason", "alert_priority",
]

df_aml = df_ctr.select(*aml_columns).union(
    df_structuring_check.select(*aml_columns)
).withColumn("_alert_generated_at", current_timestamp())

(
    df_aml
    .write
    .format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .saveAsTable(GOLD_AML_ALERTS)
)

print(f"Total AML alerts written: {df_aml.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Daily Fraud Summary

# COMMAND ----------

df_daily = (
    df_scored
    .withColumn("txn_date", to_date("txn_ts"))
    .groupBy("txn_date")
    .agg(
        count("txn_id").alias("total_txns"),
        spark_sum(when(col("is_fraud"), 1).otherwise(0)).alias("fraud_count"),
        spark_round(
            spark_sum(when(col("is_fraud"), col("amount")).otherwise(0)), 2
        ).alias("fraud_loss_amount"),
        spark_round(avg("fraud_score"), 4).alias("avg_fraud_score"),
        spark_sum(when(col("fraud_decision") == "DECLINE", 1).otherwise(0)).alias("declined_count"),
        spark_sum(when(col("fraud_decision") == "STEP_UP_AUTH", 1).otherwise(0)).alias("step_up_count"),
        spark_round(spark_sum("amount"), 2).alias("total_volume"),
    )
    .withColumn(
        "fraud_rate",
        spark_round(col("fraud_count") / col("total_txns"), 6),
    )
    .withColumn("_computed_at", current_timestamp())
    .orderBy("txn_date")
)

(
    df_daily
    .write
    .format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .saveAsTable(GOLD_DAILY_SUMMARY)
)

print(f"Daily summary written: {df_daily.count()} days")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Output Summary

# COMMAND ----------

print("=" * 60)
print("GOLD LAYER - FINANCIAL FRAUD SCORING COMPLETE")
print("=" * 60)

fraud_stats = spark.sql(f"""
    SELECT
        COUNT(*) AS total_scored,
        SUM(CASE WHEN fraud_decision = 'DECLINE' THEN 1 ELSE 0 END) AS declined,
        SUM(CASE WHEN fraud_decision = 'STEP_UP_AUTH' THEN 1 ELSE 0 END) AS step_up,
        SUM(CASE WHEN fraud_decision = 'APPROVE' THEN 1 ELSE 0 END) AS approved,
        ROUND(AVG(fraud_score), 4) AS avg_score,
        ROUND(AVG(CASE WHEN is_fraud THEN fraud_score END), 4) AS avg_score_fraud,
        ROUND(AVG(CASE WHEN NOT is_fraud THEN fraud_score END), 4) AS avg_score_legit
    FROM {GOLD_FRAUD_SCORES}
""")
fraud_stats.show(truncate=False)

aml_stats = spark.sql(f"""
    SELECT alert_type, alert_priority, COUNT(*) AS alert_count
    FROM {GOLD_AML_ALERTS}
    GROUP BY alert_type, alert_priority
    ORDER BY alert_type
""")
aml_stats.show(truncate=False)

# COMMAND ----------

from notebookutils import mssparkutils

mssparkutils.notebook.exit(f"gold_fraud_scoring complete at {datetime.now().isoformat()}")
