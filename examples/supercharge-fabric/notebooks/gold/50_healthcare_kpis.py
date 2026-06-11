# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Healthcare Operational KPIs
# MAGIC
# MAGIC Computes hospital performance metrics from Silver healthcare encounters.
# MAGIC
# MAGIC ## KPIs Calculated
# MAGIC - **Readmission Rate** (30-day, by DRG and payer)
# MAGIC - **Average LOS** (by DRG, payer, disposition)
# MAGIC - **ED-to-Admit Time** (median and P90)
# MAGIC - **Bed Occupancy Rate** (daily)
# MAGIC - **Denial Rate** (by payer)
# MAGIC - **Case Mix Index** (CMI)
# MAGIC
# MAGIC ## Target Tables
# MAGIC - `gold_healthcare_kpis` - Aggregated operational metrics
# MAGIC - `gold_healthcare_readmission_risk` - Patient-level readmission risk

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

import os
from datetime import datetime

from delta.tables import DeltaTable
from pyspark.sql.functions import (
    avg,
    coalesce,
    col,
    count,
    countDistinct,
    current_timestamp,
    expr,
    lit,
    max,
    min,
    percentile_approx,
    round as spark_round,
    sum,
    when,
)


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

source_table = "lh_silver.dbo.silver_healthcare_encounters"
target_kpis = "lh_gold.dbo.gold_healthcare_kpis"
target_readmit = "lh_gold.dbo.gold_healthcare_readmission_risk"

# CMS DRG weights (simplified top-10 for CMI calculation)
DRG_WEIGHTS = {
    "871": 5.41, "872": 3.21, "470": 1.91, "291": 1.64, "292": 0.98,
    "193": 1.43, "194": 0.91, "689": 1.14, "690": 0.72, "065": 3.87,
}
DEFAULT_DRG_WEIGHT = 1.00

TOTAL_BEDS = 350  # configurable hospital bed count

