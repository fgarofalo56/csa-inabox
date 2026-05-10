---
title: "ML Model Monitoring Guide"
description: "Monitor deployed ML models for drift, performance, and data quality."
tags:
  - implementation
  - databricks
---
# 📊 ML Model Monitoring Guide

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Advanced-red?style=flat-square)

Monitor deployed ML models for drift, performance, and data quality.

---

## 🎯 Overview

Model monitoring detects:

- **Data Drift**: Input feature distribution changes
- **Prediction Drift**: Model output distribution changes
- **Performance Degradation**: Accuracy decline over time
- **Data Quality Issues**: Missing values, outliers

---

## 🔧 Implementation

### Lakehouse Monitoring Setup

```python
from databricks.sdk import WorkspaceClient
from databricks.sdk.service.catalog import MonitorInfo

w = WorkspaceClient()

# Create monitor for inference table
monitor = w.quality_monitors.create(
    table_name="ml.inference_logs.customer_churn_predictions",
    assets_dir="/ml/monitoring/customer_churn",
    output_schema_name="ml.monitoring",
    schedule=MonitorCronSchedule(
        quartz_cron_expression="0 0 * * * ?",  # Hourly
        timezone_id="UTC"
    ),
    inference_log=InferenceLog(
        granularities=["1 day"],
        model_id_col="model_version",
        prediction_col="prediction",
        timestamp_col="timestamp",
        problem_type="PROBLEM_TYPE_CLASSIFICATION",
        label_col="actual_label"  # If available
    )
)
```

### Custom Drift Detection

```python
from evidently.report import Report
from evidently.metric_preset import DataDriftPreset, TargetDriftPreset

def detect_drift(reference_df, current_df, threshold=0.1):
    """Detect feature and prediction drift."""

    report = Report(metrics=[
        DataDriftPreset(),
        TargetDriftPreset()
    ])

    report.run(
        reference_data=reference_df.toPandas(),
        current_data=current_df.toPandas()
    )

    results = report.as_dict()

    drift_detected = results["metrics"][0]["result"]["dataset_drift"]
    drift_score = results["metrics"][0]["result"]["share_of_drifted_columns"]

    if drift_detected or drift_score > threshold:
        trigger_alert("Model drift detected", drift_score)
        return True

    return False
```

### Performance Tracking

```sql
-- Track model performance over time
CREATE OR REPLACE VIEW ml.monitoring.daily_performance AS
SELECT
    DATE(timestamp) as date,
    model_version,
    COUNT(*) as prediction_count,
    AVG(CASE WHEN prediction = actual_label THEN 1.0 ELSE 0.0 END) as accuracy,
    SUM(CASE WHEN prediction = 1 AND actual_label = 1 THEN 1 ELSE 0 END) as true_positives,
    SUM(CASE WHEN prediction = 1 AND actual_label = 0 THEN 1 ELSE 0 END) as false_positives
FROM ml.inference_logs.customer_churn_predictions
WHERE actual_label IS NOT NULL
GROUP BY DATE(timestamp), model_version;
```

### Alerting

```python
from databricks.sdk.service.sql import AlertOptions

# Create performance alert
w.alerts.create(
    name="Model Accuracy Drop Alert",
    query_id="query-123",
    options=AlertOptions(
        column="accuracy",
        op="<",
        value="0.80",
        custom_body="Model accuracy dropped below 80%"
    ),
    rearm=300  # 5 minutes
)
```

---

## 📊 Monitoring Dashboard

```sql
-- Dashboard query: Feature distribution
SELECT
    feature_name,
    DATE(timestamp) as date,
    AVG(feature_value) as mean,
    STDDEV(feature_value) as std,
    MIN(feature_value) as min,
    MAX(feature_value) as max,
    PERCENTILE(feature_value, 0.5) as median
FROM ml.inference_logs.feature_values
GROUP BY feature_name, DATE(timestamp);
```

---

## 📚 Related Documentation

- [MLOps Pipeline](mlops-pipeline.md)
- [Feature Store](feature-store-setup.md)
- [Model Deployment Patterns](../../03-architecture-patterns/ml-patterns/model-deployment.md)

---

*Last Updated: January 2025*
