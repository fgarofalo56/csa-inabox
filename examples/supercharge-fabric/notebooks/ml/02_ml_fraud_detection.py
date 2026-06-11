# Databricks notebook source
# MAGIC %md
# MAGIC # ML: Fraud Detection - Anomaly Detection
# MAGIC
# MAGIC This notebook implements fraud detection using anomaly detection techniques
# MAGIC to identify suspicious financial activity patterns in casino operations.
# MAGIC
# MAGIC ## Detection Patterns:
# MAGIC - Structuring (multiple near-CTR transactions)
# MAGIC - Unusual transaction volumes
# MAGIC - Suspicious timing patterns
# MAGIC - Outlier financial behavior

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup

# COMMAND ----------

from datetime import datetime, timedelta

# MLflow
import mlflow
import mlflow.sklearn
import numpy as np
import pandas as pd
from pyspark.sql.functions import (
    avg,
    coalesce,
    col,
    count,
    countDistinct,
    current_timestamp,
    hour,
    lit,
    max,
    min,
    rand,
    stddev,
    sum,
    to_date,
    when,
)
from pyspark.sql.types import DoubleType, IntegerType, Row
from pyspark.sql.window import Window

# For sklearn-based anomaly detection
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler

# Source table
financial_table = "lh_silver.silver_financial_reconciled"

print(f"Analyzing financial transactions for fraud patterns")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Load Financial Data

# COMMAND ----------

# Check if table exists
if not spark.catalog.tableExists(financial_table):
    print(f"Table {financial_table} does not exist. Creating sample data...")
    # Create sample financial data for demo
    import random

    from pyspark.sql import Row

    sample_data = []
    for i in range(10000):
        sample_data.append(Row(
            transaction_id=f"TXN-{i:06d}",
            player_id=f"P{random.randint(10000, 99999)}",
            transaction_type=random.choice(["CASH_IN", "CASH_OUT", "MARKER", "MARKER_PAYMENT"]),
            amount=round(random.uniform(100, 15000), 2),
            transaction_timestamp=datetime.now() - timedelta(days=random.randint(0, 30), hours=random.randint(0, 23)),
            cage_location=random.choice(["Main Cage", "North Cage", "VIP Cage", "High Limit"]),
            cashier_id=f"CASHIER-{random.randint(1, 20)}",
            source_amount=0.0,
            destination_amount=0.0,
            ctr_required=False
        ))

    df_financial = spark.createDataFrame(sample_data)
else:
    df_financial = spark.table(financial_table)

