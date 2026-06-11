# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: Table Games Ingestion
# MAGIC
# MAGIC This notebook ingests table games data (blackjack, craps, roulette, baccarat, poker).
# MAGIC
# MAGIC ## Data Source
# MAGIC - **Type:** Parquet files
# MAGIC - **Location:** Files/landing/table_games/
# MAGIC - **Schema:** Table management system / RFID chip tracking exports
# MAGIC - **Update Frequency:** Near real-time / hourly batches
# MAGIC
# MAGIC ## Target
# MAGIC - **Table:** bronze_table_games
# MAGIC - **Format:** Delta Lake
# MAGIC - **Mode:** Append
# MAGIC
# MAGIC ## Key Features
# MAGIC - RFID chip tracking data
# MAGIC - Game-specific event types (14 distinct event types)
# MAGIC - Dealer and pit information
# MAGIC - Append-only pattern with date + game_type partitioning
# MAGIC - Game category classification (CARDS / DICE / WHEEL)

# COMMAND ----------

# ---------------------------------------------------------------------------
# Fabric/local compatibility shim
# ---------------------------------------------------------------------------
import os

try:
    import notebookutils  # Fabric runtime
    def _get_arg(name, default=None):
        try:
            return notebookutils.notebook.getArgument(name, default)
        except Exception:
            return os.environ.get(name.upper(), default)
    def _notebook_exit(status: str) -> None:
        notebookutils.notebook.exit(status)
except ImportError:
    try:
        import mssparkutils  # legacy Synapse/Fabric runtime
        def _get_arg(name, default=None):
            try:
                return mssparkutils.notebook.getArgument(name, default)
            except Exception:
                return os.environ.get(name.upper(), default)
        def _notebook_exit(status: str) -> None:
            mssparkutils.notebook.exit(status)
    except ImportError:
        def _get_arg(name, default=None):
            return os.environ.get(name.upper(), default)
        def _notebook_exit(status: str) -> None:
            raise SystemExit(status)


# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from datetime import datetime

