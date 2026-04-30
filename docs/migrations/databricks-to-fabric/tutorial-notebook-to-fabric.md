# Tutorial — Convert a Databricks PySpark Notebook to Fabric

**Status:** Authored 2026-04-30
**Audience:** Data engineers performing their first Databricks-to-Fabric notebook migration.
**Scope:** Step-by-step walkthrough converting a real-world PySpark notebook with dbutils, Delta tables, library dependencies, and a downstream Power BI Direct Lake report.

---

## Prerequisites

Before starting this tutorial, you need:

- [ ] A Fabric workspace (F64 or higher for Power BI Premium features)
- [ ] A Lakehouse created in the workspace
- [ ] Access to the source ADLS Gen2 storage account (for OneLake shortcuts)
- [ ] The original Databricks notebook exported as `.py` or `.ipynb`
- [ ] Familiarity with PySpark and the Fabric notebook interface

---

## Scenario

You have a Databricks PySpark notebook that:

1. Reads raw customer CSV files from ADLS (`/mnt/raw/customers/`)
2. Cleans and transforms the data (deduplicate, standardize fields)
3. Writes a Silver-tier Delta table (`production.silver.customers_clean`)
4. A Power BI Import semantic model refreshes from this table via DBSQL

We will convert this to a Fabric notebook that:

1. Reads the same data via an OneLake shortcut
2. Runs the same transformations
3. Writes to a Fabric Lakehouse table
4. Powers a Power BI Direct Lake report (no scheduled refresh needed)

---

## Step 1: Export the Databricks notebook

In Databricks:

1. Open the notebook
2. Click **File > Export > Source File (.py)** or **IPython Notebook (.ipynb)**
3. Save to your local machine

**Original Databricks notebook (`customer_etl.py`):**

```python
# Databricks notebook source

# MAGIC %md
# MAGIC # Customer ETL Pipeline
# MAGIC Reads raw CSV, cleans, writes Silver Delta table.

# COMMAND ----------

# Install dependencies
# MAGIC %pip install phonenumbers==8.13.0 email-validator==2.0.0

# COMMAND ----------

import phonenumbers
from email_validator import validate_email
from pyspark.sql import functions as F
from pyspark.sql.types import StringType

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

dbutils.widgets.text("input_path", "/mnt/raw/customers/", "Input Path")
dbutils.widgets.text("output_table", "production.silver.customers_clean", "Output Table")
dbutils.widgets.dropdown("mode", "overwrite", ["overwrite", "append"], "Write Mode")

input_path = dbutils.widgets.get("input_path")
output_table = dbutils.widgets.get("output_table")
write_mode = dbutils.widgets.get("mode")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read raw data

# COMMAND ----------

# Read CSVs from mounted ADLS
df_raw = (
    spark.read
    .option("header", "true")
    .option("inferSchema", "true")
    .csv(input_path)
)

print(f"Raw records: {df_raw.count()}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Clean and transform

# COMMAND ----------

# UDF: Standardize phone numbers
@F.udf(StringType())
def standardize_phone(phone):
    if phone is None:
        return None
    try:
        parsed = phonenumbers.parse(phone, "US")
        return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
    except Exception:
        return None

# UDF: Validate email
@F.udf(StringType())
def validate_email_udf(email):
    if email is None:
        return None
    try:
        validated = validate_email(email, check_deliverability=False)
        return validated.normalized
    except Exception:
        return None

# Apply transformations
df_clean = (
    df_raw
    .dropDuplicates(["customer_id"])
    .withColumn("email_clean", validate_email_udf(F.col("email")))
    .withColumn("phone_clean", standardize_phone(F.col("phone")))
    .withColumn("state_upper", F.upper(F.trim(F.col("state"))))
    .withColumn("created_date", F.to_date(F.col("created_at")))
    .withColumn("etl_timestamp", F.current_timestamp())
    .filter(F.col("customer_id").isNotNull())
    .select(
        "customer_id",
        "first_name",
        "last_name",
        "email_clean",
        "phone_clean",
        "state_upper",
        "created_date",
        "etl_timestamp"
    )
)

print(f"Clean records: {df_clean.count()}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Silver Delta table

# COMMAND ----------

(
    df_clean.write
    .format("delta")
    .mode(write_mode)
    .option("overwriteSchema", "true")
    .saveAsTable(output_table)
)

# COMMAND ----------

# MAGIC %sql
# MAGIC -- Verify
# MAGIC SELECT COUNT(*) as total_records FROM production.silver.customers_clean

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize table

# COMMAND ----------

spark.sql(f"OPTIMIZE {output_table} ZORDER BY (state_upper, created_date)")

# COMMAND ----------

dbutils.notebook.exit(f"SUCCESS: {df_clean.count()} records written to {output_table}")
```

---

