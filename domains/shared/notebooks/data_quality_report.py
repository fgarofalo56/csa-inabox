# Databricks notebook source
# MAGIC %md
# MAGIC # CSA-in-a-Box: Data Quality Report
# MAGIC
# MAGIC Runs quality checks against Gold-layer tables using rules defined in
# MAGIC `governance/dataquality/quality-rules.yaml`. Produces a scorecard
# MAGIC covering completeness, accuracy, consistency, and timeliness, then
# MAGIC persists results to a Delta table for trend analysis.
# MAGIC
# MAGIC **Output table:** `gold.data_quality_results`

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Configuration

# COMMAND ----------

from datetime import datetime, timezone

import yaml
from pyspark.sql import functions as F
from pyspark.sql.types import (
    BooleanType,
    DoubleType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

dbutils.widgets.text(
    "rules_path", "/Workspace/Repos/csa-inabox/governance/dataquality/quality-rules.yaml", "Quality Rules Path"
)
dbutils.widgets.text("catalog", "csa_inabox", "Unity Catalog Name")

rules_path = dbutils.widgets.get("rules_path")
catalog = dbutils.widgets.get("catalog")

RESULTS_TABLE = f"{catalog}.gold.data_quality_results"
RUN_TIMESTAMP = datetime.now(timezone.utc)
RUN_ID = RUN_TIMESTAMP.strftime("%Y%m%d_%H%M%S")

print(f"Run ID: {RUN_ID}")
print(f"Results table: {RESULTS_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Load Quality Rules

# COMMAND ----------

# Load the YAML rules file
try:
    with open(rules_path.replace("/Workspace/Repos/csa-inabox/", "")) as f:
        rules_config = yaml.safe_load(f)
    print(f"Loaded {len(rules_config.get('rules', {}))} rule categories")
except FileNotFoundError:
    # Fallback: try reading from DBFS
    raw = dbutils.fs.head(f"dbfs:{rules_path}", 10000)
    rules_config = yaml.safe_load(raw)
    print(f"Loaded rules from DBFS: {len(rules_config.get('rules', {}))} categories")

rules = rules_config.get("rules", {})
print(f"Rule categories: {list(rules.keys())}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Quality Check Functions

# COMMAND ----------

# Results schema
result_schema = StructType(
    [
        StructField("run_id", StringType(), False),
        StructField("run_timestamp", TimestampType(), False),
        StructField("table_name", StringType(), False),
        StructField("check_category", StringType(), False),
        StructField("check_name", StringType(), False),
        StructField("column_name", StringType(), True),
        StructField("passed", BooleanType(), False),
        StructField("expected_value", StringType(), True),
        StructField("actual_value", StringType(), True),
        StructField("score", DoubleType(), True),
        StructField("severity", StringType(), True),
        StructField("details", StringType(), True),
    ]
)

check_results = []


def add_result(table, category, check, column, passed, expected, actual, score=None, severity="error", details=None):
    """Append a quality check result."""
    check_results.append(
        (
            RUN_ID,
            RUN_TIMESTAMP,
            table,
            category,
            check,
            column,
            passed,
            str(expected),
            str(actual),
            score,
            severity,
            details,
        )
    )


def resolve_table(table_ref: str) -> str:
    """Convert short table reference (e.g. 'gold.gld_sales_metrics') to FQN."""
    parts = table_ref.split(".")
    if len(parts) == 2:
        return f"{catalog}.{parts[0]}.{parts[1]}"
    return table_ref


# COMMAND ----------

# MAGIC %md
# MAGIC ### 3a. Completeness Checks (Null Analysis)

# COMMAND ----------


def check_completeness(table_fqn: str, required_columns: list[dict]) -> None:
    """Check that required columns have no nulls."""
    try:
        df = spark.table(table_fqn)
    except Exception as exc:
        add_result(table_fqn, "completeness", "table_exists", None, False, "exists", str(exc), 0.0)
        return

    row_count = df.count()
    if row_count == 0:
        add_result(table_fqn, "completeness", "has_rows", None, False, ">0", "0", 0.0)
        return

    for col_def in required_columns:
        col_name = col_def["name"]
        if col_name not in df.columns:
            add_result(table_fqn, "completeness", "column_exists", col_name, False, "exists", "missing", 0.0)
            continue

        null_count = df.where(F.col(col_name).isNull()).count()
        completeness = round((row_count - null_count) / row_count * 100, 2)
        passed = null_count == 0
        add_result(
            table_fqn,
            "completeness",
            "not_null",
            col_name,
            passed,
            "0 nulls",
            f"{null_count} nulls",
            completeness,
            "warn" if null_count < row_count * 0.05 else "error",
        )


# Run completeness checks from schema rules
for schema_rule in rules.get("schema", []):
    table_fqn = resolve_table(schema_rule["table"])
    check_completeness(table_fqn, schema_rule.get("required_columns", []))

print(f"Completeness checks done: {len(check_results)} results so far")

# COMMAND ----------

# MAGIC %md
# MAGIC ### 3b. Uniqueness Checks

# COMMAND ----------


def check_uniqueness(table_fqn: str, columns: list[str]) -> None:
    """Check that column combinations are unique."""
    try:
        df = spark.table(table_fqn)
    except Exception:
        return

    row_count = df.count()
    distinct_count = df.select(*columns).distinct().count()
    duplicate_count = row_count - distinct_count
    score = round(distinct_count / max(row_count, 1) * 100, 2)
    passed = duplicate_count == 0

    add_result(
        table_fqn,
        "accuracy",
        "uniqueness",
        ", ".join(columns),
        passed,
        f"{row_count} unique",
        f"{duplicate_count} duplicates",
        score,
    )


for uniqueness_rule in rules.get("uniqueness", []):
    table_fqn = resolve_table(uniqueness_rule["table"])
    check_uniqueness(table_fqn, uniqueness_rule["columns"])

print(f"Uniqueness checks done: {len(check_results)} results so far")

# COMMAND ----------

# MAGIC %md
# MAGIC ### 3c. Consistency Checks (Referential Integrity)

# COMMAND ----------


def check_referential_integrity(child_fqn, child_col, parent_fqn, parent_col):
    """Check that all child FK values exist in the parent table."""
    try:
        child_df = spark.table(child_fqn)
        parent_df = spark.table(parent_fqn)
    except Exception:
        return

    child_keys = child_df.select(child_col).distinct()
    parent_keys = parent_df.select(parent_col).distinct()

    orphans = child_keys.subtract(parent_keys).count()
    total = child_keys.count()
    score = round((total - orphans) / max(total, 1) * 100, 2)
    passed = orphans == 0

    add_result(
        child_fqn,
        "consistency",
        "referential_integrity",
        f"{child_col} -> {parent_fqn}.{parent_col}",
        passed,
        "0 orphans",
        f"{orphans} orphans",
        score,
    )


for ri_rule in rules.get("referential_integrity", []):
    child_fqn = resolve_table(ri_rule["child"])
    parent_fqn = resolve_table(ri_rule["parent"])
    check_referential_integrity(
        child_fqn,
        ri_rule["child_column"],
        parent_fqn,
        ri_rule["parent_column"],
    )

print(f"Consistency checks done: {len(check_results)} results so far")

# COMMAND ----------

# MAGIC %md
# MAGIC ### 3d. Volume Checks

# COMMAND ----------


def check_volume(table_fqn: str, min_rows: int, max_growth_pct: int = None):
    """Check table row count against expected bounds."""
    try:
        df = spark.table(table_fqn)
    except Exception:
        return

    row_count = df.count()
    passed = row_count >= min_rows
    score = 100.0 if passed else round(row_count / max(min_rows, 1) * 100, 2)

    add_result(
        table_fqn,
        "completeness",
        "min_row_count",
        None,
        passed,
        f">= {min_rows}",
        str(row_count),
        score,
    )


for vol_rule in rules.get("volume", []):
    table_fqn = resolve_table(vol_rule["table"])
    check_volume(table_fqn, vol_rule["min_rows"], vol_rule.get("max_growth_pct"))

print(f"Volume checks done: {len(check_results)} results so far")

# COMMAND ----------

# MAGIC %md
# MAGIC ### 3e. Custom Business Rules

# COMMAND ----------


def check_custom_rule(table_fqn: str, rule_name: str, expression: str, severity: str = "error"):
    """Evaluate a custom SQL expression against a table."""
    try:
        df = spark.table(table_fqn)
    except Exception:
        return

    row_count = df.count()
    if row_count == 0:
        return

    passing = df.where(expression).count()
    score = round(passing / row_count * 100, 2)
    passed = passing == row_count

    add_result(
        table_fqn,
        "accuracy",
        f"custom:{rule_name}",
        None,
        passed,
        "all rows match",
        f"{row_count - passing} violations",
        score,
        severity,
    )


for custom_rule in rules.get("custom", []):
    table_fqn = resolve_table(custom_rule["table"])
    check_custom_rule(
        table_fqn,
        custom_rule["name"],
        custom_rule["expression"],
        custom_rule.get("severity", "error"),
    )

print(f"Custom checks done: {len(check_results)} results so far")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Quality Scorecard

# COMMAND ----------

# Build results DataFrame
results_df = spark.createDataFrame(check_results, schema=result_schema)
results_df.createOrReplaceTempView("quality_results")

# Overall scorecard by category
scorecard = results_df.groupBy("check_category").agg(
    F.count("*").alias("total_checks"),
    F.sum(F.when(F.col("passed"), 1).otherwise(0)).alias("passed"),
    F.sum(F.when(~F.col("passed"), 1).otherwise(0)).alias("failed"),
    F.round(F.avg("score"), 2).alias("avg_score"),
)
scorecard = scorecard.withColumn(
    "pass_rate",
    F.round(F.col("passed") / F.col("total_checks") * 100, 1),
)

print("\n" + "=" * 70)
print("DATA QUALITY SCORECARD")
print("=" * 70)
display(scorecard)

# Summary metrics
total = results_df.count()
passed_total = results_df.where(F.col("passed")).count()
overall_score = round(passed_total / max(total, 1) * 100, 1)

print(f"\nOverall: {passed_total}/{total} checks passed ({overall_score}%)")
print(f"Run ID: {RUN_ID}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Failed Checks Detail

# COMMAND ----------

failed_df = results_df.where(~F.col("passed")).orderBy("severity", "table_name")

if failed_df.count() > 0:
    print(f"\nFAILED CHECKS ({failed_df.count()}):")
    display(failed_df)
else:
    print("\nAll checks passed!")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Persist Results to Delta

# COMMAND ----------

# Write results to the gold quality results table (append mode for history)
results_df.write.format("delta").mode("append").saveAsTable(RESULTS_TABLE)

print(f"Results written to {RESULTS_TABLE}")
print(f"Total records in history: {spark.table(RESULTS_TABLE).count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 7. Quality Trends Over Time

# COMMAND ----------

# MAGIC %sql
# MAGIC -- Quality score trend (last 30 runs)
# MAGIC SELECT
# MAGIC   run_id,
# MAGIC   run_timestamp,
# MAGIC   check_category,
# MAGIC   COUNT(*) AS total_checks,
# MAGIC   SUM(CASE WHEN passed THEN 1 ELSE 0 END) AS passed,
# MAGIC   ROUND(AVG(score), 2) AS avg_score,
# MAGIC   ROUND(SUM(CASE WHEN passed THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) AS pass_rate
# MAGIC FROM gold.data_quality_results
# MAGIC GROUP BY run_id, run_timestamp, check_category
# MAGIC ORDER BY run_timestamp DESC
# MAGIC LIMIT 100

# COMMAND ----------

# MAGIC %md
# MAGIC ## 8. Worst-Performing Columns

# COMMAND ----------

# MAGIC %sql
# MAGIC -- Columns with the lowest quality scores (latest run)
# MAGIC WITH latest_run AS (
# MAGIC   SELECT MAX(run_id) AS run_id FROM gold.data_quality_results
# MAGIC )
# MAGIC SELECT
# MAGIC   r.table_name,
# MAGIC   r.column_name,
# MAGIC   r.check_category,
# MAGIC   r.check_name,
# MAGIC   r.score,
# MAGIC   r.actual_value,
# MAGIC   r.severity
# MAGIC FROM gold.data_quality_results r
# MAGIC JOIN latest_run lr ON r.run_id = lr.run_id
# MAGIC WHERE r.column_name IS NOT NULL
# MAGIC   AND r.score < 100
# MAGIC ORDER BY r.score ASC
# MAGIC LIMIT 20
