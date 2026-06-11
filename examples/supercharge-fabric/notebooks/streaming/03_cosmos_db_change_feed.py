# Databricks notebook source
# MAGIC %md
# MAGIC # Streaming: Cosmos DB Change Feed Processing
# MAGIC
# MAGIC Reads the Azure Cosmos DB Change Feed using the Azure Cosmos DB Spark
# MAGIC connector and writes processed events to the Bronze Delta Lake table.
# MAGIC The change feed delivers every insert and update (not deletes by default)
# MAGIC in partition-key order, enabling low-latency event streaming.
# MAGIC
# MAGIC **Architecture:** Cosmos DB → Change Feed → Spark Connector → Bronze Delta
# MAGIC **Alternative:** Cosmos DB → Fabric Mirroring (GA) → Bronze Delta
# MAGIC
# MAGIC | Setting | Value |
# MAGIC |---|---|
# MAGIC | Source | Azure Cosmos DB for NoSQL (API) |
# MAGIC | Containers | PlayerActivity (/playerId), SlotEvents (/machineId) |
# MAGIC | Connector | azure-cosmos-spark_3-4_2-12 v4.x |
# MAGIC | Sink | `lh_bronze.bronze_cdc_cosmos_db` |
# MAGIC | Trigger | Continuous micro-batch (5s) |

# COMMAND ----------
# MAGIC %md
# MAGIC ## 1. Configuration — Cosmos Connection & Container Setup

# COMMAND ----------

