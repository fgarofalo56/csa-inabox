# SAS Model Migration: SAS Model Manager to Azure ML

**Audience:** Data Scientists, MLOps Engineers, Model Risk Managers
**Purpose:** Migrate SAS predictive models, SAS Model Manager workflows, and SAS scoring services to Azure ML, MLflow, and managed endpoints.

---

## 1. Overview

SAS Model Manager provides model governance capabilities: a model repository, champion/challenger comparison, performance monitoring, and scoring deployment. The Azure equivalent is the combination of **MLflow** (experiment tracking, model registry) and **Azure ML** (managed compute, endpoints, monitoring).

| SAS Model Manager concept    | Azure equivalent                                 | Notes                                                              |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| Model Repository             | MLflow Model Registry                            | Version-controlled model storage with staging/production lifecycle |
| Model Project                | MLflow Experiment                                | Group of related training runs                                     |
| Champion Model               | MLflow Production stage                          | Model tagged as production-ready                                   |
| Challenger Model             | MLflow Staging stage                             | Candidate model under evaluation                                   |
| Model Performance Monitoring | Azure ML data drift + model monitoring           | Automated drift detection and alerting                             |
| Scoring (batch)              | Azure ML batch endpoints                         | Batch inference on managed compute                                 |
| Scoring (real-time)          | Azure ML managed online endpoints                | REST API with auto-scaling                                         |
| SAS PMML export              | MLflow model format / ONNX                       | Portable model serialization                                       |
| Model Report Card            | MLflow model metadata + Responsible AI dashboard | Model documentation and fairness analysis                          |

---

## 2. Model export strategies

### 2.1 Strategy selection

| SAS model type                 | Export method                      | Azure target                   | Recommended approach                               |
| ------------------------------ | ---------------------------------- | ------------------------------ | -------------------------------------------------- |
| PROC LOGISTIC                  | Re-implement in Python             | statsmodels/sklearn            | Re-implement (better diagnostics, MLflow tracking) |
| PROC REG                       | Re-implement in Python             | statsmodels/sklearn            | Re-implement                                       |
| PROC HPFOREST (Random Forest)  | Re-implement in Python             | sklearn RandomForestClassifier | Re-implement                                       |
| PROC HPNEURAL (Neural Network) | Re-implement in PyTorch/TensorFlow | Azure ML                       | Re-implement (modern frameworks far superior)      |
| PROC HPCLUS (Clustering)       | Re-implement in Python             | sklearn KMeans/DBSCAN          | Re-implement                                       |
| SAS Enterprise Miner model     | PMML export then ONNX conversion   | Azure ML                       | Export if simple; re-implement if complex          |
| SAS Viya ML pipeline           | Re-implement end-to-end            | Azure ML pipeline              | Re-implement                                       |
| Custom SAS scoring code        | Re-implement                       | Azure ML scoring script        | Re-implement                                       |

### 2.2 PMML export from SAS (when applicable)

For simple models (linear regression, logistic regression, decision trees), SAS can export PMML:

**SAS:**

```sas
/* Export logistic regression model as PMML */
proc logistic data=work.training;
  model default = credit_score debt_ratio income / lackfit;
  score data=work.validation out=work.scored;
run;

/* Generate PMML */
proc hpforest data=work.training;
  target default / level=binary;
  input credit_score debt_ratio income / level=interval;
  save file="/sas/models/default_model.pmml" format=pmml;
run;
```

**Convert PMML to ONNX (Python):**

```python
# Note: PMML-to-ONNX conversion works for simple models
# Complex models should be re-implemented

# Option 1: Use sklearn-onnx for direct conversion
# Option 2: Re-implement the model (recommended for production)
from sklearn.linear_model import LogisticRegression
import mlflow
import onnx
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType

# Re-implement the model (recommended)
model = LogisticRegression(max_iter=1000)
model.fit(X_train, y_train)

# Convert to ONNX
initial_type = [('float_input', FloatTensorType([None, X_train.shape[1]]))]
onnx_model = convert_sklearn(model, initial_types=initial_type)
onnx.save_model(onnx_model, "model.onnx")
```

### 2.3 Model re-implementation (recommended approach)

