# Databricks notebook source
# MAGIC %md
# MAGIC # Variable Library Demo — Parameterized Pipeline Ingestion
# MAGIC
# MAGIC This notebook demonstrates how to use **Fabric Variable Libraries** to
# MAGIC parameterize Bronze ingestion pipelines across environments (dev / staging / prod).
# MAGIC
# MAGIC ## Key Concepts
# MAGIC - **Variable Libraries** store key-value pairs scoped to a workspace
# MAGIC - Pipelines inject variables as notebook parameters at runtime
# MAGIC - Secrets bind to Azure Key Vault — never hard-code credentials
# MAGIC
# MAGIC ## Parameters (injected by Pipeline via Variable Library)
# MAGIC | Parameter | Example | Source |
# MAGIC |-----------|---------|--------|
# MAGIC | `environment` | `dev` | Variable Library |
# MAGIC | `landing_path` | `Files/landing/slot_telemetry/` | Variable Library |
# MAGIC | `target_table` | `bronze_slot_telemetry` | Variable Library |
# MAGIC | `lakehouse_name` | `lh_bronze` | Variable Library |
# MAGIC | `batch_id` | `run-2026-04-27-001` | Pipeline system variable |

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1 · Configuration — Read from Variable Library Parameters

# COMMAND ----------

from datetime import datetime

