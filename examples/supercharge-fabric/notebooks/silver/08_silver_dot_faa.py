# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: DOT/FAA Data Quality & Enrichment
# MAGIC
# MAGIC This notebook transforms Bronze DOT/FAA data into cleansed, validated,
# MAGIC and enriched Silver layer tables.
# MAGIC
# MAGIC ## Transformations Applied:
# MAGIC - IATA/ICAO airport code validation
# MAGIC - Delay categorization (on-time, delayed, severely delayed)
# MAGIC - Carrier name standardization
# MAGIC - Cross-source correlation (flights to safety incidents)
# MAGIC - On-time performance rate calculation per carrier
# MAGIC - FAA region enrichment
# MAGIC - Data quality scoring

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

from delta.tables import DeltaTable
from pyspark.sql.functions import (
    array,
    array_compact,
    coalesce,
    col,
    concat,
    count,
    current_date,
    current_timestamp,
    desc,
    filter,
    lit,
    max,
    min,
    round,
    sum,
    to_date,
    trim,
    upper,
    when,
    window,
)
from pyspark.sql.types import IntegerType

# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source tables (Bronze)
SOURCE_FLIGHT_OPS = "lh_bronze.bronze_dot_flight_ops"
SOURCE_SAFETY = "lh_bronze.bronze_dot_safety"
SOURCE_TRAFFIC = "lh_bronze.bronze_dot_traffic_stats"

# Target tables (Silver)
TARGET_FLIGHT_PERF = "lh_silver.silver_dot_flight_performance"
TARGET_SAFETY = "lh_silver.silver_dot_safety_enriched"

