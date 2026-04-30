# Streaming Migration: Kinesis and MSK to Event Hubs

**A deep-dive guide for data engineers migrating Amazon Kinesis and Managed Streaming for Apache Kafka (MSK) to Azure Event Hubs and related streaming services.**

---

## Executive summary

AWS streaming is split across two service families: Kinesis (Data Streams, Firehose, Analytics) for managed streaming, and MSK for Apache Kafka workloads. Azure Event Hubs serves both roles --- it provides a native streaming service with an AMQP protocol and simultaneously exposes a Kafka-compatible endpoint that allows existing Kafka clients to connect with a configuration change.

The migration strategy depends on the source: Kinesis workloads typically re-architect to Event Hubs native APIs, while MSK workloads can lift-and-shift to Event Hubs Kafka protocol with minimal code changes. Both paths land data on Delta Lake tables for analytics via Databricks Structured Streaming or Fabric Real-Time Intelligence.

---

## Service mapping overview

| AWS streaming service          | Azure equivalent                                  | Migration complexity | Notes                               |
| ------------------------------ | ------------------------------------------------- | -------------------- | ----------------------------------- |
| Kinesis Data Streams           | Event Hubs                                        | M                    | Shard model maps to partition model |
| Kinesis Data Firehose          | Event Hubs Capture / ADF                          | S                    | Managed delivery to storage         |
| Kinesis Data Analytics (SQL)   | Stream Analytics                                  | M                    | SQL-based stream processing         |
| Kinesis Data Analytics (Flink) | Databricks Structured Streaming / HDInsight Flink | L                    | Flink stateful processing           |
| MSK (Managed Kafka)            | Event Hubs with Kafka protocol                    | M                    | Config change for Kafka clients     |
| MSK Connect                    | Event Hubs + ADF connectors                       | M                    | Connector-dependent                 |
| MSK Serverless                 | Event Hubs (auto-inflate)                         | S                    | Serverless scaling                  |
| Lambda (stream consumer)       | Azure Functions (Event Hub trigger)               | M                    | Function-level rewrite              |

---

## Part 1: Kinesis Data Streams to Event Hubs

### Architecture comparison

| Concept          | Kinesis Data Streams                    | Event Hubs                                                |
| ---------------- | --------------------------------------- | --------------------------------------------------------- |
| Stream           | Stream                                  | Event Hub (within a namespace)                            |
| Shard            | Shard (1 MB/s in, 2 MB/s out)           | Partition (1 MB/s in, 2 MB/s out)                         |
| Partition key    | Partition key (MD5 hash to shard)       | Partition key (hash to partition)                         |
| Retention        | 24h default, up to 365 days             | 1-90 days (standard), unlimited (Dedicated)               |
| Consumer         | KCL application or Lambda               | Consumer group (AMQP) or Kafka consumer                   |
| Enhanced fan-out | Dedicated 2 MB/s per consumer per shard | $default consumer group (shared) or Kafka consumer groups |
| Sequence number  | Per-shard sequence number               | Offset + sequence number per partition                    |
| Capacity mode    | On-demand or provisioned shards         | Auto-inflate (standard) or Dedicated (CU-based)           |

### Capacity mapping

| Kinesis provisioned | Event Hubs equivalent      | Throughput                   |
| ------------------- | -------------------------- | ---------------------------- |
| 1 shard             | 1 TU (Throughput Unit)     | 1 MB/s in, 2 MB/s out        |
| 10 shards           | 10 TUs or 1 PU (Premium)   | 10 MB/s in, 20 MB/s out      |
| 100 shards          | 10 PUs or 1 CU (Dedicated) | 100 MB/s in, 200 MB/s out    |
| On-demand (auto)    | Auto-inflate enabled       | Up to 40 TUs auto (standard) |

### Producer migration

**Kinesis producer (Python/boto3):**

```python
import boto3
import json

kinesis = boto3.client('kinesis', region_name='us-gov-west-1')

def send_event(stream_name, event_data, partition_key):
    response = kinesis.put_record(
        StreamName=stream_name,
        Data=json.dumps(event_data).encode('utf-8'),
        PartitionKey=partition_key
    )
    return response['SequenceNumber']

# Send batch
records = [
    {'Data': json.dumps(event).encode('utf-8'), 'PartitionKey': event['device_id']}
    for event in events
]
kinesis.put_records(StreamName='iot-events', Records=records)
```

