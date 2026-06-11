# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Insurance Claims Analytics & Predictions
# MAGIC
# MAGIC Computes actuarial and fraud analytics from validated silver claims:
# MAGIC
# MAGIC 1. **Loss Ratio** by LOB, state, quarter
# MAGIC 2. **Severity Distribution** by LOB
# MAGIC 3. **Fraud Score Features** for ML scoring
# MAGIC 4. **IBNR Triangle** (incurred-but-not-reported loss development)
# MAGIC 5. **Claims Closure Rate** trending
# MAGIC 6. **Subrogation Recovery Rate**
# MAGIC
# MAGIC ## Targets
# MAGIC - `gold_insurance_loss_triangles`
# MAGIC - `gold_insurance_fraud_scores`
# MAGIC - `gold_insurance_loss_ratios`
# MAGIC - `gold_insurance_kpis`

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from pyspark.sql import SparkSession, Window
from pyspark.sql.functions import (
    avg,
    col,
    count,
    countDistinct,
    current_timestamp,
    lit,
    log as spark_log,
    quarter,
    round as spark_round,
    stddev,
    sum as spark_sum,
    when,
    year,
)

spark = SparkSession.builder.getOrCreate()

SILVER_TABLE = "lh_silver.silver_insurance_claims"

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Data

# COMMAND ----------