For most production models, re-implementation in Python with MLflow tracking is preferred over PMML/ONNX export:

```python
import mlflow
import mlflow.sklearn
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.model_selection import cross_val_score
from sklearn.metrics import roc_auc_score, precision_recall_curve
import pandas as pd

# Set MLflow tracking URI (Azure ML workspace)
mlflow.set_tracking_uri("azureml://...")
mlflow.set_experiment("loan-default-model")

# Load training data from Fabric lakehouse
df = spark.table("gold.analytics.training_dataset").toPandas()
X = df[['credit_score', 'debt_ratio', 'income', 'loan_amount', 'employment_years']]
y = df['default_flag']

# Train multiple candidates (replaces SAS Model Manager champion/challenger)
models = {
    "logistic_regression": LogisticRegression(max_iter=1000),
    "random_forest": RandomForestClassifier(n_estimators=100, random_state=42),
    "gradient_boosting": GradientBoostingClassifier(n_estimators=100, random_state=42)
}

best_auc = 0
best_model_name = None

for name, model in models.items():
    with mlflow.start_run(run_name=name):
        # Train
        model.fit(X_train, y_train)

        # Evaluate
        y_pred_prob = model.predict_proba(X_test)[:, 1]
        auc = roc_auc_score(y_test, y_pred_prob)
        cv_scores = cross_val_score(model, X, y, cv=5, scoring='roc_auc')

        # Log metrics
        mlflow.log_metric("auc", auc)
        mlflow.log_metric("cv_auc_mean", cv_scores.mean())
        mlflow.log_metric("cv_auc_std", cv_scores.std())
        mlflow.log_params(model.get_params())

        # Log model
        mlflow.sklearn.log_model(model, name)

        # Track best
        if auc > best_auc:
            best_auc = auc
            best_model_name = name

        print(f"{name}: AUC={auc:.4f}, CV AUC={cv_scores.mean():.4f} +/- {cv_scores.std():.4f}")
```

---

## 3. MLflow model registry (replacing SAS Model Repository)

### 3.1 Register the champion model

```python
# Register the best model in MLflow Model Registry
model_uri = f"runs:/{best_run_id}/{best_model_name}"
model_version = mlflow.register_model(model_uri, "loan-default-model")

# Transition to production (replaces SAS champion designation)
from mlflow.tracking import MlflowClient
client = MlflowClient()

client.transition_model_version_stage(
    name="loan-default-model",
    version=model_version.version,
    stage="Production"
)
```

### 3.2 Champion/challenger workflow

```python
# Load current champion
champion = mlflow.pyfunc.load_model("models:/loan-default-model/Production")
champion_auc = evaluate_model(champion, X_test, y_test)

# Train challenger
challenger_model = GradientBoostingClassifier(
    n_estimators=200, max_depth=5, learning_rate=0.05, random_state=42
)
with mlflow.start_run(run_name="challenger_v2"):
    challenger_model.fit(X_train, y_train)
    challenger_auc = roc_auc_score(y_test,
                                    challenger_model.predict_proba(X_test)[:, 1])
    mlflow.log_metric("auc", challenger_auc)
    mlflow.sklearn.log_model(challenger_model, "gradient_boosting_v2")

# If challenger wins, promote it
if challenger_auc > champion_auc + 0.005:  # Require meaningful improvement
    new_version = mlflow.register_model(
        f"runs:/{mlflow.active_run().info.run_id}/gradient_boosting_v2",
        "loan-default-model"
    )
    # Stage progression: None -> Staging -> Production
    client.transition_model_version_stage(
        name="loan-default-model",
        version=new_version.version,
        stage="Staging"  # Staging first for validation
    )
    print(f"Challenger promoted to Staging (AUC: {challenger_auc:.4f} vs {champion_auc:.4f})")
```

---

## 4. Azure ML managed endpoints (replacing SAS scoring)

### 4.1 Real-time scoring endpoint

