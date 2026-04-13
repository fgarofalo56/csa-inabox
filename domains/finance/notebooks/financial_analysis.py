# Databricks notebook source
# MAGIC %md
# MAGIC # CSA-in-a-Box: Financial Analysis
# MAGIC
# MAGIC Finance-domain notebook that analyses gold-layer tables produced by the
# MAGIC dbt pipeline: `gld_aging_report` and `gld_revenue_reconciliation`.
# MAGIC
# MAGIC **Key analyses:**
# MAGIC - Accounts receivable aging bucket breakdown
# MAGIC - Revenue trend analysis (monthly, quarterly)
# MAGIC - Payment velocity metrics
# MAGIC - Dashboard-ready summary export

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Configuration

# COMMAND ----------

from pyspark.sql import functions as F
from pyspark.sql.window import Window

dbutils.widgets.text("catalog", "csa_inabox", "Unity Catalog Name")
catalog = dbutils.widgets.get("catalog")

AGING_TABLE = f"{catalog}.gold.gld_aging_report"
RECONCILIATION_TABLE = f"{catalog}.gold.gld_revenue_reconciliation"
MONTHLY_REVENUE_TABLE = f"{catalog}.gold.gld_monthly_revenue"
FACT_ORDERS_TABLE = f"{catalog}.gold.fact_orders"

