# Event Hubs Integration with Databricks

> __[Home](../../../README.md)__ | __[Implementation](../README.md)__ | __[Integration](README.md)__ | __EventHub + Databricks__

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)

Stream processing from Azure Event Hubs using Databricks Structured Streaming.

---

## Overview

This pattern enables real-time data processing from Event Hubs using Spark Structured Streaming, ideal for:

- Real-time ML feature engineering
- IoT data processing
- Clickstream analytics
- Log aggregation

---

## Implementation

### Step 1: Configure Event Hubs Connection

```python
# Connection configuration
eventhub_config = {
    "eventhubs.connectionString": sc._jvm.org.apache.spark.eventhubs.EventHubsUtils.encrypt(
        "Endpoint=sb://myhub.servicebus.windows.net/;SharedAccessKeyName=listen;SharedAccessKey=xxx;EntityPath=events"
    ),
    "eventhubs.consumerGroup": "$Default",
    "eventhubs.startingPosition": json.dumps({"offset": "-1", "seqNo": -1, "enqueuedTime": None, "isInclusive": True})
}
```

### Step 2: Create Streaming Reader

```python
from pyspark.sql.functions import *
from pyspark.sql.types import *

# Define schema for event body
event_schema = StructType([
    StructField("device_id", StringType(), True),
    StructField("timestamp", TimestampType(), True),
    StructField("temperature", DoubleType(), True),
    StructField("humidity", DoubleType(), True),
    StructField("location", StringType(), True)
])

# Read from Event Hubs
stream_df = spark.readStream \
    .format("eventhubs") \
    .options(**eventhub_config) \
    .load()

# Parse event body
parsed_df = stream_df \
    .withColumn("body", col("body").cast("string")) \
    .withColumn("event", from_json(col("body"), event_schema)) \
    .select(
        col("event.*"),
        col("enqueuedTime").alias("event_time"),
        col("offset"),
        col("sequenceNumber")
    )
```

### Step 3: Stream Processing

```python
from pyspark.sql.functions import window

# Windowed aggregations
windowed_stats = parsed_df \
    .withWatermark("event_time", "10 minutes") \
    .groupBy(
        window(col("event_time"), "5 minutes", "1 minute"),
        col("device_id")
    ) \
    .agg(
        avg("temperature").alias("avg_temp"),
        max("temperature").alias("max_temp"),
        min("temperature").alias("min_temp"),
        count("*").alias("reading_count")
    )

# Anomaly detection
anomalies = parsed_df \
    .filter(
        (col("temperature") > 100) |
        (col("temperature") < -40) |
        (col("humidity") > 100)
    ) \
    .withColumn("anomaly_type",
        when(col("temperature") > 100, "HIGH_TEMP")
        .when(col("temperature") < -40, "LOW_TEMP")
        .otherwise("INVALID_HUMIDITY")
    )
```

### Step 4: Write to Delta Lake

```python
# Write aggregates to Delta
agg_query = windowed_stats.writeStream \
    .format("delta") \
    .outputMode("append") \
    .option("checkpointLocation", "/checkpoints/iot_aggregates") \
    .trigger(processingTime="1 minute") \
    .toTable("silver.iot.device_stats")

# Write anomalies with alert trigger
def process_anomalies(batch_df, batch_id):
    if batch_df.count() > 0:
        # Write to Delta
        batch_df.write.format("delta").mode("append").saveAsTable("silver.iot.anomalies")

        # Send alerts
        alerts = batch_df.select("device_id", "anomaly_type", "event_time").collect()
        for alert in alerts:
            send_alert(alert.device_id, alert.anomaly_type)

anomaly_query = anomalies.writeStream \
    .foreachBatch(process_anomalies) \
    .option("checkpointLocation", "/checkpoints/anomalies") \
    .trigger(processingTime="30 seconds") \
    .start()
```

### Step 5: Feature Engineering for ML

```python
from databricks.feature_engineering import FeatureEngineeringClient

fe = FeatureEngineeringClient()

def compute_features(batch_df, batch_id):
    """Compute real-time features for ML models."""

    features = batch_df.groupBy("device_id").agg(
        avg("temperature").alias("temp_avg_5min"),
        stddev("temperature").alias("temp_stddev_5min"),
        (max("temperature") - min("temperature")).alias("temp_range_5min"),
        count("*").alias("reading_count_5min")
    ).withColumn("feature_timestamp", current_timestamp())

    # Update feature table
    fe.write_table(
        name="ml.features.device_realtime",
        df=features,
        mode="merge"
    )

# Stream features
feature_query = parsed_df \
    .withWatermark("event_time", "5 minutes") \
    .writeStream \
    .foreachBatch(compute_features) \
    .option("checkpointLocation", "/checkpoints/features") \
    .trigger(processingTime="5 minutes") \
    .start()
```

---

## Configuration Options

### Consumer Settings

```python
advanced_config = {
    "eventhubs.connectionString": encrypted_conn_string,
    "eventhubs.consumerGroup": "databricks-consumer",
    "maxEventsPerTrigger": 10000,  # Batch size
    "eventhubs.receiverTimeout": "PT60S",  # 60 second timeout
    "eventhubs.operationTimeout": "PT120S"
}
```

### Checkpoint Management

```python
# Restart from specific position
start_position = {
    "offset": "1000",
    "seqNo": -1,
    "enqueuedTime": None,
    "isInclusive": True
}

# Or from timestamp
start_position = {
    "offset": None,
    "seqNo": -1,
    "enqueuedTime": "2024-01-01T00:00:00.000Z",
    "isInclusive": True
}
```

---

## Monitoring

```python
# Monitor streaming queries
for query in spark.streams.active:
    print(f"Query: {query.name}")
    print(f"  Status: {query.status}")
    print(f"  Recent Progress: {query.recentProgress}")
```

---

## Related Documentation

- [EventHub + Functions](eventhub-functions.md)
- [EventHub + Stream Analytics](eventhub-stream-analytics.md)
- [Streaming Architectures](../../03-architecture-patterns/streaming-architectures/README.md)

---

*Last Updated: January 2025*
