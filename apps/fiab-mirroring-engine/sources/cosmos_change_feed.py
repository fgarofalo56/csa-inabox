"""CSA Loom Mirroring — Cosmos DB Change Feed source.

Cosmos has no native Debezium connector. We use the Spark Cosmos
connector's change-feed-pull mode to materialize a CDC stream that
the standard replicator can MERGE into Delta.

Run as a separate streaming job per Cosmos container; emits to the
same Delta layout as the Debezium-based sources so downstream
consumers don't care which source the data came from.
"""

from __future__ import annotations

import logging
import os

from pyspark.sql import SparkSession, DataFrame, functions as F
from delta.tables import DeltaTable

logger = logging.getLogger("loom-cosmos-cdc")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")


def read_cosmos_change_feed(
    spark: SparkSession,
    account_endpoint: str,
    database: str,
    container: str,
) -> DataFrame:
    """Pull change feed from a Cosmos container via the Spark connector.

    AAD auth via DefaultAzureCredential — no master key in the config.
    `changeFeed.startFrom = Beginning` on first run; the connector
    persists continuation tokens in the Spark checkpoint dir so
    subsequent runs resume incrementally.
    """
    return (
        spark.readStream.format("cosmos.oltp.changeFeed")
        .option("spark.cosmos.accountEndpoint", account_endpoint)
        .option("spark.cosmos.useAad", "true")
        .option("spark.cosmos.database", database)
        .option("spark.cosmos.container", container)
        .option("spark.cosmos.changeFeed.mode", "Incremental")
        .option("spark.cosmos.changeFeed.startFrom", "Beginning")
        .option("spark.cosmos.changeFeed.itemCountPerTriggerHint", "10000")
        .load()
    )


def materialize_cdc(stream: DataFrame, key_column: str) -> DataFrame:
    """Convert Cosmos document stream into Debezium-compatible envelope.

    Cosmos change feed doesn't natively distinguish update vs insert,
    and deletes only surface with TTL+softDelete. We approximate:
      - All change-feed events → marker=1 (insert) on first arrival,
        marker=2 (update) on subsequent versions of the same key.
      - True deletes require softDelete=true on the container + Cosmos
        change-feed-all-versions-and-deletes mode; documented but
        operator-opt-in.
    """
    return (
        stream
        .withColumn("__op", F.lit("u"))
        .withColumn("__ts_ms", (F.col("_ts").cast("long") * 1000))
        .withColumn("__rowMarker__", F.lit(2))
        .withColumn(key_column, F.col(f"`{key_column}`"))
    )


def main() -> None:
    mirror_id = os.environ["MIRROR_ID"]
    account_endpoint = os.environ["COSMOS_SOURCE_ENDPOINT"]
    database = os.environ["COSMOS_SOURCE_DATABASE"]
    container = os.environ["COSMOS_SOURCE_CONTAINER"]
    key_column = os.environ.get("COSMOS_SOURCE_KEY", "id")
    target_path = os.environ["TARGET_DFS_PATH"]
    target_table = os.environ["TARGET_TABLE_NAME"]
    checkpoint = os.environ.get("CHECKPOINT_PATH", f"{target_path}/_cosmos_checkpoint")
    trigger_seconds = int(os.environ.get("TRIGGER_INTERVAL_SECONDS", "30"))

    spark = (
        SparkSession.builder.appName(f"csa-loom-cosmos-mirror-{mirror_id}")
        .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension")
        .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog")
        .getOrCreate()
    )

    raw = read_cosmos_change_feed(spark, account_endpoint, database, container)
    envelope = materialize_cdc(raw, key_column)

    def merge_fn(batch: DataFrame, batch_id: int) -> None:
        if batch.rdd.isEmpty():
            return
        if not DeltaTable.isDeltaTable(spark, target_path):
            (
                batch.write.format("delta")
                .mode("overwrite")
                .option("path", target_path)
                .saveAsTable(target_table)
            )
            return
        target = DeltaTable.forPath(spark, target_path)
        (
            target.alias("t")
            .merge(batch.alias("s"), f"t.`{key_column}` = s.`{key_column}`")
            .whenMatchedDelete(condition="s.__rowMarker__ = 3")
            .whenMatchedUpdateAll(condition="s.__rowMarker__ = 2")
            .whenNotMatchedInsertAll(condition="s.__rowMarker__ = 1 OR s.__rowMarker__ = 2")
            .execute()
        )

    (
        envelope.writeStream
        .foreachBatch(merge_fn)
        .option("checkpointLocation", checkpoint)
        .trigger(processingTime=f"{trigger_seconds} seconds")
        .start()
        .awaitTermination()
    )


if __name__ == "__main__":
    main()
