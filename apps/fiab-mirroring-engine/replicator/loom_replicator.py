"""CSA Loom Mirroring Engine — Spark Structured Streaming replicator.

Two ingestion paths:

1. **Debezium → Event Hubs (Kafka surface) → Spark → Delta MERGE**
   For DB sources where Debezium connectors exist (Azure SQL, SQL Server,
   Postgres, MySQL, Oracle).

2. **Open Mirroring landing-zone protocol → Spark → Delta MERGE**
   For partner publishers (Qlik, Striim, Informatica, SAP). Publishers
   drop Parquet files into ADLS Gen2 landing-zone container with a
   documented sequence-number filename + ``__rowMarker__`` semantics.

Both paths converge on the same Delta MERGE logic: idempotent upsert
into the bronze layer of the customer lakehouse, preserving CDC envelope
(op = c/u/d/r).

Run as a job on Databricks (Photon-enabled). Configured via env vars
or job parameters; per-mirror config lives in Cosmos DB and is loaded
at job start.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import StringType, StructField, StructType
from delta.tables import DeltaTable

logger = logging.getLogger("loom-replicator")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")


# =====================================================================
# Mirror config — loaded from Cosmos DB at job start
# =====================================================================


@dataclass
class MirrorConfig:
    mirror_id: str
    source_type: str  # azure-sql | postgres | mysql | open-mirroring
    transport: str    # eventhubs | landing-zone
    eventhubs_topic: str | None
    landing_zone_path: str | None
    target_dfs_path: str       # adfss://bronze@…/<schema>/<table>
    target_table_name: str     # bronze.<schema>_<table>
    key_columns: list[str]
    trigger_interval_seconds: int = 30
    schema_evolution: str = "auto-union"


def load_mirror_config(spark: SparkSession, mirror_id: str) -> MirrorConfig:
    """Load mirror config from Cosmos DB via the cosmos-spark connector."""
    cfg_endpoint = os.environ["COSMOS_ENDPOINT"]
    cfg_db = os.environ.get("COSMOS_DATABASE", "mirroring-config")
    cfg_container = os.environ.get("COSMOS_CONTAINER", "mirrors")

    df = (
        spark.read.format("cosmos.oltp")
        .option("spark.cosmos.accountEndpoint", cfg_endpoint)
        .option("spark.cosmos.useAad", "true")
        .option("spark.cosmos.database", cfg_db)
        .option("spark.cosmos.container", cfg_container)
        .option("spark.cosmos.read.customQuery", f"SELECT * FROM c WHERE c.id = '{mirror_id}'")
        .load()
    )
    rows = df.collect()
    if not rows:
        raise RuntimeError(f"No mirror config found for id={mirror_id}")
    row = rows[0].asDict()
    return MirrorConfig(
        mirror_id=row["id"],
        source_type=row["sourceType"],
        transport=row["transport"],
        eventhubs_topic=row.get("eventHubsTopic"),
        landing_zone_path=row.get("landingZonePath"),
        target_dfs_path=row["targetDfsPath"],
        target_table_name=row["targetTableName"],
        key_columns=list(row["keyColumns"]),
        trigger_interval_seconds=int(row.get("triggerIntervalSeconds", 30)),
        schema_evolution=row.get("schemaEvolution", "auto-union"),
    )


# =====================================================================
# Source readers
# =====================================================================


def read_eventhubs(spark: SparkSession, cfg: MirrorConfig) -> DataFrame:
    """Read CDC events from Event Hubs (Kafka protocol surface).

    Each event has Debezium envelope after the ExtractNewRecordState
    transform: payload fields are the column values plus __op (c/u/d/r),
    __ts_ms, __source_schema, __source_table, __source_lsn.
    """
    eh_bootstrap = os.environ["EVENTHUBS_BOOTSTRAP"]
    eh_conn = os.environ["EVENTHUBS_CONNECTION"]  # Key Vault ref resolved upstream

    return (
        spark.readStream.format("kafka")
        .option("kafka.bootstrap.servers", eh_bootstrap)
        .option("subscribe", cfg.eventhubs_topic)
        .option("kafka.security.protocol", "SASL_SSL")
        .option("kafka.sasl.mechanism", "PLAIN")
        .option(
            "kafka.sasl.jaas.config",
            f'org.apache.kafka.common.security.plain.PlainLoginModule required username="$ConnectionString" password="{eh_conn}";',
        )
        .option("startingOffsets", "earliest")
        .option("maxOffsetsPerTrigger", "100000")
        .load()
        .selectExpr("CAST(value AS STRING) AS payload_json", "timestamp AS kafka_ts")
    )


def read_landing_zone(spark: SparkSession, cfg: MirrorConfig) -> DataFrame:
    """Read partner-published Parquet from the Open Mirroring landing-zone.

    Filenames are 20-digit zero-padded sequence numbers
    (``00000000000000000001.parquet`` ... ). Each file contains the
    declared key columns plus value columns plus ``__rowMarker__``
    (1=insert, 2=update, 3=delete).
    """
    return (
        spark.readStream.format("cloudFiles")  # Auto Loader
        .option("cloudFiles.format", "parquet")
        .option("cloudFiles.schemaLocation", f"{cfg.target_dfs_path}/_schema/")
        .option("cloudFiles.schemaEvolutionMode", "addNewColumns")
        .option("cloudFiles.fileNamePattern", r"^\d{20}\.parquet$")
        .load(cfg.landing_zone_path)
    )


# =====================================================================
# Parse + MERGE
# =====================================================================


def parse_debezium_envelope(stream: DataFrame) -> DataFrame:
    """Parse the JSON payload into a structured row + op code."""
    # We don't know the schema statically (varies per table); use a
    # permissive infer + flatten via from_json with map<string,string>.
    # Production schema-registered version uses the table-specific
    # struct so types are preserved.
    return (
        stream
        .selectExpr("get_json_object(payload_json, '$.__op') AS __op",
                    "get_json_object(payload_json, '$.__ts_ms') AS __ts_ms",
                    "get_json_object(payload_json, '$.__source_schema') AS __source_schema",
                    "get_json_object(payload_json, '$.__source_table') AS __source_table",
                    "payload_json")
        .withColumn(
            "__rowMarker__",
            F.when(F.col("__op") == "c", 1)
            .when(F.col("__op") == "u", 2)
            .when(F.col("__op") == "d", 3)
            .when(F.col("__op") == "r", 1)
            .otherwise(F.lit(None).cast("int")),
        )
    )


def merge_to_delta(
    spark: SparkSession,
    micro_batch: DataFrame,
    batch_id: int,
    cfg: MirrorConfig,
) -> None:
    """Per-microbatch MERGE into the target Delta table.

    Idempotency: relies on (key_columns, __ts_ms) ordering. For each
    key in the batch, keep the latest event (highest __ts_ms) and
    MERGE that single row. INSERT for op=c, UPDATE for op=u, DELETE
    for op=d (which translates to a target row deletion).
    """
    if micro_batch.rdd.isEmpty():
        return

    # Dedup per key to keep only the latest event per key in this batch
    key_cols = cfg.key_columns
    window = F.expr(
        f"ROW_NUMBER() OVER (PARTITION BY {','.join(key_cols)} ORDER BY __ts_ms DESC)"
    )
    latest = micro_batch.withColumn("__rn", window).filter("__rn = 1").drop("__rn")

    # Ensure target table exists with the inferred schema if not
    if not DeltaTable.isDeltaTable(spark, cfg.target_dfs_path):
        logger.info(
            "Creating target Delta table %s at %s",
            cfg.target_table_name, cfg.target_dfs_path,
        )
        (
            latest.filter("__rowMarker__ != 3")
            .write.format("delta")
            .mode("overwrite")
            .option("path", cfg.target_dfs_path)
            .saveAsTable(cfg.target_table_name)
        )
        return

    target = DeltaTable.forPath(spark, cfg.target_dfs_path)
    merge_condition = " AND ".join([f"t.{k} = s.{k}" for k in key_cols])

    (
        target.alias("t")
        .merge(latest.alias("s"), merge_condition)
        .whenMatchedDelete(condition="s.__rowMarker__ = 3")
        .whenMatchedUpdateAll(condition="s.__rowMarker__ = 2")
        .whenNotMatchedInsertAll(condition="s.__rowMarker__ = 1 OR s.__rowMarker__ = 2")
        .execute()
    )

    logger.info(
        "Batch %s merged into %s — rows in batch: %d",
        batch_id, cfg.target_table_name, latest.count(),
    )


# =====================================================================
# Driver
# =====================================================================


def main() -> None:
    mirror_id = os.environ["MIRROR_ID"]
    spark = (
        SparkSession.builder.appName(f"csa-loom-mirror-{mirror_id}")
        .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension")
        .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog")
        .getOrCreate()
    )

    cfg = load_mirror_config(spark, mirror_id)
    logger.info("Loaded mirror config: %s", cfg)

    if cfg.transport == "eventhubs":
        raw = read_eventhubs(spark, cfg)
        parsed = parse_debezium_envelope(raw)
    elif cfg.transport == "landing-zone":
        parsed = read_landing_zone(spark, cfg)
    else:
        raise ValueError(f"Unknown transport: {cfg.transport}")

    (
        parsed.writeStream
        .foreachBatch(lambda df, bid: merge_to_delta(spark, df, bid, cfg))
        .option("checkpointLocation", f"{cfg.target_dfs_path}/_checkpoints")
        .trigger(processingTime=f"{cfg.trigger_interval_seconds} seconds")
        .start()
        .awaitTermination()
    )


if __name__ == "__main__":
    main()
