# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Telecom Churn Scoring & Network KPIs
# MAGIC
# MAGIC Produces three Gold tables:
# MAGIC 1. **gold_telecom_churn** -- subscriber churn propensity scores with feature vectors
# MAGIC 2. **gold_network_kpis** -- network quality KPIs by cell, sector, hour
# MAGIC 3. **gold_telecom_arpu** -- average revenue per user (ARPU) by segment
# MAGIC
# MAGIC ## Sources
# MAGIC - silver_telecom_usage (enriched CDRs)
# MAGIC - silver_telecom_daily_usage (daily aggregates)
# MAGIC
# MAGIC ## Compliance
# MAGIC - CPNI: churn scores reference only subscriber_id (no PII in Gold)
# MAGIC - Outputs are aggregated / scored -- safe for broader analytics access

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
    countDistinct,
    current_timestamp,
    datediff,
    hour,
    lag,
    last,
    lit,
    max as spark_max,
    min as spark_min,
    round as spark_round,
    sum as spark_sum,
    to_date,
    when,
)
from pyspark.ml.feature import VectorAssembler
from pyspark.ml.classification import GBTClassifier
from pyspark.ml.evaluation import BinaryClassificationEvaluator

SOURCE_USAGE = "lh_silver.silver_telecom_usage"
SOURCE_DAILY = "lh_silver.silver_telecom_daily_usage"
TARGET_CHURN = "lh_gold.gold_telecom_churn"
TARGET_NETWORK = "lh_gold.gold_network_kpis"
TARGET_ARPU = "lh_gold.gold_telecom_arpu"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