print(f"Catalog: {catalog}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Aging Bucket Analysis

# COMMAND ----------

aging_df = spark.table(AGING_TABLE)

# Summary by aging bucket
aging_summary = (
    aging_df
    .groupBy("aging_bucket")
    .agg(
        F.count("*").alias("invoice_count"),
        F.sum("outstanding_balance").alias("total_outstanding"),
        F.avg("outstanding_balance").alias("avg_outstanding"),
        F.avg("estimated_loss_rate").alias("avg_loss_rate"),
        F.sum(F.col("outstanding_balance") * F.col("estimated_loss_rate"))
            .alias("estimated_loss_provision"),
    )
    .orderBy(
        F.when(F.col("aging_bucket") == "CURRENT", 1)
        .when(F.col("aging_bucket") == "1-30", 2)
        .when(F.col("aging_bucket") == "31-60", 3)
        .when(F.col("aging_bucket") == "61-90", 4)
        .when(F.col("aging_bucket") == "90+", 5)
        .otherwise(6)
    )
)

print("ACCOUNTS RECEIVABLE AGING SUMMARY")
print("=" * 70)
display(aging_summary)

# Total exposure
total_outstanding = aging_df.agg(F.sum("outstanding_balance")).collect()[0][0] or 0
total_provision = aging_df.agg(
    F.sum(F.col("outstanding_balance") * F.col("estimated_loss_rate"))
).collect()[0][0] or 0

print(f"\nTotal Outstanding: ${total_outstanding:,.2f}")
print(f"Estimated Loss Provision: ${total_provision:,.2f}")
print(f"Provision Rate: {total_provision / max(total_outstanding, 1) * 100:.1f}%")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Aging Bucket Distribution (Visualization)

# COMMAND ----------

# Prepare data for pie/bar chart
aging_viz = (
    aging_summary
    .select(
        "aging_bucket",
        F.round("total_outstanding", 2).alias("total_outstanding"),
        "invoice_count",
    )
)

display(aging_viz)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Top Customers with Overdue Balances

# COMMAND ----------

overdue_customers = (
    aging_df
    .where(F.col("days_past_due") > 0)
    .groupBy("customer_id")
    .agg(
        F.count("*").alias("overdue_invoices"),
        F.sum("outstanding_balance").alias("total_overdue"),
        F.max("days_past_due").alias("max_days_past_due"),
    )
    .orderBy(F.desc("total_overdue"))
    .limit(20)
)

print("TOP 20 CUSTOMERS BY OVERDUE BALANCE")
display(overdue_customers)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Revenue Trend Analysis

# COMMAND ----------

# MAGIC %md
# MAGIC ### Monthly Revenue

# COMMAND ----------

monthly_revenue = (
    spark.table(MONTHLY_REVENUE_TABLE)
    .groupBy("revenue_year", "revenue_month", "revenue_period")
    .agg(
        F.sum("gross_revenue").alias("gross_revenue"),
        F.sum("net_revenue").alias("net_revenue"),
        F.sum("returned_revenue").alias("returned_revenue"),
        F.sum("cancelled_revenue").alias("cancelled_revenue"),
        F.sum("total_orders").alias("total_orders"),
        F.sum("unique_customers").alias("unique_customers"),
    )
    .orderBy("revenue_year", "revenue_month")
)

# Add month-over-month growth
window = Window.orderBy("revenue_period")
monthly_revenue = monthly_revenue.withColumn(
    "prev_month_revenue", F.lag("net_revenue").over(window)
).withColumn(
    "mom_growth_pct",
    F.round(
        (F.col("net_revenue") - F.col("prev_month_revenue"))
        / F.abs(F.coalesce(F.col("prev_month_revenue"), F.lit(1)))
        * 100, 2
    ),
)

print("MONTHLY REVENUE TREND")
display(monthly_revenue)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Quarterly Revenue

# COMMAND ----------

quarterly_revenue = (
    spark.table(FACT_ORDERS_TABLE)
    .groupBy("order_year", "order_quarter")
    .agg(
        F.sum("total_amount").alias("gross_revenue"),
        F.sum(F.when(
            (F.col("is_cancelled") == 0) & (F.col("is_returned") == 0),
            F.col("total_amount")
        ).otherwise(0)).alias("net_revenue"),
        F.count("*").alias("total_orders"),
        F.countDistinct("customer_id").alias("unique_customers"),
        F.avg("total_amount").alias("avg_order_value"),
    )
    .orderBy("order_year", "order_quarter")
)

print("QUARTERLY REVENUE TREND")
display(quarterly_revenue)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Payment Velocity Metrics

# COMMAND ----------

# Days between invoice date and payment (using aging report data)
payment_velocity = (
    aging_df
    .withColumn(
        "days_to_due",
        F.datediff("due_date", "invoice_date"),
    )
    .groupBy(
        F.date_trunc("month", "invoice_date").alias("invoice_month"),
    )
    .agg(
        F.count("*").alias("invoice_count"),
        F.avg("days_to_due").alias("avg_payment_terms_days"),
        F.avg("days_past_due").alias("avg_days_past_due"),
        F.sum(F.when(F.col("days_past_due") <= 0, 1).otherwise(0)).alias("on_time_count"),
        F.sum("invoice_total").alias("total_invoiced"),
        F.sum("total_paid").alias("total_collected"),
    )
    .withColumn(
        "on_time_pct",
        F.round(F.col("on_time_count") / F.col("invoice_count") * 100, 1),
    )
    .withColumn(
        "collection_rate_pct",
        F.round(F.col("total_collected") / F.col("total_invoiced") * 100, 1),
    )
    .orderBy("invoice_month")
)

print("PAYMENT VELOCITY METRICS (Monthly)")
display(payment_velocity)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Revenue Reconciliation Summary

# COMMAND ----------

recon_df = spark.table(RECONCILIATION_TABLE)

# Reconciliation status breakdown
recon_summary = (
    recon_df
    .groupBy("reconciliation_status")
    .agg(
        F.count("*").alias("record_count"),
        F.sum(F.abs("amount_difference")).alias("total_discrepancy"),
        F.avg(F.abs("amount_difference")).alias("avg_discrepancy"),
    )
)

print("RECONCILIATION STATUS BREAKDOWN")
display(recon_summary)

# Unmatched items needing attention
mismatches = (
    recon_df
    .where(F.col("reconciliation_status") != "MATCHED")
    .orderBy(F.abs("amount_difference").desc())
    .limit(25)
)

print("\nTOP MISMATCHES / UNMATCHED ITEMS")
display(mismatches)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Export Summary for Finance Dashboard

# COMMAND ----------

# Create a consolidated dashboard dataset
dashboard_metrics = (
    monthly_revenue
    .select(
        "revenue_period",
        "revenue_year",
        "revenue_month",
        "gross_revenue",
        "net_revenue",
        "total_orders",
        "unique_customers",
        "mom_growth_pct",
    )
    .withColumn("metric_type", F.lit("monthly_revenue"))
    .withColumn("_exported_at", F.current_timestamp())
)

# Write to a dashboard-ready Delta table
dashboard_table = f"{catalog}.gold.finance_dashboard_summary"
dashboard_metrics.write.format("delta").mode("overwrite").saveAsTable(dashboard_table)

print(f"Dashboard data exported to: {dashboard_table}")
print(f"Records: {spark.table(dashboard_table).count():,}")
