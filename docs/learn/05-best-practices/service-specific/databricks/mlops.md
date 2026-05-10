# MLOps Best Practices

> **[Home](../../../README.md)** | **[Best Practices](../../README.md)** | **[Databricks](README.md)** | **MLOps**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Category](https://img.shields.io/badge/Category-MLOps-purple?style=flat-square)

Best practices for MLOps on Azure Databricks.

---

## Experiment Tracking

### MLflow Configuration

```python
import mlflow

# Set experiment
mlflow.set_experiment("/Experiments/customer-churn")

# Enable autologging
mlflow.autolog()

# Manual logging with context
with mlflow.start_run(run_name="random_forest_v1") as run:
    # Log parameters
    mlflow.log_params({
        "n_estimators": 100,
        "max_depth": 10
    })

    # Train model
    model.fit(X_train, y_train)

    # Log metrics
    mlflow.log_metrics({
        "accuracy": accuracy_score(y_test, y_pred),
        "f1_score": f1_score(y_test, y_pred)
    })

    # Log artifacts
    mlflow.log_artifact("feature_importance.png")

    # Log model
    mlflow.sklearn.log_model(model, "model")
```

---

## Model Registry

### Model Lifecycle

```python
from mlflow.tracking import MlflowClient

client = MlflowClient()

# Register model
model_uri = f"runs:/{run.info.run_id}/model"
mv = mlflow.register_model(model_uri, "customer_churn_model")

# Add description
client.update_registered_model(
    name="customer_churn_model",
    description="Predicts customer churn probability"
)

# Stage transitions
# None -> Staging -> Production -> Archived
client.transition_model_version_stage(
    name="customer_churn_model",
    version=mv.version,
    stage="Staging"
)
```

### Model Approval Workflow

```python
def approve_model(model_name: str, version: int):
    """Approve model after validation."""
    client = MlflowClient()

    # Get model metrics
    model_version = client.get_model_version(model_name, str(version))
    run = client.get_run(model_version.run_id)
    metrics = run.data.metrics

    # Validation criteria
    if metrics.get("accuracy", 0) > 0.85 and metrics.get("f1_score", 0) > 0.80:
        client.transition_model_version_stage(
            name=model_name,
            version=version,
            stage="Production",
            archive_existing_versions=True
        )
        return True
    return False
```

---

## Feature Store

### Feature Table Management

```python
from databricks.feature_engineering import FeatureEngineeringClient

fe = FeatureEngineeringClient()

# Create feature table
fe.create_table(
    name="feature_store.customer_features",
    primary_keys=["customer_id"],
    timestamp_keys=["update_timestamp"],
    df=features_df,
    description="Customer transaction features"
)

# Update features (overwrite)
fe.write_table(
    name="feature_store.customer_features",
    df=updated_features,
    mode="overwrite"
)
```

### Point-in-Time Training

```python
from databricks.feature_engineering import FeatureLookup

# Create training set with point-in-time correctness
training_set = fe.create_training_set(
    df=labels_df,
    feature_lookups=[
        FeatureLookup(
            table_name="feature_store.customer_features",
            lookup_key=["customer_id"],
            timestamp_lookup_key="event_timestamp"
        )
    ],
    label="is_churned"
)
```

---

## Model Serving

### Model Serving Endpoint

```python
from databricks.sdk import WorkspaceClient

w = WorkspaceClient()

# Create serving endpoint
endpoint = w.serving_endpoints.create_and_wait(
    name="churn-prediction",
    config={
        "served_entities": [{
            "entity_name": "customer_churn_model",
            "entity_version": "1",
            "workload_size": "Small",
            "scale_to_zero_enabled": True
        }]
    }
)

# A/B testing with traffic split
config = {
    "served_entities": [
        {"entity_name": "model", "entity_version": "1", "workload_size": "Small"},
        {"entity_name": "model", "entity_version": "2", "workload_size": "Small"}
    ],
    "traffic_config": {
        "routes": [
            {"served_model_name": "model-1", "traffic_percentage": 90},
            {"served_model_name": "model-2", "traffic_percentage": 10}
        ]
    }
}
```

---

## Monitoring

### Model Performance Monitoring

```python
from evidently.metric_preset import DataDriftPreset, TargetDriftPreset
from evidently.report import Report

def monitor_model_drift(reference_data, production_data):
    """Monitor for data and prediction drift."""
    report = Report(metrics=[
        DataDriftPreset(),
        TargetDriftPreset()
    ])

    report.run(
        reference_data=reference_data,
        current_data=production_data
    )

    drift_detected = report.as_dict()["metrics"][0]["result"]["dataset_drift"]
    return drift_detected, report
```

### Inference Logging

```python
# Log inference requests and predictions
import json
from datetime import datetime

def log_inference(request, prediction, model_version):
    """Log inference for monitoring."""
    log_entry = {
        "timestamp": datetime.utcnow().isoformat(),
        "model_version": model_version,
        "request": request,
        "prediction": prediction
    }

    # Write to Delta table for analysis
    spark.createDataFrame([log_entry]).write \
        .format("delta") \
        .mode("append") \
        .save("/delta/inference_logs")
```

---

## Best Practices Summary

| Area | Best Practice |
|------|--------------|
| Experiments | Use descriptive run names and tags |
| Models | Version all models in registry |
| Features | Use Feature Store for consistency |
| Serving | Enable auto-scaling and monitoring |
| Monitoring | Track drift and performance metrics |

---

## Related Documentation

- [ML on Databricks Tutorial](../../../tutorials/intermediate/ml-databricks.md)
- [Feature Store Architecture](../../../architecture/feature-store/README.md)
- [Delta Lake Best Practices](delta-lake.md)

---

*Last Updated: January 2025*
