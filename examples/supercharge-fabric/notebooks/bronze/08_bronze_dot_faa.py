# Databricks notebook source
# MAGIC %md
# MAGIC # Bronze Layer: DOT/FAA Transportation Data Ingestion
# MAGIC
# MAGIC This notebook ingests raw DOT/FAA transportation data into the Bronze layer.
# MAGIC Multi-domain ingestion covering flight operations, safety incidents,
# MAGIC traffic statistics, and airport infrastructure.
# MAGIC
# MAGIC ## Data Sources
# MAGIC - **Type:** CSV, Parquet, and API response files
# MAGIC - **Location:** Files/landing/dot_faa/
# MAGIC - **Domains:** Flight Operations, Safety Incidents, Traffic Statistics, Infrastructure
# MAGIC
# MAGIC ## Targets
# MAGIC - **bronze_dot_flight_ops** - Flight operation records
# MAGIC - **bronze_dot_safety** - Safety incident reports
# MAGIC - **bronze_dot_traffic_stats** - Airport traffic statistics
# MAGIC - **Format:** Delta Lake (Append)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from datetime import datetime

from pyspark.sql import SparkSession
from pyspark.sql.functions import (
    coalesce,
    col,
    current_timestamp,
    input_file_name,
    lit,
    to_timestamp,
    trim,
    upper,
    when,
)
from pyspark.sql.types import (
    BooleanType,
    DoubleType,
    IntegerType,
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Configuration
LANDING_BASE_PATH = "Files/landing/dot_faa"
SOURCE_PATHS = {
    "flight_operations": f"{LANDING_BASE_PATH}/flight_operations/",
    "safety_incidents": f"{LANDING_BASE_PATH}/safety_incidents/",
    "traffic_statistics": f"{LANDING_BASE_PATH}/traffic_statistics/",
    "infrastructure": f"{LANDING_BASE_PATH}/infrastructure/"
}

TARGET_TABLES = {
    "flight_operations": "bronze_dot_flight_ops",
    "safety_incidents": "bronze_dot_safety",
    "traffic_statistics": "bronze_dot_traffic_stats",
}

BATCH_ID = datetime.now().strftime("%Y%m%d_%H%M%S")

print(f"Batch ID: {BATCH_ID}")
print(f"Landing Base: {LANDING_BASE_PATH}")
for domain, path in SOURCE_PATHS.items():
    print(f"  {domain}: {path}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define Schemas
# MAGIC
# MAGIC Explicit schemas for each DOT/FAA domain to enforce structure at ingestion.

# COMMAND ----------

# Flight Operations schema
flight_ops_schema = StructType([
    StructField("flight_id", StringType(), False),
    StructField("flight_number", StringType(), False),
    StructField("carrier_code", StringType(), False),
    StructField("carrier_name", StringType(), True),
    StructField("origin_airport", StringType(), False),
    StructField("destination_airport", StringType(), False),
    StructField("scheduled_departure", TimestampType(), True),
    StructField("actual_departure", TimestampType(), True),
    StructField("scheduled_arrival", TimestampType(), True),
    StructField("actual_arrival", TimestampType(), True),
    StructField("departure_delay_minutes", IntegerType(), True),
    StructField("arrival_delay_minutes", IntegerType(), True),
    StructField("delay_cause", StringType(), True),
    StructField("cancelled", BooleanType(), True),
    StructField("cancellation_code", StringType(), True),
    StructField("diverted", BooleanType(), True),
    StructField("aircraft_type", StringType(), True),
    StructField("tail_number", StringType(), True),
    StructField("distance_miles", IntegerType(), True),
    StructField("air_time_minutes", IntegerType(), True),
    StructField("taxi_out_minutes", IntegerType(), True),
    StructField("taxi_in_minutes", IntegerType(), True),
    StructField("faa_region", StringType(), True),
    StructField("flight_date", StringType(), True),
])

# COMMAND ----------

# Safety Incidents schema
safety_schema = StructType([
    StructField("incident_id", StringType(), False),
    StructField("incident_date", StringType(), False),
    StructField("incident_type", StringType(), False),
    StructField("severity", StringType(), True),
    StructField("airport_code", StringType(), True),
    StructField("flight_number", StringType(), True),
    StructField("carrier_code", StringType(), True),
    StructField("aircraft_type", StringType(), True),
    StructField("phase_of_flight", StringType(), True),
    StructField("injury_count", IntegerType(), True),
    StructField("fatality_count", IntegerType(), True),
    StructField("damage_level", StringType(), True),
    StructField("weather_condition", StringType(), True),
    StructField("description", StringType(), True),
    StructField("investigation_status", StringType(), True),
    StructField("faa_region", StringType(), True),
    StructField("latitude", DoubleType(), True),
    StructField("longitude", DoubleType(), True),
])

# COMMAND ----------

# Traffic Statistics schema
traffic_schema = StructType([
    StructField("record_id", StringType(), False),
    StructField("airport_code", StringType(), False),
    StructField("airport_name", StringType(), True),
    StructField("report_month", StringType(), False),
    StructField("domestic_departures", IntegerType(), True),
    StructField("international_departures", IntegerType(), True),
    StructField("domestic_arrivals", IntegerType(), True),
    StructField("international_arrivals", IntegerType(), True),
    StructField("total_passengers", LongType(), True),
    StructField("total_cargo_tons", DoubleType(), True),
    StructField("total_mail_tons", DoubleType(), True),
    StructField("faa_region", StringType(), True),
    StructField("airport_category", StringType(), True),
    StructField("state_code", StringType(), True),
    StructField("city", StringType(), True),
])

# COMMAND ----------

# MAGIC %md
# MAGIC ## Ingestion Helper Function

# COMMAND ----------

def ingest_domain(domain_name, source_path, schema, target_table):
    """Ingest a single DOT/FAA domain into its Bronze Delta table."""
    print(f"\n{'='*60}")
    print(f"Ingesting domain: {domain_name}")
    print(f"  Source: {source_path}")
    print(f"  Target: {target_table}")
    print(f"{'='*60}")

    try:
        # Attempt Parquet first, fall back to CSV
        try:
            df_raw = spark.read.schema(schema).parquet(source_path)
            file_format = "parquet"
        except Exception:
            df_raw = spark.read \
                .schema(schema) \
                .option("header", "true") \
                .option("inferSchema", "false") \
                .csv(source_path)
            file_format = "csv"

        record_count = df_raw.count()
        print(f"  Format: {file_format}")
        print(f"  Records read: {record_count:,}")

        if record_count == 0:
            print(f"  WARN: No records found for {domain_name}. Skipping.")
            return 0

        # Add Bronze ingestion metadata
        df_bronze = df_raw \
            .withColumn("_ingested_at", current_timestamp()) \
            .withColumn("_source_file", input_file_name()) \
            .withColumn("_batch_id", lit(BATCH_ID)) \
            .withColumn("_domain", lit(domain_name)) \
            .withColumn("_load_date", current_timestamp().cast("date"))

        # Write to Delta table
        df_bronze.write \
            .format("delta") \
            .mode("append") \
            .option("mergeSchema", "true") \
            .partitionBy("_load_date") \
            .saveAsTable(target_table)

        final_count = spark.table(target_table).count()
        print(f"  Written: {final_count:,} records to {target_table}")
        return final_count

    except Exception as e:
        print(f"  ERROR ingesting {domain_name}: {e!s}")
        return -1

# COMMAND ----------

# MAGIC %md
# MAGIC ## Execute Multi-Domain Ingestion

# COMMAND ----------

# Track ingestion results
ingestion_results = {}

# Ingest Flight Operations
ingestion_results["flight_operations"] = ingest_domain(
    domain_name="flight_operations",
    source_path=SOURCE_PATHS["flight_operations"],
    schema=flight_ops_schema,
    target_table=TARGET_TABLES["flight_operations"]
)

# COMMAND ----------

# Ingest Safety Incidents
ingestion_results["safety_incidents"] = ingest_domain(
    domain_name="safety_incidents",
    source_path=SOURCE_PATHS["safety_incidents"],
    schema=safety_schema,
    target_table=TARGET_TABLES["safety_incidents"]
)

# COMMAND ----------

# Ingest Traffic Statistics
ingestion_results["traffic_statistics"] = ingest_domain(
    domain_name="traffic_statistics",
    source_path=SOURCE_PATHS["traffic_statistics"],
    schema=traffic_schema,
    target_table=TARGET_TABLES["traffic_statistics"]
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Row Count Validation

# COMMAND ----------

print("\n" + "="*60)
print("DOT/FAA Bronze Ingestion Summary")
print("="*60)
print(f"Batch ID: {BATCH_ID}")
print(f"Timestamp: {datetime.now().isoformat()}")
print("-"*60)

total_records = 0
for domain, count in ingestion_results.items():
    status = "OK" if count > 0 else ("EMPTY" if count == 0 else "FAILED")
    count_str = f"{count:,}" if count >= 0 else "ERROR"
    print(f"  {domain:30s} | {count_str:>12s} records | {status}")
    if count > 0:
        total_records += count

print("-"*60)
print(f"  {'TOTAL':30s} | {total_records:>12,} records")
print("="*60)

# Validate minimum record counts
MIN_EXPECTED = {
    "flight_operations": 100,
    "safety_incidents": 10,
    "traffic_statistics": 50,
}

print("\nValidation Checks:")
for domain, min_count in MIN_EXPECTED.items():
    actual = ingestion_results.get(domain, 0)
    passed = actual >= min_count
    status = "PASS" if passed else "WARN"
    print(f"  {domain}: expected >= {min_count}, got {actual} [{status}]")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Verify Delta Tables

# COMMAND ----------

for table_name in TARGET_TABLES.values():
    try:
        df_verify = spark.table(table_name)
        print(f"\nTable: {table_name}")
        print(f"  Total rows: {df_verify.count():,}")
        print(f"  Partitions: {df_verify.select('_load_date').distinct().count()}")
        print(f"  Batches: {df_verify.select('_batch_id').distinct().count()}")
    except Exception as e:
        print(f"\nTable: {table_name} - NOT FOUND: {e}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Sample Data Preview

# COMMAND ----------

# Preview flight operations
print("Flight Operations Sample:")
display(
    spark.table(TARGET_TABLES["flight_operations"])
    .select(
        "flight_number", "carrier_code", "origin_airport",
        "destination_airport", "departure_delay_minutes",
        "flight_date", "_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# Preview safety incidents
print("Safety Incidents Sample:")
display(
    spark.table(TARGET_TABLES["safety_incidents"])
    .select(
        "incident_id", "incident_date", "incident_type",
        "severity", "airport_code", "_ingested_at"
    ).limit(10)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Domain | Target Table | Format | Partitioned By |
# MAGIC |--------|-------------|--------|----------------|
# MAGIC | Flight Operations | bronze_dot_flight_ops | Delta Lake | _load_date |
# MAGIC | Safety Incidents | bronze_dot_safety | Delta Lake | _load_date |
# MAGIC | Traffic Statistics | bronze_dot_traffic_stats | Delta Lake | _load_date |
# MAGIC
# MAGIC **Next Step:** Continue to Silver layer transformation (`08_silver_dot_faa`).
