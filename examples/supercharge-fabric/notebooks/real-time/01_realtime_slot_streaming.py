import os
from datetime import datetime

# Databricks notebook source
# MAGIC %md
# MAGIC # Real-Time Slot Machine Streaming
# MAGIC
# MAGIC This notebook demonstrates real-time processing of slot machine telemetry
# MAGIC using Spark Structured Streaming for near-real-time analytics.
# MAGIC
# MAGIC ## Use Cases:
# MAGIC - Real-time floor monitoring
# MAGIC - Jackpot alerts
# MAGIC - Machine health monitoring
# MAGIC - Live player engagement tracking
# COMMAND ----------
# MAGIC %md
# MAGIC ## Configuration
# COMMAND ----------
from pyspark.sql.functions import (
    col,
    concat,
    count,
    countDistinct,
    current_timestamp,
    exists,
    filter,
    floor,
    lit,
    minute,
    rand,
    round,
    sum,
    when,
    window,
)
from pyspark.sql.types import (
    DecimalType,
    IntegerType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Streaming parameters
checkpoint_location = os.environ.get('CHECKPOINT_PATH_BASE', 'abfss://Files/checkpoints') + '/slot_streaming'
trigger_interval = "10 seconds"

# Schema for incoming events
event_schema = StructType([
    StructField("machine_id", StringType(), False),
    StructField("event_type", StringType(), False),
    StructField("event_timestamp", TimestampType(), False),
    StructField("coin_in", DecimalType(18, 2), True),
    StructField("coin_out", DecimalType(18, 2), True),
    StructField("games_played", IntegerType(), True),
    StructField("jackpot_amount", DecimalType(18, 2), True),
    StructField("zone", StringType(), True),
    StructField("denomination", DecimalType(5, 2), True),
    StructField("player_id", StringType(), True)
])

# COMMAND ----------

# MAGIC %md
# MAGIC ## Simulated Streaming Source
# MAGIC
# MAGIC For demonstration, we'll use rate source. In production, this would be:
# MAGIC - Event Hub
# MAGIC - Kafka
# MAGIC - Eventstream

# COMMAND ----------

import json
import random


# Generate sample event for simulation
def generate_sample_event():
    event_types = ["GAME_PLAY", "JACKPOT", "METER_UPDATE", "DOOR_OPEN", "BILL_IN"]
    zones = ["North", "South", "East", "West", "VIP", "High Limit"]
    denoms = [0.01, 0.05, 0.25, 1.00, 5.00]

    return {
        "machine_id": f"SLOT-{random.randint(1000, 9999)}",
        "event_type": random.choices(event_types, weights=[80, 2, 10, 3, 5])[0],
        "event_timestamp": datetime.now().isoformat(),
        "coin_in": round(random.uniform(1, 100), 2) if random.random() > 0.1 else None,
        "coin_out": round(random.uniform(0, 80), 2) if random.random() > 0.2 else None,
        "games_played": random.randint(1, 10),
        "jackpot_amount": round(random.uniform(100, 50000), 2) if random.random() < 0.02 else 0,
        "zone": random.choice(zones),
        "denomination": random.choice(denoms),
        "player_id": f"P{random.randint(10000, 99999)}" if random.random() > 0.3 else None
    }

# Show sample event
print("Sample event structure:")
print(json.dumps(generate_sample_event(), indent=2, default=str))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Option 1: Read from Autoloader (Landing Files)
# MAGIC
# MAGIC For scenarios where data lands as files

# COMMAND ----------

# # Autoloader streaming from landing zone
# df_stream = spark.readStream \
#     .format("cloudFiles") \
#     .option("cloudFiles.format", "json") \
#     .schema(event_schema) \
#     .load("Files/landing/streaming/slot_events/")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Option 2: Read from Event Hub
# MAGIC
# MAGIC For production streaming scenarios

# COMMAND ----------

# # Event Hub configuration (uncomment for production)
# import notebookutils
# eh_connection = notebookutils.credentials.getSecret("https://<vault>.vault.azure.net/", "eventhub-connection")
#
# df_stream = spark.readStream \
#     .format("eventhubs") \
#     .options(**{
#         "eventhubs.connectionString": eh_connection,
#         "eventhubs.consumerGroup": "$Default",
#         "eventhubs.startingPosition": json.dumps({"offset": "-1", "seqNo": -1, "enqueuedTime": None, "isInclusive": True})
#     }) \
#     .load() \
#     .select(from_json(col("body").cast("string"), event_schema).alias("data")) \
#     .select("data.*")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Demo: Rate Source Simulation
# MAGIC
# MAGIC For POC demonstration

# COMMAND ----------

# Simulated stream using rate source
df_rate = spark.readStream \
    .format("rate") \
    .option("rowsPerSecond", 10) \
    .load()

# Add simulated slot events
df_stream = df_rate \
    .withColumn("machine_id", concat(lit("SLOT-"), (rand() * 9000 + 1000).cast("int"))) \
    .withColumn("event_type",
        when(rand() < 0.80, "GAME_PLAY")
        .when(rand() < 0.92, "METER_UPDATE")
        .when(rand() < 0.95, "BILL_IN")
        .when(rand() < 0.98, "DOOR_OPEN")
        .otherwise("JACKPOT")) \
    .withColumn("event_timestamp", current_timestamp()) \
    .withColumn("coin_in", (rand() * 100).cast(DecimalType(18, 2))) \
    .withColumn("coin_out", (rand() * 80).cast(DecimalType(18, 2))) \
    .withColumn("games_played", (rand() * 10 + 1).cast("int")) \
    .withColumn("jackpot_amount",
        when(col("event_type") == "JACKPOT", (rand() * 50000).cast(DecimalType(18, 2)))
        .otherwise(lit(0))) \
    .withColumn("zone",
        when(rand() < 0.2, "North")
        .when(rand() < 0.4, "South")
        .when(rand() < 0.6, "East")
        .when(rand() < 0.8, "West")
        .when(rand() < 0.95, "High Limit")
        .otherwise("VIP")) \
    .withColumn("denomination",
        when(rand() < 0.3, lit(0.01))
        .when(rand() < 0.5, lit(0.25))
        .when(rand() < 0.7, lit(1.00))
        .when(rand() < 0.9, lit(5.00))
        .otherwise(lit(25.00))) \
    .withColumn("player_id",
        when(rand() > 0.3, concat(lit("P"), (rand() * 90000 + 10000).cast("int")))
        .otherwise(lit(None))) \
    .drop("timestamp", "value")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Real-Time Aggregations

# COMMAND ----------

# 1-minute windowed aggregations
df_windowed = df_stream \
    .withWatermark("event_timestamp", "1 minute") \
    .groupBy(
        window(col("event_timestamp"), "1 minute"),
        "zone"
    ) \
    .agg(
        count("*").alias("event_count"),
        sum("coin_in").alias("total_coin_in"),
        sum("coin_out").alias("total_coin_out"),
        sum("games_played").alias("total_games"),
        countDistinct("machine_id").alias("active_machines"),
        countDistinct("player_id").alias("active_players"),
        sum(when(col("event_type") == "JACKPOT", 1).otherwise(0)).alias("jackpot_count"),
        sum(col("jackpot_amount")).alias("total_jackpots")
    ) \
    .select(
        col("window.start").alias("window_start"),
        col("window.end").alias("window_end"),
        "zone",
        "event_count",
        "total_coin_in",
        "total_coin_out",
        (col("total_coin_in") - col("total_coin_out")).alias("net_win"),
        "total_games",
        "active_machines",
        "active_players",
        "jackpot_count",
        "total_jackpots"
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table (Append Mode)

# COMMAND ----------

# Write aggregated stream to Delta
# NOTE: Uncomment for production deployment. The streaming writes persist data to Delta tables.
# For POC demo purposes, use display() to visualize in-memory only.

ENABLE_STREAMING_WRITES = False  # Set to True for production

if ENABLE_STREAMING_WRITES:
    try:
        query_agg = df_windowed.writeStream \
            .format("delta") \
            .outputMode("append") \
            .option("checkpointLocation", f"{checkpoint_location}/aggregated") \
            .option("mergeSchema", "true") \
            .trigger(processingTime=trigger_interval) \
            .queryName("floor_metrics_stream") \
            .toTable("lh_gold.gold_realtime_floor_metrics")
        print("Started floor metrics streaming write")
    except Exception as e:
        print(f"Error starting floor metrics stream: {e}")
        print("Ensure lh_gold lakehouse exists and streaming is supported")
else:
    print("Streaming writes disabled (POC mode). Set ENABLE_STREAMING_WRITES=True for production.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Jackpot Alert Stream

# COMMAND ----------

# Filter for jackpots only
df_jackpots = df_stream \
    .filter(col("event_type") == "JACKPOT") \
    .filter(col("jackpot_amount") > 0) \
    .select(
        "event_timestamp",
        "machine_id",
        "zone",
        "jackpot_amount",
        "player_id",
        when(col("jackpot_amount") >= 10000, "LARGE")
        .when(col("jackpot_amount") >= 1200, "W2G_REQUIRED")
        .otherwise("STANDARD").alias("jackpot_tier")
    )

# Write jackpots to alert table
if ENABLE_STREAMING_WRITES:
    try:
        query_jackpots = df_jackpots.writeStream \
            .format("delta") \
            .outputMode("append") \
            .option("checkpointLocation", f"{checkpoint_location}/jackpots") \
            .option("mergeSchema", "true") \
            .trigger(processingTime=trigger_interval) \
            .queryName("jackpot_alerts_stream") \
            .toTable("lh_gold.gold_realtime_jackpot_alerts")
        print("Started jackpot alerts streaming write")
    except Exception as e:
        print(f"Error starting jackpot alerts stream: {e}")
        print("Ensure lh_gold lakehouse exists and streaming is supported")
else:
    print("Jackpot alerts streaming disabled (POC mode).")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Display Real-Time Dashboard (For Testing)

# COMMAND ----------

# Display stream for interactive viewing
display(df_windowed)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Machine Health Monitoring

# COMMAND ----------

# Detect machines with unusual patterns
df_machine_health = df_stream \
    .withWatermark("event_timestamp", "5 minutes") \
    .groupBy(
        window(col("event_timestamp"), "5 minutes"),
        "machine_id",
        "zone"
    ) \
    .agg(
        count("*").alias("event_count"),
        sum("coin_in").alias("total_coin_in"),
        sum("coin_out").alias("total_coin_out"),
        count(when(col("event_type") == "DOOR_OPEN", True)).alias("door_opens"),
        count(when(col("event_type") == "TILT", True)).alias("tilts")
    ) \
    .withColumn("hold_pct",
        when(col("total_coin_in") > 0,
             ((col("total_coin_in") - col("total_coin_out")) / col("total_coin_in")) * 100)
        .otherwise(0)) \
    .withColumn("alert_status",
        when(col("hold_pct") < 2, "LOW_HOLD_ALERT")
        .when(col("hold_pct") > 15, "HIGH_HOLD_ALERT")
        .when(col("door_opens") > 3, "FREQUENT_DOOR_OPENS")
        .when(col("tilts") > 0, "TILT_DETECTED")
        .when(col("event_count") < 10, "LOW_ACTIVITY")
        .otherwise("NORMAL")
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Stop Streams (Run when done testing)

# COMMAND ----------

# # Stop all active streams
# for stream in spark.streams.active:
#     print(f"Stopping stream: {stream.name}")
#     stream.stop()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Production Notes
# MAGIC
# MAGIC For production deployment:
# MAGIC
# MAGIC 1. **Use Eventstream** for ingestion from Event Hub
# MAGIC 2. **Configure proper watermarks** based on expected latency
# MAGIC 3. **Set up checkpointing** to reliable storage
# MAGIC 4. **Monitor stream lag** via Spark UI
# MAGIC 5. **Configure alerts** for processing delays
# MAGIC 6. **Use Eventhouse/KQL** for sub-second queries
