# Databricks notebook source
# MAGIC %md
# MAGIC # ML Pipeline Template — CSA-in-a-Box
# MAGIC
# MAGIC Template notebook for building ML pipelines using MLflow on Databricks.
# MAGIC Demonstrates: feature engineering, model training, experiment tracking, model registry.
# MAGIC
# MAGIC ## Usage
# MAGIC Copy this template and customize for your use case.

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup

# COMMAND ----------

# MAGIC %pip install scikit-learn mlflow

# COMMAND ----------

from datetime import datetime

import mlflow
import mlflow.sklearn
import pandas as pd
from mlflow.models.signature import infer_signature
from pyspark.sql import functions as F
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

dbutils.widgets.text("catalog", "csa_analytics", "Unity Catalog")
dbutils.widgets.text("experiment_name", "/Shared/csa-inabox/ml/customer_churn", "MLflow Experiment")
dbutils.widgets.text("model_name", "customer_churn_model", "Model Registry Name")
dbutils.widgets.dropdown("register_model", "false", ["true", "false"], "Register Model")
dbutils.widgets.dropdown(
    "promote_to_production", "false", ["true", "false"], "Promote to Production (requires thresholds)"
)
dbutils.widgets.text("min_auc_for_prod", "0.80", "Min ROC-AUC for Production promotion")
dbutils.widgets.text("min_f1_for_prod", "0.65", "Min F1 for Production promotion")

CATALOG = dbutils.widgets.get("catalog")
EXPERIMENT_NAME = dbutils.widgets.get("experiment_name")
MODEL_NAME = dbutils.widgets.get("model_name")
REGISTER_MODEL = dbutils.widgets.get("register_model") == "true"
PROMOTE_TO_PRODUCTION = dbutils.widgets.get("promote_to_production") == "true"
MIN_AUC_FOR_PROD = float(dbutils.widgets.get("min_auc_for_prod"))
MIN_F1_FOR_PROD = float(dbutils.widgets.get("min_f1_for_prod"))

