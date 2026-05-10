# ML Pipeline Solution

> __[Home](../../../README.md)__ | __[Solutions](../../08-solutions/README.md)__ | __ML Pipeline__

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Advanced-red?style=flat-square)

End-to-end MLOps pipeline with Databricks and Azure ML.

---

## Overview

The ML Pipeline solution provides:

- Automated model training and validation
- Feature store integration
- Model registry and versioning
- Production deployment with monitoring

---

## Architecture

```mermaid
flowchart LR
    subgraph "Data"
        Lake[(Data Lake)]
        FeatureStore[Feature Store]
    end

    subgraph "Development"
        Notebooks[Databricks Notebooks]
        Experiments[MLflow Experiments]
    end

    subgraph "Training"
        AutoML[AutoML]
        Training[Model Training]
        Validation[Validation]
    end

    subgraph "Deployment"
        Registry[Model Registry]
        Staging[Staging Endpoint]
        Production[Production Endpoint]
    end

    subgraph "Operations"
        Monitoring[Model Monitoring]
        Alerts[Alerting]
        Retraining[Auto Retraining]
    end

    Lake --> FeatureStore --> Training
    Notebooks --> Experiments --> Training
    Training --> Validation --> Registry
    Registry --> Staging --> Production
    Production --> Monitoring --> Alerts
    Monitoring --> Retraining --> Training
```

---

## Implementation

### Step 1: Feature Engineering Pipeline

```python
from databricks.feature_engineering import FeatureEngineeringClient
from pyspark.sql.functions import *

fe = FeatureEngineeringClient()

def create_customer_features():
    """Create customer features for churn prediction."""

    # Load raw data
    transactions = spark.table("bronze.transactions")
    customers = spark.table("bronze.customers")

    # Compute features
    customer_features = transactions.groupBy("customer_id").agg(
        count("*").alias("total_transactions"),
        sum("amount").alias("total_spend"),
        avg("amount").alias("avg_transaction_amount"),
        max("transaction_date").alias("last_transaction_date"),
        countDistinct("product_category").alias("unique_categories"),
        stddev("amount").alias("spend_volatility")
    ).join(
        customers.select("customer_id", "signup_date", "region"),
        "customer_id"
    ).withColumn(
        "days_since_signup",
        datediff(current_date(), col("signup_date"))
    ).withColumn(
        "days_since_last_transaction",
        datediff(current_date(), col("last_transaction_date"))
    )

    # Create feature table
    fe.create_table(
        name="ml.features.customer_churn_features",
        primary_keys=["customer_id"],
        df=customer_features,
        description="Customer features for churn prediction model",
        tags={"team": "data-science", "domain": "customer"}
    )

    return customer_features

# Schedule feature refresh
dbutils.jobs.submit_run(
    run_name="refresh_customer_features",
    notebook_task={
        "notebook_path": "/Repos/ml/features/customer_features"
    },
    schedule={
        "quartz_cron_expression": "0 0 6 * * ?",
        "timezone_id": "UTC"
    }
)
```

### Step 2: Model Training Pipeline

```python
import mlflow
from mlflow.tracking import MlflowClient
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, f1_score, roc_auc_score
import xgboost as xgb

mlflow.set_experiment("/Experiments/customer-churn")

def train_churn_model(data_version: str = "latest"):
    """Train customer churn prediction model."""

    with mlflow.start_run(run_name=f"training-{data_version}") as run:
        # Load features
        feature_df = fe.read_table("ml.features.customer_churn_features")
        labels = spark.table("ml.labels.churn_labels")

        # Prepare data
        training_set = fe.create_training_set(
            df=labels,
            feature_lookups=[
                FeatureLookup(
                    table_name="ml.features.customer_churn_features",
                    lookup_key="customer_id"
                )
            ],
            label="churned"
        )

        df = training_set.load_df().toPandas()
        X = df.drop(["customer_id", "churned"], axis=1)
        y = df["churned"]

        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=0.2, random_state=42
        )

        # Train model
        params = {
            "n_estimators": 100,
            "max_depth": 6,
            "learning_rate": 0.1,
            "objective": "binary:logistic"
        }

        model = xgb.XGBClassifier(**params)
        model.fit(X_train, y_train)

        # Evaluate
        y_pred = model.predict(X_test)
        y_prob = model.predict_proba(X_test)[:, 1]

        metrics = {
            "accuracy": accuracy_score(y_test, y_pred),
            "f1": f1_score(y_test, y_pred),
            "auc_roc": roc_auc_score(y_test, y_prob)
        }

        # Log to MLflow
        mlflow.log_params(params)
        mlflow.log_metrics(metrics)

        # Log model with feature store
        fe.log_model(
            model=model,
            artifact_path="model",
            flavor=mlflow.sklearn,
            training_set=training_set,
            registered_model_name="customer_churn_model"
        )

        return run.info.run_id, metrics
```

### Step 3: Model Validation Pipeline