```python
from azure.ai.ml import MLClient
from azure.ai.ml.entities import (
    ManagedOnlineEndpoint,
    ManagedOnlineDeployment,
    Model,
    Environment,
)
from azure.identity import DefaultAzureCredential

ml_client = MLClient(
    DefaultAzureCredential(),
    subscription_id="...",
    resource_group_name="rg-analytics-prod",
    workspace_name="aml-analytics-prod"
)

# Create endpoint
endpoint = ManagedOnlineEndpoint(
    name="loan-default-scoring",
    description="Loan default prediction (replaces SAS scoring service)",
    auth_mode="key"
)
ml_client.online_endpoints.begin_create_or_update(endpoint).result()

# Deploy model
deployment = ManagedOnlineDeployment(
    name="champion-v1",
    endpoint_name="loan-default-scoring",
    model=Model(
        path="./model",  # MLflow model directory
        type="mlflow_model"
    ),
    instance_type="Standard_DS3_v2",
    instance_count=2
)
ml_client.online_deployments.begin_create_or_update(deployment).result()

# Route 100% traffic to the deployment
endpoint.traffic = {"champion-v1": 100}
ml_client.online_endpoints.begin_create_or_update(endpoint).result()
```

### 4.2 Batch scoring endpoint

```python
from azure.ai.ml.entities import BatchEndpoint, BatchDeployment

# Create batch endpoint (replaces SAS batch scoring jobs)
batch_endpoint = BatchEndpoint(
    name="loan-default-batch",
    description="Batch scoring for loan portfolio (replaces SAS batch scoring)"
)
ml_client.batch_endpoints.begin_create_or_update(batch_endpoint).result()

# Deploy for batch inference
batch_deployment = BatchDeployment(
    name="champion-batch",
    endpoint_name="loan-default-batch",
    model=Model(path="./model", type="mlflow_model"),
    compute="aml-compute-cluster",
    instance_count=4,
    max_concurrency_per_instance=2,
    mini_batch_size=1000,
    output_action="append_row",
    output_file_name="predictions.csv"
)
ml_client.batch_deployments.begin_create_or_update(batch_deployment).result()
```

### 4.3 A/B testing with traffic splitting

```python
# Deploy challenger alongside champion (replaces SAS Model Manager side-by-side)
challenger_deployment = ManagedOnlineDeployment(
    name="challenger-v2",
    endpoint_name="loan-default-scoring",
    model=Model(path="./challenger_model", type="mlflow_model"),
    instance_type="Standard_DS3_v2",
    instance_count=1
)
ml_client.online_deployments.begin_create_or_update(challenger_deployment).result()

# Route 90% to champion, 10% to challenger
endpoint.traffic = {"champion-v1": 90, "challenger-v2": 10}
ml_client.online_endpoints.begin_create_or_update(endpoint).result()
```

---

## 5. Model monitoring (replacing SAS performance monitoring)

### 5.1 Data drift detection

```python
from azure.ai.ml.entities import MonitorSchedule, MonitorDefinition
from azure.ai.ml.entities import DataDriftSignal, FeatureAttributionDriftSignal

# Configure monitoring schedule
monitor = MonitorSchedule(
    name="loan-default-monitor",
    trigger=RecurrenceTrigger(frequency="day", interval=1),
    create_monitor=MonitorDefinition(
        compute=ServerlessSparkCompute(instance_type="Standard_E4s_v3"),
        monitoring_signals={
            "data_drift": DataDriftSignal(
                production_data=ProductionData(
                    input_data=InputData(
                        type="uri_folder",
                        path="azureml://datastores/production/paths/scoring-logs/"
                    )
                ),
                reference_data=ReferenceData(
                    input_data=InputData(
                        type="mltable",
                        path="azureml://datastores/training/paths/baseline/"
                    )
                ),
                features=["credit_score", "debt_ratio", "income"],
                metric_thresholds={
                    "normalized_wasserstein_distance": 0.1,
                    "jensen_shannon_distance": 0.05
                }
            )
        },
        alert_notification=AlertNotification(
            emails=["model-risk-team@agency.gov"]
        )
    )
)
ml_client.schedules.begin_create_or_update(monitor).result()
```

### 5.2 Model performance tracking

