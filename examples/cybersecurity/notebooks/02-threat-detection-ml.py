# -*- coding: utf-8 -*-
# Databricks notebook source
# MAGIC %md
# MAGIC # 02 — Threat Detection with Machine Learning
# MAGIC
# MAGIC Anomaly detection and alert prioritization using Silver-layer data:
# MAGIC - Feature engineering from security alerts
# MAGIC - Isolation Forest anomaly detection
# MAGIC - Alert scoring and prioritization model
# MAGIC - Evaluation metrics

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup

# COMMAND ----------

import numpy as np
import pandas as pd
from pyspark.sql import functions as F
from pyspark.sql.window import Window
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import LabelEncoder, StandardScaler
from sklearn.metrics import classification_report, precision_recall_curve
import warnings
warnings.filterwarnings("ignore")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Load Silver Alert Data

# COMMAND ----------

# Load enriched alerts from Silver layer (or simulate from sample)
SILVER_TABLE = "cybersecurity_silver.fct_security_alerts"

try:
    df_silver = spark.table(SILVER_TABLE)
    print(f"Loaded {df_silver.count()} enriched alerts from Silver")
except Exception:
    # Fallback: load sample and simulate Silver enrichment
    df_raw = spark.read.option("multiline", "true").json(
        "/Workspace/examples/cybersecurity/data/sample-sentinel-alerts.json"
    )
    df_silver = (
        df_raw
        .withColumn("time_generated", F.to_timestamp("TimeGenerated"))
        .withColumn("severity_level", F.when(F.col("Severity") == "Critical", 4)
                    .when(F.col("Severity") == "High", 3)
                    .when(F.col("Severity") == "Medium", 2)
                    .otherwise(1))
        .withColumn("technique_id", F.explode_outer("Techniques"))
        .withColumn("tactic_name", F.explode_outer("Tactics"))
    )
    print(f"Loaded {df_silver.count()} simulated Silver alerts")

display(df_silver.limit(5))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Feature Engineering
# MAGIC
# MAGIC Build features that capture alert behavior patterns:
# MAGIC - Temporal: hour of day, day of week, time since last alert
# MAGIC - Frequency: alerts per host, alerts per account, alerts per technique
# MAGIC - Severity: numeric severity, MITRE weight
# MAGIC - Entity: number of entities involved

# COMMAND ----------

# Convert to Pandas for ML processing
pdf = df_silver.toPandas()

# Temporal features
pdf["hour_of_day"] = pd.to_datetime(pdf["time_generated"]).dt.hour
pdf["day_of_week"] = pd.to_datetime(pdf["time_generated"]).dt.dayofweek
pdf["is_business_hours"] = pdf["hour_of_day"].between(8, 17).astype(int)
pdf["is_weekend"] = (pdf["day_of_week"] >= 5).astype(int)

# Frequency features (per entity)
provider_counts = pdf["ProviderName"].value_counts().to_dict()
pdf["provider_frequency"] = pdf["ProviderName"].map(provider_counts)

if "technique_id" in pdf.columns:
    technique_counts = pdf["technique_id"].value_counts().to_dict()
    pdf["technique_frequency"] = pdf["technique_id"].map(technique_counts).fillna(0)
else:
    pdf["technique_frequency"] = 0

# Severity as numeric
if "severity_level" not in pdf.columns:
    severity_map = {"Critical": 4, "High": 3, "Medium": 2, "Low": 1}
    pdf["severity_level"] = pdf["Severity"].map(severity_map).fillna(0)

pdf["severity_level"] = pd.to_numeric(pdf["severity_level"], errors="coerce").fillna(0)

print(f"Feature matrix shape: {pdf.shape}")
pdf[["AlertName", "hour_of_day", "day_of_week", "is_business_hours",
     "severity_level", "provider_frequency", "technique_frequency"]].head(10)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Anomaly Detection — Isolation Forest
# MAGIC
# MAGIC Isolation Forest identifies anomalous alerts based on feature patterns.
# MAGIC Alerts that are structurally different from the majority are flagged.

# COMMAND ----------

# Select features for the model
feature_cols = [
    "hour_of_day",
    "day_of_week",
    "is_business_hours",
    "is_weekend",
    "severity_level",
    "provider_frequency",
    "technique_frequency",
]

X = pdf[feature_cols].fillna(0).values

# Standardize features
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X)

# Train Isolation Forest
iso_forest = IsolationForest(
    n_estimators=100,
    contamination=0.15,     # expect ~15% anomalies
    max_samples="auto",
    random_state=42,
    n_jobs=-1,
)

pdf["anomaly_label"] = iso_forest.fit_predict(X_scaled)  # -1 = anomaly, 1 = normal
pdf["anomaly_score"] = iso_forest.decision_function(X_scaled)  # lower = more anomalous

anomaly_count = (pdf["anomaly_label"] == -1).sum()
print(f"Anomalies detected: {anomaly_count} / {len(pdf)} ({anomaly_count/len(pdf)*100:.1f}%)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Alert Scoring & Prioritization
# MAGIC
# MAGIC Combine anomaly score with severity and MITRE weight for a composite priority.

# COMMAND ----------

# Normalize anomaly score to 0-1 range (invert so higher = more anomalous)
min_score = pdf["anomaly_score"].min()
max_score = pdf["anomaly_score"].max()
pdf["anomaly_normalized"] = 1 - (pdf["anomaly_score"] - min_score) / (max_score - min_score)

# Composite priority score
pdf["priority_score"] = (
    0.4 * (pdf["severity_level"] / 4.0) +
    0.35 * pdf["anomaly_normalized"] +
    0.25 * (pdf["technique_frequency"] / pdf["technique_frequency"].max()).fillna(0)
)

# Rank alerts
pdf_ranked = pdf.sort_values("priority_score", ascending=False)

print("=== Top 10 Priority Alerts ===")
display_cols = ["AlertId", "AlertName", "Severity", "anomaly_label",
                "anomaly_normalized", "priority_score"]
existing_cols = [c for c in display_cols if c in pdf_ranked.columns]
print(pdf_ranked[existing_cols].head(10).to_string(index=False))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Model Evaluation
# MAGIC
# MAGIC Evaluate the anomaly detection model's performance.

# COMMAND ----------

# Distribution of anomaly scores by severity
print("=== Anomaly Score Statistics by Severity ===")
if "Severity" in pdf.columns:
    severity_col = "Severity"
elif "severity_label" in pdf.columns:
    severity_col = "severity_label"
else:
    severity_col = "severity_level"

stats = pdf.groupby(severity_col).agg(
    count=("anomaly_score", "count"),
    mean_score=("anomaly_normalized", "mean"),
    anomaly_rate=("anomaly_label", lambda x: (x == -1).mean()),
    avg_priority=("priority_score", "mean"),
).round(3)
print(stats.to_string())

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Scored Alerts to Gold Layer

# COMMAND ----------

# Convert back to Spark DataFrame and write
output_cols = ["AlertId", "AlertName", "severity_level", "anomaly_label",
               "anomaly_normalized", "priority_score", "hour_of_day", "is_business_hours"]
existing_output = [c for c in output_cols if c in pdf_ranked.columns]

df_scored = spark.createDataFrame(pdf_ranked[existing_output])

GOLD_TABLE = "cybersecurity_gold.scored_alerts"
try:
    df_scored.write.mode("overwrite").saveAsTable(GOLD_TABLE)
    print(f"Saved {df_scored.count()} scored alerts to {GOLD_TABLE}")
except Exception as e:
    print(f"Could not write to Gold table (expected in dev): {e}")
    display(df_scored)
