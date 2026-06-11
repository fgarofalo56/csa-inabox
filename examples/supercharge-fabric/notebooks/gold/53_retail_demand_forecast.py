# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Retail Demand Forecast & Customer 360
# MAGIC
# MAGIC Aggregate daily sales for demand forecasting features and build
# MAGIC customer-level RFM scores / CLV estimates.
# MAGIC
# MAGIC ## Outputs
# MAGIC - **gold_retail_demand** — SKU × Store × Day with forecast features
# MAGIC - **gold_retail_customer_360** — RFM, CLV, segment per customer
# MAGIC
# MAGIC ## Source
# MAGIC - **silver_retail_sales**

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    avg,
    col,
    count,
    countDistinct,
    current_date,
    current_timestamp,
    datediff,
    dayofweek,
    lit,
    max as spark_max,
    min as spark_min,
    month,
    ntile,
    round as spark_round,
    sum as spark_sum,
    weekofyear,
    when,
)
from pyspark.sql.window import Window

SOURCE_TABLE = "lh_silver.silver_retail_sales"
DEMAND_TABLE = "lh_gold.gold_retail_demand"
CUSTOMER_TABLE = "lh_gold.gold_retail_customer_360"

print(f"Source: {SOURCE_TABLE}")
print(f"Demand target: {DEMAND_TABLE}")
print(f"Customer target: {CUSTOMER_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Sales

# COMMAND ----------

df_sales = spark.table(SOURCE_TABLE).filter(~col("is_return"))
total_sales = df_sales.count()
print(f"Sales records (excl. returns): {total_sales:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 1: Demand Forecast Features
# MAGIC
# MAGIC Aggregate to SKU × Store × Day and compute lag/rolling features.

# COMMAND ----------

# Daily aggregation
df_daily = (
    df_sales
    .groupBy("sku", "store_id", "txn_date", "category", "subcategory", "region", "store_format")
    .agg(
        spark_sum("qty").alias("daily_qty"),
        spark_sum("line_total").alias("daily_revenue"),
        count("txn_id").alias("txn_count"),
        avg("discount_pct").alias("avg_discount_pct"),
    )
)

daily_count = df_daily.count()
print(f"Daily SKU-Store aggregations: {daily_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Rolling Window Features

# COMMAND ----------

# Define windows
w7 = Window.partitionBy("sku", "store_id").orderBy("txn_date").rowsBetween(-6, 0)
w14 = Window.partitionBy("sku", "store_id").orderBy("txn_date").rowsBetween(-13, 0)
w28 = Window.partitionBy("sku", "store_id").orderBy("txn_date").rowsBetween(-27, 0)

df_features = (
    df_daily
    # Moving averages
    .withColumn("sales_ma_7d", spark_round(avg("daily_qty").over(w7), 2))
    .withColumn("sales_ma_14d", spark_round(avg("daily_qty").over(w14), 2))
    .withColumn("sales_ma_28d", spark_round(avg("daily_qty").over(w28), 2))
    # Revenue moving averages
    .withColumn("revenue_ma_7d", spark_round(avg("daily_revenue").over(w7), 2))
    # Calendar features
    .withColumn("day_of_week", dayofweek("txn_date"))
    .withColumn("week_of_year", weekofyear("txn_date"))
    .withColumn("month_num", month("txn_date"))
    # Seasonal index: ratio of current to 28-day average
    .withColumn(
        "seasonal_index",
        when(
            col("sales_ma_28d") > 0,
            spark_round(col("daily_qty") / col("sales_ma_28d"), 4),
        ).otherwise(lit(1.0)),
    )
    .withColumn("_gold_processed_at", current_timestamp())
)

print(f"Feature columns: {len(df_features.columns)}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write gold_retail_demand

# COMMAND ----------

df_features.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(DEMAND_TABLE)

demand_count = spark.table(DEMAND_TABLE).count()
print(f"gold_retail_demand rows: {demand_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Part 2: Customer 360 — RFM & CLV

# COMMAND ----------

# MAGIC %md
# MAGIC ### RFM Scoring

# COMMAND ----------

df_rfm_raw = (
    df_sales
    .filter(col("loyalty_id").isNotNull())
    .groupBy("loyalty_id", "customer_segment")
    .agg(
        datediff(current_date(), spark_max("txn_date")).alias("recency_days"),
        countDistinct("txn_id").alias("frequency"),
        spark_round(spark_sum("line_total"), 2).alias("monetary"),
        spark_min("txn_date").alias("first_purchase_date"),
        spark_max("txn_date").alias("last_purchase_date"),
        countDistinct("category").alias("categories_shopped"),
        countDistinct("store_id").alias("stores_visited"),
        avg("discount_pct").alias("avg_discount_sensitivity"),
    )
)

rfm_count = df_rfm_raw.count()
print(f"Unique loyalty customers: {rfm_count:,}")

# COMMAND ----------

# Score each dimension 1-5 using quintiles
# Recency: lower is better → reverse scoring
w_r = Window.orderBy(col("recency_days").desc())
w_f = Window.orderBy("frequency")
w_m = Window.orderBy("monetary")

df_rfm = (
    df_rfm_raw
    .withColumn("r_score", ntile(5).over(w_r))
    .withColumn("f_score", ntile(5).over(w_f))
    .withColumn("m_score", ntile(5).over(w_m))
    .withColumn(
        "rfm_segment",
        when((col("r_score") >= 4) & (col("f_score") >= 4) & (col("m_score") >= 4), "Champions")
        .when((col("r_score") >= 3) & (col("f_score") >= 3), "Loyal")
        .when((col("r_score") >= 4) & (col("f_score") <= 2), "New Customers")
        .when((col("r_score") <= 2) & (col("f_score") >= 3), "At Risk")
        .when((col("r_score") <= 2) & (col("f_score") <= 2), "Hibernating")
        .otherwise("Potential Loyalists"),
    )
)

# COMMAND ----------

# MAGIC %md
# MAGIC ### CLV Estimation
# MAGIC
# MAGIC Simple heuristic CLV: avg order value × purchase frequency × expected tenure.

# COMMAND ----------

df_clv = (
    df_rfm
    .withColumn(
        "avg_order_value",
        when(col("frequency") > 0, col("monetary") / col("frequency")).otherwise(0),
    )
    .withColumn(
        "tenure_months",
        spark_round(
            datediff(col("last_purchase_date"), col("first_purchase_date")) / 30.44, 1
        ),
    )
    .withColumn(
        "monthly_frequency",
        when(
            col("tenure_months") > 0,
            spark_round(col("frequency") / col("tenure_months"), 2),
        ).otherwise(col("frequency")),
    )
    .withColumn(
        "clv_12m",
        spark_round(col("avg_order_value") * col("monthly_frequency") * 12, 2),
    )
    .withColumn(
        "clv_tier",
        when(col("clv_12m") >= 5000, "Platinum")
        .when(col("clv_12m") >= 2000, "Gold")
        .when(col("clv_12m") >= 500, "Silver")
        .otherwise("Bronze"),
    )
    .withColumn("_gold_processed_at", current_timestamp())
)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write gold_retail_customer_360

# COMMAND ----------

df_clv.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .saveAsTable(CUSTOMER_TABLE)

cust_count = spark.table(CUSTOMER_TABLE).count()
print(f"gold_retail_customer_360 rows: {cust_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary Statistics

# COMMAND ----------

display(
    spark.sql(f"""
        SELECT
            rfm_segment,
            clv_tier,
            COUNT(*) AS customers,
            ROUND(AVG(monetary), 2) AS avg_monetary,
            ROUND(AVG(clv_12m), 2) AS avg_clv_12m,
            ROUND(AVG(recency_days), 0) AS avg_recency_days
        FROM {CUSTOMER_TABLE}
        GROUP BY rfm_segment, clv_tier
        ORDER BY avg_clv_12m DESC
    """)
)

# COMMAND ----------

display(
    spark.sql(f"""
        SELECT
            category,
            region,
            COUNT(*) AS day_records,
            ROUND(AVG(daily_qty), 1) AS avg_daily_qty,
            ROUND(AVG(seasonal_index), 3) AS avg_seasonal_idx
        FROM {DEMAND_TABLE}
        GROUP BY category, region
        ORDER BY avg_daily_qty DESC
        LIMIT 20
    """)
)

# COMMAND ----------

# Checkpoint
checkpoint_path = "abfss://retail@{{ADLS_ACCOUNT}}.dfs.core.windows.net/checkpoints/gold"
mssparkutils.fs.put(
    f"{checkpoint_path}/last_run.txt",
    f"demand={demand_count}|customer360={cust_count}",
    True,
)
print("Gold checkpoint written")
