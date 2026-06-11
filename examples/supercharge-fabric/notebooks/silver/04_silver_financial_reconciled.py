# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Financial Reconciled
# MAGIC
# MAGIC This notebook reconciles financial transactions with compliance requirements.
# MAGIC
# MAGIC ## Transformations:
# MAGIC - CTR threshold validation
# MAGIC - Transaction matching and reconciliation
# MAGIC - Structuring pattern detection
# MAGIC - Daily aggregation by player

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
    col,
    count,
    current_timestamp,
    filter,
    lit,
    sum,
    unix_timestamp,
    when,
    window,
)
from pyspark.sql.window import Window

# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))
source_table = "lh_bronze.dbo.bronze_financial_txn"
target_table = "lh_silver.dbo.silver_financial_reconciled"

# Compliance thresholds
CTR_THRESHOLD = 10000
NEAR_CTR_LOWER = 8000
NEAR_CTR_UPPER = 9999
STRUCTURING_WINDOW_HOURS = 24

print(f"Processing batch: {batch_id}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Financial Data

# COMMAND ----------

if not spark.catalog.tableExists(source_table):
    raise Exception(f"Source table {source_table} does not exist")

df_bronze = spark.table(source_table)
print(f"Bronze records: {df_bronze.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Validation

# COMMAND ----------

# Validate transaction data
df_validated = df_bronze \
    .withColumn("is_valid_amount",
        col("amount").isNotNull() & (col("amount") > 0)) \
    .withColumn("is_valid_txn_type",
        col("transaction_type").isin("BUY_IN", "CASH_OUT", "MARKER", "CHIP_EXCHANGE", "CHECK_CASH")) \
    .withColumn("is_valid_timestamp",
        col("transaction_timestamp").isNotNull()) \
    .withColumn("is_valid_player",
        col("player_id").isNotNull())

# Calculate DQ score
df_with_dq = df_validated \
    .withColumn("_dq_score",
        (when(col("is_valid_amount"), lit(40)).otherwise(lit(0)) +
         when(col("is_valid_txn_type"), lit(20)).otherwise(lit(0)) +
         when(col("is_valid_timestamp"), lit(20)).otherwise(lit(0)) +
         when(col("is_valid_player"), lit(20)).otherwise(lit(0)))) \
    .withColumn("_dq_passed", col("_dq_score") >= 80)

df_quality = df_with_dq.filter(col("_dq_passed"))
print(f"Records passing DQ: {df_quality.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## CTR and Compliance Flagging

# COMMAND ----------

# Add compliance flags
df_compliance = df_quality \
    .withColumn("ctr_required",
        col("amount") >= CTR_THRESHOLD) \
    .withColumn("near_ctr",
        col("amount").between(NEAR_CTR_LOWER, NEAR_CTR_UPPER)) \
    .withColumn("compliance_category",
        when(col("amount") >= CTR_THRESHOLD, "CTR_REQUIRED")
        .when(col("amount").between(NEAR_CTR_LOWER, NEAR_CTR_UPPER), "NEAR_CTR")
        .when(col("amount") >= 3000, "REPORTABLE")
        .otherwise("STANDARD"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Structuring Detection

# COMMAND ----------

# Window for structuring detection (24-hour rolling)
structuring_window = Window \
    .partitionBy("player_id") \
    .orderBy(unix_timestamp(col("transaction_timestamp"))) \
    .rangeBetween(-STRUCTURING_WINDOW_HOURS * 3600, 0)

# Detect potential structuring
df_with_structuring = df_compliance \
    .withColumn("rolling_24h_txn_count",
        count("*").over(structuring_window)) \
    .withColumn("rolling_24h_total",
        sum("amount").over(structuring_window)) \
    .withColumn("rolling_24h_near_ctr_count",
        sum(when(col("near_ctr"), 1).otherwise(0)).over(structuring_window)) \
    .withColumn("potential_structuring",
        (col("rolling_24h_near_ctr_count") >= 2) &
        (col("rolling_24h_total") >= CTR_THRESHOLD)) \
    .withColumn("structuring_risk_score",
        when(col("potential_structuring"), lit(100))
        .when(col("rolling_24h_near_ctr_count") >= 2, lit(75))
        .when(col("near_ctr") & (col("rolling_24h_txn_count") >= 3), lit(50))
        .when(col("near_ctr"), lit(25))
        .otherwise(lit(0)))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Daily Player Aggregation

# COMMAND ----------

# Player daily window
player_daily_window = Window.partitionBy("player_id", "transaction_date")

# Add daily player metrics
df_enriched = df_with_structuring \
    .withColumn("player_daily_txn_count",
        count("*").over(player_daily_window)) \
    .withColumn("player_daily_total",
        sum("amount").over(player_daily_window)) \
    .withColumn("player_daily_buy_ins",
        sum(when(col("transaction_type") == "BUY_IN", col("amount")).otherwise(0)).over(player_daily_window)) \
    .withColumn("player_daily_cash_outs",
        sum(when(col("transaction_type") == "CASH_OUT", col("amount")).otherwise(0)).over(player_daily_window)) \
    .withColumn("player_daily_net",
        col("player_daily_cash_outs") - col("player_daily_buy_ins"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Reconciliation Status

# COMMAND ----------

# Add reconciliation fields
df_reconciled = df_enriched \
    .withColumn("reconciliation_status",
        when(col("potential_structuring"), "PENDING_SAR_REVIEW")
        .when(col("ctr_required"), "PENDING_CTR")
        .otherwise("RECONCILED")) \
    .withColumn("requires_action",
        col("reconciliation_status").isin("PENDING_CTR", "PENDING_SAR_REVIEW"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Final Silver DataFrame

# COMMAND ----------

df_silver = df_reconciled \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id)) \
    .drop(
        "is_valid_amount", "is_valid_txn_type",
        "is_valid_timestamp", "is_valid_player"
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Silver Table

# COMMAND ----------

try:
    # Delta MERGE upsert — deduplicate on transaction_id
    if spark.catalog.tableExists(target_table):
        deltaTable = DeltaTable.forName(spark, target_table)
        deltaTable.alias("target").merge(
            df_silver.alias("source"),
            "target.transaction_id = source.transaction_id"
        ).whenMatchedUpdateAll(
            condition="target._silver_timestamp < source._silver_timestamp"
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        # First run — create the table
        df_silver.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("transaction_date") \
            .option("overwriteSchema", "true") \
            .saveAsTable(target_table)

    record_count = spark.table(target_table).count()
    print(f"Merged {spark.table(target_table).count():,} source records into {target_table} (total: {record_count:,})")
except Exception as e:
    print(f"ERROR in lh_silver.silver_financial_reconciled (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Compliance Summary

# COMMAND ----------

# Compliance category summary
spark.sql(f"""
    SELECT
        compliance_category,
        COUNT(*) as transactions,
        SUM(amount) as total_amount,
        COUNT(DISTINCT player_id) as unique_players
    FROM {target_table}
    GROUP BY compliance_category
    ORDER BY total_amount DESC
""").show()

# COMMAND ----------

# Structuring risk summary
spark.sql(f"""
    SELECT
        structuring_risk_score,
        COUNT(*) as transactions,
        COUNT(DISTINCT player_id) as players,
        SUM(amount) as total_amount
    FROM {target_table}
    WHERE structuring_risk_score > 0
    GROUP BY structuring_risk_score
    ORDER BY structuring_risk_score DESC
""").show()

# COMMAND ----------

# Pending actions
spark.sql(f"""
    SELECT
        reconciliation_status,
        COUNT(*) as count,
        SUM(amount) as total_amount
    FROM {target_table}
    WHERE requires_action = true
    GROUP BY reconciliation_status
""").show()
