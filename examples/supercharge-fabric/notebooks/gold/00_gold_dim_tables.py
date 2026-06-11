# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Dimension Tables (dim_date, dim_machine)
# MAGIC
# MAGIC This notebook creates the shared dimension tables that fact tables and Direct
# MAGIC Lake semantic models depend on for time intelligence and machine attribution.
# MAGIC
# MAGIC ## Dimensions Created
# MAGIC - **dim_date** — standard date dimension (2020-2030) with year/quarter/month/day
# MAGIC   attributes, weekend flag, month and day names. Enables DAX `TOTALMTD`,
# MAGIC   `TOTALYTD`, and all time-intelligence measures.
# MAGIC - **dim_machine** — one row per distinct slot machine with manufacturer,
# MAGIC   machine_type, zone, denomination, and first_seen / last_seen. Sourced from
# MAGIC   `silver_slot_cleansed`.
# MAGIC
# MAGIC ## Run this BEFORE Tutorial 05 (Direct Lake + Power BI)
# MAGIC The semantic model's star schema requires these dims. Tutorial 05 cannot
# MAGIC complete without them.

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

# Imports, Fabric parameter shim, and configuration — all in one cell so the
# shim is guaranteed to be defined before it's called (avoids NameError when
# cells are run out of order after import).
import os
from datetime import datetime

from pyspark.sql.functions import (
    col,
    dayofmonth,
    dayofweek,
    dayofyear,
    first,
    month,
    quarter,
    weekofyear,
    when,
    year,
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

# Date dimension range — extend if your fact tables cover a wider window
DIM_DATE_START = _get_arg("dim_date_start", "2020-01-01")
DIM_DATE_END = _get_arg("dim_date_end", "2030-12-31")

# Source and target tables (three-part names for schema-enabled Lakehouses)
slot_source_table = "lh_silver.dbo.silver_slot_cleansed"
dim_date_table = "lh_gold.dbo.dim_date"
dim_machine_table = "lh_gold.dbo.dim_machine"

print(f"Processing batch: {batch_id}")
print(f"dim_date range: {DIM_DATE_START} -> {DIM_DATE_END}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Build dim_date
# MAGIC
# MAGIC Standard date dimension with hierarchy columns. `date_key` is the natural key
# MAGIC used by fact tables like `gold_slot_performance.business_date` and
# MAGIC `gold_compliance_reporting.report_date`.

# COMMAND ----------

df_dim_date = (
    spark.sql(
        f"SELECT explode(sequence(to_date('{DIM_DATE_START}'), to_date('{DIM_DATE_END}'), interval 1 day)) AS date_key"
    )
    .withColumn("year", year("date_key"))
    .withColumn("quarter", quarter("date_key"))
    .withColumn("month", month("date_key"))
    .withColumn("day", dayofmonth("date_key"))
    .withColumn("day_of_week", dayofweek("date_key"))
    .withColumn("day_of_year", dayofyear("date_key"))
    .withColumn("week_of_year", weekofyear("date_key"))
    .withColumn("is_weekend", dayofweek("date_key").isin(1, 7))
    .withColumn(
        "month_name",
        when(col("month") == 1, "January")
        .when(col("month") == 2, "February")
        .when(col("month") == 3, "March")
        .when(col("month") == 4, "April")
        .when(col("month") == 5, "May")
        .when(col("month") == 6, "June")
        .when(col("month") == 7, "July")
        .when(col("month") == 8, "August")
        .when(col("month") == 9, "September")
        .when(col("month") == 10, "October")
        .when(col("month") == 11, "November")
        .otherwise("December"),
    )
    .withColumn(
        "day_name",
        when(col("day_of_week") == 1, "Sunday")
        .when(col("day_of_week") == 2, "Monday")
        .when(col("day_of_week") == 3, "Tuesday")
        .when(col("day_of_week") == 4, "Wednesday")
        .when(col("day_of_week") == 5, "Thursday")
        .when(col("day_of_week") == 6, "Friday")
        .otherwise("Saturday"),
    )
)

df_dim_date.write.format("delta").mode("overwrite").saveAsTable(dim_date_table)
print(f"{dim_date_table} written: {df_dim_date.count():,} rows")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Build dim_machine
# MAGIC
# MAGIC One row per distinct slot machine with static attributes. Sourced from
# MAGIC `silver_slot_cleansed` by grouping on `machine_id` and picking the first
# MAGIC non-null value for each attribute. `first_seen` / `last_seen` bracket the
# MAGIC observed event window.

# COMMAND ----------

df_dim_machine = (
    spark.table(slot_source_table)
    .filter(col("machine_id").isNotNull())
    .groupBy("machine_id")
    .agg(
        first("manufacturer", ignorenulls=True).alias("manufacturer"),
        first("machine_type", ignorenulls=True).alias("machine_type"),
        first("zone", ignorenulls=True).alias("zone"),
        first("denomination", ignorenulls=True).alias("denomination"),
        spark_min("event_timestamp").alias("first_seen"),
        spark_max("event_timestamp").alias("last_seen"),
    )
)

df_dim_machine.write.format("delta").mode("overwrite").saveAsTable(dim_machine_table)
print(f"{dim_machine_table} written: {df_dim_machine.count():,} rows")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation

# COMMAND ----------

print("=" * 60)
print("Dimension tables summary")
print("=" * 60)
for tbl in [dim_date_table, dim_machine_table]:
    cnt = spark.table(tbl).count()
    print(f"{tbl:40} {cnt:>8,} rows")

spark.sql(f"SELECT * FROM {dim_date_table} LIMIT 5").show()
spark.sql(f"SELECT * FROM {dim_machine_table} LIMIT 5").show()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Next Steps
# MAGIC
# MAGIC 1. Open your Direct Lake semantic model (`sm_casino_gold`)
# MAGIC 2. **Add tables** -> select `dim_date` and `dim_machine` from `lh_gold`
# MAGIC 3. Create relationships per Tutorial 05 Step 2:
# MAGIC    - `dim_date[date_key]` 1 -> * `gold_slot_performance[business_date]`
# MAGIC    - `dim_date[date_key]` 1 -> * `gold_compliance_reporting[report_date]`
# MAGIC    - `dim_machine[machine_id]` 1 -> * `gold_slot_performance[machine_id]`
# MAGIC 4. Proceed to Tutorial 05 Step 3 (DAX measures with time intelligence)