from pyspark.sql import SparkSession
from pyspark.sql.functions import avg as _avg
from pyspark.sql.functions import (
    coalesce,
    col,
    current_timestamp,
    hour,
    input_file_name,
    lit,
    to_date,
    when,
)
from pyspark.sql.functions import count as _count
from pyspark.sql.functions import sum as _sum
from pyspark.sql.types import (
    DecimalType,
    IntegerType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Configuration
SOURCE_PATH = "Files/output/bronze_table_games.parquet"
TARGET_TABLE = "lh_bronze.bronze_table_games"
SCHEMA_VERSION = "1.0"
BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

# Valid enum values from schema
VALID_GAME_TYPES = ["BLACKJACK", "CRAPS", "ROULETTE", "BACCARAT", "POKER"]
VALID_EVENT_TYPES = [
    "GAME_START", "GAME_END", "BET_PLACED", "HAND_COMPLETE",
    "WIN", "LOSS", "PUSH", "SURRENDER", "DEALER_CHANGE",
    "TABLE_OPEN", "TABLE_CLOSE", "MARKER_ISSUED",
    "CHIP_FILL", "CHIP_CREDIT"
]
VALID_OUTCOMES = ["WIN", "LOSS", "PUSH", "BLACKJACK", "BUST", "SURRENDER"]

print(f"Source: {SOURCE_PATH}")
print(f"Target: {TARGET_TABLE}")
print(f"Schema Version: {SCHEMA_VERSION}")
print(f"Batch ID: {BATCH_ID}")
print(f"Valid Game Types: {VALID_GAME_TYPES}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Schema
# MAGIC
# MAGIC Explicit schema matching `data_generation/schemas/table_games_schema.json`.
# MAGIC Includes all fields from the JSON schema for validation and performance.

# COMMAND ----------

table_games_schema = StructType([
    StructField("event_id", StringType(), False),
    StructField("table_id", StringType(), False),
    StructField("game_type", StringType(), False),
    StructField("event_type", StringType(), False),
    StructField("event_timestamp", TimestampType(), False),
    StructField("player_id", StringType(), True),
    StructField("dealer_id", StringType(), True),
    StructField("pit_id", StringType(), True),
    StructField("bet_amount", DecimalType(18, 2), True),
    StructField("win_amount", DecimalType(18, 2), True),
    StructField("chip_count", IntegerType(), True),
    StructField("hand_number", IntegerType(), True),
    StructField("cards_dealt", StringType(), True),
    StructField("outcome", StringType(), True),
    StructField("session_id", StringType(), True),
    StructField("seat_position", IntegerType(), True),
    StructField("game_specific", StringType(), True),
    StructField("_ingested_at", StringType(), True),
    StructField("_source", StringType(), True),
    StructField("_batch_id", StringType(), True),
])

print(f"Schema defined with {len(table_games_schema.fields)} fields")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Source Data

# COMMAND ----------

# Read parquet file with error handling for missing source
try:
    df_raw = spark.read.parquet(SOURCE_PATH)

    # Display statistics
    record_count = df_raw.count()
    column_count = len(df_raw.columns)

    print(f"Source Statistics:")
    print(f"  Records: {record_count:,}")
    print(f"  Columns: {column_count}")

    # Show schema
    df_raw.printSchema()

except Exception as e:
    print(f"ERROR: Failed to read source data from {SOURCE_PATH}")
    print(f"  Exception: {e!s}")
    print(f"  Verify the source file exists and is accessible.")
    _notebook_exit(f"FAILED: Source read error - {e!s}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Schema Enforcement
# MAGIC
# MAGIC Apply the explicit StructType schema to enforce data types and catch mismatches.

# COMMAND ----------

# Apply schema enforcement
schema_fields = [f.name for f in table_games_schema.fields if f.name not in ("_ingested_at", "_source", "_batch_id")]
source_columns = df_raw.columns

# Identify missing and extra columns
missing_cols = [f for f in schema_fields if f not in source_columns]
extra_cols = [c for c in source_columns if c not in [f.name for f in table_games_schema.fields]]

print("Schema Enforcement Report:")
print(f"  Expected fields: {len(schema_fields)}")
print(f"  Source columns: {len(source_columns)}")
if missing_cols:
    print(f"  Missing columns (will be null): {missing_cols}")
if extra_cols:
    print(f"  Extra columns (will be preserved): {extra_cols}")

# Add missing columns as null
df_enforced = df_raw
for missing in missing_cols:
    field = [f for f in table_games_schema.fields if f.name == missing][0]
    df_enforced = df_enforced.withColumn(missing, lit(None).cast(field.dataType))

print("Schema enforcement applied successfully.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Checks (Bronze)
# MAGIC
# MAGIC Validate critical fields, enum values, amount ranges, and game-specific integrity.

# COMMAND ----------

# Check for null critical fields (required per schema)
critical_fields = ["event_id", "table_id", "game_type", "event_type", "event_timestamp"]

print("=" * 60)
print("DATA QUALITY CHECKS - Table Games")
print("=" * 60)

print("\n1. Critical Field Null Check:")
quality_issues = 0
for field in critical_fields:
    if field in df_enforced.columns:
        null_count = df_enforced.filter(col(field).isNull()).count()
        status = "PASS" if null_count == 0 else f"WARN: {null_count} nulls"
        if null_count > 0:
            quality_issues += 1
        print(f"  {field}: {status}")
    else:
        print(f"  {field}: MISSING FROM SOURCE")
        quality_issues += 1

# Check game_type enum validation
print("\n2. Game Type Enum Validation:")
if "game_type" in df_enforced.columns:
    invalid_games = df_enforced.filter(
        ~col("game_type").isin(VALID_GAME_TYPES) & col("game_type").isNotNull()
    ).count()
    print(f"  Valid types: {VALID_GAME_TYPES}")
    print(f"  Invalid game_type values: {invalid_games}")
    if invalid_games > 0:
        quality_issues += 1

# Check event_type enum validation
print("\n3. Event Type Enum Validation:")
if "event_type" in df_enforced.columns:
    invalid_events = df_enforced.filter(
        ~col("event_type").isin(VALID_EVENT_TYPES) & col("event_type").isNotNull()
    ).count()
    print(f"  Valid event types: {VALID_EVENT_TYPES}")
    print(f"  Invalid event_type values: {invalid_events}")
    if invalid_events > 0:
        quality_issues += 1

# Check outcome enum validation
print("\n4. Outcome Enum Validation:")
if "outcome" in df_enforced.columns:
    invalid_outcomes = df_enforced.filter(
        ~col("outcome").isin(VALID_OUTCOMES) & col("outcome").isNotNull()
    ).count()
    print(f"  Valid outcomes: {VALID_OUTCOMES}")
    print(f"  Invalid outcome values: {invalid_outcomes}")
    if invalid_outcomes > 0:
        quality_issues += 1

# Check bet_amount range validation (must be >= 0)
print("\n5. Bet Amount Range Validation:")
if "bet_amount" in df_enforced.columns:
    negative_bets = df_enforced.filter(col("bet_amount") < 0).count()
    print(f"  Negative bet amounts: {negative_bets}")
    if negative_bets > 0:
        quality_issues += 1

# Check win_amount range validation (must be >= 0)
print("\n6. Win Amount Range Validation:")
if "win_amount" in df_enforced.columns:
    negative_wins = df_enforced.filter(col("win_amount") < 0).count()
    print(f"  Negative win amounts: {negative_wins}")
    if negative_wins > 0:
        quality_issues += 1

# Check seat_position range (1-8 per schema)
print("\n7. Seat Position Range Validation:")
if "seat_position" in df_enforced.columns:
    invalid_seats = df_enforced.filter(
        ((col("seat_position") < 1) | (col("seat_position") > 8))
        & col("seat_position").isNotNull()
    ).count()
    print(f"  Expected range: 1-8")
    print(f"  Out-of-range seat positions: {invalid_seats}")

# Check table_id format (should match ^TBL-[A-Z]{2}-[0-9]{3}$)
print("\n8. Table ID Format Validation:")
if "table_id" in df_enforced.columns:
    invalid_table_ids = df_enforced.filter(
        ~col("table_id").rlike("^TBL-[A-Z]{2}-[0-9]{3}$") & col("table_id").isNotNull()
    ).count()
    print(f"  Expected pattern: ^TBL-[A-Z]{{2}}-[0-9]{{3}}$")
    print(f"  Invalid table_id values: {invalid_table_ids}")

# Check for duplicate event_ids
print("\n9. Duplicate Check:")
if "event_id" in df_enforced.columns:
    total = df_enforced.count()
    distinct = df_enforced.select("event_id").distinct().count()
    dupes = total - distinct
    print(f"  Total records: {total:,}")
    print(f"  Distinct event_ids: {distinct:,}")
    print(f"  Duplicates: {dupes:,}")
    if dupes > 0:
        quality_issues += 1

print(f"\nTotal quality issues: {quality_issues}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Derived Columns and Bronze Metadata

# COMMAND ----------

# Add ingestion metadata and derived columns
df_bronze = df_enforced \
    .withColumn("event_date", to_date("event_timestamp")) \
    .withColumn("event_hour", hour("event_timestamp")) \
    .withColumn("game_category",
        when(col("game_type").isin("BLACKJACK", "BACCARAT", "POKER"), "CARDS")
        .when(col("game_type") == "CRAPS", "DICE")
        .when(col("game_type") == "ROULETTE", "WHEEL")
        .otherwise("OTHER")) \
    .withColumn("is_player_event",
        col("event_type").isin("BET_PLACED", "WIN", "LOSS", "PUSH", "SURRENDER")) \
    .withColumn("net_result",
        coalesce(col("win_amount"), lit(0)) - coalesce(col("bet_amount"), lit(0))) \
    .withColumn("is_high_value",
        coalesce(col("bet_amount"), lit(0)) >= 1000) \
    .withColumn("_bronze_ingested_at", current_timestamp()) \
    .withColumn("_bronze_source_file", input_file_name()) \
    .withColumn("_bronze_batch_id", lit(BATCH_ID)) \
    .withColumn("_bronze_load_date", current_timestamp().cast("date")) \
    .withColumn("_bronze_schema_version", lit(SCHEMA_VERSION))

print("Added derived columns and Bronze metadata:")
print("  - event_date, event_hour (temporal)")
print("  - game_category (CARDS / DICE / WHEEL)")
print("  - is_player_event (betting/outcome events)")
print("  - net_result (win_amount - bet_amount)")
print("  - is_high_value (bet >= $1,000)")
print("  - _bronze_ingested_at")
print("  - _bronze_source_file")
print("  - _bronze_batch_id")
print("  - _bronze_load_date")
print("  - _bronze_schema_version")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Delta Table

# COMMAND ----------

# Write to Bronze with date and game_type partitioning
df_bronze.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .partitionBy("event_date", "game_type") \
    .saveAsTable(TARGET_TABLE)

print(f"Successfully wrote {spark.table(TARGET_TABLE).count():,} records to {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Verify Ingestion

# COMMAND ----------

# Read back and verify
df_verify = spark.table(TARGET_TABLE)

print(f"\nTable Verification:")
print(f"  Total records: {df_verify.count():,}")
print(f"  Date partitions: {df_verify.select('event_date').distinct().count()}")
print(f"  Game type partitions: {df_verify.select('game_type').distinct().count()}")

# Sample data
print(f"\nSample Records:")
display(
    df_verify.select(
        "event_id", "table_id", "game_type", "event_type",
        "event_timestamp", "bet_amount", "win_amount", "net_result",
        "_bronze_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Table Statistics

# COMMAND ----------

# Summary by game type
print("Game Type Summary:")
display(
    df_verify
    .groupBy("game_type", "game_category")
    .agg(
        _count("*").alias("event_count"),
        _count(col("player_id")).alias("player_events"),
        _sum("bet_amount").alias("total_bets"),
        _sum("win_amount").alias("total_wins")
    )
    .orderBy("game_type")
)

# COMMAND ----------

# Event type distribution
print("Event Type Distribution:")
display(
    df_verify
    .groupBy("event_type")
    .agg(
        _count("*").alias("count"),
    )
    .orderBy(col("count").desc())
)

# COMMAND ----------

# Table activity summary
print("Table Activity (Top 20 by event count):")
display(
    df_verify
    .groupBy("table_id", "game_type")
    .agg(
        _count("*").alias("event_count"),
        _count(col("player_id")).alias("unique_interactions"),
        _sum("bet_amount").alias("total_bets"),
        _sum("win_amount").alias("total_wins")
    )
    .orderBy(col("event_count").desc())
    .limit(20)
)

# COMMAND ----------

# High-value event report
print("High-Value Events (bet >= $1,000):")
display(
    df_verify
    .filter(col("is_high_value") == True)
    .groupBy("game_type", "event_type")
    .agg(
        _count("*").alias("count"),
        _sum("bet_amount").alias("total_bet_amount"),
        _sum("win_amount").alias("total_win_amount")
    )
    .orderBy(col("total_bet_amount").desc())
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Delta Table History

# COMMAND ----------

from delta.tables import DeltaTable

delta_table = DeltaTable.forName(spark, TARGET_TABLE)

print("Table History:")
display(
    delta_table.history(5)
    .select("version", "timestamp", "operation", "operationMetrics")
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Metric | Value |
# MAGIC |--------|-------|
# MAGIC | Source | Parquet files |
# MAGIC | Target | bronze_table_games |
# MAGIC | Load Pattern | Append |
# MAGIC | Format | Delta Lake |
# MAGIC | Partitioned By | event_date, game_type |
# MAGIC | Game Types | BLACKJACK, CRAPS, ROULETTE, BACCARAT, POKER |
# MAGIC | Schema Version | 1.0 |
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer for game result validation and player session analysis.
