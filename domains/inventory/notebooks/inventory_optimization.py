# Databricks notebook source
# MAGIC %md
# MAGIC # CSA-in-a-Box: Inventory Optimization
# MAGIC
# MAGIC Inventory-domain notebook that analyses gold-layer tables for stock
# MAGIC optimization: `gld_inventory_turnover`, `gld_reorder_alerts`, and
# MAGIC `fact_inventory_snapshot`.
# MAGIC
# MAGIC **Key analyses:**
# MAGIC - ABC classification (products by revenue contribution)
# MAGIC - Safety stock calculations
# MAGIC - Reorder point optimization
# MAGIC - Seasonal demand patterns
# MAGIC - Dead stock identification

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Configuration

# COMMAND ----------

import math
from pyspark.sql import functions as F
from pyspark.sql.window import Window

dbutils.widgets.text("catalog", "csa_inabox", "Unity Catalog Name")
dbutils.widgets.text("service_level_z", "1.65", "Z-score for service level (1.65 = 95%)")

catalog = dbutils.widgets.get("catalog")
z_score = float(dbutils.widgets.get("service_level_z"))

TURNOVER_TABLE = f"{catalog}.gold.gld_inventory_turnover"
REORDER_TABLE = f"{catalog}.gold.gld_reorder_alerts"
SNAPSHOT_TABLE = f"{catalog}.gold.fact_inventory_snapshot"
PRODUCTS_TABLE = f"{catalog}.gold.dim_products"

