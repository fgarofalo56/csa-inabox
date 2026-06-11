# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: DOI Natural Resources Analytics
# MAGIC
# MAGIC This notebook creates aggregated Department of the Interior analytics tables optimized for
# MAGIC Power BI Direct Lake dashboards and natural resources executive reporting.
# MAGIC
# MAGIC ## Output Tables:
# MAGIC - **gold_doi_seismic_risk** - Regional seismic activity, significant events, tsunami tracking
# MAGIC - **gold_doi_water_resources** - State-level streamflow, monitoring coverage, drought indicators
# MAGIC - **gold_doi_park_performance** - National park visitation KPIs with regional ranking
# MAGIC - **gold_doi_natural_resources_dashboard** - Cross-domain executive dashboard combining all DOI data
# MAGIC
# MAGIC ## Key Metrics:
# MAGIC - Earthquake counts, significant events (mag 4.5+), felt reports
# MAGIC - Streamflow averages, monitoring site coverage, anomaly detection
# MAGIC - Park visitation trends, peak months, camping rates
# MAGIC - Unified natural resources health indicators

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
    desc,
    greatest,
    lag,
    lit,
    max,
    min,
    month,
    round,
    row_number,
    stddev,
    sum,
    to_date,
    when,
    window,
    year,
)
from pyspark.sql.window import Window

# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source tables (Silver)
SOURCE_EARTHQUAKES = "lh_silver.silver_doi_earthquakes"
SOURCE_WATER_SITES = "lh_silver.silver_doi_water_sites"
SOURCE_STREAMFLOW = "lh_silver.silver_doi_streamflow"
SOURCE_PARK_VISITS = "lh_silver.silver_doi_park_visitation"

# Target tables (Gold)
TARGET_SEISMIC_RISK = "lh_gold.gold_doi_seismic_risk"
TARGET_WATER_RESOURCES = "lh_gold.gold_doi_water_resources"
TARGET_PARK_PERFORMANCE = "lh_gold.gold_doi_park_performance"
TARGET_NR_DASHBOARD = "lh_gold.gold_doi_natural_resources_dashboard"

