---
title: "Tutorial 5: Real-time Streaming Ingestion"
description: "__Build real-time data ingestion pipelines using Azure Event Hubs and Spark Structured Streaming. Process streaming data with low latency and integrate with batch processing layers.__"
tags:
  - tutorials
  - synapse
---
# ⚡ Tutorial 5: Real-time Streaming Ingestion

![Tutorial](https://img.shields.io/badge/Tutorial-05_Streaming_Ingestion-blue)
![Duration](https://img.shields.io/badge/Duration-30_minutes-green)
![Level](https://img.shields.io/badge/Level-Intermediate-yellow)

__Build real-time data ingestion pipelines using Azure Event Hubs and Spark Structured Streaming. Process streaming data with low latency and integrate with batch processing layers.__

## 🎯 Learning Objectives

After completing this tutorial, you will be able to:

- ✅ __Set up Azure Event Hubs__ for streaming data ingestion
- ✅ __Configure Kafka integration__ for high-throughput scenarios
- ✅ __Build Spark Structured Streaming__ applications
- ✅ __Implement stream processing__ with windowing and aggregations
- ✅ __Write to Delta Lake__ for unified batch and streaming

## ⏱️ Time Estimate: 30 minutes

- __Event Hub Setup__: 10 minutes
- __Spark Streaming Application__: 15 minutes
- __Testing & Monitoring__: 5 minutes

## 📋 Prerequisites

### __Completed Tutorials__

- [x] [Tutorial 1: Environment Setup](01-environment-setup.md)
- [x] [Tutorial 2: Workspace Basics](02-workspace-basics.md)
- [x] [Tutorial 3: Data Lake Setup](03-data-lake-setup.md)
- [x] [Tutorial 4: Batch Ingestion](04-batch-ingestion.md)

### __Required Resources__

- [ ] Synapse workspace with Spark pool
- [ ] ADLS Gen2 storage configured
- [ ] Azure subscription with Event Hubs quota

### __Verify Prerequisites__

```powershell
# Load workspace configuration
$config = Get-Content "workspace-config.json" | ConvertFrom-Json

# Verify Spark pool exists
az synapse spark pool show `
  --name "sparksmall" `
  --workspace-name $config.WorkspaceName `
  --resource-group $config.ResourceGroup
```

## 🔧 Step 1: Create Event Hub Namespace

### __1.1 Provision Event Hub Namespace__

```powershell
# Load naming convention
$naming = Get-Content "naming-convention.json" | ConvertFrom-Json

# Create Event Hub namespace
$eventHubNamespace = "eh-$($naming.SynapseWorkspace)-ns"

az eventhubs namespace create `
  --name $eventHubNamespace `
  --resource-group $naming.ResourceGroupName `
  --location $naming.Location `
  --sku Standard `
  --enable-kafka true `
  --enable-auto-inflate false `
  --tags Project=SynapseTutorial Environment=Learning

Write-Host "✅ Event Hub namespace created: $eventHubNamespace" -ForegroundColor Green
```

### __1.2 Create Event Hub for Transactions__

```powershell
# Create Event Hub for transaction stream
az eventhubs eventhub create `
  --namespace-name $eventHubNamespace `
  --resource-group $naming.ResourceGroupName `
  --name "transactions-stream" `
  --partition-count 4 `
  --message-retention 1

Write-Host "✅ Event Hub created: transactions-stream" -ForegroundColor Green
```

### __1.3 Configure Access Policy__

```powershell
# Create SAS policy for sending data
az eventhubs eventhub authorization-rule create `
  --namespace-name $eventHubNamespace `
  --resource-group $naming.ResourceGroupName `
  --eventhub-name "transactions-stream" `
  --name "SendPolicy" `
  --rights Send

# Get connection string
$connectionString = az eventhubs eventhub authorization-rule keys list `
  --namespace-name $eventHubNamespace `
  --resource-group $naming.ResourceGroupName `
  --eventhub-name "transactions-stream" `
  --name "SendPolicy" `
  --query primaryConnectionString `
  --output tsv

Write-Host "✅ Connection string retrieved (store securely)" -ForegroundColor Green
```

## 📨 Step 2: Send Test Data to Event Hub

### __2.1 Create Data Generator Script__

```python
# File: event_hub_producer.py
import asyncio
import json
from datetime import datetime
import random
from azure.eventhub.aio import EventHubProducerClient
from azure.eventhub import EventData

# Configuration
CONNECTION_STR = "your-connection-string-here"
EVENTHUB_NAME = "transactions-stream"

async def send_transaction_events():
    """Generate and send transaction events to Event Hub"""

    producer = EventHubProducerClient.from_connection_string(
        conn_str=CONNECTION_STR,
        eventhub_name=EVENTHUB_NAME
    )

    customer_ids = [f"C{str(i).zfill(3)}" for i in range(1, 101)]
    categories = ["Electronics", "Books", "Clothing", "Home", "Sports"]

    async with producer:
        # Generate 100 transactions
        event_data_batch = await producer.create_batch()

        for i in range(100):
            transaction = {
                "transaction_id": f"T{str(i+1).zfill(6)}",
                "customer_id": random.choice(customer_ids),
                "amount": round(random.uniform(10.0, 500.0), 2),
                "category": random.choice(categories),
                "timestamp": datetime.utcnow().isoformat(),
                "location": random.choice(["US", "UK", "EU", "APAC"]),
                "payment_method": random.choice(["Credit", "Debit", "PayPal"])
            }

            event_data_batch.add(EventData(json.dumps(transaction)))

            if len(event_data_batch) == 10:
                await producer.send_batch(event_data_batch)
                print(f"Sent batch of {len(event_data_batch)} events")
                event_data_batch = await producer.create_batch()

        # Send remaining events
        if len(event_data_batch) > 0:
            await producer.send_batch(event_data_batch)
            print(f"Sent final batch of {len(event_data_batch)} events")

    print(f"✅ Successfully sent 100 transaction events")

# Run the producer
if __name__ == "__main__":
    asyncio.run(send_transaction_events())
```

### __2.2 Execute Data Generator__

```powershell
# Install required Python packages
pip install azure-eventhub aiohttp

# Update connection string in script
(Get-Content "event_hub_producer.py") -replace "your-connection-string-here", $connectionString | Set-Content "event_hub_producer.py"

# Run producer
python event_hub_producer.py

Write-Host "✅ Test data sent to Event Hub" -ForegroundColor Green
```

## ⚡ Step 3: Create Spark Structured Streaming Application

### __3.1 Create Streaming Notebook__

**Via Synapse Studio**:

```text
1. Navigate to Develop → + → Notebook
2. Name: "StreamingIngestion"
3. Attach to: sparksmall (Spark pool)
4. Language: PySpark
```

### __3.2 Configure Event Hub Connection__

```python
# Cell 1: Import libraries and configure Event Hub connection
from pyspark.sql import SparkSession
from pyspark.sql.functions import *
from pyspark.sql.types import *

# Event Hub configuration
EVENT_HUB_NAMESPACE = "eh-synapse-ns"
EVENT_HUB_NAME = "transactions-stream"
CONNECTION_STRING = "your-connection-string-here"

# Event Hub connection configuration
ehConf = {
    "eventhubs.connectionString": sc._jvm.org.apache.spark.eventhubs.EventHubsUtils.encrypt(CONNECTION_STRING),
    "eventhubs.consumerGroup": "$Default",
    "eventhubs.startingPosition": json.dumps({"offset": "-1", "seqNo": -1, "enqueuedTime": None, "isInclusive": True})
}

print("✅ Event Hub configuration loaded")
```

### __3.3 Read Streaming Data__

```python
# Cell 2: Create streaming DataFrame
# Read from Event Hub
streaming_df = (spark
    .readStream
    .format("eventhubs")
    .options(**ehConf)
    .load()
)

# Display schema
streaming_df.printSchema()

# Parse JSON body
transaction_schema = StructType([
    StructField("transaction_id", StringType(), True),
    StructField("customer_id", StringType(), True),
    StructField("amount", DoubleType(), True),
    StructField("category", StringType(), True),
    StructField("timestamp", TimestampType(), True),
    StructField("location", StringType(), True),
    StructField("payment_method", StringType(), True)
])

# Extract and parse transaction data
transactions = (streaming_df
    .withColumn("body_string", col("body").cast("string"))
    .withColumn("transaction", from_json(col("body_string"), transaction_schema))
    .select(
        col("transaction.*"),
        col("enqueuedTime").alias("ingestion_time"),
        col("offset"),
        col("sequenceNumber")
    )
)

print("✅ Streaming DataFrame created")
```

### __3.4 Apply Transformations__

```python
# Cell 3: Transform streaming data
# Add processing timestamp
enriched_transactions = (transactions
    .withColumn("processing_time", current_timestamp())
    .withColumn("processing_date", to_date(col("timestamp")))
    .withColumn("amount_usd", col("amount"))  # Assume USD, would convert in production
)

# Calculate running statistics
transaction_stats = (enriched_transactions
    .groupBy(
        window(col("timestamp"), "5 minutes"),
        col("category")
    )
    .agg(
        count("*").alias("transaction_count"),
        sum("amount").alias("total_amount"),
        avg("amount").alias("avg_amount"),
        max("amount").alias("max_amount")
    )
)

print("✅ Transformations applied")
```

## 💾 Step 4: Write to Delta Lake

### __4.1 Configure Delta Lake Sink__

```python
# Cell 4: Write streaming data to Delta Lake
# Define checkpoint location
checkpoint_location = f"abfss://raw@{storage_account}.dfs.core.windows.net/checkpoints/transactions-stream"
delta_table_path = f"abfss://raw@{storage_account}.dfs.core.windows.net/transactions-streaming/"

# Write stream to Delta Lake
query = (enriched_transactions
    .writeStream
    .format("delta")
    .outputMode("append")
    .option("checkpointLocation", checkpoint_location)
    .option("mergeSchema", "true")
    .start(delta_table_path)
)

print(f"✅ Streaming to Delta Lake")
print(f"Query ID: {query.id}")
print(f"Status: {query.status}")
```

### __4.2 Write Aggregations to Console (for monitoring)__

```python
# Cell 5: Display real-time statistics
stats_query = (transaction_stats
    .writeStream
    .outputMode("complete")
    .format("console")
    .option("truncate", "false")
    .option("numRows", 20)
    .start()
)

# Let it run for 30 seconds
import time
time.sleep(30)

# Stop the query
stats_query.stop()

print("✅ Statistics displayed")
```

## 🔄 Step 5: Implement Kafka Integration

### __5.1 Configure Kafka Endpoint__

```python
# Cell 6: Connect using Kafka protocol (Event Hubs Kafka endpoint)
kafka_bootstrap_servers = f"{EVENT_HUB_NAMESPACE}.servicebus.windows.net:9093"

# Kafka configuration
kafka_options = {
    "kafka.bootstrap.servers": kafka_bootstrap_servers,
    "subscribe": EVENT_HUB_NAME,
    "kafka.sasl.mechanism": "PLAIN",
    "kafka.security.protocol": "SASL_SSL",
    "kafka.sasl.jaas.config": f'org.apache.kafka.common.security.plain.PlainLoginModule required username="$ConnectionString" password="{CONNECTION_STRING}";',
    "kafka.request.timeout.ms": "60000",
    "kafka.session.timeout.ms": "30000",
    "failOnDataLoss": "false",
    "startingOffsets": "earliest"
}

# Read from Event Hub using Kafka
kafka_stream = (spark
    .readStream
    .format("kafka")
    .options(**kafka_options)
    .load()
)

print("✅ Kafka stream configured")
```

### __5.2 Process Kafka Messages__

```python
# Cell 7: Parse Kafka messages
kafka_transactions = (kafka_stream
    .selectExpr("CAST(value AS STRING) as json_string")
    .withColumn("transaction", from_json(col("json_string"), transaction_schema))
    .select("transaction.*")
)

# Write to Delta with deduplication
dedupe_checkpoint = f"abfss://raw@{storage_account}.dfs.core.windows.net/checkpoints/kafka-dedupe"

kafka_query = (kafka_transactions
    .writeStream
    .format("delta")
    .outputMode("append")
    .option("checkpointLocation", dedupe_checkpoint)
    .option("mergeSchema", "true")
    .trigger(processingTime="10 seconds")  # Micro-batch every 10 seconds
    .start(delta_table_path)
)

print("✅ Kafka stream processing started")
```

## 📊 Step 6: Monitor Streaming Queries

### __6.1 Check Query Status__

```python
# Cell 8: Monitor active streams
# List all active streaming queries
active_streams = spark.streams.active

for stream in active_streams:
    print(f"Query ID: {stream.id}")
    print(f"Name: {stream.name}")
    print(f"Status: {stream.status}")
    print(f"Recent Progress:")
    print(stream.lastProgress)
    print("-" * 80)
```

### __6.2 Query Streaming Metrics__

```python
# Cell 9: Get detailed metrics
def print_stream_metrics(query):
    """Print detailed streaming query metrics"""
    status = query.status
    progress = query.lastProgress

    if progress:
        print(f"Input Rate: {progress.get('inputRowsPerSecond', 0)} rows/sec")
        print(f"Processing Rate: {progress.get('processedRowsPerSecond', 0)} rows/sec")
        print(f"Batch Duration: {progress.get('batchDuration', 0)} ms")
        print(f"Total Input Rows: {progress.get('numInputRows', 0)}")

    print(f"Running: {status.get('isDataAvailable', False)}")
    print(f"Trigger: {status.get('trigger', 'N/A')}")

# Monitor main query
print_stream_metrics(query)
```

### __6.3 Access Streaming Data__

```sql
-- Cell 10: Query streaming Delta table
-- Switch to SQL

SELECT
    category,
    location,
    COUNT(*) as transaction_count,
    SUM(amount) as total_revenue,
    AVG(amount) as avg_transaction_value
FROM delta.`abfss://raw@{storage_account}.dfs.core.windows.net/transactions-streaming/`
WHERE processing_date = CURRENT_DATE()
GROUP BY category, location
ORDER BY total_revenue DESC;
```

## 🎯 Step 7: Implement Windowed Aggregations

### __7.1 Tumbling Window Aggregations__

```python
# Cell 11: 5-minute tumbling windows
tumbling_agg = (enriched_transactions
    .withWatermark("timestamp", "10 minutes")
    .groupBy(
        window(col("timestamp"), "5 minutes"),
        col("category")
    )
    .agg(
        count("*").alias("txn_count"),
        sum("amount").alias("total_amount"),
        avg("amount").alias("avg_amount")
    )
    .select(
        col("window.start").alias("window_start"),
        col("window.end").alias("window_end"),
        col("category"),
        col("txn_count"),
        col("total_amount"),
        col("avg_amount")
    )
)

# Write to Delta
tumbling_checkpoint = f"abfss://curated@{storage_account}.dfs.core.windows.net/checkpoints/tumbling-agg"
tumbling_output = f"abfss://curated@{storage_account}.dfs.core.windows.net/transaction-analytics/by-category/"

tumbling_query = (tumbling_agg
    .writeStream
    .format("delta")
    .outputMode("append")
    .option("checkpointLocation", tumbling_checkpoint)
    .trigger(processingTime="1 minute")
    .start(tumbling_output)
)

print("✅ Tumbling window aggregation running")
```

### __7.2 Sliding Window Aggregations__

```python
# Cell 12: 10-minute sliding windows, sliding every 5 minutes
sliding_agg = (enriched_transactions
    .withWatermark("timestamp", "10 minutes")
    .groupBy(
        window(col("timestamp"), "10 minutes", "5 minutes"),
        col("location")
    )
    .agg(
        count("*").alias("txn_count"),
        sum("amount").alias("revenue")
    )
)

# Display to console
sliding_query = (sliding_agg
    .writeStream
    .outputMode("complete")
    .format("console")
    .start()
)

print("✅ Sliding window aggregation started")
```

## ✅ Step 8: Validate and Test

### __8.1 Verification Script__

```powershell
# Check Event Hub message count
az eventhubs eventhub show `
  --namespace-name $eventHubNamespace `
  --resource-group $naming.ResourceGroupName `
  --name "transactions-stream" `
  --query "status" `
  --output tsv

Write-Host "✅ Event Hub status verified" -ForegroundColor Green
```

### __8.2 Query Streaming Results__

```sql
-- Verify data in Delta Lake
SELECT
    COUNT(*) as total_records,
    MIN(timestamp) as earliest_transaction,
    MAX(timestamp) as latest_transaction,
    COUNT(DISTINCT customer_id) as unique_customers,
    SUM(amount) as total_revenue
FROM delta.`abfss://raw@{storage_account}.dfs.core.windows.net/transactions-streaming/`;
```

## 💡 Key Concepts Review

### __Streaming vs Batch__

| Aspect | Batch Processing | Stream Processing |
|--------|-----------------|-------------------|
| **Latency** | Minutes to hours | Seconds to minutes |
| **Data Volume** | Large datasets | Continuous flow |
| **Complexity** | Simpler | More complex |
| **Use Cases** | Historical analysis | Real-time insights |
| **Cost** | Lower (scheduled) | Higher (always-on) |

### __Event Hub Best Practices__

- ✅ Use appropriate partition count (4-32 for most workloads)
- ✅ Enable Kafka protocol for ecosystem compatibility
- ✅ Implement checkpointing for fault tolerance
- ✅ Monitor consumer lag regularly
- ✅ Use Auto Inflate for variable workloads

### __Spark Structured Streaming Concepts__

- **Watermarks**: Handle late-arriving data
- **Triggers**: Control micro-batch frequency
- **Checkpoints**: Enable fault-tolerant recovery
- **Output Modes**: Append, Complete, Update
- **Stateful Operations**: Aggregations, joins, deduplication

## 🎉 Congratulations

You've successfully built real-time streaming pipelines. Your solution now includes:

- ✅ __Event Hub namespace__ configured for streaming
- ✅ __Spark Structured Streaming__ applications
- ✅ __Delta Lake integration__ for unified storage
- ✅ __Windowed aggregations__ for time-series analysis
- ✅ __Kafka compatibility__ for ecosystem integration

## 🚀 What's Next?

**Continue to Tutorial 6**: [Spark Pool Configuration](06-spark-pools.md)

In the next tutorial, you'll:

- Optimize Spark pool sizing and configuration
- Implement auto-scaling strategies
- Tune Spark performance parameters
- Monitor resource utilization

## 💬 Troubleshooting

### __Common Issues and Solutions__

**Issue**: Connection timeout to Event Hub

```python
# Increase timeout settings
ehConf["eventhubs.connectionTimeout"] = "120s"
ehConf["eventhubs.operationTimeout"] = "120s"
```

**Issue**: Streaming query fails with checkpoint errors

```python
# Clear checkpoint and restart
dbutils.fs.rm(checkpoint_location, True)
# Restart streaming query
```

**Issue**: High latency in stream processing

```python
# Reduce micro-batch interval
.trigger(processingTime="5 seconds")  # Instead of default 500ms

# Increase parallelism
spark.conf.set("spark.sql.shuffle.partitions", "16")
```

---

__Tutorial Progress__: 5 of 14 completed
__Next__: [06. Spark Pools →](06-spark-pools.md)
__Time Investment__: 30 minutes ✅

*Real-time streaming complements batch processing. Master both for complete data solutions.*