print(f"Sources: {SOURCE_USAGE}, {SOURCE_DAILY}")
print(f"Targets: {TARGET_CHURN}, {TARGET_NETWORK}, {TARGET_ARPU}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Tables

# COMMAND ----------

df_usage = spark.table(SOURCE_USAGE)
df_daily = spark.table(SOURCE_DAILY)

print(f"Usage records:  {df_usage.count():,}")
print(f"Daily records:  {df_daily.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Churn Feature Engineering

# COMMAND ----------

# Aggregate subscriber-level features from daily usage
df_sub_features = df_daily \
    .groupBy("subscriber_id", "plan_type") \
    .agg(
        spark_sum("voice_seconds").alias("total_voice_seconds"),
        spark_sum("voice_calls").alias("total_voice_calls"),
        spark_sum("sms_count").alias("total_sms_count"),
        spark_sum("data_bytes_down").alias("total_data_down"),
        spark_sum("data_bytes_up").alias("total_data_up"),
        spark_sum("total_rated_amount").alias("total_revenue"),
        avg("avg_throughput_mbps").alias("mean_throughput_mbps"),
        count("*").alias("active_days"),
        countDistinct("call_date").alias("distinct_active_days"),
        spark_sum("data_volume_mb").alias("total_data_mb"),
    )

# Join back subscriber attributes from usage table (tenure, churn_flag)
df_sub_attrs = df_usage \
    .select("subscriber_id", "tenure_months", "monthly_charge", "churn_flag") \
    .dropDuplicates(["subscriber_id"])

df_churn_features = df_sub_features \
    .join(df_sub_attrs, on="subscriber_id", how="left") \
    .withColumn(
        "data_usage_gb",
        spark_round((col("total_data_down") + col("total_data_up")) / 1073741824.0, 2),
    ) \
    .withColumn(
        "arpu",
        spark_round(col("total_revenue") / col("active_days") * 30, 2),
    ) \
    .withColumn(
        "voice_minutes",
        spark_round(col("total_voice_seconds") / 60.0, 1),
    ) \
    .fillna({"tenure_months": 0, "monthly_charge": 0.0, "churn_flag": False})

# COMMAND ----------

# MAGIC %md
# MAGIC ## Churn Propensity Scoring (GBT Classifier)

# COMMAND ----------

feature_cols = [
    "tenure_months", "monthly_charge", "total_voice_calls",
    "total_sms_count", "data_usage_gb", "arpu",
    "mean_throughput_mbps", "distinct_active_days", "voice_minutes",
]

# Convert churn_flag boolean to int label
df_labeled = df_churn_features \
    .withColumn("label", when(col("churn_flag") == True, 1).otherwise(0)) \
    .fillna(0.0)

assembler = VectorAssembler(inputCols=feature_cols, outputCol="features", handleInvalid="skip")
df_assembled = assembler.transform(df_labeled)

# Train/test split
train_df, test_df = df_assembled.randomSplit([0.8, 0.2], seed=42)

# Train GBT model
gbt = GBTClassifier(
    featuresCol="features",
    labelCol="label",
    maxIter=50,
    maxDepth=5,
    seed=42,
)
model = gbt.fit(train_df)

# Score all subscribers
df_scored = model.transform(df_assembled) \
    .select(
        "subscriber_id", "plan_type", "tenure_months", "monthly_charge",
        "data_usage_gb", "arpu", "voice_minutes", "total_sms_count",
        "mean_throughput_mbps", "distinct_active_days",
        "label", "probability", "prediction",
    )

# Extract churn probability (index 1 of probability vector)
from pyspark.ml.functions import vector_to_array

df_churn_output = df_scored \
    .withColumn("prob_array", vector_to_array(col("probability"))) \
    .withColumn("churn_propensity", spark_round(col("prob_array")[1], 4)) \
    .withColumn(
        "risk_tier",
        when(col("churn_propensity") > 0.7, "high")
        .when(col("churn_propensity") > 0.4, "medium")
        .otherwise("low"),
    ) \
    .drop("prob_array", "probability", "prediction") \
    .withColumn("_gold_scored_at", current_timestamp()) \
    .withColumn("_gold_batch_id", lit(BATCH_ID))

# Evaluate
evaluator = BinaryClassificationEvaluator(labelCol="label", metricName="areaUnderROC")
auc = evaluator.evaluate(model.transform(test_df))
print(f"Model AUC-ROC: {auc:.4f}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Churn Scores to Gold

# COMMAND ----------

df_churn_output.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(TARGET_CHURN)

print(f"Written {df_churn_output.count():,} churn scores to {TARGET_CHURN}")
df_churn_output.groupBy("risk_tier").count().show()

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Network KPIs by Cell / Sector / Hour

# COMMAND ----------

df_network = df_usage \
    .withColumn("event_hour", hour(col("start_timestamp"))) \
    .groupBy("cell_id", "sector", "technology", "event_hour") \
    .agg(
        count("*").alias("total_events"),
        spark_sum(when(col("call_type") == "voice", 1).otherwise(0)).alias("voice_attempts"),
        spark_sum(
            when((col("call_type") == "voice") & (col("duration_sec") < 10), 1).otherwise(0)
        ).alias("dropped_calls"),
        avg("throughput_mbps").alias("avg_throughput_mbps"),
        avg("duration_sec").alias("avg_duration_sec"),
        spark_sum("data_volume_mb").alias("total_data_mb"),
        countDistinct("subscriber_id").alias("unique_subscribers"),
    ) \
    .withColumn(
        "dropped_call_rate",
        when(col("voice_attempts") > 0,
             spark_round(col("dropped_calls") * 100.0 / col("voice_attempts"), 2))
        .otherwise(0.0),
    ) \
    .withColumn("_gold_computed_at", current_timestamp()) \
    .withColumn("_gold_batch_id", lit(BATCH_ID))

df_network.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(TARGET_NETWORK)

print(f"Written {df_network.count():,} network KPI records to {TARGET_NETWORK}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. ARPU by Segment

# COMMAND ----------

df_arpu = df_churn_features \
    .groupBy("plan_type") \
    .agg(
        count("*").alias("subscriber_count"),
        spark_round(avg("arpu"), 2).alias("avg_arpu"),
        spark_round(avg("data_usage_gb"), 2).alias("avg_data_gb"),
        spark_round(avg("voice_minutes"), 1).alias("avg_voice_min"),
        spark_round(avg("total_sms_count"), 0).alias("avg_sms_count"),
    ) \
    .withColumn("_gold_computed_at", current_timestamp()) \
    .withColumn("_gold_batch_id", lit(BATCH_ID))

df_arpu.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(TARGET_ARPU)

print(f"\nARPU by segment:")
df_arpu.show()
print(f"Gold layer complete. Batch: {BATCH_ID}")
