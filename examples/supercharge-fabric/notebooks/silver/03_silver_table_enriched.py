# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Table Games Enriched
# MAGIC
# MAGIC This notebook transforms table games data with enrichment and validation.
# MAGIC
# MAGIC ## Transformations:
# MAGIC - Join with player and dealer master data
# MAGIC - Calculate session-level aggregations
# MAGIC - Apply data quality scoring
# MAGIC - Detect unusual betting patterns

# COMMAND ----------

# ---------------------------------------------------------------------------
# Fabric/local compatibility shim
# ---------------------------------------------------------------------------
import os

try:
    import notebookutils  # Fabric runtime
    def _get_arg(name, default=None):
        try:
            return notebookutils.notebook.getArgument(name, default)
        except Exception:
            return os.environ.get(name.upper(), default)
    def _notebook_exit(status: str) -> None:
        notebookutils.notebook.exit(status)
except ImportError:
    try:
        import mssparkutils  # legacy Synapse/Fabric runtime
        def _get_arg(name, default=None):
            try:
                return mssparkutils.notebook.getArgument(name, default)
            except Exception:
                return os.environ.get(name.upper(), default)
        def _notebook_exit(status: str) -> None:
            mssparkutils.notebook.exit(status)
    except ImportError:
        def _get_arg(name, default=None):
            return os.environ.get(name.upper(), default)
        def _notebook_exit(status: str) -> None:
            raise SystemExit(status)


from datetime import datetime

from delta.tables import DeltaTable
from pyspark.sql.functions import (
    abs,
    array,
    array_compact,
    coalesce,
    col,
    count,
    current_timestamp,
    filter,
    lag,
    lit,
    row_number,
    session_window,
    sum,
    unix_timestamp,
    when,
    window,
)
from pyspark.sql.window import Window

# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))
source_table = "lh_bronze.bronze_table_games"
target_table = "lh_silver.silver_table_enriched"

print(f"Processing batch: {batch_id}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Data

# COMMAND ----------

# Check if source exists
if not spark.catalog.tableExists(source_table):
    raise Exception(f"Source table {source_table} does not exist")

df_bronze = spark.table(source_table)
print(f"Bronze records: {df_bronze.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Validation

# COMMAND ----------

# Define validation rules
df_validated = df_bronze \
    .withColumn("is_valid_game_type",
        col("game_type").isin("BLACKJACK", "CRAPS", "ROULETTE", "BACCARAT", "POKER")) \
    .withColumn("is_valid_event",
        col("event_type").isNotNull() & (col("event_type") != "")) \
    .withColumn("is_valid_amount",
        (col("bet_amount").isNull()) | (col("bet_amount") >= 0)) \
    .withColumn("is_valid_timestamp",
        col("event_timestamp").isNotNull() &
        (col("event_timestamp") >= "2020-01-01") &
        (col("event_timestamp") <= current_timestamp())) \
    .withColumn("has_player_for_bet",
        (col("event_type") != "BET_PLACED") | col("player_id").isNotNull())

# COMMAND ----------

# MAGIC %md
# MAGIC ## Calculate Data Quality Score

# COMMAND ----------

# Calculate overall quality score
df_with_dq = df_validated \
    .withColumn("_dq_score",
        (when(col("is_valid_game_type"), lit(25)).otherwise(lit(0)) +
         when(col("is_valid_event"), lit(25)).otherwise(lit(0)) +
         when(col("is_valid_amount"), lit(25)).otherwise(lit(0)) +
         when(col("is_valid_timestamp"), lit(15)).otherwise(lit(0)) +
         when(col("has_player_for_bet"), lit(10)).otherwise(lit(0)))) \
    .withColumn("_dq_passed", col("_dq_score") >= 75)

# Filter to high-quality records
df_quality = df_with_dq.filter(col("_dq_passed"))
print(f"Records passing DQ: {df_quality.count():,} ({df_quality.count() / df_bronze.count() * 100:.1f}%)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Session-Level Aggregations

# COMMAND ----------

# Window for session-level calculations
session_window = Window.partitionBy("session_id").orderBy("event_timestamp")
player_window = Window.partitionBy("player_id", "event_date").orderBy("event_timestamp")

# Add session and player metrics
df_enriched = df_quality \
    .withColumn("session_event_number", row_number().over(session_window)) \
    .withColumn("session_running_bet", sum("bet_amount").over(session_window)) \
    .withColumn("session_running_win", sum("win_amount").over(session_window)) \
    .withColumn("session_running_net",
        coalesce(sum("win_amount").over(session_window), lit(0)) -
        coalesce(sum("bet_amount").over(session_window), lit(0))) \
    .withColumn("player_daily_hands", count("*").over(player_window)) \
    .withColumn("time_since_prev_event",
        unix_timestamp("event_timestamp") -
        lag(unix_timestamp("event_timestamp")).over(session_window))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Detect Unusual Patterns

# COMMAND ----------

# Flag unusual betting patterns
df_with_flags = df_enriched \
    .withColumn("is_large_bet",
        col("bet_amount") >= 1000) \
    .withColumn("is_rapid_play",
        col("time_since_prev_event") < 10) \
    .withColumn("is_big_swing",
        abs(col("net_result")) >= 500) \
    .withColumn("pattern_flags",
        array_compact(array(
            when(col("is_large_bet"), lit("LARGE_BET")),
            when(col("is_rapid_play"), lit("RAPID_PLAY")),
            when(col("is_big_swing"), lit("BIG_SWING"))
        )))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Silver Metadata

# COMMAND ----------

# Final Silver DataFrame
df_silver = df_with_flags \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id)) \
    .drop(
        "is_valid_game_type", "is_valid_event", "is_valid_amount",
        "is_valid_timestamp", "has_player_for_bet"
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Silver Table

# COMMAND ----------

# Delta MERGE upsert — deduplicate on session + event timestamp
try:
    if spark.catalog.tableExists(target_table):
        deltaTable = DeltaTable.forName(spark, target_table)
        deltaTable.alias("target").merge(
            df_silver.alias("source"),
            "target.session_id = source.session_id "
            "AND target.event_timestamp = source.event_timestamp"
        ).whenMatchedUpdateAll(
            condition="target._silver_timestamp < source._silver_timestamp"
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        # First run — create the table
        df_silver.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("event_date", "game_type") \
            .option("overwriteSchema", "true") \
            .saveAsTable(target_table)

    record_count = spark.table(target_table).count()
    print(f"Merged {spark.table(target_table).count():,} source records into {target_table} (total: {record_count:,})")
except Exception as e:
    print(f"ERROR in lh_silver.silver_table_enriched (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation Summary

# COMMAND ----------

# Game summary
spark.sql(f"""
    SELECT
        game_type,
        COUNT(*) as events,
        COUNT(DISTINCT session_id) as sessions,
        COUNT(DISTINCT player_id) as players,
        ROUND(AVG(_dq_score), 1) as avg_dq_score,
        SUM(bet_amount) as total_bets,
        SUM(win_amount) as total_wins
    FROM {target_table}
    GROUP BY game_type
    ORDER BY game_type
""").show()

# COMMAND ----------

# Pattern flag summary — LATERAL VIEW lets us GROUP BY the exploded column
# (can't alias EXPLODE() in SELECT and GROUP BY that alias in the same query)
spark.sql(f"""
    SELECT
        flag,
        COUNT(*) as occurrences
    FROM {target_table}
    LATERAL VIEW EXPLODE(pattern_flags) t AS flag
    WHERE SIZE(pattern_flags) > 0
    GROUP BY flag
    ORDER BY occurrences DESC
""").show()
