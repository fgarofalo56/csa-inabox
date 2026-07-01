# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Player Table-Games Daily (player-grain fact)
# MAGIC
# MAGIC Player-grain counterpart to `gold_table_analytics` (which is game-day grain).
# MAGIC Aggregates table-games activity at the **(player_id, event_date)** grain so
# MAGIC `gold_player_360` can join through to table gaming metrics.
# MAGIC
# MAGIC ## Star schema relationships enabled
# MAGIC - `gold_player_360[player_id]` 1 -> * `gold_player_table_daily[player_id]`
# MAGIC - `dim_date[date_key]` 1 -> * `gold_player_table_daily[event_date]`

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
source_table = "lh_silver.silver_table_enriched"
target_table = "lh_gold.gold_player_table_daily"

print(f"Processing batch: {batch_id}")
print(f"Source: {source_table}")
print(f"Target: {target_table}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Daily Table-Games Activity per Player
# MAGIC
# MAGIC Derives `event_date` from `event_timestamp` to avoid depending on whether
# MAGIC Silver has already materialized an `event_date` column.

# COMMAND ----------

df_silver = (
    spark.table(source_table)
    .filter(col("player_id").isNotNull())
    .withColumn("event_date", to_date("event_timestamp"))
)

df_gold = (
    df_silver
    .groupBy("player_id", "event_date")
    .agg(
        # Drop = total buy-ins by player; actual_win_loss is house-win (positive = player loss)
        sum("drop_amount").alias("total_drop"),
        sum("actual_win_loss").alias("total_house_win"),
        sum("theoretical_win").alias("total_theoretical_win"),

        # Activity breadth
        sum("hands_played").alias("total_hands_played"),
        sum("hours_played").alias("total_hours_played"),
        countDistinct("table_id").alias("unique_tables"),
        countDistinct("game_type").alias("unique_game_types"),
        countDistinct("session_id").alias("unique_sessions"),

        # Bet size
        avg("average_bet").alias("avg_bet"),
        spark_max("max_bet").alias("max_bet_session"),

        # Session bounds
        spark_min("event_timestamp").alias("first_event_time"),
        spark_max("event_timestamp").alias("last_event_time"),

        count("*").alias("total_events"),
        avg("_dq_score").alias("avg_dq_score"),
    )
    # Player-oriented P&L: the player's net WIN is the negative of house win
    .withColumn("player_net_win", -col("total_house_win"))
    .withColumn(
        "hold_percentage",
        when(col("total_drop") > 0,
             spark_round(col("total_house_win") / col("total_drop") * 100, 2))
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
            "target.player_id = source.player_id AND target.event_date = source.event_date"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_gold.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("event_date") \
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

# event_date is the partition column; ZORDER on player_id clusters rows
# within each date partition for fast per-player lookups.
spark.sql(f"OPTIMIZE {target_table} ZORDER BY (player_id)")
print("Table optimized with Z-Order on player_id")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation

# COMMAND ----------

spark.sql(f"SELECT COUNT(*) AS total_rows, COUNT(DISTINCT player_id) AS unique_players, COUNT(DISTINCT event_date) AS unique_days FROM {target_table}").show()
spark.sql(f"SELECT * FROM {target_table} ORDER BY event_date DESC, total_drop DESC LIMIT 5").show()