```python
# Log scoring performance metrics over time
# (replaces SAS Model Manager performance reports)

import mlflow

def log_production_metrics(y_true, y_pred_prob, scoring_date):
    """Log production model performance metrics to MLflow."""
    with mlflow.start_run(run_name=f"production_{scoring_date}"):
        auc = roc_auc_score(y_true, y_pred_prob)
        precision, recall, _ = precision_recall_curve(y_true, y_pred_prob)
        avg_precision = average_precision_score(y_true, y_pred_prob)

        mlflow.log_metrics({
            "production_auc": auc,
            "production_avg_precision": avg_precision,
            "production_n_scored": len(y_true),
            "production_positive_rate": y_true.mean()
        })

        # Alert if performance degrades
        champion_auc = 0.82  # Baseline from training
        if auc < champion_auc - 0.03:
            print(f"ALERT: Production AUC ({auc:.4f}) below threshold "
                  f"({champion_auc - 0.03:.4f}). Consider retraining.")
```

---

## 6. SAS scoring code migration patterns

### 6.1 SAS score code to Python scoring script

**SAS scoring code (generated by PROC LOGISTIC):**

```sas
data work.scored;
  set work.new_applications;
  /* Intercept and coefficients from PROC LOGISTIC */
  _logit = -3.2145
           + 0.0234 * credit_score
           - 1.5678 * debt_ratio
           + 0.0001 * income
           - 0.0003 * loan_amount;
  pred_default = 1 / (1 + exp(-_logit));
  if pred_default >= 0.5 then predicted_class = 1;
  else predicted_class = 0;
run;
```

**Python scoring script (Azure ML endpoint):**

```python
# score.py - Azure ML scoring script
import json
import numpy as np
import mlflow

def init():
    global model
    model = mlflow.sklearn.load_model("model")

def run(raw_data):
    data = json.loads(raw_data)
    features = np.array(data["features"])
    predictions = model.predict_proba(features)[:, 1].tolist()
    classes = [1 if p >= 0.5 else 0 for p in predictions]
    return json.dumps({
        "predictions": predictions,
        "classes": classes
    })
```

---

## 7. Validation framework

### 7.1 Model equivalence testing

```python
def validate_model_migration(sas_predictions, python_predictions,
                              tolerance=0.005):
    """Validate that Python model produces equivalent results to SAS model.

    Args:
        sas_predictions: Array of SAS predicted probabilities
        python_predictions: Array of Python predicted probabilities
        tolerance: Maximum acceptable mean absolute difference
    """
    mae = np.mean(np.abs(sas_predictions - python_predictions))
    max_diff = np.max(np.abs(sas_predictions - python_predictions))
    correlation = np.corrcoef(sas_predictions, python_predictions)[0, 1]

    # AUC comparison
    sas_auc = roc_auc_score(y_true, sas_predictions)
    python_auc = roc_auc_score(y_true, python_predictions)

    results = {
        "mean_absolute_difference": mae,
        "max_absolute_difference": max_diff,
        "correlation": correlation,
        "sas_auc": sas_auc,
        "python_auc": python_auc,
        "auc_difference": abs(sas_auc - python_auc),
        "passed": mae < tolerance and abs(sas_auc - python_auc) < 0.01
    }

    print(f"MAE: {mae:.6f} (tolerance: {tolerance})")
    print(f"Max difference: {max_diff:.6f}")
    print(f"Correlation: {correlation:.6f}")
    print(f"SAS AUC: {sas_auc:.4f}, Python AUC: {python_auc:.4f}")
    print(f"Validation: {'PASSED' if results['passed'] else 'FAILED'}")

    return results
```

---

## 8. Migration checklist

| Step | Action                                                 | Validation                          |
| ---- | ------------------------------------------------------ | ----------------------------------- |
| 1    | Export SAS model coefficients and scoring code         | Document all model parameters       |
| 2    | Re-implement model in Python with MLflow tracking      | Compare AUC within 0.01             |
| 3    | Register model in MLflow Model Registry                | Verify model metadata and artifacts |
| 4    | Deploy to Azure ML managed endpoint                    | Test endpoint with sample data      |
| 5    | Run parallel scoring (SAS and Azure ML) for 2--4 weeks | Mean prediction difference < 0.005  |
| 6    | Configure model monitoring                             | Drift alerts firing correctly       |
| 7    | Decommission SAS scoring                               | Remove SAS Model Manager project    |

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