print(f"Financial transactions: {df_financial.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Feature Engineering for Anomaly Detection

# COMMAND ----------

# Aggregate transactions by player and day
df_daily = df_financial \
    .withColumn("txn_date", to_date("transaction_timestamp")) \
    .withColumn("txn_hour", hour("transaction_timestamp")) \
    .groupBy("player_id", "txn_date") \
    .agg(
        # Transaction counts
        count("*").alias("transaction_count"),
        countDistinct("transaction_type").alias("unique_txn_types"),
        countDistinct("cage_location").alias("unique_cages"),
        countDistinct("cashier_id").alias("unique_cashiers"),

        # Amount aggregations
        sum("amount").alias("total_amount"),
        avg("amount").alias("avg_amount"),
        max("amount").alias("max_amount"),
        min("amount").alias("min_amount"),
        stddev("amount").alias("std_amount"),

        # Structuring detection features
        sum(when(col("amount").between(8000, 9999), 1).otherwise(0)).alias("near_ctr_count"),
        sum(when(col("amount") >= 10000, 1).otherwise(0)).alias("ctr_count"),

        # Time patterns
        countDistinct("txn_hour").alias("unique_hours"),
        min("txn_hour").alias("earliest_hour"),
        max("txn_hour").alias("latest_hour"),

        # Transaction types
        sum(when(col("transaction_type") == "CASH_IN", 1).otherwise(0)).alias("cash_in_count"),
        sum(when(col("transaction_type") == "CASH_OUT", 1).otherwise(0)).alias("cash_out_count"),
        sum(when(col("transaction_type") == "MARKER", 1).otherwise(0)).alias("marker_count")
    )

print(f"Player-day aggregations: {df_daily.count():,}")

# COMMAND ----------

# Add derived features
df_features = df_daily \
    .withColumn(
        # Time span of activity
        "hour_span",
        col("latest_hour") - col("earliest_hour")
    ) \
    .withColumn(
        # Cash-in to cash-out ratio
        "cash_flow_ratio",
        when(col("cash_out_count") > 0,
             col("cash_in_count") / col("cash_out_count"))
        .otherwise(col("cash_in_count"))
    ) \
    .withColumn(
        # Structuring risk score (multiple near-CTR transactions)
        "structuring_risk",
        when(col("near_ctr_count") >= 3, lit(100))
        .when(col("near_ctr_count") >= 2, lit(75))
        .when(col("near_ctr_count") >= 1, lit(25))
        .otherwise(lit(0))
    ) \
    .withColumn(
        # Amount variation (unusual if very low std for multiple transactions)
        "amount_variation",
        when(col("transaction_count") > 1,
             coalesce(col("std_amount") / col("avg_amount"), lit(0)))
        .otherwise(lit(1))
    )

# Fill nulls
df_features = df_features.na.fill(0)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Isolation Forest Anomaly Detection

# COMMAND ----------

# Select features for anomaly detection
anomaly_features = [
    "transaction_count",
    "total_amount",
    "avg_amount",
    "max_amount",
    "unique_cages",
    "unique_cashiers",
    "near_ctr_count",
    "unique_hours",
    "hour_span",
    "structuring_risk"
]

# Scalable approach: Use sampling for large datasets to avoid memory issues
# For production with 100K+ records, train on sample and batch-score full data
MAX_TRAINING_ROWS = 100000

total_rows = df_features.count()
print(f"Total aggregated rows: {total_rows:,}")

if total_rows > MAX_TRAINING_ROWS:
    # Sample for training (stratified by structuring_risk for better coverage)
    sample_fraction = MAX_TRAINING_ROWS / total_rows
    df_sample = df_features.sampleBy(
        "structuring_risk",
        fractions={0.0: sample_fraction, 25.0: min(1.0, sample_fraction * 2),
                   75.0: 1.0, 100.0: 1.0},  # Over-sample high-risk
        seed=42
    )
    print(f"Using stratified sample of {df_sample.count():,} rows for training")
    pdf_train = df_sample.select(["player_id", "txn_date"] + anomaly_features).toPandas()
else:
    pdf_train = df_features.select(["player_id", "txn_date"] + anomaly_features).toPandas()

# Prepare features
X_train = pdf_train[anomaly_features].fillna(0)

# Scale features
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X_train)

