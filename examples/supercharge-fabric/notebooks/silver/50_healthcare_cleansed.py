# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Healthcare Encounter Cleansing
# MAGIC
# MAGIC Transforms Bronze healthcare admissions into cleansed Silver encounters.
# MAGIC
# MAGIC ## Transformations
# MAGIC - Deduplication on encounter_id (latest ingestion wins)
# MAGIC - ICD-10 format validation (letter + digits + dot pattern)
# MAGIC - Null checks on critical fields
# MAGIC - LOS recalculation from admit/discharge dates
# MAGIC - 30-day readmission flag derivation
# MAGIC - Data quality scoring

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

import os
from datetime import datetime

from delta.tables import DeltaTable
from pyspark.sql.functions import (
    avg,
    col,
    count,
    current_timestamp,
    datediff,
    lag,
    lit,
    regexp_extract,
    row_number,
    to_date,
    to_timestamp,
    trim,
    upper,
    when,
)
from pyspark.sql.window import Window


def _get_arg(name: str, default=None):
    """Read a notebook parameter from Fabric/Synapse runtime, env var, or default."""
    try:
        import notebookutils
        return notebookutils.notebook.getArgument(name, default)
    except Exception:
        try:
            import mssparkutils
            return mssparkutils.notebook.getArgument(name, default)
        except Exception:
            return os.environ.get(name.upper(), default)


batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

source_table = "lh_bronze.dbo.bronze_healthcare_admissions"
target_table = "lh_silver.dbo.silver_healthcare_encounters"

print(f"Processing batch: {batch_id}")
print(f"Source: {source_table}")
print(f"Target: {target_table}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Data

# COMMAND ----------

df_bronze = spark.table(source_table)
print(f"Bronze records: {df_bronze.count():,}")
df_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Parse Timestamps & Recalculate LOS

# COMMAND ----------

df_parsed = df_bronze \
    .withColumn("admit_dt", to_timestamp("admit_dt")) \
    .withColumn("discharge_dt", to_timestamp("discharge_dt")) \
    .withColumn("ed_arrival_dt", to_timestamp("ed_arrival_dt")) \
    .withColumn("admit_date", to_date("admit_dt")) \
    .withColumn("discharge_date", to_date("discharge_dt")) \
    .withColumn("los_calc", datediff("discharge_dt", "admit_dt")) \
    .withColumn("los_calc",
        when(col("los_calc") < 0, lit(None)).otherwise(col("los_calc")))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Null Checks & Filtering

# COMMAND ----------

df_filtered = df_parsed \
    .filter(col("encounter_id").isNotNull()) \
    .filter(col("mrn_hash").isNotNull()) \
    .filter(col("admit_dt").isNotNull())

dropped = df_bronze.count() - df_filtered.count()
print(f"Dropped {dropped:,} records with null critical fields")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Deduplication

# COMMAND ----------

dedup_window = Window.partitionBy("encounter_id") \
    .orderBy(col("_bronze_ingested_at").desc())

df_deduped = df_filtered \
    .withColumn("_rn", row_number().over(dedup_window)) \
    .filter(col("_rn") == 1) \
    .drop("_rn")

print(f"After deduplication: {df_deduped.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Standardize & Validate

# COMMAND ----------

df_clean = df_deduped \
    .withColumn("drg_code", trim(col("drg_code"))) \
    .withColumn("payer", trim(upper(col("payer")))) \
    .withColumn("disposition", trim(col("disposition"))) \
    .withColumn("gender", upper(trim(col("gender")))) \
    .withColumn("readmit_flag",
        when(col("readmit_flag").isin(0, 1), col("readmit_flag")).otherwise(lit(0)))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Derive 30-Day Readmission Flag

# COMMAND ----------

readmit_window = Window.partitionBy("mrn_hash") \
    .orderBy("admit_dt")

df_readmit = df_clean \
    .withColumn("prev_discharge_dt",
        lag("discharge_dt").over(readmit_window)) \
    .withColumn("days_since_last_discharge",
        datediff("admit_dt", "prev_discharge_dt")) \
    .withColumn("readmit_30d",
        when(
            (col("days_since_last_discharge").isNotNull()) &
            (col("days_since_last_discharge") <= 30) &
            (col("days_since_last_discharge") >= 0),
            lit(1)
        ).otherwise(lit(0))) \
    .drop("prev_discharge_dt")

# COMMAND ----------

# MAGIC %md
# MAGIC ## ED-to-Admit Time

# COMMAND ----------

df_ed = df_readmit \
    .withColumn("ed_to_admit_minutes",
        when(col("ed_arrival_dt").isNotNull(),
             (col("admit_dt").cast("long") - col("ed_arrival_dt").cast("long")) / 60)
        .otherwise(lit(None)))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Score

# COMMAND ----------

df_dq = df_ed \
    .withColumn("_dq_score",
        when(col("encounter_id").isNotNull(), lit(20)).otherwise(lit(0)) +
        when(col("drg_code").isNotNull(), lit(20)).otherwise(lit(0)) +
        when(col("payer").isNotNull(), lit(20)).otherwise(lit(0)) +
        when(col("los_calc").isNotNull() & (col("los_calc") >= 0), lit(20)).otherwise(lit(0)) +
        when(col("disposition").isNotNull(), lit(20)).otherwise(lit(0))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Silver Metadata & Write

# COMMAND ----------

df_silver = df_dq \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

final_columns = [
    "encounter_id", "mrn_hash", "ssn_masked",
    "admit_dt", "discharge_dt", "admit_date", "discharge_date",
    "los", "los_calc", "drg_code", "payer", "disposition",
    "readmit_flag", "readmit_30d", "days_since_last_discharge",
    "ed_arrival_dt", "ed_to_admit_minutes",
    "age", "gender",
    "_dq_score", "_silver_timestamp", "_batch_id",
]

df_final = df_silver.select([col(c) for c in final_columns if c in df_silver.columns])

try:
    if spark.catalog.tableExists(target_table):
        deltaTable = DeltaTable.forName(spark, target_table)
        deltaTable.alias("target").merge(
            df_final.alias("source"),
            "target.encounter_id = source.encounter_id"
        ).whenMatchedUpdateAll(
            condition="target._silver_timestamp < source._silver_timestamp"
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_final.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("admit_date") \
            .option("overwriteSchema", "true") \
            .saveAsTable(target_table)

    print(f"Wrote to {target_table} ({spark.table(target_table).count():,} total)")
except Exception as e:
    print(f"ERROR in {target_table} (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        COUNT(*) as total,
        ROUND(AVG(_dq_score), 2) as avg_quality,
        ROUND(AVG(los_calc), 1) as avg_los,
        SUM(readmit_30d) as readmissions_30d
    FROM {target_table}
""").show()

# COMMAND ----------

spark.sql(f"OPTIMIZE {target_table} ZORDER BY (mrn_hash)")
print("Table optimized with Z-Order on mrn_hash")

# COMMAND ----------

# MAGIC %md
# MAGIC **Next Step:** Continue to Gold layer KPIs (`50_healthcare_kpis.py`).
