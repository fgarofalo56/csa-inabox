# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Geolocation Insights
# MAGIC
# MAGIC This notebook creates aggregated geolocation analytics tables optimized for
# MAGIC Power BI Direct Lake dashboards and location intelligence reporting.
# MAGIC
# MAGIC ## Output Tables:
# MAGIC - **gold_geolocation_geofence_summary** - Geofence breach/dwell summary with event frequency
# MAGIC - **gold_geolocation_device_tracking** - Device-level movement summaries and patterns
# MAGIC - **gold_geolocation_h3_density** - H3 hex-cell density analysis for spatial heat maps
# MAGIC
# MAGIC ## Key Metrics:
# MAGIC - Geofence enter/exit/dwell frequency and duration
# MAGIC - Device movement patterns (speed, distance, zones visited)
# MAGIC - H3 spatial density for location-based analytics
# MAGIC - Proximity trigger effectiveness
# MAGIC - Indoor vs outdoor activity distribution

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
    col,
    count,
    countDistinct,
    current_timestamp,
    filter,
    lit,
    max,
    min,
    round,
    sum,
    unix_timestamp,
    when,
    window,
)
from pyspark.sql.window import Window

# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source table
source_table = "lh_silver.silver_geolocation"

# Target tables
geofence_summary_table = "lh_gold.gold_geolocation_geofence_summary"
device_tracking_table = "lh_gold.gold_geolocation_device_tracking"
h3_density_table = "lh_gold.gold_geolocation_h3_density"