import os

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import (
    ArrayType,
    BooleanType,
    DoubleType,
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
# Cosmos DB connection configuration — all secrets via Key Vault
# NOTE: In Fabric, use mssparkutils.credentials.getSecret() to avoid
#       embedding connection strings in notebook source.
# ---------------------------------------------------------------------------
try:
    from notebookutils import mssparkutils
    COSMOS_ENDPOINT = mssparkutils.credentials.getSecret(
        "kv-casino-poc", "cosmos-account-endpoint"
    )
    COSMOS_KEY = mssparkutils.credentials.getSecret(
        "kv-casino-poc", "cosmos-account-key"
    )
    CHECKPOINT_STORAGE = mssparkutils.credentials.getSecret(
        "kv-casino-poc", "adls-checkpoint-path"
    )
except ImportError:
    # Local / unit-test fallback
    COSMOS_ENDPOINT = os.getenv("COSMOS_ENDPOINT", "https://<account>.documents.azure.com:443/")
    COSMOS_KEY      = os.getenv("COSMOS_KEY", "")
    CHECKPOINT_STORAGE = os.getenv("CHECKPOINT_PATH", os.environ.get('CHECKPOINT_PATH_BASE', 'abfss://Files/checkpoints') + '')

COSMOS_DATABASE = "CasinoDB"

# Container definitions: name → partition key path
COSMOS_CONTAINERS = {
    "PlayerActivity": {"partitionKey": "/playerId",  "throughput": 4000},
    "SlotEvents":     {"partitionKey": "/machineId", "throughput": 10000},
}

# Delta Lake target
BRONZE_TABLE   = "lh_bronze.bronze_cdc_cosmos_db"
CHECKPOINT_DIR = f"{CHECKPOINT_STORAGE}/cdc_cosmos_db"

# NOTE: Fabric Mirroring for Cosmos DB (NoSQL) is generally available.
#       The Mirroring approach is preferred for full fidelity without
#       managing Spark connector versions. See Section 9 for setup details.

# COMMAND ----------
# MAGIC %md
# MAGIC ## 2. Spark Cosmos Connector Setup
# MAGIC
# MAGIC The Azure Cosmos DB Spark connector must be installed on the Fabric
# MAGIC Spark environment before this notebook can run.
# MAGIC
# MAGIC Installation:
# MAGIC 1. Fabric workspace → **Settings** → **Data Engineering/Science**
# MAGIC 2. Select the Spark environment → **Libraries** tab
# MAGIC 3. Add Maven coordinate: `com.azure.cosmos.spark:azure-cosmos-spark_3-4_2-12:4.35.0`
# MAGIC 4. Save and publish the environment

# COMMAND ----------

# Cosmos Spark connector configuration dict — reused by readStream calls
cosmos_config = {
    "spark.cosmos.accountEndpoint": COSMOS_ENDPOINT,
    "spark.cosmos.accountKey":      COSMOS_KEY,
    "spark.cosmos.database":        COSMOS_DATABASE,
    # Throughput control — limit RU/s consumed by Spark reads (optional)
    "spark.cosmos.throughputControl.enabled":           "true",
    "spark.cosmos.throughputControl.targetThroughputThreshold": "0.75",
    # Change feed specific options
    "spark.cosmos.changeFeed.mode":              "Incremental",  # or FullFidelity (preview)
    "spark.cosmos.changeFeed.startFrom":         "Now",          # "Beginning" for full backfill
    "spark.cosmos.changeFeed.itemCountPerTriggerHint": "10000",
    # Connection tuning
    "spark.cosmos.read.maxItemCount":            "1000",
    "spark.cosmos.connection.mode":              "Direct",       # Gateway mode for restricted networks
}

print("Cosmos Spark connector configuration loaded.")
print(f"  Endpoint: {COSMOS_ENDPOINT[:40]}...")
print(f"  Database: {COSMOS_DATABASE}")
print(f"  Containers: {list(COSMOS_CONTAINERS.keys())}")

# COMMAND ----------
# MAGIC %md
# MAGIC ## 3. Read Change Feed with `spark.readStream.format("cosmos.oltp.changeFeed")`
# MAGIC
# MAGIC The change feed provides all mutations (inserts + updates) per partition.
# MAGIC Each item is delivered in its full current form along with metadata fields
# MAGIC prefixed with `_` (e.g., `_ts`, `_etag`, `_lsn`).

# COMMAND ----------

# Schema for PlayerActivity container items
player_activity_schema = StructType([
    StructField("id",             StringType(),  nullable=False),  # Cosmos item ID
    StructField("playerId",       StringType(),  nullable=False),  # Partition key
    StructField("activityType",   StringType(),  nullable=True),   # CHECK_IN, BET, COMP_REDEEM
    StructField("locationCode",   StringType(),  nullable=True),
    StructField("gameCode",       StringType(),  nullable=True),
    StructField("amountWagered",  DoubleType(),  nullable=True),
    StructField("pointsEarned",   IntegerType(), nullable=True),
    StructField("sessionId",      StringType(),  nullable=True),
    StructField("deviceId",       StringType(),  nullable=True),
    StructField("eventTs",        LongType(),    nullable=True),   # epoch ms (stored as number)
    StructField("tags",           ArrayType(StringType()), nullable=True),
    # Cosmos system properties
    StructField("_ts",            LongType(),    nullable=True),   # last-modified epoch seconds
    StructField("_etag",          StringType(),  nullable=True),
    StructField("_lsn",           LongType(),    nullable=True),   # logical sequence number
    StructField("_rid",           StringType(),  nullable=True),
])

# Schema for SlotEvents container items
slot_events_schema = StructType([
    StructField("id",             StringType(),  nullable=False),
    StructField("machineId",      StringType(),  nullable=False),  # Partition key
    StructField("eventType",      StringType(),  nullable=True),   # SPIN, JACKPOT, TILT, DOOR_OPEN
    StructField("creditIn",       DoubleType(),  nullable=True),
    StructField("creditOut",      DoubleType(),  nullable=True),
    StructField("jackpotAmount",  DoubleType(),  nullable=True),
    StructField("denomination",   DoubleType(),  nullable=True),
    StructField("gameTitle",      StringType(),  nullable=True),
    StructField("floorZone",      StringType(),  nullable=True),
    StructField("eventTs",        LongType(),    nullable=True),
    StructField("_ts",            LongType(),    nullable=True),
    StructField("_etag",          StringType(),  nullable=True),
    StructField("_lsn",           LongType(),    nullable=True),
    StructField("_rid",           StringType(),  nullable=True),
])


def build_change_feed_stream(container_name: str, schema: StructType, container_checkpoint: str):
    """
    Returns a structured streaming DataFrame sourced from the Cosmos DB change feed
    for the specified container.
    """
    container_config = {
        **cosmos_config,
        "spark.cosmos.container": container_name,
    }

    return (
        spark.readStream
        .format("cosmos.oltp.changeFeed")
        .options(**container_config)
        .schema(schema)
        .load()
    )


# Build change feed streams for each container
player_activity_stream = build_change_feed_stream(
    "PlayerActivity",
    player_activity_schema,
    f"{CHECKPOINT_DIR}/player_activity"
)

slot_events_stream = build_change_feed_stream(
    "SlotEvents",
    slot_events_schema,
    f"{CHECKPOINT_DIR}/slot_events"
)

print("Change feed streams created.")

# COMMAND ----------
# MAGIC %md
# MAGIC ## 4. Multi-Partition Processing
# MAGIC
# MAGIC Cosmos DB partitions are processed in parallel by Spark workers. The
# MAGIC connector maps each physical partition to a Spark task, so parallelism
# MAGIC scales with container throughput and Spark executor count.
# MAGIC
# MAGIC NOTE: In Fabric Spark, executor count is controlled by the Spark pool
# MAGIC       size. For high-throughput containers (>10K RU/s) use a Medium or
# MAGIC       Large pool to match parallelism to partition count.

# COMMAND ----------

def enrich_change_feed(df, container_name: str):
    """
    Add standard Bronze audit columns and normalise Cosmos metadata fields.
    """
    return (
        df
        # Convert Cosmos _ts (epoch seconds) to a proper timestamp
        .withColumn("cosmos_modified_at",   F.to_timestamp(F.col("_ts")))
        # Convert application eventTs (epoch ms) to timestamp
        .withColumn("event_timestamp",
            F.to_timestamp(F.from_unixtime(F.col("eventTs") / 1000))
        )
        # Fabric Bronze audit columns
        .withColumn("source_container",     F.lit(container_name))
        .withColumn("source_database",      F.lit(COSMOS_DATABASE))
        .withColumn("ingested_at",          F.current_timestamp())
        .withColumn("ingestion_source",     F.lit("cosmos_db_change_feed"))
        # Partition date for Delta partitioning
        .withColumn("event_date",           F.to_date(F.col("event_timestamp")))
        # Lag metric: seconds between event and ingestion
        .withColumn("ingestion_lag_s",
            F.unix_timestamp(F.current_timestamp()) - F.col("_ts")
        )
        # Drop raw epoch fields after conversion
        .drop("eventTs")
    )


# Apply enrichment to both streams
player_activity_enriched = enrich_change_feed(player_activity_stream, "PlayerActivity")
slot_events_enriched      = enrich_change_feed(slot_events_stream,     "SlotEvents")

print("Enrichment transforms applied.")

# COMMAND ----------
# MAGIC %md
# MAGIC ## 5. Write to Delta Lake

# COMMAND ----------

# NOTE: Two separate writeStream queries are used — one per container — so
#       each has its own checkpoint location and can be managed independently.
#       Fabric supports up to 50 concurrent streaming queries per workspace.

# PlayerActivity stream → Bronze Delta
player_query = (
    player_activity_enriched
    .writeStream
    .format("delta")
    .outputMode("append")
    .option("checkpointLocation", f"{CHECKPOINT_DIR}/player_activity")
    .option("mergeSchema", "true")
    .partitionBy("source_container", "event_date")
    .trigger(processingTime="5 seconds")
    .toTable(BRONZE_TABLE)
)

# SlotEvents stream → Bronze Delta (same table, different partition)
slot_query = (
    slot_events_enriched
    .writeStream
    .format("delta")
    .outputMode("append")
    .option("checkpointLocation", f"{CHECKPOINT_DIR}/slot_events")
    .option("mergeSchema", "true")
    .partitionBy("source_container", "event_date")
    .trigger(processingTime="5 seconds")
    .toTable(BRONZE_TABLE)
)

print(f"PlayerActivity query started: {player_query.id}")
print(f"SlotEvents query started:     {slot_query.id}")

# COMMAND ----------
# MAGIC %md
# MAGIC ## 6. Monitoring

# COMMAND ----------

monitoring_sql = f"""
-- Event throughput by container (last 15 minutes)
SELECT
    source_container,
    COUNT(*)                                AS event_count,
    AVG(ingestion_lag_s)                    AS avg_lag_seconds,
    MAX(ingestion_lag_s)                    AS max_lag_seconds,
    MIN(event_timestamp)                    AS earliest_event,
    MAX(event_timestamp)                    AS latest_event,
    MAX(ingested_at)                        AS last_ingested_at
FROM {BRONZE_TABLE}
WHERE ingested_at >= CURRENT_TIMESTAMP - INTERVAL 15 MINUTES
GROUP BY source_container;

-- PlayerActivity event type distribution
SELECT
    activityType,
    COUNT(*)    AS event_count,
    AVG(amountWagered) AS avg_wagered
FROM {BRONZE_TABLE}
WHERE source_container = 'PlayerActivity'
  AND event_date = CURRENT_DATE
GROUP BY activityType
ORDER BY event_count DESC;

-- Slot machine jackpot events (last hour)
SELECT
    machineId,
    floorZone,
    jackpotAmount,
    event_timestamp,
    ingestion_lag_s
FROM {BRONZE_TABLE}
WHERE source_container  = 'SlotEvents'
  AND eventType         = 'JACKPOT'
  AND ingested_at >= CURRENT_TIMESTAMP - INTERVAL 1 HOUR
ORDER BY event_timestamp DESC;

-- Detect high ingestion lag (SLA breach > 10 seconds)
SELECT
    source_container,
    COUNT(*) AS breach_count,
    MAX(ingestion_lag_s) AS max_lag_s
FROM {BRONZE_TABLE}
WHERE ingestion_lag_s > 10
  AND ingested_at >= CURRENT_TIMESTAMP - INTERVAL 1 HOUR
GROUP BY source_container;
"""

print("Monitoring SQL:")
print(monitoring_sql)

# Live stream progress
for q_name, q in [("PlayerActivity", player_query), ("SlotEvents", slot_query)]:
    if q.isActive:
        p = q.lastProgress
        if p:
            print(f"\n[{q_name}]")
            print(f"  Input rows/s   : {p.get('inputRowsPerSecond', 'N/A')}")
            print(f"  Processed rows/s: {p.get('processedRowsPerSecond', 'N/A')}")
            print(f"  Batch duration : {p.get('batchDuration', 'N/A')} ms")
            print(f"  Sources lag    : {p.get('sources', [{}])[0].get('endOffset', 'N/A')}")

# COMMAND ----------
# MAGIC %md
# MAGIC ## 7. Fabric Mirroring for Cosmos DB (Alternative — Recommended for GA)
# MAGIC
# MAGIC Microsoft Fabric Database Mirroring supports Azure Cosmos DB for NoSQL
# MAGIC as a generally available source. It replicates the change feed automatically
# MAGIC and lands data in a managed Lakehouse as Delta tables, without requiring
# MAGIC this notebook or Spark connector management.
# MAGIC
# MAGIC **Setup steps (Fabric portal):**
# MAGIC 1. **+ New** → **Mirrored Azure Cosmos DB**
# MAGIC 2. Enter AccountEndpoint and AccountKey (or use a linked service)
# MAGIC 3. Select database `CasinoDB` and containers `PlayerActivity`, `SlotEvents`
# MAGIC 4. Fabric creates `lh_mirrored_casinodb.PlayerActivity` etc. automatically
# MAGIC 5. The Delta tables are directly queryable with Direct Lake from Power BI
# MAGIC
# MAGIC NOTE: Mirroring handles schema evolution, partition management, and
# MAGIC       checkpointing automatically. Use this notebook only when custom
# MAGIC       transformation logic is needed at ingestion time.

print("Fabric Mirroring for Cosmos DB is available via the Fabric portal.")
print("See inline comments above for configuration steps.")

# COMMAND ----------
# MAGIC %md
# MAGIC ## 8. Cleanup — Stop Streaming Queries

# COMMAND ----------

def stop_cosmos_streams():
    """Gracefully stop all Cosmos change feed streaming queries."""
    stopped = 0
    for q in spark.streams.active:
        q.stop()
        print(f"Stopped: {q.id}")
        stopped += 1
    print(f"Total queries stopped: {stopped}")

# Uncomment to stop all active queries:
# stop_cosmos_streams()

# Status summary
active_queries = spark.streams.active
print(f"Active streaming queries: {len(active_queries)}")
for q in active_queries:
    print(f"  [{q.id}] status={q.status['message']} | active={q.isActive}")
