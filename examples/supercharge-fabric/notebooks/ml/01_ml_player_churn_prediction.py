# Databricks notebook source
# MAGIC %md
# MAGIC # ML: Player Churn Prediction Model
# MAGIC
# MAGIC This notebook builds a machine learning model to predict player churn risk
# MAGIC using the Gold layer player 360 data.
# MAGIC
# MAGIC ## Model Approach:
# MAGIC - Binary classification (churned vs active)
# MAGIC - Gradient Boosted Trees classifier
# MAGIC - MLflow experiment tracking
# MAGIC - Feature importance analysis

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup

# COMMAND ----------

from datetime import datetime

# MLflow
import mlflow
import mlflow.spark
import numpy as np
import pandas as pd
from pyspark.ml import Pipeline
from pyspark.ml.classification import GBTClassifier, RandomForestClassifier
from pyspark.ml.evaluation import (
    BinaryClassificationEvaluator,
    MulticlassClassificationEvaluator,
)
from pyspark.ml.feature import StandardScaler, StringIndexer, VectorAssembler
from pyspark.ml.tuning import CrossValidator, ParamGridBuilder

# PySpark ML
from pyspark.sql.functions import (
    avg,
    coalesce,
    col,
    count,
    desc,
    filter,
    lit,
    round,
    transform,
    when,
)

# Source table
source_table = "lh_gold.gold_player_360"

