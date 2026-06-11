# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Retail Sales Cleansed
# MAGIC
# MAGIC Deduplicate, validate, enrich POS transactions with product/store master data.
# MAGIC
# MAGIC ## Source
# MAGIC - **Table:** bronze_retail_pos
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** silver_retail_sales
# MAGIC - **Format:** Delta Lake (merge/upsert)
# MAGIC
# MAGIC ## Transformations
# MAGIC - Deduplicate on txn_id
# MAGIC - Validate qty > 0, unit_price > 0
# MAGIC - Join product and store master
# MAGIC - Calculate line_total, apply returns logic
# MAGIC - PCI-DSS: drop card_token in silver (not needed for analytics)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    abs as spark_abs,
    col,
    current_timestamp,
    lit,
    sum as spark_sum,
    to_timestamp,
    when,
)
from pyspark.sql.window import Window

SOURCE_TABLE = "lh_bronze.bronze_retail_pos"
TARGET_TABLE = "lh_silver.silver_retail_sales"
PRODUCT_TABLE = "lh_bronze.bronze_product_master"
STORE_TABLE = "lh_bronze.bronze_store_master"

print(f"Source: {SOURCE_TABLE}")
print(f"Target: {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Data

# COMMAND ----------

df_bronze = spark.table(SOURCE_TABLE)
raw_count = df_bronze.count()
print(f"Bronze records: {raw_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 1: Deduplicate on txn_id
# MAGIC
# MAGIC Keep the latest ingested record per txn_id.

# COMMAND ----------

from pyspark.sql.functions import row_number

window_dedup = Window.partitionBy("txn_id").orderBy(col("_fabric_ingested_at").desc())

df_dedup = (
    df_bronze
    .withColumn("_rn", row_number().over(window_dedup))
    .filter(col("_rn") == 1)
    .drop("_rn")
)

dedup_count = df_dedup.count()
dupes_removed = raw_count - dedup_count
print(f"After dedup: {dedup_count:,} (removed {dupes_removed:,} duplicates)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 2: Data Validation
# MAGIC
# MAGIC - qty must be > 0 (returns handled separately)
# MAGIC - unit_price must be > 0
# MAGIC - Quarantine invalid rows

# COMMAND ----------

df_valid = df_dedup.filter(
    (col("qty") > 0) & (col("unit_price") > 0)
)

df_quarantine = df_dedup.filter(
    (col("qty") <= 0) | (col("unit_price") <= 0)
)

valid_count = df_valid.count()
quarantine_count = df_quarantine.count()
print(f"Valid: {valid_count:,} | Quarantined: {quarantine_count:,}")

# Write quarantined records for review
if quarantine_count > 0:
    df_quarantine.write \
        .format("delta") \
        .mode("append") \
        .saveAsTable("lh_silver.silver_retail_quarantine")
    print(f"Quarantined {quarantine_count:,} rows")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 3: Returns Logic
# MAGIC
# MAGIC Transactions with negative line_total or flagged payment_method='return'
# MAGIC are tagged as returns. We store them with is_return=true.

# COMMAND ----------

df_with_returns = df_valid.withColumn(
    "is_return",
    when(
        (col("line_total") < 0) | (col("payment_method") == "return"),
        lit(True),
    ).otherwise(lit(False)),
)

# Recalculate line_total to ensure consistency
df_calc = df_with_returns.withColumn(
    "line_total_calc",
    when(
        col("is_return"),
        -1 * spark_abs(col("qty") * col("unit_price") * (1 - col("discount_pct"))),
    ).otherwise(
        col("qty") * col("unit_price") * (1 - col("discount_pct")),
    ),
)

return_count = df_calc.filter(col("is_return")).count()
print(f"Returns identified: {return_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 4: Enrich with Product & Store Master
# MAGIC
# MAGIC Left-join to preserve all sales even if master data is lagging.

# COMMAND ----------

# Product master — bring in cost for margin calculation
try:
    df_product = spark.table(PRODUCT_TABLE).select(
        col("sku"),
        col("cost").alias("product_cost"),
    )
    df_enriched = df_calc.join(df_product, on="sku", how="left")
    print("Product master joined successfully")
except Exception as e:
    print(f"Product master not available: {e}. Continuing without cost.")
    df_enriched = df_calc.withColumn("product_cost", lit(None).cast("double"))

# Store master — bring in additional store attributes
try:
    df_store = spark.table(STORE_TABLE).select(
        col("store_id"),
        col("sqft").alias("store_sqft"),
        col("city").alias("store_city"),
        col("state").alias("store_state"),
    )
    df_enriched = df_enriched.join(df_store, on="store_id", how="left")
    print("Store master joined successfully")
except Exception as e:
    print(f"Store master not available: {e}. Continuing without store dims.")
    df_enriched = (
        df_enriched
        .withColumn("store_sqft", lit(None).cast("int"))
        .withColumn("store_city", lit(None).cast("string"))
        .withColumn("store_state", lit(None).cast("string"))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 5: Calculate Margin & Final Columns

# COMMAND ----------

df_silver = (
    df_enriched
    .withColumn(
        "gross_margin",
        when(
            col("product_cost").isNotNull(),
            col("line_total_calc") - (col("qty") * col("product_cost")),
        ),
    )
    .withColumn("txn_date", to_timestamp(col("txn_timestamp")).cast("date"))
    .withColumn("_silver_processed_at", current_timestamp())
    # PCI-DSS: drop card_token — not needed in analytics layer
    .drop("card_token", "_rn", "_ingested_at", "_source", "_batch_id")
    .withColumnRenamed("line_total_calc", "line_total")
)

print(f"Silver columns: {df_silver.columns}")

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
print(f"Silver table total rows: {silver_count:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Post-Processing Summary

# COMMAND ----------

display(
    spark.sql(f"""
        SELECT
            category,
            COUNT(*) AS txn_count,
            ROUND(SUM(line_total), 2) AS total_revenue,
            ROUND(AVG(discount_pct) * 100, 1) AS avg_discount_pct,
            SUM(CASE WHEN is_return THEN 1 ELSE 0 END) AS return_count
        FROM {TARGET_TABLE}
        GROUP BY category
        ORDER BY total_revenue DESC
    """)
)

# COMMAND ----------

# Checkpoint
checkpoint_path = "abfss://retail@{{ADLS_ACCOUNT}}.dfs.core.windows.net/checkpoints/silver_sales"
mssparkutils.fs.put(
    f"{checkpoint_path}/last_run.txt",
    f"{silver_count}|{quarantine_count}|{return_count}",
    True,
)
print("Silver checkpoint written")
