# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: DOT/FAA Aviation Analytics & Safety Dashboard
# MAGIC
# MAGIC This notebook creates aggregated analytics tables for DOT/FAA transportation data,
# MAGIC optimized for Power BI Direct Lake dashboards.
# MAGIC
# MAGIC ## Analytics Produced:
# MAGIC - **Carrier Performance:** On-time rates, delay patterns by carrier (monthly)
# MAGIC - **Route Analytics:** Top delayed routes, delay cause breakdown
# MAGIC - **Safety Analytics:** Incident rates, severity trends, bird strikes
# MAGIC - **Airport Metrics:** Utilization, runway availability, passenger volumes

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
    avg,
    coalesce,
    col,
    count,
    countDistinct,
    current_timestamp,
    date_format,
    desc,
    filter,
    lag,
    lit,
    max,
    min,
    month,
    months,
    rank,
    round,
    row_number,
    sum,
    upper,
    when,
    window,
    year,
)
from pyspark.sql.window import Window

# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source tables (Silver)
SOURCE_FLIGHT_PERF = "lh_silver.silver_dot_flight_performance"
SOURCE_SAFETY = "lh_silver.silver_dot_safety_enriched"
SOURCE_TRAFFIC = "lh_bronze.bronze_dot_traffic_stats"

# Target tables (Gold)
TARGET_CARRIER_PERF = "lh_gold.gold_dot_carrier_performance"
TARGET_SAFETY_ANALYTICS = "lh_gold.gold_dot_safety_analytics"
TARGET_AIRPORT_METRICS = "lh_gold.gold_dot_airport_metrics"

