# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Player 360 View
# MAGIC
# MAGIC This notebook creates a comprehensive 360-degree view of each player,
# MAGIC combining data from multiple sources for analytics and personalization.
# MAGIC
# MAGIC ## Metrics Included:
# MAGIC - Gaming activity across all channels
# MAGIC - Financial summary (cash-in, markers)
# MAGIC - Player value scoring
# MAGIC - Churn risk assessment
# MAGIC - Engagement metrics

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
    coalesce,
    col,
    count,
    countDistinct,
    current_date,
    current_timestamp,
    datediff,
    filter,
    greatest,
    hour,
    least,
    lit,
    max,
    min,
    sum,
    to_date,
    when,
)
from pyspark.sql.types import (
    DecimalType,
    IntegerType,
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

# Source tables (three-part names for schema-enabled Lakehouses)
player_table = "lh_silver.silver_player_master"
slot_table = "lh_silver.silver_slot_cleansed"
financial_table = "lh_silver.silver_financial_reconciled"

# Target
target_table = "lh_gold.gold_player_360"

# Business parameters
THEO_SLOT_PCT = 0.08  # 8% slot theoretical
THEO_TABLE_HOURLY = 50  # $50/hour table theo

print(f"Processing batch: {batch_id}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Load Player Master (Current Records Only)

# COMMAND ----------

df_players = spark.table(player_table) \
    .filter(col("is_current") == True) \
    .select(
        "player_id",
        "first_name",
        "last_name",
        "date_of_birth",
        "gender",
        "email",
        "phone",
        "city",
        "state",
        "loyalty_tier",
        "enrollment_date",
        "marketing_opt_in"
    )

print(f"Current players: {df_players.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Slot Activity

# COMMAND ----------

df_slot_activity = spark.table(slot_table) \
    .groupBy("player_id") \
    .agg(
        sum("coin_in").alias("slot_coin_in"),
        sum("coin_out").alias("slot_coin_out"),
        sum("games_played").alias("slot_games_played"),
        countDistinct("machine_id").alias("slot_machines_played"),
        countDistinct("event_date").alias("slot_visit_days"),
        min("event_timestamp").alias("first_slot_play"),
        max("event_timestamp").alias("last_slot_play"),
        avg("_dq_score").alias("slot_data_quality")
    )

print(f"Players with slot activity: {df_slot_activity.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Table Games Activity

# COMMAND ----------

# Check if table games Silver exists
if spark.catalog.tableExists("lh_silver.silver_table_enriched"):
    # Column mapping: silver_table_enriched has drop_amount (= buy-in) and
    # actual_win_loss (= house win). Cash out is derived from these. Session
    # windows derive from event_timestamp since no explicit session columns exist.
    df_table_activity = spark.table("lh_silver.silver_table_enriched") \
        .filter(col("player_id").isNotNull()) \
        .groupBy("player_id") \
        .agg(
            sum("drop_amount").alias("table_buy_in"),
            sum(col("drop_amount") - col("actual_win_loss")).alias("table_cash_out"),
            sum("hours_played").alias("table_hours_played"),
            countDistinct("table_id").alias("tables_played"),
            countDistinct(to_date("event_timestamp")).alias("table_visit_days"),
            min("event_timestamp").alias("first_table_play"),
            max("event_timestamp").alias("last_table_play")
        )
    print(f"Players with table activity: {df_table_activity.count():,}")
else:
    print("Table games Silver not found - creating empty DataFrame")
    df_table_activity = spark.createDataFrame([], StructType([
        StructField("player_id", StringType()),
        StructField("table_buy_in", DecimalType(18,2)),
        StructField("table_cash_out", DecimalType(18,2)),
        StructField("table_hours_played", DecimalType(10,2)),
        StructField("tables_played", IntegerType()),
        StructField("table_visit_days", IntegerType()),
        StructField("first_table_play", TimestampType()),
        StructField("last_table_play", TimestampType())
    ]))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Financial Activity

# COMMAND ----------

if spark.catalog.tableExists(financial_table):
    df_financial = spark.table(financial_table) \
        .groupBy("player_id") \
        .agg(
            count("*").alias("total_transactions"),
            sum(when(col("transaction_type") == "CASH_IN", col("amount"))).alias("total_cash_in"),
            sum(when(col("transaction_type") == "CASH_OUT", col("amount"))).alias("total_cash_out"),
            sum(when(col("transaction_type") == "MARKER", col("amount"))).alias("total_markers"),
            sum(when(col("transaction_type") == "MARKER_PAYMENT", col("amount"))).alias("total_marker_payments"),
            sum(when(col("ctr_required") == True, 1).otherwise(0)).alias("ctr_transaction_count"),
            max("transaction_timestamp").alias("last_financial_transaction")
        )
    print(f"Players with financial activity: {df_financial.count():,}")
else:
    print("Financial Silver not found - creating empty DataFrame")
    df_financial = spark.createDataFrame([], StructType([
        StructField("player_id", StringType()),
        StructField("total_transactions", LongType()),
        StructField("total_cash_in", DecimalType(18,2)),
        StructField("total_cash_out", DecimalType(18,2)),
        StructField("total_markers", DecimalType(18,2)),
        StructField("total_marker_payments", DecimalType(18,2)),
        StructField("ctr_transaction_count", LongType()),
        StructField("last_financial_transaction", TimestampType())
    ]))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Join All Data Sources

# COMMAND ----------

df_360 = df_players \
    .join(df_slot_activity, "player_id", "left") \
    .join(df_table_activity, "player_id", "left") \
    .join(df_financial, "player_id", "left")

print(f"Combined player records: {df_360.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Calculate Derived Metrics

# COMMAND ----------

df_metrics = df_360 \
    .withColumn(
        # Total gaming activity
        "total_gaming_activity",
        coalesce(col("slot_coin_in"), lit(0)) +
        coalesce(col("table_buy_in"), lit(0))
    ) \
    .withColumn(
        # Total theo win (casino expected revenue)
        "total_theo_win",
        (coalesce(col("slot_coin_in"), lit(0)) * THEO_SLOT_PCT) +
        (coalesce(col("table_hours_played"), lit(0)) * THEO_TABLE_HOURLY)
    ) \
    .withColumn(
        # Slot theo
        "slot_theo_win",
        coalesce(col("slot_coin_in"), lit(0)) * THEO_SLOT_PCT
    ) \
    .withColumn(
        # Table theo
        "table_theo_win",
        coalesce(col("table_hours_played"), lit(0)) * THEO_TABLE_HOURLY
    ) \
    .withColumn(
        # Total visits
        "total_visits",
        coalesce(col("slot_visit_days"), lit(0)) +
        coalesce(col("table_visit_days"), lit(0))
    ) \
    .withColumn(
        # Last activity across all channels
        "last_visit",
        greatest(
            col("last_slot_play"),
            col("last_table_play"),
            col("last_financial_transaction")
        )
    ) \
    .withColumn(
        # First activity
        "first_visit",
        least(
            col("first_slot_play"),
            col("first_table_play")
        )
    ) \
    .withColumn(
        # Days since last visit
        "days_since_visit",
        datediff(current_date(), col("last_visit"))
    ) \
    .withColumn(
        # Account age
        "account_age_days",
        datediff(current_date(), col("enrollment_date"))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Calculate Player Value Score

# COMMAND ----------

# Player value score (0-1000 scale)
df_scored = df_metrics \
    .withColumn(
        "player_value_score",
        (
            # Theo contribution (up to 500 points)
            least(coalesce(col("total_theo_win"), lit(0)) / 100, lit(500)) +

            # Visit frequency (up to 200 points)
            least(coalesce(col("total_visits"), lit(0)) * 5, lit(200)) +

            # Recency bonus (up to 100 points, decays over 90 days)
            when(col("days_since_visit") <= 30, lit(100))
            .when(col("days_since_visit") <= 60, lit(50))
            .when(col("days_since_visit") <= 90, lit(25))
            .otherwise(lit(0)) +

            # Loyalty tier bonus (up to 200 points)
            when(col("loyalty_tier") == "Diamond", lit(200))
            .when(col("loyalty_tier") == "Platinum", lit(150))
            .when(col("loyalty_tier") == "Gold", lit(100))
            .when(col("loyalty_tier") == "Silver", lit(50))
            .otherwise(lit(0))
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Calculate Churn Risk

# COMMAND ----------

df_churn = df_scored \
    .withColumn(
        "churn_risk",
        when(col("days_since_visit") > 90, "High")
        .when(col("days_since_visit") > 60, "Medium-High")
        .when(col("days_since_visit") > 30, "Medium")
        .when(col("days_since_visit") > 14, "Low")
        .otherwise("Active")
    ) \
    .withColumn(
        "churn_risk_score",  # 0-100 scale
        when(col("days_since_visit").isNull(), lit(100))
        .when(col("days_since_visit") > 180, lit(95))
        .when(col("days_since_visit") > 90, lit(80))
        .when(col("days_since_visit") > 60, lit(60))
        .when(col("days_since_visit") > 30, lit(40))
        .when(col("days_since_visit") > 14, lit(20))
        .otherwise(lit(5))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Segmentation

# COMMAND ----------

df_segmented = df_churn \
    .withColumn(
        "player_segment",
        when(col("player_value_score") >= 500, "VIP")
        .when(col("player_value_score") >= 200, "High Value")
        .when(col("player_value_score") >= 100, "Medium Value")
        .when(col("player_value_score") >= 50, "Low Value")
        .otherwise("Minimal Activity")
    ) \
    .withColumn(
        "vip_flag",
        col("loyalty_tier").isin(["Diamond", "Platinum"]) |
        (col("player_value_score") >= 500)
    ) \
    .withColumn(
        "preferred_game_type",
        when(coalesce(col("slot_coin_in"), lit(0)) > coalesce(col("table_buy_in"), lit(0)), "Slots")
        .when(coalesce(col("table_buy_in"), lit(0)) > coalesce(col("slot_coin_in"), lit(0)), "Tables")
        .otherwise("Mixed/Unknown")
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Gold Metadata

# COMMAND ----------

df_gold = df_segmented \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Gold Table

# COMMAND ----------

# Select and order columns
try:
    final_columns = [
        # Player dimensions
        "player_id", "first_name", "last_name", "date_of_birth", "gender",
        "email", "phone", "city", "state",
        "loyalty_tier", "enrollment_date", "marketing_opt_in",

        # Slot activity
        "slot_coin_in", "slot_coin_out", "slot_games_played",
        "slot_machines_played", "slot_visit_days", "slot_theo_win",
        "first_slot_play", "last_slot_play",

        # Table activity
        "table_buy_in", "table_cash_out", "table_hours_played",
        "tables_played", "table_visit_days", "table_theo_win",
        "first_table_play", "last_table_play",

        # Financial
        "total_transactions", "total_cash_in", "total_cash_out",
        "total_markers", "total_marker_payments", "ctr_transaction_count",

        # Calculated metrics
        "total_gaming_activity", "total_theo_win", "total_visits",
        "first_visit", "last_visit", "days_since_visit", "account_age_days",

        # Scoring
        "player_value_score", "churn_risk", "churn_risk_score",
        "player_segment", "vip_flag", "preferred_game_type",

        # Metadata
        "_gold_timestamp", "_batch_id"
    ]

    df_final = df_gold.select([col(c) for c in final_columns if c in df_gold.columns])

    # Write to Gold — incremental MERGE on player natural key
    if spark.catalog.tableExists(target_table):
        deltaTable = DeltaTable.forName(spark, target_table)
        deltaTable.alias("target").merge(
            df_final.alias("source"),
            "target.player_id = source.player_id"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_final.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .saveAsTable(target_table)

    print(f"Merged {spark.table(target_table).count():,} records into {target_table}")
except Exception as e:
    print(f"ERROR in lh_gold.gold_player_360 (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize for Direct Lake

# COMMAND ----------

spark.sql(f"OPTIMIZE {target_table} ZORDER BY (player_id, loyalty_tier)")
print("Table optimized")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation & Summary

# COMMAND ----------

# Overall summary
spark.sql(f"""
    SELECT
        COUNT(*) as total_players,
        COUNT(CASE WHEN vip_flag THEN 1 END) as vip_count,
        ROUND(AVG(player_value_score), 2) as avg_value_score,
        ROUND(SUM(total_theo_win), 2) as total_theo_win
    FROM {target_table}
""").show()

# COMMAND ----------

# Tier distribution
spark.sql(f"""
    SELECT
        loyalty_tier,
        COUNT(*) as players,
        ROUND(AVG(player_value_score), 2) as avg_value,
        ROUND(AVG(total_theo_win), 2) as avg_theo
    FROM {target_table}
    GROUP BY loyalty_tier
    ORDER BY avg_theo DESC
""").show()

# COMMAND ----------

# Churn risk distribution
spark.sql(f"""
    SELECT
        churn_risk,
        COUNT(*) as players,
        ROUND(SUM(total_theo_win), 2) as total_theo_at_risk
    FROM {target_table}
    GROUP BY churn_risk
    ORDER BY
        CASE churn_risk
            WHEN 'High' THEN 1
            WHEN 'Medium-High' THEN 2
            WHEN 'Medium' THEN 3
            WHEN 'Low' THEN 4
            WHEN 'Active' THEN 5
        END
""").show()

# COMMAND ----------

# Top 10 players by value
spark.sql(f"""
    SELECT
        player_id,
        loyalty_tier,
        player_value_score,
        total_theo_win,
        days_since_visit,
        churn_risk
    FROM {target_table}
    ORDER BY player_value_score DESC
    LIMIT 10
""").show()
