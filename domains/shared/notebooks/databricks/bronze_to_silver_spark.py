# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze to Silver: Spark Processing Pipeline
# MAGIC
# MAGIC Alternative to dbt for teams that prefer native Spark processing.
# MAGIC Reads raw data from ADLS Bronze layer, applies schema enforcement,
# MAGIC validation, and dedup, then writes Delta to Silver.
# MAGIC
# MAGIC **Parameters (widgets):**
# MAGIC - `domain`: Data domain (default: shared)
# MAGIC - `entity`: Entity name (e.g., sample_orders, sample_customers)
# MAGIC - `environment`: dev/prod (default: dev)

# COMMAND ----------

# Widget parameters
dbutils.widgets.text("domain", "shared", "Domain")
dbutils.widgets.text("entity", "sample_orders", "Entity")
dbutils.widgets.dropdown("environment", "dev", ["dev", "prod"], "Environment")

domain = dbutils.widgets.get("domain")
entity = dbutils.widgets.get("entity")
environment = dbutils.widgets.get("environment")

print(f"Processing: {domain}/{entity} ({environment})")

# COMMAND ----------

from datetime import datetime

from delta.tables import DeltaTable
from pyspark.sql import functions as F
from pyspark.sql.types import (
    DecimalType,
    LongType,
    StringType,
    StructField,
    StructType,
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

# Storage paths
STORAGE_ACCOUNT = spark.conf.get("spark.csa.storage_account", "csadatalake")
BRONZE_PATH = f"abfss://raw@{STORAGE_ACCOUNT}.dfs.core.windows.net/{domain}/{entity}"
SILVER_PATH = f"abfss://curated@{STORAGE_ACCOUNT}.dfs.core.windows.net/silver/{domain}/{entity}"

# Schema definitions per entity
SCHEMAS = {
    "sample_orders": StructType(
        [
            StructField("order_id", StringType(), True),
            StructField("customer_id", StringType(), True),
            StructField("order_date", StringType(), True),
            StructField("total_amount", StringType(), True),
            StructField("status", StringType(), True),
            StructField("_ingested_at", StringType(), True),
        ]
    ),
    "sample_customers": StructType(
        [
            StructField("customer_id", StringType(), True),
            StructField("first_name", StringType(), True),
            StructField("last_name", StringType(), True),
            StructField("email", StringType(), True),
            StructField("phone", StringType(), True),
            StructField("address_line1", StringType(), True),
            StructField("address_line2", StringType(), True),
            StructField("city", StringType(), True),
            StructField("state", StringType(), True),
            StructField("postal_code", StringType(), True),
            StructField("country", StringType(), True),
            StructField("region", StringType(), True),
            StructField("signup_date", StringType(), True),
            StructField("created_at", StringType(), True),
            StructField("updated_at", StringType(), True),
            StructField("_ingested_at", StringType(), True),
        ]
    ),
    "sample_products": StructType(
        [
            StructField("product_id", StringType(), True),
            StructField("product_name", StringType(), True),
            StructField("category", StringType(), True),
            StructField("unit_price", StringType(), True),
            StructField("_ingested_at", StringType(), True),
        ]
    ),
}

print(f"Bronze: {BRONZE_PATH}")
print(f"Silver: {SILVER_PATH}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Read Bronze Data

# COMMAND ----------

schema = SCHEMAS.get(entity)
if schema is None:
    dbutils.notebook.exit(f"ERROR: No schema defined for entity '{entity}'")

# Read raw data (CSV or Parquet)
try:
    df_bronze = spark.read.option("header", "true").schema(schema).csv(BRONZE_PATH)
except Exception:
    # Fall back to Parquet if CSV fails
    df_bronze = spark.read.parquet(BRONZE_PATH)

row_count = df_bronze.count()
print(f"Read {row_count} rows from Bronze")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Deduplication

# COMMAND ----------

from pyspark.sql.window import Window

# Entity-specific dedup key
DEDUP_KEYS = {
    "sample_orders": "order_id",
    "sample_customers": "customer_id",
    "sample_products": "product_id",
}

dedup_key = DEDUP_KEYS.get(entity, entity.replace("sample_", "") + "_id")

window = Window.partitionBy(dedup_key).orderBy(F.col("_ingested_at").desc())
df_deduped = (
    df_bronze.withColumn("_row_num", F.row_number().over(window)).filter(F.col("_row_num") == 1).drop("_row_num")
)

dedup_dropped = row_count - df_deduped.count()
print(f"Dedup removed {dedup_dropped} duplicate rows")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Type Casting and Standardization

# COMMAND ----------

if entity == "sample_orders":
    df_typed = (
        df_deduped.withColumn("order_id", F.col("order_id").cast(LongType()))
        .withColumn("customer_id", F.col("customer_id").cast(LongType()))
        .withColumn("order_date", F.to_date("order_date", "yyyy-MM-dd"))
        .withColumn("total_amount", F.col("total_amount").cast(DecimalType(18, 2)))
        .withColumn("status", F.upper(F.trim(F.col("status"))))
        .withColumn("_ingested_at", F.to_timestamp("_ingested_at"))
    )
elif entity == "sample_customers":
    df_typed = (
        df_deduped.withColumn("customer_id", F.col("customer_id").cast(LongType()))
        .withColumn("first_name", F.upper(F.trim(F.col("first_name"))))
        .withColumn("last_name", F.upper(F.trim(F.col("last_name"))))
        .withColumn("email", F.lower(F.trim(F.col("email"))))
        .withColumn("state", F.upper(F.trim(F.col("state"))))
        .withColumn("country", F.upper(F.trim(F.col("country"))))
        .withColumn("created_at", F.to_timestamp("created_at"))
        .withColumn("updated_at", F.to_timestamp("updated_at"))
        .withColumn("_ingested_at", F.to_timestamp("_ingested_at"))
    )
elif entity == "sample_products":
    df_typed = (
        df_deduped.withColumn("product_id", F.col("product_id").cast(LongType()))
        .withColumn("product_name", F.trim(F.col("product_name")))
        .withColumn("category", F.upper(F.trim(F.col("category"))))
        .withColumn("unit_price", F.col("unit_price").cast(DecimalType(18, 2)))
        .withColumn("_ingested_at", F.to_timestamp("_ingested_at"))
    )
else:
    df_typed = df_deduped

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Validation (Flag-Don't-Drop)

# COMMAND ----------

if entity == "sample_orders":
    df_validated = (
        df_typed.withColumn("_is_missing_order_id", F.col("order_id").isNull())
        .withColumn("_is_missing_customer_id", F.col("customer_id").isNull())
        .withColumn("_is_missing_order_date", F.col("order_date").isNull())
        .withColumn("_is_negative_amount", F.col("total_amount") < 0)
        .withColumn("_is_future_date", F.col("order_date") > F.current_date())
        .withColumn(
            "is_valid",
            ~(
                F.col("_is_missing_order_id")
                | F.col("_is_missing_customer_id")
                | F.col("_is_missing_order_date")
                | F.col("_is_negative_amount")
                | F.col("_is_future_date")
            ),
        )
        .withColumn(
            "validation_errors",
            F.concat_ws(
                "; ",
                F.when(F.col("_is_missing_order_id"), F.lit("order_id null")),
                F.when(F.col("_is_missing_customer_id"), F.lit("customer_id null")),
                F.when(F.col("_is_missing_order_date"), F.lit("order_date null")),
                F.when(F.col("_is_negative_amount"), F.lit("total_amount negative")),
                F.when(F.col("_is_future_date"), F.lit("order_date in the future")),
            ),
        )
    )
elif entity == "sample_customers":
    email_regex = r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
    df_validated = (
        df_typed.withColumn("_is_missing_id", F.col("customer_id").isNull())
        .withColumn("_is_invalid_email", ~F.col("email").rlike(email_regex))
        .withColumn(
            "_is_missing_name",
            (F.coalesce(F.col("first_name"), F.lit("")) == "") & (F.coalesce(F.col("last_name"), F.lit("")) == ""),
        )
        .withColumn("_is_missing_created_at", F.col("created_at").isNull())
        .withColumn(
            "is_valid",
            ~(
                F.col("_is_missing_id")
                | F.col("_is_invalid_email")
                | F.col("_is_missing_name")
                | F.col("_is_missing_created_at")
            ),
        )
        .withColumn(
            "validation_errors",
            F.concat_ws(
                "; ",
                F.when(F.col("_is_missing_id"), F.lit("customer_id missing")),
                F.when(F.col("_is_invalid_email"), F.lit("email failed regex")),
                F.when(F.col("_is_missing_name"), F.lit("name missing")),
                F.when(F.col("_is_missing_created_at"), F.lit("created_at null")),
            ),
        )
    )
else:
    df_validated = df_typed.withColumn("is_valid", F.lit(True)).withColumn("validation_errors", F.lit(""))

# Add processing metadata
df_final = df_validated.withColumn("_dbt_loaded_at", F.current_timestamp()).withColumn(
    "_processing_engine", F.lit("spark")
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Write to Silver (Delta Lake)

# COMMAND ----------

valid_count = df_final.filter(F.col("is_valid") == True).count()
invalid_count = df_final.filter(F.col("is_valid") == False).count()
total = df_final.count()

print(f"Writing {total} rows to Silver ({valid_count} valid, {invalid_count} flagged)")

# Merge into Delta (upsert)
if DeltaTable.isDeltaTable(spark, SILVER_PATH):
    delta_table = DeltaTable.forPath(spark, SILVER_PATH)
    merge_key = DEDUP_KEYS.get(entity, "id")

    (
        delta_table.alias("target")
        .merge(df_final.alias("source"), f"target.{merge_key} = source.{merge_key}")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute()
    )
    print(f"Merged into existing Delta table at {SILVER_PATH}")
else:
    (df_final.write.format("delta").mode("overwrite").option("overwriteSchema", "true").save(SILVER_PATH))
    print(f"Created new Delta table at {SILVER_PATH}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Summary

# COMMAND ----------

summary = {
    "entity": entity,
    "domain": domain,
    "environment": environment,
    "bronze_rows": row_count,
    "dedup_removed": dedup_dropped,
    "silver_rows": total,
    "valid_rows": valid_count,
    "invalid_rows": invalid_count,
    "valid_pct": round(valid_count / max(total, 1) * 100, 1),
    "silver_path": SILVER_PATH,
    "processed_at": datetime.utcnow().isoformat(),
}

import json

dbutils.notebook.exit(json.dumps(summary))
