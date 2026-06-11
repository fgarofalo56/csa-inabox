# Databricks notebook source
# MAGIC %md
# MAGIC # Streaming: Oracle CDC via LogMiner/GoldenGate
# MAGIC
# MAGIC Captures change data from Oracle databases using LogMiner or GoldenGate
# MAGIC and streams inserts, updates, and deletes into the Bronze Delta Lake layer.
# MAGIC
# MAGIC ## Architecture
# MAGIC - **Source:** Oracle DB (ARCHIVELOG mode, supplemental logging enabled)
# MAGIC - **CDC Method:** LogMiner (built-in) or GoldenGate → Kafka → Eventstreams
# MAGIC - **Target:** `bronze_cdc_oracle` (Delta Lake, append with operation metadata)
# MAGIC
# MAGIC ## Prerequisites
# MAGIC - Oracle JDBC driver JAR on cluster classpath
# MAGIC - DBA privileges for LogMiner session setup
# MAGIC - Key Vault secret: `oracle-jdbc-password`

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

import os

from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    col,
    current_timestamp,
    expr,
    from_json,
    lit,
    regexp_replace,
    to_timestamp,
    udf,
    when,
)
from pyspark.sql.types import (
    BooleanType,
    DecimalType,
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Oracle JDBC connection parameters — credentials from environment / Key Vault
ORACLE_HOST     = os.getenv("ORACLE_HOST", "<oracle-host>")
ORACLE_PORT     = os.getenv("ORACLE_PORT", "1521")
ORACLE_SERVICE  = os.getenv("ORACLE_SERVICE", "CASINOPRD")
ORACLE_USER     = os.getenv("ORACLE_USER", "cdc_reader")
ORACLE_PASSWORD = os.getenv("ORACLE_PASSWORD")          # Key Vault secret

JDBC_URL = f"jdbc:oracle:thin:@//{ORACLE_HOST}:{ORACLE_PORT}/{ORACLE_SERVICE}"

# CDC scope
CDC_TABLES   = ["CASINO.SLOT_TRANSACTIONS", "CASINO.TABLE_GAME_HANDS"]
TARGET_TABLE = "bronze_cdc_oracle"
CHECKPOINT   = "Files/checkpoints/oracle_cdc"

# LogMiner window (minutes to look back on first run)
LOGMINER_LOOKBACK_MINUTES = int(os.getenv("LOGMINER_LOOKBACK_MINUTES", "10"))

print(f"JDBC URL    : {JDBC_URL}")
print(f"CDC tables  : {CDC_TABLES}")
print(f"Target table: {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Enable ARCHIVELOG Mode
# MAGIC
# MAGIC Run the following SQL as SYSDBA **once** to prepare the Oracle database.
# MAGIC These commands must be executed in a SQL*Plus or DBA tool session — they
# MAGIC cannot be issued over a standard JDBC connection.
# MAGIC
# MAGIC ```sql
# MAGIC -- Connect as SYSDBA
# MAGIC CONNECT / AS SYSDBA;
# MAGIC
# MAGIC -- Check current mode
# MAGIC SELECT log_mode FROM v$database;
# MAGIC
# MAGIC -- Enable ARCHIVELOG (requires instance restart)
# MAGIC SHUTDOWN IMMEDIATE;
# MAGIC STARTUP MOUNT;
# MAGIC ALTER DATABASE ARCHIVELOG;
# MAGIC ALTER DATABASE OPEN;
# MAGIC
# MAGIC -- Verify
# MAGIC SELECT log_mode FROM v$database;   -- should return ARCHIVELOG
# MAGIC ```

# COMMAND ----------

# MAGIC %md
# MAGIC ## Enable Supplemental Logging
# MAGIC
# MAGIC Supplemental logging ensures the redo log contains enough column data for CDC.
# MAGIC
# MAGIC ```sql
# MAGIC -- Minimum supplemental logging (required)
# MAGIC ALTER DATABASE ADD SUPPLEMENTAL LOG DATA;
# MAGIC
# MAGIC -- All-column logging for target tables (recommended for full before/after images)
# MAGIC ALTER TABLE CASINO.SLOT_TRANSACTIONS  ADD SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
# MAGIC ALTER TABLE CASINO.TABLE_GAME_HANDS   ADD SUPPLEMENTAL LOG DATA (ALL) COLUMNS;
# MAGIC
# MAGIC -- Grant LogMiner privileges to CDC user
# MAGIC GRANT EXECUTE ON DBMS_LOGMNR          TO cdc_reader;
# MAGIC GRANT EXECUTE ON DBMS_LOGMNR_D        TO cdc_reader;
# MAGIC GRANT SELECT  ON V_$LOGMNR_CONTENTS   TO cdc_reader;
# MAGIC GRANT SELECT  ON V_$DATABASE          TO cdc_reader;
# MAGIC GRANT SELECT  ON V_$ARCHIVED_LOG      TO cdc_reader;
# MAGIC GRANT LOGMINING                        TO cdc_reader;  -- 12c+
# MAGIC ```

# COMMAND ----------

# MAGIC %md
# MAGIC ## LogMiner Session Setup
# MAGIC
# MAGIC Oracle LogMiner is invoked via JDBC using PL/SQL anonymous blocks.
# MAGIC The following snippet is executed by the `logminer_reader` helper below.
# MAGIC
# MAGIC ```sql
# MAGIC -- Add redo log files for the desired time window
# MAGIC BEGIN
# MAGIC   DBMS_LOGMNR.ADD_LOGFILE(
# MAGIC     LOGFILENAME => '/oracle/redo/redo01.log',
# MAGIC     OPTIONS     => DBMS_LOGMNR.NEW);
# MAGIC END;
# MAGIC
# MAGIC -- Start LogMiner session with continuous mine + online catalog
# MAGIC BEGIN
# MAGIC   DBMS_LOGMNR.START_LOGMNR(
# MAGIC     STARTTIME => SYSDATE - INTERVAL '10' MINUTE,
# MAGIC     ENDTIME   => SYSDATE,
# MAGIC     OPTIONS   => DBMS_LOGMNR.CONTINUOUS_MINE +
# MAGIC                  DBMS_LOGMNR.DICT_FROM_ONLINE_CATALOG +
# MAGIC                  DBMS_LOGMNR.NO_ROWID_IN_STMT);
# MAGIC END;
# MAGIC ```

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Redo Logs via JDBC

# COMMAND ----------

def read_logminer_batch(jdbc_url: str, user: str, password: str,
                        tables: list, lookback_minutes: int):
    """Query V$LOGMNR_CONTENTS for DML changes on target tables."""
    table_filter = ", ".join(f"'{t}'" for t in tables)
    query = f"""(
        SELECT
            SCN,
            TIMESTAMP,
            OPERATION,
            SEG_OWNER || '.' || TABLE_NAME   AS table_name,
            SQL_REDO,
            SQL_UNDO,
            ROW_ID,
            XIDUSN, XIDSLT, XIDSQN
        FROM V$LOGMNR_CONTENTS
        WHERE OPERATION     IN ('INSERT','UPDATE','DELETE')
          AND SEG_TYPE_NAME  = 'TABLE'
          AND SEG_OWNER || '.' || TABLE_NAME IN ({table_filter})
          AND TIMESTAMP     >= SYSDATE - {lookback_minutes}/1440
    ) logmnr_q"""

    return (spark.read.format("jdbc")
            .option("url",      jdbc_url)
            .option("dbtable",  query)
            .option("user",     user)
            .option("password", password)
            .option("driver",   "oracle.jdbc.OracleDriver")
            .option("fetchsize", 1000)
            .load())

raw_cdc_df = read_logminer_batch(JDBC_URL, ORACLE_USER, ORACLE_PASSWORD,
                                 CDC_TABLES, LOGMINER_LOOKBACK_MINUTES)
print(f"CDC rows fetched: {raw_cdc_df.count()}")
raw_cdc_df.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Parse DML Operations

# COMMAND ----------

# Oracle data type mapping applied during cast:
#   NUMBER(p,s)  → DecimalType(p, s)
#   VARCHAR2     → StringType
#   DATE         → TimestampType  (Oracle DATE includes time component)
#   TIMESTAMP    → TimestampType
#   CLOB         → StringType     (streamed as text; large CLOBs truncated at 32 KB)
#   BLOB         → BinaryType     (not recommended for CDC; store reference only)

parsed_cdc_df = (raw_cdc_df
    .withColumn("scn",           col("SCN").cast(LongType()))
    .withColumn("change_ts",     col("TIMESTAMP").cast(TimestampType()))
    .withColumn("operation",     col("OPERATION"))
    .withColumn("table_name",    col("table_name"))
    .withColumn("sql_redo",      col("SQL_REDO"))
    .withColumn("sql_undo",      col("SQL_UNDO"))
    .withColumn("row_id",        col("ROW_ID"))
    .withColumn("txn_id",
        expr("CONCAT(XIDUSN, '.', XIDSLT, '.', XIDSQN)"))
    .withColumn("_ingest_ts",    current_timestamp())
    .withColumn("_source",       lit("oracle_logminer"))
    .select("scn","change_ts","operation","table_name",
            "sql_redo","sql_undo","row_id","txn_id",
            "_ingest_ts","_source"))

parsed_cdc_df.show(5, truncate=80)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Alternative: GoldenGate → Kafka → Eventstreams
# MAGIC
# MAGIC If LogMiner latency is unacceptable (>30 s) or the Oracle version is older
# MAGIC than 11g R2, use GoldenGate to publish changes to Kafka, then connect via
# MAGIC Microsoft Fabric Eventstreams (Kafka-compatible endpoint).
# MAGIC
# MAGIC ```
# MAGIC Oracle DB
# MAGIC   └─ GoldenGate Extract (trail files)
# MAGIC       └─ GoldenGate Replicat (Kafka handler)
# MAGIC           └─ Kafka topic: oracle.casino.cdc
# MAGIC               └─ Fabric Eventstream (Kafka source connector)
# MAGIC                   └─ bronze_cdc_oracle (Delta Lake)
# MAGIC ```
# MAGIC
# MAGIC **Kafka read snippet for GoldenGate JSON envelope:**
# MAGIC ```python
# MAGIC gg_schema = StructType([
# MAGIC     StructField("table",  StringType()),
# MAGIC     StructField("op_type", StringType()),   # I / U / D
# MAGIC     StructField("op_ts",  StringType()),
# MAGIC     StructField("before", StringType()),    # JSON row image
# MAGIC     StructField("after",  StringType()),
# MAGIC ])
# MAGIC df = (spark.readStream.format("kafka")
# MAGIC       .option("kafka.bootstrap.servers", KAFKA_BROKERS)
# MAGIC       .option("subscribe", "oracle.casino.cdc")
# MAGIC       .load()
# MAGIC       .select(from_json(col("value").cast("string"), gg_schema).alias("d"))
# MAGIC       .select("d.*"))
# MAGIC ```

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Lake

# COMMAND ----------

(parsed_cdc_df.write
    .format("delta")
    .mode("append")
    .option("mergeSchema", "true")
    .saveAsTable(TARGET_TABLE))

print(f"Written to {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Monitoring

# COMMAND ----------

# Row counts by operation type
spark.sql(f"""
    SELECT operation, table_name, COUNT(*) AS change_count
    FROM   {TARGET_TABLE}
    GROUP  BY operation, table_name
    ORDER  BY table_name, operation
""").show()

# Latest SCN processed (use to set next lookback window)
spark.sql(f"""
    SELECT MAX(scn) AS max_scn, MAX(change_ts) AS latest_change_ts
    FROM   {TARGET_TABLE}
""").show()

# NOTE: In Fabric, schedule this notebook via Data Factory pipeline triggers
# and pass LOGMINER_LOOKBACK_MINUTES as a parameter to implement micro-batch CDC.
# For sub-minute latency, deploy the GoldenGate → Eventstreams path instead.