print(f"Processing batch: {batch_id}")
print(f"Sources:")
print(f"  - {SOURCE_EARTHQUAKES}")
print(f"  - {SOURCE_WATER_SITES}")
print(f"  - {SOURCE_STREAMFLOW}")
print(f"  - {SOURCE_PARK_VISITS}")
print(f"Targets:")
print(f"  - {TARGET_SEISMIC_RISK}")
print(f"  - {TARGET_WATER_RESOURCES}")
print(f"  - {TARGET_PARK_PERFORMANCE}")
print(f"  - {TARGET_NR_DASHBOARD}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Data

# COMMAND ----------

df_earthquakes = spark.table(SOURCE_EARTHQUAKES)
df_water_sites = spark.table(SOURCE_WATER_SITES)
df_streamflow = spark.table(SOURCE_STREAMFLOW)
df_park_visits = spark.table(SOURCE_PARK_VISITS)

print(f"Silver earthquakes:      {df_earthquakes.count():,} records")
print(f"Silver water sites:      {df_water_sites.count():,} records")
print(f"Silver streamflow:       {df_streamflow.count():,} records")
print(f"Silver park visitation:  {df_park_visits.count():,} records")

eq_date_range = df_earthquakes.agg(
    min("event_time"), max("event_time")
).collect()[0]
print(f"Earthquake date range: {eq_date_range[0]} to {eq_date_range[1]}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 1: Seismic Risk

# COMMAND ----------

# MAGIC %md
# MAGIC ### Aggregate Seismic Activity by Region and Year

# COMMAND ----------

df_seismic_agg = df_earthquakes \
    .withColumn("event_year", year("event_time")) \
    .withColumn("event_date", to_date("event_time")) \
    .groupBy("region", "event_year") \
    .agg(
        # Event counts
        count("*").alias("total_earthquakes"),
        sum(when(col("magnitude") >= 4.5, 1).otherwise(0)).alias("significant_events"),
        sum(when(col("magnitude") >= 6.0, 1).otherwise(0)).alias("major_events"),
        sum(when(col("magnitude") >= 7.0, 1).otherwise(0)).alias("great_events"),

        # Magnitude statistics
        round(max("magnitude"), 1).alias("max_magnitude"),
        round(avg("magnitude"), 2).alias("avg_magnitude"),
        round(stddev("magnitude"), 2).alias("stddev_magnitude"),

        # Depth statistics
        round(avg("depth_km"), 1).alias("avg_depth"),
        round(min("depth_km"), 1).alias("min_depth"),
        round(max("depth_km"), 1).alias("max_depth"),

        # Tsunami events
        sum(when(col("tsunami_flag") == True, 1).otherwise(0)).alias("tsunami_events"),

        # Felt reports
        sum(coalesce(col("felt_reports"), lit(0))).alias("felt_reports_total"),
        round(avg(coalesce(col("felt_reports"), lit(0))), 1).alias("avg_felt_reports"),
        max(coalesce(col("felt_reports"), lit(0))).alias("max_felt_reports"),

        # Alert levels
        sum(when(col("alert_level") == "red", 1).otherwise(0)).alias("red_alerts"),
        sum(when(col("alert_level") == "orange", 1).otherwise(0)).alias("orange_alerts"),
        sum(when(col("alert_level") == "yellow", 1).otherwise(0)).alias("yellow_alerts"),

        # Geographic spread
        countDistinct("place").alias("distinct_locations"),
        countDistinct(event_date).alias("days_with_activity"),

        # Estimated impact
        round(sum(coalesce(col("estimated_damage_usd"), lit(0))), 2).alias("estimated_damage_usd"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Seismic Risk Metrics

# COMMAND ----------

yoy_seismic_window = Window.partitionBy("region").orderBy("event_year")
rolling_5yr_seismic = Window.partitionBy("region").orderBy("event_year").rowsBetween(-4, 0)

df_seismic_risk = df_seismic_agg \
    .withColumn("event_frequency",
        when(col("days_with_activity") > 0,
            round(col("total_earthquakes") / col("days_with_activity"), 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("significant_event_pct",
        when(col("total_earthquakes") > 0,
            round(col("significant_events") / col("total_earthquakes") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("rolling_5yr_avg_events",
        round(avg("total_earthquakes").over(rolling_5yr_seismic), 1)
    ) \
    .withColumn("prev_year_events",
        lag("total_earthquakes", 1).over(yoy_seismic_window)
    ) \
    .withColumn("yoy_change_pct",
        when(col("prev_year_events").isNotNull() & (col("prev_year_events") > 0),
            round((col("total_earthquakes") - col("prev_year_events")) /
                  col("prev_year_events") * 100, 2))
        .otherwise(lit(None))
    ) \
    .drop("prev_year_events")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Seismic Risk Tier and Metadata

# COMMAND ----------

risk_rank_window = Window.partitionBy("event_year").orderBy(col("total_earthquakes").desc())

df_seismic_final = df_seismic_risk \
    .withColumn("seismic_risk_tier",
        when((col("significant_events") >= 10) | (col("max_magnitude") >= 6.0), lit("VERY_HIGH"))
        .when((col("significant_events") >= 5) | (col("max_magnitude") >= 5.0), lit("HIGH"))
        .when(col("significant_events") >= 1, lit("MODERATE"))
        .when(col("total_earthquakes") >= 10, lit("LOW"))
        .otherwise(lit("MINIMAL"))
    ) \
    .withColumn("regional_rank",
        row_number().over(risk_rank_window)
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Seismic Risk Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_SEISMIC_RISK):
        deltaTable = DeltaTable.forName(spark, TARGET_SEISMIC_RISK)
        deltaTable.alias("target").merge(
            df_seismic_final.alias("source"),
            "target.region = source.region AND target.event_year = source.event_year"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_seismic_final.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("event_year") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_SEISMIC_RISK)

    print(f"Merged {spark.table(TARGET_SEISMIC_RISK).count():,} records into {TARGET_SEISMIC_RISK}")
except Exception as e:
    print(f"ERROR writing seismic risk (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 2: Water Resources

# COMMAND ----------

# MAGIC %md
# MAGIC ### Aggregate Streamflow by State and Year

# COMMAND ----------

# Enrich streamflow with site metadata
df_flow_enriched = df_streamflow.alias("f") \
    .join(
        df_water_sites.select(
            col("site_id"),
            col("state").alias("site_state"),
            col("site_name"),
            col("site_type"),
            col("drainage_area_sq_mi"),
        ).alias("s"),
        col("f.site_id") == col("s.site_id"),
        "left"
    )

# COMMAND ----------

# State-year level aggregation
df_water_agg = df_flow_enriched \
    .withColumn("measurement_year", year("measurement_date")) \
    .groupBy("site_state", "measurement_year") \
    .agg(
        # Streamflow KPIs
        round(avg("streamflow_cfs"), 2).alias("avg_streamflow"),
        round(max("streamflow_cfs"), 2).alias("max_streamflow"),
        round(min("streamflow_cfs"), 2).alias("min_streamflow"),
        round(stddev("streamflow_cfs"), 2).alias("stddev_streamflow"),

        # Gage height
        round(avg(coalesce(col("gage_height_ft"), lit(0))), 2).alias("avg_gage_height"),
        round(max(coalesce(col("gage_height_ft"), lit(0))), 2).alias("max_gage_height"),

        # Monitoring coverage
        countDistinct("f.site_id").alias("monitoring_sites"),
        countDistinct("site_type").alias("site_type_diversity"),

        # Parameter coverage
        countDistinct("parameter_code").alias("parameter_coverage"),

        # Data quality
        count("*").alias("total_measurements"),
        countDistinct("measurement_date").alias("days_with_data"),

        # Anomaly detection (measurements outside 2 stddev)
        sum(when(col("quality_flag").isin("ANOMALY", "SUSPECT", "ESTIMATED"), 1).otherwise(0)).alias("anomaly_count"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Drought Indicators and Trends

# COMMAND ----------

yoy_water_window = Window.partitionBy("site_state").orderBy("measurement_year")

df_water_resources = df_water_agg \
    .withColumn("prev_year_avg_flow",
        lag("avg_streamflow", 1).over(yoy_water_window)
    ) \
    .withColumn("flow_change_pct",
        when(col("prev_year_avg_flow").isNotNull() & (col("prev_year_avg_flow") > 0),
            round((col("avg_streamflow") - col("prev_year_avg_flow")) /
                  col("prev_year_avg_flow") * 100, 2))
        .otherwise(lit(None))
    ) \
    .withColumn("drought_indicator",
        when(col("flow_change_pct") < -30, lit("SEVERE_DROUGHT"))
        .when(col("flow_change_pct") < -15, lit("MODERATE_DROUGHT"))
        .when(col("flow_change_pct") < -5, lit("MILD_DROUGHT"))
        .when(col("flow_change_pct").isNull(), lit("BASELINE"))
        .otherwise(lit("NORMAL"))
    ) \
    .withColumn("flow_variability",
        when(col("avg_streamflow") > 0,
            round(col("stddev_streamflow") / col("avg_streamflow"), 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("anomaly_rate",
        when(col("total_measurements") > 0,
            round(col("anomaly_count") / col("total_measurements") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .drop("prev_year_avg_flow") \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Water Resources Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_WATER_RESOURCES):
        deltaTable = DeltaTable.forName(spark, TARGET_WATER_RESOURCES)
        deltaTable.alias("target").merge(
            df_water_resources.alias("source"),
            "target.site_state = source.site_state AND target.measurement_year = source.measurement_year"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_water_resources.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("measurement_year") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_WATER_RESOURCES)

    print(f"Merged {df_water_resources.count():,} records into {TARGET_WATER_RESOURCES}")
except Exception as e:
    print(f"ERROR writing water resources (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 3: Park Performance

# COMMAND ----------

# MAGIC %md
# MAGIC ### Annual Park Visitation Aggregation

# COMMAND ----------

df_park_annual = df_park_visits \
    .withColumn("visit_year", year("report_date")) \
    .withColumn("visit_month", month("report_date")) \
    .groupBy("park_code", "park_name", "region", "state", "visit_year") \
    .agg(
        # Total visitation
        sum("visitor_count").alias("total_visitors"),

        # Monthly breakdown for peak detection
        sum(when(col("visit_month") == 1, col("visitor_count")).otherwise(0)).alias("jan_visitors"),
        sum(when(col("visit_month") == 2, col("visitor_count")).otherwise(0)).alias("feb_visitors"),
        sum(when(col("visit_month") == 3, col("visitor_count")).otherwise(0)).alias("mar_visitors"),
        sum(when(col("visit_month") == 4, col("visitor_count")).otherwise(0)).alias("apr_visitors"),
        sum(when(col("visit_month") == 5, col("visitor_count")).otherwise(0)).alias("may_visitors"),
        sum(when(col("visit_month") == 6, col("visitor_count")).otherwise(0)).alias("jun_visitors"),
        sum(when(col("visit_month") == 7, col("visitor_count")).otherwise(0)).alias("jul_visitors"),
        sum(when(col("visit_month") == 8, col("visitor_count")).otherwise(0)).alias("aug_visitors"),
        sum(when(col("visit_month") == 9, col("visitor_count")).otherwise(0)).alias("sep_visitors"),
        sum(when(col("visit_month") == 10, col("visitor_count")).otherwise(0)).alias("oct_visitors"),
        sum(when(col("visit_month") == 11, col("visitor_count")).otherwise(0)).alias("nov_visitors"),
        sum(when(col("visit_month") == 12, col("visitor_count")).otherwise(0)).alias("dec_visitors"),

        # Visit type breakdown
        sum(coalesce(col("recreation_visitors"), lit(0))).alias("recreation_visitors"),
        sum(coalesce(col("camping_visitors"), lit(0))).alias("camping_visitors"),
        sum(coalesce(col("backcountry_visitors"), lit(0))).alias("backcountry_visitors"),
        sum(coalesce(col("concession_visitors"), lit(0))).alias("concession_visitors"),

        # Reporting coverage
        countDistinct("report_date").alias("months_reported"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Park Performance KPIs

# COMMAND ----------

yoy_park_window = Window.partitionBy("park_code").orderBy("visit_year")

# Find peak month
monthly_cols = [
    ("jan_visitors", 1), ("feb_visitors", 2), ("mar_visitors", 3),
    ("apr_visitors", 4), ("may_visitors", 5), ("jun_visitors", 6),
    ("jul_visitors", 7), ("aug_visitors", 8), ("sep_visitors", 9),
    ("oct_visitors", 10), ("nov_visitors", 11), ("dec_visitors", 12),
]

# Build peak month detection using greatest()
peak_month_expr = greatest(*[col(c) for c, _ in monthly_cols])

df_park_kpis = df_park_annual \
    .withColumn("peak_visitors", peak_month_expr) \
    .withColumn("peak_month",
        when(col("jan_visitors") == col("peak_visitors"), lit(1))
        .when(col("feb_visitors") == col("peak_visitors"), lit(2))
        .when(col("mar_visitors") == col("peak_visitors"), lit(3))
        .when(col("apr_visitors") == col("peak_visitors"), lit(4))
        .when(col("may_visitors") == col("peak_visitors"), lit(5))
        .when(col("jun_visitors") == col("peak_visitors"), lit(6))
        .when(col("jul_visitors") == col("peak_visitors"), lit(7))
        .when(col("aug_visitors") == col("peak_visitors"), lit(8))
        .when(col("sep_visitors") == col("peak_visitors"), lit(9))
        .when(col("oct_visitors") == col("peak_visitors"), lit(10))
        .when(col("nov_visitors") == col("peak_visitors"), lit(11))
        .when(col("dec_visitors") == col("peak_visitors"), lit(12))
        .otherwise(lit(7))
    ) \
    .withColumn("avg_monthly_visitors",
        when(col("months_reported") > 0,
            round(col("total_visitors") / col("months_reported"), 0))
        .otherwise(lit(0))
    ) \
    .withColumn("camping_rate",
        when(col("total_visitors") > 0,
            round(col("camping_visitors") / col("total_visitors") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("backcountry_pct",
        when(col("total_visitors") > 0,
            round(col("backcountry_visitors") / col("total_visitors") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("recreation_pct",
        when(col("total_visitors") > 0,
            round(col("recreation_visitors") / col("total_visitors") * 100, 2))
        .otherwise(lit(0.0))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Year-over-Year Change and Regional Ranking

# COMMAND ----------

df_park_yoy = df_park_kpis \
    .withColumn("prev_year_visitors",
        lag("total_visitors", 1).over(yoy_park_window)
    ) \
    .withColumn("yoy_change",
        when(col("prev_year_visitors").isNotNull() & (col("prev_year_visitors") > 0),
            round((col("total_visitors") - col("prev_year_visitors")) /
                  col("prev_year_visitors") * 100, 2))
        .otherwise(lit(None))
    ) \
    .drop("prev_year_visitors")

# Regional visitor ranking
regional_rank_window = Window.partitionBy("region", "visit_year") \
    .orderBy(col("total_visitors").desc())
national_rank_window = Window.partitionBy("visit_year") \
    .orderBy(col("total_visitors").desc())

df_park_final = df_park_yoy \
    .withColumn("visitor_rank",
        row_number().over(regional_rank_window)
    ) \
    .withColumn("national_rank",
        row_number().over(national_rank_window)
    ) \
    .withColumn("growth_category",
        when(col("yoy_change") > 20, lit("SURGING"))
        .when(col("yoy_change") > 5, lit("GROWING"))
        .when(col("yoy_change") >= -5, lit("STABLE"))
        .when(col("yoy_change") >= -20, lit("DECLINING"))
        .when(col("yoy_change").isNull(), lit("BASELINE"))
        .otherwise(lit("SHARP_DECLINE"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Park Performance Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_PARK_PERFORMANCE):
        deltaTable = DeltaTable.forName(spark, TARGET_PARK_PERFORMANCE)
        deltaTable.alias("target").merge(
            df_park_final.alias("source"),
            "target.park_code = source.park_code AND target.visit_year = source.visit_year"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_park_final.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("visit_year") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_PARK_PERFORMANCE)

    print(f"Merged {df_park_final.count():,} records into {TARGET_PARK_PERFORMANCE}")
except Exception as e:
    print(f"ERROR writing park performance (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 4: Natural Resources Dashboard (Cross-Domain)

# COMMAND ----------

# MAGIC %md
# MAGIC ### State-Level Seismic Summary

# COMMAND ----------

# Aggregate seismic data to state level from region-based data
df_state_seismic = df_seismic_final \
    .groupBy("event_year") \
    .agg(
        sum("total_earthquakes").alias("national_earthquakes"),
        sum("significant_events").alias("national_significant_quakes"),
        max("max_magnitude").alias("national_max_magnitude"),
        sum("tsunami_events").alias("national_tsunami_events"),
        sum("felt_reports_total").alias("national_felt_reports"),
        round(sum("estimated_damage_usd"), 2).alias("national_seismic_damage"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### State-Level Water Summary

# COMMAND ----------

df_state_water_summary = df_water_resources \
    .groupBy("measurement_year") \
    .agg(
        round(avg("avg_streamflow"), 2).alias("national_avg_streamflow"),
        sum("monitoring_sites").alias("national_monitoring_sites"),
        sum("anomaly_count").alias("national_water_anomalies"),
        round(avg("flow_variability"), 2).alias("national_flow_variability"),
        sum(when(col("drought_indicator").isin("SEVERE_DROUGHT", "MODERATE_DROUGHT"), 1)
            .otherwise(0)).alias("states_in_drought"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### National Park Summary

# COMMAND ----------

df_park_summary = df_park_final \
    .groupBy("visit_year") \
    .agg(
        sum("total_visitors").alias("national_park_visitors"),
        countDistinct("park_code").alias("parks_reporting"),
        round(avg("yoy_change"), 2).alias("avg_park_yoy_change"),
        sum("camping_visitors").alias("national_camping_visitors"),
        sum("backcountry_visitors").alias("national_backcountry_visitors"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Combine into Unified Dashboard

# COMMAND ----------

df_dashboard = df_state_seismic.alias("s") \
    .join(
        df_state_water_summary.alias("w"),
        col("s.event_year") == col("w.measurement_year"),
        "full_outer"
    ) \
    .join(
        df_park_summary.alias("p"),
        coalesce(col("s.event_year"), col("w.measurement_year")) == col("p.visit_year"),
        "full_outer"
    ) \
    .select(
        coalesce(
            col("s.event_year"),
            col("w.measurement_year"),
            col("p.visit_year")
        ).alias("report_year"),

        # Seismic
        coalesce(col("national_earthquakes"), lit(0)).alias("national_earthquakes"),
        coalesce(col("national_significant_quakes"), lit(0)).alias("national_significant_quakes"),
        col("national_max_magnitude"),
        coalesce(col("national_tsunami_events"), lit(0)).alias("national_tsunami_events"),
        coalesce(col("national_felt_reports"), lit(0)).alias("national_felt_reports"),
        coalesce(col("national_seismic_damage"), lit(0)).alias("national_seismic_damage"),

        # Water
        col("national_avg_streamflow"),
        coalesce(col("national_monitoring_sites"), lit(0)).alias("national_monitoring_sites"),
        coalesce(col("national_water_anomalies"), lit(0)).alias("national_water_anomalies"),
        col("national_flow_variability"),
        coalesce(col("states_in_drought"), lit(0)).alias("states_in_drought"),

        # Parks
        coalesce(col("national_park_visitors"), lit(0)).alias("national_park_visitors"),
        coalesce(col("parks_reporting"), lit(0)).alias("parks_reporting"),
        col("avg_park_yoy_change"),
        coalesce(col("national_camping_visitors"), lit(0)).alias("national_camping_visitors"),
        coalesce(col("national_backcountry_visitors"), lit(0)).alias("national_backcountry_visitors"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Cross-Domain Health Indicators

# COMMAND ----------

df_dashboard_scored = df_dashboard \
    .withColumn("seismic_activity_level",
        when(col("national_significant_quakes") >= 20, lit("VERY_HIGH"))
        .when(col("national_significant_quakes") >= 10, lit("HIGH"))
        .when(col("national_significant_quakes") >= 5, lit("MODERATE"))
        .otherwise(lit("LOW"))
    ) \
    .withColumn("water_health_level",
        when(col("states_in_drought") >= 15, lit("CRITICAL"))
        .when(col("states_in_drought") >= 10, lit("STRESSED"))
        .when(col("states_in_drought") >= 5, lit("FAIR"))
        .otherwise(lit("GOOD"))
    ) \
    .withColumn("park_engagement_level",
        when(col("national_park_visitors") > 300000000, lit("RECORD"))
        .when(col("national_park_visitors") > 250000000, lit("HIGH"))
        .when(col("national_park_visitors") > 200000000, lit("MODERATE"))
        .otherwise(lit("LOW"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Natural Resources Dashboard Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_NR_DASHBOARD):
        deltaTable = DeltaTable.forName(spark, TARGET_NR_DASHBOARD)
        deltaTable.alias("target").merge(
            df_dashboard_scored.alias("source"),
            "target.report_year = source.report_year"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_dashboard_scored.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_NR_DASHBOARD)

    print(f"Merged {df_dashboard_scored.count():,} records into {TARGET_NR_DASHBOARD}")
except Exception as e:
    print(f"ERROR writing NR dashboard (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Optimize All Gold Tables for Direct Lake

# COMMAND ----------

spark.sql(f"OPTIMIZE {TARGET_SEISMIC_RISK} ZORDER BY (region)")
print(f"Optimized {TARGET_SEISMIC_RISK}")

spark.sql(f"OPTIMIZE {TARGET_WATER_RESOURCES} ZORDER BY (site_state)")
print(f"Optimized {TARGET_WATER_RESOURCES}")

spark.sql(f"OPTIMIZE {TARGET_PARK_PERFORMANCE} ZORDER BY (park_code, region)")
print(f"Optimized {TARGET_PARK_PERFORMANCE}")

spark.sql(f"OPTIMIZE {TARGET_NR_DASHBOARD} ZORDER BY (report_year)")
print(f"Optimized {TARGET_NR_DASHBOARD}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Validation & Summary

# COMMAND ----------

# MAGIC %md
# MAGIC ### Seismic Risk Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        event_year,
        COUNT(DISTINCT region) as regions,
        SUM(total_earthquakes) as earthquakes,
        SUM(significant_events) as significant,
        MAX(max_magnitude) as max_mag,
        SUM(tsunami_events) as tsunamis,
        SUM(felt_reports_total) as felt_reports
    FROM {TARGET_SEISMIC_RISK}
    GROUP BY event_year
    ORDER BY event_year DESC
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# Highest risk regions
print("Highest Risk Regions (Latest Year):")
spark.sql(f"""
    SELECT
        regional_rank,
        region,
        total_earthquakes,
        significant_events,
        max_magnitude,
        seismic_risk_tier,
        rolling_5yr_avg_events
    FROM {TARGET_SEISMIC_RISK}
    WHERE event_year = (SELECT MAX(event_year) FROM {TARGET_SEISMIC_RISK})
    ORDER BY regional_rank
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Water Resources Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        drought_indicator,
        COUNT(*) as state_years,
        ROUND(AVG(avg_streamflow), 2) as avg_flow,
        SUM(monitoring_sites) as total_sites,
        SUM(anomaly_count) as total_anomalies,
        ROUND(AVG(flow_variability), 2) as avg_variability
    FROM {TARGET_WATER_RESOURCES}
    GROUP BY drought_indicator
    ORDER BY state_years DESC
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Park Performance Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        growth_category,
        COUNT(*) as park_years,
        SUM(total_visitors) as total_visitors,
        ROUND(AVG(camping_rate), 2) as avg_camping_rate,
        ROUND(AVG(backcountry_pct), 2) as avg_backcountry_pct,
        ROUND(AVG(yoy_change), 2) as avg_yoy_change
    FROM {TARGET_PARK_PERFORMANCE}
    GROUP BY growth_category
    ORDER BY total_visitors DESC
""").show(truncate=False)

# COMMAND ----------

# Top 10 most visited parks (latest year)
print("Top 10 Most Visited Parks (Latest Year):")
spark.sql(f"""
    SELECT
        national_rank,
        park_name,
        region,
        state,
        total_visitors,
        yoy_change,
        peak_month,
        camping_rate,
        backcountry_pct,
        growth_category
    FROM {TARGET_PARK_PERFORMANCE}
    WHERE visit_year = (SELECT MAX(visit_year) FROM {TARGET_PARK_PERFORMANCE})
    ORDER BY national_rank
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Natural Resources Dashboard Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        report_year,
        national_earthquakes,
        national_significant_quakes,
        seismic_activity_level,
        national_avg_streamflow,
        states_in_drought,
        water_health_level,
        national_park_visitors,
        park_engagement_level
    FROM {TARGET_NR_DASHBOARD}
    ORDER BY report_year DESC
    LIMIT 5
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Gold Layer Output Summary
# MAGIC
# MAGIC | Table | Description | Partitioned By | Z-Order |
# MAGIC |-------|-------------|----------------|---------|
# MAGIC | gold_doi_seismic_risk | Regional seismic activity, significant events, tsunamis | event_year | region |
# MAGIC | gold_doi_water_resources | State-level streamflow, monitoring coverage, drought | measurement_year | site_state |
# MAGIC | gold_doi_park_performance | Park visitation KPIs with regional ranking | visit_year | park_code, region |
# MAGIC | gold_doi_natural_resources_dashboard | Cross-domain executive view combining all DOI data | - | report_year |
# MAGIC
# MAGIC **Dashboard Ready:** All tables optimized for Power BI Direct Lake connectivity.
