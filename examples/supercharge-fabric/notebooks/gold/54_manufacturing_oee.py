# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Manufacturing OEE & Maintenance Predictions
# MAGIC
# MAGIC Computes Overall Equipment Effectiveness (OEE) per machine per shift and
# MAGIC generates predictive maintenance scores.
# MAGIC
# MAGIC ## OEE = Availability x Performance x Quality
# MAGIC
# MAGIC ## Source
# MAGIC - **Table:** silver_manufacturing_health
# MAGIC
# MAGIC ## Targets
# MAGIC - **gold_manufacturing_oee** -- OEE metrics per machine per shift
# MAGIC - **gold_maintenance_predictions** -- Predictive maintenance scores per machine

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from pyspark.sql import SparkSession, Window
from pyspark.sql.functions import (
    avg,
    col,
    count,
    current_timestamp,
    date_trunc,
    expr,
    greatest,
    hour,
    least,
    lit,
    max as spark_max,
    min as spark_min,
    sum as spark_sum,
    when,
)

SOURCE_TABLE = "lh_silver.silver_manufacturing_health"
OEE_TABLE = "lh_gold.gold_manufacturing_oee"
PREDICTIONS_TABLE = "lh_gold.gold_maintenance_predictions"

# Shift definitions (8-hour shifts)
SHIFT_HOURS = 8
PLANNED_MINUTES_PER_SHIFT = SHIFT_HOURS * 60  # 480

# Ideal cycle times per machine type (seconds per part)
IDEAL_CYCLE = {"CNC": 120, "press": 45, "robot": 30, "conveyor": 15}

