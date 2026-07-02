# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Slot Machine Performance KPIs
# MAGIC
# MAGIC This notebook creates aggregated slot performance metrics optimized for analytics.
# MAGIC
# MAGIC ## KPIs Calculated:
# MAGIC - Net Win and Hold Percentage
# MAGIC - Theoretical Win and Variance
# MAGIC - Win Per Unit metrics
# MAGIC - Player engagement metrics

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
    array,
    array_compact,
    avg,
    coalesce,
    col,
    count,
    countDistinct,
    current_timestamp,
    lit,
    max,
    min,
    sum,
    unix_timestamp,
    when,
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
source_table = "lh_silver.silver_slot_cleansed"
target_table = "lh_gold.gold_slot_performance"

# Business parameters
THEORETICAL_HOLD_PCT = 0.08  # 8% theoretical hold

print(f"Processing batch: {batch_id}")
print(f"Theoretical hold: {THEORETICAL_HOLD_PCT * 100}%")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Data

# COMMAND ----------

df_silver = spark.table(source_table)

print(f"Silver records: {df_silver.count():,}")
print(f"Date range: {df_silver.agg(min('event_date'), max('event_date')).collect()[0]}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate by Machine/Zone/Day

# COMMAND ----------

# Daily aggregations
df_daily = df_silver \
    .groupBy(
        "machine_id",
        "zone",
        "denomination",
        "manufacturer",
        "machine_type",
        col("event_date").alias("business_date")
    ) \
    .agg(
        # Volume metrics
        sum("coin_in").alias("total_coin_in"),
        sum("coin_out").alias("total_coin_out"),
        sum("games_played").alias("total_games"),
        count("*").alias("total_events"),

        # Jackpot metrics
        sum(when(col("event_type") == "JACKPOT", col("jackpot_amount"))).alias("jackpot_payouts"),
        count(when(col("event_type") == "JACKPOT", True)).alias("jackpot_count"),

        # Player metrics
        countDistinct("player_id").alias("unique_players"),
        countDistinct("session_id").alias("unique_sessions"),

        # Time metrics
        min("event_timestamp").alias("first_event"),
        max("event_timestamp").alias("last_event"),

        # Data quality
        avg("_dq_score").alias("avg_data_quality")
    )

print(f"Daily aggregations: {df_daily.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Calculate KPIs

# COMMAND ----------

df_kpis = df_daily \
    .withColumn("total_coin_in", coalesce(col("total_coin_in"), lit(0))) \
    .withColumn("total_coin_out", coalesce(col("total_coin_out"), lit(0))) \
    .withColumn("total_games", coalesce(col("total_games"), lit(0))) \
    .withColumn("jackpot_payouts", coalesce(col("jackpot_payouts"), lit(0))) \
    .withColumn(
        # Net Win (Casino revenue)
        "net_win",
        col("total_coin_in") - col("total_coin_out")
    ) \
    .withColumn(
        # Actual Hold Percentage
        "actual_hold_pct",
        when(col("total_coin_in") > 0,
             (col("net_win") / col("total_coin_in")) * 100)
        .otherwise(0)
    ) \
    .withColumn(
        # Theoretical Win (Expected based on house edge)
        "theoretical_win",
        col("total_coin_in") * THEORETICAL_HOLD_PCT
    ) \
    .withColumn(
        # Hold Variance (Actual vs Theoretical)
        "hold_variance",
        col("net_win") - col("theoretical_win")
    ) \
    .withColumn(
        # Hold Variance Percentage
        "hold_variance_pct",
        when(col("theoretical_win") > 0,
             ((col("net_win") - col("theoretical_win")) / col("theoretical_win")) * 100)
        .otherwise(0)
    ) \
    .withColumn(
        # Average Bet
        "avg_bet",
        when(col("total_games") > 0,
             col("total_coin_in") / col("total_games"))
        .otherwise(0)
    ) \
    .withColumn(
        # Win Per Unit Per Day (WPUPD)
        "win_per_unit",
        col("net_win")  # Already per machine per day
    ) \
    .withColumn(
        # Games per Player (engagement)
        "games_per_player",
        when(col("unique_players") > 0,
             col("total_games") / col("unique_players"))
        .otherwise(0)
    ) \
    .withColumn(
        # Operating hours (approximate)
        "operating_hours",
        (unix_timestamp(col("last_event")) - unix_timestamp(col("first_event"))) / 3600
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Performance Flags

# COMMAND ----------

df_flagged = df_kpis \
    .withColumn(
        "performance_status",
        when(col("hold_variance_pct") > 20, "HIGH_PERFORMER")
        .when(col("hold_variance_pct") < -20, "UNDERPERFORMER")
        .when(col("total_games") < 100, "LOW_ACTIVITY")
        .otherwise("NORMAL")
    ) \
    .withColumn(
        "alert_flags",
        array_compact(
            array(
                when(col("actual_hold_pct") < 2, lit("VERY_LOW_HOLD")),
                when(col("actual_hold_pct") > 15, lit("VERY_HIGH_HOLD")),
                when(col("jackpot_payouts") > col("total_coin_in") * 0.5, lit("HIGH_JACKPOT_RATIO")),
                when(col("total_events") == 0, lit("NO_ACTIVITY"))
            )
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Gold Metadata

# COMMAND ----------

df_gold = df_flagged \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id)) \
    .withColumn("_theoretical_hold_used", lit(THEORETICAL_HOLD_PCT))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Gold Table

# COMMAND ----------

# Select and order columns
try:
    final_columns = [
        # Dimensions
        "machine_id", "zone", "denomination", "manufacturer", "machine_type", "business_date",

        # Volume metrics
        "total_coin_in", "total_coin_out", "total_games", "total_events",

        # Financial KPIs
        "net_win", "actual_hold_pct", "theoretical_win", "hold_variance", "hold_variance_pct",

        # Jackpot metrics
        "jackpot_payouts", "jackpot_count",

        # Player metrics
        "unique_players", "unique_sessions", "games_per_player",

        # Operational metrics
        "avg_bet", "win_per_unit", "operating_hours",

        # Quality & Status
        "avg_data_quality", "performance_status", "alert_flags",

        # Metadata
        "_gold_timestamp", "_batch_id", "_theoretical_hold_used"
    ]

    df_final = df_gold.select([col(c) for c in final_columns if c in df_gold.columns])

    # Write to Gold — incremental MERGE on aggregation natural key
    if spark.catalog.tableExists(target_table):
        deltaTable = DeltaTable.forName(spark, target_table)
        deltaTable.alias("target").merge(
            df_final.alias("source"),
            "target.machine_id = source.machine_id "
            "AND target.zone = source.zone "
            "AND target.denomination = source.denomination "
            "AND target.manufacturer = source.manufacturer "
            "AND target.machine_type = source.machine_type "
            "AND target.business_date = source.business_date"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_final.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("business_date") \
            .option("overwriteSchema", "true") \
            .saveAsTable(target_table)

    print(f"Merged {spark.table(target_table).count():,} records into {target_table}")
except Exception as e:
    print(f"ERROR in lh_gold.gold_slot_performance (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize for Direct Lake

# COMMAND ----------

spark.sql(f"OPTIMIZE {target_table} ZORDER BY (machine_id, zone)")
print("Table optimized with Z-Order on machine_id, zone")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation & Summary

# COMMAND ----------

# Overall summary
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        COUNT(DISTINCT machine_id) as unique_machines,
        COUNT(DISTINCT zone) as zones,
        MIN(business_date) as min_date,
        MAX(business_date) as max_date
    FROM {target_table}
""").show()

# COMMAND ----------

# Financial summary
spark.sql(f"""
    SELECT
        SUM(total_coin_in) as total_coin_in,
        SUM(total_coin_out) as total_coin_out,
        SUM(net_win) as total_net_win,
        ROUND(SUM(net_win) / NULLIF(SUM(total_coin_in), 0) * 100, 2) as overall_hold_pct,
        SUM(total_games) as total_games,
        SUM(jackpot_payouts) as total_jackpots
    FROM {target_table}
""").show()

# COMMAND ----------

# Zone performance
spark.sql(f"""
    SELECT
        zone,
        SUM(net_win) as net_win,
        ROUND(SUM(net_win) / NULLIF(SUM(total_coin_in), 0) * 100, 2) as hold_pct,
        SUM(total_games) as games,
        SUM(unique_players) as players
    FROM {target_table}
    GROUP BY zone
    ORDER BY net_win DESC
""").show()

# COMMAND ----------

# Performance distribution
spark.sql(f"""
    SELECT
        performance_status,
        COUNT(*) as machine_days,
        SUM(net_win) as net_win,
        ROUND(AVG(actual_hold_pct), 2) as avg_hold_pct
    FROM {target_table}
    GROUP BY performance_status
    ORDER BY net_win DESC
""").show()

# COMMAND ----------

# Top 10 machines by net win
spark.sql(f"""
    SELECT
        machine_id,
        zone,
        SUM(net_win) as total_net_win,
        ROUND(AVG(actual_hold_pct), 2) as avg_hold_pct,
        SUM(total_games) as total_games
    FROM {target_table}
    GROUP BY machine_id, zone
    ORDER BY total_net_win DESC
    LIMIT 10
""").show()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Lakehouse Schemas (GA Dec 2025)
# MAGIC
# MAGIC Fabric Lakehouse now supports **schema-based table organization** (GA).
# MAGIC Instead of flat Lakehouse-qualified naming (`lh_gold.gold_slot_performance`),
# MAGIC tables can be organized into schemas for better discovery, access control,
# MAGIC and multi-domain isolation.
# MAGIC
# MAGIC ### Schema Pattern (Alternative to flat naming)
# MAGIC ```
# MAGIC Flat naming:   lh_gold.gold_slot_performance
# MAGIC Schema naming:  lh_gold.casino.gold_slot_performance
# MAGIC ```
# MAGIC
# MAGIC To adopt schemas, create the schema first, then save tables into it.
# MAGIC Both patterns coexist -- existing flat-named tables remain accessible.

# COMMAND ----------

# --- Lakehouse Schema Pattern (Optional, GA Dec 2025) ---
# Uncomment the following to organize Gold tables within Lakehouse schemas.
# This enables domain-based table isolation and finer-grained access control.
#
# Create schema (idempotent):
# spark.sql("CREATE SCHEMA IF NOT EXISTS casino")
#
# Write to schema-qualified table (uses same MERGE pattern):
# if spark.catalog.tableExists("casino.gold_slot_performance"):
#     deltaTable = DeltaTable.forName(spark, "casino.gold_slot_performance")
#     deltaTable.alias("target").merge(
#         df_kpis.alias("source"),
#         "target.machine_id = source.machine_id AND target.business_date = source.business_date"
#     ).whenMatchedUpdateAll().whenNotMatchedInsertAll().execute()
# else:
#     df_kpis.write.format("delta") \
#         .mode("overwrite") \
#         .option("overwriteSchema", "true") \
#         .saveAsTable("casino.gold_slot_performance")
#
# For federal agency isolation:
# spark.sql("CREATE SCHEMA IF NOT EXISTS usda")
# spark.sql("CREATE SCHEMA IF NOT EXISTS noaa")
# spark.sql("CREATE SCHEMA IF NOT EXISTS epa")
# spark.sql("CREATE SCHEMA IF NOT EXISTS doi")
# spark.sql("CREATE SCHEMA IF NOT EXISTS sba")
#
# Schema-based access control:
# GRANT SELECT ON SCHEMA casino TO `casino-analysts@contoso.com`
# GRANT SELECT ON SCHEMA usda TO `usda-data-team@contoso.com`

print("Lakehouse Schema pattern available (see comments above)")
print("Current table uses flat naming for backward compatibility")
