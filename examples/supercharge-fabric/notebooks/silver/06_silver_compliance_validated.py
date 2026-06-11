# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Compliance Validated
# MAGIC
# MAGIC This notebook validates compliance filings against regulatory requirements.
# MAGIC
# MAGIC ## Validations:
# MAGIC - CTR amount threshold verification
# MAGIC - SAR filing completeness
# MAGIC - W-2G jackpot threshold validation
# MAGIC - Filing deadline compliance

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
    array,
    array_compact,
    coalesce,
    col,
    concat,
    count,
    current_date,
    current_timestamp,
    date_add,
    datediff,
    filter,
    lit,
    size,
    when,
)

# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))
source_table = "lh_bronze.dbo.bronze_compliance"
target_table = "lh_silver.dbo.silver_compliance_validated"

# Regulatory thresholds
CTR_THRESHOLD = 10000
W2G_SLOT_THRESHOLD = 1200
W2G_OTHER_THRESHOLD = 600
SAR_FILING_DAYS = 30
CTR_FILING_DAYS = 15

print(f"Processing batch: {batch_id}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Compliance Data

# COMMAND ----------

if not spark.catalog.tableExists(source_table):
    raise Exception(f"Source table {source_table} does not exist")

df_bronze = spark.table(source_table)
print(f"Bronze records: {df_bronze.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Validation

# COMMAND ----------

# Core field validation
df_validated = df_bronze \
    .withColumn("is_valid_filing_type",
        col("filing_type").isin("CTR", "SAR", "W2G")) \
    .withColumn("is_valid_amount",
        col("amount").isNotNull() & (col("amount") > 0)) \
    .withColumn("is_valid_timestamp",
        col("filing_timestamp").isNotNull()) \
    .withColumn("has_player_info",
        col("player_id").isNotNull() | col("ssn_hash").isNotNull()) \
    .withColumn("has_transaction_ref",
        col("transaction_date").isNotNull() |
        col("transaction_amount").isNotNull() |
        col("machine_id").isNotNull())

# Calculate DQ score
df_with_dq = df_validated \
    .withColumn("_dq_score",
        (when(col("is_valid_filing_type"), lit(25)).otherwise(lit(0)) +
         when(col("is_valid_amount"), lit(25)).otherwise(lit(0)) +
         when(col("is_valid_timestamp"), lit(20)).otherwise(lit(0)) +
         when(col("has_player_info"), lit(20)).otherwise(lit(0)) +
         when(col("has_transaction_ref"), lit(10)).otherwise(lit(0)))) \
    .withColumn("_dq_passed", col("_dq_score") >= 70)

df_quality = df_with_dq.filter(col("_dq_passed"))
print(f"Records passing DQ: {df_quality.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Regulatory Threshold Validation

# COMMAND ----------

# Validate against regulatory thresholds
df_threshold_validated = df_quality \
    .withColumn("meets_ctr_threshold",
        when(col("filing_type") == "CTR", col("amount") >= CTR_THRESHOLD)
        .otherwise(lit(True))) \
    .withColumn("meets_w2g_threshold",
        when(col("filing_type") == "W2G",
            when(col("game_type") == "SLOTS", col("amount") >= W2G_SLOT_THRESHOLD)
            .otherwise(col("amount") >= W2G_OTHER_THRESHOLD))
        .otherwise(lit(True))) \
    .withColumn("threshold_validation_passed",
        col("meets_ctr_threshold") & col("meets_w2g_threshold")) \
    .withColumn("threshold_validation_notes",
        when(~col("meets_ctr_threshold"),
            concat(lit("CTR amount below $"), lit(CTR_THRESHOLD), lit(" threshold")))
        .when(~col("meets_w2g_threshold"),
            lit("W2G amount below jackpot threshold"))
        .otherwise(lit("PASSED")))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Filing Deadline Validation

# COMMAND ----------

# Calculate filing deadlines and compliance
# (transaction_date, filing_date, and status already exist in bronze_compliance —
#  don't recreate them, just compute derived deadline/status fields)
df_deadline_validated = df_threshold_validated \
    .withColumn("filing_deadline",
        when(col("filing_type") == "CTR",
            date_add(col("transaction_date"), CTR_FILING_DAYS))
        .when(col("filing_type") == "SAR",
            date_add(col("transaction_date"), SAR_FILING_DAYS))
        .otherwise(date_add(col("transaction_date"), CTR_FILING_DAYS))) \
    .withColumn("days_to_deadline",
        datediff(col("filing_deadline"), current_date())) \
    .withColumn("days_since_transaction",
        datediff(col("filing_date"), col("transaction_date"))) \
    .withColumn("filing_deadline_status",
        when(col("status") == "SUBMITTED", "FILED")
        .when(col("days_to_deadline") < 0, "OVERDUE")
        .when(col("days_to_deadline") <= 3, "DUE_SOON")
        .otherwise("ON_TRACK"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Completeness Validation

# COMMAND ----------

# Validate filing completeness based on type
df_completeness = df_deadline_validated \
    .withColumn("ctr_complete",
        when(col("filing_type") == "CTR",
            col("player_id").isNotNull() &
            col("ssn_hash").isNotNull() &
            col("amount").isNotNull() &
            col("transaction_type").isNotNull())
        .otherwise(lit(True))) \
    .withColumn("sar_complete",
        when(col("filing_type") == "SAR",
            col("player_id").isNotNull() &
            col("suspicious_activity_type").isNotNull() &
            col("narrative").isNotNull())
        .otherwise(lit(True))) \
    .withColumn("w2g_complete",
        when(col("filing_type") == "W2G",
            col("player_id").isNotNull() &
            col("ssn_hash").isNotNull() &
            col("amount").isNotNull() &
            col("game_type").isNotNull())
        .otherwise(lit(True))) \
    .withColumn("filing_complete",
        col("ctr_complete") & col("sar_complete") & col("w2g_complete"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Overall Validation Status

# COMMAND ----------

# Calculate overall validation status
df_final_validated = df_completeness \
    .withColumn("validation_passed",
        col("threshold_validation_passed") &
        col("filing_complete") &
        (col("filing_deadline_status") != "OVERDUE")) \
    .withColumn("validation_issues",
        array_compact(array(
            when(~col("threshold_validation_passed"), col("threshold_validation_notes")),
            when(~col("filing_complete"), lit("INCOMPLETE_FILING")),
            when(col("filing_deadline_status") == "OVERDUE", lit("FILING_OVERDUE")),
            when(col("filing_deadline_status") == "DUE_SOON", lit("FILING_DUE_SOON"))
        ))) \
    .withColumn("validation_issue_count",
        size(col("validation_issues")))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Regulatory Agency Assignment

# COMMAND ----------

# Assign regulatory agency
df_with_agency = df_final_validated \
    .withColumn("regulatory_agency",
        when(col("filing_type").isin("CTR", "SAR"), "FinCEN")
        .when(col("filing_type") == "W2G", "IRS")
        .otherwise("OTHER")) \
    .withColumn("form_number",
        when(col("filing_type") == "CTR", "FinCEN 103")
        .when(col("filing_type") == "SAR", "FinCEN 111")
        .when(col("filing_type") == "W2G", "IRS Form W-2G")
        .otherwise("N/A"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Final Silver DataFrame

# COMMAND ----------

df_silver = df_with_agency \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id)) \
    .drop(
        "is_valid_filing_type", "is_valid_amount",
        "is_valid_timestamp", "has_player_info", "has_transaction_ref",
        "ctr_complete", "sar_complete", "w2g_complete"
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Silver Table

# COMMAND ----------

try:
    # Delta MERGE upsert — deduplicate on filing_id
    if spark.catalog.tableExists(target_table):
        deltaTable = DeltaTable.forName(spark, target_table)
        deltaTable.alias("target").merge(
            df_silver.alias("source"),
            "target.filing_id = source.filing_id"
        ).whenMatchedUpdateAll(
            condition="target._silver_timestamp < source._silver_timestamp"
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        # First run — create the table
        df_silver.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("filing_date", "filing_type") \
            .option("overwriteSchema", "true") \
            .saveAsTable(target_table)

    record_count = spark.table(target_table).count()
    print(f"Merged {spark.table(target_table).count():,} source records into {target_table} (total: {record_count:,})")
except Exception as e:
    print(f"ERROR in lh_silver.silver_compliance_validated (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Compliance Validation Summary

# COMMAND ----------

# Filing type summary
spark.sql(f"""
    SELECT
        filing_type,
        regulatory_agency,
        COUNT(*) as filings,
        SUM(CASE WHEN validation_passed THEN 1 ELSE 0 END) as valid_filings,
        ROUND(SUM(CASE WHEN validation_passed THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) as validation_rate,
        SUM(amount) as total_amount
    FROM {target_table}
    GROUP BY filing_type, regulatory_agency
    ORDER BY filing_type
""").show()

# COMMAND ----------

# Deadline status summary
spark.sql(f"""
    SELECT
        filing_type,
        filing_deadline_status,
        COUNT(*) as count,
        SUM(amount) as total_amount
    FROM {target_table}
    GROUP BY filing_type, filing_deadline_status
    ORDER BY filing_type,
        CASE filing_deadline_status
            WHEN 'OVERDUE' THEN 1
            WHEN 'DUE_SOON' THEN 2
            WHEN 'ON_TRACK' THEN 3
            ELSE 4
        END
""").show()

# COMMAND ----------

# Validation issues breakdown — LATERAL VIEW lets us GROUP BY the exploded column
# (can't alias EXPLODE() in SELECT and GROUP BY that alias in the same query)
spark.sql(f"""
    SELECT
        issue,
        COUNT(*) as occurrences
    FROM {target_table}
    LATERAL VIEW EXPLODE(validation_issues) t AS issue
    WHERE validation_issue_count > 0
    GROUP BY issue
    ORDER BY occurrences DESC
""").show()

# COMMAND ----------

# Overdue filings requiring immediate attention
overdue = spark.sql(f"""
    SELECT
        filing_type,
        filing_deadline,
        days_to_deadline,
        amount,
        player_id
    FROM {target_table}
    WHERE filing_deadline_status = 'OVERDUE'
    ORDER BY days_to_deadline
    LIMIT 20
""")

if overdue.count() > 0:
    print("ALERT: OVERDUE FILINGS REQUIRING IMMEDIATE ACTION:")
    overdue.show(truncate=False)
else:
    print("No overdue filings found.")