print(f"Processing batch: {batch_id}")
print(f"Sources: {SOURCE_FLIGHT_OPS}, {SOURCE_SAFETY}, {SOURCE_TRAFFIC}")
print(f"Targets: {TARGET_FLIGHT_PERF}, {TARGET_SAFETY}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Reference Data: Valid Codes & Mappings

# COMMAND ----------

# Major US carrier code to name standardization
CARRIER_MAPPING = {
    "AA": "American Airlines", "DL": "Delta Air Lines",
    "UA": "United Airlines", "WN": "Southwest Airlines",
    "B6": "JetBlue Airways", "AS": "Alaska Airlines",
    "NK": "Spirit Airlines", "F9": "Frontier Airlines",
    "G4": "Allegiant Air", "HA": "Hawaiian Airlines",
    "SY": "Sun Country Airlines", "MX": "Breeze Airways",
}

# FAA regions
FAA_REGIONS = {
    "AAL": "Alaskan", "ACE": "Central", "AEA": "Eastern",
    "AGL": "Great Lakes", "ANE": "New England", "ANM": "Northwest Mountain",
    "ASO": "Southern", "ASW": "Southwest", "AWP": "Western-Pacific",
}

# FAA region by state mapping (subset of major states)
STATE_TO_FAA_REGION = {
    "AK": "AAL",
    "CT": "ANE", "MA": "ANE", "ME": "ANE", "NH": "ANE", "RI": "ANE", "VT": "ANE",
    "DC": "AEA", "DE": "AEA", "MD": "AEA", "NJ": "AEA", "NY": "AEA", "PA": "AEA", "VA": "AEA", "WV": "AEA",
    "IL": "AGL", "IN": "AGL", "MI": "AGL", "MN": "AGL", "ND": "AGL", "OH": "AGL", "SD": "AGL", "WI": "AGL",
    "IA": "ACE", "KS": "ACE", "MO": "ACE", "NE": "ACE",
    "CO": "ANM", "ID": "ANM", "MT": "ANM", "OR": "ANM", "UT": "ANM", "WA": "ANM", "WY": "ANM",
    "AL": "ASO", "FL": "ASO", "GA": "ASO", "KY": "ASO", "MS": "ASO", "NC": "ASO", "PR": "ASO", "SC": "ASO", "TN": "ASO", "VI": "ASO",
    "AR": "ASW", "LA": "ASW", "NM": "ASW", "OK": "ASW", "TX": "ASW",
    "AZ": "AWP", "CA": "AWP", "HI": "AWP", "NV": "AWP",
}

# Delay thresholds (in minutes)
DELAY_ON_TIME_MAX = 14
DELAY_SEVERE_MIN = 60

print("Reference data loaded:")
print(f"  Carrier mappings: {len(CARRIER_MAPPING)}")
print(f"  FAA regions: {len(FAA_REGIONS)}")
print(f"  State-to-region mappings: {len(STATE_TO_FAA_REGION)}")
print(f"  Delay thresholds: on-time <= {DELAY_ON_TIME_MAX}min, severe >= {DELAY_SEVERE_MIN}min")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Data

# COMMAND ----------

df_flights = spark.table(SOURCE_FLIGHT_OPS)
df_safety = spark.table(SOURCE_SAFETY)
df_traffic = spark.table(SOURCE_TRAFFIC)

print(f"Bronze flight ops:      {df_flights.count():,} records")
print(f"Bronze safety incidents: {df_safety.count():,} records")
print(f"Bronze traffic stats:    {df_traffic.count():,} records")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Flight Performance: Data Quality Validation

# COMMAND ----------

# Step 1: Filter records with null required fields
df_flights_clean = df_flights \
    .filter(col("flight_id").isNotNull()) \
    .filter(col("flight_number").isNotNull()) \
    .filter(col("carrier_code").isNotNull()) \
    .filter(col("origin_airport").isNotNull()) \
    .filter(col("destination_airport").isNotNull())

dropped = df_flights.count() - df_flights_clean.count()
print(f"Records after null filter: {df_flights_clean.count():,} (dropped {dropped:,})")

# COMMAND ----------

# Step 2: Validate IATA airport codes (3-letter uppercase alpha)
iata_pattern = "^[A-Z]{3}$"

df_flights_validated = df_flights_clean \
    .withColumn("origin_airport", upper(trim(col("origin_airport")))) \
    .withColumn("destination_airport", upper(trim(col("destination_airport")))) \
    .withColumn("carrier_code", upper(trim(col("carrier_code")))) \
    .withColumn("_valid_origin", col("origin_airport").rlike(iata_pattern)) \
    .withColumn("_valid_destination", col("destination_airport").rlike(iata_pattern))

invalid_airports = df_flights_validated \
    .filter(~col("_valid_origin") | ~col("_valid_destination")).count()
print(f"Records with invalid airport codes: {invalid_airports:,}")

# COMMAND ----------

# Step 3: Validate date ranges (no future dates, no dates before 2000)
df_flights_validated = df_flights_validated \
    .withColumn("flight_date_parsed", to_date(col("flight_date"))) \
    .withColumn("_valid_date",
        (col("flight_date_parsed").isNotNull()) &
        (col("flight_date_parsed") >= lit("2000-01-01")) &
        (col("flight_date_parsed") <= current_date())
    )

invalid_dates = df_flights_validated.filter(~col("_valid_date")).count()
print(f"Records with invalid dates: {invalid_dates:,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Flight Performance: Delay Categorization

# COMMAND ----------

# Categorize delays
df_flights_categorized = df_flights_validated \
    .withColumn("departure_delay_minutes",
        coalesce(col("departure_delay_minutes"), lit(0))) \
    .withColumn("arrival_delay_minutes",
        coalesce(col("arrival_delay_minutes"), lit(0))) \
    .withColumn("delay_category",
        when(col("cancelled") == True, lit("CANCELLED"))
        .when(col("diverted") == True, lit("DIVERTED"))
        .when(col("arrival_delay_minutes") <= DELAY_ON_TIME_MAX, lit("ON_TIME"))
        .when(col("arrival_delay_minutes") < DELAY_SEVERE_MIN, lit("DELAYED"))
        .otherwise(lit("SEVERELY_DELAYED"))
    ) \
    .withColumn("is_on_time",
        (col("delay_category") == "ON_TIME").cast(IntegerType())
    )

# Show delay distribution
print("Delay Category Distribution:")
display(
    df_flights_categorized
    .groupBy("delay_category")
    .count()
    .orderBy(col("count").desc())
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Flight Performance: Carrier Name Standardization

# COMMAND ----------

# Build carrier mapping expression
carrier_expr = coalesce(
    *[when(col("carrier_code") == code, lit(name)) for code, name in CARRIER_MAPPING.items()],
    col("carrier_name"),
    concat(lit("Unknown ("), col("carrier_code"), lit(")"))
)

df_flights_std = df_flights_categorized \
    .withColumn("carrier_name_std", carrier_expr) \
    .withColumn("route",
        concat(col("origin_airport"), lit("-"), col("destination_airport"))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Flight Performance: FAA Region Enrichment

# COMMAND ----------

# Enrich with FAA region if not already present
# Use the faa_region from source if available, otherwise leave as-is
df_flights_enriched = df_flights_std \
    .withColumn("faa_region",
        coalesce(col("faa_region"), lit("UNKNOWN"))
    ) \
    .withColumn("faa_region_name",
        coalesce(
            *[when(col("faa_region") == code, lit(name)) for code, name in FAA_REGIONS.items()],
            col("faa_region")
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Calculate On-Time Performance Rate Per Carrier

# COMMAND ----------

from pyspark.sql.window import Window

# Window for carrier-level on-time performance
carrier_window = Window.partitionBy("carrier_code")

df_flights_perf = df_flights_enriched \
    .withColumn("carrier_total_flights",
        count("*").over(carrier_window)) \
    .withColumn("carrier_on_time_count",
        sum("is_on_time").over(carrier_window)) \
    .withColumn("carrier_on_time_rate",
        round(col("carrier_on_time_count") / col("carrier_total_flights") * 100, 2)
    )

# Show carrier on-time performance
print("Carrier On-Time Performance:")
display(
    df_flights_perf
    .select("carrier_code", "carrier_name_std", "carrier_total_flights",
            "carrier_on_time_count", "carrier_on_time_rate")
    .distinct()
    .orderBy(col("carrier_on_time_rate").desc())
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Flight Performance: Data Quality Score

# COMMAND ----------

df_flights_dq = df_flights_perf \
    .withColumn("_dq_score",
        (
            when(col("_valid_origin"), lit(15)).otherwise(lit(0)) +
            when(col("_valid_destination"), lit(15)).otherwise(lit(0)) +
            when(col("_valid_date"), lit(15)).otherwise(lit(0)) +
            when(col("scheduled_departure").isNotNull(), lit(10)).otherwise(lit(0)) +
            when(col("actual_departure").isNotNull(), lit(10)).otherwise(lit(0)) +
            when(col("scheduled_arrival").isNotNull(), lit(10)).otherwise(lit(0)) +
            when(col("actual_arrival").isNotNull(), lit(10)).otherwise(lit(0)) +
            when(col("distance_miles").isNotNull() & (col("distance_miles") > 0), lit(10)).otherwise(lit(0)) +
            when(col("carrier_code").isin(list(CARRIER_MAPPING.keys())), lit(5)).otherwise(lit(0))
        )
    ) \
    .withColumn("_dq_flags",
        array_compact(
            array(
                when(~col("_valid_origin"), lit("INVALID_ORIGIN_AIRPORT")),
                when(~col("_valid_destination"), lit("INVALID_DEST_AIRPORT")),
                when(~col("_valid_date"), lit("INVALID_FLIGHT_DATE")),
                when(col("departure_delay_minutes") < -60, lit("SUSPICIOUS_EARLY_DEPARTURE")),
                when(col("distance_miles").isNull() | (col("distance_miles") <= 0), lit("MISSING_DISTANCE"))
            )
        )
    )

# Drop internal validation columns
df_flights_final = df_flights_dq.drop(
    "_valid_origin", "_valid_destination", "_valid_date"
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Safety Incidents: Validation & Enrichment

# COMMAND ----------

# Clean and validate safety data
df_safety_clean = df_safety \
    .filter(col("incident_id").isNotNull()) \
    .filter(col("incident_date").isNotNull()) \
    .filter(col("incident_type").isNotNull()) \
    .withColumn("incident_date_parsed", to_date(col("incident_date"))) \
    .withColumn("airport_code", upper(trim(col("airport_code")))) \
    .withColumn("carrier_code", upper(trim(col("carrier_code")))) \
    .withColumn("incident_type", upper(trim(col("incident_type")))) \
    .withColumn("severity",
        coalesce(upper(trim(col("severity"))), lit("UNKNOWN"))
    ) \
    .withColumn("injury_count", coalesce(col("injury_count"), lit(0))) \
    .withColumn("fatality_count", coalesce(col("fatality_count"), lit(0)))

print(f"Safety records after cleaning: {df_safety_clean.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cross-Source Correlation: Flights to Safety Incidents

# COMMAND ----------

# Join safety incidents with flight data on flight_number + date
# This links incidents to their corresponding flight records
df_safety_correlated = df_safety_clean.alias("s") \
    .join(
        df_flights_final.alias("f"),
        (col("s.flight_number") == col("f.flight_number")) &
        (col("s.incident_date_parsed") == col("f.flight_date_parsed")),
        "left"
    ) \
    .select(
        col("s.*"),
        col("f.origin_airport").alias("flight_origin"),
        col("f.destination_airport").alias("flight_destination"),
        col("f.carrier_name_std").alias("carrier_name_std"),
        col("f.aircraft_type").alias("flight_aircraft_type"),
        col("f.route").alias("flight_route"),
    )

matched = df_safety_correlated.filter(col("flight_origin").isNotNull()).count()
total = df_safety_correlated.count()
print(f"Safety incidents matched to flights: {matched}/{total} ({matched/max(total,1)*100:.1f}%)")

# COMMAND ----------

# Enrich safety records with FAA region
df_safety_enriched = df_safety_correlated \
    .withColumn("faa_region",
        coalesce(col("faa_region"), lit("UNKNOWN"))
    ) \
    .withColumn("faa_region_name",
        coalesce(
            *[when(col("faa_region") == code, lit(name)) for code, name in FAA_REGIONS.items()],
            col("faa_region")
        )
    ) \
    .withColumn("_dq_score",
        (
            when(col("incident_id").isNotNull(), lit(20)).otherwise(lit(0)) +
            when(col("incident_date_parsed").isNotNull(), lit(20)).otherwise(lit(0)) +
            when(col("airport_code").rlike("^[A-Z]{3}$"), lit(20)).otherwise(lit(0)) +
            when(col("severity") != "UNKNOWN", lit(20)).otherwise(lit(0)) +
            when(col("description").isNotNull(), lit(20)).otherwise(lit(0))
        )
    ) \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Add Silver Metadata to Flight Performance

# COMMAND ----------

df_flights_silver = df_flights_final \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Silver Flight Performance Table

# COMMAND ----------

try:
    flight_perf_columns = [
        # Identifiers
        "flight_id", "flight_number", "carrier_code", "carrier_name_std", "route",
        # Airports
        "origin_airport", "destination_airport",
        # Schedule
        "flight_date_parsed", "scheduled_departure", "actual_departure",
        "scheduled_arrival", "actual_arrival",
        # Delay metrics
        "departure_delay_minutes", "arrival_delay_minutes",
        "delay_category", "delay_cause", "is_on_time",
        # Flight details
        "cancelled", "cancellation_code", "diverted",
        "aircraft_type", "tail_number", "distance_miles",
        "air_time_minutes", "taxi_out_minutes", "taxi_in_minutes",
        # Region & performance
        "faa_region", "faa_region_name",
        "carrier_on_time_rate",
        # Quality & metadata
        "_dq_score", "_dq_flags", "_silver_timestamp", "_batch_id"
    ]

    df_flight_out = df_flights_silver.select(
        [col(c) for c in flight_perf_columns if c in df_flights_silver.columns]
    )

    # Write to Silver layer using Delta MERGE (incremental upsert)
    if spark.catalog.tableExists(TARGET_FLIGHT_PERF):
        deltaTable = DeltaTable.forName(spark, TARGET_FLIGHT_PERF)
        deltaTable.alias("target").merge(
            df_flight_out.alias("source"),
            "target.flight_id = source.flight_id"
        ).whenMatchedUpdateAll(
            condition="target._silver_timestamp < source._silver_timestamp"
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_flight_out.write \
            .format("delta") \
            .mode("overwrite") \
            .partitionBy("flight_date_parsed") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_FLIGHT_PERF)

    print(f"Written/merged records to {TARGET_FLIGHT_PERF} (total: {spark.table(TARGET_FLIGHT_PERF).count():,})")
except Exception as e:
    print(f"ERROR in unknown (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Silver Safety Enriched Table

# COMMAND ----------

safety_columns = [
    "incident_id", "incident_date", "incident_date_parsed", "incident_type",
    "severity", "airport_code", "flight_number", "carrier_code", "carrier_name_std",
    "aircraft_type", "phase_of_flight",
    "injury_count", "fatality_count", "damage_level",
    "weather_condition", "description", "investigation_status",
    "faa_region", "faa_region_name", "latitude", "longitude",
    "flight_origin", "flight_destination", "flight_route",
    "_dq_score", "_silver_timestamp", "_batch_id"
]

df_safety_out = df_safety_enriched.select(
    [col(c) for c in safety_columns if c in df_safety_enriched.columns]
)

# Write to Silver layer using Delta MERGE (incremental upsert)
if spark.catalog.tableExists(TARGET_SAFETY):
    deltaTable = DeltaTable.forName(spark, TARGET_SAFETY)
    deltaTable.alias("target").merge(
        df_safety_out.alias("source"),
        "target.incident_id = source.incident_id"
    ).whenMatchedUpdateAll(
        condition="target._silver_timestamp < source._silver_timestamp"
    ).whenNotMatchedInsertAll(
    ).execute()
else:
    df_safety_out.write \
        .format("delta") \
        .mode("overwrite") \
        .partitionBy("incident_date_parsed") \
        .option("overwriteSchema", "true") \
        .saveAsTable(TARGET_SAFETY)

print(f"Written/merged records to {TARGET_SAFETY} (total: {spark.table(TARGET_SAFETY).count():,})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Report

# COMMAND ----------

print("="*60)
print("DOT/FAA Silver Layer - Data Quality Report")
print("="*60)

# Flight performance quality
print(f"\n--- {TARGET_FLIGHT_PERF} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(CASE WHEN _dq_score < 50 THEN 1 END) as low_quality_records,
        COUNT(DISTINCT carrier_code) as unique_carriers,
        COUNT(DISTINCT origin_airport) as unique_origins,
        COUNT(DISTINCT destination_airport) as unique_destinations
    FROM {TARGET_FLIGHT_PERF}
""").show(truncate=False)

# COMMAND ----------

# Safety quality
print(f"\n--- {TARGET_SAFETY} ---")
spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        ROUND(AVG(_dq_score), 2) as avg_quality_score,
        COUNT(CASE WHEN _dq_score = 100 THEN 1 END) as perfect_records,
        COUNT(CASE WHEN flight_origin IS NOT NULL THEN 1 END) as matched_to_flights,
        COUNT(DISTINCT incident_type) as incident_types,
        COUNT(DISTINCT severity) as severity_levels
    FROM {TARGET_SAFETY}
""").show(truncate=False)

# COMMAND ----------

# Delay category distribution
print("\nDelay Category Distribution:")
spark.sql(f"""
    SELECT
        delay_category,
        COUNT(*) as flights,
        ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 2) as pct
    FROM {TARGET_FLIGHT_PERF}
    GROUP BY delay_category
    ORDER BY flights DESC
""").show()

# COMMAND ----------

# Carrier on-time performance summary
print("\nCarrier On-Time Performance:")
spark.sql(f"""
    SELECT
        carrier_code,
        carrier_name_std,
        COUNT(*) as total_flights,
        ROUND(carrier_on_time_rate, 2) as on_time_pct
    FROM {TARGET_FLIGHT_PERF}
    GROUP BY carrier_code, carrier_name_std, carrier_on_time_rate
    ORDER BY on_time_pct DESC
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize Tables

# COMMAND ----------

spark.sql(f"OPTIMIZE {TARGET_FLIGHT_PERF} ZORDER BY (carrier_code, origin_airport)")
print(f"Optimized {TARGET_FLIGHT_PERF} with Z-Order on carrier_code, origin_airport")

spark.sql(f"OPTIMIZE {TARGET_SAFETY} ZORDER BY (incident_type, airport_code)")
print(f"Optimized {TARGET_SAFETY} with Z-Order on incident_type, airport_code")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Source Table | Target Table | Key Transformations |
# MAGIC |-------------|-------------|---------------------|
# MAGIC | bronze_dot_flight_ops | silver_dot_flight_performance | IATA validation, delay categorization, carrier standardization, OTP rate |
# MAGIC | bronze_dot_safety | silver_dot_safety_enriched | Cross-correlation with flights, FAA region enrichment, DQ scoring |
# MAGIC
# MAGIC **Next Step:** Continue to Gold layer analytics (`08_gold_dot_faa_analytics`).
