# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer Utilities
# MAGIC
# MAGIC Common helpers for Bronze ingestion notebooks.
# MAGIC
# MAGIC ## Usage
# MAGIC ```python
# MAGIC %run ../utils/bronze_utils
# MAGIC
# MAGIC df = add_bronze_metadata(df, batch_id=BATCH_ID)
# MAGIC write_bronze_append(df, "lh_bronze.bronze_slot_telemetry", partition_cols=["_bronze_load_date"])
# MAGIC optimize_bronze(spark, "lh_bronze.bronze_slot_telemetry", zorder_cols=["machine_id"])
# MAGIC null_counts = basic_null_check(df, ["machine_id", "event_type"])
# MAGIC ```

# COMMAND ----------

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pyspark.sql import DataFrame, SparkSession

try:
    from pyspark.sql.functions import current_timestamp, input_file_name, lit
    _PYSPARK_AVAILABLE = True
except ImportError:
    _PYSPARK_AVAILABLE = False

# COMMAND ----------


def add_bronze_metadata(df: DataFrame, batch_id: str) -> DataFrame:
    return (
        df
        .withColumn("_bronze_ingested_at", current_timestamp())
        .withColumn("_bronze_source_file", input_file_name())
        .withColumn("_bronze_batch_id", lit(batch_id))
        .withColumn("_bronze_load_date", current_timestamp().cast("date"))
    )


# COMMAND ----------


def write_bronze_append(
    df: DataFrame,
    table_name: str,
    partition_cols: list[str] | None = None,
) -> None:
    writer = df.write.format("delta").mode("append").option("mergeSchema", "true")
    if partition_cols:
        writer = writer.partitionBy(*partition_cols)
    writer.saveAsTable(table_name)


# COMMAND ----------


def _validate_identifier(name: str) -> str:
    """Validate a SQL identifier to prevent injection."""
    if not re.match(r'^[a-zA-Z_][a-zA-Z0-9_.]*$', name):
        raise ValueError(f"Invalid SQL identifier: {name}")
    return name


def optimize_bronze(
    spark: SparkSession,
    table_name: str,
    zorder_cols: list[str] | None = None,
    vacuum_retention_hours: int = 168,
) -> None:
    safe_table = _validate_identifier(table_name)
    if zorder_cols:
        safe_cols = ", ".join(_validate_identifier(c) for c in zorder_cols)
        spark.sql(f"OPTIMIZE {safe_table} ZORDER BY ({safe_cols})")
    else:
        spark.sql(f"OPTIMIZE {safe_table}")
    spark.sql(f"VACUUM {safe_table} RETAIN {vacuum_retention_hours} HOURS")


# COMMAND ----------


def basic_null_check(df: DataFrame, columns: list[str]) -> dict[str, int]:
    from pyspark.sql.functions import col, count, when

    agg_exprs = [
        count(when(col(c).isNull(), c)).alias(c)
        for c in columns
    ]
    row = df.agg(*agg_exprs).collect()[0]
    return {c: row[c] for c in columns}