**Event Hubs producer (Python/azure-eventhub):**

```python
from azure.eventhub import EventHubProducerClient, EventData
from azure.identity import DefaultAzureCredential
import json

credential = DefaultAzureCredential()
producer = EventHubProducerClient(
    fully_qualified_namespace="acme-streaming.servicebus.usgovcloudapi.net",
    eventhub_name="iot-events",
    credential=credential
)

def send_event(event_data, partition_key):
    event_data_batch = producer.create_batch(partition_key=partition_key)
    event_data_batch.add(EventData(json.dumps(event_data)))
    producer.send_batch(event_data_batch)

# Send batch
with producer:
    batch = producer.create_batch()
    for event in events:
        batch.add(EventData(json.dumps(event)))
    producer.send_batch(batch)
```

### Consumer migration

**Kinesis consumer (KCL pattern):**

```python
import boto3

kinesis = boto3.client('kinesis')

# Get shard iterator
response = kinesis.get_shard_iterator(
    StreamName='iot-events',
    ShardId='shardId-000000000000',
    ShardIteratorType='LATEST'
)
shard_iterator = response['ShardIterator']

# Poll for records
while True:
    response = kinesis.get_records(ShardIterator=shard_iterator, Limit=100)
    for record in response['Records']:
        process_record(record['Data'])
    shard_iterator = response['NextShardIterator']
```

**Event Hubs consumer (EventProcessorClient pattern):**

```python
from azure.eventhub import EventHubConsumerClient
from azure.eventhub.extensions.checkpointstoreblob import BlobCheckpointStore
from azure.identity import DefaultAzureCredential

credential = DefaultAzureCredential()

checkpoint_store = BlobCheckpointStore(
    blob_account_url="https://acmecheckpoints.blob.core.usgovcloudapi.net",
    container_name="checkpoints",
    credential=credential
)

consumer = EventHubConsumerClient(
    fully_qualified_namespace="acme-streaming.servicebus.usgovcloudapi.net",
    eventhub_name="iot-events",
    consumer_group="$Default",
    credential=credential,
    checkpoint_store=checkpoint_store
)

def on_event(partition_context, event):
    process_record(event.body_as_json())
    partition_context.update_checkpoint(event)

with consumer:
    consumer.receive(on_event=on_event, starting_position="-1")
```

---

## Part 2: Kinesis Data Firehose to Event Hubs Capture

### Architecture comparison

| Firehose capability         | Event Hubs Capture / ADF                  | Notes                                   |
| --------------------------- | ----------------------------------------- | --------------------------------------- |
| Delivery to S3              | Event Hubs Capture to ADLS Gen2           | Automatic Avro file writing             |
| Delivery to Redshift        | ADF pipeline from Event Hub to Databricks | Via staging on ADLS                     |
| Delivery to Elasticsearch   | ADF or Azure Function to Azure AI Search  | Custom pipeline                         |
| Format conversion (Parquet) | Databricks Auto Loader (Parquet/Delta)    | Capture writes Avro; convert downstream |
| Dynamic partitioning        | Capture partitions by time (hour/minute)  | Custom partitioning via Databricks      |
| Data transformation         | Stream Analytics or Azure Functions       | Inline transformation                   |
| Buffering (size/time)       | Capture window (1-15 min, 10-300 MB)      | Similar buffering controls              |

### Event Hubs Capture configuration

```json
{
    "properties": {
        "captureDescription": {
            "enabled": true,
            "encoding": "Avro",
            "intervalInSeconds": 300,
            "sizeLimitInBytes": 314572800,
            "destination": {
                "name": "EventHubArchive.AzureBlockBlob",
                "properties": {
                    "storageAccountResourceId": "/subscriptions/.../storageAccounts/acmeanalyticsgov",
                    "blobContainer": "streaming-raw",
                    "archiveNameFormat": "{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}"
                }
            }
        }
    }
}
```

### Landing captured data as Delta tables

