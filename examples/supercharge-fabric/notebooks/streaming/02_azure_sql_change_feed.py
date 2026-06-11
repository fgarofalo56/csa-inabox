# Databricks notebook source
# MAGIC %md
# MAGIC # Streaming: Azure SQL Database Change Feed
# MAGIC
# MAGIC Processes change data from Azure SQL Database using SQL Server Change
# MAGIC Tracking (CT) and Fabric Mirroring. Changes are applied as upserts to the
# MAGIC Bronze Delta Lake table, preserving the full mutation history.
# MAGIC
# MAGIC **Architecture:** Azure SQL DB → Fabric Mirroring (GA) → Bronze Delta
# MAGIC **Alternative:** Azure SQL DB → Change Tracking → JDBC Polling → Bronze Delta
# MAGIC
# MAGIC | Setting | Value |
# MAGIC |---|---|
# MAGIC | Source | Azure SQL Database (General Purpose / Business Critical) |
# MAGIC | CT Method | SQL Server Change Tracking v2 |
# MAGIC | Preferred GA Method | Fabric Database Mirroring |
# MAGIC | Sink | `lh_bronze.bronze_cdc_azure_sql` |
# MAGIC | Write Mode | MERGE (upsert) |

# COMMAND ----------
# MAGIC %md
# MAGIC ## 1. Configuration — Azure SQL Connection & Change Tracking

# COMMAND ----------

import os

