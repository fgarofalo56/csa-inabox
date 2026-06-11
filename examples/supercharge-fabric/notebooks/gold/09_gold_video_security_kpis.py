# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Video Security KPIs
# MAGIC
# MAGIC This notebook creates aggregated video security analytics tables optimized for
# MAGIC Power BI Direct Lake dashboards and security operations reporting.
# MAGIC
# MAGIC ## Output Tables:
# MAGIC - **gold_video_alert_summary** - Alert frequency by camera, location, event type, and time
# MAGIC - **gold_video_camera_utilization** - Camera uptime, event volume, and model performance
# MAGIC - **gold_video_incident_trends** - Daily/hourly incident trends with anomaly detection
# MAGIC
# MAGIC ## Key Metrics:
# MAGIC - Alert frequency by severity (INFO/WARNING/CRITICAL)
# MAGIC - Camera event volume and utilization rates
# MAGIC - Incident trends with hour-of-day and day-of-week patterns
# MAGIC - Security event concentration by zone
# MAGIC - Model confidence distributions

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
    lit,
    max,
    min,
    percentile_approx,
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
source_table = "lh_silver.silver_video_analytics"

# Target tables
alert_summary_table = "lh_gold.gold_video_alert_summary"
camera_util_table = "lh_gold.gold_video_camera_utilization"
incident_trends_table = "lh_gold.gold_video_incident_trends"

