# Feature Store Architecture

> **[Home](../../README.md)** | **[Architecture](../README.md)** | **Feature Store**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Pattern](https://img.shields.io/badge/Pattern-ML%20Infrastructure-purple?style=flat-square)

Architecture guide for implementing a Feature Store on Azure.

---

## Overview

A Feature Store is a centralized repository for storing, managing, and serving ML features. It enables:

- **Feature reuse** across teams and models
- **Consistency** between training and inference
- **Point-in-time correctness** for training data
- **Feature discovery** and documentation

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Feature Store Architecture                │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ Data Sources │───▶│  Feature     │───▶│  Offline     │  │
│  │ (Raw Data)   │    │  Engineering │    │  Store       │  │
│  └──────────────┘    └──────────────┘    │  (Delta)     │  │
│                                          └───────┬──────┘  │
│                                                  │         │
│                                          ┌───────▼──────┐  │
│  ┌──────────────┐                        │  Online      │  │
│  │  ML Training │◀───────────────────────│  Store       │  │
│  └──────────────┘                        │  (Redis/     │  │
│                                          │   Cosmos DB) │  │
│  ┌──────────────┐                        └───────┬──────┘  │
│  │  ML Serving  │◀───────────────────────────────┘         │
│  └──────────────┘                                          │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Components

### Offline Store (Delta Lake)

```python
# Feature table definition
from databricks.feature_engineering import FeatureEngineeringClient

fe = FeatureEngineeringClient()

# Create feature table
customer_features = spark.sql("""
    SELECT
        customer_id,
        COUNT(*) as transaction_count_30d,
        SUM(amount) as total_spend_30d,
        AVG(amount) as avg_transaction_30d,
        MAX(transaction_date) as last_transaction_date,
        current_timestamp() as update_timestamp
    FROM transactions
    WHERE transaction_date >= current_date() - INTERVAL 30 DAYS
    GROUP BY customer_id
""")

fe.create_table(
    name="feature_store.customer_features",
    primary_keys=["customer_id"],
    timestamp_keys=["update_timestamp"],
    df=customer_features,
    description="Customer transaction features - 30 day window"
)
```

### Online Store (Azure Redis/Cosmos DB)

```python
# Sync features to online store
from databricks.feature_engineering import FeatureEngineeringClient

fe = FeatureEngineeringClient()

# Publish to online store
fe.publish_table(
    name="feature_store.customer_features",
    online_store_spec=AzureCosmosDBSpec(
        account_uri=dbutils.secrets.get("keyvault", "cosmos-uri"),
        write_secret_prefix="keyvault/cosmos-key",
        read_secret_prefix="keyvault/cosmos-key",
        database_name="features",
        container_name="customer_features"
    )
)
```

---

## Feature Engineering Patterns

### Time-Windowed Features

```python
from pyspark.sql.functions import *
from pyspark.sql.window import Window

def create_time_windowed_features(df, windows=[7, 14, 30, 90]):
    """Create features for multiple time windows."""
    features = df

    for days in windows:
        window_spec = Window.partitionBy("customer_id") \
            .orderBy("transaction_date") \
            .rangeBetween(-days * 86400, 0)

        features = features \
            .withColumn(f"txn_count_{days}d", count("*").over(window_spec)) \
            .withColumn(f"total_spend_{days}d", sum("amount").over(window_spec)) \
            .withColumn(f"avg_spend_{days}d", avg("amount").over(window_spec))

    return features
```

### Point-in-Time Join

```python
# Training data with point-in-time correctness
from databricks.feature_engineering import FeatureEngineeringClient, FeatureLookup

fe = FeatureEngineeringClient()

# Define feature lookups
feature_lookups = [
    FeatureLookup(
        table_name="feature_store.customer_features",
        lookup_key=["customer_id"],
        timestamp_lookup_key="event_timestamp"
    ),
    FeatureLookup(
        table_name="feature_store.product_features",
        lookup_key=["product_id"]
    )
]

# Create training set with point-in-time join
training_set = fe.create_training_set(
    df=labels_df,
    feature_lookups=feature_lookups,
    label="is_churned",
    exclude_columns=["event_timestamp"]
)

training_df = training_set.load_df()
```

---

## Feature Serving

### Batch Inference

```python
# Batch scoring with feature store
fe = FeatureEngineeringClient()

# Load model and score
scored_df = fe.score_batch(
    model_uri="models:/churn_model/Production",
    df=customers_to_score
)
```

### Real-time Inference

```python
# Online serving endpoint
import requests

def get_prediction(customer_id: str) -> dict:
    """Get real-time prediction using online features."""

    endpoint_url = "https://workspace.azuredatabricks.net/serving-endpoints/churn-model/invocations"

    response = requests.post(
        endpoint_url,
        headers={"Authorization": f"Bearer {token}"},
        json={"dataframe_records": [{"customer_id": customer_id}]}
    )

    return response.json()
```

---

## Governance

### Feature Documentation

```python
# Document features with tags and descriptions
fe.set_feature_table_tag(
    name="feature_store.customer_features",
    key="team",
    value="data-science"
)

fe.set_feature_table_tag(
    name="feature_store.customer_features",
    key="data_owner",
    value="customer-analytics"
)
```

### Access Control

```sql
-- Unity Catalog permissions
GRANT SELECT ON TABLE feature_store.customer_features TO `data-scientists`;
GRANT ALL PRIVILEGES ON TABLE feature_store.customer_features TO `feature-engineers`;
```

---

## Monitoring

### Feature Drift Detection

```python
# Monitor feature distributions
from evidently import ColumnDriftMetric
from evidently.report import Report

def detect_feature_drift(reference_df, current_df, features):
    """Detect drift in feature distributions."""
    report = Report(metrics=[
        ColumnDriftMetric(column_name=f) for f in features
    ])

    report.run(reference_data=reference_df.toPandas(),
               current_data=current_df.toPandas())

    return report.as_dict()
```

---

## Related Documentation

- [MLOps Best Practices](../../best-practices/ml-operations/README.md)
- [ML on Databricks](../../tutorials/intermediate/ml-databricks.md)
- [Delta Lake Guide](../../delta-lake-guide.md)

---

*Last Updated: January 2025*
