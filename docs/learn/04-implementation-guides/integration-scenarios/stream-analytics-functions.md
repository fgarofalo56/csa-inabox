# Stream Analytics Integration with Azure Functions

> __[Home](../../../README.md)__ | __[Implementation](../README.md)__ | __[Integration](README.md)__ | __ASA + Functions__

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)

Extend Stream Analytics with custom processing using Azure Functions UDFs and outputs.

---

## Overview

Stream Analytics + Functions enables:

- Custom aggregation and transformation logic
- Integration with external APIs and services
- Complex event processing beyond SQL capabilities
- Machine learning model inference

---

## Implementation

### Step 1: JavaScript UDF in Stream Analytics

```javascript
// UDF for custom scoring
function scoreAnomaly(temperature, humidity, pressure) {
    // Weighted anomaly score
    var tempScore = Math.abs(temperature - 25) / 50;
    var humidScore = Math.abs(humidity - 50) / 50;
    var pressScore = Math.abs(pressure - 1013) / 100;

    return (tempScore * 0.4) + (humidScore * 0.3) + (pressScore * 0.3);
}
```

### Step 2: Azure Function as UDF

```python
# function_app.py
import azure.functions as func
import json

app = func.FunctionApp()

@app.function_name("EnrichWithGeolocation")
@app.route(route="enrich", methods=["POST"])
async def enrich_with_geolocation(req: func.HttpRequest) -> func.HttpResponse:
    """UDF to enrich events with geolocation from IP."""

    try:
        records = req.get_json()
        enriched = []

        for record in records:
            ip = record.get("ip_address")
            if ip:
                # Call geolocation API
                geo_data = await lookup_geolocation(ip)
                record["country"] = geo_data.get("country")
                record["city"] = geo_data.get("city")
                record["latitude"] = geo_data.get("lat")
                record["longitude"] = geo_data.get("lon")

            enriched.append(record)

        return func.HttpResponse(
            json.dumps(enriched),
            mimetype="application/json"
        )

    except Exception as e:
        return func.HttpResponse(str(e), status_code=500)
```

### Step 3: Stream Analytics Query with UDF

```sql
-- Register the function
CREATE FUNCTION EnrichLocation AS
RETURNS RECORD(
    country NVARCHAR(100),
    city NVARCHAR(100),
    latitude FLOAT,
    longitude FLOAT
)
WITH (
    FUNCTION_TYPE = 'AzureMLService',
    ENDPOINT = 'https://myfunc.azurewebsites.net/api/enrich'
)

-- Use the UDF
SELECT
    device_id,
    temperature,
    ip_address,
    EnrichLocation(ip_address).country AS country,
    EnrichLocation(ip_address).city AS city,
    EnrichLocation(ip_address).latitude AS lat,
    EnrichLocation(ip_address).longitude AS lon,
    System.Timestamp() AS event_time
INTO [enriched-output]
FROM [iot-input]
```

### Step 4: Function Output for Custom Destinations

```python
@app.function_name("CustomOutput")
@app.route(route="output", methods=["POST"])
async def custom_output(req: func.HttpRequest) -> func.HttpResponse:
    """Custom output adapter for Stream Analytics."""

    records = req.get_json()

    # Write to multiple destinations
    tasks = [
        write_to_redis(records),
        write_to_elasticsearch(records),
        send_to_kafka(records)
    ]

    await asyncio.gather(*tasks)

    return func.HttpResponse("OK", status_code=200)

async def write_to_redis(records):
    """Cache latest values in Redis."""
    import aioredis

    redis = await aioredis.from_url(os.environ["REDIS_URL"])

    for record in records:
        key = f"device:{record['device_id']}:latest"
        await redis.hset(key, mapping={
            "temperature": record["temperature"],
            "timestamp": record["event_time"]
        })
        await redis.expire(key, 3600)  # 1 hour TTL

async def write_to_elasticsearch(records):
    """Index for search and analytics."""
    from elasticsearch import AsyncElasticsearch

    es = AsyncElasticsearch([os.environ["ES_URL"]])

    actions = [
        {
            "_index": "iot-events",
            "_source": record
        }
        for record in records
    ]

    await helpers.async_bulk(es, actions)

async def send_to_kafka(records):
    """Forward to Kafka for additional processing."""
    from aiokafka import AIOKafkaProducer

    producer = AIOKafkaProducer(bootstrap_servers=os.environ["KAFKA_BROKERS"])
    await producer.start()

    for record in records:
        await producer.send_and_wait(
            "iot-events",
            json.dumps(record).encode()
        )

    await producer.stop()
```

### Step 5: ML Model Integration

```python
@app.function_name("AnomalyDetection")
@app.route(route="anomaly", methods=["POST"])
async def detect_anomalies(req: func.HttpRequest) -> func.HttpResponse:
    """ML model inference for anomaly detection."""

    import joblib
    import numpy as np

    # Load model (cached in memory)
    model = load_model()

    records = req.get_json()
    results = []

    for record in records:
        features = np.array([[
            record["temperature"],
            record["humidity"],
            record["pressure"]
        ]])

        # Predict
        is_anomaly = model.predict(features)[0]
        anomaly_score = model.decision_function(features)[0]

        results.append({
            **record,
            "is_anomaly": bool(is_anomaly == -1),
            "anomaly_score": float(anomaly_score)
        })

    return func.HttpResponse(
        json.dumps(results),
        mimetype="application/json"
    )

# Cache model in memory
_model = None
def load_model():
    global _model
    if _model is None:
        from azure.storage.blob import BlobClient
        blob = BlobClient.from_connection_string(
            os.environ["STORAGE_CONNECTION"],
            "models",
            "anomaly_detector.pkl"
        )
        model_bytes = blob.download_blob().readall()
        _model = joblib.loads(model_bytes)
    return _model
```

### Step 6: Stream Analytics Query with ML

```sql
-- Use ML function
WITH AnomalyScored AS (
    SELECT
        device_id,
        temperature,
        humidity,
        pressure,
        UDF.AnomalyDetection(temperature, humidity, pressure) AS anomaly
    FROM [iot-input]
)
SELECT
    device_id,
    temperature,
    humidity,
    pressure,
    anomaly.is_anomaly,
    anomaly.anomaly_score,
    System.Timestamp() AS event_time
INTO [ml-output]
FROM AnomalyScored
WHERE anomaly.is_anomaly = true
```

---

## Performance Optimization

```python
# Batch processing for efficiency
@app.function_name("BatchProcessor")
@app.route(route="batch", methods=["POST"])
async def batch_processor(req: func.HttpRequest) -> func.HttpResponse:
    """Process records in batches for efficiency."""

    records = req.get_json()

    # Process in chunks
    chunk_size = 100
    results = []

    for i in range(0, len(records), chunk_size):
        chunk = records[i:i + chunk_size]
        chunk_results = await process_chunk(chunk)
        results.extend(chunk_results)

    return func.HttpResponse(json.dumps(results), mimetype="application/json")
```

---

## Related Documentation

- [ASA + Event Grid](stream-analytics-eventgrid.md)
- [EventHub + Stream Analytics](eventhub-stream-analytics.md)
- [ML Deployment Patterns](../../03-architecture-patterns/ml-patterns/model-deployment.md)

---

*Last Updated: January 2025*
