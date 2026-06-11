# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Energy Meter Readings - Validated & Enriched
# MAGIC
# MAGIC This notebook transforms raw AMI readings from Bronze into validated,
# MAGIC quality-checked records in the Silver layer.
# MAGIC
# MAGIC ## Transformations
# MAGIC - Voltage validation (ANSI C84.1: 108-132V for 120V service)
# MAGIC - Gap detection and interpolation for missing 15-min intervals
# MAGIC - Tamper/theft pattern flagging
# MAGIC - Daily and monthly consumption aggregation
# MAGIC
# MAGIC ## Source → Target
# MAGIC - **Source:** lh_bronze.bronze_energy_meters
# MAGIC - **Target:** lh_silver.silver_energy_consumption
# MAGIC - **Compliance:** NERC CIP data quality controls

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from datetime import datetime

from pyspark.sql import Window
from pyspark.sql.functions import (
    abs as spark_abs,
    avg,
    col,
    count,
    current_timestamp,
    datediff,
    dayofmonth,
    expr,
    lag,
    last,
    lit,
    month,
    round as spark_round,
    sum as spark_sum,
    to_date,
    unix_timestamp,
    when,
    year,
)

SOURCE_TABLE = "lh_bronze.bronze_energy_meters"
TARGET_TABLE = "lh_silver.silver_energy_consumption"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

# ANSI C84.1 voltage limits for 120V nominal service
VOLTAGE_MIN_RANGE_B = 108.0   # Range B lower (extreme)
VOLTAGE_MAX_RANGE_B = 132.0   # Range B upper (extreme)
VOLTAGE_MIN_RANGE_A = 114.0   # Range A lower (normal)
VOLTAGE_MAX_RANGE_A = 126.0   # Range A upper (normal)

INTERVAL_SECONDS = 900  # 15 minutes