print(f"Catalog: {catalog}")
print(f"Service level Z-score: {z_score}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. ABC Analysis (Revenue Contribution)

# COMMAND ----------

# Load inventory turnover with product pricing
turnover_df = spark.table(TURNOVER_TABLE)

# Calculate inventory value per product
abc_df = (
    turnover_df
    .withColumn(
        "inventory_value",
        F.col("total_on_hand") * F.col("unit_price"),
    )
    .orderBy(F.desc("inventory_value"))
)

# Running cumulative percentage for ABC classification
window_cum = Window.orderBy(F.desc("inventory_value")).rowsBetween(
    Window.unboundedPreceding, Window.currentRow
)
total_value = abc_df.agg(F.sum("inventory_value")).collect()[0][0] or 1

abc_df = (
    abc_df
    .withColumn("cumulative_value", F.sum("inventory_value").over(window_cum))
    .withColumn(
        "cumulative_pct",
        F.round(F.col("cumulative_value") / F.lit(total_value) * 100, 2),
    )
    .withColumn(
        "abc_class",
        F.when(F.col("cumulative_pct") <= 80, "A")
        .when(F.col("cumulative_pct") <= 95, "B")
        .otherwise("C"),
    )
)

# Summary by ABC class
abc_summary = (
    abc_df
    .groupBy("abc_class")
    .agg(
        F.count("*").alias("product_count"),
        F.sum("inventory_value").alias("total_value"),
        F.sum("total_on_hand").alias("total_units"),
        F.avg("unit_price").alias("avg_unit_price"),
    )
    .withColumn(
        "value_pct",
        F.round(F.col("total_value") / F.lit(total_value) * 100, 1),
    )
    .orderBy("abc_class")
)

print("ABC CLASSIFICATION SUMMARY")
print("=" * 70)
print("A = Top 80% of value | B = Next 15% | C = Bottom 5%")
display(abc_summary)

# Detailed product list with ABC class
print("\nTOP 20 PRODUCTS BY INVENTORY VALUE (Class A)")
display(abc_df.where(F.col("abc_class") == "A").limit(20))

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Safety Stock Calculations

# COMMAND ----------

# MAGIC %md
# MAGIC Safety stock formula: `SS = Z * sigma_demand * sqrt(lead_time)`
# MAGIC
# MAGIC Since demand data per product is not available yet (see
# MAGIC `gld_inventory_turnover.sql` notes), we estimate using reorder point
# MAGIC as a proxy for expected demand during lead time. We calculate
# MAGIC variability from the spread across warehouses.

# COMMAND ----------

# Calculate demand variability across warehouses as a proxy
snapshot_df = spark.table(SNAPSHOT_TABLE)

demand_proxy = (
    snapshot_df
    .groupBy("product_id")
    .agg(
        F.avg("qty_on_hand").alias("avg_qty"),
        F.stddev("qty_on_hand").alias("stddev_qty"),
        F.avg("reorder_point").alias("avg_reorder_point"),
        F.count("*").alias("warehouse_count"),
        F.sum("qty_on_hand").alias("total_on_hand"),
        F.sum(F.col("qty_on_hand") - F.col("qty_reserved")).alias("total_available"),
        F.max("days_since_restock").alias("max_days_since_restock"),
    )
    .withColumn(
        "stddev_qty", F.coalesce("stddev_qty", F.lit(0.0))
    )
)

# Assume average lead time of 7 days (configurable)
LEAD_TIME_DAYS = 7

safety_stock_df = (
    demand_proxy
    .withColumn(
        "safety_stock",
        F.round(F.lit(z_score) * F.col("stddev_qty") * F.lit(math.sqrt(LEAD_TIME_DAYS)), 0),
    )
    .withColumn(
        "optimal_reorder_point",
        F.round(F.col("avg_reorder_point") + F.col("safety_stock"), 0),
    )
    .withColumn(
        "current_vs_optimal",
        F.round(F.col("avg_reorder_point") - F.col("optimal_reorder_point"), 0),
    )
    .orderBy(F.desc(F.abs("current_vs_optimal")))
)

print("SAFETY STOCK & REORDER POINT OPTIMIZATION")
print(f"Service level: {z_score} (Z-score) | Lead time: {LEAD_TIME_DAYS} days")
print("=" * 70)
display(safety_stock_df.limit(30))

# Products where current reorder point is below optimal
under_stocked = safety_stock_df.where(F.col("current_vs_optimal") < 0)
print(f"\nProducts with sub-optimal reorder points: {under_stocked.count()}")
display(under_stocked.limit(15))

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Reorder Alert Analysis

# COMMAND ----------

reorder_df = spark.table(REORDER_TABLE)

# Alert severity breakdown
alert_summary = (
    reorder_df
    .groupBy("alert_severity")
    .agg(
        F.count("*").alias("alert_count"),
        F.countDistinct("product_id").alias("unique_products"),
        F.sum("qty_deficit").alias("total_deficit"),
    )
    .orderBy(
        F.when(F.col("alert_severity") == "CRITICAL", 1)
        .when(F.col("alert_severity") == "URGENT", 2)
        .otherwise(3)
    )
)

print("REORDER ALERT SUMMARY")
display(alert_summary)

# Critical alerts detail
critical = reorder_df.where(F.col("alert_severity") == "CRITICAL")
if critical.count() > 0:
    print(f"\nCRITICAL ALERTS ({critical.count()} items at zero stock):")
    display(critical.select(
        "product_id", "product_name", "product_category",
        "warehouse_name", "qty_on_hand", "qty_available",
        "reorder_point", "qty_deficit", "days_since_restock",
    ))
else:
    print("\nNo CRITICAL alerts -- all products have stock.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Seasonal Demand Patterns

# COMMAND ----------

# Analyze restocking patterns as a proxy for demand seasonality
# (Uses days_since_restock and snapshot_date from fact_inventory_snapshot)
seasonal_df = (
    snapshot_df
    .withColumn("restock_month", F.month("last_restocked_at"))
    .where(F.col("last_restocked_at").isNotNull())
    .groupBy("restock_month")
    .agg(
        F.count("*").alias("restock_events"),
        F.avg("qty_on_hand").alias("avg_stock_at_restock"),
        F.countDistinct("product_id").alias("unique_products"),
    )
    .orderBy("restock_month")
)

# Add month names for readability
month_names = {
    1: "Jan", 2: "Feb", 3: "Mar", 4: "Apr", 5: "May", 6: "Jun",
    7: "Jul", 8: "Aug", 9: "Sep", 10: "Oct", 11: "Nov", 12: "Dec",
}
month_map = F.create_map([F.lit(x) for kv in month_names.items() for x in kv])

seasonal_df = seasonal_df.withColumn(
    "month_name", month_map[F.col("restock_month")]
)

print("RESTOCKING SEASONALITY (Proxy for Demand Patterns)")
display(seasonal_df)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Dead Stock Identification

# COMMAND ----------

# Dead stock: products sitting in warehouses with no restocking activity
# for an extended period and status indicating overstock
DEAD_STOCK_THRESHOLD_DAYS = 90

dead_stock = (
    snapshot_df
    .where(
        (F.col("days_since_restock") >= DEAD_STOCK_THRESHOLD_DAYS)
        & (F.col("stock_status") == "WELL_STOCKED")
        & (F.col("qty_on_hand") > 0)
    )
)

# Enrich with product details
products_df = spark.table(PRODUCTS_TABLE)

dead_stock_detail = (
    dead_stock
    .join(products_df, "product_id", "left")
    .select(
        "product_id",
        "product_name",
        "category",
        "warehouse_name",
        "warehouse_region",
        "qty_on_hand",
        "qty_reserved",
        F.col("qty_on_hand").cast("double") * F.col("unit_price").alias("dead_stock_value"),
        "days_since_restock",
        "last_restocked_at",
    )
    .withColumn(
        "dead_stock_value",
        F.round(F.col("qty_on_hand").cast("double") * F.col("unit_price"), 2),
    )
    .orderBy(F.desc("dead_stock_value"))
)

total_dead_value = dead_stock_detail.agg(
    F.sum("dead_stock_value")
).collect()[0][0] or 0

print(f"DEAD STOCK ANALYSIS (>{DEAD_STOCK_THRESHOLD_DAYS} days, well-stocked)")
print(f"Total dead stock value: ${total_dead_value:,.2f}")
print(f"Products affected: {dead_stock_detail.select('product_id').distinct().count()}")
print("=" * 70)
display(dead_stock_detail.limit(25))

# COMMAND ----------

# MAGIC %md
# MAGIC ## 7. Inventory Health Dashboard Summary

# COMMAND ----------

# Consolidated inventory health metrics
health = {
    "total_products": turnover_df.select("product_id").distinct().count(),
    "total_inventory_value": total_value,
    "active_reorder_alerts": reorder_df.count(),
    "critical_alerts": reorder_df.where(F.col("alert_severity") == "CRITICAL").count(),
    "dead_stock_value": total_dead_value,
    "class_a_products": abc_df.where(F.col("abc_class") == "A").count(),
    "under_stocked_products": under_stocked.count(),
}

print("\nINVENTORY HEALTH DASHBOARD")
print("=" * 50)
for key, value in health.items():
    if "value" in key.lower():
        print(f"  {key}: ${value:,.2f}")
    else:
        print(f"  {key}: {value:,}")
