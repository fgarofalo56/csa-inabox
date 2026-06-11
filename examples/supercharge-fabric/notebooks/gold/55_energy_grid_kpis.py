# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Energy Grid KPIs
# MAGIC
# MAGIC This notebook computes grid reliability indices, load forecasting features,
# MAGIC and revenue protection scores from Silver-layer energy data.
# MAGIC
# MAGIC ## Outputs
# MAGIC - **gold_grid_reliability**: SAIDI/SAIFI/CAIDI by feeder and district (IEEE 1366)
# MAGIC - **gold_energy_forecasts**: Peak demand, load factor, DR eligibility
# MAGIC - **gold_revenue_protection**: Theft detection scores and estimated losses
# MAGIC
# MAGIC ## Compliance
# MAGIC - NERC CIP audit trail
# MAGIC - IEEE 1366 Major Event Day exclusion

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from datetime import datetime

from pyspark.sql.functions import (
    avg,
    col,
    count,
    countDistinct,
    current_timestamp,
    expr,
    lit,
    max as spark_max,
    min as spark_min,
    round as spark_round,
    sum as spark_sum,
    to_date,
    when,
)

SILVER_CONSUMPTION = "lh_silver.silver_energy_consumption"
BRONZE_OUTAGES = "lh_bronze.bronze_energy_outage_events"
GOLD_RELIABILITY = "lh_gold.gold_grid_reliability"
GOLD_FORECASTS = "lh_gold.gold_energy_forecasts"
GOLD_REVENUE = "lh_gold.gold_revenue_protection"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

# System-wide customer count for SAIDI/SAIFI
TOTAL_CUSTOMERS = 1_200_000

