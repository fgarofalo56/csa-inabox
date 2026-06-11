# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: People Movement Analytics
# MAGIC
# MAGIC This notebook creates aggregated movement analytics tables optimized for
# MAGIC Power BI Direct Lake dashboards and casino operations reporting.
# MAGIC
# MAGIC ## Output Tables:
# MAGIC - **gold_movement_zone_heatmap** - Zone-level heat map data with occupancy and traffic patterns
# MAGIC - **gold_movement_peak_traffic** - Peak traffic analysis by zone, hour, and day of week
# MAGIC - **gold_movement_dwell_summary** - Dwell time summaries and queue analytics by zone
# MAGIC
# MAGIC ## Key Metrics:
# MAGIC - Zone occupancy heat maps (hourly and daily)
# MAGIC - Peak traffic hours and capacity utilization
# MAGIC - Average and max dwell times by zone category
# MAGIC - Queue length, wait time, and detection frequency
# MAGIC - Foot traffic flow direction analysis

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
    desc,
    lit,
    max,
    min,
    percentile_approx,
    round,
    row_number,
    sum,
    when,
    window,
)
from pyspark.sql.window import Window

# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source table
source_table = "lh_silver.silver_people_movement"

# Target tables
zone_heatmap_table = "lh_gold.gold_movement_zone_heatmap"
peak_traffic_table = "lh_gold.gold_movement_peak_traffic"
dwell_summary_table = "lh_gold.gold_movement_dwell_summary"