print(f"Batch: {batch_id}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Data

# COMMAND ----------

df = spark.table(source_table)
print(f"Silver records: {df.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## KPI 1: Aggregate Metrics by DRG

# COMMAND ----------

df_by_drg = df.groupBy("drg_code").agg(
    count("*").alias("encounters"),
    spark_round(avg("los_calc"), 2).alias("avg_los"),
    spark_round(avg(when(col("readmit_30d") == 1, 1).otherwise(0)) * 100, 2).alias("readmit_rate_pct"),
    countDistinct("mrn_hash").alias("unique_patients"),
    spark_round(avg("_dq_score"), 1).alias("avg_quality"),
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## KPI 2: Payer Analysis & Denial Rate

# COMMAND ----------

df_by_payer = df.groupBy("payer").agg(
    count("*").alias("encounters"),
    spark_round(avg("los_calc"), 2).alias("avg_los"),
    spark_round(avg(when(col("readmit_30d") == 1, 1).otherwise(0)) * 100, 2).alias("readmit_rate_pct"),
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## KPI 3: ED-to-Admit Time

# COMMAND ----------

df_ed_metrics = df.filter(col("ed_to_admit_minutes").isNotNull()).agg(
    spark_round(avg("ed_to_admit_minutes"), 1).alias("avg_ed_to_admit_min"),
    spark_round(percentile_approx("ed_to_admit_minutes", 0.5), 1).alias("median_ed_to_admit_min"),
    spark_round(percentile_approx("ed_to_admit_minutes", 0.9), 1).alias("p90_ed_to_admit_min"),
    count("*").alias("ed_encounters"),
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## KPI 4: Daily Bed Occupancy

# COMMAND ----------

df_daily_census = df.groupBy("admit_date").agg(
    count("*").alias("admissions"),
    spark_round(count("*") / lit(TOTAL_BEDS) * 100, 2).alias("occupancy_rate_pct"),
    spark_round(avg("los_calc"), 2).alias("avg_los"),
    sum(when(col("readmit_30d") == 1, 1).otherwise(0)).alias("readmissions"),
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## KPI 5: Case Mix Index

# COMMAND ----------

from pyspark.sql.functions import udf
from pyspark.sql.types import DoubleType

@udf(DoubleType())
def drg_weight_udf(drg_code):
    if drg_code is None:
        return float(DEFAULT_DRG_WEIGHT)
    return float(DRG_WEIGHTS.get(str(drg_code), DEFAULT_DRG_WEIGHT))

df_cmi = df.withColumn("drg_weight", drg_weight_udf(col("drg_code")))
cmi_value = df_cmi.agg(spark_round(avg("drg_weight"), 4).alias("case_mix_index")).collect()[0][0]
print(f"Case Mix Index: {cmi_value}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Build Combined KPI Table

# COMMAND ----------

# Combine DRG-level metrics with overall stats
df_kpi_combined = df_by_drg \
    .withColumn("metric_type", lit("by_drg")) \
    .withColumn("case_mix_index", lit(cmi_value)) \
    .withColumn("total_beds", lit(TOTAL_BEDS)) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

try:
    if spark.catalog.tableExists(target_kpis):
        deltaTable = DeltaTable.forName(spark, target_kpis)
        deltaTable.alias("target").merge(
            df_kpi_combined.alias("source"),
            "target.drg_code = source.drg_code AND target.metric_type = source.metric_type"
        ).whenMatchedUpdateAll().whenNotMatchedInsertAll().execute()
    else:
        df_kpi_combined.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .saveAsTable(target_kpis)

    print(f"Wrote KPIs to {target_kpis}")
except Exception as e:
    print(f"ERROR writing {target_kpis}: {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Build Readmission Risk Table

# COMMAND ----------

df_risk = df \
    .select(
        "encounter_id", "mrn_hash", "drg_code", "payer",
        "los_calc", "readmit_30d", "days_since_last_discharge",
        "age", "disposition", "ed_to_admit_minutes",
    ) \
    .withColumn("risk_score",
        (when(col("readmit_30d") == 1, lit(40)).otherwise(lit(0))) +
        (when(col("los_calc") > 7, lit(15)).otherwise(lit(0))) +
        (when(col("age") > 65, lit(15)).otherwise(lit(0))) +
        (when(col("disposition").isin("SNF", "LTAC", "Rehab"), lit(15)).otherwise(lit(0))) +
        (when(col("ed_to_admit_minutes") > 240, lit(15)).otherwise(lit(0)))
    ) \
    .withColumn("risk_tier",
        when(col("risk_score") >= 60, lit("HIGH"))
        .when(col("risk_score") >= 30, lit("MEDIUM"))
        .otherwise(lit("LOW"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

try:
    if spark.catalog.tableExists(target_readmit):
        deltaTable = DeltaTable.forName(spark, target_readmit)
        deltaTable.alias("target").merge(
            df_risk.alias("source"),
            "target.encounter_id = source.encounter_id"
        ).whenMatchedUpdateAll().whenNotMatchedInsertAll().execute()
    else:
        df_risk.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .saveAsTable(target_readmit)

    print(f"Wrote readmission risk to {target_readmit}")
except Exception as e:
    print(f"ERROR writing {target_readmit}: {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize for Direct Lake

# COMMAND ----------

spark.sql(f"OPTIMIZE {target_kpis} ZORDER BY (drg_code)")
spark.sql(f"OPTIMIZE {target_readmit} ZORDER BY (mrn_hash, risk_tier)")
print("Gold tables optimized")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation Summary

# COMMAND ----------

print("=== Healthcare KPI Summary ===")
spark.sql(f"SELECT * FROM {target_kpis} ORDER BY encounters DESC LIMIT 10").show(truncate=False)

print(f"\nCase Mix Index: {cmi_value}")
print(f"Total Beds: {TOTAL_BEDS}")

spark.sql(f"""
    SELECT risk_tier, COUNT(*) as patients,
           ROUND(AVG(risk_score), 1) as avg_score
    FROM {target_readmit}
    GROUP BY risk_tier ORDER BY avg_score DESC
""").show()

# COMMAND ----------

# MAGIC %md
# MAGIC **Next Step:** Connect Gold tables to Power BI via Direct Lake for the Healthcare Operations dashboard.