```python
# Databricks Auto Loader: read Capture Avro files, write Delta
(spark.readStream
  .format("cloudFiles")
  .option("cloudFiles.format", "avro")
  .option("cloudFiles.schemaLocation", "dbfs:/schemas/iot_events")
  .load("abfss://streaming-raw@acmeanalyticsgov.dfs.core.usgovcloudapi.net/acme-streaming/iot-events/")
  .writeStream
  .format("delta")
  .option("checkpointLocation", "dbfs:/checkpoints/iot_events")
  .trigger(processingTime="1 minute")
  .toTable("iot_prod.bronze.raw_events"))
```

---

## Part 3: Kinesis Data Analytics to Stream Analytics

### SQL-based stream processing migration

**Kinesis Analytics SQL:**

```sql
-- Kinesis Analytics application
CREATE OR REPLACE STREAM "DESTINATION_STREAM" (
    device_id VARCHAR(64),
    window_start TIMESTAMP,
    avg_temperature DOUBLE,
    max_temperature DOUBLE,
    event_count INTEGER
);

CREATE OR REPLACE PUMP "AGGREGATE_PUMP" AS
INSERT INTO "DESTINATION_STREAM"
SELECT STREAM
    "device_id",
    STEP("SOURCE_STREAM".ROWTIME BY INTERVAL '5' MINUTE) AS window_start,
    AVG("temperature") AS avg_temperature,
    MAX("temperature") AS max_temperature,
    COUNT(*) AS event_count
FROM "SOURCE_STREAM"
GROUP BY
    "device_id",
    STEP("SOURCE_STREAM".ROWTIME BY INTERVAL '5' MINUTE);
```

**Azure Stream Analytics equivalent:**

```sql
-- Stream Analytics job query
SELECT
    device_id,
    System.Timestamp() AS window_start,
    AVG(temperature) AS avg_temperature,
    MAX(temperature) AS max_temperature,
    COUNT(*) AS event_count
INTO [output-delta]
FROM [input-eventhub]
TIMESTAMP BY event_time
GROUP BY
    device_id,
    TumblingWindow(minute, 5)
```

**Stream Analytics input configuration:**

```json
{
    "name": "input-eventhub",
    "properties": {
        "type": "Stream",
        "datasource": {
            "type": "Microsoft.EventHub/EventHubs",
            "properties": {
                "serviceBusNamespace": "acme-streaming",
                "eventHubName": "iot-events",
                "consumerGroupName": "stream-analytics-cg",
                "authenticationMode": "Msi"
            }
        },
        "serialization": { "type": "Json", "encoding": "UTF8" }
    }
}
```

### Fabric Real-Time Intelligence (for complex event processing)

For workloads that exceed Stream Analytics SQL capabilities (complex stateful processing, pattern matching, ML inference on streams):

```kusto
// KQL query in Fabric Real-Time Intelligence (Eventhouse)
IoTEvents
| where ingestion_time() > ago(5m)
| summarize
    avg_temperature = avg(temperature),
    max_temperature = max(temperature),
    event_count = count()
    by device_id, bin(event_time, 5m)
| where max_temperature > 100
| project device_id, window_start = event_time, avg_temperature, max_temperature, event_count
```

---

## Part 4: MSK to Event Hubs with Kafka protocol

### The Kafka compatibility advantage

Event Hubs exposes a Kafka-compatible endpoint. Existing Kafka producers and consumers can connect to Event Hubs by changing only the connection configuration --- no code changes required.

### Kafka client configuration change

**MSK connection (original):**

```properties
# Kafka producer/consumer config for MSK
bootstrap.servers=b-1.acme-msk.abc123.kafka.us-gov-west-1.amazonaws.com:9098,b-2.acme-msk.abc123.kafka.us-gov-west-1.amazonaws.com:9098
security.protocol=SASL_SSL
sasl.mechanism=AWS_MSK_IAM
sasl.jaas.config=software.amazon.msk.auth.iam.IAMLoginModule required;
sasl.client.callback.handler.class=software.amazon.msk.auth.iam.IAMClientCallbackHandler
```

**Event Hubs Kafka endpoint (migrated):**

```properties
# Kafka producer/consumer config for Event Hubs
bootstrap.servers=acme-streaming.servicebus.usgovcloudapi.net:9093
security.protocol=SASL_SSL
sasl.mechanism=PLAIN
sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username="$ConnectionString" password="Endpoint=sb://acme-streaming.servicebus.usgovcloudapi.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=<key>";
```