## Step 2: Create OneLake shortcut to source data

Before converting the notebook, make the source CSV files accessible in Fabric.

1. Open your Fabric workspace
2. Open (or create) a Lakehouse named `bronze_lakehouse`
3. In the Lakehouse explorer, right-click **Files** > **New shortcut**
4. Select **Azure Data Lake Storage Gen2**
5. Enter the connection details:
    - **URL:** `https://<storageaccount>.dfs.core.windows.net`
    - **Sub path:** `/<container>/raw/customers`
    - **Shortcut name:** `raw_customers`
6. Authenticate with your Entra ID credentials or a service principal

The CSV files now appear at `Files/raw_customers/` in the Lakehouse. No data was copied.

---

## Step 3: Create a Fabric environment for libraries

1. In the workspace, click **New > Environment**
2. Name it `customer-etl-env`
3. Under **Public libraries**, add:
    - `phonenumbers==8.13.0`
    - `email-validator==2.0.0`
4. Click **Publish** and wait for the environment to build (~2-5 minutes)

---

## Step 4: Create the Fabric notebook

1. In the workspace, click **New > Notebook**
2. Name it `customer_etl`
3. Attach the `customer-etl-env` environment (top toolbar > Environment dropdown)
4. Attach to the `bronze_lakehouse` as the default Lakehouse

---

## Step 5: Convert the notebook code

Create the following cells in the Fabric notebook:

**Cell 1 (Markdown):**

```markdown
# Customer ETL Pipeline

Reads raw CSV from OneLake shortcut, cleans, writes Silver Lakehouse table.
Converted from Databricks notebook `customer_etl.py`.
```

**Cell 2 (PySpark) -- Imports:**

```python
# Libraries are installed via the Fabric environment (customer-etl-env)
# No need for %pip install in the notebook
import phonenumbers
from email_validator import validate_email
from pyspark.sql import functions as F
from pyspark.sql.types import StringType
```

**Cell 3 (PySpark) -- Configuration:**

```python
# Parameters -- in Fabric, these are passed from Data Pipeline
# or via mssparkutils.notebook.run()
# Default values used for interactive development
input_path = mssparkutils.notebook.getParam("input_path", "Files/raw_customers/")
output_table = mssparkutils.notebook.getParam("output_table", "customers_clean")
write_mode = mssparkutils.notebook.getParam("mode", "overwrite")

print(f"Input: {input_path}")
print(f"Output table: {output_table}")
print(f"Write mode: {write_mode}")
```

**Cell 4 (PySpark) -- Read raw data:**

```python
# Read CSVs from OneLake shortcut (no /mnt/ needed)
df_raw = (
    spark.read
    .option("header", "true")
    .option("inferSchema", "true")
    .csv(input_path)
)

print(f"Raw records: {df_raw.count()}")
df_raw.printSchema()
```

**Cell 5 (PySpark) -- Transform:**

```python
# UDF: Standardize phone numbers (same as Databricks)
@F.udf(StringType())
def standardize_phone(phone):
    if phone is None:
        return None
    try:
        parsed = phonenumbers.parse(phone, "US")
        return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
    except Exception:
        return None

# UDF: Validate email (same as Databricks)
@F.udf(StringType())
def validate_email_udf(email):
    if email is None:
        return None
    try:
        validated = validate_email(email, check_deliverability=False)
        return validated.normalized
    except Exception:
        return None

# Apply transformations (same logic)
df_clean = (
    df_raw
    .dropDuplicates(["customer_id"])
    .withColumn("email_clean", validate_email_udf(F.col("email")))
    .withColumn("phone_clean", standardize_phone(F.col("phone")))
    .withColumn("state_upper", F.upper(F.trim(F.col("state"))))
    .withColumn("created_date", F.to_date(F.col("created_at")))
    .withColumn("etl_timestamp", F.current_timestamp())
    .filter(F.col("customer_id").isNotNull())
    .select(
        "customer_id",
        "first_name",
        "last_name",
        "email_clean",
        "phone_clean",
        "state_upper",
        "created_date",
        "etl_timestamp"
    )
)

print(f"Clean records: {df_clean.count()}")
```

**Cell 6 (PySpark) -- Write Silver table:**

```python
# Write to Lakehouse table (replaces Unity Catalog table path)
(
    df_clean.write
    .format("delta")
    .mode(write_mode)
    .option("overwriteSchema", "true")
    .saveAsTable(output_table)
)

print(f"Table '{output_table}' written successfully.")
```

**Cell 7 (Spark SQL) -- Verify:**

```sql
-- Verify row count (use cell type: Spark SQL)
SELECT COUNT(*) as total_records,
       COUNT(DISTINCT customer_id) as unique_customers,
       MIN(created_date) as earliest,
       MAX(created_date) as latest
FROM bronze_lakehouse.customers_clean
```