df = spark.table(SILVER_TABLE)
total = df.count()
print(f"Silver records: {total:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Loss Ratio by LOB / State / Quarter

# COMMAND ----------

df_loss_ratio = (
    df
    .withColumn("accident_year", year("loss_dt"))
    .withColumn("accident_quarter", quarter("loss_dt"))
    .groupBy("line_of_business", "state", "accident_year", "accident_quarter")
    .agg(
        spark_sum("reserve_amt").alias("incurred_losses"),
        spark_sum("paid_amt").alias("paid_losses"),
        count("*").alias("claim_count"),
        countDistinct("policy_id").alias("policy_count"),
    )
)

# Loss ratio requires earned premium; approximate from claim-level data
# In production, join to policy-level earned premium table
df_loss_ratio = df_loss_ratio.withColumn(
    "loss_ratio_estimate",
    spark_round(col("incurred_losses") / (col("policy_count") * 2500), 4),
)

df_loss_ratio = df_loss_ratio.withColumn("_computed_at", current_timestamp())

(
    df_loss_ratio
    .write.format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .saveAsTable("lh_gold.gold_insurance_loss_ratios")
)

print(f"Loss ratios written: {df_loss_ratio.count():,} rows")
df_loss_ratio.show(10, truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Severity Distribution by LOB

# COMMAND ----------

df_severity = (
    df
    .groupBy("line_of_business")
    .agg(
        avg("reserve_amt").alias("avg_severity"),
        stddev("reserve_amt").alias("stddev_severity"),
        spark_sum("reserve_amt").alias("total_incurred"),
        count("*").alias("claim_count"),
        avg("paid_amt").alias("avg_paid"),
    )
    .withColumn("cv_severity", spark_round(col("stddev_severity") / col("avg_severity"), 4))
    .withColumn("_computed_at", current_timestamp())
)

print("=== Severity Distribution by LOB ===")
df_severity.show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Fraud Score Features

# COMMAND ----------

# Build feature vector per claim for fraud scoring
df_fraud = (
    df
    .withColumn("report_lag_score", when(col("report_lag_days") > 30, 1.0).otherwise(0.0))
    .withColumn("high_reserve_score", when(col("reserve_amt") > 50000, 1.0).otherwise(0.0))
    .withColumn("reopened_score", when(col("status") == "reopened", 1.0).otherwise(0.0))
    .withColumn("zero_paid_score", when(col("paid_amt") == 0, 0.5).otherwise(0.0))
    .withColumn("log_reserve", spark_log(col("reserve_amt") + 1))
)

# Aggregate fraud features
df_fraud_scores = (
    df_fraud
    .withColumn(
        "fraud_score",
        spark_round(
            (col("report_lag_score") * 25
             + col("high_reserve_score") * 30
             + col("reopened_score") * 20
             + col("zero_paid_score") * 10
             + when(col("fraud_flag"), 15.0).otherwise(0.0)),
            2,
        ),
    )
    .select(
        "claim_id", "policy_id", "line_of_business", "state",
        "loss_type", "reserve_amt", "paid_amt", "report_lag_days",
        "fraud_flag", "fraud_score",
        "report_lag_score", "high_reserve_score", "reopened_score",
        "zero_paid_score", "log_reserve",
    )
    .withColumn("_scored_at", current_timestamp())
)

(
    df_fraud_scores
    .write.format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .saveAsTable("lh_gold.gold_insurance_fraud_scores")
)

fraud_count = df_fraud_scores.filter(col("fraud_score") > 75).count()
print(f"Fraud scores written: {df_fraud_scores.count():,} claims")
print(f"High-risk referrals (score > 75): {fraud_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. IBNR Loss Development Triangle

# COMMAND ----------

# Build loss triangle: accident quarter x development quarter
df_triangle = (
    df
    .withColumn("accident_year", year("loss_dt"))
    .withColumn("accident_qtr", quarter("loss_dt"))
    .withColumn("accident_period", (col("accident_year") * 10 + col("accident_qtr")))
    .withColumn("dev_quarter", (col("development_age_months") / 3).cast("int") + 1)
    .groupBy("line_of_business", "accident_period", "dev_quarter")
    .agg(
        spark_sum("reserve_amt").alias("cumulative_incurred"),
        spark_sum("paid_amt").alias("cumulative_paid"),
        count("*").alias("claim_count"),
    )
    .orderBy("line_of_business", "accident_period", "dev_quarter")
    .withColumn("_computed_at", current_timestamp())
)

(
    df_triangle
    .write.format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .saveAsTable("lh_gold.gold_insurance_loss_triangles")
)

print(f"Loss triangle rows: {df_triangle.count():,}")
df_triangle.filter(col("line_of_business") == "auto").show(20, truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Claims Closure Rate & Subrogation Recovery

# COMMAND ----------

closed_statuses = ["closed_paid", "closed_no_pay"]

df_kpis = (
    df
    .withColumn("accident_year", year("loss_dt"))
    .withColumn("accident_qtr", quarter("loss_dt"))
    .groupBy("line_of_business", "accident_year", "accident_qtr")
    .agg(
        count("*").alias("total_claims"),
        spark_sum(when(col("status").isin(closed_statuses), 1).otherwise(0)).alias("closed_claims"),
        spark_sum(when(col("status") == "subrogation", 1).otherwise(0)).alias("subro_claims"),
        spark_sum(when(col("status") == "subrogation", col("paid_amt")).otherwise(0)).alias("subro_paid"),
        spark_sum(when(col("status") == "subrogation", col("reserve_amt")).otherwise(0)).alias("subro_reserve"),
        avg("report_lag_days").alias("avg_report_lag"),
        avg("reserve_amt").alias("avg_reserve"),
    )
    .withColumn("closure_rate", spark_round(col("closed_claims") / col("total_claims"), 4))
    .withColumn(
        "subro_recovery_rate",
        when(col("subro_reserve") > 0,
             spark_round(col("subro_paid") / col("subro_reserve"), 4))
        .otherwise(lit(0.0)),
    )
    .withColumn("_computed_at", current_timestamp())
)

(
    df_kpis
    .write.format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .saveAsTable("lh_gold.gold_insurance_kpis")
)

print(f"KPI rows written: {df_kpis.count():,}")
df_kpis.show(10, truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print("=== Gold Layer Insurance Analytics Complete ===")
print(f"  gold_insurance_loss_ratios:    {df_loss_ratio.count():,} rows")
print(f"  gold_insurance_fraud_scores:   {df_fraud_scores.count():,} rows")
print(f"  gold_insurance_loss_triangles: {df_triangle.count():,} rows")
print(f"  gold_insurance_kpis:           {df_kpis.count():,} rows")
print()
print("Downstream: Power BI Direct Lake dashboards, SIU referral queue, statutory feeds")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Notebook Complete
# MAGIC
# MAGIC Gold analytics for insurance claims are ready.
# MAGIC Connect Power BI via Direct Lake for real-time dashboards.