mlflow.set_experiment(EXPERIMENT_NAME)
print(f"Experiment: {EXPERIMENT_NAME}")
print(f"Model name: {MODEL_NAME}")
print(f"Production gate: AUC >= {MIN_AUC_FOR_PROD}, F1 >= {MIN_F1_FOR_PROD}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Feature Engineering

# COMMAND ----------


def build_features(catalog: str) -> pd.DataFrame:
    """Build feature set from gold layer tables.

    Combines customer lifetime value with behavioral features
    for churn prediction.
    """
    # Read from gold layer
    clv_df = spark.table(f"{catalog}.gold.gld_customer_lifetime_value")

    # Build features
    features_df = clv_df.select(
        "customer_id",
        "total_orders",
        "lifetime_revenue",
        "avg_order_value",
        "active_months",
        "completed_orders",
        "cancelled_orders",
        "returned_orders",
        "monthly_revenue_rate",
        "customer_segment",
        "value_tier",
        # Target: is the customer churned?
        F.when(F.col("customer_segment") == "churned", 1).otherwise(0).alias("is_churned"),
    )

    # Convert to pandas for sklearn
    pdf = features_df.toPandas()

    # Encode categorical features
    for col in ["value_tier"]:
        le = LabelEncoder()
        pdf[f"{col}_encoded"] = le.fit_transform(pdf[col].fillna("unknown"))

    return pdf


# Build features.  Per Archon task b210c0cf the synthetic-data fallback
# has been removed — the previous version caught every exception and
# generated 1000 rows of fake data, which silently masked real data
# pipeline failures.  Now we fail loudly so the operator knows the
# upstream Silver/Gold data needs attention.
features_pdf = build_features(CATALOG)
print(f"Feature set: {features_pdf.shape[0]} rows, {features_pdf.shape[1]} columns")
if features_pdf.empty:
    raise RuntimeError(
        f"Feature set is empty — {CATALOG}.gold.gld_customer_lifetime_value "
        "returned zero rows.  Investigate the Silver/Gold pipeline before "
        "training.  Synthetic fallback has been removed intentionally.",
    )
print(f"Churn rate: {features_pdf['is_churned'].mean():.2%}")
display(features_pdf.describe())

# COMMAND ----------

# MAGIC %md
# MAGIC ## Model Training

# COMMAND ----------

# Feature columns (exclude IDs and target)
FEATURE_COLS = [
    "total_orders",
    "lifetime_revenue",
    "avg_order_value",
    "active_months",
    "completed_orders",
    "cancelled_orders",
    "returned_orders",
    "monthly_revenue_rate",
    "value_tier_encoded",
]
TARGET_COL = "is_churned"

X = features_pdf[FEATURE_COLS].fillna(0)
y = features_pdf[TARGET_COL]

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

print(f"Train set: {X_train.shape[0]} rows")
print(f"Test set:  {X_test.shape[0]} rows")

# COMMAND ----------

# MAGIC %md
# MAGIC ## MLflow Experiment

# COMMAND ----------

with mlflow.start_run(run_name=f"churn_model_{datetime.utcnow().strftime('%Y%m%d_%H%M')}") as run:
    # Hyperparameters
    params = {
        "n_estimators": 200,
        "max_depth": 5,
        "learning_rate": 0.1,
        "min_samples_split": 10,
        "min_samples_leaf": 5,
        "subsample": 0.8,
        "random_state": 42,
    }
    mlflow.log_params(params)

    # Train model
    model = GradientBoostingClassifier(**params)
    model.fit(X_train, y_train)

    # Predictions
    y_pred = model.predict(X_test)
    y_proba = model.predict_proba(X_test)[:, 1]

    # Metrics
    metrics = {
        "accuracy": accuracy_score(y_test, y_pred),
        "precision": precision_score(y_test, y_pred),
        "recall": recall_score(y_test, y_pred),
        "f1": f1_score(y_test, y_pred),
        "roc_auc": roc_auc_score(y_test, y_proba),
    }
    mlflow.log_metrics(metrics)

    # Log model with signature
    signature = infer_signature(X_train, y_pred)
    mlflow.sklearn.log_model(
        model,
        "model",
        signature=signature,
        input_example=X_train.iloc[:3],
    )

    # Feature importance
    importance = pd.DataFrame(
        {
            "feature": FEATURE_COLS,
            "importance": model.feature_importances_,
        }
    ).sort_values("importance", ascending=False)
    mlflow.log_table(importance, "feature_importance.json")

    # Log classification report
    report = classification_report(y_test, y_pred)
    mlflow.log_text(report, "classification_report.txt")

    print(f"\nRun ID: {run.info.run_id}")
    print("\nMetrics:")
    for k, v in metrics.items():
        print(f"  {k}: {v:.4f}")
    print("\nFeature Importance:")
    print(importance.to_string(index=False))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Register Model (Optional)

# COMMAND ----------

if REGISTER_MODEL:
    model_uri = f"runs:/{run.info.run_id}/model"

    # Register in Unity Catalog model registry.  All new versions land
    # in the ``Staging`` alias first — never directly in Production.
    # This is the approval gate promised by Archon task b210c0cf.
    registered_model = mlflow.register_model(
        model_uri=model_uri,
        name=f"{CATALOG}.gold.{MODEL_NAME}",
    )
    print(f"Model registered: {registered_model.name} v{registered_model.version}")

    client = mlflow.tracking.MlflowClient()

    # Always tag the run metadata so promotions are auditable.
    client.set_model_version_tag(
        name=registered_model.name,
        version=registered_model.version,
        key="environment",
        value="staging",
    )
    client.set_model_version_tag(
        name=registered_model.name,
        version=registered_model.version,
        key="platform",
        value="csa-inabox",
    )
    # Record the metrics that will be checked by the promotion gate
    # so the ``Staging`` -> ``Production`` decision is traceable even
    # when the reviewer runs it days later from a different cluster.
    for metric_name, metric_value in metrics.items():
        client.set_model_version_tag(
            name=registered_model.name,
            version=registered_model.version,
            key=f"metric_{metric_name}",
            value=f"{metric_value:.6f}",
        )

    # Use an alias for Staging (UC model registry uses aliases, not
    # stages; the old ``transition_model_version_stage`` API is
    # deprecated for UC models).
    client.set_registered_model_alias(
        name=registered_model.name,
        alias="Staging",
        version=registered_model.version,
    )
    print("Model registered under alias 'Staging'")

    # ---------------------------------------------------------------
    # Production promotion gate (Archon task b210c0cf)
    # ---------------------------------------------------------------
    # Promotion requires BOTH:
    #   1. The operator explicitly passing promote_to_production=true
    #      (human review step)
    #   2. Metrics clearing the configured thresholds
    # If either is missing, the model stays in Staging and the
    # notebook prints what the reviewer needs to see to unblock the
    # promotion.  The configured thresholds default to production-
    # grade values (AUC >= 0.80, F1 >= 0.65) and can be overridden
    # per-run via the widgets above.
    # ---------------------------------------------------------------
    gate_failures: list[str] = []
    if metrics["roc_auc"] < MIN_AUC_FOR_PROD:
        gate_failures.append(f"roc_auc={metrics['roc_auc']:.4f} < {MIN_AUC_FOR_PROD}")
    if metrics["f1"] < MIN_F1_FOR_PROD:
        gate_failures.append(f"f1={metrics['f1']:.4f} < {MIN_F1_FOR_PROD}")

    if PROMOTE_TO_PRODUCTION and not gate_failures:
        client.set_registered_model_alias(
            name=registered_model.name,
            alias="Production",
            version=registered_model.version,
        )
        client.set_model_version_tag(
            name=registered_model.name,
            version=registered_model.version,
            key="environment",
            value="production",
        )
        client.set_model_version_tag(
            name=registered_model.name,
            version=registered_model.version,
            key="promoted_at",
            value=datetime.utcnow().isoformat(),
        )
        print(
            f"[PROMOTED] {registered_model.name} v{registered_model.version} "
            f"-> alias 'Production' (AUC={metrics['roc_auc']:.4f}, "
            f"F1={metrics['f1']:.4f})",
        )
    elif PROMOTE_TO_PRODUCTION and gate_failures:
        raise RuntimeError(
            f"Production promotion blocked — thresholds not met: "
            f"{'; '.join(gate_failures)}. Retrain with better features, "
            f"lower the gate via --min_auc_for_prod / --min_f1_for_prod "
            "with an explicit justification, or leave the model in "
            "Staging for another iteration.",
        )
    else:
        print(
            f"Model left in Staging. To promote: re-run with "
            f"promote_to_production=true (gate: AUC >= {MIN_AUC_FOR_PROD}, "
            f"F1 >= {MIN_F1_FOR_PROD}).",
        )
else:
    print("Model registration skipped. Set register_model=true to register.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print(f"""
{"=" * 60}
ML Pipeline Complete
{"=" * 60}

Experiment: {EXPERIMENT_NAME}
Run ID:     {run.info.run_id}
Model:      GradientBoostingClassifier
AUC:        {metrics["roc_auc"]:.4f}
F1:         {metrics["f1"]:.4f}

Top Features:
{importance.head(5).to_string(index=False)}

Next Steps:
1. Review experiment in MLflow UI
2. Compare with previous runs
3. If satisfied, register model (set register_model=true)
4. Transition to production stage
5. Set up model monitoring
""")