from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    col,
    current_timestamp,
    input_file_name,
    lit,
)
from pyspark.sql.types import (
    DoubleType,
    IntegerType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

spark = SparkSession.builder.getOrCreate()

# COMMAND ----------

# Parameters — injected by Pipeline activity from Variable Library.
# When running interactively, defaults are used.
# In a Pipeline, the "Set Variable" activity populates these from the
# Variable Library bound to the workspace.

environment = spark.conf.get("spark.loom.variable.environment", "dev")
landing_path = spark.conf.get(
    "spark.loom.variable.landing_path",
    "Files/landing/slot_telemetry/",
)
target_table = spark.conf.get(
    "spark.loom.variable.target_table",
    "bronze_slot_telemetry",
)
lakehouse_name = spark.conf.get(
    "spark.loom.variable.lakehouse_name",
    "lh_bronze",
)
batch_id = spark.conf.get(
    "spark.loom.variable.batch_id",
    f"interactive-{datetime.utcnow().strftime('%Y%m%d%H%M%S')}",
)

print(f"Environment : {environment}")
print(f"Landing path: {landing_path}")
print(f"Target table: {target_table}")
print(f"Lakehouse   : {lakehouse_name}")
print(f"Batch ID    : {batch_id}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2 · Schema Definition
# MAGIC
# MAGIC Schema enforcement prevents malformed files from corrupting the Bronze layer.
# MAGIC The schema itself can be versioned in a Variable Library or config file.

# COMMAND ----------

SLOT_SCHEMA = StructType([
    StructField("machine_id", StringType(), False),
    StructField("casino_id", StringType(), False),
    StructField("timestamp", TimestampType(), False),
    StructField("event_type", StringType(), False),
    StructField("denomination", DoubleType(), True),
    StructField("coin_in", DoubleType(), True),
    StructField("coin_out", DoubleType(), True),
    StructField("jackpot_amount", DoubleType(), True),
    StructField("player_id", StringType(), True),
    StructField("session_id", StringType(), True),
    StructField("floor_zone", StringType(), True),
    StructField("firmware_version", StringType(), True),
    StructField("error_code", IntegerType(), True),
])

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3 · Ingest from Landing Zone
# MAGIC
# MAGIC The `landing_path` is parameterized so the same notebook works across
# MAGIC environments — dev reads from a dev landing zone, prod from prod.

# COMMAND ----------

# Build the full OneLake path from the parameterized landing folder.
source_path = f"abfss://{lakehouse_name}@{{ADLS_ACCOUNT}}.dfs.core.windows.net/{landing_path}"

raw_df = (
    spark.read
    .format("parquet")
    .schema(SLOT_SCHEMA)
    .option("mode", "DROPMALFORMED")
    .load(source_path)
)

print(f"Records read from landing zone: {raw_df.count()}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4 · Add Metadata Columns
# MAGIC
# MAGIC Standard Bronze metadata: source file, ingestion timestamp, environment,
# MAGIC and batch ID (from Pipeline / Variable Library).

# COMMAND ----------

bronze_df = (
    raw_df
    .withColumn("_source_file", input_file_name())
    .withColumn("_ingested_at", current_timestamp())
    .withColumn("_environment", lit(environment))
    .withColumn("_batch_id", lit(batch_id))
)

bronze_df.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5 · Write to Bronze Delta Table
# MAGIC
# MAGIC The `target_table` name comes from the Variable Library, allowing the
# MAGIC same notebook to write to different tables per environment or domain.

# COMMAND ----------

(
    bronze_df
    .write
    .format("delta")
    .mode("append")
    .option("mergeSchema", "true")
    .saveAsTable(target_table)
)

print(f"✓ Appended {bronze_df.count()} records to {target_table}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6 · Post-Ingestion Quality Gate
# MAGIC
# MAGIC A lightweight count + null check ensures the write succeeded before
# MAGIC the Pipeline marks this activity as complete.

# COMMAND ----------

written_count = spark.table(target_table).filter(
    col("_batch_id") == batch_id
).count()

assert written_count > 0, (
    f"Quality gate FAILED: 0 records written for batch {batch_id}"
)

null_machine_ids = spark.table(target_table).filter(
    (col("_batch_id") == batch_id) & col("machine_id").isNull()
).count()

assert null_machine_ids == 0, (
    f"Quality gate FAILED: {null_machine_ids} null machine_id values"
)

print(f"✓ Quality gate PASSED — {written_count} records, 0 null machine_ids")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 7 · Variable Library Setup Reference
# MAGIC
# MAGIC ### Creating a Variable Library (REST API)
# MAGIC
# MAGIC ```python
# MAGIC import requests
# MAGIC
# MAGIC # Azure-native: there is no Variable Library item. Pass per-environment
# MAGIC # values via Synapse Spark conf or Synapse/ADF pipeline parameters bound to
# MAGIC # the Notebook activity, e.g. on the Spark pool / session:
# MAGIC url = None  # spark.conf.set("spark.loom.variable.environment", "dev")
# MAGIC headers = {"Authorization": f"Bearer {token}"}
# MAGIC
# MAGIC payload = {
# MAGIC     "displayName": "bronze-ingestion-config",
# MAGIC     "description": "Parameters for Bronze layer ingestion pipelines",
# MAGIC     "variables": {
# MAGIC         "environment": {"type": "String", "value": "dev"},
# MAGIC         "landing_path": {"type": "String", "value": "Files/landing/slot_telemetry/"},
# MAGIC         "target_table": {"type": "String", "value": "bronze_slot_telemetry"},
# MAGIC         "lakehouse_name": {"type": "String", "value": "lh_bronze"},
# MAGIC     }
# MAGIC }
# MAGIC
# MAGIC resp = requests.post(url, headers=headers, json=payload)
# MAGIC print(resp.status_code, resp.json())
# MAGIC ```
# MAGIC
# MAGIC ### Pipeline Activity Configuration
# MAGIC
# MAGIC In the Pipeline, add a **Notebook activity** and bind parameters:
# MAGIC
# MAGIC | Parameter | Source | Expression |
# MAGIC |-----------|--------|------------|
# MAGIC | `environment` | Variable Library | `@variables('environment')` |
# MAGIC | `landing_path` | Variable Library | `@variables('landing_path')` |
# MAGIC | `target_table` | Variable Library | `@variables('target_table')` |
# MAGIC | `lakehouse_name` | Variable Library | `@variables('lakehouse_name')` |
# MAGIC | `batch_id` | System | `@pipeline().RunId` |
# MAGIC
# MAGIC ### Environment Promotion Pattern
# MAGIC
# MAGIC ```
# MAGIC dev workspace  →  Variable Library: environment=dev,  landing=Files/landing/dev/
# MAGIC staging workspace → Variable Library: environment=stg, landing=Files/landing/stg/
# MAGIC prod workspace →  Variable Library: environment=prod, landing=Files/landing/prod/
# MAGIC ```
# MAGIC
# MAGIC The **same notebook** deploys to all three workspaces via Deployment Pipelines
# MAGIC or fabric-cicd. Only the Variable Library values differ per workspace.

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Step | Action | Variable Library Parameter |
# MAGIC |------|--------|---------------------------|
# MAGIC | 1 | Read config | `environment`, `lakehouse_name` |
# MAGIC | 2 | Define schema | (static in notebook) |
# MAGIC | 3 | Read landing | `landing_path` |
# MAGIC | 4 | Add metadata | `batch_id` (from Pipeline) |
# MAGIC | 5 | Write Bronze | `target_table` |
# MAGIC | 6 | Quality gate | `batch_id` (for filtering) |
# MAGIC
# MAGIC **Key takeaway:** Variable Libraries decouple configuration from code,
# MAGIC enabling a single notebook to serve dev, staging, and production without
# MAGIC modification — the same principle as environment variables in 12-factor apps.