**That is the entire migration for Kafka producers and consumers.** The application code, serialization format, topic structure, and consumer group logic remain unchanged.

### Topic mapping

| MSK concept     | Event Hubs equivalent  | Notes                                         |
| --------------- | ---------------------- | --------------------------------------------- |
| Topic           | Event Hub              | One topic per Event Hub                       |
| Partition       | Partition              | Same concept; partition count set at creation |
| Consumer group  | Consumer group         | Same concept                                  |
| Offset          | Offset                 | Same concept                                  |
| Retention       | Retention              | 1-90 days (standard); unlimited (Dedicated)   |
| Compaction      | Not supported natively | Use Delta Lake for compacted state            |
| Schema Registry | Azure Schema Registry  | Avro, JSON Schema, Protobuf                   |

### MSK Connect migration

MSK Connect runs Kafka Connect connectors as managed services. On Azure, replace with:

1. **ADF connectors** for source/sink patterns that ADF supports natively (databases, blob storage, REST APIs).
2. **Kafka Connect on AKS** for connectors not available in ADF (deploy Kafka Connect cluster on Azure Kubernetes Service, pointing to Event Hubs Kafka endpoint).
3. **Azure Functions** with Event Hub trigger for custom consumer logic.

---

## Part 5: Lambda consumers to Azure Functions

### Lambda with Kinesis trigger to Azure Function with Event Hub trigger

**AWS Lambda (Kinesis trigger):**

```python
import json
import base64

def lambda_handler(event, context):
    for record in event['Records']:
        payload = base64.b64decode(record['kinesis']['data'])
        data = json.loads(payload)
        process_event(data)
    return {'statusCode': 200}
```

**Azure Function (Event Hub trigger):**

```python
import azure.functions as func
import json
import logging

app = func.FunctionApp()

@app.event_hub_message_trigger(
    arg_name="events",
    event_hub_name="iot-events",
    connection="EventHubConnection",
    consumer_group="functions-cg"
)
def process_iot_events(events: func.EventHubEvent):
    for event in events:
        data = json.loads(event.get_body().decode('utf-8'))
        process_event(data)
        logging.info(f"Processed event from device {data['device_id']}")
```

**Key differences:**

- Lambda receives base64-encoded Kinesis records; Azure Functions receives deserialized Event Hub events.
- Lambda IAM role replaced by managed identity + Event Hubs Data Receiver role.
- Lambda concurrency per shard replaced by Function scaling per partition.

---

## Worked example: full Kinesis pipeline to Event Hubs

### Source architecture (AWS)

```
IoT Devices
  → Kinesis Data Stream (iot-events, 10 shards)
    → Lambda consumer (real-time alerts)
    → Kinesis Firehose → S3 (raw archive)
    → Kinesis Analytics (5-min aggregation) → Kinesis Data Stream (iot-aggregated)
      → Lambda consumer (dashboard update)
```

### Target architecture (Azure)

```
IoT Devices
  → Event Hubs (iot-events, 10 partitions)
    → Azure Function (real-time alerts)
    → Event Hubs Capture → ADLS Gen2 (raw archive)
    → Stream Analytics (5-min aggregation) → Event Hubs (iot-aggregated)
      → Databricks Structured Streaming → Delta table → Power BI Direct Lake
```

### Migration sequence

1. **Create Event Hubs namespace** with 10 TUs (matching 10 Kinesis shards).
2. **Create Event Hub** `iot-events` with 10 partitions and 7-day retention.
3. **Configure Capture** to write Avro files to ADLS Gen2 `streaming-raw` container.
4. **Deploy Azure Function** with Event Hub trigger for real-time alerts.
5. **Create Stream Analytics job** with 5-minute tumbling window aggregation.
6. **Create output Event Hub** `iot-aggregated` for aggregated results.
7. **Deploy Databricks Structured Streaming** job to read from `iot-aggregated` and write to Delta.
8. **Dual-run** both pipelines for 1 week to validate data parity.
9. **Cut over** IoT devices to send to Event Hubs; disable Kinesis streams.

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Migration Center](index.md) | [Compute Migration](compute-migration.md) | [Storage Migration](storage-migration.md) | [Migration Playbook](../aws-to-azure.md)