print(f"Processing batch: {batch_id}")
print(f"Source: {source_table}")
print(f"Targets:")
print(f"  - {geofence_summary_table}")
print(f"  - {device_tracking_table}")
print(f"  - {h3_density_table}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Load Silver Data

# COMMAND ----------

df_silver = spark.table(source_table)

silver_count = df_silver.count()
print(f"Silver records: {silver_count:,}")
print(f"Unique devices: {df_silver.select('device_id').distinct().count():,}")
print(f"Unique geofences: {df_silver.filter(col('geofence_id').isNotNull()).select('geofence_id').distinct().count():,}")
print(f"Date range: {df_silver.agg(min('event_date'), max('event_date')).collect()[0]}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Table 1: Geofence Summary
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Geofence Events

# COMMAND ----------

# Filter to only geofence interaction events
df_geofence_events = df_silver.filter(col("geofence_id").isNotNull())

df_geofence_summary = df_geofence_events \
    .groupBy(
        "geofence_id",
        "geofence_name",
        "event_date"
    ) \
    .agg(
        count("*").alias("total_events"),

        # Event type breakdown
        sum(when(col("geofence_event_clean") == "enter", 1).otherwise(0)).alias("enter_count"),
        sum(when(col("geofence_event_clean") == "exit", 1).otherwise(0)).alias("exit_count"),
        sum(when(col("geofence_event_clean") == "dwell", 1).otherwise(0)).alias("dwell_count"),

        # Dwell time metrics
        avg(when(col("geofence_event_clean") == "dwell", col("geofence_dwell_seconds"))).alias("avg_dwell_seconds"),
        max(when(col("geofence_event_clean") == "dwell", col("geofence_dwell_seconds"))).alias("max_dwell_seconds"),
        min(when(col("geofence_event_clean") == "dwell", col("geofence_dwell_seconds"))).alias("min_dwell_seconds"),
        avg(when(col("geofence_event_clean") == "dwell", col("geofence_dwell_minutes"))).alias("avg_dwell_minutes"),

        # Device metrics
        countDistinct("device_id").alias("unique_devices"),
        countDistinct(when(col("device_type_clean") == "patron_app", col("device_id"))).alias("patron_devices"),
        countDistinct(when(col("device_type_clean") == "employee_badge", col("device_id"))).alias("employee_devices"),

        # Temporal spread
        countDistinct("event_hour").alias("active_hours"),
        min("timestamp").alias("first_event"),
        max("timestamp").alias("last_event"),

        # Proximity triggers
        sum(when(col("proximity_trigger").isNotNull(), 1).otherwise(0)).alias("proximity_triggers_fired"),

        # Data quality
        avg("_dq_score").alias("avg_data_quality"),
    )

# Add derived metrics
df_geofence_summary = df_geofence_summary \
    .withColumn(
        "net_flow",
        col("enter_count") - col("exit_count")
    ) \
    .withColumn(
        "flow_status",
        when(col("net_flow") > 5, lit("ACCUMULATING"))
        .when(col("net_flow") < -5, lit("DISPERSING"))
        .otherwise(lit("BALANCED"))
    ) \
    .withColumn(
        "traffic_level",
        when(col("total_events") > 100, lit("Very High"))
        .when(col("total_events") > 50, lit("High"))
        .when(col("total_events") > 20, lit("Moderate"))
        .when(col("total_events") > 5, lit("Low"))
        .otherwise(lit("Minimal"))
    ) \
    .withColumn(
        "avg_dwell_category",
        when(col("avg_dwell_minutes") > 60, lit("Extended"))
        .when(col("avg_dwell_minutes") > 20, lit("Long"))
        .when(col("avg_dwell_minutes") > 5, lit("Medium"))
        .when(col("avg_dwell_minutes").isNotNull(), lit("Short"))
        .otherwise(lit("N/A"))
    ) \
    .withColumn(
        "trigger_effectiveness_pct",
        when(col("patron_devices") > 0,
             round(col("proximity_triggers_fired") * 100.0 / col("patron_devices"), 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

print(f"Geofence summary records: {df_geofence_summary.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Geofence Summary

# COMMAND ----------

try:
    if spark.catalog.tableExists(geofence_summary_table):
        deltaTable = DeltaTable.forName(spark, geofence_summary_table)
        deltaTable.alias("target").merge(
            df_geofence_summary.alias("source"),
            "target.geofence_id = source.geofence_id AND target.geofence_name = source.geofence_name AND target.event_date = source.event_date"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_geofence_summary.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .partitionBy("event_date") \
            .saveAsTable(geofence_summary_table)

    print(f"Merged {spark.table(geofence_summary_table).count():,} records into {geofence_summary_table}")

    spark.sql(f"OPTIMIZE {geofence_summary_table} ZORDER BY (geofence_id, geofence_name)")
    print("Geofence summary table optimized")
except Exception as e:
    print(f"ERROR writing geofence summary (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Table 2: Device Tracking Summary
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Device-Level Movement Patterns

# COMMAND ----------

df_device_tracking = df_silver \
    .groupBy(
        "device_id",
        "device_type_clean",
        "mobility_class",
        "event_date"
    ) \
    .agg(
        count("*").alias("total_pings"),

        # Location metrics
        avg("latitude").alias("avg_latitude"),
        avg("longitude").alias("avg_longitude"),
        min("latitude").alias("min_latitude"),
        max("latitude").alias("max_latitude"),
        min("longitude").alias("min_longitude"),
        max("longitude").alias("max_longitude"),

        # Accuracy
        avg("accuracy_meters").alias("avg_accuracy_meters"),
        countDistinct("accuracy_tier").alias("accuracy_tiers_used"),

        # Movement
        avg("speed_mps").alias("avg_speed_mps"),
        max("speed_mps").alias("max_speed_mps"),
        avg("speed_kmh").alias("avg_speed_kmh"),
        max("speed_kmh").alias("max_speed_kmh"),
        sum(when(col("is_stationary"), 1).otherwise(0)).alias("stationary_pings"),
        sum(when(col("is_walking"), 1).otherwise(0)).alias("walking_pings"),
        sum(when(col("is_vehicle_speed"), 1).otherwise(0)).alias("vehicle_pings"),

        # Geofence interactions
        sum(when(col("geofence_event_clean") == "enter", 1).otherwise(0)).alias("geofence_enters"),
        sum(when(col("geofence_event_clean") == "exit", 1).otherwise(0)).alias("geofence_exits"),
        countDistinct("geofence_id").alias("distinct_geofences_visited"),

        # Indoor / outdoor
        sum(when(col("location_type") == "indoor", 1).otherwise(0)).alias("indoor_pings"),
        sum(when(col("location_type") == "outdoor", 1).otherwise(0)).alias("outdoor_pings"),
        countDistinct("indoor_zone_clean").alias("distinct_indoor_zones"),
        countDistinct("floor_level").alias("distinct_floors"),

        # POI proximity
        countDistinct("poi_name").alias("distinct_pois_visited"),
        avg("poi_distance_meters").alias("avg_poi_distance_m"),

        # H3 spatial spread
        countDistinct("h3_index").alias("distinct_h3_cells"),

        # Source systems
        countDistinct("source_system_clean").alias("source_systems_used"),

        # Battery
        avg("battery_level").alias("avg_battery_level"),
        min("battery_level").alias("min_battery_level"),

        # Temporal
        countDistinct("event_hour").alias("active_hours"),
        min("timestamp").alias("first_ping"),
        max("timestamp").alias("last_ping"),

        # Proximity triggers
        sum(when(col("proximity_trigger").isNotNull(), 1).otherwise(0)).alias("proximity_triggers"),

        # Data quality
        avg("_dq_score").alias("avg_data_quality"),
    )

# Calculate derived metrics
df_device_tracking = df_device_tracking \
    .withColumn(
        "lat_range",
        round(col("max_latitude") - col("min_latitude"), 6)
    ) \
    .withColumn(
        "lon_range",
        round(col("max_longitude") - col("min_longitude"), 6)
    ) \
    .withColumn(
        "tracking_duration_hours",
        round(
            (unix_timestamp(col("last_ping")) - unix_timestamp(col("first_ping"))) / 3600.0,
            2
        )
    ) \
    .withColumn(
        "pings_per_hour",
        when(col("active_hours") > 0,
             round(col("total_pings") / col("active_hours"), 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn(
        "indoor_pct",
        when(col("total_pings") > 0,
             round(col("indoor_pings") * 100.0 / col("total_pings"), 1))
        .otherwise(lit(0.0))
    ) \
    .withColumn(
        "stationary_pct",
        when(col("total_pings") > 0,
             round(col("stationary_pings") * 100.0 / col("total_pings"), 1))
        .otherwise(lit(0.0))
    ) \
    .withColumn(
        "activity_pattern",
        when(col("stationary_pct") > 80, lit("Mostly Stationary"))
        .when(col("vehicle_pings") > col("walking_pings"), lit("Vehicle-Dominant"))
        .when(col("walking_pings") > col("stationary_pings"), lit("Active Mover"))
        .otherwise(lit("Mixed"))
    ) \
    .withColumn(
        "battery_status",
        when(col("min_battery_level").isNull(), lit("UNKNOWN"))
        .when(col("min_battery_level") < 10, lit("CRITICAL"))
        .when(col("min_battery_level") < 25, lit("LOW"))
        .otherwise(lit("NORMAL"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

print(f"Device tracking records: {df_device_tracking.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Device Tracking

# COMMAND ----------

try:
    if spark.catalog.tableExists(device_tracking_table):
        deltaTable = DeltaTable.forName(spark, device_tracking_table)
        deltaTable.alias("target").merge(
            df_device_tracking.alias("source"),
            "target.device_id = source.device_id AND target.device_type_clean = source.device_type_clean AND target.mobility_class = source.mobility_class AND target.event_date = source.event_date"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_device_tracking.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .partitionBy("event_date") \
            .saveAsTable(device_tracking_table)

    print(f"Merged {df_device_tracking.count():,} records into {device_tracking_table}")

    spark.sql(f"OPTIMIZE {device_tracking_table} ZORDER BY (device_id, device_type_clean)")
    print("Device tracking table optimized")
except Exception as e:
    print(f"ERROR writing device tracking (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Table 3: H3 Spatial Density
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Events by H3 Hex Cell

# COMMAND ----------

# Filter to records with valid H3 indices
df_h3_events = df_silver.filter(col("has_h3_index") == True)

df_h3_density = df_h3_events \
    .groupBy(
        "h3_index",
        "event_date",
        "event_hour"
    ) \
    .agg(
        count("*").alias("event_count"),
        countDistinct("device_id").alias("unique_devices"),

        # Device type breakdown
        countDistinct(when(col("device_type_clean") == "patron_app", col("device_id"))).alias("patron_devices"),
        countDistinct(when(col("device_type_clean") == "employee_badge", col("device_id"))).alias("employee_devices"),
        countDistinct(when(col("device_type_clean") == "asset_tag", col("device_id"))).alias("asset_devices"),
        sum(when(col("device_type_clean").isin("vehicle_gps", "shuttle_tracker", "valet_tag"), 1).otherwise(0)).alias("vehicle_pings"),

        # Average position for the cell (centroid)
        avg("latitude").alias("centroid_lat"),
        avg("longitude").alias("centroid_lon"),

        # Movement metrics
        avg("speed_mps").alias("avg_speed_mps"),
        sum(when(col("is_stationary"), 1).otherwise(0)).alias("stationary_count"),
        sum(when(col("is_walking"), 1).otherwise(0)).alias("walking_count"),

        # Indoor/outdoor
        sum(when(col("location_type") == "indoor", 1).otherwise(0)).alias("indoor_events"),
        sum(when(col("location_type") == "outdoor", 1).otherwise(0)).alias("outdoor_events"),

        # Geofence associations
        countDistinct("geofence_id").alias("geofences_in_cell"),

        # Proximity triggers
        sum(when(col("proximity_trigger").isNotNull(), 1).otherwise(0)).alias("proximity_triggers"),

        # Data quality
        avg("_dq_score").alias("avg_data_quality"),
    )

# Add density classification
df_h3_density = df_h3_density \
    .withColumn(
        "density_level",
        when(col("unique_devices") >= 20, lit("Very High"))
        .when(col("unique_devices") >= 10, lit("High"))
        .when(col("unique_devices") >= 5, lit("Moderate"))
        .when(col("unique_devices") >= 2, lit("Low"))
        .otherwise(lit("Minimal"))
    ) \
    .withColumn(
        "dominant_activity",
        when(col("stationary_count") > col("walking_count"), lit("Stationary"))
        .when(col("walking_count") > col("stationary_count"), lit("Walking"))
        .otherwise(lit("Mixed"))
    ) \
    .withColumn(
        "patron_share_pct",
        when(col("unique_devices") > 0,
             round(col("patron_devices") * 100.0 / col("unique_devices"), 1))
        .otherwise(lit(0.0))
    ) \
    .withColumn(
        "is_hotspot",
        (col("unique_devices") >= 10).cast("boolean")
    ) \
    .withColumn(
        "time_of_day",
        when(col("event_hour").between(6, 11), lit("Morning"))
        .when(col("event_hour").between(12, 17), lit("Afternoon"))
        .when(col("event_hour").between(18, 23), lit("Evening"))
        .otherwise(lit("Night"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

print(f"H3 density records: {df_h3_density.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write H3 Density

# COMMAND ----------

try:
    if spark.catalog.tableExists(h3_density_table):
        deltaTable = DeltaTable.forName(spark, h3_density_table)
        deltaTable.alias("target").merge(
            df_h3_density.alias("source"),
            "target.h3_index = source.h3_index AND target.event_date = source.event_date AND target.event_hour = source.event_hour"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_h3_density.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .partitionBy("event_date") \
            .saveAsTable(h3_density_table)

    print(f"Merged {df_h3_density.count():,} records into {h3_density_table}")

    spark.sql(f"OPTIMIZE {h3_density_table} ZORDER BY (h3_index, event_hour)")
    print("H3 density table optimized")
except Exception as e:
    print(f"ERROR writing H3 density (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Validation & Summary
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Geofence Summary Overview

# COMMAND ----------

spark.sql(f"""
    SELECT
        geofence_name,
        SUM(total_events) as total_events,
        SUM(enter_count) as enters,
        SUM(exit_count) as exits,
        SUM(dwell_count) as dwells,
        ROUND(AVG(avg_dwell_minutes), 1) as avg_dwell_min,
        SUM(unique_devices) as unique_devices,
        MAX(traffic_level) as peak_traffic
    FROM {geofence_summary_table}
    GROUP BY geofence_name
    ORDER BY total_events DESC
    LIMIT 15
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Device Tracking Overview

# COMMAND ----------

spark.sql(f"""
    SELECT
        device_type_clean as device_type,
        mobility_class,
        COUNT(*) as device_days,
        ROUND(AVG(total_pings), 0) as avg_pings,
        ROUND(AVG(avg_speed_kmh), 1) as avg_speed_kmh,
        ROUND(AVG(distinct_geofences_visited), 1) as avg_geofences,
        ROUND(AVG(indoor_pct), 1) as avg_indoor_pct,
        ROUND(AVG(tracking_duration_hours), 1) as avg_tracking_hrs
    FROM {device_tracking_table}
    GROUP BY device_type_clean, mobility_class
    ORDER BY device_days DESC
""").show(truncate=False)

# Activity pattern distribution
spark.sql(f"""
    SELECT
        activity_pattern,
        COUNT(*) as device_days,
        ROUND(AVG(distinct_h3_cells), 1) as avg_h3_cells,
        ROUND(AVG(stationary_pct), 1) as avg_stationary_pct
    FROM {device_tracking_table}
    GROUP BY activity_pattern
    ORDER BY device_days DESC
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## H3 Density Overview

# COMMAND ----------

spark.sql(f"""
    SELECT
        density_level,
        COUNT(*) as cell_hours,
        SUM(unique_devices) as total_devices,
        SUM(event_count) as total_events,
        ROUND(AVG(patron_share_pct), 1) as avg_patron_pct,
        SUM(CASE WHEN is_hotspot THEN 1 ELSE 0 END) as hotspot_records
    FROM {h3_density_table}
    GROUP BY density_level
    ORDER BY
        CASE density_level
            WHEN 'Very High' THEN 1
            WHEN 'High' THEN 2
            WHEN 'Moderate' THEN 3
            WHEN 'Low' THEN 4
            WHEN 'Minimal' THEN 5
        END
""").show(truncate=False)

# Time of day patterns
spark.sql(f"""
    SELECT
        time_of_day,
        SUM(event_count) as total_events,
        SUM(unique_devices) as total_devices,
        SUM(proximity_triggers) as triggers_fired,
        SUM(CASE WHEN is_hotspot THEN 1 ELSE 0 END) as hotspot_hours
    FROM {h3_density_table}
    GROUP BY time_of_day
    ORDER BY
        CASE time_of_day
            WHEN 'Morning' THEN 1
            WHEN 'Afternoon' THEN 2
            WHEN 'Evening' THEN 3
            WHEN 'Night' THEN 4
        END
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Final Record Counts

# COMMAND ----------

print("=" * 60)
print("GOLD LAYER - GEOLOCATION INSIGHTS - FINAL SUMMARY")
print("=" * 60)
print(f"  {geofence_summary_table}: {spark.table(geofence_summary_table).count():,} records")
print(f"  {device_tracking_table}: {spark.table(device_tracking_table).count():,} records")
print(f"  {h3_density_table}: {spark.table(h3_density_table).count():,} records")
print("=" * 60)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Table | Description | Key Dimensions |
# MAGIC |-------|-------------|----------------|
# MAGIC | gold_geolocation_geofence_summary | Geofence breach and dwell analysis | geofence_id, event_date |
# MAGIC | gold_geolocation_device_tracking | Device movement patterns | device_id, device_type, event_date |
# MAGIC | gold_geolocation_h3_density | H3 spatial density heat maps | h3_index, event_date, event_hour |
# MAGIC
# MAGIC ### Key Metrics Available:
# MAGIC - **Geofence Analysis** - Enter/exit/dwell counts, flow status, dwell duration
# MAGIC - **Device Tracking** - Speed, indoor/outdoor split, activity pattern classification
# MAGIC - **H3 Density** - Device concentration per hex cell, hotspot identification
# MAGIC - **Proximity Triggers** - Trigger effectiveness per geofence and device type
# MAGIC - **Time Patterns** - Morning/Afternoon/Evening/Night distribution across all metrics
# MAGIC
# MAGIC **Ready for:** Power BI Direct Lake, Location Intelligence Dashboard, Patron Journey Analysis
