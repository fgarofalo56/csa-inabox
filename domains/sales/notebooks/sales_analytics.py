# Databricks notebook source
# MAGIC %md
# MAGIC # CSA-in-a-Box: Sales Analytics
# MAGIC
# MAGIC Sales-domain notebook that analyses the gold-layer `gld_sales_metrics`
# MAGIC table produced by the dbt pipeline.
# MAGIC
# MAGIC **Key analyses:**
# MAGIC - Sales pipeline analysis (by region and channel)
# MAGIC - Customer segmentation (RFM analysis)
# MAGIC - Revenue forecasting (simple moving average)
# MAGIC - Product performance ranking
# MAGIC - Regional sales comparison

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Configuration

# COMMAND ----------

from pyspark.sql import functions as F
from pyspark.sql.window import Window

dbutils.widgets.text("catalog", "csa_inabox", "Unity Catalog Name")
dbutils.widgets.text("forecast_window", "7", "Moving average window (days)")

catalog = dbutils.widgets.get("catalog")
forecast_window = int(dbutils.widgets.get("forecast_window"))

SALES_TABLE = f"{catalog}.gold.gld_sales_metrics"
CLV_TABLE = f"{catalog}.gold.gld_customer_lifetime_value"
FACT_ORDERS_TABLE = f"{catalog}.gold.fact_orders"

print(f"Catalog: {catalog}")
print(f"Forecast window: {forecast_window}-day moving average")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Sales Pipeline Analysis

# COMMAND ----------

sales_df = spark.table(SALES_TABLE)

# Summary by region
region_summary = (
    sales_df
    .groupBy("sales_region")
    .agg(
        F.sum("total_revenue").alias("total_revenue"),
        F.sum("total_orders").alias("total_orders"),
        F.sum("total_units_sold").alias("total_units"),
        F.avg("avg_line_value").alias("avg_line_value"),
        F.sum("unique_customers").alias("unique_customers"),
        F.countDistinct("order_date").alias("active_days"),
    )
    .withColumn(
        "revenue_per_order",
        F.round(F.col("total_revenue") / F.col("total_orders"), 2),
    )
    .orderBy(F.desc("total_revenue"))
)

print("SALES BY REGION")
print("=" * 70)
display(region_summary)

# COMMAND ----------

# Summary by channel
channel_summary = (
    sales_df
    .groupBy("sales_channel")
    .agg(
        F.sum("total_revenue").alias("total_revenue"),
        F.sum("total_orders").alias("total_orders"),
        F.avg("revenue_per_order").alias("avg_revenue_per_order"),
        F.sum("unique_products_sold").alias("product_diversity"),
    )
    .orderBy(F.desc("total_revenue"))
)

print("SALES BY CHANNEL")
display(channel_summary)

# COMMAND ----------

# Region x Channel heatmap data
region_channel = (
    sales_df
    .groupBy("sales_region", "sales_channel")
    .agg(
        F.sum("total_revenue").alias("total_revenue"),
        F.sum("total_orders").alias("total_orders"),
    )
    .orderBy("sales_region", "sales_channel")
)

print("REGION x CHANNEL REVENUE BREAKDOWN")
display(region_channel)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Customer Segmentation (RFM Analysis)

# COMMAND ----------

# MAGIC %md
# MAGIC **RFM** = Recency, Frequency, Monetary
# MAGIC
# MAGIC Uses `gld_customer_lifetime_value` which already has per-customer
# MAGIC order metrics. We score each dimension 1-5 and assign segments.

# COMMAND ----------

clv_df = spark.table(CLV_TABLE)

# Calculate RFM metrics
rfm_df = (
    clv_df
    .where(F.col("total_orders") > 0)  # Exclude never_purchased
    .withColumn(
        "recency_days",
        F.datediff(F.current_date(), F.col("last_order_date")),
    )
    .select(
        "customer_id", "first_name", "last_name",
        "recency_days", "total_orders", "lifetime_revenue",
        "customer_segment", "value_tier",
    )
)

# Score RFM dimensions using quintiles (1=worst, 5=best)
# Recency: lower days = better (invert scoring)
for col_name, alias, ascending in [
    ("recency_days", "r_score", False),   # Lower recency = higher score
    ("total_orders", "f_score", True),    # More orders = higher score
    ("lifetime_revenue", "m_score", True), # More revenue = higher score
]:
    rfm_df = rfm_df.withColumn(
        alias,
        F.ntile(5).over(
            Window.orderBy(F.col(col_name).asc() if ascending else F.col(col_name).desc())
        ),
    )

# Combined RFM score and segment label
rfm_df = (
    rfm_df
    .withColumn("rfm_score", F.col("r_score") + F.col("f_score") + F.col("m_score"))
    .withColumn(
        "rfm_segment",
        F.when(F.col("rfm_score") >= 13, "Champions")
        .when(F.col("rfm_score") >= 10, "Loyal Customers")
        .when(
            (F.col("r_score") >= 4) & (F.col("f_score") <= 2),
            "New Customers",
        )
        .when(
            (F.col("r_score") <= 2) & (F.col("f_score") >= 3),
            "At Risk",
        )
        .when(F.col("rfm_score") >= 7, "Potential Loyalists")
        .when(F.col("r_score") <= 2, "Lost")
        .otherwise("Need Attention"),
    )
)

# Segment summary
rfm_summary = (
    rfm_df
    .groupBy("rfm_segment")
    .agg(
        F.count("*").alias("customer_count"),
        F.round(F.avg("lifetime_revenue"), 2).alias("avg_revenue"),
        F.round(F.avg("total_orders"), 1).alias("avg_orders"),
        F.round(F.avg("recency_days"), 0).alias("avg_recency_days"),
    )
    .orderBy(F.desc("avg_revenue"))
)