from delta.tables import DeltaTable
from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import (
    BooleanType,
    DecimalType,
    IntegerType,
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

spark = SparkSession.builder.getOrCreate()

# ---------------------------------------------------------------------------
# Connection configuration — all secrets sourced from Key Vault
# NOTE: In Fabric, use mssparkutils.credentials.getSecret() to avoid
#       embedding connection strings in notebook source.
# ---------------------------------------------------------------------------
try:
    from notebookutils import mssparkutils
    AZURE_SQL_JDBC_URL = mssparkutils.credentials.getSecret(
        "kv-casino-poc", "azure-sql-jdbc-url"
    )
    AZURE_SQL_USER     = mssparkutils.credentials.getSecret(
        "kv-casino-poc", "azure-sql-username"
    )
    AZURE_SQL_PASSWORD = mssparkutils.credentials.getSecret(
        "kv-casino-poc", "azure-sql-password"
    )
    CHECKPOINT_STORAGE = mssparkutils.credentials.getSecret(
        "kv-casino-poc", "adls-checkpoint-path"
    )
except ImportError:
    AZURE_SQL_JDBC_URL = os.getenv("AZURE_SQL_JDBC_URL", "")
    AZURE_SQL_USER     = os.getenv("AZURE_SQL_USER", "")
    AZURE_SQL_PASSWORD = os.getenv("AZURE_SQL_PASSWORD", "")
    CHECKPOINT_STORAGE = os.getenv("CHECKPOINT_PATH", os.environ.get('CHECKPOINT_PATH_BASE', 'abfss://Files/checkpoints') + '')

# JDBC properties dict (used for batch reads during CT polling)
jdbc_properties = {
    "user":     AZURE_SQL_USER,
    "password": AZURE_SQL_PASSWORD,
    "driver":   "com.microsoft.sqlserver.jdbc.SQLServerDriver",
    "encrypt":  "true",
    "trustServerCertificate": "false",
    "hostNameInCertificate":  "*.database.windows.net",
    "loginTimeout": "30",
}

# Target tables in Azure SQL Database
CT_TABLES = {
    "Orders":           {"schema": "dbo", "pk": "OrderId"},
    "CustomerActivity": {"schema": "dbo", "pk": "ActivityId"},
}

# Delta Lake target
BRONZE_TABLE   = "lh_bronze.bronze_cdc_azure_sql"
CHECKPOINT_DIR = f"{CHECKPOINT_STORAGE}/cdc_azure_sql"
CT_VERSION_DIR = f"{CHECKPOINT_STORAGE}/ct_versions"  # persists last sync version

# NOTE: Fabric Database Mirroring (GA) is the recommended approach for
#       Azure SQL Database — it replicates the entire database without
#       requiring JDBC polling. This notebook covers the JDBC/CT fallback.

# COMMAND ----------
# MAGIC %md
# MAGIC ## 2. Enable Change Tracking on Azure SQL — Run Once Against Source DB
# MAGIC
# MAGIC Execute in Azure SQL Database via SSMS, Azure Data Studio, or the
# MAGIC Query editor in the Azure portal. **Not executed by this notebook.**

# COMMAND ----------

CHANGE_TRACKING_SQL = """
-- Step 1: Enable Change Tracking at database level
--   CHANGE_RETENTION: how long CT data is retained (DAYS)
--   AUTO_CLEANUP: automatically purge expired CT entries
ALTER DATABASE casino
SET CHANGE_TRACKING = ON
(CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON);
GO

-- Step 2: Enable Change Tracking on Orders table
ALTER TABLE dbo.Orders
ENABLE CHANGE_TRACKING
WITH (TRACK_COLUMNS_UPDATED = ON);  -- record which columns changed
GO

-- Step 3: Enable Change Tracking on CustomerActivity table
ALTER TABLE dbo.CustomerActivity
ENABLE CHANGE_TRACKING
WITH (TRACK_COLUMNS_UPDATED = ON);
GO

-- Verify CT is enabled
SELECT
    DB_NAME()                       AS database_name,
    is_auto_cleanup_on,
    retention_period,
    retention_period_units_desc
FROM sys.change_tracking_databases;

-- Get the current minimum valid CT version (must use this as baseline)
SELECT CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID('dbo.Orders')) AS min_valid_version;
SELECT CHANGE_TRACKING_CURRENT_VERSION()                          AS current_version;
"""

print("Change Tracking SQL (run on Azure SQL Database):")
print(CHANGE_TRACKING_SQL)

# COMMAND ----------
# MAGIC %md
# MAGIC ## 3. Fabric Mirroring Setup (Preferred GA Method)
# MAGIC
# MAGIC Microsoft Fabric Database Mirroring replicates Azure SQL Database
# MAGIC continuously without custom JDBC polling. Configure via the Fabric portal:
# MAGIC
# MAGIC 1. Open the Fabric workspace → **+ New** → **Mirrored Azure SQL Database**
# MAGIC 2. Provide the Azure SQL connection details
# MAGIC 3. Select tables: `dbo.Orders`, `dbo.CustomerActivity`
# MAGIC 4. Fabric creates a managed Lakehouse with Delta tables automatically
# MAGIC 5. Tables land under `lh_mirrored_casino.dbo_Orders` etc.
# MAGIC
# MAGIC NOTE: When using Fabric Mirroring the JDBC polling sections below are
# MAGIC       NOT needed. This notebook's JDBC approach is a fallback for
# MAGIC       environments where Mirroring is unavailable or requires custom logic.

print("Fabric Mirroring is the preferred method for Azure SQL Database.")
print("See inline comments for portal configuration steps.")
print("JDBC Change Tracking polling proceeds below as the programmatic alternative.")

# COMMAND ----------
# MAGIC %md
# MAGIC ## 4. Read Change Feed — JDBC Change Tracking Polling
# MAGIC
# MAGIC Change Tracking returns only changed PKs plus metadata. We then join back
# MAGIC to the source table to retrieve full row data for inserts/updates.

# COMMAND ----------

def get_last_sync_version(table_name: str) -> int:
    """Read the last successfully processed CT version from the checkpoint."""
    version_path = f"{CT_VERSION_DIR}/{table_name}_version.txt"
    try:
        df = spark.read.text(version_path)
        return int(df.collect()[0][0])
    except Exception:
        # First run — start from a safe baseline 24 hours behind current version
        baseline_query = "SELECT CHANGE_TRACKING_CURRENT_VERSION() - 1000 AS v"
        result = spark.read.jdbc(AZURE_SQL_JDBC_URL, f"({baseline_query}) t", properties=jdbc_properties)
        return int(result.collect()[0]["v"])


def save_sync_version(table_name: str, version: int):
    """Persist the successfully processed CT version."""
    version_path = f"{CT_VERSION_DIR}/{table_name}_version.txt"
    spark.createDataFrame([[str(version)]]).write.mode("overwrite").text(version_path)


def read_changed_keys(table_name: str, schema_name: str, pk_col: str, last_version: int):
    """
    Query CHANGETABLE to get all PKs modified since last_version.
    Returns a DataFrame with pk, SYS_CHANGE_OPERATION, SYS_CHANGE_VERSION.
    """
    ct_query = f"""
        SELECT
            CT.{pk_col},
            CT.SYS_CHANGE_OPERATION  AS change_op,      -- I=Insert, U=Update, D=Delete
            CT.SYS_CHANGE_VERSION    AS change_version,
            CT.SYS_CHANGE_COLUMNS    AS changed_columns
        FROM CHANGETABLE(CHANGES {schema_name}.{table_name}, {last_version}) AS CT
    """
    return spark.read.jdbc(
        AZURE_SQL_JDBC_URL,
        f"({ct_query}) change_keys",
        properties=jdbc_properties
    )

# COMMAND ----------
# MAGIC %md
# MAGIC ## 5. Process Changes — Inserts, Updates, Deletes

# COMMAND ----------

# Schema for Orders (full row)
orders_schema = StructType([
    StructField("OrderId",         StringType(),       nullable=False),
    StructField("CustomerId",      StringType(),       nullable=True),
    StructField("TableId",         StringType(),       nullable=True),
    StructField("GameType",        StringType(),       nullable=True),
    StructField("BetAmount",       DecimalType(18, 2), nullable=True),
    StructField("Outcome",         StringType(),       nullable=True),  # WIN, LOSS, PUSH
    StructField("OrderStatus",     StringType(),       nullable=True),
    StructField("CreatedAt",       TimestampType(),    nullable=True),
    StructField("UpdatedAt",       TimestampType(),    nullable=True),
])

# Schema for CustomerActivity (full row)
customer_activity_schema = StructType([
    StructField("ActivityId",      StringType(),       nullable=False),
    StructField("CustomerId",      StringType(),       nullable=True),
    StructField("ActivityType",    StringType(),       nullable=True),  # CHECK_IN, CHECK_OUT, COMP_REDEEM
    StructField("LocationCode",    StringType(),       nullable=True),
    StructField("PointsEarned",    IntegerType(),      nullable=True),
    StructField("ActivityTs",      TimestampType(),    nullable=True),
])


def fetch_full_rows(table_name: str, schema_name: str, pk_col: str, changed_pks):
    """
    Given a set of changed PKs, fetch the full current row from the source table.
    Deletes will have no matching row — we identify them from change_op='D'.
    """
    pk_list = ",".join([f"'{r[pk_col]}'" for r in changed_pks.filter(F.col("change_op") != "D").select(pk_col).collect()])
    if not pk_list:
        return spark.createDataFrame([], orders_schema)  # empty frame
    full_row_query = f"""
        SELECT * FROM {schema_name}.{table_name}
        WHERE {pk_col} IN ({pk_list})
    """
    return spark.read.jdbc(AZURE_SQL_JDBC_URL, f"({full_row_query}) rows", properties=jdbc_properties)


def process_table_changes(table_name: str, config: dict):
    """Full change-processing cycle for one CT-enabled table."""
    schema_name = config["schema"]
    pk_col      = config["pk"]

    last_version  = get_last_sync_version(table_name)
    changed_keys  = read_changed_keys(table_name, schema_name, pk_col, last_version)
    change_count  = changed_keys.count()

    print(f"[{table_name}] Found {change_count} changes since version {last_version}")
    if change_count == 0:
        return

    new_version = changed_keys.agg(F.max("change_version")).collect()[0][0]

    # Separate inserts/updates from deletes
    upsert_keys  = changed_keys.filter(F.col("change_op").isin("I", "U"))
    delete_keys  = changed_keys.filter(F.col("change_op") == "D")

    full_rows = (
        fetch_full_rows(table_name, schema_name, pk_col, upsert_keys)
        .withColumn("cdc_operation",    F.lit("UPSERT"))
        .withColumn("source_table",     F.lit(f"{schema_name}.{table_name}"))
        .withColumn("ingested_at",      F.current_timestamp())
        .withColumn("ingestion_source", F.lit("azure_sql_change_tracking"))
    )

    # Soft-delete rows: stamp a deleted_at column rather than physical removal
    delete_rows = (
        delete_keys
        .withColumnRenamed(pk_col, pk_col)
        .withColumn("cdc_operation",    F.lit("DELETE"))
        .withColumn("source_table",     F.lit(f"{schema_name}.{table_name}"))
        .withColumn("ingested_at",      F.current_timestamp())
        .withColumn("ingestion_source", F.lit("azure_sql_change_tracking"))
        .withColumn("deleted_at",       F.current_timestamp())
    )

    return full_rows, delete_rows, new_version

# COMMAND ----------
# MAGIC %md
# MAGIC ## 6. Write to Delta with MERGE for Upserts

# COMMAND ----------

def upsert_to_bronze(full_rows, delete_rows, table_name: str, pk_col: str, new_version: int):
    """
    MERGE upsert into the Bronze Delta table.
    - Matching PKs → UPDATE all columns
    - New PKs      → INSERT
    - Deleted PKs  → UPDATE with deleted_at timestamp (soft delete)
    """
    # Ensure the Delta table exists (create on first run)
    if not spark.catalog.tableExists(BRONZE_TABLE):
        full_rows.write.format("delta").partitionBy("source_table").saveAsTable(BRONZE_TABLE)
        save_sync_version(table_name, new_version)
        return

    bronze_delta = DeltaTable.forName(spark, BRONZE_TABLE)

    if not full_rows.isEmpty():
        (
            bronze_delta.alias("target")
            .merge(
                full_rows.alias("source"),
                f"target.{pk_col} = source.{pk_col} AND target.source_table = source.source_table"
            )
            .whenMatchedUpdateAll()
            .whenNotMatchedInsertAll()
            .execute()
        )
        print(f"  Upserted {full_rows.count()} rows into {BRONZE_TABLE}")

    if not delete_rows.isEmpty():
        (
            bronze_delta.alias("target")
            .merge(
                delete_rows.alias("source"),
                f"target.{pk_col} = source.{pk_col} AND target.source_table = source.source_table"
            )
            .whenMatchedUpdate(set={"deleted_at": "source.deleted_at", "cdc_operation": "'DELETE'"})
            .execute()
        )
        print(f"  Soft-deleted {delete_rows.count()} rows in {BRONZE_TABLE}")

    save_sync_version(table_name, new_version)


# Execute the CT polling cycle for all configured tables
for table_name, config in CT_TABLES.items():
    result = process_table_changes(table_name, config)
    if result:
        full_rows, delete_rows, new_version = result
        upsert_to_bronze(full_rows, delete_rows, table_name, config["pk"], new_version)

# COMMAND ----------
# MAGIC %md
# MAGIC ## 7. Monitoring

# COMMAND ----------

monitoring_sql = f"""
-- Change counts by table and operation (last 24 hours)
SELECT
    source_table,
    cdc_operation,
    COUNT(*)           AS record_count,
    MAX(ingested_at)   AS last_ingested,
    COUNT(deleted_at)  AS soft_delete_count
FROM {BRONZE_TABLE}
WHERE ingested_at >= CURRENT_TIMESTAMP - INTERVAL 24 HOURS
GROUP BY source_table, cdc_operation
ORDER BY source_table, cdc_operation;

-- Detect duplicate PKs (should be zero for upsert-managed Bronze)
SELECT source_table, OrderId, COUNT(*) AS dup_count
FROM {BRONZE_TABLE}
WHERE source_table = 'dbo.Orders'
GROUP BY source_table, OrderId
HAVING COUNT(*) > 1;

-- Change Tracking version lag check (run on Azure SQL)
-- SELECT
--     CHANGE_TRACKING_CURRENT_VERSION()    AS current_version,
--     CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID('dbo.Orders')) AS min_valid,
--     CURRENT_TIMESTAMP                    AS check_time;
"""

print("Monitoring SQL:")
print(monitoring_sql)

# Verify latest rows in Bronze
if spark.catalog.tableExists(BRONZE_TABLE):
    spark.sql(f"""
        SELECT source_table, cdc_operation, COUNT(*) AS cnt, MAX(ingested_at) AS latest
        FROM {BRONZE_TABLE}
        GROUP BY source_table, cdc_operation
        ORDER BY latest DESC
    """).show(truncate=False)