```python
def validate_model(model_name: str, version: int):
    """Validate model before promotion."""

    client = MlflowClient()
    model_uri = f"models:/{model_name}/{version}"

    # Load model
    model = mlflow.sklearn.load_model(model_uri)

    # Load validation set
    validation_df = spark.table("ml.validation.holdout_churn").toPandas()
    X_val = validation_df.drop(["customer_id", "churned"], axis=1)
    y_val = validation_df["churned"]

    # Evaluate
    y_pred = model.predict(X_val)
    y_prob = model.predict_proba(X_val)[:, 1]

    validation_metrics = {
        "val_accuracy": accuracy_score(y_val, y_pred),
        "val_f1": f1_score(y_val, y_pred),
        "val_auc_roc": roc_auc_score(y_val, y_prob)
    }

    # Check thresholds
    passed = all([
        validation_metrics["val_accuracy"] > 0.80,
        validation_metrics["val_f1"] > 0.75,
        validation_metrics["val_auc_roc"] > 0.85
    ])

    if passed:
        # Promote to Staging
        client.transition_model_version_stage(
            name=model_name,
            version=version,
            stage="Staging"
        )
        return {"status": "promoted", "metrics": validation_metrics}
    else:
        return {"status": "failed", "metrics": validation_metrics}
```

### Step 4: Model Deployment

```python
from databricks.sdk import WorkspaceClient

def deploy_to_production(model_name: str):
    """Deploy model to production serving endpoint."""

    w = WorkspaceClient()

    # Get staging model version
    client = MlflowClient()
    staging_versions = client.get_latest_versions(model_name, stages=["Staging"])

    if not staging_versions:
        raise ValueError("No staging model found")

    version = staging_versions[0].version

    # Create or update endpoint
    endpoint_name = f"{model_name.replace('_', '-')}-endpoint"

    config = {
        "served_entities": [{
            "entity_name": model_name,
            "entity_version": str(version),
            "workload_size": "Small",
            "scale_to_zero_enabled": False
        }],
        "auto_capture_config": {
            "catalog_name": "ml",
            "schema_name": "inference_logs",
            "table_name_prefix": model_name
        }
    }

    try:
        # Update existing endpoint
        w.serving_endpoints.update_config_and_wait(
            name=endpoint_name,
            served_entities=config["served_entities"]
        )
    except:
        # Create new endpoint
        w.serving_endpoints.create_and_wait(
            name=endpoint_name,
            config=config
        )

    # Promote to Production in registry
    client.transition_model_version_stage(
        name=model_name,
        version=version,
        stage="Production",
        archive_existing_versions=True
    )

    return {"endpoint": endpoint_name, "version": version}
```

### Step 5: Model Monitoring

```python
from databricks.sdk.service.catalog import MonitorCronSchedule

def setup_model_monitoring(model_name: str):
    """Set up monitoring for deployed model."""

    w = WorkspaceClient()

    # Create monitor on inference table
    monitor = w.quality_monitors.create(
        table_name=f"ml.inference_logs.{model_name}_predictions",
        assets_dir=f"/ml/monitoring/{model_name}",
        output_schema_name="ml.monitoring",
        schedule=MonitorCronSchedule(
            quartz_cron_expression="0 0 * * * ?",
            timezone_id="UTC"
        ),
        inference_log={
            "granularities": ["1 day"],
            "model_id_col": "model_version",
            "prediction_col": "prediction",
            "timestamp_col": "timestamp",
            "problem_type": "PROBLEM_TYPE_CLASSIFICATION",
            "label_col": "actual_label"
        }
    )

    return monitor

# Create drift alert
def create_drift_alert(model_name: str, threshold: float = 0.1):
    """Create alert for model drift."""

    alert_query = f"""
    SELECT
        date,
        drift_score,
        CASE WHEN drift_score > {threshold} THEN 'DRIFT_DETECTED' ELSE 'NORMAL' END as status
    FROM ml.monitoring.{model_name}_drift_metrics
    WHERE date = current_date()
    """

    # Create Databricks SQL alert
    w.alerts.create(
        name=f"{model_name}_drift_alert",
        query_id="drift_query_id",
        options={
            "column": "status",
            "op": "==",
            "value": "DRIFT_DETECTED",
            "custom_body": f"Model drift detected for {model_name}"
        }
    )
```

---

## CI/CD Pipeline

```yaml
# azure-pipelines.yml
trigger:
  branches:
    include:
      - main

stages:
  - stage: Test
    jobs:
      - job: UnitTests
        steps:
          - script: pytest tests/unit/

  - stage: Train
    jobs:
      - job: TrainModel
        steps:
          - script: |
              databricks jobs run-now --job-id $(TRAINING_JOB_ID)

  - stage: Validate
    jobs:
      - job: ValidateModel
        steps:
          - script: |
              python validate_model.py --model $(MODEL_NAME)

  - stage: Deploy
    condition: succeeded()
    jobs:
      - deployment: DeployModel
        environment: production
        strategy:
          runOnce:
            deploy:
              steps:
                - script: |
                    python deploy_model.py --model $(MODEL_NAME)
```

---

## Related Documentation

- [MLOps Pipeline Guide](../../04-implementation-guides/databricks/mlops-pipeline.md)
- [Model Monitoring](../../04-implementation-guides/databricks/model-monitoring.md)
- [Feature Store Setup](../../04-implementation-guides/databricks/feature-store-setup.md)

---

*Last Updated: January 2025*
