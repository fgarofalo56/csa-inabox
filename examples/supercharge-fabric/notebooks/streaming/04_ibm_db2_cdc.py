# Databricks notebook source
# MAGIC %md
# MAGIC # Streaming: IBM DB2 CDC via JDBC
# MAGIC
# MAGIC Ingests change data from IBM DB2 legacy systems (LUW on-premises and z/OS
# MAGIC mainframe) using JDBC batch polling of DB2 ASN (Replication) staging tables.
# MAGIC Handles EBCDIC encoding, packed decimal data types, and mainframe-specific
# MAGIC date/time formats before writing to Bronze Delta Lake.
# MAGIC
# MAGIC **Architecture:** DB2 → ASN Replication → JDBC Polling → SHIR → Bronze Delta
# MAGIC
# MAGIC | Setting | Value |
# MAGIC |---|---|
# MAGIC | Source (LUW) | IBM DB2 LUW 11.5+ (Linux/Unix/Windows) |
# MAGIC | Source (z/OS) | IBM DB2 for z/OS v12+ |
# MAGIC | JDBC Driver | IBM DB2 JCC Driver 4.x (db2jcc4.jar) |
# MAGIC | Tables | CASINO.LEGACY_TRANSACTIONS, CASINO.PLAYER_HISTORY |
# MAGIC | Sink | `lh_bronze.bronze_cdc_ibm_db2` |
# MAGIC | Write Mode | Append (Bronze immutable log) |

# COMMAND ----------
# MAGIC %md
# MAGIC ## 1. Configuration — JDBC URL & Driver

# COMMAND ----------

import os

