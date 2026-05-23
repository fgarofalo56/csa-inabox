"""Financial fraud detection — Spark Structured Streaming scoring job.

Reads CDC events from the Loom Mirroring Engine output Delta table
(bronze.fraud_transactions), scores each transaction with a pretrained
gradient boost model, writes scored events to silver.fraud_scored,
and emits a per-merchant fraud-score moving-average stream to ADX
where the Loom Activator Engine watches it.
"""

from __future__ import annotations

import pickle

from pyspark.sql import SparkSession, functions as F
from pyspark.sql.window import Window
from pyspark.ml.linalg import Vectors, VectorUDT
import numpy as np

# Load the pretrained model from DBFS (deployed by the bundle)
with open("/Volumes/loom/models/fraud_v1.pkl", "rb") as f:
    MODEL = pickle.load(f)

spark = SparkSession.builder.appName("csa-loom-fraud-scoring").getOrCreate()


# Per-row scoring UDF — converts feature columns to a vector and runs
# model.predict_proba(); returns the fraud-probability score.
@F.udf("double")
def score_udf(amount: float, mcc: int, hour_of_day: int, days_since_last_txn: float, country_iso: str) -> float:
    # Production: vectorize via a column-shaped feature transformer rather
    # than per-row UDF. This is a teaching example.
    features = np.array(
        [
            float(amount),
            float(mcc),
            float(hour_of_day),
            float(days_since_last_txn),
            float(hash(country_iso) % 100),  # cheap proxy for country embedding
        ]
    ).reshape(1, -1)
    return float(MODEL.predict_proba(features)[0, 1])


def main() -> None:
    # 1. Read CDC stream from bronze (Mirroring Engine output)
    bronze = (
        spark.readStream.format("delta")
        .option("ignoreChanges", "true")
        .table("loom.bronze.fraud_transactions")
        .filter("__rowMarker__ != 3")  # ignore deletes
    )

    # 2. Add fraud score
    scored = bronze.withColumn(
        "fraud_score",
        score_udf(
            F.col("amount"),
            F.col("mcc"),
            F.hour(F.col("txn_ts")),
            F.col("days_since_last_txn"),
            F.col("country_iso"),
        ),
    )

    # 3. Write to silver
    silver_q = (
        scored.writeStream.format("delta")
        .outputMode("append")
        .option("checkpointLocation", "abfss://silver@loom.dfs.core.windows.net/fraud_scored/_checkpoints")
        .toTable("loom.silver.fraud_scored")
    )

    # 4. Per-merchant rolling fraud-score MA to ADX
    # Activator watches: when fraud_score_ma_5min > 0.75 for any merchant,
    # the rule fires (see activator/rules.json).
    per_merchant = (
        scored.withWatermark("txn_ts", "10 minutes")
        .groupBy(
            F.window("txn_ts", "5 minutes", "1 minute"),
            F.col("merchant_id"),
        )
        .agg(F.avg("fraud_score").alias("fraud_score_ma_5min"),
             F.sum("amount").alias("amount_total"))
        .select(
            F.col("merchant_id"),
            F.col("window.end").alias("Timestamp"),
            F.col("fraud_score_ma_5min").alias("Value"),
            F.col("merchant_id").alias("ObjectId"),
            F.lit("fraud_score_ma_5min").alias("Property"),
            F.col("amount_total").alias("amount_total"),
        )
    )

    adx_q = (
        per_merchant.writeStream.format("com.microsoft.kusto.spark.synapse.datasource")
        .option("kustoCluster", "https://${ADX_CLUSTER}.kusto.windows.net")
        .option("kustoDatabase", "loomdb-default")
        .option("kustoTable", "fraud_score_ma_5min")
        .option("kustoAadAppId", "${UAMI_CLIENT_ID}")
        .option("checkpointLocation", "abfss://silver@loom.dfs.core.windows.net/fraud_scored/adx_chk")
        .outputMode("append")
        .start()
    )

    spark.streams.awaitAnyTermination()


if __name__ == "__main__":
    main()
