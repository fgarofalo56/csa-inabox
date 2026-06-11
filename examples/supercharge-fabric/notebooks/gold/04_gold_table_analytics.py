# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Table Games Analytics
# MAGIC
# MAGIC This notebook creates aggregated KPIs for table games operations.
# MAGIC
# MAGIC ## Key Metrics:
# MAGIC - Drop (total buy-ins)
# MAGIC - Win/Loss by game type
# MAGIC - Hold percentage
# MAGIC - Hands per hour
# MAGIC - Average bet size

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
    abs,
    array,
    array_compact,
    avg,
    col,
    count,
    countDistinct,
    current_timestamp,
    exists,
    filter,
    lit,
    max,
    round,
    size,
    sum,
    when,
)
from pyspark.sql.types import (
    DateType,
    DecimalType,
    DoubleType,
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)


def _get_arg(name: str, default=None):
    """Read a notebook parameter from Fabric/Synapse runtime, env var, or default."""
    try:
        import notebookutils  # Fabric runtime
        return notebookutils.notebook.getArgument(name, default)
    except Exception:
        try:
            import mssparkutils  # legacy Synapse/Fabric runtime
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
source_table = "lh_silver.dbo.silver_table_enriched"
target_table = "lh_gold.dbo.gold_table_analytics"