**Cell 8 (PySpark) -- Optimization note:**

```python
# Fabric auto-applies V-Order optimization on write.
# Manual OPTIMIZE + ZORDER is available but usually unnecessary.
# Uncomment if you need explicit optimization:
# spark.sql(f"OPTIMIZE {output_table} ZORDER BY (state_upper, created_date)")

print("V-Order auto-optimization applied during write.")
```

**Cell 9 (PySpark) -- Exit:**

```python
record_count = spark.table(output_table).count()
mssparkutils.notebook.exit(f"SUCCESS: {record_count} records in {output_table}")
```

---

## Step 6: Schedule with a Data Pipeline

1. In the workspace, click **New > Data Pipeline**
2. Name it `customer_etl_pipeline`
3. Add a **Notebook activity**:
    - Notebook: `customer_etl`
    - Parameters:
        - `input_path`: `Files/raw_customers/`
        - `output_table`: `customers_clean`
        - `mode`: `overwrite`
4. Add a **Schedule trigger**:
    - Recurrence: Daily at 06:00 UTC
    - Or: Storage event trigger on `Files/raw_customers/` for event-driven runs

---

## Step 7: Create a Direct Lake Power BI report

1. In the Lakehouse, click the **SQL endpoint** in the top-right
2. In the SQL endpoint view, click **New semantic model**
3. Select the `customers_clean` table
4. Name the semantic model `Customers - Direct Lake`
5. The semantic model is created with Direct Lake mode -- no import, no refresh
6. Open the semantic model and click **New report**
7. Build your report:
    - Card visual: Total Customers (`COUNT(customer_id)`)
    - Bar chart: Customers by State (`state_upper`)
    - Table: Customer list with filters
8. Save the report

**Result:** The Power BI report reads directly from the Delta files in OneLake. When the notebook runs and updates the table, the report shows fresh data automatically. No scheduled refresh, no DBSQL warehouse running.

---

## Step 8: Validate migration

Run both the Databricks notebook and the Fabric notebook against the same source data and compare:

| Validation check               | Databricks result | Fabric result | Match? |
| ------------------------------ | ----------------- | ------------- | ------ |
| Raw record count               | **\_\_**          | **\_\_**      | [ ]    |
| Clean record count             | **\_\_**          | **\_\_**      | [ ]    |
| Unique customer IDs            | **\_\_**          | **\_\_**      | [ ]    |
| Records per state (top 5)      | **\_\_**          | **\_\_**      | [ ]    |
| Email validation failures      | **\_\_**          | **\_\_**      | [ ]    |
| Phone standardization failures | **\_\_**          | **\_\_**      | [ ]    |
| Schema (column names + types)  | **\_\_**          | **\_\_**      | [ ]    |

If all checks pass, the migration is validated.

---

## Step 9: Decommission Databricks notebook

After 2 weeks of parallel operation:

1. Archive the Databricks notebook to Git (if not already)
2. Disable the Databricks job schedule
3. Remove the DBSQL endpoint (if only used for this Power BI model)
4. Update documentation to reference the Fabric notebook
5. Remove the old Power BI Import semantic model

---

## Summary of changes

| Original (Databricks)               | Converted (Fabric)                  | Change type        |
| ----------------------------------- | ----------------------------------- | ------------------ |
| `%pip install`                      | Fabric environment                  | Library management |
| `dbutils.widgets.get()`             | `mssparkutils.notebook.getParam()`  | Parameterization   |
| `/mnt/raw/customers/`               | `Files/raw_customers/` (shortcut)   | Path               |
| `production.silver.customers_clean` | `customers_clean` (Lakehouse table) | Table reference    |
| `OPTIMIZE ... ZORDER BY`            | V-Order auto-applied                | Optimization       |
| `%sql` magic                        | Spark SQL cell type                 | Cell type          |
| `dbutils.notebook.exit()`           | `mssparkutils.notebook.exit()`      | Notebook API       |
| Power BI Import + DBSQL             | Direct Lake (no refresh)            | BI model           |
| Databricks Workflow job             | Fabric Data Pipeline                | Scheduling         |

Total code changes: ~15 lines modified out of ~80 lines of PySpark. The transformation logic is identical.

---

## Related

- [Notebook Migration](notebook-migration.md) -- complete reference for all notebook patterns
- [Unity Catalog Migration](unity-catalog-migration.md) -- table reference mapping
- [Feature Mapping](feature-mapping-complete.md) -- notebook and dev tools section
- [Best Practices](best-practices.md) -- notebook conversion checklist
- [Parent guide: 5-phase migration](../databricks-to-fabric.md)

---

**Maintainers:** csa-inabox core team
**Source finding:** CSA-0083 (HIGH, XL) -- approved via AQ-0010 ballot B6
**Last updated:** 2026-04-30
