# Databricks notebook source
# MAGIC %md
# MAGIC # Shortcut Transformations - Auto Delta Conversion
# MAGIC
# MAGIC **Notebook:** `17_bronze_shortcut_transformations`
# MAGIC **Layer:** Bronze (Ingestion)
# MAGIC **Source:** OneLake Shortcuts to ADLS Gen2 / S3 / GCS files (CSV, Parquet, JSON)
# MAGIC **Target:** Auto-converted Delta tables in Lakehouse via Shortcut Transformations (GA March 2026)
# MAGIC
# MAGIC ## Overview
# MAGIC Shortcut Transformations (GA) automatically convert structured files into Delta Lake tables
# MAGIC without requiring pipelines or notebooks. This notebook demonstrates the pattern comparison
# MAGIC between traditional pipeline ingestion and the new shortcut transformation approach.

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from datetime import datetime

from pyspark.sql.functions import col, current_timestamp, input_file_name, lit
from pyspark.sql.types import (
    DoubleType,
    IntegerType,
    LongType,
    StringType,
    StructField,
    StructType,
)

TRADITIONAL_SOURCE = "Files/landing/adls_exports/player_activity.csv"
TRADITIONAL_TABLE = "bronze_player_activity_pipeline"
SHORTCUT_TABLE = "bronze_player_activity_shortcut"
USDA_SHORTCUT_TABLE = "bronze_usda_crop_production_shortcut"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

