# ML Real-Time Scoring Integration

> __[Home](../../../README.md)__ | __[Implementation](../README.md)__ | __[Integration](README.md)__ | __ML Real-time Scoring__

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Advanced-red?style=flat-square)

Implement real-time ML model inference across streaming and batch pipelines.

---

## Overview

Real-time ML scoring enables:

- Sub-second predictions on streaming data
- Feature enrichment in event pipelines
- Online fraud detection and anomaly scoring
- Personalization at scale

---

## Architecture Patterns

### Pattern 1: Embedded Scoring (Stream Analytics + ML)

```sql
-- Stream Analytics with Azure ML
WITH ScoredEvents AS (
    SELECT
        device_id,
        temperature,
        humidity,
        pressure,
        udf.AnomalyScore(temperature, humidity, pressure) AS anomaly_score
    FROM [iot-input]
)
SELECT
    device_id,
    temperature,
    humidity,
    pressure,
    anomaly_score,
    CASE WHEN anomaly_score > 0.8 THEN 'CRITICAL'
         WHEN anomaly_score > 0.5 THEN 'WARNING'
         ELSE 'NORMAL'
    END AS status
INTO [scored-output]
FROM ScoredEvents
```

### Pattern 2: Databricks Model Serving

```python
from databricks.sdk import WorkspaceClient
from mlflow.deployments import get_deploy_client

# Deploy model to serving endpoint
w = WorkspaceClient()

endpoint_config = {
    "name": "fraud-detection-endpoint",
    "config": {
        "served_entities": [{
            "entity_name": "fraud_model",
            "entity_version": "1",
            "workload_size": "Small",
            "scale_to_zero_enabled": False
        }],
        "traffic_config": {
            "routes": [{
                "served_model_name": "fraud_model-1",
                "traffic_percentage": 100
            }]
        },
        "auto_capture_config": {
            "catalog_name": "ml",
            "schema_name": "inference_logs",
            "table_name_prefix": "fraud_detection"
        }
    }
}

w.serving_endpoints.create_and_wait(**endpoint_config)
```

### Pattern 3: Streaming with Model Inference

```python
from pyspark.sql.functions import *
import mlflow

# Load model for batch inference
model_uri = "models:/fraud_model/Production"
model_udf = mlflow.pyfunc.spark_udf(spark, model_uri, result_type="double")

# Score streaming data
def score_transactions(batch_df, batch_id):
    """Score each micro-batch with ML model."""

    # Prepare features
    features = batch_df.select(
        "transaction_id",
        "amount",
        "merchant_category",
        "time_since_last_transaction",
        "distance_from_home"
    )

    # Apply model
    scored = features.withColumn(
        "fraud_score",
        model_udf(struct([col(c) for c in features.columns if c != "transaction_id"]))
    )

    # Filter high-risk transactions
    high_risk = scored.filter(col("fraud_score") > 0.7)

    # Write results
    scored.write.format("delta").mode("append").saveAsTable("ml.scores.transactions")

    # Alert on high risk
    if high_risk.count() > 0:
        high_risk.write.format("delta").mode("append").saveAsTable("ml.alerts.fraud")

# Stream processing
transactions_stream = spark.readStream.format("delta").table("bronze.transactions")

query = transactions_stream.writeStream \
    .foreachBatch(score_transactions) \
    .option("checkpointLocation", "/checkpoints/fraud_scoring") \
    .trigger(processingTime="10 seconds") \
    .start()
```

### Pattern 4: Azure ML Online Endpoint

```python
from azure.ai.ml import MLClient
from azure.ai.ml.entities import ManagedOnlineEndpoint, ManagedOnlineDeployment
from azure.identity import DefaultAzureCredential

# Create ML client
ml_client = MLClient(
    DefaultAzureCredential(),
    subscription_id,
    resource_group,
    workspace_name
)

# Create endpoint
endpoint = ManagedOnlineEndpoint(
    name="realtime-scoring",
    auth_mode="key"
)
ml_client.online_endpoints.begin_create_or_update(endpoint).result()

# Deploy model
deployment = ManagedOnlineDeployment(
    name="production",
    endpoint_name="realtime-scoring",
    model="azureml:fraud-model:1",
    instance_type="Standard_DS3_v2",
    instance_count=2,
    environment="azureml:sklearn-env:1",
    code_configuration={
        "code": "./scoring",
        "scoring_script": "score.py"
    }
)
ml_client.online_deployments.begin_create_or_update(deployment).result()
```

### Pattern 5: Event Hub + Azure Function + ML

```python
# function_app.py
import azure.functions as func
import json
import aiohttp
import os

app = func.FunctionApp()

@app.event_hub_message_trigger(
    arg_name="events",
    event_hub_name="transactions",
    connection="EventHubConnection"
)
@app.event_hub_output(
    arg_name="scored_output",
    event_hub_name="scored-transactions",
    connection="EventHubConnection"
)
async def score_events(events: list[func.EventHubEvent], scored_output: func.Out[list[str]]):
    """Score transactions using Azure ML endpoint."""

    ml_endpoint = os.environ["ML_ENDPOINT_URL"]
    ml_key = os.environ["ML_ENDPOINT_KEY"]

    scored_events = []

    async with aiohttp.ClientSession() as session:
        for event in events:
            data = json.loads(event.get_body().decode())

            # Call ML endpoint
            async with session.post(
                ml_endpoint,
                json={"data": [data]},
                headers={"Authorization": f"Bearer {ml_key}"}
            ) as response:
                result = await response.json()
                score = result["predictions"][0]

            # Enrich with score
            data["fraud_score"] = score
            data["scored_at"] = datetime.utcnow().isoformat()

            scored_events.append(json.dumps(data))

    scored_output.set(scored_events)
```

---

## Feature Store Integration

```python
from databricks.feature_engineering import FeatureEngineeringClient, FeatureLookup

fe = FeatureEngineeringClient()

# Define feature lookups for scoring
feature_lookups = [
    FeatureLookup(
        table_name="ml.features.customer_profile",
        lookup_key=["customer_id"],
        feature_names=["avg_transaction_amount", "transaction_frequency"]
    ),
    FeatureLookup(
        table_name="ml.features.merchant_risk",
        lookup_key=["merchant_id"],
        feature_names=["merchant_risk_score", "chargeback_rate"]
    )
]

# Score with feature enrichment
def score_with_features(batch_df, batch_id):
    # Enrich with features
    enriched = fe.score_batch(
        model_uri="models:/fraud_model/Production",
        df=batch_df,
        feature_lookups=feature_lookups,
        result_type="double"
    )

    enriched.write.format("delta").mode("append").saveAsTable("ml.scores.enriched")
```

---

## Monitoring

```sql
-- Monitor model performance
SELECT
    DATE(scored_at) AS date,
    model_version,
    COUNT(*) AS predictions,
    AVG(fraud_score) AS avg_score,
    SUM(CASE WHEN fraud_score > 0.5 THEN 1 ELSE 0 END) AS flagged_count,
    AVG(latency_ms) AS avg_latency
FROM ml.inference_logs.fraud_detection
GROUP BY DATE(scored_at), model_version
ORDER BY date DESC;
```

---

## Related Documentation

- [MLOps Pipeline](../databricks/mlops-pipeline.md)
- [Model Monitoring](../databricks/model-monitoring.md)
- [Feature Store Setup](../databricks/feature-store-setup.md)

---

*Last Updated: January 2025*
