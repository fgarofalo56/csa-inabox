# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Player Slot Daily (player-grain fact)
# MAGIC
# MAGIC Fills the grain gap between `gold_player_360` (one row per player) and
# MAGIC `gold_slot_performance` (one row per machine-day) by aggregating slot
# MAGIC activity at the **(player_id, business_date)** grain. Enables Direct Lake
# MAGIC relationships from `gold_player_360` and `dim_date` for player-level
# MAGIC analytics (e.g. "how much did VIP players drop on slots last week?").
# MAGIC
# MAGIC ## Star schema relationships enabled
# MAGIC - `gold_player_360[player_id]` 1 -> * `gold_player_slot_daily[player_id]`
# MAGIC - `dim_date[date_key]` 1 -> * `gold_player_slot_daily[business_date]`

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

# Imports, Fabric parameter shim, and configuration — all in one cell so the
# shim is guaranteed to be defined before it's called (avoids NameError when
# cells are run out of order after import).
import os
from datetime import datetime

from delta.tables import DeltaTable
from pyspark.sql.functions import (
    avg,
    col,
    count,
    countDistinct,
    current_timestamp,
    lit,
    round as spark_round,
    sum,
    to_date,
    unix_timestamp,
    when,
)
from pyspark.sql.functions import (
    max as spark_max,
)
from pyspark.sql.functions import (
    min as spark_min,
)


def _get_arg(name: str, default=None):
    """Read a notebook parameter from Fabric/Synapse runtime, env var, or default."""
    try:
        import notebookutils
        return notebookutils.notebook.getArgument(name, default)
    except Exception:
        try:
            import mssparkutils
            return mssparkutils.notebook.getArgument(name, default)
        except Exception:
            return os.environ.get(name.upper(), default)


def _notebook_exit(status: str) -> None:
    """Exit the notebook with a status message (Fabric/Synapse pipelines consume this)."""
    try:
        import notebookutils
        notebookutils.notebook.exit(status)
    except Exception:
        try:
            import mssparkutils
            mssparkutils.notebook.exit(status)
        except Exception:
            raise SystemExit(status)


# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source and target (three-part names for schema-enabled Lakehouses)
source_table = "lh_silver.dbo.silver_slot_cleansed"
target_table = "lh_gold.dbo.gold_player_slot_daily"

print(f"Processing batch: {batch_id}")
print(f"Source: {source_table}")
print(f"Target: {target_table}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Daily Slot Activity per Player

# COMMAND ----------

df_silver = spark.table(source_table).filter(col("player_id").isNotNull())

df_gold = (
    df_silver
    .groupBy(col("player_id"), col("event_date").alias("business_date"))
    .agg(
        sum("coin_in").alias("total_coin_in"),
        sum("coin_out").alias("total_coin_out"),
        sum("games_played").alias("total_games_played"),
        count("*").alias("total_events"),

        # Jackpot metrics
        sum(when(col("event_type") == "JACKPOT", col("jackpot_amount")).otherwise(lit(0))).alias("total_jackpot_amount"),
        count(when(col("event_type") == "JACKPOT", True)).alias("jackpot_count"),

        # Engagement breadth
        countDistinct("machine_id").alias("unique_machines"),
        countDistinct("session_id").alias("unique_sessions"),

        # Session bounds
        spark_min("event_timestamp").alias("first_event_time"),
        spark_max("event_timestamp").alias("last_event_time"),

        # Data quality carry-through
        avg("_dq_score").alias("avg_dq_score"),
    )
    .withColumn("net_win", col("total_coin_in") - col("total_coin_out"))
    .withColumn(
        "hold_percentage",
        when(col("total_coin_in") > 0,
             spark_round((col("total_coin_in") - col("total_coin_out")) / col("total_coin_in") * 100, 2))
        .otherwise(lit(0))
    )
    .withColumn(
        "session_minutes",
        spark_round(
            (unix_timestamp("last_event_time") - unix_timestamp("first_event_time")) / 60.0, 2
        ),
    )
    .withColumn("_gold_timestamp", current_timestamp())
    .withColumn("_batch_id", lit(batch_id))
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Gold Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(target_table):
        deltaTable = DeltaTable.forName(spark, target_table)
        deltaTable.alias("target").merge(
            df_gold.alias("source"),
            "target.player_id = source.player_id AND target.business_date = source.business_date"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_gold.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("business_date") \
            .option("overwriteSchema", "true") \
            .saveAsTable(target_table)

    count_out = spark.table(target_table).count()
    print(f"Written {count_out:,} rows to {target_table}")
except Exception as e:
    print(f"ERROR in {target_table} (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize for Direct Lake

# COMMAND ----------

# business_date is the partition column; ZORDER on player_id clusters rows
# within each date partition for fast per-player lookups.
spark.sql(f"OPTIMIZE {target_table} ZORDER BY (player_id)")
print("Table optimized with Z-Order on player_id")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation

# COMMAND ----------

spark.sql(f"SELECT COUNT(*) AS total_rows, COUNT(DISTINCT player_id) AS unique_players, COUNT(DISTINCT business_date) AS unique_days FROM {target_table}").show()
spark.sql(f"SELECT * FROM {target_table} ORDER BY business_date DESC, total_coin_in DESC LIMIT 5").show()