print(f"Processing batch: {batch_id}")
print(f"Source: {source_table}")
print(f"Targets:")
print(f"  - {alert_summary_table}")
print(f"  - {camera_util_table}")
print(f"  - {incident_trends_table}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Load Silver Data

# COMMAND ----------

df_silver = spark.table(source_table)

silver_count = df_silver.count()
print(f"Silver records: {silver_count:,}")
print(f"Unique cameras: {df_silver.select('camera_id').distinct().count():,}")
print(f"Date range: {df_silver.agg(min('event_date'), max('event_date')).collect()[0]}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Table 1: Alert Summary
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Alerts by Camera, Location, Event Type, and Day

# COMMAND ----------

df_alert_summary = df_silver \
    .groupBy(
        "camera_id",
        "camera_location_clean",
        "event_type_clean",
        "alert_level_clean",
        "event_date"
    ) \
    .agg(
        count("*").alias("event_count"),
        avg("confidence_score").alias("avg_confidence"),
        min("confidence_score").alias("min_confidence"),
        max("confidence_score").alias("max_confidence"),
        max("alert_severity_score").alias("max_severity"),

        # Security event counts
        sum(when(col("is_security_event"), 1).otherwise(0)).alias("security_event_count"),
        sum(when(col("is_critical"), 1).otherwise(0)).alias("critical_event_count"),

        # Object class breakdown
        sum(when(col("object_class_clean") == "person", 1).otherwise(0)).alias("person_detections"),
        sum(when(col("object_class_clean") == "vehicle", 1).otherwise(0)).alias("vehicle_detections"),
        sum(when(col("object_class_clean") == "weapon", 1).otherwise(0)).alias("weapon_detections"),

        # Temporal patterns
        countDistinct("event_hour").alias("active_hours"),
        min("timestamp").alias("first_event_time"),
        max("timestamp").alias("last_event_time"),

        # Data quality
        avg("_dq_score").alias("avg_data_quality"),
    )

# Add derived metrics
df_alert_summary = df_alert_summary \
    .withColumn(
        "events_per_active_hour",
        when(col("active_hours") > 0,
             round(col("event_count") / col("active_hours"), 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn(
        "security_event_pct",
        when(col("event_count") > 0,
             round(col("security_event_count") * 100.0 / col("event_count"), 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn(
        "alert_priority",
        when(col("critical_event_count") > 5, lit("URGENT"))
        .when(col("critical_event_count") > 0, lit("HIGH"))
        .when(col("security_event_count") > 10, lit("MEDIUM"))
        .otherwise(lit("LOW"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

print(f"Alert summary records: {df_alert_summary.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Alert Summary

# COMMAND ----------

try:
    if spark.catalog.tableExists(alert_summary_table):
        deltaTable = DeltaTable.forName(spark, alert_summary_table)
        deltaTable.alias("target").merge(
            df_alert_summary.alias("source"),
            "target.camera_id = source.camera_id AND target.camera_location_clean = source.camera_location_clean AND target.event_type_clean = source.event_type_clean AND target.alert_level_clean = source.alert_level_clean AND target.event_date = source.event_date"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_alert_summary.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .partitionBy("event_date") \
            .saveAsTable(alert_summary_table)

    print(f"Merged {spark.table(alert_summary_table).count():,} records into {alert_summary_table}")

    spark.sql(f"OPTIMIZE {alert_summary_table} ZORDER BY (camera_id, event_type_clean)")
    print("Alert summary table optimized")
except Exception as e:
    print(f"ERROR in unknown (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Table 2: Camera Utilization
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Camera Performance Metrics

# COMMAND ----------

df_camera_util = df_silver \
    .groupBy(
        "camera_id",
        "camera_location_clean",
        "event_date"
    ) \
    .agg(
        count("*").alias("total_events"),
        countDistinct("event_type_clean").alias("distinct_event_types"),
        countDistinct("event_hour").alias("active_hours"),

        # Event type breakdown
        sum(when(col("event_type_clean") == "object_detection", 1).otherwise(0)).alias("object_detection_count"),
        sum(when(col("event_type_clean") == "zone_crossing", 1).otherwise(0)).alias("zone_crossing_count"),
        sum(when(col("event_type_clean") == "anomaly", 1).otherwise(0)).alias("anomaly_count"),
        sum(when(col("event_type_clean") == "face_match", 1).otherwise(0)).alias("face_match_count"),
        sum(when(col("event_type_clean") == "crowd_density", 1).otherwise(0)).alias("crowd_density_count"),
        sum(when(col("event_type_clean") == "loitering", 1).otherwise(0)).alias("loitering_count"),
        sum(when(col("event_type_clean") == "tailgating", 1).otherwise(0)).alias("tailgating_count"),
        sum(when(col("event_type_clean") == "abandoned_object", 1).otherwise(0)).alias("abandoned_object_count"),

        # Confidence metrics
        avg("confidence_score").alias("avg_confidence"),
        percentile_approx("confidence_score", 0.5).alias("median_confidence"),

        # Alert counts
        sum(when(col("alert_level_clean") == "INFO", 1).otherwise(0)).alias("info_alerts"),
        sum(when(col("alert_level_clean") == "WARNING", 1).otherwise(0)).alias("warning_alerts"),
        sum(when(col("alert_level_clean") == "CRITICAL", 1).otherwise(0)).alias("critical_alerts"),

        # Model usage
        countDistinct("model_name").alias("distinct_models"),

        # Temporal coverage
        min("timestamp").alias("first_event"),
        max("timestamp").alias("last_event"),

        # Data quality
        avg("_dq_score").alias("avg_data_quality"),
    )

# Calculate utilization metrics
df_camera_util = df_camera_util \
    .withColumn(
        "utilization_pct",
        round(col("active_hours") / 24.0 * 100, 1)
    ) \
    .withColumn(
        "events_per_hour",
        when(col("active_hours") > 0,
             round(col("total_events") / col("active_hours"), 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn(
        "operating_duration_hours",
        round(
            (unix_timestamp(col("last_event")) - unix_timestamp(col("first_event"))) / 3600.0,
            2
        )
    ) \
    .withColumn(
        "camera_status",
        when(col("active_hours") >= 20, lit("HIGH_UTILIZATION"))
        .when(col("active_hours") >= 12, lit("NORMAL"))
        .when(col("active_hours") >= 4, lit("LOW_UTILIZATION"))
        .otherwise(lit("MINIMAL_ACTIVITY"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

print(f"Camera utilization records: {df_camera_util.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Camera Utilization

# COMMAND ----------

try:
    if spark.catalog.tableExists(camera_util_table):
        deltaTable = DeltaTable.forName(spark, camera_util_table)
        deltaTable.alias("target").merge(
            df_camera_util.alias("source"),
            "target.camera_id = source.camera_id AND target.camera_location_clean = source.camera_location_clean AND target.event_date = source.event_date"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_camera_util.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .partitionBy("event_date") \
            .saveAsTable(camera_util_table)

    print(f"Merged {df_camera_util.count():,} records into {camera_util_table}")

    spark.sql(f"OPTIMIZE {camera_util_table} ZORDER BY (camera_id, camera_location_clean)")
    print("Camera utilization table optimized")
except Exception as e:
    print(f"ERROR writing camera utilization (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Table 3: Incident Trends
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Hourly Incident Trends by Location

# COMMAND ----------

df_incident_trends = df_silver \
    .groupBy(
        "camera_location_clean",
        "event_date",
        "event_hour",
        "day_of_week",
        "is_weekend"
    ) \
    .agg(
        count("*").alias("total_events"),
        sum(when(col("is_security_event"), 1).otherwise(0)).alias("security_events"),
        sum(when(col("is_critical"), 1).otherwise(0)).alias("critical_events"),

        # Specific incident types
        sum(when(col("event_type_clean") == "anomaly", 1).otherwise(0)).alias("anomaly_events"),
        sum(when(col("event_type_clean") == "loitering", 1).otherwise(0)).alias("loitering_events"),
        sum(when(col("event_type_clean") == "tailgating", 1).otherwise(0)).alias("tailgating_events"),
        sum(when(col("event_type_clean") == "abandoned_object", 1).otherwise(0)).alias("abandoned_object_events"),
        sum(when(col("event_type_clean") == "face_match", 1).otherwise(0)).alias("face_match_events"),
        sum(when(col("event_type_clean") == "crowd_density", 1).otherwise(0)).alias("crowd_density_events"),

        # Crowd metrics
        avg(when(col("event_type_clean") == "crowd_density", col("object_count"))).alias("avg_crowd_size"),
        max(when(col("event_type_clean") == "crowd_density", col("object_count"))).alias("max_crowd_size"),

        # Dwell time for loitering
        avg(when(col("event_type_clean") == "loitering", col("dwell_time_seconds"))).alias("avg_loitering_seconds"),
        max(when(col("event_type_clean") == "loitering", col("dwell_time_seconds"))).alias("max_loitering_seconds"),

        # Confidence
        avg("confidence_score").alias("avg_confidence"),

        # Camera coverage
        countDistinct("camera_id").alias("active_cameras"),
    )

# Add trend analysis columns
w_location = Window.partitionBy("camera_location_clean").orderBy("event_date", "event_hour")

df_incident_trends = df_incident_trends \
    .withColumn(
        "security_event_rate",
        when(col("total_events") > 0,
             round(col("security_events") * 100.0 / col("total_events"), 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn(
        "time_of_day",
        when(col("event_hour").between(6, 11), lit("Morning"))
        .when(col("event_hour").between(12, 17), lit("Afternoon"))
        .when(col("event_hour").between(18, 23), lit("Evening"))
        .otherwise(lit("Night"))
    ) \
    .withColumn(
        "risk_level",
        when(col("critical_events") > 3, lit("HIGH"))
        .when(col("security_events") > 10, lit("ELEVATED"))
        .when(col("security_events") > 0, lit("NORMAL"))
        .otherwise(lit("LOW"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

print(f"Incident trend records: {df_incident_trends.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write Incident Trends

# COMMAND ----------

try:
    if spark.catalog.tableExists(incident_trends_table):
        deltaTable = DeltaTable.forName(spark, incident_trends_table)
        deltaTable.alias("target").merge(
            df_incident_trends.alias("source"),
            "target.camera_location_clean = source.camera_location_clean AND target.event_date = source.event_date AND target.event_hour = source.event_hour AND target.day_of_week = source.day_of_week AND target.is_weekend = source.is_weekend"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_incident_trends.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .partitionBy("event_date") \
            .saveAsTable(incident_trends_table)

    print(f"Merged {df_incident_trends.count():,} records into {incident_trends_table}")

    spark.sql(f"OPTIMIZE {incident_trends_table} ZORDER BY (camera_location_clean, event_hour)")
    print("Incident trends table optimized")
except Exception as e:
    print(f"ERROR writing incident trends (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC # Validation & Summary
# MAGIC ---

# COMMAND ----------

# MAGIC %md
# MAGIC ## Alert Summary Overview

# COMMAND ----------

spark.sql(f"""
    SELECT
        alert_level_clean as alert_level,
        COUNT(*) as records,
        SUM(event_count) as total_events,
        SUM(critical_event_count) as critical_events,
        ROUND(AVG(avg_confidence), 4) as avg_confidence
    FROM {alert_summary_table}
    GROUP BY alert_level_clean
    ORDER BY total_events DESC
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Camera Utilization Overview

# COMMAND ----------

spark.sql(f"""
    SELECT
        camera_status,
        COUNT(*) as camera_days,
        ROUND(AVG(utilization_pct), 1) as avg_utilization_pct,
        ROUND(AVG(events_per_hour), 2) as avg_events_per_hour,
        SUM(critical_alerts) as total_critical_alerts
    FROM {camera_util_table}
    GROUP BY camera_status
    ORDER BY camera_days DESC
""").show(truncate=False)

# Top 10 cameras by event volume
spark.sql(f"""
    SELECT
        camera_id,
        camera_location_clean as location,
        SUM(total_events) as total_events,
        ROUND(AVG(utilization_pct), 1) as avg_utilization,
        SUM(critical_alerts) as critical_alerts
    FROM {camera_util_table}
    GROUP BY camera_id, camera_location_clean
    ORDER BY total_events DESC
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Incident Trends Overview

# COMMAND ----------

spark.sql(f"""
    SELECT
        camera_location_clean as location,
        SUM(security_events) as security_events,
        SUM(critical_events) as critical_events,
        SUM(anomaly_events) as anomalies,
        SUM(loitering_events) as loitering,
        SUM(tailgating_events) as tailgating
    FROM {incident_trends_table}
    GROUP BY camera_location_clean
    ORDER BY security_events DESC
""").show(truncate=False)

# Time of day patterns
spark.sql(f"""
    SELECT
        time_of_day,
        SUM(total_events) as total_events,
        SUM(security_events) as security_events,
        ROUND(AVG(security_event_rate), 2) as avg_security_rate_pct
    FROM {incident_trends_table}
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
print("GOLD LAYER - VIDEO SECURITY KPIS - FINAL SUMMARY")
print("=" * 60)
print(f"  {alert_summary_table}: {spark.table(alert_summary_table).count():,} records")
print(f"  {camera_util_table}: {spark.table(camera_util_table).count():,} records")
print(f"  {incident_trends_table}: {spark.table(incident_trends_table).count():,} records")
print("=" * 60)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC | Table | Description | Key Dimensions |
# MAGIC |-------|-------------|----------------|
# MAGIC | gold_video_alert_summary | Alert frequency and severity | camera_id, event_type, alert_level, event_date |
# MAGIC | gold_video_camera_utilization | Camera uptime and event volume | camera_id, camera_location, event_date |
# MAGIC | gold_video_incident_trends | Hourly incident patterns | camera_location, event_date, event_hour |
# MAGIC
# MAGIC ### Key Metrics Available:
# MAGIC - **Alert Priority** - URGENT/HIGH/MEDIUM/LOW based on critical event counts
# MAGIC - **Camera Utilization** - Active hours, events per hour, operating duration
# MAGIC - **Security Event Rate** - Percentage of events classified as security incidents
# MAGIC - **Time of Day Patterns** - Morning/Afternoon/Evening/Night security distributions
# MAGIC - **Risk Level** - Location-based risk assessment per time window
# MAGIC
# MAGIC **Ready for:** Power BI Direct Lake, Security Operations Dashboard, Incident Response