print(f"Processing batch: {batch_id}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Data

# COMMAND ----------

table_exists = spark.catalog.tableExists(source_table)
print(f"Source table exists: {table_exists}")

if table_exists:
    df_silver = spark.table(source_table)
    print(f"Silver records: {df_silver.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Daily Table Performance

# COMMAND ----------

if table_exists:
    # Daily aggregation by game type
    df_daily = df_silver \
        .filter(col("event_type").isin("BET_PLACED", "WIN", "LOSS", "PUSH")) \
        .groupBy("event_date", "game_type", "game_category") \
        .agg(
            # Volume metrics
            countDistinct("table_id").alias("active_tables"),
            countDistinct("session_id").alias("total_sessions"),
            countDistinct("player_id").alias("unique_players"),
            count("*").alias("total_hands"),

            # Financial metrics
            sum("bet_amount").alias("total_drop"),
            sum("win_amount").alias("total_payouts"),
            sum("net_result").alias("table_win"),

            # Average metrics
            avg("bet_amount").alias("avg_bet"),
            max("bet_amount").alias("max_bet"),

            # Quality metrics
            avg("_dq_score").alias("avg_dq_score"),

            # Pattern flags
            sum(when(col("is_large_bet"), 1).otherwise(0)).alias("large_bet_count"),
            sum(when(col("is_big_swing"), 1).otherwise(0)).alias("big_swing_count")
        )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Calculate KPIs

# COMMAND ----------

if table_exists:
    df_with_kpis = df_daily \
        .withColumn("hold_pct",
            when(col("total_drop") > 0,
                round(col("table_win") / col("total_drop") * 100, 2))
            .otherwise(lit(0))) \
        .withColumn("hands_per_table",
            round(col("total_hands") / col("active_tables"), 1)) \
        .withColumn("drop_per_player",
            when(col("unique_players") > 0,
                round(col("total_drop") / col("unique_players"), 2))
            .otherwise(lit(0))) \
        .withColumn("sessions_per_player",
            when(col("unique_players") > 0,
                round(col("total_sessions") / col("unique_players"), 2))
            .otherwise(lit(0)))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Expected Hold Variance

# COMMAND ----------

if table_exists:
    # Define expected hold by game type
    df_with_variance = df_with_kpis \
        .withColumn("expected_hold_pct",
            when(col("game_type") == "BLACKJACK", lit(15.0))
            .when(col("game_type") == "CRAPS", lit(12.0))
            .when(col("game_type") == "ROULETTE", lit(20.0))
            .when(col("game_type") == "BACCARAT", lit(14.0))
            .when(col("game_type") == "POKER", lit(5.0))
            .otherwise(lit(15.0))) \
        .withColumn("hold_variance",
            col("hold_pct") - col("expected_hold_pct")) \
        .withColumn("hold_variance_status",
            when(abs(col("hold_variance")) <= 3, "NORMAL")
            .when(col("hold_variance") > 3, "HIGH_HOLD")
            .when(col("hold_variance") < -3, "LOW_HOLD")
            .otherwise("REVIEW"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Performance Alerts

# COMMAND ----------

if table_exists:
    df_with_alerts = df_with_variance \
        .withColumn("performance_alerts",
            array_compact(array(
                when(col("hold_variance_status") == "LOW_HOLD", lit("LOW_HOLD_ALERT")),
                when(col("hold_variance_status") == "HIGH_HOLD", lit("HIGH_HOLD_ALERT")),
                when(col("large_bet_count") / col("total_hands") > 0.1, lit("HIGH_ROLLER_ACTIVITY")),
                when(col("big_swing_count") / col("total_hands") > 0.05, lit("VOLATILITY_ALERT")),
                when(col("avg_dq_score") < 80, lit("DATA_QUALITY_CONCERN"))
            ))) \
        .withColumn("alert_count", size(col("performance_alerts")))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Gold Metadata

# COMMAND ----------

if table_exists:
    df_gold = df_with_alerts \
        .withColumn("_gold_timestamp", current_timestamp()) \
        .withColumn("_batch_id", lit(batch_id))
else:
    # Create empty schema
    schema = StructType([
        StructField("event_date", DateType()),
        StructField("game_type", StringType()),
        StructField("game_category", StringType()),
        StructField("active_tables", LongType()),
        StructField("total_sessions", LongType()),
        StructField("unique_players", LongType()),
        StructField("total_hands", LongType()),
        StructField("total_drop", DecimalType(18,2)),
        StructField("total_payouts", DecimalType(18,2)),
        StructField("table_win", DecimalType(18,2)),
        StructField("hold_pct", DoubleType()),
        StructField("expected_hold_pct", DoubleType()),
        StructField("hold_variance", DoubleType()),
        StructField("hold_variance_status", StringType()),
        StructField("_gold_timestamp", TimestampType()),
        StructField("_batch_id", StringType())
    ])
    df_gold = spark.createDataFrame([], schema)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Gold Table

# COMMAND ----------

try:
    # Write to Gold — incremental MERGE on aggregation natural key
    if spark.catalog.tableExists(target_table):
        deltaTable = DeltaTable.forName(spark, target_table)
        deltaTable.alias("target").merge(
            df_gold.alias("source"),
            "target.event_date = source.event_date "
            "AND target.game_type = source.game_type "
            "AND target.game_category = source.game_category"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_gold.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("event_date") \
            .option("overwriteSchema", "true") \
            .saveAsTable(target_table)

    print(f"Merged {spark.table(target_table).count():,} records into {target_table}")
except Exception as e:
    print(f"ERROR in lh_gold.gold_table_analytics (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize for Direct Lake

# COMMAND ----------

# event_date is the partition column, so it can't appear in ZORDER. game_type
# alone still clusters row-groups within each date partition for faster filters.
spark.sql(f"OPTIMIZE {target_table} ZORDER BY (game_type)")
print("Table optimized with Z-Order on event_date, game_type")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation

# COMMAND ----------

# Game type summary
spark.sql(f"""
    SELECT
        game_type,
        SUM(total_drop) as total_drop,
        SUM(table_win) as total_win,
        ROUND(AVG(hold_pct), 2) as avg_hold_pct,
        ROUND(AVG(expected_hold_pct), 2) as expected_hold_pct,
        ROUND(AVG(hold_variance), 2) as avg_variance
    FROM {target_table}
    GROUP BY game_type
    ORDER BY total_drop DESC
""").show()

# COMMAND ----------

# Recent performance with alerts
spark.sql(f"""
    SELECT
        event_date,
        game_type,
        total_drop,
        table_win,
        hold_pct,
        hold_variance_status,
        performance_alerts
    FROM {target_table}
    WHERE alert_count > 0
    ORDER BY event_date DESC, alert_count DESC
    LIMIT 15
""").show(truncate=False)
