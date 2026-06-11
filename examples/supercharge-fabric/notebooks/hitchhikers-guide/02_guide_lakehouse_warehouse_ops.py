# Fabric notebook source
# MAGIC %md
# MAGIC # 🧭 Hitchhiker's Guide — 02: Lakehouse & Warehouse Ops
# MAGIC
# MAGIC ## Sections
# MAGIC
# MAGIC | # | Topic |
# MAGIC |---|---|
# MAGIC | A | Lakehouse CRUD via `mssparkutils.lakehouse.*` |
# MAGIC | B | Default lakehouse + relative paths (Spark vs Python notebook) |
# MAGIC | C | OneLake addressing for items |
# MAGIC | D | Read / write Delta |
# MAGIC | E | MERGE (upsert) |
# MAGIC | F | OPTIMIZE / Z-ORDER / VACUUM |
# MAGIC | G | Schema enforcement & evolution |
# MAGIC | H | Partitioning |
# MAGIC | I | Warehouse from Spark (synapsesql connector) |
# MAGIC | J | Time travel & history |
# MAGIC | K | Materialized Lake Views |

# COMMAND ----------

# MAGIC %md
# MAGIC ## A — Lakehouse CRUD
# MAGIC
# MAGIC 🔗 [notebookutils-lakehouse](https://learn.microsoft.com/en-us/fabric/data-engineering/notebookutils/notebookutils-lakehouse)

# COMMAND ----------

mssparkutils.lakehouse.list()
mssparkutils.lakehouse.create("lh_bronze", description="raw ingestion")
mssparkutils.lakehouse.get("lh_bronze")
# Rename is dangerous — downstream shortcuts break. Coordinate first.
mssparkutils.lakehouse.update("<lakehouseId>", new_name="lh_bronze_v2")
# mssparkutils.lakehouse.delete("<lakehouseId>")   # uncomment with care

# COMMAND ----------

# MAGIC %md
# MAGIC ## B — Default lakehouse & relative paths
# MAGIC
# MAGIC 🚩 **Gotcha**: Spark notebooks resolve relative paths against the
# MAGIC default lakehouse's ABFSS root. Python notebooks resolve against
# MAGIC `/home/trusted-service-user/work`. **Always pass absolute paths
# MAGIC across notebook types.**

# COMMAND ----------

# Spark notebook — works
df = spark.read.format("delta").load("Tables/customers")

# Python notebook — broken: this opens a local file in the runtime container
# Use the full abfss path instead.

# COMMAND ----------

# MAGIC %md
# MAGIC ## C — OneLake addressing
# MAGIC
# MAGIC ```
# MAGIC https://{{ADLS_ACCOUNT}}.dfs.core.windows.net/<workspace>/<item>.<itemtype>/<path>
# MAGIC ```
# MAGIC
# MAGIC where `<itemtype>` is `lakehouse`, `warehouse`, `mirroredDatabase`,
# MAGIC `MirroredAzureDatabricksCatalog`, `eventhouse`, etc.
# MAGIC
# MAGIC 🔗 [onelake-access-api](https://learn.microsoft.com/en-us/fabric/onelake/onelake-access-api)

# COMMAND ----------

# MAGIC %md
# MAGIC ## D — Read / write Delta

# COMMAND ----------

df = spark.read.format("delta").load("Tables/customers")
(df
  .write.format("delta")
  .mode("overwrite")
  .option("overwriteSchema", "true")
  .saveAsTable("lh_silver.customers"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## E — MERGE (upsert)

# COMMAND ----------

from delta.tables import DeltaTable

target = DeltaTable.forName(spark, "lh_silver.customers")
updates = spark.read.format("delta").load("Tables/customers_changes")

(target.alias("t")
  .merge(updates.alias("s"), "t.customer_id = s.customer_id")
  .whenMatchedUpdateAll()
  .whenNotMatchedInsertAll()
  .execute())

# COMMAND ----------

# MAGIC %md
# MAGIC ## F — OPTIMIZE / Z-ORDER / VACUUM

# COMMAND ----------

spark.sql("OPTIMIZE lh_silver.customers")
spark.sql("OPTIMIZE lh_silver.orders ZORDER BY (customer_id, order_date)")
spark.sql("VACUUM lh_silver.customers RETAIN 168 HOURS")
spark.sql("DESCRIBE HISTORY lh_silver.customers LIMIT 5").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## G — Schema enforcement & evolution

# COMMAND ----------

# Append with schema evolution (adds new columns automatically)
(df
  .write.format("delta")
  .mode("append")
  .option("mergeSchema", "true")
  .save("Tables/customers"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## H — Partitioning

# COMMAND ----------

(df
  .write.format("delta")
  .partitionBy("region", "year")
  .mode("overwrite")
  .saveAsTable("lh_silver.orders_partitioned"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## I — Warehouse from Spark
# MAGIC
# MAGIC 🔗 [spark-data-warehouse-connector](https://learn.microsoft.com/en-us/fabric/data-engineering/spark-data-warehouse-connector)

# COMMAND ----------

dfw = spark.read.synapsesql("warehouse.dbo.dim_customer")
(spark.table("lh_silver.orders")
   .write.synapsesql("warehouse.dbo.fact_orders", mode="append"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## J — Time travel

# COMMAND ----------

df_v5 = spark.read.option("versionAsOf", 5).format("delta").load("Tables/customers")
df_ts = spark.read.option("timestampAsOf", "2026-05-01T00:00:00Z").format("delta").load("Tables/customers")

# COMMAND ----------

# MAGIC %md
# MAGIC ## K — Materialized Lake Views
# MAGIC
# MAGIC 2026 feature — declarative materialization with auto-refresh. Combines
# MAGIC with V-Order and skipping for Direct Lake performance.
# MAGIC
# MAGIC 🔗 [materialized-lake-views](https://learn.microsoft.com/en-us/fabric/data-engineering/materialized-lake-views)

# COMMAND ----------

spark.sql("""
CREATE OR REPLACE MATERIALIZED VIEW lh_gold.mv_monthly_revenue AS
SELECT date_trunc('month', order_date) AS month, region, sum(revenue) AS revenue
FROM lh_silver.fact_sales
GROUP BY date_trunc('month', order_date), region
""")
