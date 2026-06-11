# Databricks notebook source
# MAGIC %md
# MAGIC # Streaming: Apache Kafka Topic Ingestion
# MAGIC
# MAGIC Reads casino event streams from Apache Kafka (or Fabric Eventstreams
# MAGIC Kafka-compatible endpoint) with SASL/SSL security, deserialization of
# MAGIC JSON and Avro messages, and real-time windowed aggregations.
# MAGIC
# MAGIC ## Topics Consumed
# MAGIC | Topic | Format | Description |
# MAGIC |---|---|---|
# MAGIC | `casino.slot-events` | JSON | Spin results, coin-in/out, jackpots |
# MAGIC | `casino.player-activity` | JSON | Player card events, session lifecycle |
# MAGIC | `casino.financial-transactions` | Avro | Financial posting events (Schema Registry) |
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** `bronze_kafka_events` (Delta Lake, append)
# MAGIC - **Checkpoint:** `Files/checkpoints/kafka_events`

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

import os

from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    avg,
    col,
    count,
    current_timestamp,
    expr,
    from_avro,
    from_json,
    lit,
    schema_of_json,
    window,
)
from pyspark.sql.functions import sum as _sum
from pyspark.sql.types import (
    BooleanType,
    DoubleType,
    IntegerType,
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Kafka / Eventstreams broker config — credentials from Key Vault / env vars
KAFKA_BROKERS       = os.getenv("KAFKA_BROKERS",
                        "eventhub-ns.servicebus.windows.net:9093")
KAFKA_USERNAME      = os.getenv("KAFKA_USERNAME", "$ConnectionString")
KAFKA_PASSWORD      = os.getenv("KAFKA_PASSWORD")          # Key Vault secret
SCHEMA_REGISTRY_URL = os.getenv("SCHEMA_REGISTRY_URL",
                        "https://<schema-registry-host>")

# Topics
TOPIC_SLOT_EVENTS     = "casino.slot-events"
TOPIC_PLAYER_ACTIVITY = "casino.player-activity"
TOPIC_FINANCIAL_TXN   = "casino.financial-transactions"
ALL_TOPICS            = ",".join([TOPIC_SLOT_EVENTS,
                                  TOPIC_PLAYER_ACTIVITY,
                                  TOPIC_FINANCIAL_TXN])

TARGET_TABLE = "bronze_kafka_events"
CHECKPOINT   = "Files/checkpoints/kafka_events"
WINDOW_DURATION  = "5 minutes"
WATERMARK_DELAY  = "10 minutes"

print(f"Brokers      : {KAFKA_BROKERS}")
print(f"Topics       : {ALL_TOPICS}")
print(f"Target table : {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Eventstreams Kafka Endpoint Setup
# MAGIC
# MAGIC Microsoft Fabric Eventstreams exposes a Kafka-compatible endpoint.
# MAGIC Connect existing Kafka producers without changing client code.
# MAGIC
# MAGIC ```
# MAGIC Kafka Producer (casino floor systems)
# MAGIC   └─ Fabric Eventstream (Kafka source)          ← this notebook connects here
# MAGIC       └─ Custom endpoint (Kafka-compatible)
# MAGIC           └─ bronze_kafka_events (Delta Lake destination)
# MAGIC ```
# MAGIC
# MAGIC SASL JAAS config string (stored in Key Vault, referenced below):
# MAGIC ```
# MAGIC org.apache.kafka.common.security.plain.PlainLoginModule required
# MAGIC   username="$ConnectionString"
# MAGIC   password="Endpoint=sb://...;SharedAccessKeyName=...;SharedAccessKey=...";
# MAGIC ```
# MAGIC
# MAGIC NOTE: Fabric Eventstreams also supports a no-code Delta Lake destination.
# MAGIC Use this notebook when you need custom parsing, enrichment, or aggregations
# MAGIC before writing to the Lakehouse.

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read from Kafka Topics

# COMMAND ----------

SASL_JAAS = (
    "org.apache.kafka.common.security.plain.PlainLoginModule required "
    f'username="{KAFKA_USERNAME}" '
    f'password="{KAFKA_PASSWORD}";'
)

raw_stream = (spark.readStream
    .format("kafka")
    .option("kafka.bootstrap.servers",    KAFKA_BROKERS)
    .option("kafka.security.protocol",    "SASL_SSL")
    .option("kafka.sasl.mechanism",       "PLAIN")
    .option("kafka.sasl.jaas.config",     SASL_JAAS)
    .option("subscribe",                  ALL_TOPICS)
    .option("startingOffsets",            "latest")
    .option("maxOffsetsPerTrigger",       50_000)
    .option("failOnDataLoss",             "false")
    .load()
    .withColumn("_kafka_topic",     col("topic"))
    .withColumn("_kafka_partition", col("partition"))
    .withColumn("_kafka_offset",    col("offset"))
    .withColumn("_kafka_ts",        col("timestamp"))
    .withColumn("_ingest_ts",       current_timestamp())
    .withColumn("raw_value",        col("value").cast("string")))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Deserialize JSON Messages (Slot Events & Player Activity)

# COMMAND ----------

slot_schema = StructType([
    StructField("event_id",      StringType()),
    StructField("machine_id",    StringType()),
    StructField("event_type",    StringType()),
    StructField("event_ts",      StringType()),
    StructField("denomination",  DoubleType()),
    StructField("coin_in",       DoubleType()),
    StructField("coin_out",      DoubleType()),
    StructField("jackpot_amount",DoubleType()),
    StructField("player_id",     StringType()),
    StructField("zone",          StringType()),
])

player_schema = StructType([
    StructField("session_id",    StringType()),
    StructField("player_id",     StringType()),
    StructField("card_number",   StringType()),
    StructField("event_type",    StringType()),    # card_in / card_out
    StructField("machine_id",    StringType()),
    StructField("event_ts",      StringType()),
    StructField("tier_level",    StringType()),
])

slot_stream = (raw_stream
    .filter(col("_kafka_topic") == TOPIC_SLOT_EVENTS)
    .withColumn("data", from_json(col("raw_value"), slot_schema))
    .select("_kafka_topic","_kafka_offset","_kafka_ts","_ingest_ts","data.*"))

player_stream = (raw_stream
    .filter(col("_kafka_topic") == TOPIC_PLAYER_ACTIVITY)
    .withColumn("data", from_json(col("raw_value"), player_schema))
    .select("_kafka_topic","_kafka_offset","_kafka_ts","_ingest_ts","data.*"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Deserialize Avro Messages with Schema Registry
# MAGIC
# MAGIC Financial transactions use Avro with a centralized Schema Registry
# MAGIC to enforce schema evolution governance.

# COMMAND ----------

# Fetch Avro schema from registry (cached after first call)
def get_avro_schema(subject: str, registry_url: str) -> str:
    """Fetch latest Avro schema JSON string from Confluent Schema Registry."""
    import json
    import urllib.request
    url = f"{registry_url}/subjects/{subject}/versions/latest"
    with urllib.request.urlopen(url) as resp:
        return json.loads(resp.read())["schema"]

# NOTE: In Fabric, store the schema string in a notebook parameter or
# Key Vault secret to avoid network calls at stream startup.
FINANCIAL_AVRO_SCHEMA = """{
  "type": "record", "name": "FinancialTransaction",
  "fields": [
    {"name": "txn_id",      "type": "string"},
    {"name": "player_id",   "type": "string"},
    {"name": "machine_id",  "type": "string"},
    {"name": "txn_type",    "type": "string"},
    {"name": "amount",      "type": "double"},
    {"name": "currency",    "type": "string"},
    {"name": "txn_ts",      "type": "long",   "logicalType": "timestamp-millis"},
    {"name": "cage_id",     "type": "string"},
    {"name": "is_ctr_flag", "type": "boolean"}
  ]
}"""

financial_stream = (raw_stream
    .filter(col("_kafka_topic") == TOPIC_FINANCIAL_TXN)
    # Strip 5-byte Confluent wire-format magic+schema-id prefix before decoding
    .withColumn("avro_payload", expr("substring(value, 6, length(value)-5)"))
    .withColumn("data", from_avro(col("avro_payload"), FINANCIAL_AVRO_SCHEMA))
    .select("_kafka_topic","_kafka_offset","_kafka_ts","_ingest_ts","data.*"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Multi-Topic Unified Write to Delta Lake

# COMMAND ----------

# Flatten all streams to a common envelope schema before writing
def normalize_stream(df, topic_label):
    return (df
        .withColumn("_topic_label", lit(topic_label))
        .withColumn("raw_payload",  lit(None).cast(StringType())))

# Write slot events
slot_query = (slot_stream
    .withColumn("_topic_label", lit("slot_events"))
    .writeStream
    .format("delta")
    .outputMode("append")
    .option("checkpointLocation", f"{CHECKPOINT}/slot")
    .option("mergeSchema", "true")
    .toTable(f"{TARGET_TABLE}_slot"))

# Write player activity
player_query = (player_stream
    .withColumn("_topic_label", lit("player_activity"))
    .writeStream
    .format("delta")
    .outputMode("append")
    .option("checkpointLocation", f"{CHECKPOINT}/player")
    .toTable(f"{TARGET_TABLE}_player"))

# Write financial transactions
financial_query = (financial_stream
    .withColumn("_topic_label", lit("financial_txn"))
    .writeStream
    .format("delta")
    .outputMode("append")
    .option("checkpointLocation", f"{CHECKPOINT}/financial")
    .toTable(f"{TARGET_TABLE}_financial"))

print("All stream queries started.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Window Aggregations (Slot Revenue — 5-Minute Tumbling Window)

# COMMAND ----------

windowed_revenue = (slot_stream
    .withWatermark("event_ts", WATERMARK_DELAY)
    .groupBy(
        window(col("event_ts"), WINDOW_DURATION),
        col("zone"),
        col("denomination"))
    .agg(
        count("*").alias("spin_count"),
        _sum("coin_in").alias("total_coin_in"),
        _sum("coin_out").alias("total_coin_out"),
        _sum("jackpot_amount").alias("total_jackpot")))

windowed_query = (windowed_revenue
    .writeStream
    .format("delta")
    .outputMode("append")
    .option("checkpointLocation", f"{CHECKPOINT}/windowed")
    .toTable("silver_kafka_slot_revenue_5min"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Monitoring: Consumer Lag and Throughput

# COMMAND ----------

# Check stream progress for all active queries
for q in spark.streams.active:
    prog = q.lastProgress
    if prog:
        print(f"Query     : {q.name or q.id}")
        print(f"  Rows/sec (input) : {prog.get('inputRowsPerSecond', 'N/A'):.1f}")
        print(f"  Rows/sec (proc)  : {prog.get('processedRowsPerSecond', 'N/A'):.1f}")
        offsets = prog.get("sources", [{}])[0].get("endOffset", {})
        print(f"  End offsets      : {offsets}")
        print()

# NOTE: Fabric Eventstreams provides a built-in Monitoring hub that shows
# consumer-group lag per partition without requiring custom KQL queries.
# For Confluent Kafka, use kafka-consumer-groups.sh or Confluent Control Center.
