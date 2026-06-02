# Notebooks (Spark)

Loom notebooks are interactive Spark notebooks for data engineering and data
science — PySpark, Scala, Spark SQL, and R cells running against your lakehouse.
The Loom notebook editor builds the Fabric / Synapse notebook experience
one-for-one, backed by a real Databricks or Synapse Spark cluster.

## When to use it

- **Interactive** data exploration, cleansing, and feature engineering against
  Delta tables in the lakehouse.
- **Bronze → Silver → Gold** transforms where you want code (not a visual
  dataflow) — joins, window functions, UDFs, ML feature prep.
- Authoring logic you'll later schedule from a **pipeline Notebook activity** or
  promote to a headless **Spark job definition**.

Use a Dataflow Gen2 instead when the team prefers a code-free Power Query
transform; use a Spark job definition for production batch with no interactive
session.

## The notebook editor

Open a notebook at `/items/notebook/<id>`. The ribbon mirrors Fabric:

- **Home** — **Run**, **Run all**, **Run history**.
- **Item** — **New notebook**, **Delete**.
- **Workspace** — **Refresh list**.
- **Insert** — **+ Code cell**, **+ Markdown cell**.

The notebook **attaches to a cluster** (a Databricks cluster or a Synapse Spark
pool); the attach control is in the header. Cells render in an embedded compute
UI, and results appear inline.

### Step-by-step: read, transform, write Delta

1. **Create / open** a notebook and **attach** it to the default cluster
   (Loom pre-configures one per workspace).
2. **+ Code cell** — read a Bronze Delta table:

   ```python
   df = spark.read.format("delta").load("Tables/noaa_bronze_daily")
   df.printSchema()
   ```

3. Add a transform cell (Bronze → Silver):

   ```python
   from pyspark.sql.functions import col, to_date
   silver = (df
       .withColumn("date", to_date("date_str"))
       .filter(col("temp_f").isNotNull()))
   silver.write.format("delta").mode("overwrite") \
       .partitionBy("date").saveAsTable("noaa_silver_daily")
   ```

4. Use `%%sql` magic for ad-hoc SQL without switching languages:

   ```sql
   %%sql
   SELECT YEAR(date) yr, AVG(temp_c) FROM noaa_silver_daily GROUP BY YEAR(date)
   ```

5. **Run** the cell (Shift+Enter) or **Run all** from the ribbon. Watch
   progress in **Run history**.
6. **Schedule** it: from a data pipeline, add a **Notebook** activity bound to
   this notebook and attach a trigger.

## Honest infra gate

If no Spark cluster / pool is reachable, the editor shows a `MessageBar`
naming the cluster env var (e.g. `EXISTING_DATABRICKS_HOSTNAME`) or the Synapse
Spark pool to provision. The notebook surface still renders so you can author
cells offline.

## Tip

Read with `spark.read.format("delta").load("Files/...")` from raw, write back
with `df.write.mode("overwrite").format("delta").save("Tables/...")`. Reach
for `%%sql` for quick checks inside a PySpark notebook.

## Learn more

- **MS Learn — [Explore the lakehouse with a notebook](https://learn.microsoft.com/fabric/data-engineering/lakehouse-notebook-explore)**
- MS Learn — [Develop, execute, and manage notebooks](https://learn.microsoft.com/fabric/data-engineering/how-to-use-notebook)
- MS Learn — [Spark job definition](https://learn.microsoft.com/fabric/data-engineering/spark-job-definition)
- Loom editor guides — [Notebook](../tutorials/editor-notebook.md) · [Databricks notebook](../tutorials/editor-databricks-notebook.md)
- Loom tutorial — [First lakehouse + Delta tables](../tutorials/02-first-lakehouse.md)