print(f"MLflow tracking URI: {mlflow.get_tracking_uri()}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Load and Prepare Data

# COMMAND ----------

# Read Gold player data
df = spark.table(source_table)

print(f"Total players: {df.count():,}")
df.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Churn Label

# COMMAND ----------

# Define churn: No visit in 90+ days
CHURN_THRESHOLD_DAYS = 90

df_ml = df.withColumn(
    "churned",
    when(col("days_since_visit") > CHURN_THRESHOLD_DAYS, 1).otherwise(0)
)

# Check class distribution
df_ml.groupBy("churned").count().show()

churn_rate = df_ml.filter(col("churned") == 1).count() / df_ml.count() * 100
print(f"Churn rate: {churn_rate:.2f}%")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Feature Selection

# COMMAND ----------

# Numeric features
numeric_features = [
    "slot_coin_in",
    "slot_coin_out",
    "slot_games_played",
    "slot_machines_played",
    "slot_visit_days",
    "slot_theo_win",
    "table_buy_in",
    "table_cash_out",
    "table_hours_played",
    "total_transactions",
    "total_cash_in",
    "total_markers",
    "total_gaming_activity",
    "total_theo_win",
    "total_visits",
    "player_value_score",
    "account_age_days"
]

# Categorical features
categorical_features = [
    "loyalty_tier",
    "preferred_game_type"
]

# Fill nulls with 0 for numeric features
for col_name in numeric_features:
    df_ml = df_ml.withColumn(col_name, coalesce(col(col_name), lit(0)))

# Fill nulls for categorical
for col_name in categorical_features:
    df_ml = df_ml.withColumn(col_name, coalesce(col(col_name), lit("Unknown")))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Encode Categorical Features

# COMMAND ----------

# String indexers for categorical columns
indexers = []
indexed_cols = []

for cat_col in categorical_features:
    indexer = StringIndexer(
        inputCol=cat_col,
        outputCol=f"{cat_col}_idx",
        handleInvalid="keep"
    )
    indexers.append(indexer)
    indexed_cols.append(f"{cat_col}_idx")

# Apply indexers
pipeline_prep = Pipeline(stages=indexers)
df_indexed = pipeline_prep.fit(df_ml).transform(df_ml)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Create Feature Vector

# COMMAND ----------

# All feature columns
feature_columns = numeric_features + indexed_cols

# Vector assembler
assembler = VectorAssembler(
    inputCols=feature_columns,
    outputCol="features_raw",
    handleInvalid="keep"
)

# Standard scaler
scaler = StandardScaler(
    inputCol="features_raw",
    outputCol="features",
    withStd=True,
    withMean=True
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Train/Test Split

# COMMAND ----------

# Stratified split
train_df, test_df = df_indexed.randomSplit([0.8, 0.2], seed=42)

print(f"Training records: {train_df.count():,}")
print(f"Testing records: {test_df.count():,}")

# Check class balance in splits
print("\nTraining class distribution:")
train_df.groupBy("churned").count().show()

print("Testing class distribution:")
test_df.groupBy("churned").count().show()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Model Training with MLflow

# COMMAND ----------

# Set experiment
mlflow.set_experiment("/Shared/player_churn_prediction")

# COMMAND ----------

# Train Gradient Boosted Trees
with mlflow.start_run(run_name="gbt_baseline") as run:

    # Log parameters
    max_iter = 50
    max_depth = 5

    mlflow.log_param("model_type", "GBTClassifier")
    mlflow.log_param("max_iter", max_iter)
    mlflow.log_param("max_depth", max_depth)
    mlflow.log_param("churn_threshold_days", CHURN_THRESHOLD_DAYS)
    mlflow.log_param("features", feature_columns)

    # Create classifier
    gbt = GBTClassifier(
        labelCol="churned",
        featuresCol="features",
        maxIter=max_iter,
        maxDepth=max_depth,
        seed=42
    )

    # Full pipeline
    pipeline = Pipeline(stages=[assembler, scaler, gbt])

    # Train model
    print("Training model...")
    model = pipeline.fit(train_df)

    # Predict on test set
    predictions = model.transform(test_df)

    # Evaluate
    evaluator_auc = BinaryClassificationEvaluator(
        labelCol="churned",
        rawPredictionCol="rawPrediction",
        metricName="areaUnderROC"
    )

    evaluator_acc = MulticlassClassificationEvaluator(
        labelCol="churned",
        predictionCol="prediction",
        metricName="accuracy"
    )

    evaluator_precision = MulticlassClassificationEvaluator(
        labelCol="churned",
        predictionCol="prediction",
        metricName="weightedPrecision"
    )

    evaluator_recall = MulticlassClassificationEvaluator(
        labelCol="churned",
        predictionCol="prediction",
        metricName="weightedRecall"
    )

    auc = evaluator_auc.evaluate(predictions)
    accuracy = evaluator_acc.evaluate(predictions)
    precision = evaluator_precision.evaluate(predictions)
    recall = evaluator_recall.evaluate(predictions)

    # Log metrics
    mlflow.log_metric("auc_roc", auc)
    mlflow.log_metric("accuracy", accuracy)
    mlflow.log_metric("precision", precision)
    mlflow.log_metric("recall", recall)

    # Log model
    mlflow.spark.log_model(model, "churn_model")

    print(f"\nModel Performance:")
    print(f"  AUC-ROC: {auc:.4f}")
    print(f"  Accuracy: {accuracy:.4f}")
    print(f"  Precision: {precision:.4f}")
    print(f"  Recall: {recall:.4f}")

    run_id = run.info.run_id
    print(f"\nMLflow Run ID: {run_id}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Feature Importance

# COMMAND ----------

# Get feature importance from GBT model
gbt_model = model.stages[-1]
importances = gbt_model.featureImportances.toArray()

# Create importance dataframe
importance_df = pd.DataFrame({
    "feature": feature_columns,
    "importance": importances
}).sort_values("importance", ascending=False)

print("\nFeature Importance:")
print(importance_df.to_string(index=False))

# COMMAND ----------

# Visualize feature importance
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(10, 8))
importance_df.head(15).plot.barh(x="feature", y="importance", ax=ax)
ax.set_xlabel("Importance")
ax.set_title("Top 15 Feature Importances - Churn Prediction")
plt.tight_layout()
display(fig)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Confusion Matrix

# COMMAND ----------

# Confusion matrix
predictions.groupBy("churned", "prediction").count().show()

# Calculate metrics
tp = predictions.filter((col("churned") == 1) & (col("prediction") == 1)).count()
tn = predictions.filter((col("churned") == 0) & (col("prediction") == 0)).count()
fp = predictions.filter((col("churned") == 0) & (col("prediction") == 1)).count()
fn = predictions.filter((col("churned") == 1) & (col("prediction") == 0)).count()

print(f"\nConfusion Matrix:")
print(f"  True Positives: {tp}")
print(f"  True Negatives: {tn}")
print(f"  False Positives: {fp}")
print(f"  False Negatives: {fn}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Register Model

# COMMAND ----------

# Register model in MLflow registry
from mlflow.tracking import MlflowClient

client = MlflowClient()

model_uri = f"runs:/{run_id}/churn_model"
model_name = "PlayerChurnModel"

# Register model
model_details = mlflow.register_model(model_uri, model_name)

print(f"Model registered: {model_details.name}")
print(f"Version: {model_details.version}")

# COMMAND ----------

# Transition to Production (optional)
# client.transition_model_version_stage(
#     name=model_name,
#     version=model_details.version,
#     stage="Production"
# )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Batch Scoring

# COMMAND ----------

# Score all current players
df_current = spark.table(source_table)

# Prepare features (same preprocessing)
for col_name in numeric_features:
    df_current = df_current.withColumn(col_name, coalesce(col(col_name), lit(0)))
for col_name in categorical_features:
    df_current = df_current.withColumn(col_name, coalesce(col(col_name), lit("Unknown")))

# Apply indexers
df_current_indexed = pipeline_prep.fit(df_ml).transform(df_current)

# Make predictions
predictions_all = model.transform(df_current_indexed)

# Select relevant columns
scored_players = predictions_all.select(
    "player_id",
    "loyalty_tier",
    "player_value_score",
    "days_since_visit",
    col("probability").getItem(1).alias("churn_probability"),
    col("prediction").alias("churn_prediction")
)

scored_players.show(10)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Scores to Gold Layer

# COMMAND ----------

# Save predictions
scored_players.write \
    .format("delta") \
    .mode("overwrite") \
    .saveAsTable("lh_gold.ml_player_churn_scores")

_scored_count = spark.table("lh_gold.ml_player_churn_scores").count()
print(f"Scored {_scored_count:,} players")

# COMMAND ----------

# MAGIC %md
# MAGIC ## High-Risk VIP Players

# COMMAND ----------

# Identify high-risk VIP players for intervention
high_risk_vip = scored_players.filter(
    (col("churn_probability") > 0.7) &
    (col("player_value_score") > 100)
).orderBy(col("churn_probability").desc())

print("High-Risk VIP Players Requiring Intervention:")
high_risk_vip.show(20)

# COMMAND ----------

# Summary of churn predictions
scored_players.groupBy(
    when(col("churn_probability") > 0.7, "High Risk")
    .when(col("churn_probability") > 0.4, "Medium Risk")
    .otherwise("Low Risk").alias("risk_category")
).agg(
    count("*").alias("player_count"),
    round(avg("player_value_score"), 2).alias("avg_value_score")
).orderBy("risk_category").show()
