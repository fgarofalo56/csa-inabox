# Databricks notebook source
# MAGIC %md
# MAGIC # Streaming: Azure IoT Hub Device-to-Cloud Messages
# MAGIC
# MAGIC Reads device telemetry from the Azure IoT Hub built-in Event Hub-compatible
# MAGIC endpoint, routes messages by device type, enriches with device metadata,
# MAGIC and writes to a partitioned Bronze Delta Lake table.
# MAGIC
# MAGIC ## Device Types
# MAGIC | Device Type | Volume | Key Signals |
# MAGIC |---|---|---|
# MAGIC | `slot_machine` | ~500 devices, 2 msg/min each | coin-in, coin-out, door, tilt |
# MAGIC | `table_sensor` | ~80 sensors, 1 msg/min each | chip tray weight, card count |
# MAGIC | `hvac_sensor` | ~120 sensors, 1 msg/15 min | temp, humidity, airflow |
# MAGIC | `door_sensor` | ~300 sensors, event-driven | open/close, badge swipe |
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** `bronze_iot_telemetry` partitioned by `device_type`
# MAGIC - **Checkpoint:** `Files/checkpoints/iot_hub`

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

import os

from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    broadcast,
    col,
    current_timestamp,
    expr,
    from_json,
    get_json_object,
    lit,
    to_timestamp,
    when,
)
from pyspark.sql.types import (
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

# IoT Hub / Event Hub-compatible endpoint — credentials from Key Vault
IOT_HUB_NAME        = os.getenv("IOT_HUB_NAME", "casino-iothub")
IOT_HUB_NAMESPACE   = f"{IOT_HUB_NAME}.servicebus.windows.net"
IOT_HUB_POLICY_KEY  = os.getenv("IOT_HUB_POLICY_KEY")    # Key Vault secret
IOT_HUB_CONSUMER_GRP = os.getenv("IOT_HUB_CONSUMER_GROUP", "fabric-spark-cg")

# Built-in Event Hub-compatible endpoint details
EVENTHUB_NAME        = "messages/events"                   # built-in endpoint name
EVENTHUB_CONN_STRING = (
    f"Endpoint=sb://{IOT_HUB_NAMESPACE}/;"
    f"SharedAccessKeyName=service;SharedAccessKey={IOT_HUB_POLICY_KEY};"
    f"EntityPath={EVENTHUB_NAME}"
)

TARGET_TABLE = "bronze_iot_telemetry"
CHECKPOINT   = "Files/checkpoints/iot_hub"
DEVICE_META_PATH = "Files/reference/iot_device_metadata.parquet"

print(f"IoT Hub    : {IOT_HUB_NAME}")
print(f"Consumer Grp: {IOT_HUB_CONSUMER_GRP}")
print(f"Target table: {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read from IoT Hub Built-In Event Hub Endpoint
# MAGIC
# MAGIC IoT Hub exposes a built-in Event Hub-compatible endpoint for device messages.
# MAGIC No separate Azure Event Hubs namespace is required — the connection string
# MAGIC uses the IoT Hub's hostname and a shared access policy key.
# MAGIC
# MAGIC NOTE: Create a dedicated consumer group (`fabric-spark-cg`) in the Azure
# MAGIC Portal under IoT Hub → Built-in endpoints → Consumer groups. Never use
# MAGIC `$Default` in production to avoid competing with other readers.

# COMMAND ----------

# Event Hub connection config for Spark structured streaming
EH_CONF = {
    "eventhubs.connectionString":
        sc._jvm.org.apache.spark.eventhubs.EventHubsUtils
              .encrypt(EVENTHUB_CONN_STRING),
    "eventhubs.consumerGroup":   IOT_HUB_CONSUMER_GRP,
    "eventhubs.startingPosition": '{"offset": "-1", "seqNo": -1, "enqueuedTime": null, "isInclusive": true}',
    "maxEventsPerTrigger":        10_000,
}

raw_iot_stream = (spark.readStream
    .format("eventhubs")
    .options(**EH_CONF)
    .load()
    .withColumn("raw_body",     col("body").cast("string"))
    .withColumn("enqueued_ts",  col("enqueuedTime"))
    .withColumn("_ingest_ts",   current_timestamp())
    .withColumn("iothub_device_id",
        col("systemProperties")["iothub-connection-device-id"].cast("string"))
    .withColumn("iothub_module_id",
        col("systemProperties")["iothub-connection-module-id"].cast("string")))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Parse Device Telemetry JSON

# COMMAND ----------

# Base telemetry schema — all device types share these root fields
base_schema = StructType([
    StructField("device_id",      StringType()),
    StructField("device_type",    StringType()),    # slot_machine | table_sensor | hvac_sensor | door_sensor
    StructField("event_type",     StringType()),
    StructField("event_ts",       StringType()),
    StructField("firmware_ver",   StringType()),
    StructField("location_id",    StringType()),
    StructField("zone",           StringType()),
    StructField("payload",        MapType(StringType(), StringType())),  # device-type-specific fields
])

parsed_stream = (raw_iot_stream
    .withColumn("telemetry", from_json(col("raw_body"), base_schema))
    .select(
        col("iothub_device_id"),
        col("enqueued_ts"),
        col("_ingest_ts"),
        col("telemetry.device_id").alias("device_id"),
        col("telemetry.device_type").alias("device_type"),
        col("telemetry.event_type").alias("event_type"),
        to_timestamp(col("telemetry.event_ts")).alias("event_ts"),
        col("telemetry.firmware_ver").alias("firmware_ver"),
        col("telemetry.location_id").alias("location_id"),
        col("telemetry.zone").alias("zone"),
        col("telemetry.payload").alias("payload"),
    ))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Route by Device Type

# COMMAND ----------

# Slot machine telemetry — extract SAS meter fields from payload map
slot_stream = (parsed_stream
    .filter(col("device_type") == "slot_machine")
    .withColumn("coin_in_meter",
        col("payload")["coin_in_meter"].cast(DoubleType()))
    .withColumn("coin_out_meter",
        col("payload")["coin_out_meter"].cast(DoubleType()))
    .withColumn("games_played",
        col("payload")["games_played"].cast(LongType()))
    .withColumn("door_open",
        col("payload")["door_open"].cast(BooleanType()))
    .withColumn("tilt_code",
        col("payload")["tilt_code"]))

# HVAC sensor telemetry
hvac_stream = (parsed_stream
    .filter(col("device_type") == "hvac_sensor")
    .withColumn("temperature_c",
        col("payload")["temperature_c"].cast(DoubleType()))
    .withColumn("humidity_pct",
        col("payload")["humidity_pct"].cast(DoubleType()))
    .withColumn("airflow_cfm",
        col("payload")["airflow_cfm"].cast(DoubleType())))

# Door sensor telemetry
door_stream = (parsed_stream
    .filter(col("device_type") == "door_sensor")
    .withColumn("door_state",
        col("payload")["door_state"])
    .withColumn("badge_id",
        col("payload")["badge_id"])
    .withColumn("access_granted",
        col("payload")["access_granted"].cast(BooleanType())))

# Table sensor telemetry
table_stream = (parsed_stream
    .filter(col("device_type") == "table_sensor")
    .withColumn("chip_tray_value",
        col("payload")["chip_tray_value"].cast(DoubleType()))
    .withColumn("card_count",
        col("payload")["card_count"].cast(IntegerType()))
    .withColumn("shuffle_count",
        col("payload")["shuffle_count"].cast(IntegerType())))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Enrich with Device Metadata

# COMMAND ----------

# Static device registry (refreshed daily by a Data Factory pipeline)
# NOTE: In Fabric, store this as a Delta table in lh_silver and read via
# spark.read.table() so updates propagate automatically.
device_meta_df = (spark.read
    .format("parquet")
    .load(DEVICE_META_PATH))

# Broadcast join — metadata is small (~50 K rows)
slot_enriched = (slot_stream
    .join(broadcast(device_meta_df), on="device_id", how="left")
    .withColumn("_source", lit("iot_hub")))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Partitioned Delta Lake Tables

# COMMAND ----------

# Message routing rules:
#   slot_machine  → bronze_iot_telemetry / device_type=slot_machine
#   hvac_sensor   → bronze_iot_telemetry / device_type=hvac_sensor
#   door_sensor   → bronze_iot_telemetry / device_type=door_sensor
#   table_sensor  → bronze_iot_telemetry / device_type=table_sensor

def write_routed_stream(df, device_type_label, checkpoint_suffix):
    return (df
        .withColumn("device_type", lit(device_type_label))
        .writeStream
        .format("delta")
        .outputMode("append")
        .partitionBy("device_type")
        .option("checkpointLocation", f"{CHECKPOINT}/{checkpoint_suffix}")
        .option("mergeSchema", "true")
        .toTable(TARGET_TABLE))

slot_q   = write_routed_stream(slot_enriched,  "slot_machine",  "slot")
hvac_q   = write_routed_stream(hvac_stream,    "hvac_sensor",   "hvac")
door_q   = write_routed_stream(door_stream,    "door_sensor",   "door")
table_q  = write_routed_stream(table_stream,   "table_sensor",  "table")

print(f"4 routed stream queries writing to {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Device Health Monitoring Queries

# COMMAND ----------

# Last-seen timestamp per device (run interactively or via scheduled notebook)
spark.sql(f"""
    SELECT device_type,
           device_id,
           MAX(event_ts)             AS last_seen_ts,
           COUNT(*)                  AS msg_count_today,
           DATEDIFF(NOW(), MAX(event_ts)) AS minutes_since_last_msg
    FROM   {TARGET_TABLE}
    WHERE  event_ts >= CURRENT_DATE
    GROUP  BY device_type, device_id
    HAVING minutes_since_last_msg > 30       -- flag silent devices
    ORDER  BY minutes_since_last_msg DESC
""").show(20)

# Tilt / fault summary for slot machines
spark.sql(f"""
    SELECT zone,
           tilt_code,
           COUNT(*)  AS tilt_count,
           COUNT(DISTINCT device_id) AS affected_machines
    FROM   {TARGET_TABLE}
    WHERE  device_type = 'slot_machine'
      AND  tilt_code IS NOT NULL
      AND  event_ts  >= CURRENT_DATE
    GROUP  BY zone, tilt_code
    ORDER  BY tilt_count DESC
""").show()

# NOTE: Connect an Eventhouse KQL database to bronze_iot_telemetry via a
# Fabric shortcut to enable sub-second anomaly detection without data copy.