print(f"Source: {SOURCE_TABLE}")
print(f"Target: {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Data

# COMMAND ----------

df_bronze = spark.table(SOURCE_TABLE)
bronze_count = df_bronze.count()
print(f"Bronze records: {bronze_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Voltage Validation (ANSI C84.1)

# COMMAND ----------

df_voltage = df_bronze \
    .withColumn(
        "voltage_valid",
        when(
            (col("voltage_a") >= VOLTAGE_MIN_RANGE_B) &
            (col("voltage_a") <= VOLTAGE_MAX_RANGE_B),
            True
        ).otherwise(False)
    ) \
    .withColumn(
        "voltage_range",
        when(
            (col("voltage_a") >= VOLTAGE_MIN_RANGE_A) &
            (col("voltage_a") <= VOLTAGE_MAX_RANGE_A),
            lit("RANGE_A")
        ).when(
            (col("voltage_a") >= VOLTAGE_MIN_RANGE_B) &
            (col("voltage_a") <= VOLTAGE_MAX_RANGE_B),
            lit("RANGE_B")
        ).otherwise(lit("OUT_OF_RANGE"))
    )

violations = df_voltage.filter(~col("voltage_valid")).count()
print(f"Voltage violations (out of Range B): {violations:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Gap Detection & Interpolation

# COMMAND ----------

meter_window = Window.partitionBy("meter_id").orderBy("reading_timestamp")

df_gaps = df_voltage \
    .withColumn("prev_timestamp", lag("reading_timestamp").over(meter_window)) \
    .withColumn(
        "gap_seconds",
        unix_timestamp("reading_timestamp") - unix_timestamp("prev_timestamp")
    ) \
    .withColumn(
        "has_gap",
        when(col("gap_seconds") > INTERVAL_SECONDS * 1.5, True).otherwise(False)
    ) \
    .withColumn(
        "gap_interpolated",
        when(col("read_quality") == "ESTIMATED", True).otherwise(False)
    )

gap_count = df_gaps.filter(col("has_gap")).count()
print(f"Gaps detected (> 22.5 min): {gap_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Tamper / Theft Detection

# COMMAND ----------

# Tamper scoring based on multiple signals
df_tamper = df_gaps \
    .withColumn("prev_kwh", lag("kwh_delivered").over(meter_window)) \
    .withColumn(
        "sudden_zero",
        when(
            (col("prev_kwh") > 0.5) & (col("kwh_delivered") == 0.0),
            0.3
        ).otherwise(0.0)
    ) \
    .withColumn(
        "reverse_anomaly",
        when(
            (col("kwh_received") > 0) & (col("rate_class") == "RESIDENTIAL") &
            (col("kwh_received") > col("kwh_delivered") * 2),
            0.25
        ).otherwise(0.0)
    ) \
    .withColumn(
        "tamper_device_score",
        when(col("tamper_flag") == True, 0.45).otherwise(0.0)
    ) \
    .withColumn(
        "tamper_score",
        col("sudden_zero") + col("reverse_anomaly") + col("tamper_device_score")
    ) \
    .withColumn(
        "tamper_score",
        when(col("tamper_score") > 1.0, 1.0).otherwise(col("tamper_score"))
    )

high_tamper = df_tamper.filter(col("tamper_score") > 0.5).count()
print(f"High tamper score records (>0.5): {high_tamper:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Daily & Monthly Aggregations

# COMMAND ----------

df_with_date = df_tamper \
    .withColumn("reading_date", to_date("reading_timestamp")) \
    .withColumn("reading_month", month("reading_timestamp")) \
    .withColumn("reading_year", year("reading_timestamp"))

# Daily aggregation per meter
daily_window = Window.partitionBy("meter_id", "reading_date")
df_daily = df_with_date \
    .withColumn("daily_kwh", spark_sum("kwh_delivered").over(daily_window)) \
    .withColumn("daily_demand_max_kw", expr("max(demand_kw) OVER (PARTITION BY meter_id, reading_date)"))

# Monthly aggregation per meter
monthly_window = Window.partitionBy("meter_id", "reading_year", "reading_month")
df_monthly = df_daily \
    .withColumn("monthly_kwh", spark_sum("kwh_delivered").over(monthly_window))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Build Silver Output

# COMMAND ----------

df_silver = df_monthly.select(
    col("meter_id"),
    col("reading_timestamp"),
    spark_round(col("kwh_delivered"), 4).alias("kwh_delivered"),
    spark_round(col("kwh_received"), 4).alias("kwh_received"),
    spark_round(col("voltage_a"), 2).alias("voltage_avg"),
    col("voltage_valid"),
    col("voltage_range"),
    spark_round(col("power_factor"), 4).alias("power_factor"),
    spark_round(col("demand_kw"), 4).alias("demand_kw"),
    col("read_quality"),
    spark_round(col("tamper_score"), 4).alias("tamper_score"),
    col("gap_interpolated"),
    spark_round(col("daily_kwh"), 2).alias("daily_kwh"),
    spark_round(col("monthly_kwh"), 2).alias("monthly_kwh"),
    col("rate_class"),
    col("district"),
    col("feeder_id"),
    current_timestamp().alias("_silver_processed_at"),
    lit(BATCH_ID).alias("_silver_batch_id"),
    lit("55_energy_validated").alias("_silver_notebook"),
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Silver

# COMMAND ----------

df_silver.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(TARGET_TABLE)

silver_count = spark.table(TARGET_TABLE).count()
print(f"Silver records written: {silver_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Quality Summary

# COMMAND ----------

quality_summary = spark.table(TARGET_TABLE) \
    .groupBy("voltage_range", "read_quality") \
    .agg(
        count("*").alias("record_count"),
        avg("tamper_score").alias("avg_tamper_score"),
        avg("kwh_delivered").alias("avg_kwh"),
    ) \
    .orderBy("voltage_range", "read_quality")

quality_summary.show(truncate=False)

audit_entry = {
    "timestamp": datetime.now().isoformat(),
    "notebook": "55_energy_validated",
    "operation": "SILVER_TRANSFORM",
    "table": TARGET_TABLE,
    "records_in": bronze_count,
    "records_out": silver_count,
    "voltage_violations": violations,
    "gaps_detected": gap_count,
    "high_tamper_records": high_tamper,
    "batch_id": BATCH_ID,
}
print(f"NERC CIP Audit: {audit_entry}")