print(f"Training feature matrix shape: {X_scaled.shape}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Train Isolation Forest

# COMMAND ----------

# Set MLflow experiment
mlflow.set_experiment("/Shared/fraud_detection")

with mlflow.start_run(run_name="isolation_forest_fraud"):

    # Parameters
    contamination = 0.05  # Expected 5% anomalies
    n_estimators = 100
    random_state = 42

    mlflow.log_param("model_type", "IsolationForest")
    mlflow.log_param("contamination", contamination)
    mlflow.log_param("n_estimators", n_estimators)
    mlflow.log_param("features", anomaly_features)
    mlflow.log_param("training_rows", len(X_scaled))
    mlflow.log_param("total_rows", total_rows)

    # Train Isolation Forest
    iso_forest = IsolationForest(
        contamination=contamination,
        n_estimators=n_estimators,
        random_state=random_state,
        n_jobs=-1
    )

    # Fit model on training data
    iso_forest.fit(X_scaled)

    # Log model artifacts
    mlflow.sklearn.log_model(iso_forest, "fraud_detection_model")
    mlflow.sklearn.log_model(scaler, "feature_scaler")

    print(f"Model trained on {len(X_scaled):,} samples")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Batch Scoring (Scalable for Large Datasets)

# COMMAND ----------

# Define UDF for batch scoring using pandas_udf (vectorized for performance)
from pyspark.sql.functions import pandas_udf
from pyspark.sql.types import DoubleType, IntegerType

# Broadcast the scaler parameters and model for distributed scoring
scaler_mean = spark.sparkContext.broadcast(scaler.mean_)
scaler_scale = spark.sparkContext.broadcast(scaler.scale_)
model_broadcast = spark.sparkContext.broadcast(iso_forest)

@pandas_udf(DoubleType())
def score_anomaly(
    transaction_count: pd.Series, total_amount: pd.Series, avg_amount: pd.Series,
    max_amount: pd.Series, unique_cages: pd.Series, unique_cashiers: pd.Series,
    near_ctr_count: pd.Series, unique_hours: pd.Series, hour_span: pd.Series,
    structuring_risk: pd.Series
) -> pd.Series:
    """Vectorized anomaly scoring using Isolation Forest."""
    # Build feature matrix
    X = pd.DataFrame({
        'transaction_count': transaction_count,
        'total_amount': total_amount,
        'avg_amount': avg_amount,
        'max_amount': max_amount,
        'unique_cages': unique_cages,
        'unique_cashiers': unique_cashiers,
        'near_ctr_count': near_ctr_count,
        'unique_hours': unique_hours,
        'hour_span': hour_span,
        'structuring_risk': structuring_risk
    }).fillna(0)

    # Scale features using broadcast parameters
    X_scaled = (X - scaler_mean.value) / scaler_scale.value

    # Score using broadcast model (negative decision function = higher anomaly)
    scores = -model_broadcast.value.decision_function(X_scaled)
    return pd.Series(scores)

# Apply scoring to full dataset using Spark (no full DataFrame to Pandas conversion)
df_scored = df_features.withColumn(
    "anomaly_score",
    score_anomaly(
        col("transaction_count"), col("total_amount"), col("avg_amount"),
        col("max_amount"), col("unique_cages"), col("unique_cashiers"),
        col("near_ctr_count"), col("unique_hours"), col("hour_span"),
        col("structuring_risk")
    )
)

# Determine anomaly threshold from training data
threshold = np.percentile(-iso_forest.decision_function(X_scaled), (1 - contamination) * 100)

df_scored = df_scored.withColumn(
    "is_anomaly",
    when(col("anomaly_score") > threshold, 1).otherwise(0)
)

# Cache for downstream operations
df_scored.cache()
scored_count = df_scored.count()
anomaly_count = df_scored.filter(col("is_anomaly") == 1).count()
anomaly_pct = anomaly_count / scored_count * 100

print(f"Scored {scored_count:,} records")
print(f"Anomalies detected: {anomaly_count:,} ({anomaly_pct:.2f}%)")

# Log final metrics to MLflow
with mlflow.start_run(run_name="isolation_forest_fraud", nested=True):
    mlflow.log_metric("total_scored", scored_count)
    mlflow.log_metric("final_anomaly_count", anomaly_count)
    mlflow.log_metric("final_anomaly_percentage", anomaly_pct)

# Convert scored Spark DataFrame to pandas for analysis (only anomalies + sample)
pdf = df_scored.filter(
    (col("is_anomaly") == 1) | (rand() < 0.1)  # All anomalies + 10% sample of normal
).toPandas()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Analyze Anomalies

# COMMAND ----------

# Get anomalous records from sampled pdf
anomalies = pdf[pdf["is_anomaly"] == 1].copy()
anomalies = anomalies.sort_values("anomaly_score", ascending=False)

print(f"\nTop 20 Most Anomalous Player-Days:")
display(anomalies.head(20))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Structuring Detection Analysis

# COMMAND ----------

# Focus on potential structuring patterns
structuring_suspects = anomalies[anomalies["near_ctr_count"] >= 2]

print(f"\nPotential Structuring Cases (2+ near-CTR transactions):")
print(f"Total suspicious player-days: {len(structuring_suspects)}")

if len(structuring_suspects) > 0:
    display(structuring_suspects[[
        "player_id", "txn_date", "transaction_count", "total_amount",
        "near_ctr_count", "unique_cages", "anomaly_score"
    ]].head(20))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Anomaly Categorization

# COMMAND ----------

# Categorize anomalies
def categorize_anomaly(row):
    categories = []

    if row["near_ctr_count"] >= 2:
        categories.append("POTENTIAL_STRUCTURING")
    if row["total_amount"] > 50000:
        categories.append("HIGH_VOLUME")
    if row["unique_cages"] >= 3:
        categories.append("MULTIPLE_CAGES")
    if row["unique_cashiers"] >= 4:
        categories.append("MULTIPLE_CASHIERS")
    if row["hour_span"] >= 16:
        categories.append("EXTENDED_ACTIVITY")
    if row["transaction_count"] > 20:
        categories.append("HIGH_FREQUENCY")

    return categories if categories else ["STATISTICAL_OUTLIER"]

anomalies["anomaly_categories"] = anomalies.apply(categorize_anomaly, axis=1)

# Category distribution
all_categories = [cat for cats in anomalies["anomaly_categories"] for cat in cats]
category_counts = pd.Series(all_categories).value_counts()

print("\nAnomaly Category Distribution:")
print(category_counts)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results to Gold Layer

# COMMAND ----------

# Use the full scored Spark DataFrame (not pandas subset) for complete results
df_results = df_scored \
    .withColumn("_analysis_timestamp", current_timestamp()) \
    .withColumn("_model_version", lit("isolation_forest_v1"))

# Save to Gold (full dataset with scores)
df_results.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable("lh_gold.ml_fraud_detection_scores")

_fraud_count = spark.table("lh_gold.ml_fraud_detection_scores").count()
print(f"Saved {_fraud_count:,} records to Gold layer")

# COMMAND ----------

# MAGIC %md
# MAGIC ## High-Priority Alerts

# COMMAND ----------

# Generate alerts for immediate review
high_priority_alerts = df_results.filter(
    (col("is_anomaly") == 1) &
    (
        (col("near_ctr_count") >= 2) |  # Potential structuring
        (col("total_amount") > 50000) |  # Large volume
        (col("anomaly_score") > df_results.agg({"anomaly_score": "max"}).first()[0] * 0.8)  # Top anomalies
    )
).select(
    "player_id",
    "txn_date",
    "transaction_count",
    "total_amount",
    "near_ctr_count",
    "unique_cages",
    "anomaly_score"
).orderBy(col("anomaly_score").desc())

print("HIGH PRIORITY ALERTS - Require Immediate Review:")
high_priority_alerts.show(20)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary Statistics

# COMMAND ----------

# Summary by anomaly status
summary = df_results.groupBy("is_anomaly").agg(
    count("*").alias("count"),
    round(avg("total_amount"), 2).alias("avg_total_amount"),
    round(avg("transaction_count"), 2).alias("avg_txn_count"),
    round(avg("near_ctr_count"), 2).alias("avg_near_ctr"),
    round(avg("anomaly_score"), 4).alias("avg_anomaly_score")
)

print("\nSummary by Anomaly Status:")
summary.show()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Production Deployment Notes
# MAGIC
# MAGIC For production use:
# MAGIC
# MAGIC 1. **Schedule daily runs** to score new transactions
# MAGIC 2. **Integrate with SIEM** for alert escalation
# MAGIC 3. **Add feedback loop** for analyst-confirmed fraud cases
# MAGIC 4. **Retrain model** quarterly with labeled data
# MAGIC 5. **Monitor model drift** using PSI/KS tests
# MAGIC 6. **Comply with** BSA/AML reporting requirements