print("CUSTOMER SEGMENTATION (RFM)")
print("=" * 70)
display(rfm_summary)

# Top champions
print("\nTOP 10 CHAMPION CUSTOMERS:")
display(
    rfm_df
    .where(F.col("rfm_segment") == "Champions")
    .orderBy(F.desc("lifetime_revenue"))
    .limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Revenue Forecasting (Simple Moving Average)

# COMMAND ----------

# Daily revenue from sales metrics
daily_revenue = (
    sales_df
    .groupBy("order_date")
    .agg(
        F.sum("total_revenue").alias("daily_revenue"),
        F.sum("total_orders").alias("daily_orders"),
    )
    .orderBy("order_date")
)

# Calculate moving average
window_ma = (
    Window
    .orderBy("order_date")
    .rowsBetween(-forecast_window + 1, 0)
)

forecast_df = (
    daily_revenue
    .withColumn(
        f"ma_{forecast_window}d",
        F.round(F.avg("daily_revenue").over(window_ma), 2),
    )
    .withColumn(
        f"ma_{forecast_window}d_orders",
        F.round(F.avg("daily_orders").over(window_ma), 1),
    )
    .withColumn(
        "deviation_pct",
        F.round(
            (F.col("daily_revenue") - F.col(f"ma_{forecast_window}d"))
            / F.col(f"ma_{forecast_window}d") * 100, 1
        ),
    )
)

print(f"REVENUE FORECAST ({forecast_window}-Day Moving Average)")
print("=" * 70)
display(forecast_df)

# Latest forecast
latest = forecast_df.orderBy(F.desc("order_date")).first()
if latest:
    print(f"\nLatest date: {latest['order_date']}")
    print(f"Daily revenue: ${latest['daily_revenue']:,.2f}")
    print(f"{forecast_window}-day MA: ${latest[f'ma_{forecast_window}d']:,.2f}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Product Performance Ranking

# COMMAND ----------

# Product performance from sales metrics
product_performance = (
    sales_df
    .groupBy("order_date")
    .agg(
        F.sum("total_revenue").alias("revenue"),
        F.sum("unique_products_sold").alias("products_sold"),
        F.sum("total_units_sold").alias("units_sold"),
    )
)

# Revenue per product (aggregate view)
# Since gld_sales_metrics doesn't have product_id, we use unit-level metrics
product_efficiency = (
    sales_df
    .groupBy("sales_region", "sales_channel")
    .agg(
        F.sum("total_revenue").alias("total_revenue"),
        F.sum("unique_products_sold").alias("unique_products"),
        F.sum("total_units_sold").alias("total_units"),
        F.round(F.avg("avg_unit_price"), 2).alias("avg_unit_price"),
        F.round(F.avg("units_per_order"), 1).alias("avg_units_per_order"),
    )
    .withColumn(
        "revenue_per_product",
        F.round(F.col("total_revenue") / F.col("unique_products"), 2),
    )
    .orderBy(F.desc("revenue_per_product"))
)

print("PRODUCT EFFICIENCY BY REGION & CHANNEL")
display(product_efficiency)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Regional Sales Comparison

# COMMAND ----------

# Daily trends by region
region_daily = (
    sales_df
    .groupBy("order_date", "sales_region")
    .agg(
        F.sum("total_revenue").alias("revenue"),
        F.sum("total_orders").alias("orders"),
        F.sum("unique_customers").alias("customers"),
    )
    .orderBy("order_date", "sales_region")
)

print("DAILY REVENUE BY REGION (for time series chart)")
display(region_daily)

# COMMAND ----------

# Regional growth comparison (week-over-week)
weekly_region = (
    sales_df
    .withColumn("week", F.weekofyear("order_date"))
    .withColumn("year", F.year("order_date"))
    .groupBy("year", "week", "sales_region")
    .agg(
        F.sum("total_revenue").alias("weekly_revenue"),
        F.sum("total_orders").alias("weekly_orders"),
    )
)

window_wow = Window.partitionBy("sales_region").orderBy("year", "week")
weekly_region = (
    weekly_region
    .withColumn("prev_week_revenue", F.lag("weekly_revenue").over(window_wow))
    .withColumn(
        "wow_growth_pct",
        F.round(
            (F.col("weekly_revenue") - F.col("prev_week_revenue"))
            / F.abs(F.coalesce("prev_week_revenue", F.lit(1))) * 100, 1
        ),
    )
    .orderBy(F.desc("year"), F.desc("week"), "sales_region")
)

print("WEEK-OVER-WEEK REGIONAL GROWTH")
display(weekly_region.limit(40))

# COMMAND ----------

# MAGIC %md
# MAGIC ## 7. Key Performance Summary

# COMMAND ----------

# Aggregate KPIs
total_rev = sales_df.agg(F.sum("total_revenue")).collect()[0][0] or 0
total_ord = sales_df.agg(F.sum("total_orders")).collect()[0][0] or 0
total_cust = sales_df.agg(F.sum("unique_customers")).collect()[0][0] or 0
active_days = sales_df.select("order_date").distinct().count()
regions = sales_df.select("sales_region").distinct().count()

print("=" * 50)
print("SALES PERFORMANCE KPIs")
print("=" * 50)
print(f"  Total Revenue:      ${total_rev:,.2f}")
print(f"  Total Orders:       {total_ord:,}")
print(f"  Unique Customers:   {total_cust:,}")
print(f"  Active Days:        {active_days:,}")
print(f"  Regions:            {regions}")
print(f"  Avg Daily Revenue:  ${total_rev / max(active_days, 1):,.2f}")
print(f"  Avg Order Value:    ${total_rev / max(total_ord, 1):,.2f}")
print("=" * 50)