print(f"Source: {SOURCE_TABLE}")
print(f"OEE Target: {OEE_TABLE}")
print(f"Predictions Target: {PREDICTIONS_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Data

# COMMAND ----------

df_silver = spark.table(SOURCE_TABLE)
print(f"Silver records: {df_silver.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Assign Shifts
# MAGIC
# MAGIC Shifts: Day (06:00-14:00), Swing (14:00-22:00), Night (22:00-06:00).

# COMMAND ----------

df_shifted = df_silver.withColumn(
    "shift",
    when((hour("window_start") >= 6) & (hour("window_start") < 14), lit("Day"))
    .when((hour("window_start") >= 14) & (hour("window_start") < 22), lit("Swing"))
    .otherwise(lit("Night")),
).withColumn("shift_date", date_trunc("day", col("window_start")).cast("date"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## OEE Calculation
# MAGIC
# MAGIC ### Availability
# MAGIC Fraction of shift minutes where machine was running (non-anomaly).
# MAGIC
# MAGIC ### Performance
# MAGIC Simulated from RPM consistency -- ratio of actual throughput to ideal.
# MAGIC
# MAGIC ### Quality
# MAGIC Simulated from anomaly and vibration/temperature variance.

# COMMAND ----------

df_oee_raw = (
    df_shifted
    .groupBy("machine_id", "machine_type", "shift_date", "shift")
    .agg(
        count("*").alias("total_minutes"),
        spark_sum(when(~col("is_anomaly"), 1).otherwise(0)).alias("run_minutes"),
        avg("vibration_avg").alias("avg_vibration"),
        avg("temperature_avg").alias("avg_temperature"),
        avg("current_avg").alias("avg_current"),
        spark_max("vibration_max").alias("peak_vibration"),
        spark_max("temperature_max").alias("peak_temperature"),
        avg("rpm_avg").alias("avg_rpm"),
        avg("vibration_stddev").alias("avg_vib_stddev"),
        avg("days_since_maintenance").alias("days_since_maint"),
        spark_sum(when(col("is_anomaly"), 1).otherwise(0)).alias("anomaly_minutes"),
    )
)

# Availability = run_minutes / planned_minutes
df_oee = df_oee_raw.withColumn(
    "availability",
    least(lit(1.0), col("run_minutes") / lit(PLANNED_MINUTES_PER_SHIFT)),
)

# Performance: simulate based on RPM stability
# Higher RPM stddev => lower performance
df_oee = df_oee.withColumn(
    "performance",
    least(
        lit(1.0),
        greatest(
            lit(0.3),
            lit(0.95) - (col("avg_vib_stddev") * 0.05),
        ),
    ),
)

# Quality: simulate from anomaly rate
df_oee = df_oee.withColumn(
    "quality",
    least(
        lit(1.0),
        greatest(
            lit(0.5),
            lit(1.0) - (col("anomaly_minutes") / greatest(col("total_minutes"), lit(1))) * 2,
        ),
    ),
)

# OEE composite
df_oee = df_oee.withColumn(
    "oee", col("availability") * col("performance") * col("quality")
)

# Energy per unit (simulated: current_avg * voltage_assumed / parts_estimated)
ASSUMED_VOLTAGE = 480  # 3-phase industrial
df_oee = df_oee.withColumn(
    "energy_kwh_per_unit",
    (col("avg_current") * lit(ASSUMED_VOLTAGE) * col("run_minutes") / 60 / 1000)
    / greatest(col("run_minutes") * lit(0.5), lit(1)),  # ~0.5 parts/min estimate
)

# Add processing timestamp
df_oee = df_oee.withColumn("_gold_processed_at", current_timestamp())

print(f"OEE records: {df_oee.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write OEE Table

# COMMAND ----------

df_oee.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(OEE_TABLE)

print(f"Written to {OEE_TABLE}: {spark.table(OEE_TABLE).count():,} rows")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Predictive Maintenance Scoring
# MAGIC
# MAGIC Composite score (0-100) based on:
# MAGIC - Vibration trend (weight 0.35)
# MAGIC - Temperature trend (weight 0.25)
# MAGIC - Current trend (weight 0.20)
# MAGIC - Days since maintenance (weight 0.20)

# COMMAND ----------

# Latest shift per machine for prediction
w_latest = Window.partitionBy("machine_id").orderBy(col("shift_date").desc(), col("shift").desc())

df_latest = (
    df_oee
    .withColumn("rn", expr("row_number() over (partition by machine_id order by shift_date desc, shift desc)"))
    .filter(col("rn") == 1)
    .drop("rn")
)

# Normalize components to 0-100
df_pred = (
    df_latest
    .withColumn(
        "vibration_score",
        least(lit(100), (col("peak_vibration") / lit(7.0)) * 100),
    )
    .withColumn(
        "temperature_score",
        least(lit(100), (col("peak_temperature") / lit(85.0)) * 100),
    )
    .withColumn(
        "current_score",
        least(lit(100), (col("avg_current") / lit(55.0)) * 100),
    )
    .withColumn(
        "maintenance_age_score",
        least(lit(100), (col("days_since_maint") / lit(90.0)) * 100),
    )
    .withColumn(
        "maintenance_risk_score",
        (col("vibration_score") * 0.35)
        + (col("temperature_score") * 0.25)
        + (col("current_score") * 0.20)
        + (col("maintenance_age_score") * 0.20),
    )
    .withColumn(
        "recommended_action",
        when(col("maintenance_risk_score") > 80, lit("IMMEDIATE - Schedule maintenance within 24h"))
        .when(col("maintenance_risk_score") > 60, lit("SOON - Schedule maintenance within 7 days"))
        .when(col("maintenance_risk_score") > 40, lit("MONITOR - Increase inspection frequency"))
        .otherwise(lit("NORMAL - Continue standard schedule")),
    )
    .select(
        "machine_id",
        "machine_type",
        "shift_date",
        "avg_vibration",
        "peak_vibration",
        "avg_temperature",
        "peak_temperature",
        "avg_current",
        "days_since_maint",
        "oee",
        "vibration_score",
        "temperature_score",
        "current_score",
        "maintenance_age_score",
        "maintenance_risk_score",
        "recommended_action",
    )
    .withColumn("_gold_processed_at", current_timestamp())
)

print(f"Prediction records: {df_pred.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Predictions Table

# COMMAND ----------

df_pred.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(PREDICTIONS_TABLE)

print(f"Written to {PREDICTIONS_TABLE}: {spark.table(PREDICTIONS_TABLE).count():,} rows")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Verification

# COMMAND ----------

print("=== OEE Summary by Machine Type ===")
display(
    spark.table(OEE_TABLE)
    .groupBy("machine_type")
    .agg(
        avg("oee").alias("avg_oee"),
        avg("availability").alias("avg_availability"),
        avg("performance").alias("avg_performance"),
        avg("quality").alias("avg_quality"),
        avg("energy_kwh_per_unit").alias("avg_energy_per_unit"),
    )
)

# COMMAND ----------

print("=== Maintenance Risk Distribution ===")
display(
    spark.table(PREDICTIONS_TABLE)
    .groupBy("recommended_action")
    .agg(count("*").alias("machine_count"))
    .orderBy("machine_count")
)

# COMMAND ----------

print("=== Top 10 Highest Risk Machines ===")
display(
    spark.table(PREDICTIONS_TABLE)
    .orderBy(col("maintenance_risk_score").desc())
    .select(
        "machine_id", "machine_type", "maintenance_risk_score",
        "oee", "recommended_action"
    )
    .limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Table | Purpose | Rows |
# MAGIC |-------|---------|------|
# MAGIC | gold_manufacturing_oee | OEE per machine per shift | Per machine x shift |
# MAGIC | gold_maintenance_predictions | Risk scores + recommendations | Per machine (latest) |
# MAGIC
# MAGIC **Next Step:** Power BI Direct Lake dashboard for OEE real-time monitoring.
