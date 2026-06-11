# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Manufacturing Machine Health
# MAGIC
# MAGIC Aggregates raw sensor telemetry into 1-minute windows per sensor per machine.
# MAGIC Computes anomaly flags (z-score > 3) and time since last maintenance.
# MAGIC
# MAGIC ## Source
# MAGIC - **Table:** bronze_manufacturing_sensors
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** silver_manufacturing_health
# MAGIC - **Grain:** 1 machine x 1 minute
# MAGIC - **Format:** Delta Lake (merge/upsert)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from pyspark.sql import SparkSession, Window
from pyspark.sql.functions import (
    abs as spark_abs,
    avg,
    col,
    current_timestamp,
    datediff,
    lit,
    max as spark_max,
    min as spark_min,
    stddev,
    to_timestamp,
    when,
    window,
)

SOURCE_TABLE = "lh_bronze.bronze_manufacturing_sensors"
TARGET_TABLE = "lh_silver.silver_manufacturing_health"

# Anomaly detection threshold (z-score)
Z_SCORE_THRESHOLD = 3.0

# Maintenance reference table (optional -- falls back to metadata if absent)
MAINTENANCE_TABLE = "lh_bronze.bronze_manufacturing_work_orders"

print(f"Source: {SOURCE_TABLE}")
print(f"Target: {TARGET_TABLE}")
print(f"Z-score threshold: {Z_SCORE_THRESHOLD}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Data

# COMMAND ----------

df_bronze = spark.table(SOURCE_TABLE)
print(f"Bronze records: {df_bronze.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1-Minute Aggregations
# MAGIC
# MAGIC Compute avg, max, min, stddev for each sensor metric per machine per minute.

# COMMAND ----------

df_agg = (
    df_bronze
    .withColumn("event_ts", to_timestamp(col("timestamp")))
    .groupBy(
        col("machine_id"),
        col("machine_type"),
        window(col("event_ts"), "1 minute").alias("time_window"),
    )
    .agg(
        # Vibration
        avg("vibration_mm_s").alias("vibration_avg"),
        spark_max("vibration_mm_s").alias("vibration_max"),
        stddev("vibration_mm_s").alias("vibration_stddev"),
        # Temperature
        avg("temperature_c").alias("temperature_avg"),
        spark_max("temperature_c").alias("temperature_max"),
        stddev("temperature_c").alias("temperature_stddev"),
        # Current
        avg("current_a").alias("current_avg"),
        spark_max("current_a").alias("current_max"),
        stddev("current_a").alias("current_stddev"),
        # Pressure
        avg("pressure_bar").alias("pressure_avg"),
        spark_min("pressure_bar").alias("pressure_min"),
        # RPM
        avg("rpm").alias("rpm_avg"),
        stddev("rpm").alias("rpm_stddev"),
    )
    .withColumn("window_start", col("time_window.start"))
    .withColumn("window_end", col("time_window.end"))
    .drop("time_window")
)

print(f"Aggregated rows: {df_agg.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Anomaly Detection (Z-Score)
# MAGIC
# MAGIC Compute rolling z-scores over a 1-hour window. Flag readings where
# MAGIC any sensor z-score exceeds the threshold.

# COMMAND ----------

# Rolling statistics window: 60 one-minute rows per machine
w_rolling = (
    Window.partitionBy("machine_id")
    .orderBy("window_start")
    .rowsBetween(-59, 0)
)

df_zscore = (
    df_agg
    .withColumn("vib_rolling_avg", avg("vibration_avg").over(w_rolling))
    .withColumn("vib_rolling_std", stddev("vibration_avg").over(w_rolling))
    .withColumn(
        "vibration_zscore",
        when(
            col("vib_rolling_std") > 0,
            spark_abs(col("vibration_avg") - col("vib_rolling_avg")) / col("vib_rolling_std"),
        ).otherwise(0.0),
    )
    .withColumn("temp_rolling_avg", avg("temperature_avg").over(w_rolling))
    .withColumn("temp_rolling_std", stddev("temperature_avg").over(w_rolling))
    .withColumn(
        "temperature_zscore",
        when(
            col("temp_rolling_std") > 0,
            spark_abs(col("temperature_avg") - col("temp_rolling_avg")) / col("temp_rolling_std"),
        ).otherwise(0.0),
    )
    .withColumn("cur_rolling_avg", avg("current_avg").over(w_rolling))
    .withColumn("cur_rolling_std", stddev("current_avg").over(w_rolling))
    .withColumn(
        "current_zscore",
        when(
            col("cur_rolling_std") > 0,
            spark_abs(col("current_avg") - col("cur_rolling_avg")) / col("cur_rolling_std"),
        ).otherwise(0.0),
    )
)

# Composite anomaly flag
df_anomaly = df_zscore.withColumn(
    "is_anomaly",
    when(
        (col("vibration_zscore") > Z_SCORE_THRESHOLD)
        | (col("temperature_zscore") > Z_SCORE_THRESHOLD)
        | (col("current_zscore") > Z_SCORE_THRESHOLD),
        True,
    ).otherwise(False),
)

anomaly_count = df_anomaly.filter(col("is_anomaly")).count()
total_count = df_anomaly.count()
print(f"Anomalies detected: {anomaly_count:,} / {total_count:,} ({100*anomaly_count/max(total_count,1):.2f}%)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Time Since Last Maintenance

# COMMAND ----------

# Try to load maintenance dates; fall back to a static default
try:
    df_maint = (
        spark.table(MAINTENANCE_TABLE)
        .groupBy("machine_id")
        .agg(spark_max("completed_dt").alias("last_maintenance_dt"))
    )
    df_health = df_anomaly.join(df_maint, on="machine_id", how="left")
except Exception:
    print(f"Maintenance table not found; using default 30-day offset")
    df_health = df_anomaly.withColumn("last_maintenance_dt", lit(None))

df_health = df_health.withColumn(
    "days_since_maintenance",
    when(
        col("last_maintenance_dt").isNotNull(),
        datediff(col("window_start"), to_timestamp(col("last_maintenance_dt"))),
    ).otherwise(lit(30)),
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Select Final Columns

# COMMAND ----------

df_silver = (
    df_health.select(
        "machine_id",
        "machine_type",
        "window_start",
        "window_end",
        "vibration_avg",
        "vibration_max",
        "vibration_stddev",
        "temperature_avg",
        "temperature_max",
        "temperature_stddev",
        "current_avg",
        "current_max",
        "current_stddev",
        "pressure_avg",
        "pressure_min",
        "rpm_avg",
        "rpm_stddev",
        "vibration_zscore",
        "temperature_zscore",
        "current_zscore",
        "is_anomaly",
        "days_since_maintenance",
    )
    .withColumn("_silver_processed_at", current_timestamp())
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Silver Delta Table

# COMMAND ----------

df_silver.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(TARGET_TABLE)

final_count = spark.table(TARGET_TABLE).count()
print(f"Silver table written: {final_count:,} rows")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Verification

# COMMAND ----------

df_verify = spark.table(TARGET_TABLE)

print("Anomaly Summary by Machine Type:")
display(
    df_verify
    .groupBy("machine_type")
    .agg(
        avg("vibration_avg").alias("avg_vibration"),
        avg("temperature_avg").alias("avg_temperature"),
        avg("is_anomaly".cast("int")).alias("anomaly_rate"),
    )
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Metric | Value |
# MAGIC |--------|-------|
# MAGIC | Source | bronze_manufacturing_sensors |
# MAGIC | Target | silver_manufacturing_health |
# MAGIC | Grain | 1 machine x 1 minute |
# MAGIC | Anomaly Method | Z-score > 3.0 |
# MAGIC
# MAGIC **Next Step:** Gold layer OEE calculation (`54_manufacturing_oee.py`).