print(f"Batch ID: {BATCH_ID}")
print(f"Traditional: {TRADITIONAL_SOURCE} -> {TRADITIONAL_TABLE}")
print(f"Shortcut:    {SHORTCUT_TABLE}")
print(f"Federal:     {USDA_SHORTCUT_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Traditional Pipeline Ingestion (Baseline Comparison)
# MAGIC
# MAGIC The **existing** pattern: read raw files, apply schema, add metadata, write Delta.
# MAGIC Requires a notebook or Data Factory pipeline to execute.

# COMMAND ----------

player_schema = StructType([
    StructField("activity_id", StringType(), False),
    StructField("player_id", StringType(), False),
    StructField("casino_id", StringType(), True),
    StructField("activity_type", StringType(), True),
    StructField("activity_timestamp", StringType(), True),
    StructField("table_id", StringType(), True),
    StructField("game_type", StringType(), True),
    StructField("buy_in_amount", DoubleType(), True),
    StructField("cash_out_amount", DoubleType(), True),
    StructField("duration_minutes", IntegerType(), True),
    StructField("loyalty_points_earned", IntegerType(), True),
    StructField("session_id", StringType(), True),
])

try:
    df_trad = spark.read.schema(player_schema) \
        .option("header", "true").option("mode", "PERMISSIVE") \
        .csv(TRADITIONAL_SOURCE)
    df_trad = df_trad \
        .withColumn("_bronze_ingested_at", current_timestamp()) \
        .withColumn("_bronze_source_file", input_file_name()) \
        .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
        .withColumn("_bronze_load_date", current_timestamp().cast("date"))
    df_trad.write.format("delta").mode("append") \
        .option("mergeSchema", "true").partitionBy("_bronze_load_date") \
        .saveAsTable(TRADITIONAL_TABLE)
    trad_count = spark.table(TRADITIONAL_TABLE).count()
    print(f"Traditional Pipeline: {trad_count:,} records -> {TRADITIONAL_TABLE}")
except Exception as e:
    print(f"Traditional ingestion skipped (source not present): {e}")
    trad_count = 0

# COMMAND ----------

# MAGIC %md
# MAGIC ## Shortcut Transformation Pattern (NEW - GA March 2026)
# MAGIC
# MAGIC Fabric **automatically** converts structured files into Delta tables.
# MAGIC No notebook, no pipeline, no code required for the base conversion.
# MAGIC
# MAGIC ### How It Works
# MAGIC 1. Create a **Shortcut** in Lakehouse pointing to ADLS Gen2 / S3 / GCS
# MAGIC 2. Enable **Transformation** on the shortcut (UI toggle or REST API)
# MAGIC 3. Fabric **auto-converts** files to Delta in the Tables section
# MAGIC 4. **Incremental updates** -- new files are auto-converted on arrival
# MAGIC
# MAGIC ### Setup (Fabric UI)
# MAGIC ```
# MAGIC Lakehouse > Tables > New Shortcut > Azure Data Lake Storage Gen2
# MAGIC   Connection: storageaccount.dfs.core.windows.net
# MAGIC   Path:       /landing/player_activity/
# MAGIC   Enable:     "Shortcut Transformation" toggle = ON
# MAGIC ```
# MAGIC
# MAGIC **Shortcut transformations happen automatically -- no code needed.**

# COMMAND ----------

try:
    df_shortcut = spark.table(SHORTCUT_TABLE)
    shortcut_count = df_shortcut.count()
    print(f"Shortcut Table: {SHORTCUT_TABLE}")
    print(f"  Records: {shortcut_count:,}  Columns: {len(df_shortcut.columns)}")
    df_shortcut.printSchema()
    display(df_shortcut.limit(5))
except Exception as e:
    print(f"Shortcut table not found (configure shortcut in Fabric UI): {e}")
    shortcut_count = 0

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validate Shortcut-Transformed Data
# MAGIC
# MAGIC Compare schema and row counts between traditional pipeline and shortcut transformation.

# COMMAND ----------

try:
    df_t = spark.table(TRADITIONAL_TABLE)
    df_s = spark.table(SHORTCUT_TABLE)
    trad_base = [f for f in df_t.schema.fields if not f.name.startswith("_bronze_")]
    s_fields = {f.name: f.dataType.simpleString() for f in df_s.schema.fields}

    print("VALIDATION: Traditional vs Shortcut")
    print(f"{'Field':<28} {'Traditional':<18} {'Shortcut':<18} Match")
    print("-" * 70)
    for f in trad_base:
        tt = f.dataType.simpleString()
        st = s_fields.get(f.name, "MISSING")
        print(f"  {f.name:<26} {tt:<18} {st:<18} {'OK' if tt == st else 'DIFF'}")

    tc, sc = df_t.count(), df_s.count()
    print(f"\nRows: Traditional={tc:,}  Shortcut={sc:,}  {'MATCH' if tc == sc else 'DIFF'}")
    for fld in ["activity_id", "player_id"]:
        tn = df_t.filter(col(fld).isNull()).count()
        sn = df_s.filter(col(fld).isNull()).count()
        print(f"  {fld} nulls: Trad={tn} Short={sn} {'OK' if tn == sn else 'DIFF'}")
except Exception as e:
    print(f"Validation skipped (tables not available): {e}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Enrich Shortcut Tables with Bronze Metadata
# MAGIC
# MAGIC Add standard `_bronze_*` columns for medallion architecture consistency.

# COMMAND ----------

try:
    df_raw = spark.table(SHORTCUT_TABLE)
    df_enriched = df_raw \
        .withColumn("_bronze_ingested_at", current_timestamp()) \
        .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
        .withColumn("_bronze_load_date", current_timestamp().cast("date")) \
        .withColumn("_bronze_source", lit("shortcut_transformation"))
    enriched_table = f"{SHORTCUT_TABLE}_enriched"
    df_enriched.write.format("delta").mode("overwrite") \
        .option("overwriteSchema", "true").partitionBy("_bronze_load_date") \
        .saveAsTable(enriched_table)
    print(f"Enriched: {df_enriched.count():,} records -> {enriched_table}")
    print(f"  Added: _bronze_ingested_at, _bronze_batch_id, _bronze_load_date, _bronze_source")
except Exception as e:
    print(f"Enrichment skipped (shortcut table not available): {e}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Federal Data Shortcut Example: USDA Crop Production
# MAGIC
# MAGIC USDA crop production CSVs from ADLS Gen2 auto-converted to Delta via shortcut.
# MAGIC ```
# MAGIC Lakehouse > New Shortcut > ADLS Gen2 > /federal-data/usda/crop_production/
# MAGIC   Transformation: ON  |  Table: bronze_usda_crop_production_shortcut
# MAGIC ```

# COMMAND ----------

usda_schema = StructType([
    StructField("record_id", StringType(), False),
    StructField("state_code", StringType(), True),
    StructField("state_name", StringType(), True),
    StructField("commodity", StringType(), True),
    StructField("year", IntegerType(), True),
    StructField("period", StringType(), True),
    StructField("acres_planted", LongType(), True),
    StructField("acres_harvested", LongType(), True),
    StructField("production_quantity", LongType(), True),
    StructField("yield_per_acre", DoubleType(), True),
    StructField("price_per_unit", DoubleType(), True),
    StructField("unit", StringType(), True),
])

try:
    df_usda = spark.table(USDA_SHORTCUT_TABLE)
    expected = {f.name for f in usda_schema.fields}
    actual = set(df_usda.columns)
    print(f"USDA Shortcut: {USDA_SHORTCUT_TABLE}")
    print(f"  Records: {df_usda.count():,}  Columns: {len(df_usda.columns)}")
    print(f"  Schema: {'PASS' if not (expected - actual) else f'Missing: {expected - actual}'}")
    print(f"  States: {df_usda.select('state_name').distinct().count()}")
    print(f"  Commodities: {df_usda.select('commodity').distinct().count()}")
    display(df_usda.limit(5))
except Exception as e:
    print(f"USDA table not found (configure shortcut first): {e}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary & Comparison
# MAGIC
# MAGIC | Dimension | Pipeline / Notebook | Shortcut Transformation |
# MAGIC |-----------|---------------------|-------------------------|
# MAGIC | **Setup Time** | Hours (schema + code + pipeline) | Minutes (UI toggle) |
# MAGIC | **Maintenance** | Code updates, testing, deploy | Near-zero (Fabric-managed) |
# MAGIC | **Latency** | Scheduled or triggered | Near-real-time on file arrival |
# MAGIC | **Compute Cost** | Spark cluster runtime | Included in Fabric capacity |
# MAGIC | **Schema Control** | Full (explicit StructType) | Auto-inferred (verify post-hoc) |
# MAGIC | **Transformations** | Unlimited (PySpark, SQL) | None (raw conversion only) |
# MAGIC | **Metadata** | Added at ingestion | Requires enrichment step |
# MAGIC | **Incremental** | Custom logic (watermark) | Automatic |
# MAGIC
# MAGIC **Use Shortcuts:** file drops, open data, bulk loads, quick POCs
# MAGIC **Use Pipelines:** complex joins, streaming, compliance (CTR/SAR), business logic
# MAGIC **Hybrid:** shortcuts for ingestion + notebooks for enrichment and Silver processing

# COMMAND ----------

print("=" * 80)
print("SHORTCUT TRANSFORMATIONS - INGESTION SUMMARY")
print("=" * 80)
print(f"\n{'Method':<22} {'Table':<45} {'Records':<10} {'Mechanism'}")
print("-" * 90)
for method, table, cnt, mech in [
    ("Traditional", TRADITIONAL_TABLE, trad_count, "Notebook/Pipeline"),
    ("Shortcut", SHORTCUT_TABLE, shortcut_count, "Fabric Auto-Convert"),
    ("Federal (USDA)", USDA_SHORTCUT_TABLE, 0, "Fabric Auto-Convert"),
]:
    print(f"  {method:<20} {table:<45} {cnt:<10,} {mech}")
print(f"\nBatch: {BATCH_ID}")
print(f"Key Takeaways:")
print(f"  1. Shortcut Transformations eliminate boilerplate ingestion code")
print(f"  2. Auto-inferred schemas should be validated post-conversion")
print(f"  3. Bronze metadata enrichment recommended for lineage tracking")
print(f"  4. Best for file-based sources, open data, quick POC onboarding")
print(f"  5. Combine with existing notebooks for Silver/Gold processing")
print("=" * 80)