print(f"Processing batch: {batch_id}")
print(f"Source: {source_table}")
print(f"Targets:")
print(f"  - {zone_heatmap_table}")
print(f"  - {peak_traffic_table}")
print(f"  - {dwell_summary_table}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Load Silver Data

# COMMAND ----------

df_silver = spark.table(source_table)

silver_count = df_silver.count()
print(f"Silver records: {silver_count:,}")
print(f"Unique zones: {df_silver.select('zone_name_clean').distinct().count():,}")
print(f"Unique sensors: {df_silver.select('sensor_id').distinct().count():,}")
print(f"Date range: {df_silver.agg(min('event_date'), max('event_date')).collect()[0]}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Table 1: Zone Heat Map
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Zone Occupancy by Hour

# COMMAND ----------

df_zone_heatmap = df_silver \
    .groupBy(
        "zone_id",
        "zone_name_clean",
        "zone_category",
        "zone_capacity",
        "floor_level",
        "event_date",
        "event_hour"
    ) \
    .agg(
        count("*").alias("reading_count"),
        avg("person_count").alias("avg_person_count"),
        max("person_count").alias("max_person_count"),
        min("person_count").alias("min_person_count"),
        avg("occupancy_pct_recalculated").alias("avg_occupancy_pct"),
        max("occupancy_pct_recalculated").alias("max_occupancy_pct"),

        # Direction analysis
        sum(when(col("direction_clean") == "entering", col("person_count")).otherwise(0)).alias("entering_total"),
        sum(when(col("direction_clean") == "exiting", col("person_count")).otherwise(0)).alias("exiting_total"),
        sum(when(col("direction_clean") == "stationary", col("person_count")).otherwise(0)).alias("stationary_total"),
        sum(when(col("direction_clean") == "passing_through", col("person_count")).otherwise(0)).alias("passing_through_total"),

        # Sensor coverage
        countDistinct("sensor_id").alias("active_sensors"),
        countDistinct("sensor_type_clean").alias("sensor_types_active"),

        # Heat map cell concentration
        countDistinct("heat_map_cell").alias("occupied_cells"),

        # Data quality
        avg("_dq_score").alias("avg_data_quality"),
    )

# Add derived metrics
df_zone_heatmap = df_zone_heatmap \
    .withColumn(
        "net_flow",
        col("entering_total") - col("exiting_total")
    ) \
    .withColumn(
        "flow_direction",
        when(col("net_flow") > 0, lit("INBOUND"))
        .when(col("net_flow") < 0, lit("OUTBOUND"))
        .otherwise(lit("BALANCED"))
    ) \
    .withColumn(
        "congestion_level",
        when(col("avg_occupancy_pct") >= 90, lit("CRITICAL"))
        .when(col("avg_occupancy_pct") >= 70, lit("HIGH"))
        .when(col("avg_occupancy_pct") >= 40, lit("MODERATE"))
        .otherwise(lit("LOW"))
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

print(f"Zone heat map records: {df_zone_heatmap.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Zone Heat Map

# COMMAND ----------

try:
    if spark.catalog.tableExists(zone_heatmap_table):
        deltaTable = DeltaTable.forName(spark, zone_heatmap_table)
        deltaTable.alias("target").merge(
            df_zone_heatmap.alias("source"),
            "target.zone_id = source.zone_id AND target.zone_name_clean = source.zone_name_clean AND target.zone_category = source.zone_category AND target.zone_capacity = source.zone_capacity AND target.floor_level = source.floor_level AND target.event_date = source.event_date AND target.event_hour = source.event_hour"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_zone_heatmap.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .partitionBy("event_date") \
            .saveAsTable(zone_heatmap_table)

    print(f"Merged {spark.table(zone_heatmap_table).count():,} records into {zone_heatmap_table}")

    spark.sql(f"OPTIMIZE {zone_heatmap_table} ZORDER BY (zone_id, event_hour)")
    print("Zone heat map table optimized")
except Exception as e:
    print(f"ERROR writing zone heatmap (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Table 2: Peak Traffic Analysis
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Identify Peak Traffic Patterns

# COMMAND ----------

# Aggregate by zone and day of week + hour to find peak patterns
df_traffic_patterns = df_silver \
    .groupBy(
        "zone_id",
        "zone_name_clean",
        "zone_category",
        "zone_capacity",
        "floor_level",
        "day_of_week",
        "is_weekend",
        "event_hour"
    ) \
    .agg(
        count("*").alias("total_readings"),
        avg("person_count").alias("avg_person_count"),
        max("person_count").alias("max_person_count"),
        avg("occupancy_pct_recalculated").alias("avg_occupancy_pct"),
        max("occupancy_pct_recalculated").alias("peak_occupancy_pct"),
        avg("velocity_mps").alias("avg_velocity_mps"),
        countDistinct("event_date").alias("days_observed"),
    )

# Rank hours within each zone by traffic volume
w_zone_rank = Window.partitionBy("zone_id", "day_of_week").orderBy(col("avg_person_count").desc())

df_peak_traffic = df_traffic_patterns \
    .withColumn("hour_rank", row_number().over(w_zone_rank)) \
    .withColumn(
        "is_peak_hour",
        (col("hour_rank") <= 3).cast("boolean")
    ) \
    .withColumn(
        "traffic_intensity",
        when(col("avg_occupancy_pct") >= 80, lit("Very High"))
        .when(col("avg_occupancy_pct") >= 60, lit("High"))
        .when(col("avg_occupancy_pct") >= 35, lit("Moderate"))
        .when(col("avg_occupancy_pct") >= 15, lit("Low"))
        .otherwise(lit("Very Low"))
    ) \
    .withColumn(
        "day_name",
        when(col("day_of_week") == 1, lit("Sunday"))
        .when(col("day_of_week") == 2, lit("Monday"))
        .when(col("day_of_week") == 3, lit("Tuesday"))
        .when(col("day_of_week") == 4, lit("Wednesday"))
        .when(col("day_of_week") == 5, lit("Thursday"))
        .when(col("day_of_week") == 6, lit("Friday"))
        .when(col("day_of_week") == 7, lit("Saturday"))
    ) \
    .withColumn(
        "time_of_day",
        when(col("event_hour").between(6, 11), lit("Morning"))
        .when(col("event_hour").between(12, 17), lit("Afternoon"))
        .when(col("event_hour").between(18, 23), lit("Evening"))
        .otherwise(lit("Night"))
    ) \
    .withColumn(
        "avg_readings_per_day",
        when(col("days_observed") > 0,
             round(col("total_readings") / col("days_observed"), 1))
        .otherwise(lit(0.0))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

print(f"Peak traffic records: {df_peak_traffic.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Peak Traffic

# COMMAND ----------

try:
    if spark.catalog.tableExists(peak_traffic_table):
        deltaTable = DeltaTable.forName(spark, peak_traffic_table)
        deltaTable.alias("target").merge(
            df_peak_traffic.alias("source"),
            "target.zone_id = source.zone_id AND target.zone_name_clean = source.zone_name_clean AND target.zone_category = source.zone_category AND target.zone_capacity = source.zone_capacity AND target.floor_level = source.floor_level AND target.day_of_week = source.day_of_week AND target.is_weekend = source.is_weekend AND target.event_hour = source.event_hour"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_peak_traffic.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .saveAsTable(peak_traffic_table)

    print(f"Merged {df_peak_traffic.count():,} records into {peak_traffic_table}")

    spark.sql(f"OPTIMIZE {peak_traffic_table} ZORDER BY (zone_id, day_of_week)")
    print("Peak traffic table optimized")
except Exception as e:
    print(f"ERROR writing peak traffic (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Table 3: Dwell Time and Queue Summary
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Dwell and Queue Metrics by Zone and Day

# COMMAND ----------

df_dwell_summary = df_silver \
    .groupBy(
        "zone_id",
        "zone_name_clean",
        "zone_category",
        "floor_level",
        "event_date"
    ) \
    .agg(
        count("*").alias("total_readings"),

        # Dwell time metrics
        avg("dwell_time_seconds").alias("avg_dwell_seconds"),
        max("dwell_time_seconds").alias("max_dwell_seconds"),
        min("dwell_time_seconds").alias("min_dwell_seconds"),
        percentile_approx("dwell_time_seconds", 0.5).alias("median_dwell_seconds"),
        percentile_approx("dwell_time_seconds", 0.9).alias("p90_dwell_seconds"),
        avg("dwell_time_minutes").alias("avg_dwell_minutes"),

        # Queue metrics
        sum(when(col("queue_detected") == True, 1).otherwise(0)).alias("queue_detected_count"),
        avg(when(col("queue_detected") == True, col("queue_length"))).alias("avg_queue_length"),
        max(when(col("queue_detected") == True, col("queue_length"))).alias("max_queue_length"),
        avg(when(col("queue_detected") == True, col("queue_wait_minutes"))).alias("avg_queue_wait_min"),
        max(when(col("queue_detected") == True, col("queue_wait_minutes"))).alias("max_queue_wait_min"),

        # Occupancy metrics
        avg("occupancy_pct_recalculated").alias("avg_occupancy_pct"),
        max("occupancy_pct_recalculated").alias("max_occupancy_pct"),
        avg("person_count").alias("avg_person_count"),
        max("person_count").alias("max_person_count"),

        # Velocity
        avg("velocity_mps").alias("avg_velocity_mps"),
    )

# Add derived metrics
df_dwell_summary = df_dwell_summary \
    .withColumn(
        "queue_detection_rate_pct",
        when(col("total_readings") > 0,
             round(col("queue_detected_count") * 100.0 / col("total_readings"), 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn(
        "dwell_category",
        when(col("avg_dwell_minutes") > 60, lit("Extended"))
        .when(col("avg_dwell_minutes") > 30, lit("Long"))
        .when(col("avg_dwell_minutes") > 10, lit("Medium"))
        .when(col("avg_dwell_minutes") > 2, lit("Short"))
        .otherwise(lit("Transient"))
    ) \
    .withColumn(
        "queue_severity",
        when(col("avg_queue_wait_min") > 20, lit("CRITICAL"))
        .when(col("avg_queue_wait_min") > 10, lit("HIGH"))
        .when(col("avg_queue_wait_min") > 5, lit("MODERATE"))
        .when(col("queue_detected_count") > 0, lit("LOW"))
        .otherwise(lit("NONE"))
    ) \
    .withColumn(
        "movement_pattern",
        when(col("avg_velocity_mps") < 0.3, lit("Stationary"))
        .when(col("avg_velocity_mps") < 0.8, lit("Slow"))
        .when(col("avg_velocity_mps") < 1.5, lit("Normal"))
        .otherwise(lit("Fast"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

print(f"Dwell summary records: {df_dwell_summary.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Dwell Summary

# COMMAND ----------

try:
    if spark.catalog.tableExists(dwell_summary_table):
        deltaTable = DeltaTable.forName(spark, dwell_summary_table)
        deltaTable.alias("target").merge(
            df_dwell_summary.alias("source"),
            "target.zone_id = source.zone_id AND target.zone_name_clean = source.zone_name_clean AND target.zone_category = source.zone_category AND target.floor_level = source.floor_level AND target.event_date = source.event_date"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_dwell_summary.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .partitionBy("event_date") \
            .saveAsTable(dwell_summary_table)

    print(f"Merged {df_dwell_summary.count():,} records into {dwell_summary_table}")

    spark.sql(f"OPTIMIZE {dwell_summary_table} ZORDER BY (zone_id, zone_category)")
    print("Dwell summary table optimized")
except Exception as e:
    print(f"ERROR writing dwell summary (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Validation & Summary
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Zone Heat Map Overview

# COMMAND ----------

spark.sql(f"""
    SELECT
        zone_category,
        COUNT(*) as zone_hour_records,
        ROUND(AVG(avg_occupancy_pct), 1) as avg_occupancy,
        ROUND(MAX(max_occupancy_pct), 1) as peak_occupancy,
        ROUND(AVG(avg_person_count), 0) as avg_person_count,
        SUM(entering_total) as total_entering,
        SUM(exiting_total) as total_exiting
    FROM {zone_heatmap_table}
    GROUP BY zone_category
    ORDER BY avg_occupancy DESC
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Peak Traffic Overview

# COMMAND ----------

# Top 10 busiest zone-hours
spark.sql(f"""
    SELECT
        zone_name_clean as zone,
        day_name,
        event_hour,
        ROUND(avg_person_count, 0) as avg_people,
        ROUND(avg_occupancy_pct, 1) as avg_occupancy_pct,
        traffic_intensity
    FROM {peak_traffic_table}
    WHERE is_peak_hour = true
    ORDER BY avg_person_count DESC
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Queue and Dwell Overview

# COMMAND ----------

# Zones with highest queue impact
spark.sql(f"""
    SELECT
        zone_name_clean as zone,
        zone_category,
        dwell_category,
        ROUND(avg_dwell_minutes, 1) as avg_dwell_min,
        queue_severity,
        ROUND(avg_queue_wait_min, 1) as avg_queue_wait_min,
        ROUND(queue_detection_rate_pct, 1) as queue_rate_pct
    FROM {dwell_summary_table}
    WHERE queue_detected_count > 0
    ORDER BY avg_queue_wait_min DESC
    LIMIT 15
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Final Record Counts

# COMMAND ----------

print("=" * 60)
print("GOLD LAYER - MOVEMENT ANALYTICS - FINAL SUMMARY")
print("=" * 60)
print(f"  {zone_heatmap_table}: {spark.table(zone_heatmap_table).count():,} records")
print(f"  {peak_traffic_table}: {spark.table(peak_traffic_table).count():,} records")
print(f"  {dwell_summary_table}: {spark.table(dwell_summary_table).count():,} records")
print("=" * 60)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Table | Description | Key Dimensions |
# MAGIC |-------|-------------|----------------|
# MAGIC | gold_movement_zone_heatmap | Hourly zone occupancy heat map | zone_id, event_date, event_hour |
# MAGIC | gold_movement_peak_traffic | Peak traffic by zone and day | zone_id, day_of_week, event_hour |
# MAGIC | gold_movement_dwell_summary | Dwell time and queue analytics | zone_id, event_date |
# MAGIC
# MAGIC ### Key Metrics Available:
# MAGIC - **Zone Heat Maps** - Hourly person counts, occupancy, and traffic flow direction
# MAGIC - **Peak Traffic** - Top 3 busiest hours per zone per day, traffic intensity
# MAGIC - **Dwell Time** - Average, median, P90 dwell times by zone
# MAGIC - **Queue Analytics** - Queue detection rate, average wait time, queue severity
# MAGIC - **Movement Patterns** - Flow direction (inbound/outbound), velocity categories
# MAGIC
# MAGIC **Ready for:** Power BI Direct Lake, Casino Floor Optimization, Queue Management Dashboard
