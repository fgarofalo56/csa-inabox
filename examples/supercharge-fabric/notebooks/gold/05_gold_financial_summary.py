# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Financial Summary
# MAGIC
# MAGIC This notebook creates daily financial summaries for executive reporting.
# MAGIC
# MAGIC ## Key Metrics:
# MAGIC - Daily revenue (P&L)
# MAGIC - Transaction volumes by type
# MAGIC - Compliance filing status
# MAGIC - Cash flow analysis

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
    exists,
    lit,
    max,
    round,
    sum,
    when,
)
from pyspark.sql.types import DateType, DecimalType, LongType, StructField, StructType


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

# Sources and target (three-part names for schema-enabled Lakehouses)
financial_table = "lh_silver.dbo.silver_financial_reconciled"
compliance_table = "lh_silver.dbo.silver_compliance_validated"
target_table = "lh_gold.dbo.gold_financial_summary"

print(f"Processing batch: {batch_id}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Check Source Tables

# COMMAND ----------

financial_exists = spark.catalog.tableExists(financial_table)
compliance_exists = spark.catalog.tableExists(compliance_table)

print(f"Financial table exists: {financial_exists}")
print(f"Compliance table exists: {compliance_exists}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Financial Transactions

# COMMAND ----------

if financial_exists:
    df_financial = spark.table(financial_table)

    # Daily financial summary
    df_financial_daily = df_financial \
        .groupBy("transaction_date") \
        .agg(
            # Volume metrics
            count("*").alias("total_transactions"),
            countDistinct("player_id").alias("unique_customers"),

            # By transaction type
            sum(when(col("transaction_type") == "BUY_IN", col("amount")).otherwise(0)).alias("total_buy_ins"),
            sum(when(col("transaction_type") == "CASH_OUT", col("amount")).otherwise(0)).alias("total_cash_outs"),
            sum(when(col("transaction_type") == "MARKER", col("amount")).otherwise(0)).alias("total_markers"),
            sum(when(col("transaction_type") == "CHECK_CASH", col("amount")).otherwise(0)).alias("total_check_cashing"),

            # Totals
            sum("amount").alias("total_volume"),
            avg("amount").alias("avg_transaction"),
            max("amount").alias("max_transaction"),

            # Compliance metrics
            sum(when(col("ctr_required"), 1).otherwise(0)).alias("ctr_count"),
            sum(when(col("ctr_required"), col("amount")).otherwise(0)).alias("ctr_volume"),
            sum(when(col("potential_structuring"), 1).otherwise(0)).alias("structuring_suspects"),

            # Reconciliation status
            sum(when(col("reconciliation_status") == "PENDING_CTR", 1).otherwise(0)).alias("pending_ctr_filings"),
            sum(when(col("reconciliation_status") == "PENDING_SAR_REVIEW", 1).otherwise(0)).alias("pending_sar_review")
        )
else:
    schema = StructType([
        StructField("transaction_date", DateType()),
        StructField("total_transactions", LongType()),
        StructField("unique_customers", LongType()),
        StructField("total_buy_ins", DecimalType(18,2)),
        StructField("total_cash_outs", DecimalType(18,2)),
        StructField("total_markers", DecimalType(18,2)),
        StructField("total_check_cashing", DecimalType(18,2)),
        StructField("total_volume", DecimalType(18,2)),
        StructField("avg_transaction", DecimalType(18,2)),
        StructField("max_transaction", DecimalType(18,2)),
        StructField("ctr_count", LongType()),
        StructField("ctr_volume", DecimalType(18,2)),
        StructField("structuring_suspects", LongType()),
        StructField("pending_ctr_filings", LongType()),
        StructField("pending_sar_review", LongType())
    ])
    df_financial_daily = spark.createDataFrame([], schema)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Compliance Filings

# COMMAND ----------

if compliance_exists:
    df_compliance = spark.table(compliance_table)

    # Daily compliance summary
    df_compliance_daily = df_compliance \
        .groupBy("filing_date") \
        .agg(
            # Filing counts by type
            sum(when(col("filing_type") == "CTR", 1).otherwise(0)).alias("ctr_filed"),
            sum(when(col("filing_type") == "SAR", 1).otherwise(0)).alias("sar_filed"),
            sum(when(col("filing_type") == "W2G", 1).otherwise(0)).alias("w2g_filed"),

            # Filing amounts
            sum(when(col("filing_type") == "CTR", col("amount")).otherwise(0)).alias("ctr_filed_amount"),
            sum(when(col("filing_type") == "W2G", col("amount")).otherwise(0)).alias("w2g_filed_amount"),

            # Validation status
            sum(when(col("validation_passed"), 1).otherwise(0)).alias("filings_validated"),
            sum(when(~col("validation_passed"), 1).otherwise(0)).alias("filings_with_issues"),

            # Deadline status
            sum(when(col("filing_deadline_status") == "OVERDUE", 1).otherwise(0)).alias("overdue_filings"),
            sum(when(col("filing_deadline_status") == "DUE_SOON", 1).otherwise(0)).alias("filings_due_soon")
        ) \
        .withColumnRenamed("filing_date", "report_date")
else:
    schema = StructType([
        StructField("report_date", DateType()),
        StructField("ctr_filed", LongType()),
        StructField("sar_filed", LongType()),
        StructField("w2g_filed", LongType()),
        StructField("ctr_filed_amount", DecimalType(18,2)),
        StructField("w2g_filed_amount", DecimalType(18,2)),
        StructField("filings_validated", LongType()),
        StructField("filings_with_issues", LongType()),
        StructField("overdue_filings", LongType()),
        StructField("filings_due_soon", LongType())
    ])
    df_compliance_daily = spark.createDataFrame([], schema)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Combine Financial and Compliance

# COMMAND ----------

# Join financial and compliance data
df_combined = df_financial_daily \
    .withColumnRenamed("transaction_date", "report_date") \
    .join(df_compliance_daily, "report_date", "full_outer") \
    .na.fill(0)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Calculate KPIs

# COMMAND ----------

df_with_kpis = df_combined \
    .withColumn("net_cash_flow",
        coalesce(col("total_buy_ins"), lit(0)) - coalesce(col("total_cash_outs"), lit(0))) \
    .withColumn("avg_customer_spend",
        when(col("unique_customers") > 0,
            round(col("total_buy_ins") / col("unique_customers"), 2))
        .otherwise(lit(0))) \
    .withColumn("ctr_filing_rate",
        when(col("ctr_count") > 0,
            round(col("ctr_filed") / col("ctr_count") * 100, 1))
        .otherwise(lit(100))) \
    .withColumn("compliance_score",
        when((col("pending_ctr_filings") == 0) & (col("overdue_filings") == 0), lit(100))
        .when(col("overdue_filings") > 0, lit(50))
        .otherwise(lit(75)))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Performance Status

# COMMAND ----------

df_with_status = df_with_kpis \
    .withColumn("cash_flow_status",
        when(col("net_cash_flow") > 0, "POSITIVE")
        .when(col("net_cash_flow") < 0, "NEGATIVE")
        .otherwise("NEUTRAL")) \
    .withColumn("compliance_status",
        when(col("compliance_score") >= 90, "COMPLIANT")
        .when(col("compliance_score") >= 70, "ATTENTION_NEEDED")
        .otherwise("AT_RISK")) \
    .withColumn("daily_alerts",
        array_compact(array(
            when(col("overdue_filings") > 0, lit("OVERDUE_FILINGS")),
            when(col("structuring_suspects") > 0, lit("STRUCTURING_DETECTED")),
            when(col("pending_ctr_filings") > 5, lit("CTR_BACKLOG")),
            when(col("filings_with_issues") > 0, lit("FILING_ERRORS")),
            when(col("compliance_score") < 70, lit("COMPLIANCE_RISK"))
        )))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Gold Metadata

# COMMAND ----------

df_gold = df_with_status \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Gold Table

# COMMAND ----------

try:
    # Write to Gold — incremental MERGE on report_date natural key
    if spark.catalog.tableExists(target_table):
        deltaTable = DeltaTable.forName(spark, target_table)
        deltaTable.alias("target").merge(
            df_gold.alias("source"),
            "target.report_date = source.report_date"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_gold.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("report_date") \
            .option("overwriteSchema", "true") \
            .saveAsTable(target_table)

    print(f"Merged {spark.table(target_table).count():,} records into {target_table}")
except Exception as e:
    print(f"ERROR in lh_gold.gold_financial_summary (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize for Direct Lake

# COMMAND ----------

# Table is partitioned by report_date and aggregates to one row per date, so ZORDER
# on report_date is both illegal (partition column) and pointless. Plain OPTIMIZE
# still compacts parquet files for Direct Lake.
spark.sql(f"OPTIMIZE {target_table}")
print("Table optimized with Z-Order on report_date")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Executive Summary

# COMMAND ----------

# Overall summary
spark.sql(f"""
    SELECT
        MIN(report_date) as period_start,
        MAX(report_date) as period_end,
        SUM(total_transactions) as total_transactions,
        SUM(total_volume) as total_volume,
        SUM(net_cash_flow) as net_cash_flow,
        SUM(ctr_count) as total_ctrs,
        SUM(ctr_filed) as ctrs_filed,
        SUM(sar_filed) as sars_filed,
        SUM(w2g_filed) as w2gs_filed
    FROM {target_table}
""").show()

# COMMAND ----------

# Daily trend
spark.sql(f"""
    SELECT
        report_date,
        total_volume,
        net_cash_flow,
        unique_customers,
        compliance_score,
        compliance_status
    FROM {target_table}
    ORDER BY report_date DESC
    LIMIT 10
""").show()

# COMMAND ----------

# Days requiring attention
spark.sql(f"""
    SELECT
        report_date,
        compliance_status,
        SIZE(daily_alerts) as alert_count,
        daily_alerts
    FROM {target_table}
    WHERE SIZE(daily_alerts) > 0
    ORDER BY report_date DESC
""").show(truncate=False)