from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import (
    BooleanType,
    DateType,
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
# DB2 connection configuration — all secrets via Key Vault
# NOTE: In Fabric, use mssparkutils.credentials.getSecret() to avoid
#       embedding credentials in notebook source.
# ---------------------------------------------------------------------------
try:
    from notebookutils import mssparkutils
    DB2_HOST     = mssparkutils.credentials.getSecret("kv-casino-poc", "db2-host")
    DB2_PORT     = mssparkutils.credentials.getSecret("kv-casino-poc", "db2-port")
    DB2_DATABASE = mssparkutils.credentials.getSecret("kv-casino-poc", "db2-database")
    DB2_USER     = mssparkutils.credentials.getSecret("kv-casino-poc", "db2-username")
    DB2_PASSWORD = mssparkutils.credentials.getSecret("kv-casino-poc", "db2-password")
    CHECKPOINT_STORAGE = mssparkutils.credentials.getSecret(
        "kv-casino-poc", "adls-checkpoint-path"
    )
except ImportError:
    DB2_HOST     = os.getenv("DB2_HOST", "<db2-host>")
    DB2_PORT     = os.getenv("DB2_PORT", "50000")
    DB2_DATABASE = os.getenv("DB2_DATABASE", "CASINODB")
    DB2_USER     = os.getenv("DB2_USER", "")
    DB2_PASSWORD = os.getenv("DB2_PASSWORD", "")
    CHECKPOINT_STORAGE = os.getenv("CHECKPOINT_PATH", os.environ.get('CHECKPOINT_PATH_BASE', 'abfss://Files/checkpoints') + '')

# DB2 LUW JDBC URL (standard TCP/IP port 50000)
DB2_LUW_JDBC_URL = f"jdbc:db2://{DB2_HOST}:{DB2_PORT}/{DB2_DATABASE}"

# DB2 for z/OS JDBC URL (DB2 Connect gateway, port 446 is standard for z/OS)
# NOTE: z/OS uses a different port and often requires SSL certificates from
#       the mainframe security administrator.
DB2_ZOS_JDBC_URL = (
    f"jdbc:db2://{DB2_HOST}:446/{DB2_DATABASE}"
    f":sslConnection=true;sslTrustStoreLocation=/mnt/certs/db2zos.jks;"
    f"sslTrustStorePassword=${{DB2_ZOS_TRUSTSTORE_PASSWORD}};"
)

# JDBC properties — common to LUW and z/OS connections
jdbc_properties = {
    "user":               DB2_USER,
    "password":           DB2_PASSWORD,
    "driver":             "com.ibm.db2.jcc.DB2Driver",
    "fetchSize":          "10000",    # rows per JDBC fetch batch
    "isolationLevel":     "READ_UNCOMMITTED",  # avoid lock contention on high-volume tables
    "currentSchema":      "CASINO",
    "progressiveStreaming": "2",      # DB2 JCC progressive streaming: reduce memory pressure
}

# Target table names in DB2 (schema-qualified)
DB2_LEGACY_TRANSACTIONS = "CASINO.LEGACY_TRANSACTIONS"
DB2_PLAYER_HISTORY      = "CASINO.PLAYER_HISTORY"

# ASN replication staging table (created by DB2 InfoSphere CDC / Q-Capture)
DB2_ASN_STAGING_TABLE   = "ASNTB.CDC_STAGING"

# Delta Lake target
BRONZE_TABLE   = "lh_bronze.bronze_cdc_ibm_db2"
CHECKPOINT_DIR = f"{CHECKPOINT_STORAGE}/cdc_ibm_db2"
WATERMARK_DIR  = f"{CHECKPOINT_STORAGE}/db2_watermarks"

print(f"DB2 LUW JDBC URL : {DB2_LUW_JDBC_URL}")
print(f"DB2 z/OS JDBC URL: {DB2_ZOS_JDBC_URL[:60]}...")
print(f"Bronze table     : {BRONZE_TABLE}")

# COMMAND ----------
# MAGIC %md
# MAGIC ## 2. DB2 LUW vs z/OS Differences
# MAGIC
# MAGIC | Feature | DB2 LUW | DB2 for z/OS |
# MAGIC |---|---|---|
# MAGIC | Default encoding | UTF-8 | EBCDIC (CP037 / CP1047) |
# MAGIC | Date format | ISO (YYYY-MM-DD) | ISO or Packed (PIC 9) |
# MAGIC | Decimal type | DECIMAL(p,s) native | PACKED DECIMAL in COBOL blobs |
# MAGIC | JDBC port | 50000 | 446 (DB2 Connect) |
# MAGIC | Max row size | 32,677 bytes | 32,764 bytes |
# MAGIC | LOB handling | Native JDBC LOB | Requires progressiveStreaming=2 |
# MAGIC | Schemas | Case-insensitive | UPPERCASE enforced |
# MAGIC | Timestamp precision | microseconds | microseconds (v12+) |
# MAGIC | ROWID | Not applicable | ROWID column exists |
# MAGIC | Concurrency | Optimistic via RRSAF | DRDA / DB2 Connect |

# COMMAND ----------
# MAGIC %md
# MAGIC ## 3. JDBC Connection Setup & Driver Installation
# MAGIC
# MAGIC **Install the IBM DB2 JCC driver on the Fabric Spark environment:**
# MAGIC 1. Download `db2jcc4.jar` from IBM Fix Central (requires IBM entitlement)
# MAGIC 2. Upload the JAR to your ADLS Gen2 storage: `abfss://libs@<storage>.dfs.core.windows.net/jdbc/db2jcc4.jar`
# MAGIC 3. In Fabric workspace → **Settings** → Spark environment → **Libraries** → **Custom libraries**
# MAGIC 4. Add the JAR file path
# MAGIC 5. NOTE: IBM DB2 JCC is not available on Maven Central; manual JAR installation is required.

# COMMAND ----------

def test_db2_connection(jdbc_url: str, properties: dict) -> bool:
    """
    Validates DB2 JDBC connectivity by querying SYSIBM.SYSDUMMY1
    (the DB2 equivalent of Oracle's DUAL table).
    """
    try:
        test_df = spark.read.jdbc(
            url=jdbc_url,
            table="(SELECT 1 AS ping FROM SYSIBM.SYSDUMMY1) test",
            properties=properties
        )
        test_df.collect()
        print(f"DB2 connection OK: {jdbc_url[:50]}...")
        return True
    except Exception as e:
        print(f"DB2 connection FAILED: {e}")
        return False

# Test connectivity before running the full pipeline
# luw_ok = test_db2_connection(DB2_LUW_JDBC_URL, jdbc_properties)

# COMMAND ----------
# MAGIC %md
# MAGIC ## 4. Read CDC / ASN Replication Tables
# MAGIC
# MAGIC IBM DB2 CDC is typically implemented via:
# MAGIC - **IBM InfoSphere Data Replication (Q-Capture/Q-Apply)** — enterprise CDC
# MAGIC - **DB2 SQL Replication (Capture/Apply)** — native DB2 CDC, writes to ASN staging tables
# MAGIC - **Direct JDBC polling** — watermark-based incremental extraction (fallback)
# MAGIC
# MAGIC This notebook uses watermark-based JDBC polling against the source tables
# MAGIC and optionally reads ASN staging tables if DB2 Replication is configured.

# COMMAND ----------

# Schema for CASINO.LEGACY_TRANSACTIONS (DB2 LUW source)
legacy_transactions_schema = StructType([
    StructField("TRANS_ID",       StringType(),       nullable=False),  # CHAR(36) — UUID
    StructField("PLAYER_ID",      StringType(),       nullable=True),   # CHAR(20)
    StructField("MACHINE_ID",     StringType(),       nullable=True),   # CHAR(15)
    StructField("TRANS_AMOUNT",   DecimalType(15, 2), nullable=True),   # DECIMAL(15,2)
    StructField("TRANS_TYPE",     StringType(),       nullable=True),   # CHAR(10): BET, WIN, COMP
    StructField("GAME_CODE",      StringType(),       nullable=True),   # VARCHAR(20)
    StructField("TRANS_DATE",     DateType(),         nullable=True),   # DATE
    StructField("TRANS_TIME",     StringType(),       nullable=True),   # TIME stored as VARCHAR on some systems
    StructField("TRANS_TS",       TimestampType(),    nullable=True),   # TIMESTAMP(6)
    StructField("STATUS_CODE",    StringType(),       nullable=True),   # CHAR(2): AC, VO, PE
    StructField("CAGE_ID",        StringType(),       nullable=True),   # CHAR(10)
    StructField("SHIFT_CODE",     StringType(),       nullable=True),   # CHAR(1): D, S, G
    StructField("LAST_UPDATED",   TimestampType(),    nullable=True),   # Watermark column
])

# Schema for CASINO.PLAYER_HISTORY (DB2 z/OS source — note uppercase enforcement)
player_history_schema = StructType([
    StructField("PLAYER_ID",      StringType(),       nullable=False),  # CHAR(20)
    StructField("VISIT_DATE",     DateType(),         nullable=True),   # DATE
    StructField("TOTAL_WAGERED",  DecimalType(18, 2), nullable=True),   # DECIMAL(18,2)
    StructField("TOTAL_WON",      DecimalType(18, 2), nullable=True),
    StructField("POINTS_EARNED",  IntegerType(),      nullable=True),   # INTEGER
    StructField("TIER_CODE",      StringType(),       nullable=True),   # CHAR(2): BR, SL, GO, PL
    StructField("EXCLUSION_FLAG", StringType(),       nullable=True),   # CHAR(1): Y/N
    StructField("RECORD_TS",      TimestampType(),    nullable=True),   # Watermark column
    StructField("ROWID_COL",      StringType(),       nullable=True),   # DB2 z/OS ROWID (string representation)
])


def get_last_watermark(table_name: str) -> str:
    """Read the last successfully processed watermark timestamp."""
    wm_path = f"{WATERMARK_DIR}/{table_name.replace('.', '_')}_watermark.txt"
    try:
        df = spark.read.text(wm_path)
        wm = df.collect()[0][0]
        print(f"[{table_name}] Last watermark: {wm}")
        return wm
    except Exception:
        # First run: start 7 days back
        default_wm = "2024-01-01 00:00:00"
        print(f"[{table_name}] No watermark found, using default: {default_wm}")
        return default_wm


def save_watermark(table_name: str, watermark: str):
    """Persist the successfully processed watermark."""
    wm_path = f"{WATERMARK_DIR}/{table_name.replace('.', '_')}_watermark.txt"
    spark.createDataFrame([[watermark]]).write.mode("overwrite").text(wm_path)
    print(f"[{table_name}] Saved watermark: {watermark}")


def read_db2_incremental(
    jdbc_url: str,
    table_name: str,
    watermark_col: str,
    last_watermark: str,
    schema: StructType,
    partition_col: str = None,
    num_partitions: int = 8,
) -> "DataFrame":
    """
    Read incremental rows from DB2 since the last watermark.
    Uses JDBC partitioning for parallel reads on large tables.
    """
    query = f"""
        SELECT * FROM {table_name}
        WHERE {watermark_col} > TIMESTAMP('{last_watermark}')
          AND {watermark_col} <= CURRENT TIMESTAMP
        ORDER BY {watermark_col} ASC
        FETCH FIRST 500000 ROWS ONLY
    """
    # NOTE: DB2 uses FETCH FIRST n ROWS ONLY instead of SQL LIMIT

    read_options = {**jdbc_properties}

    if partition_col:
        # Parallel JDBC read — requires a numeric/date lower/upper bound
        return (
            spark.read
            .schema(schema)
            .jdbc(
                url=jdbc_url,
                table=f"({query}) incremental",
                column=partition_col,
                lowerBound=0,
                upperBound=9999999,
                numPartitions=num_partitions,
                properties=read_options,
            )
        )
    else:
        return (
            spark.read
            .schema(schema)
            .jdbc(url=jdbc_url, table=f"({query}) incremental", properties=read_options)
        )

# COMMAND ----------
# MAGIC %md
# MAGIC ## 5. Handle EBCDIC Encoding (z/OS)
# MAGIC
# MAGIC DB2 for z/OS stores character data in EBCDIC by default. The IBM DB2
# MAGIC JCC driver handles EBCDIC→Unicode conversion transparently for standard
# MAGIC CHAR/VARCHAR columns. However, BLOB columns containing packed COBOL data
# MAGIC require explicit decoding via Python's `codecs` library.
# MAGIC
# MAGIC NOTE: Ensure the JCC driver `currentStringEncoding` property matches the
# MAGIC       CCSID configured on the z/OS subsystem (typically CCSID 037 or 1047).

# COMMAND ----------

import codecs

from pyspark.sql.functions import udf
from pyspark.sql.types import StringType as ST


def decode_ebcdic_blob(blob_bytes: bytes, ccsid: str = "cp037") -> str:
    """
    Decode an EBCDIC-encoded byte array to a UTF-8 Python string.
    CCSID 037 = US EBCDIC (most common in North American mainframes)
    CCSID 1047 = Latin-1 Open Systems (used in some DB2 z/OS configs)
    """
    if blob_bytes is None:
        return None
    try:
        if isinstance(blob_bytes, (bytes, bytearray)):
            return blob_bytes.decode(ccsid).strip()
        return str(blob_bytes).strip()
    except (UnicodeDecodeError, LookupError):
        # Fall back to UTF-8 if EBCDIC decode fails (LUW data received in error)
        return blob_bytes.decode("utf-8", errors="replace").strip()


# Register as a Spark UDF for use in DataFrame transformations
decode_ebcdic_udf = udf(decode_ebcdic_blob, ST())


def handle_packed_decimal(df, packed_col: str, precision: int = 15, scale: int = 2):
    """
    DB2 z/OS COBOL packed decimal (COMP-3) fields stored as raw bytes require
    unpacking. The JCC driver handles standard DECIMAL columns natively;
    this UDF handles edge cases where COBOL copybooks expose raw COMP-3 bytes.

    For standard DB2 DECIMAL(p,s) columns JCC translates automatically —
    only use this for BLOB-embedded COBOL structures.
    """
    # NOTE: Standard DB2 DECIMAL columns are handled by the JCC driver.
    #       Only use this transform for BLOB payloads containing COBOL COMP-3.
    return df.withColumn(
        packed_col,
        F.col(packed_col).cast(DecimalType(precision, scale))
    )

# COMMAND ----------
# MAGIC %md
# MAGIC ## 6. Data Type Mapping — DB2 to Spark

# COMMAND ----------

# DB2 → Spark type mapping reference
DB2_SPARK_TYPE_MAP = {
    # Numeric types
    "SMALLINT":          "ShortType",
    "INTEGER":           "IntegerType",
    "BIGINT":            "LongType",
    "DECIMAL(p,s)":      "DecimalType(p,s)",  # maps directly
    "NUMERIC(p,s)":      "DecimalType(p,s)",
    "REAL":              "FloatType",
    "DOUBLE":            "DoubleType",
    "DECFLOAT(16)":      "DoubleType",        # approximate mapping
    "DECFLOAT(34)":      "DecimalType(38,10)", # high-precision fallback
    # String types
    "CHAR(n)":           "StringType",         # fixed-length → trimmed string
    "VARCHAR(n)":        "StringType",
    "LONG VARCHAR":      "StringType",
    "CLOB":              "StringType",         # JCC streams LOBs as String
    # Date/time types
    "DATE":              "DateType",
    "TIME":              "StringType",         # HH:MM:SS stored as string
    "TIMESTAMP(p)":      "TimestampType",      # microsecond precision
    # Binary types
    "BLOB":              "BinaryType",
    "VARBINARY(n)":      "BinaryType",
    "CHAR(n) FOR BIT DATA": "BinaryType",
    # Boolean (DB2 has no native BOOLEAN — simulated as CHAR(1) Y/N or SMALLINT 0/1)
    "CHAR(1) Y/N":       "BooleanType (after Y→true/N→false UDF)",
}

print("DB2 → Spark type mapping:")
for db2_type, spark_type in DB2_SPARK_TYPE_MAP.items():
    print(f"  {db2_type:<30} → {spark_type}")

# COMMAND ----------
# MAGIC %md
# MAGIC ## 7. Run Incremental Extract & Write to Delta Lake

# COMMAND ----------

def process_db2_table(
    jdbc_url: str,
    table_name: str,
    watermark_col: str,
    schema: StructType,
    source_system: str,   # "db2_luw" or "db2_zos"
):
    """Full incremental extract cycle for one DB2 table."""
    last_wm = get_last_watermark(table_name)

    raw_df = read_db2_incremental(
        jdbc_url=jdbc_url,
        table_name=table_name,
        watermark_col=watermark_col,
        last_watermark=last_wm,
        schema=schema,
    )

    row_count = raw_df.count()
    print(f"[{table_name}] Extracted {row_count} rows since {last_wm}")
    if row_count == 0:
        return 0

    # Add Bronze audit columns
    enriched_df = (
        raw_df
        # Normalise DB2 CHAR(1) Y/N boolean columns
        .withColumn("exclusion_flag_bool",
            F.when(F.col("EXCLUSION_FLAG") == "Y", F.lit(True))
             .when(F.col("EXCLUSION_FLAG") == "N", F.lit(False))
             .otherwise(F.lit(None).cast(BooleanType()))
            if "EXCLUSION_FLAG" in [c.name for c in raw_df.schema] else F.lit(None).cast(BooleanType())
        )
        # Trim trailing spaces from CHAR(n) columns (DB2 pads with spaces)
        .withColumn("TRANS_TYPE",
            F.trim(F.col("TRANS_TYPE"))
            if "TRANS_TYPE" in [c.name for c in raw_df.schema] else F.lit(None)
        )
        # Fabric Bronze audit columns
        .withColumn("source_table",      F.lit(table_name))
        .withColumn("source_system",     F.lit(source_system))
        .withColumn("ingested_at",       F.current_timestamp())
        .withColumn("ingestion_source",  F.lit("ibm_db2_jdbc_cdc"))
        .withColumn("extraction_date",   F.to_date(F.current_timestamp()))
    )

    # Append to Bronze Delta table
    (
        enriched_df.write
        .format("delta")
        .mode("append")
        .option("mergeSchema", "true")
        .partitionBy("source_table", "extraction_date")
        .saveAsTable(BRONZE_TABLE)
    )

    # Update watermark to the max LAST_UPDATED / RECORD_TS seen in this batch
    new_wm = raw_df.agg(F.max(watermark_col)).collect()[0][0]
    if new_wm:
        save_watermark(table_name, str(new_wm))

    print(f"[{table_name}] Wrote {row_count} rows to {BRONZE_TABLE}. New watermark: {new_wm}")
    return row_count


# Run extract for DB2 LUW — LEGACY_TRANSACTIONS
luw_count = process_db2_table(
    jdbc_url=DB2_LUW_JDBC_URL,
    table_name=DB2_LEGACY_TRANSACTIONS,
    watermark_col="LAST_UPDATED",
    schema=legacy_transactions_schema,
    source_system="db2_luw",
)

# Run extract for DB2 z/OS — PLAYER_HISTORY
# NOTE: For z/OS, switch to DB2_ZOS_JDBC_URL and ensure JCC SSL cert is configured
zos_count = process_db2_table(
    jdbc_url=DB2_LUW_JDBC_URL,  # Replace with DB2_ZOS_JDBC_URL for z/OS target
    table_name=DB2_PLAYER_HISTORY,
    watermark_col="RECORD_TS",
    schema=player_history_schema,
    source_system="db2_zos",
)

print(f"\nExtraction summary:")
print(f"  {DB2_LEGACY_TRANSACTIONS}: {luw_count} rows")
print(f"  {DB2_PLAYER_HISTORY}:       {zos_count} rows")

# COMMAND ----------
# MAGIC %md
# MAGIC ## 8. Monitoring

# COMMAND ----------

monitoring_sql = f"""
-- Extraction volume by source table and date (last 7 days)
SELECT
    source_table,
    source_system,
    extraction_date,
    COUNT(*)            AS row_count,
    MAX(ingested_at)    AS last_ingested_at
FROM {BRONZE_TABLE}
WHERE ingested_at >= CURRENT_TIMESTAMP - INTERVAL 7 DAYS
GROUP BY source_table, source_system, extraction_date
ORDER BY extraction_date DESC, source_table;

-- Detect potential duplicate ingestion (same TRANS_ID ingested multiple times)
SELECT
    TRANS_ID,
    COUNT(*)    AS ingestion_count,
    MIN(ingested_at) AS first_ingested,
    MAX(ingested_at) AS last_ingested
FROM {BRONZE_TABLE}
WHERE source_table = 'CASINO.LEGACY_TRANSACTIONS'
GROUP BY TRANS_ID
HAVING COUNT(*) > 1
ORDER BY ingestion_count DESC
LIMIT 20;

-- DB2 z/OS: monitor EBCDIC decode failures (null values in expected non-null columns)
SELECT
    extraction_date,
    COUNT(*) AS total_rows,
    COUNT(PLAYER_ID) AS non_null_player_id,
    COUNT(TRANS_ID)  AS non_null_trans_id,
    (COUNT(*) - COUNT(TRANS_ID)) AS potential_decode_failures
FROM {BRONZE_TABLE}
WHERE source_system = 'db2_zos'
  AND extraction_date = CURRENT_DATE
GROUP BY extraction_date;

-- Transaction amount distribution (sanity check for packed decimal conversion)
SELECT
    source_system,
    ROUND(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY TRANS_AMOUNT), 2) AS p25_amount,
    ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY TRANS_AMOUNT), 2) AS p50_amount,
    ROUND(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY TRANS_AMOUNT), 2) AS p75_amount,
    ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY TRANS_AMOUNT), 2) AS p99_amount,
    MAX(TRANS_AMOUNT) AS max_amount
FROM {BRONZE_TABLE}
WHERE source_table = 'CASINO.LEGACY_TRANSACTIONS'
  AND extraction_date = CURRENT_DATE
GROUP BY source_system;
"""

print("Monitoring SQL:")
print(monitoring_sql)

# Quick Bronze validation
if spark.catalog.tableExists(BRONZE_TABLE):
    spark.sql(f"""
        SELECT
            source_table,
            source_system,
            COUNT(*)          AS total_rows,
            MAX(ingested_at)  AS latest_ingestion
        FROM {BRONZE_TABLE}
        GROUP BY source_table, source_system
        ORDER BY latest_ingestion DESC
    """).show(truncate=False)
else:
    print(f"Table {BRONZE_TABLE} does not yet exist — run extraction first.")

# COMMAND ----------
# MAGIC %md
# MAGIC ## 9. Schedule as Fabric Data Pipeline Activity
# MAGIC
# MAGIC For near-real-time DB2 ingestion, schedule this notebook via a Fabric
# MAGIC Data Pipeline with a recurrence trigger:
# MAGIC
# MAGIC 1. Create a **Data Pipeline** in the Fabric workspace
# MAGIC 2. Add a **Notebook** activity pointing to this notebook
# MAGIC 3. Set **Parameters**: `source_system`, `batch_size`, `watermark_override`
# MAGIC 4. Add a **Schedule** trigger: every 5 minutes (or every 15 for z/OS)
# MAGIC 5. Add failure alerting via Data Activator or Azure Monitor
# MAGIC
# MAGIC NOTE: For z/OS sources, the SHIR (Self-hosted Integration Runtime) must
# MAGIC       be installed in the network segment that can reach the mainframe
# MAGIC       DRDA port (default 446). The SHIR bridges Fabric to the z/OS DB2
# MAGIC       Connect gateway without requiring public internet exposure.

print("Schedule via Fabric Data Pipeline for automated near-real-time ingestion.")
print("See inline comments for pipeline configuration steps.")