print(f"Processing batch: {batch_id}")
print(f"Sources: {SOURCE_FLIGHT_PERF}, {SOURCE_SAFETY}, {SOURCE_TRAFFIC}")
print(f"Targets: {TARGET_CARRIER_PERF}, {TARGET_SAFETY_ANALYTICS}, {TARGET_AIRPORT_METRICS}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Data

# COMMAND ----------

df_flights = spark.table(SOURCE_FLIGHT_PERF)
df_safety = spark.table(SOURCE_SAFETY)
df_traffic = spark.table(SOURCE_TRAFFIC)

print(f"Silver flight performance: {df_flights.count():,} records")
print(f"Silver safety enriched:    {df_safety.count():,} records")
print(f"Bronze traffic statistics: {df_traffic.count():,} records")

flight_date_range = df_flights.agg(
    min("flight_date_parsed"), max("flight_date_parsed")
).collect()[0]
print(f"Flight date range: {flight_date_range[0]} to {flight_date_range[1]}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 1: Carrier Performance Analytics

# COMMAND ----------

# MAGIC %md
# MAGIC ### On-Time Performance by Carrier (Monthly)

# COMMAND ----------

# Monthly carrier performance aggregation
df_carrier_monthly = df_flights \
    .withColumn("report_year", year("flight_date_parsed")) \
    .withColumn("report_month", month("flight_date_parsed")) \
    .withColumn("report_period",
        date_format(col("flight_date_parsed"), "yyyy-MM")) \
    .groupBy(
        "carrier_code", "carrier_name_std",
        "report_year", "report_month", "report_period"
    ) \
    .agg(
        # Volume
        count("*").alias("total_flights"),
        countDistinct("route").alias("unique_routes"),
        countDistinct("origin_airport").alias("airports_served"),

        # On-time metrics
        sum("is_on_time").alias("on_time_flights"),
        sum(when(col("delay_category") == "DELAYED", 1).otherwise(0)).alias("delayed_flights"),
        sum(when(col("delay_category") == "SEVERELY_DELAYED", 1).otherwise(0)).alias("severely_delayed_flights"),
        sum(when(col("cancelled") == True, 1).otherwise(0)).alias("cancelled_flights"),
        sum(when(col("diverted") == True, 1).otherwise(0)).alias("diverted_flights"),

        # Delay metrics
        round(avg("departure_delay_minutes"), 2).alias("avg_departure_delay_min"),
        round(avg("arrival_delay_minutes"), 2).alias("avg_arrival_delay_min"),
        max("arrival_delay_minutes").alias("max_arrival_delay_min"),

        # Delay cause breakdown
        sum(when(col("delay_cause") == "CARRIER", 1).otherwise(0)).alias("carrier_delays"),
        sum(when(col("delay_cause") == "WEATHER", 1).otherwise(0)).alias("weather_delays"),
        sum(when(col("delay_cause") == "NAS", 1).otherwise(0)).alias("nas_delays"),
        sum(when(col("delay_cause") == "SECURITY", 1).otherwise(0)).alias("security_delays"),
        sum(when(col("delay_cause") == "LATE_AIRCRAFT", 1).otherwise(0)).alias("late_aircraft_delays"),

        # Distance
        round(avg("distance_miles"), 0).alias("avg_distance_miles"),
        sum("distance_miles").alias("total_distance_miles"),

        # Data quality
        round(avg("_dq_score"), 2).alias("avg_data_quality"),
    )

# COMMAND ----------

# Calculate derived KPIs
df_carrier_perf = df_carrier_monthly \
    .withColumn("on_time_rate",
        round(col("on_time_flights") / col("total_flights") * 100, 2)
    ) \
    .withColumn("cancellation_rate",
        round(col("cancelled_flights") / col("total_flights") * 100, 2)
    ) \
    .withColumn("diversion_rate",
        round(col("diverted_flights") / col("total_flights") * 100, 2)
    ) \
    .withColumn("severe_delay_rate",
        round(col("severely_delayed_flights") / col("total_flights") * 100, 2)
    ) \
    .withColumn("completion_factor",
        round((col("total_flights") - col("cancelled_flights")) / col("total_flights") * 100, 2)
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Top 10 Worst Routes by Average Delay

# COMMAND ----------

# Route-level delay analysis
df_route_delays = df_flights \
    .filter(col("cancelled") == False) \
    .groupBy("route", "origin_airport", "destination_airport") \
    .agg(
        count("*").alias("total_flights"),
        round(avg("arrival_delay_minutes"), 2).alias("avg_arrival_delay_min"),
        round(avg("departure_delay_minutes"), 2).alias("avg_departure_delay_min"),
        sum("is_on_time").alias("on_time_flights"),
        round(avg("distance_miles"), 0).alias("avg_distance_miles"),
        countDistinct("carrier_code").alias("carriers_on_route"),
    ) \
    .withColumn("on_time_rate",
        round(col("on_time_flights") / col("total_flights") * 100, 2)
    ) \
    .withColumn("delay_rank",
        row_number().over(
            Window.orderBy(col("avg_arrival_delay_min").desc())
        )
    )

# Attach top-10 worst routes flag to carrier performance
df_worst_routes = df_route_delays.filter(col("delay_rank") <= 10)

print("Top 10 Worst Routes by Average Delay:")
display(df_worst_routes.select(
    "delay_rank", "route", "total_flights",
    "avg_arrival_delay_min", "on_time_rate", "carriers_on_route"
))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Delay Cause Breakdown by FAA Region

# COMMAND ----------

# Region-level delay cause analysis
df_region_delays = df_flights \
    .filter(col("delay_cause").isNotNull()) \
    .groupBy("faa_region", "faa_region_name", "delay_cause") \
    .agg(
        count("*").alias("delay_count"),
        round(avg("arrival_delay_minutes"), 2).alias("avg_delay_minutes"),
    )

# Pivot for regional delay cause comparison
df_region_pivot = df_region_delays \
    .groupBy("faa_region", "faa_region_name") \
    .pivot("delay_cause") \
    .agg(sum("delay_count")) \
    .na.fill(0)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Performance Ranking & Metadata

# COMMAND ----------

# Rank carriers by on-time performance within each month
carrier_rank_window = Window.partitionBy("report_period").orderBy(col("on_time_rate").desc())

df_carrier_final = df_carrier_perf \
    .withColumn("monthly_otp_rank",
        row_number().over(carrier_rank_window)
    ) \
    .withColumn("performance_tier",
        when(col("on_time_rate") >= 85, lit("EXCELLENT"))
        .when(col("on_time_rate") >= 75, lit("GOOD"))
        .when(col("on_time_rate") >= 65, lit("FAIR"))
        .otherwise(lit("POOR"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Carrier Performance Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_CARRIER_PERF):
        deltaTable = DeltaTable.forName(spark, TARGET_CARRIER_PERF)
        deltaTable.alias("target").merge(
            df_carrier_final.alias("source"),
            "target.carrier_code = source.carrier_code AND target.report_year = source.report_year AND target.report_month = source.report_month"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_carrier_final.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("report_year") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_CARRIER_PERF)

    print(f"Merged {spark.table(TARGET_CARRIER_PERF).count():,} records into {TARGET_CARRIER_PERF}")
except Exception as e:
    print(f"ERROR in unknown (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 2: Safety Analytics

# COMMAND ----------

# MAGIC %md
# MAGIC ### Incident Rate per 100K Departures

# COMMAND ----------

# Monthly incident counts
df_incident_monthly = df_safety \
    .withColumn("incident_year", year("incident_date_parsed")) \
    .withColumn("incident_month", month("incident_date_parsed")) \
    .withColumn("incident_period",
        date_format(col("incident_date_parsed"), "yyyy-MM"))

# Aggregate incidents by period and type
df_safety_agg = df_incident_monthly \
    .groupBy("incident_period", "incident_year", "incident_month") \
    .agg(
        count("*").alias("total_incidents"),
        sum(when(col("severity") == "FATAL", 1).otherwise(0)).alias("fatal_incidents"),
        sum(when(col("severity") == "SERIOUS", 1).otherwise(0)).alias("serious_incidents"),
        sum(when(col("severity") == "MINOR", 1).otherwise(0)).alias("minor_incidents"),
        sum(when(col("severity") == "NONE", 1).otherwise(0)).alias("no_injury_incidents"),

        sum("injury_count").alias("total_injuries"),
        sum("fatality_count").alias("total_fatalities"),

        # Incident type breakdown
        sum(when(col("incident_type") == "BIRD_STRIKE", 1).otherwise(0)).alias("bird_strikes"),
        sum(when(col("incident_type") == "RUNWAY_INCURSION", 1).otherwise(0)).alias("runway_incursions"),
        sum(when(col("incident_type") == "TURBULENCE", 1).otherwise(0)).alias("turbulence_events"),
        sum(when(col("incident_type") == "MECHANICAL", 1).otherwise(0)).alias("mechanical_failures"),
        sum(when(col("incident_type") == "GROUND_INCIDENT", 1).otherwise(0)).alias("ground_incidents"),

        countDistinct("airport_code").alias("airports_affected"),
        countDistinct("carrier_code").alias("carriers_involved"),
    )

# COMMAND ----------

# Calculate departure counts from traffic data for incident rate normalization
df_departures_monthly = df_traffic \
    .withColumn("report_period", col("report_month")) \
    .groupBy("report_period") \
    .agg(
        sum(coalesce(col("domestic_departures"), lit(0)) +
            coalesce(col("international_departures"), lit(0))).alias("total_departures")
    )

# Join to calculate rate per 100K departures
df_safety_rates = df_safety_agg.alias("s") \
    .join(
        df_departures_monthly.alias("d"),
        col("s.incident_period") == col("d.report_period"),
        "left"
    ) \
    .withColumn("total_departures", coalesce(col("total_departures"), lit(100000))) \
    .withColumn("incident_rate_per_100k",
        round(col("total_incidents") / col("total_departures") * 100000, 4)
    ) \
    .withColumn("fatal_rate_per_100k",
        round(col("fatal_incidents") / col("total_departures") * 100000, 6)
    ) \
    .drop("report_period")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Incident Severity Trends

# COMMAND ----------

# Add severity trend indicators (month-over-month change)
severity_window = Window.orderBy("incident_period")

df_safety_trends = df_safety_rates \
    .withColumn("prev_total_incidents",
        lag("total_incidents", 1).over(severity_window)) \
    .withColumn("incident_mom_change",
        when(col("prev_total_incidents").isNotNull() & (col("prev_total_incidents") > 0),
            round((col("total_incidents") - col("prev_total_incidents")) /
                  col("prev_total_incidents") * 100, 2))
        .otherwise(lit(None))
    ) \
    .withColumn("severity_trend",
        when(col("incident_mom_change") > 10, lit("INCREASING"))
        .when(col("incident_mom_change") < -10, lit("DECREASING"))
        .otherwise(lit("STABLE"))
    ) \
    .drop("prev_total_incidents")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Bird Strike Frequency by Airport

# COMMAND ----------

# Bird strike analysis by airport
df_bird_strikes = df_safety \
    .filter(upper(col("incident_type")) == "BIRD_STRIKE") \
    .groupBy("airport_code") \
    .agg(
        count("*").alias("bird_strike_count"),
        sum("injury_count").alias("injuries_from_strikes"),
        countDistinct("carrier_code").alias("carriers_affected"),
        min("incident_date_parsed").alias("first_strike_date"),
        max("incident_date_parsed").alias("last_strike_date"),
    ) \
    .withColumn("bird_strike_rank",
        row_number().over(Window.orderBy(col("bird_strike_count").desc()))
    )

# Merge bird strike data into safety analytics as a nested view
print("Top 10 Airports by Bird Strike Frequency:")
display(df_bird_strikes.filter(col("bird_strike_rank") <= 10))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Safety Metadata & Write

# COMMAND ----------

df_safety_final = df_safety_trends \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

if spark.catalog.tableExists(TARGET_SAFETY_ANALYTICS):
    deltaTable = DeltaTable.forName(spark, TARGET_SAFETY_ANALYTICS)
    deltaTable.alias("target").merge(
        df_safety_final.alias("source"),
        "target.incident_period = source.incident_period AND target.incident_year = source.incident_year AND target.incident_month = source.incident_month"
    ).whenMatchedUpdateAll(
    ).whenNotMatchedInsertAll(
    ).execute()
else:
    df_safety_final.write.format("delta") \
        .mode("overwrite") \
        .partitionBy("incident_year") \
        .option("overwriteSchema", "true") \
        .saveAsTable(TARGET_SAFETY_ANALYTICS)

print(f"Merged {df_safety_final.count():,} records into {TARGET_SAFETY_ANALYTICS}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 3: Airport Metrics

# COMMAND ----------

# MAGIC %md
# MAGIC ### Airport Utilization Rates

# COMMAND ----------

# Airport-level metrics from traffic data
df_airport_base = df_traffic \
    .groupBy("airport_code", "airport_name", "faa_region",
             "airport_category", "state_code", "city") \
    .agg(
        # Passenger volume
        sum("total_passengers").alias("total_passengers"),
        round(avg("total_passengers"), 0).alias("avg_monthly_passengers"),

        # Flight volume
        sum(coalesce(col("domestic_departures"), lit(0))).alias("total_domestic_departures"),
        sum(coalesce(col("international_departures"), lit(0))).alias("total_international_departures"),
        sum(coalesce(col("domestic_arrivals"), lit(0))).alias("total_domestic_arrivals"),
        sum(coalesce(col("international_arrivals"), lit(0))).alias("total_international_arrivals"),

        # Cargo
        sum(coalesce(col("total_cargo_tons"), lit(0))).alias("total_cargo_tons"),
        sum(coalesce(col("total_mail_tons"), lit(0))).alias("total_mail_tons"),

        # Reporting coverage
        countDistinct("report_month").alias("months_reported"),
    )

# Calculate derived airport metrics
df_airport_metrics = df_airport_base \
    .withColumn("total_departures",
        col("total_domestic_departures") + col("total_international_departures")) \
    .withColumn("total_arrivals",
        col("total_domestic_arrivals") + col("total_international_arrivals")) \
    .withColumn("total_operations",
        col("total_departures") + col("total_arrivals")) \
    .withColumn("international_pct",
        when(col("total_departures") > 0,
            round(col("total_international_departures") / col("total_departures") * 100, 2))
        .otherwise(lit(0))
    ) \
    .withColumn("passengers_per_operation",
        when(col("total_operations") > 0,
            round(col("total_passengers") / col("total_operations"), 1))
        .otherwise(lit(0))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Enrich with Flight Performance Data

# COMMAND ----------

# Get per-airport flight performance from silver data
df_airport_flight_perf = df_flights \
    .groupBy(col("origin_airport").alias("perf_airport_code")) \
    .agg(
        count("*").alias("total_tracked_flights"),
        sum("is_on_time").alias("on_time_flights"),
        round(avg("departure_delay_minutes"), 2).alias("avg_departure_delay"),
        round(avg("arrival_delay_minutes"), 2).alias("avg_arrival_delay"),
        sum(when(col("cancelled") == True, 1).otherwise(0)).alias("cancelled_flights"),
        countDistinct("carrier_code").alias("carriers_serving"),
        countDistinct("route").alias("routes_served"),
    ) \
    .withColumn("airport_otp_rate",
        round(col("on_time_flights") / col("total_tracked_flights") * 100, 2)
    )

# Join airport metrics with flight performance
df_airport_enriched = df_airport_metrics.alias("a") \
    .join(
        df_airport_flight_perf.alias("p"),
        col("a.airport_code") == col("p.perf_airport_code"),
        "left"
    ) \
    .drop("perf_airport_code")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Enrich with Safety Incident Counts

# COMMAND ----------

# Safety incidents per airport
df_airport_safety = df_safety \
    .groupBy(col("airport_code").alias("safety_airport_code")) \
    .agg(
        count("*").alias("safety_incidents"),
        sum(when(col("severity") == "FATAL", 1).otherwise(0)).alias("fatal_incidents"),
        sum(when(upper(col("incident_type")) == "BIRD_STRIKE", 1).otherwise(0)).alias("bird_strikes"),
        sum("injury_count").alias("total_injuries"),
    )

df_airport_with_safety = df_airport_enriched.alias("a") \
    .join(
        df_airport_safety.alias("s"),
        col("a.airport_code") == col("s.safety_airport_code"),
        "left"
    ) \
    .drop("safety_airport_code") \
    .na.fill(0, ["safety_incidents", "fatal_incidents", "bird_strikes", "total_injuries"])

# COMMAND ----------

# MAGIC %md
# MAGIC ### Airport Ranking & Classification

# COMMAND ----------

# Rank and classify airports
df_airport_final = df_airport_with_safety \
    .withColumn("passenger_volume_rank",
        row_number().over(Window.orderBy(col("total_passengers").desc()))
    ) \
    .withColumn("operations_rank",
        row_number().over(Window.orderBy(col("total_operations").desc()))
    ) \
    .withColumn("airport_size_tier",
        when(col("total_passengers") >= 30000000, lit("LARGE_HUB"))
        .when(col("total_passengers") >= 10000000, lit("MEDIUM_HUB"))
        .when(col("total_passengers") >= 2500000, lit("SMALL_HUB"))
        .when(col("total_passengers") >= 100000, lit("NON_HUB"))
        .otherwise(lit("GENERAL_AVIATION"))
    ) \
    .withColumn("safety_incident_rate_per_10k_ops",
        when(col("total_operations") > 0,
            round(col("safety_incidents") / col("total_operations") * 10000, 4))
        .otherwise(lit(None))
    ) \
    .withColumn("runway_availability_index",
        when(col("total_operations") > 0,
            round(col("total_operations") / col("months_reported") / 30, 0))
        .otherwise(lit(0))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Airport Metrics Table

# COMMAND ----------

if spark.catalog.tableExists(TARGET_AIRPORT_METRICS):
    deltaTable = DeltaTable.forName(spark, TARGET_AIRPORT_METRICS)
    deltaTable.alias("target").merge(
        df_airport_final.alias("source"),
        "target.airport_code = source.airport_code"
    ).whenMatchedUpdateAll(
    ).whenNotMatchedInsertAll(
    ).execute()
else:
    df_airport_final.write.format("delta") \
        .mode("overwrite") \
        .option("overwriteSchema", "true") \
        .saveAsTable(TARGET_AIRPORT_METRICS)

print(f"Merged {df_airport_final.count():,} records into {TARGET_AIRPORT_METRICS}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Optimize All Gold Tables for Direct Lake

# COMMAND ----------

spark.sql(f"OPTIMIZE {TARGET_CARRIER_PERF} ZORDER BY (carrier_code, report_period)")
print(f"Optimized {TARGET_CARRIER_PERF}")

spark.sql(f"OPTIMIZE {TARGET_SAFETY_ANALYTICS} ZORDER BY (incident_period)")
print(f"Optimized {TARGET_SAFETY_ANALYTICS}")

spark.sql(f"OPTIMIZE {TARGET_AIRPORT_METRICS} ZORDER BY (airport_code)")
print(f"Optimized {TARGET_AIRPORT_METRICS}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Validation & Summary

# COMMAND ----------

# MAGIC %md
# MAGIC ### Carrier Performance Summary

# COMMAND ----------

spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        COUNT(DISTINCT carrier_code) as carriers,
        COUNT(DISTINCT report_period) as months,
        ROUND(AVG(on_time_rate), 2) as avg_otp_rate,
        ROUND(AVG(cancellation_rate), 2) as avg_cancel_rate,
        ROUND(AVG(avg_arrival_delay_min), 2) as avg_delay_min
    FROM {TARGET_CARRIER_PERF}
""").show(truncate=False)

# COMMAND ----------

# Top carriers by on-time performance
print("Top Carriers by On-Time Performance (Latest Month):")
spark.sql(f"""
    SELECT
        carrier_code,
        carrier_name_std,
        total_flights,
        on_time_rate,
        cancellation_rate,
        performance_tier,
        monthly_otp_rank
    FROM {TARGET_CARRIER_PERF}
    WHERE report_period = (SELECT MAX(report_period) FROM {TARGET_CARRIER_PERF})
    ORDER BY on_time_rate DESC
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Safety Analytics Summary

# COMMAND ----------

spark.sql(f"""
    SELECT
        COUNT(*) as reporting_periods,
        SUM(total_incidents) as total_incidents,
        SUM(total_fatalities) as total_fatalities,
        SUM(bird_strikes) as total_bird_strikes,
        ROUND(AVG(incident_rate_per_100k), 4) as avg_incident_rate_per_100k
    FROM {TARGET_SAFETY_ANALYTICS}
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Airport Metrics Summary

# COMMAND ----------

spark.sql(f"""
    SELECT
        airport_size_tier,
        COUNT(*) as airports,
        SUM(total_passengers) as total_passengers,
        SUM(total_operations) as total_operations,
        ROUND(AVG(COALESCE(airport_otp_rate, 0)), 2) as avg_otp_rate,
        SUM(safety_incidents) as safety_incidents
    FROM {TARGET_AIRPORT_METRICS}
    GROUP BY airport_size_tier
    ORDER BY total_passengers DESC
""").show(truncate=False)

# COMMAND ----------

# Top 10 busiest airports
print("Top 10 Busiest Airports:")
spark.sql(f"""
    SELECT
        passenger_volume_rank as rank,
        airport_code,
        airport_name,
        airport_size_tier,
        total_passengers,
        total_operations,
        COALESCE(airport_otp_rate, 0) as otp_rate,
        safety_incidents,
        bird_strikes
    FROM {TARGET_AIRPORT_METRICS}
    ORDER BY passenger_volume_rank
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Gold Layer Output Summary
# MAGIC
# MAGIC | Table | Description | Partitioned By | Z-Order |
# MAGIC |-------|-------------|----------------|---------|
# MAGIC | gold_dot_carrier_performance | Monthly carrier OTP, delays, cancellations | report_year | carrier_code, report_period |
# MAGIC | gold_dot_safety_analytics | Incident rates, severity trends, bird strikes | incident_year | incident_period |
# MAGIC | gold_dot_airport_metrics | Utilization, passenger volume, safety rates | - | airport_code |
# MAGIC
# MAGIC **Dashboard Ready:** All tables optimized for Power BI Direct Lake connectivity.
