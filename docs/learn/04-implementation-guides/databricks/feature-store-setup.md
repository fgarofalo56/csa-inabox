# 🏪 Feature Store Setup Guide

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)
![Duration](https://img.shields.io/badge/Duration-1--2_hours-blue?style=flat-square)

Configure Databricks Feature Store for centralized ML feature management.

---

## 🎯 Overview

Feature Store provides a centralized repository for ML features, enabling:

- **Feature Reuse**: Share features across models and teams
- **Point-in-Time Correctness**: Prevent data leakage in training
- **Feature Serving**: Low-latency feature retrieval for inference
- **Lineage Tracking**: Track feature origins and usage

---

## 📋 Prerequisites

- [ ] Azure Databricks workspace
- [ ] Unity Catalog enabled
- [ ] MLflow configured
- [ ] Compute cluster available

---

## 🔧 Implementation

### Step 1: Create Feature Tables

```python
from databricks.feature_engineering import FeatureEngineeringClient
from pyspark.sql import SparkSession

spark = SparkSession.builder.getOrCreate()
fe = FeatureEngineeringClient()

# Create a feature table
customer_features_df = spark.sql("""
    SELECT
        customer_id,
        COUNT(*) as total_orders,
        SUM(amount) as total_spend,
        AVG(amount) as avg_order_value,
        MAX(order_date) as last_order_date,
        DATEDIFF(current_date(), MAX(order_date)) as days_since_last_order
    FROM gold.sales.orders
    GROUP BY customer_id
""")

# Create feature table in Unity Catalog
fe.create_table(
    name="ml.features.customer_features",
    primary_keys=["customer_id"],
    df=customer_features_df,
    description="Customer aggregated features for ML models"
)
```

### Step 2: Create Time-Series Features

```python
from databricks.feature_engineering import FeatureEngineeringClient, FeatureFunction
from pyspark.sql.functions import *

fe = FeatureEngineeringClient()

# Create time-series feature table with timestamp key
order_history_df = spark.sql("""
    SELECT
        customer_id,
        order_date as timestamp,
        SUM(amount) OVER (
            PARTITION BY customer_id
            ORDER BY order_date
            ROWS BETWEEN 30 PRECEDING AND CURRENT ROW
        ) as rolling_30d_spend,
        COUNT(*) OVER (
            PARTITION BY customer_id
            ORDER BY order_date
            ROWS BETWEEN 7 PRECEDING AND CURRENT ROW
        ) as rolling_7d_orders
    FROM gold.sales.orders
""")

fe.create_table(
    name="ml.features.customer_order_history",
    primary_keys=["customer_id"],
    timestamp_keys=["timestamp"],
    df=order_history_df,
    description="Time-series customer order features"
)
```

### Step 3: Use Features in Training

```python
from databricks.feature_engineering import FeatureLookup
import mlflow

# Define feature lookups
feature_lookups = [
    FeatureLookup(
        table_name="ml.features.customer_features",
        feature_names=["total_orders", "total_spend", "avg_order_value"],
        lookup_key="customer_id"
    ),
    FeatureLookup(
        table_name="ml.features.customer_order_history",
        feature_names=["rolling_30d_spend", "rolling_7d_orders"],
        lookup_key="customer_id",
        timestamp_lookup_key="event_timestamp"  # Point-in-time lookup
    )
]

# Create training set
training_df = spark.table("gold.ml.training_labels")

training_set = fe.create_training_set(
    df=training_df,
    feature_lookups=feature_lookups,
    label="churn_label",
    exclude_columns=["customer_id", "event_timestamp"]
)

# Load as DataFrame for training
training_data = training_set.load_df()

# Train model with MLflow
with mlflow.start_run():
    model = train_model(training_data)

    # Log model with feature metadata
    fe.log_model(
        model=model,
        artifact_path="model",
        flavor=mlflow.sklearn,
        training_set=training_set,
        registered_model_name="customer_churn_model"
    )
```

### Step 4: Online Feature Serving

```python
# Enable online store for low-latency serving
from databricks.feature_engineering.online_store import OnlineStoreSpec

# Publish features to online store
fe.publish_table(
    name="ml.features.customer_features",
    online_store=OnlineStoreSpec(
        cloud="azure",
        region="eastus"
    )
)

# Score with online features
from databricks.feature_engineering import FeatureEngineeringClient

fe = FeatureEngineeringClient()

# Real-time inference
def score_customer(customer_id):
    # Features are automatically retrieved from online store
    result = fe.score_batch(
        model_uri="models:/customer_churn_model/Production",
        df=spark.createDataFrame([(customer_id,)], ["customer_id"])
    )
    return result.collect()[0]["prediction"]
```

---

## 📊 Feature Monitoring

```python
# Monitor feature freshness and quality
feature_stats = spark.sql("""
    SELECT
        'customer_features' as feature_table,
        COUNT(*) as row_count,
        MAX(updated_at) as last_update,
        DATEDIFF(current_timestamp(), MAX(updated_at)) as staleness_hours
    FROM ml.features.customer_features
""")

feature_stats.show()
```

---

## 📚 Related Documentation

- [Feature Engineering](feature-engineering.md)
- [MLOps Pipeline](mlops-pipeline.md)
- [Model Monitoring](model-monitoring.md)

---

*Last Updated: January 2025*
