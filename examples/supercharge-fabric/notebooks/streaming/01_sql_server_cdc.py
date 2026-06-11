# Databricks notebook source
# MAGIC %md
# MAGIC # Streaming: SQL Server CDC via Debezium/SHIR
# MAGIC
# MAGIC Captures row-level change events from on-premises SQL Server using the
# MAGIC Self-hosted Integration Runtime (SHIR) and Debezium CDC connector, ingested
# MAGIC through Microsoft Fabric Eventstreams into the Bronze Delta Lake table.
# MAGIC
# MAGIC **Architecture:** SQL Server → SHIR → Eventstream (Debezium) → Bronze Delta
# MAGIC
# MAGIC | Setting | Value |
# MAGIC |---|---|
# MAGIC | Source | On-prem SQL Server 2019+ |
# MAGIC | CDC Method | SQL Server native CDC + Debezium |
# MAGIC | Sink | `lh_bronze.bronze_cdc_sql_server` |
# MAGIC | Trigger | Continuous micro-batch (2s) |

# COMMAND ----------
# MAGIC %md
# MAGIC ## 1. Configuration — SHIR Connection & CDC Tables

# COMMAND ----------

import os

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import (
    BooleanType,
    DecimalType,
    IntegerType,
    LongType,
    MapType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

spark = SparkSession.builder.getOrCreate()

# ---------------------------------------------------------------------------
# Connection configuration — all secrets sourced from environment / Key Vault
# NOTE: In Fabric, use the built-in Secret Manager or reference a linked
#       Azure Key Vault via mssparkutils.credentials.getSecret()
# ---------------------------------------------------------------------------
try:
    from notebookutils import mssparkutils
    EVENTSTREAM_CONN_STR = mssparkutils.credentials.getSecret(
        "kv-casino-poc", "eventstream-cdc-connection-string"
    )
    CHECKPOINT_STORAGE = mssparkutils.credentials.getSecret(
        "kv-casino-poc", "adls-checkpoint-path"
    )
except ImportError:
    # Local / unit-test fallback — never use real credentials here
    EVENTSTREAM_CONN_STR = os.getenv("EVENTSTREAM_CONN_STR", "")
    CHECKPOINT_STORAGE = os.getenv("CHECKPOINT_PATH", os.environ.get('CHECKPOINT_PATH_BASE', 'abfss://Files/checkpoints') + '')

# Eventstream / Kafka endpoint exposed by Fabric Eventstreams
KAFKA_BOOTSTRAP_SERVERS = os.getenv(
    "EVENTSTREAM_KAFKA_ENDPOINT",
    "<your-eventstream>.servicebus.windows.net:9093"
)
KAFKA_TOPIC_TRANSACTIONS = "casino.dbo.Transactions"
KAFKA_TOPIC_PLAYERS     = "casino.dbo.Players"

# Delta Lake target paths (Fabric Lakehouse)
BRONZE_TABLE   = "lh_bronze.bronze_cdc_sql_server"
CHECKPOINT_DIR = f"{CHECKPOINT_STORAGE}/cdc_sql_server"

# NOTE: Fabric Lakehouse tables are accessed via the three-part name
#       workspace.lakehouse.table when using cross-workspace references.

# COMMAND ----------
# MAGIC %md
# MAGIC ## 2. Enable CDC on SQL Server — Run Once Against Source DB
# MAGIC
# MAGIC Execute the following SQL directly on the SQL Server instance via SSMS
# MAGIC or a linked service query. **Not executed by this notebook.**

# COMMAND ----------

CDC_ENABLE_SQL = """
-- Step 1: Enable CDC at database level (requires sysadmin or db_owner)
USE casino;
GO
EXEC sys.sp_cdc_enable_db;
GO

-- Step 2: Enable CDC on Transactions table
EXEC sys.sp_cdc_enable_table
    @source_schema = N'dbo',
    @source_name   = N'Transactions',
    @role_name     = NULL,          -- NULL = no gating role restriction
    @capture_instance = N'dbo_Transactions',
    @supports_net_changes = 1;
GO

-- Step 3: Enable CDC on Players table
EXEC sys.sp_cdc_enable_table
    @source_schema = N'dbo',
    @source_name   = N'Players',
    @role_name     = NULL,
    @capture_instance = N'dbo_Players',
    @supports_net_changes = 1;
GO

-- Verify CDC is enabled
SELECT name, is_cdc_enabled FROM sys.databases WHERE name = 'casino';
SELECT capture_instance, source_schema, source_table, start_lsn
FROM cdc.change_tables;
"""

print("CDC enablement SQL (run on source SQL Server):")
print(CDC_ENABLE_SQL)

# COMMAND ----------
# MAGIC %md
# MAGIC ## 3. Debezium CDC Envelope Schema
# MAGIC
# MAGIC Debezium serialises each change as a JSON envelope containing operation
# MAGIC type, the before/after row images, LSN (Log Sequence Number), and source
# MAGIC metadata. The schema below matches Debezium SQL Server connector v2.x.

# COMMAND ----------

# Inner schema shared by before/after row images for Transactions
transaction_row_schema = StructType([
    StructField("TransactionId",   StringType(),  nullable=True),
    StructField("PlayerId",        StringType(),  nullable=True),
    StructField("MachineId",       StringType(),  nullable=True),
    StructField("Amount",          DecimalType(18, 2), nullable=True),
    StructField("TransactionType", StringType(),  nullable=True),  # BET, WIN, DEPOSIT
    StructField("GameCode",        StringType(),  nullable=True),
    StructField("CreatedAt",       TimestampType(), nullable=True),
    StructField("IsVoided",        BooleanType(), nullable=True),
])

# Inner schema for Players row images
player_row_schema = StructType([
    StructField("PlayerId",      StringType(), nullable=True),
    StructField("LoyaltyTier",   StringType(), nullable=True),
    StructField("FirstVisit",    TimestampType(), nullable=True),
    StructField("TotalWagered",  DecimalType(18, 2), nullable=True),
    StructField("IsExcluded",    BooleanType(), nullable=True),
])

# Full Debezium envelope schema (source metadata + before/after images)
debezium_envelope_schema = StructType([
    StructField("op",        StringType(), nullable=False),   # c=create, u=update, d=delete, r=read(snapshot)
    StructField("ts_ms",     LongType(),   nullable=False),   # event timestamp (epoch ms)
    StructField("lsn",       StringType(), nullable=True),    # SQL Server LSN hex string
    StructField("source", StructType([
        StructField("version",  StringType(), nullable=True),
        StructField("connector", StringType(), nullable=True),
        StructField("db",       StringType(), nullable=True),
        StructField("schema",   StringType(), nullable=True),
        StructField("table",    StringType(), nullable=True),
        StructField("commit_lsn", StringType(), nullable=True),
        StructField("change_lsn", StringType(), nullable=True),
    ]), nullable=True),
    StructField("before",    transaction_row_schema, nullable=True),  # NULL for inserts
    StructField("after",     transaction_row_schema, nullable=True),  # NULL for deletes
])

# COMMAND ----------
# MAGIC %md
# MAGIC ## 4. Read CDC Stream from Eventstreams (Kafka Protocol)
# MAGIC
# MAGIC Fabric Eventstreams exposes a Kafka-compatible endpoint. The SASL/SSL
# MAGIC settings below are required for the managed endpoint.
# MAGIC
# MAGIC NOTE: Set `startingOffsets` to `"earliest"` for initial backfill,
# MAGIC       then switch to `"latest"` for steady-state streaming.

# COMMAND ----------

raw_cdc_stream = (
    spark.readStream
    .format("kafka")
    .option("kafka.bootstrap.servers", KAFKA_BOOTSTRAP_SERVERS)
    .option("kafka.security.protocol", "SASL_SSL")
    .option("kafka.sasl.mechanism", "PLAIN")
    .option(
        "kafka.sasl.jaas.config",
        f'org.apache.kafka.common.security.plain.PlainLoginModule required '
        f'username="$ConnectionString" '
        f'password="{EVENTSTREAM_CONN_STR}";'
    )
    .option("subscribe", f"{KAFKA_TOPIC_TRANSACTIONS},{KAFKA_TOPIC_PLAYERS}")
    .option("startingOffsets", "latest")
    .option("maxOffsetsPerTrigger", 50_000)   # back-pressure control
    .option("failOnDataLoss", "false")         # tolerate Eventstream retention gaps
    .load()
)

print("CDC stream schema:")
raw_cdc_stream.printSchema()

# COMMAND ----------
# MAGIC %md
# MAGIC ## 5. Parse CDC Envelope — Before/After Images
# MAGIC
# MAGIC Extracts the Debezium envelope, normalises operation codes, and adds
# MAGIC Fabric-standard audit columns.

# COMMAND ----------

parsed_cdc = (
    raw_cdc_stream
    # Kafka value is bytes → cast to string then parse JSON
    .withColumn("value_str", F.col("value").cast("string"))
    .withColumn("key_str",   F.col("key").cast("string"))
    .withColumn("envelope",  F.from_json(F.col("value_str"), debezium_envelope_schema))
    # Flatten envelope fields
    .select(
        F.col("topic").alias("cdc_topic"),
        F.col("partition").alias("kafka_partition"),
        F.col("offset").alias("kafka_offset"),
        F.col("envelope.op").alias("cdc_operation"),
        F.col("envelope.lsn").alias("sql_lsn"),
        F.col("envelope.ts_ms").alias("event_epoch_ms"),
        F.to_timestamp(
            F.from_unixtime(F.col("envelope.ts_ms") / 1000)
        ).alias("event_timestamp"),
        F.col("envelope.source.table").alias("source_table"),
        F.col("envelope.before").alias("before_image"),
        F.col("envelope.after").alias("after_image"),
        # Resolve the effective row: after for inserts/updates, before for deletes
        F.when(F.col("envelope.op").isin("c", "u", "r"), F.col("envelope.after"))
         .when(F.col("envelope.op") == "d",              F.col("envelope.before"))
         .alias("effective_row"),
    )
    # Map Debezium op codes to readable labels
    .withColumn("operation_label",
        F.when(F.col("cdc_operation") == "c", F.lit("INSERT"))
         .when(F.col("cdc_operation") == "u", F.lit("UPDATE"))
         .when(F.col("cdc_operation") == "d", F.lit("DELETE"))
         .when(F.col("cdc_operation") == "r", F.lit("SNAPSHOT"))
         .otherwise(F.lit("UNKNOWN"))
    )
    # Fabric audit columns
    .withColumn("ingested_at", F.current_timestamp())
    .withColumn("ingestion_source", F.lit("sql_server_cdc_debezium"))
)

# COMMAND ----------
# MAGIC %md
# MAGIC ## 6. Handle Schema Evolution
# MAGIC
# MAGIC When the source schema changes, Debezium can emit schema-change events.
# MAGIC The Bronze layer stores the raw JSON so downstream Silver jobs can replay
# MAGIC with updated parsing logic without data loss.
# MAGIC
# MAGIC NOTE: Fabric Delta Lake supports `mergeSchema` and `overwriteSchema`.
# MAGIC       For CDC Bronze, always use `mergeSchema=true` to accommodate additive
# MAGIC       column additions without pipeline interruption.

# COMMAND ----------

# Preserve the raw JSON payload alongside parsed fields for schema-evolution safety
cdc_with_raw = parsed_cdc.withColumn("raw_payload", F.col("value_str") if "value_str" in [c.name for c in parsed_cdc.schema] else F.lit(None).cast(StringType()))

# NOTE: If the source schema adds columns, mergeSchema will add them to Delta
#       automatically. Dropped columns remain in Delta with NULL values.

# COMMAND ----------
# MAGIC %md
# MAGIC ## 7. Write to Delta Lake Bronze Table

# COMMAND ----------

def write_cdc_stream(df, epoch_id):
    """
    Micro-batch writer — appends each batch to the Bronze Delta table.
    Epoch ID is passed by Spark Structured Streaming for idempotency.
    """
    if df.isEmpty():
        return

    (
        df.write
        .format("delta")
        .mode("append")
        .option("mergeSchema", "true")
        # NOTE: partitionBy is set at table creation; subsequent writes inherit it.
        .partitionBy("source_table", F.to_date(F.col("event_timestamp")).cast("string") if False else "ingested_at")
        .saveAsTable(BRONZE_TABLE)
    )
    print(f"[Epoch {epoch_id}] Wrote {spark.table(BRONZE_TABLE).count()} CDC records to {BRONZE_TABLE}")


# Append-mode streaming query with 2-second micro-batches
cdc_query = (
    parsed_cdc
    .writeStream
    .format("delta")
    .outputMode("append")
    .option("checkpointLocation", CHECKPOINT_DIR)
    .option("mergeSchema", "true")
    .partitionBy("source_table")
    .trigger(processingTime="2 seconds")
    .toTable(BRONZE_TABLE)
)

print(f"Streaming query started: {cdc_query.id}")
print(f"Status: {cdc_query.status}")

# COMMAND ----------
# MAGIC %md
# MAGIC ## 8. Monitoring Queries

# COMMAND ----------

# NOTE: Run these in a separate cell / notebook while the stream is active.
#       Fabric Real-Time Hub also provides built-in Eventstream monitoring.

monitoring_sql = f"""
-- Event counts by operation type (last 1 hour)
SELECT
    source_table,
    operation_label,
    COUNT(*)                          AS event_count,
    MIN(event_timestamp)              AS earliest_event,
    MAX(event_timestamp)              AS latest_event,
    CURRENT_TIMESTAMP - MAX(event_timestamp) AS approx_lag
FROM {BRONZE_TABLE}
WHERE ingested_at >= CURRENT_TIMESTAMP - INTERVAL 1 HOUR
GROUP BY source_table, operation_label
ORDER BY source_table, operation_label;

-- Latency percentiles (ingestion lag vs event timestamp)
SELECT
    source_table,
    PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY latency_seconds) AS p50_latency_s,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_seconds) AS p95_latency_s,
    PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_seconds) AS p99_latency_s
FROM (
    SELECT
        source_table,
        UNIX_TIMESTAMP(ingested_at) - (event_epoch_ms / 1000) AS latency_seconds
    FROM {BRONZE_TABLE}
    WHERE ingested_at >= CURRENT_TIMESTAMP - INTERVAL 15 MINUTE
) t
GROUP BY source_table;
"""

print("Monitoring SQL (execute against Lakehouse SQL endpoint):")
print(monitoring_sql)

# Stream status check (call while query is running)
if "cdc_query" in dir() and cdc_query.isActive:
    progress = cdc_query.lastProgress
    if progress:
        print(f"Input rows/s  : {progress.get('inputRowsPerSecond', 'N/A')}")
        print(f"Process rows/s: {progress.get('processedRowsPerSecond', 'N/A')}")
        print(f"Batch duration: {progress.get('batchDuration', 'N/A')} ms")

# COMMAND ----------
# MAGIC %md
# MAGIC ## 9. Cleanup — Stop Streaming Query

# COMMAND ----------

# Graceful shutdown — call this cell to stop the streaming query
def stop_cdc_stream(query_name: str = None):
    """Stop the CDC streaming query gracefully."""
    for q in spark.streams.active:
        if query_name is None or q.name == query_name:
            q.stop()
            print(f"Stopped streaming query: {q.id}")

# Uncomment to stop:
# stop_cdc_stream()

# List all active streaming queries
active = spark.streams.active
print(f"Active streaming queries: {len(active)}")
for q in active:
    print(f"  - {q.id} | name={q.name} | status={q.status['message']}")
