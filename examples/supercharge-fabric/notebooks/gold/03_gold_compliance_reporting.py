# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Compliance Reporting
# MAGIC
# MAGIC This notebook creates aggregated compliance metrics for regulatory reporting.
# MAGIC
# MAGIC ## Reports Generated:
# MAGIC - Daily CTR/SAR/W-2G filing counts
# MAGIC - Total amounts by filing type
# MAGIC - Pending filings tracking
# MAGIC - Structuring detection summary

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
    coalesce,
    col,
    count,
    current_timestamp,
    exists,
    filter,
    lit,
    sum,
    to_date,
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

# Sources (three-part names for schema-enabled Lakehouses)
compliance_table = "lh_silver.silver_compliance_validated"
financial_table = "lh_silver.silver_financial_reconciled"

# Target
target_table = "lh_gold.gold_compliance_reporting"

print(f"Processing batch: {batch_id}")

# COMMAND ----------

# Check if source tables exist
compliance_exists = spark.catalog.tableExists(compliance_table)
financial_exists = spark.catalog.tableExists(financial_table)

print(f"Compliance table exists: {compliance_exists}")
print(f"Financial table exists: {financial_exists}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Filed Compliance Reports

# COMMAND ----------

if compliance_exists:
    df_filings = spark.table(compliance_table)

    # Daily filing summary
    df_daily_filings = df_filings \
        .withColumn("report_date", to_date("filing_timestamp")) \
        .groupBy("report_date") \
        .agg(
            # CTR metrics
            sum(when(col("filing_type") == "CTR", 1).otherwise(0)).alias("ctr_count"),
            sum(when(col("filing_type") == "CTR", col("amount"))).alias("ctr_total_amount"),

            # SAR metrics
            sum(when(col("filing_type") == "SAR", 1).otherwise(0)).alias("sar_count"),
            sum(when(col("filing_type") == "SAR", col("amount"))).alias("sar_total_amount"),

            # W-2G metrics
            sum(when(col("filing_type") == "W2G", 1).otherwise(0)).alias("w2g_count"),
            sum(when(col("filing_type") == "W2G", col("amount"))).alias("w2g_total_amount"),

            # Status breakdown
            sum(when(col("status") == "PENDING", 1).otherwise(0)).alias("pending_filings"),
            sum(when(col("status") == "SUBMITTED", 1).otherwise(0)).alias("submitted_filings"),

            # Totals
            count("*").alias("total_filings")
        )
else:
    # Create empty DataFrame if no compliance data
    schema = StructType([
        StructField("report_date", DateType()),
        StructField("ctr_count", LongType()),
        StructField("ctr_total_amount", DecimalType(18,2)),
        StructField("sar_count", LongType()),
        StructField("sar_total_amount", DecimalType(18,2)),
        StructField("w2g_count", LongType()),
        StructField("w2g_total_amount", DecimalType(18,2)),
        StructField("pending_filings", LongType()),
        StructField("submitted_filings", LongType()),
        StructField("total_filings", LongType())
    ])
    df_daily_filings = spark.createDataFrame([], schema)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Potential Filings from Financial Data

# COMMAND ----------

if financial_exists:
    df_financial = spark.table(financial_table)

    # Potential CTRs not yet filed
    df_potential_ctr = df_financial \
        .filter(col("amount") >= 10000) \
        .filter(coalesce(col("ctr_filed"), lit(False)) == False) \
        .withColumn("report_date", to_date("transaction_timestamp")) \
        .groupBy("report_date") \
        .agg(
            count("*").alias("potential_ctr_count"),
            sum("amount").alias("potential_ctr_amount")
        )

    # Potential structuring (near-CTR transactions)
    df_structuring = df_financial \
        .filter(col("amount").between(8000, 9999)) \
        .withColumn("report_date", to_date("transaction_timestamp")) \
        .groupBy("report_date", "player_id") \
        .agg(
            count("*").alias("near_ctr_txns"),
            sum("amount").alias("near_ctr_total")
        ) \
        .filter(col("near_ctr_txns") >= 2) \
        .groupBy("report_date") \
        .agg(
            count("*").alias("structuring_suspect_count"),
            sum("near_ctr_total").alias("structuring_suspect_amount")
        )
else:
    # Create empty DataFrames
    df_potential_ctr = spark.createDataFrame([], StructType([
        StructField("report_date", DateType()),
        StructField("potential_ctr_count", LongType()),
        StructField("potential_ctr_amount", DecimalType(18,2))
    ]))

    df_structuring = spark.createDataFrame([], StructType([
        StructField("report_date", DateType()),
        StructField("structuring_suspect_count", LongType()),
        StructField("structuring_suspect_amount", DecimalType(18,2))
    ]))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Combine All Compliance Metrics

# COMMAND ----------

# Join all metrics
df_gold = df_daily_filings \
    .join(df_potential_ctr, "report_date", "full_outer") \
    .join(df_structuring, "report_date", "full_outer") \
    .na.fill(0)

# Add calculated fields
df_gold = df_gold \
    .withColumn("total_regulatory_filings",
        col("ctr_count") + col("sar_count") + col("w2g_count")) \
    .withColumn("total_regulatory_amount",
        coalesce(col("ctr_total_amount"), lit(0)) +
        coalesce(col("sar_total_amount"), lit(0)) +
        coalesce(col("w2g_total_amount"), lit(0))) \
    .withColumn("compliance_alert_flags",
        array_compact(array(
            when(col("pending_filings") > 10, lit("HIGH_PENDING")),
            when(col("structuring_suspect_count") > 0, lit("STRUCTURING_DETECTED")),
            when(col("potential_ctr_count") > col("ctr_count"), lit("UNFILED_CTRS"))
        )))

# Add metadata
df_gold = df_gold \
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
    print(f"ERROR in lh_gold.gold_compliance_reporting (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize for Direct Lake

# COMMAND ----------

# Table is partitioned by report_date and aggregates to one row per date, so ZORDER
# on report_date is both illegal (partition column) and pointless (no intra-partition
# clustering to gain). Plain OPTIMIZE still compacts parquet files for Direct Lake.
spark.sql(f"OPTIMIZE {target_table}")
print("Table optimized (file compaction only — ZORDER not applicable on daily-aggregated table)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation

# COMMAND ----------

# Summary view
spark.sql(f"""
    SELECT
        MIN(report_date) as min_date,
        MAX(report_date) as max_date,
        SUM(ctr_count) as total_ctrs,
        SUM(sar_count) as total_sars,
        SUM(w2g_count) as total_w2gs,
        SUM(structuring_suspect_count) as structuring_suspects
    FROM {target_table}
""").show()

# COMMAND ----------

# Recent compliance activity
spark.sql(f"""
    SELECT
        report_date,
        ctr_count,
        sar_count,
        w2g_count,
        pending_filings,
        structuring_suspect_count
    FROM {target_table}
    ORDER BY report_date DESC
    LIMIT 10
""").show()