print(f"Batch: {BATCH_ID}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Grid Reliability Indices (IEEE 1366)
# MAGIC
# MAGIC - **SAIDI** = Sum(Customer Minutes Interrupted) / Total Customers
# MAGIC - **SAIFI** = Sum(Customers Interrupted) / Total Customers
# MAGIC - **CAIDI** = SAIDI / SAIFI

# COMMAND ----------

df_outages = spark.table(BRONZE_OUTAGES)

# Calculate Customer Minutes Interrupted (CMI)
df_cmi = df_outages \
    .withColumn("cmi", col("duration_minutes") * col("customers_affected")) \
    .withColumn("outage_date", to_date("start_datetime"))

# Daily reliability by district
df_daily_reliability = df_cmi \
    .filter(col("major_event") == False) \
    .groupBy("outage_date", "district") \
    .agg(
        spark_sum("cmi").alias("total_cmi"),
        spark_sum("customers_affected").alias("total_customers_interrupted"),
        count("event_id").alias("outage_count"),
        avg("duration_minutes").alias("avg_duration_min"),
    )

# Compute indices
df_reliability = df_daily_reliability \
    .withColumn("saidi", spark_round(col("total_cmi") / lit(TOTAL_CUSTOMERS / 5), 4)) \
    .withColumn("saifi", spark_round(col("total_customers_interrupted") / lit(TOTAL_CUSTOMERS / 5), 6)) \
    .withColumn(
        "caidi",
        spark_round(
            when(col("saifi") > 0, col("saidi") / col("saifi")).otherwise(0.0),
            2
        )
    ) \
    .withColumn(
        "asai",
        spark_round(
            lit(1.0) - (col("saidi") / lit(1440.0)),  # 1440 min/day
            6
        )
    ) \
    .withColumn("period", lit("daily")) \
    .withColumn("period_start", col("outage_date")) \
    .withColumn("customers_served", lit(TOTAL_CUSTOMERS // 5)) \
    .withColumn("excluding_med", lit(True)) \
    .select(
        "period", "period_start", "district",
        "saidi", "saifi", "caidi", "asai",
        "customers_served", "total_cmi", "outage_count", "excluding_med",
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Feeder-Level Reliability

# COMMAND ----------

df_feeder_reliability = df_cmi \
    .filter(col("major_event") == False) \
    .groupBy("outage_date", "district", "feeder_id") \
    .agg(
        spark_sum("cmi").alias("total_cmi"),
        spark_sum("customers_affected").alias("total_customers_interrupted"),
        count("event_id").alias("outage_count"),
    ) \
    .withColumn("saidi", spark_round(col("total_cmi") / lit(5000), 4)) \
    .withColumn("saifi", spark_round(col("total_customers_interrupted") / lit(5000), 6)) \
    .withColumn(
        "caidi",
        spark_round(
            when(col("saifi") > 0, col("saidi") / col("saifi")).otherwise(0.0), 2
        )
    ) \
    .withColumn("asai", spark_round(lit(1.0) - (col("saidi") / lit(1440.0)), 6)) \
    .withColumn("period", lit("daily")) \
    .withColumn("period_start", col("outage_date")) \
    .withColumn("customers_served", lit(5000)) \
    .withColumn("excluding_med", lit(True)) \
    .select(
        "period", "period_start", "district", "feeder_id",
        "saidi", "saifi", "caidi", "asai",
        "customers_served", "total_cmi", "outage_count", "excluding_med",
    )

# Union district + feeder level
df_all_reliability = df_reliability \
    .withColumn("feeder_id", lit(None).cast("string")) \
    .unionByName(df_feeder_reliability)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Grid Reliability

# COMMAND ----------

df_all_reliability.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(GOLD_RELIABILITY)

rel_count = spark.table(GOLD_RELIABILITY).count()
print(f"Grid reliability records: {rel_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Load Forecasting Features

# COMMAND ----------

df_silver = spark.table(SILVER_CONSUMPTION)

# Peak demand and load factor by district and date
df_load = df_silver \
    .withColumn("reading_date", to_date("reading_timestamp")) \
    .groupBy("reading_date", "district") \
    .agg(
        spark_max("demand_kw").alias("peak_demand_kw"),
        avg("demand_kw").alias("avg_demand_kw"),
        spark_sum("kwh_delivered").alias("total_kwh"),
        countDistinct("meter_id").alias("active_meters"),
    ) \
    .withColumn(
        "load_factor",
        spark_round(
            when(col("peak_demand_kw") > 0,
                 col("avg_demand_kw") / col("peak_demand_kw"))
            .otherwise(0.0), 4
        )
    ) \
    .withColumn("peak_demand_mw", spark_round(col("peak_demand_kw") / 1000.0, 2)) \
    .withColumn(
        "dr_eligible_mw",
        spark_round(col("peak_demand_mw") * 0.08, 2)  # ~8% DR eligible
    ) \
    .withColumn(
        "peak_flag",
        when(col("peak_demand_mw") > lit(2500), True).otherwise(False)
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Load Forecasts

# COMMAND ----------

df_forecasts = df_load.select(
    col("reading_date").alias("forecast_date"),
    col("district"),
    col("peak_demand_mw").alias("predicted_mw"),
    col("load_factor"),
    col("total_kwh"),
    col("active_meters"),
    col("dr_eligible_mw"),
    col("peak_flag"),
    current_timestamp().alias("_gold_processed_at"),
    lit(BATCH_ID).alias("_gold_batch_id"),
)

df_forecasts.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(GOLD_FORECASTS)

forecast_count = spark.table(GOLD_FORECASTS).count()
print(f"Forecast records: {forecast_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Revenue Protection (Theft Detection)

# COMMAND ----------

# Aggregate tamper scores by meter
df_theft = df_silver \
    .withColumn("analysis_date", to_date("reading_timestamp")) \
    .groupBy("meter_id", "analysis_date", "district", "rate_class") \
    .agg(
        avg("tamper_score").alias("avg_tamper_score"),
        spark_max("tamper_score").alias("max_tamper_score"),
        spark_sum("kwh_delivered").alias("daily_kwh"),
        count("*").alias("reading_count"),
    ) \
    .withColumn(
        "theft_score",
        spark_round(
            col("avg_tamper_score") * 0.4 +
            col("max_tamper_score") * 0.4 +
            when(col("reading_count") < 80, 0.2).otherwise(0.0),  # missing reads
            4
        )
    ) \
    .withColumn(
        "anomaly_type",
        when(col("max_tamper_score") > 0.7, lit("METER_TAMPER"))
        .when(col("reading_count") < 50, lit("MISSING_READS"))
        .when(col("daily_kwh") < 0.5, lit("ZERO_CONSUMPTION"))
        .otherwise(lit("NONE"))
    ) \
    .withColumn(
        "estimated_loss_kwh",
        when(col("theft_score") > 0.3,
             spark_round(col("daily_kwh") * col("theft_score") * 2.0, 2))
        .otherwise(0.0)
    ) \
    .withColumn(
        "estimated_loss_usd",
        spark_round(col("estimated_loss_kwh") * 0.12, 2)  # $0.12/kWh avg rate
    ) \
    .withColumn(
        "priority",
        when(col("theft_score") > 0.7, lit("HIGH"))
        .when(col("theft_score") > 0.4, lit("MEDIUM"))
        .otherwise(lit("LOW"))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Revenue Protection

# COMMAND ----------

df_revenue = df_theft.select(
    "meter_id", "analysis_date", "district", "rate_class",
    "theft_score", "anomaly_type",
    "estimated_loss_kwh", "estimated_loss_usd", "priority",
    current_timestamp().alias("_gold_processed_at"),
    lit(BATCH_ID).alias("_gold_batch_id"),
)

df_revenue.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(GOLD_REVENUE)

rev_count = spark.table(GOLD_REVENUE).count()
high_priority = df_revenue.filter(col("priority") == "HIGH").count()
print(f"Revenue protection records: {rev_count:,}")
print(f"High-priority investigations: {high_priority:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Audit Summary

# COMMAND ----------

audit_entry = {
    "timestamp": datetime.now().isoformat(),
    "notebook": "55_energy_grid_kpis",
    "operation": "GOLD_KPI_COMPUTE",
    "tables_written": [GOLD_RELIABILITY, GOLD_FORECASTS, GOLD_REVENUE],
    "reliability_records": rel_count,
    "forecast_records": forecast_count,
    "revenue_records": rev_count,
    "high_priority_theft": high_priority,
    "batch_id": BATCH_ID,
}
print(f"NERC CIP Audit: {audit_entry}")
