# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: EPA Environmental Analytics
# MAGIC
# MAGIC This notebook creates aggregated EPA environmental analytics tables optimized for
# MAGIC Power BI Direct Lake dashboards and environmental compliance reporting.
# MAGIC
# MAGIC ## Output Tables:
# MAGIC - **gold_epa_air_quality_index** - Daily county-level AQI, dominant pollutant, exceedance tracking
# MAGIC - **gold_epa_facility_risk** - TRI facility-level toxic release risk tiers and media breakdown
# MAGIC - **gold_epa_water_compliance** - Water system violation rates and compliance scoring
# MAGIC - **gold_epa_environmental_scorecard** - Cross-domain state-level environmental health index
# MAGIC
# MAGIC ## Key Metrics:
# MAGIC - Daily AQI with unhealthy/good hours and 30-day rolling averages
# MAGIC - Facility toxic release totals with air/water/land media percentages
# MAGIC - Water system violation rates and critical violation counts
# MAGIC - Composite environmental health index by state

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
    asc,
    avg,
    coalesce,
    col,
    collect_set,
    count,
    countDistinct,
    current_timestamp,
    days,
    desc,
    filter,
    first,
    lag,
    lit,
    max,
    min,
    round,
    row_number,
    struct,
    sum,
    when,
    window,
    year,
)
from pyspark.sql.window import Window

# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source tables (Silver)
SOURCE_AQI_DATA = "lh_silver.silver_epa_air_quality"
SOURCE_TRI_DATA = "lh_silver.silver_epa_tri_releases"
SOURCE_WATER_DATA = "lh_silver.silver_epa_water_systems"
SOURCE_VIOLATIONS = "lh_silver.silver_epa_water_violations"

# Target tables (Gold)
TARGET_AIR_QUALITY = "lh_gold.gold_epa_air_quality_index"
TARGET_FACILITY_RISK = "lh_gold.gold_epa_facility_risk"
TARGET_WATER_COMPLIANCE = "lh_gold.gold_epa_water_compliance"
TARGET_ENV_SCORECARD = "lh_gold.gold_epa_environmental_scorecard"

print(f"Processing batch: {batch_id}")
print(f"Sources:")
print(f"  - {SOURCE_AQI_DATA}")
print(f"  - {SOURCE_TRI_DATA}")
print(f"  - {SOURCE_WATER_DATA}")
print(f"  - {SOURCE_VIOLATIONS}")
print(f"Targets:")
print(f"  - {TARGET_AIR_QUALITY}")
print(f"  - {TARGET_FACILITY_RISK}")
print(f"  - {TARGET_WATER_COMPLIANCE}")
print(f"  - {TARGET_ENV_SCORECARD}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Data

# COMMAND ----------

df_aqi = spark.table(SOURCE_AQI_DATA)
df_tri = spark.table(SOURCE_TRI_DATA)
df_water = spark.table(SOURCE_WATER_DATA)
df_violations = spark.table(SOURCE_VIOLATIONS)

print(f"Silver AQI data:           {df_aqi.count():,} records")
print(f"Silver TRI releases:       {df_tri.count():,} records")
print(f"Silver water systems:      {df_water.count():,} records")
print(f"Silver water violations:   {df_violations.count():,} records")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 1: Air Quality Index

# COMMAND ----------

# MAGIC %md
# MAGIC ### Daily County-Level AQI Aggregation

# COMMAND ----------

df_aqi_daily = df_aqi \
    .groupBy("state", "county", "county_fips", "date") \
    .agg(
        # AQI metrics
        round(avg("aqi_value"), 0).alias("daily_aqi"),
        round(max("aqi_value"), 0).alias("peak_aqi"),

        # Dominant pollutant (mode - most frequent)
        first("dominant_pollutant").alias("dominant_pollutant"),

        # Hours by AQI category
        sum(when(col("aqi_category") == "Good", col("hours_measured")).otherwise(0)).alias("good_hours"),
        sum(when(col("aqi_category") == "Moderate", col("hours_measured")).otherwise(0)).alias("moderate_hours"),
        sum(when(col("aqi_category").isin(
            "Unhealthy for Sensitive Groups", "Unhealthy", "Very Unhealthy", "Hazardous"
        ), col("hours_measured")).otherwise(0)).alias("unhealthy_hours"),

        # Individual pollutant AQIs
        round(max(when(col("pollutant") == "PM2.5", col("aqi_value"))), 0).alias("pm25_aqi"),
        round(max(when(col("pollutant") == "PM10", col("aqi_value"))), 0).alias("pm10_aqi"),
        round(max(when(col("pollutant") == "O3", col("aqi_value"))), 0).alias("ozone_aqi"),
        round(max(when(col("pollutant") == "NO2", col("aqi_value"))), 0).alias("no2_aqi"),
        round(max(when(col("pollutant") == "SO2", col("aqi_value"))), 0).alias("so2_aqi"),
        round(max(when(col("pollutant") == "CO", col("aqi_value"))), 0).alias("co_aqi"),

        # Monitoring sites
        countDistinct("site_id").alias("monitoring_sites"),
        count("*").alias("measurement_count"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Exceedances and Rolling Averages

# COMMAND ----------

# NAAQS exceedance tracking
df_aqi_enriched = df_aqi_daily \
    .withColumn("exceedance_day",
        when(col("daily_aqi") > 100, lit(1)).otherwise(lit(0))
    ) \
    .withColumn("aqi_category",
        when(col("daily_aqi") <= 50, lit("Good"))
        .when(col("daily_aqi") <= 100, lit("Moderate"))
        .when(col("daily_aqi") <= 150, lit("Unhealthy for Sensitive Groups"))
        .when(col("daily_aqi") <= 200, lit("Unhealthy"))
        .when(col("daily_aqi") <= 300, lit("Very Unhealthy"))
        .otherwise(lit("Hazardous"))
    )

# 30-day rolling average AQI
rolling_30d_window = Window.partitionBy("county_fips") \
    .orderBy(col("date").cast("long")) \
    .rangeBetween(-30 * 86400, 0)

df_aqi_with_rolling = df_aqi_enriched \
    .withColumn("rolling_30day_avg_aqi",
        round(avg("daily_aqi").over(rolling_30d_window), 1)
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Cumulative Exceedance Days (YTD)

# COMMAND ----------

ytd_window = Window.partitionBy("county_fips", year("date")) \
    .orderBy("date") \
    .rowsBetween(Window.unboundedPreceding, Window.currentRow)

df_aqi_final = df_aqi_with_rolling \
    .withColumn("ytd_exceedance_days",
        sum("exceedance_day").over(ytd_window)
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Air Quality Index Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_AIR_QUALITY):
        deltaTable = DeltaTable.forName(spark, TARGET_AIR_QUALITY)
        deltaTable.alias("target").merge(
            df_aqi_final.alias("source"),
            "target.state = source.state AND target.county_fips = source.county_fips AND target.date = source.date"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_aqi_final.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("state") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_AIR_QUALITY)

    print(f"Merged {spark.table(TARGET_AIR_QUALITY).count():,} records into {TARGET_AIR_QUALITY}")
except Exception as e:
    print(f"ERROR writing air quality (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 2: Facility Risk (TRI Data)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Aggregate TRI Releases by Facility

# COMMAND ----------

df_facility_agg = df_tri \
    .groupBy("facility_id", "facility_name", "state", "county",
             "latitude", "longitude", "industry_sector", "naics_code") \
    .agg(
        # Total releases
        round(sum(coalesce(col("total_releases_lbs"), lit(0))), 2).alias("total_releases_lbs"),

        # Chemical diversity
        countDistinct("chemical_name").alias("chemical_count"),
        collect_set("chemical_name").alias("chemicals_released"),

        # Media breakdown (air, water, land)
        round(sum(coalesce(col("fugitive_air_lbs"), lit(0)) +
                  coalesce(col("stack_air_lbs"), lit(0))), 2).alias("air_releases_lbs"),
        round(sum(coalesce(col("water_releases_lbs"), lit(0))), 2).alias("water_releases_lbs"),
        round(sum(coalesce(col("land_releases_lbs"), lit(0))), 2).alias("land_releases_lbs"),
        round(sum(coalesce(col("offsite_releases_lbs"), lit(0))), 2).alias("offsite_releases_lbs"),

        # Reporting years
        countDistinct("reporting_year").alias("years_reporting"),
        min("reporting_year").alias("first_report_year"),
        max("reporting_year").alias("latest_report_year"),

        # Carcinogen tracking
        sum(when(col("carcinogen_flag") == True, col("total_releases_lbs")).otherwise(0)).alias("carcinogen_releases_lbs"),
        countDistinct(when(col("carcinogen_flag") == True, col("chemical_name"))).alias("carcinogen_chemical_count"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Media Breakdown Percentages and Year-over-Year Trend

# COMMAND ----------

df_facility_pct = df_facility_agg \
    .withColumn("air_pct",
        when(col("total_releases_lbs") > 0,
            round(col("air_releases_lbs") / col("total_releases_lbs") * 100, 1))
        .otherwise(lit(0.0))
    ) \
    .withColumn("water_pct",
        when(col("total_releases_lbs") > 0,
            round(col("water_releases_lbs") / col("total_releases_lbs") * 100, 1))
        .otherwise(lit(0.0))
    ) \
    .withColumn("land_pct",
        when(col("total_releases_lbs") > 0,
            round(col("land_releases_lbs") / col("total_releases_lbs") * 100, 1))
        .otherwise(lit(0.0))
    ) \
    .withColumn("media_breakdown",
        struct(
            col("air_pct").alias("air"),
            col("water_pct").alias("water"),
            col("land_pct").alias("land")
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Year-over-Year Trend per Facility

# COMMAND ----------

# Calculate latest vs previous year releases for trend
df_tri_yearly = df_tri \
    .groupBy("facility_id", "reporting_year") \
    .agg(round(sum("total_releases_lbs"), 2).alias("year_releases"))

yoy_fac_window = Window.partitionBy("facility_id").orderBy("reporting_year")

df_tri_trend = df_tri_yearly \
    .withColumn("prev_year_releases", lag("year_releases", 1).over(yoy_fac_window)) \
    .withColumn("yoy_change_pct",
        when(col("prev_year_releases").isNotNull() & (col("prev_year_releases") > 0),
            round((col("year_releases") - col("prev_year_releases")) /
                  col("prev_year_releases") * 100, 2))
        .otherwise(lit(None))
    ) \
    .filter(col("reporting_year") == (
        df_tri.agg(max("reporting_year")).collect()[0][0]
    )) \
    .select(
        col("facility_id").alias("trend_facility_id"),
        col("yoy_change_pct").alias("yoy_trend")
    )

# Join trend back to facility data
df_facility_with_trend = df_facility_pct.alias("f") \
    .join(
        df_tri_trend.alias("t"),
        col("f.facility_id") == col("t.trend_facility_id"),
        "left"
    ) \
    .drop("trend_facility_id")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Assign Risk Tier and Metadata

# COMMAND ----------

release_rank_window = Window.orderBy(col("total_releases_lbs").desc())

df_facility_final = df_facility_with_trend \
    .withColumn("release_rank",
        row_number().over(release_rank_window)
    ) \
    .withColumn("risk_tier",
        when((col("total_releases_lbs") > 100000) | (col("carcinogen_chemical_count") >= 5), lit("HIGH"))
        .when((col("total_releases_lbs") > 10000) | (col("carcinogen_chemical_count") >= 2), lit("MEDIUM"))
        .otherwise(lit("LOW"))
    ) \
    .withColumn("yoy_trend_direction",
        when(col("yoy_trend") > 10, lit("INCREASING"))
        .when(col("yoy_trend") < -10, lit("DECREASING"))
        .when(col("yoy_trend").isNull(), lit("UNKNOWN"))
        .otherwise(lit("STABLE"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Facility Risk Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_FACILITY_RISK):
        deltaTable = DeltaTable.forName(spark, TARGET_FACILITY_RISK)
        deltaTable.alias("target").merge(
            df_facility_final.alias("source"),
            "target.facility_id = source.facility_id"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_facility_final.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("state") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_FACILITY_RISK)

    print(f"Merged {df_facility_final.count():,} records into {TARGET_FACILITY_RISK}")
except Exception as e:
    print(f"ERROR writing facility risk (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 3: Water Compliance

# COMMAND ----------

# MAGIC %md
# MAGIC ### Aggregate Violations by Water System

# COMMAND ----------

# Water system base information
df_water_base = df_water.select(
    "pwsid",
    "pws_name",
    "state",
    "county",
    "population_served",
    "source_type",
    "pws_type",
)

# Violation aggregation by water system
df_violation_agg = df_violations \
    .groupBy("pwsid") \
    .agg(
        count("*").alias("violation_count"),

        # Violation severity
        sum(when(col("violation_severity") == "CRITICAL", 1).otherwise(0)).alias("critical_violations"),
        sum(when(col("violation_severity") == "MAJOR", 1).otherwise(0)).alias("major_violations"),
        sum(when(col("violation_severity") == "MINOR", 1).otherwise(0)).alias("minor_violations"),

        # Contaminant tracking
        countDistinct("contaminant_code").alias("contaminants_monitored"),
        collect_set("contaminant_name").alias("contaminant_list"),

        # Health-based violations
        sum(when(col("is_health_based") == True, 1).otherwise(0)).alias("health_based_violations"),

        # Compliance actions
        sum(when(col("enforcement_action").isNotNull(), 1).otherwise(0)).alias("enforcement_actions"),
        sum(when(col("returned_to_compliance") == True, 1).otherwise(0)).alias("resolved_violations"),

        # Sample tracking
        sum(coalesce(col("sample_count"), lit(0))).alias("total_samples"),

        # Timeline
        min("violation_date").alias("first_violation_date"),
        max("violation_date").alias("latest_violation_date"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Join Water System Metadata with Violations

# COMMAND ----------

df_water_compliance = df_water_base.alias("w") \
    .join(
        df_violation_agg.alias("v"),
        col("w.pwsid") == col("v.pwsid"),
        "left"
    ) \
    .select(
        col("w.pwsid"),
        col("w.pws_name"),
        col("w.state"),
        col("w.county"),
        col("w.population_served"),
        col("w.source_type"),
        col("w.pws_type"),
        coalesce(col("v.total_samples"), lit(0)).alias("total_samples"),
        coalesce(col("v.violation_count"), lit(0)).alias("violation_count"),
        coalesce(col("v.critical_violations"), lit(0)).alias("critical_violations"),
        coalesce(col("v.major_violations"), lit(0)).alias("major_violations"),
        coalesce(col("v.minor_violations"), lit(0)).alias("minor_violations"),
        coalesce(col("v.contaminants_monitored"), lit(0)).alias("contaminants_monitored"),
        col("v.contaminant_list"),
        coalesce(col("v.health_based_violations"), lit(0)).alias("health_based_violations"),
        coalesce(col("v.enforcement_actions"), lit(0)).alias("enforcement_actions"),
        coalesce(col("v.resolved_violations"), lit(0)).alias("resolved_violations"),
        col("v.first_violation_date"),
        col("v.latest_violation_date"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Violation Rate and Compliance Score

# COMMAND ----------

df_water_scored = df_water_compliance \
    .withColumn("violation_rate",
        when(col("total_samples") > 0,
            round(col("violation_count") / col("total_samples") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("resolution_rate",
        when(col("violation_count") > 0,
            round(col("resolved_violations") / col("violation_count") * 100, 2))
        .otherwise(lit(100.0))
    ) \
    .withColumn("compliance_score",
        round(
            lit(100) -
            (col("critical_violations") * 10) -
            (col("major_violations") * 5) -
            (col("minor_violations") * 1) +
            (col("resolution_rate") * 0.2),
            2
        )
    ) \
    .withColumn("compliance_score",
        when(col("compliance_score") < 0, lit(0.0))
        .when(col("compliance_score") > 100, lit(100.0))
        .otherwise(col("compliance_score"))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Compliance Classification and Metadata

# COMMAND ----------

compliance_rank_window = Window.orderBy(col("compliance_score").asc())

df_water_final = df_water_scored \
    .withColumn("compliance_tier",
        when(col("compliance_score") >= 90, lit("EXCELLENT"))
        .when(col("compliance_score") >= 75, lit("GOOD"))
        .when(col("compliance_score") >= 50, lit("NEEDS_IMPROVEMENT"))
        .when(col("compliance_score") >= 25, lit("POOR"))
        .otherwise(lit("CRITICAL"))
    ) \
    .withColumn("risk_rank",
        row_number().over(compliance_rank_window)
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Water Compliance Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_WATER_COMPLIANCE):
        deltaTable = DeltaTable.forName(spark, TARGET_WATER_COMPLIANCE)
        deltaTable.alias("target").merge(
            df_water_final.alias("source"),
            "target.pwsid = source.pwsid"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_water_final.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("state") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_WATER_COMPLIANCE)

    print(f"Merged {df_water_final.count():,} records into {TARGET_WATER_COMPLIANCE}")
except Exception as e:
    print(f"ERROR writing water compliance (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 4: Environmental Scorecard (Cross-Domain)

# COMMAND ----------

# MAGIC %md
# MAGIC ### State-Level Air Quality Aggregation

# COMMAND ----------

df_state_aqi = df_aqi_final \
    .withColumn("report_year", year("date")) \
    .groupBy("state", "report_year") \
    .agg(
        round(avg("daily_aqi"), 1).alias("avg_aqi"),
        round(max("daily_aqi"), 0).alias("max_aqi"),
        sum("exceedance_day").alias("total_exceedance_days"),
        count("*").alias("aqi_observations"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### State-Level TRI Releases Aggregation

# COMMAND ----------

df_state_tri = df_tri \
    .groupBy("state", col("reporting_year").alias("report_year")) \
    .agg(
        round(sum("total_releases_lbs"), 2).alias("total_toxic_releases"),
        countDistinct("facility_id").alias("reporting_facilities"),
        countDistinct("chemical_name").alias("unique_chemicals"),
        round(sum(when(col("carcinogen_flag") == True, col("total_releases_lbs")).otherwise(0)), 2).alias("carcinogen_releases"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### State-Level Water Violation Aggregation

# COMMAND ----------

df_state_water = df_water_final \
    .groupBy("state") \
    .agg(
        count("*").alias("water_systems"),
        sum("violation_count").alias("total_violations"),
        sum("total_samples").alias("total_samples"),
        round(avg("compliance_score"), 2).alias("avg_compliance_score"),
        sum("critical_violations").alias("critical_violations"),
        sum("population_served").alias("population_served"),
    ) \
    .withColumn("water_violation_rate",
        when(col("total_samples") > 0,
            round(col("total_violations") / col("total_samples") * 100, 2))
        .otherwise(lit(0.0))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Combine into Environmental Scorecard

# COMMAND ----------

# Join air + TRI + water at state-year level
df_scorecard = df_state_aqi.alias("a") \
    .join(
        df_state_tri.alias("t"),
        (col("a.state") == col("t.state")) & (col("a.report_year") == col("t.report_year")),
        "full_outer"
    ) \
    .select(
        coalesce(col("a.state"), col("t.state")).alias("state"),
        coalesce(col("a.report_year"), col("t.report_year")).alias("report_year"),
        col("a.avg_aqi"),
        col("a.max_aqi"),
        col("a.total_exceedance_days"),
        col("t.total_toxic_releases"),
        col("t.reporting_facilities"),
        col("t.unique_chemicals"),
        col("t.carcinogen_releases"),
    ) \
    .join(
        df_state_water.alias("w"),
        col("state") == col("w.state"),
        "left"
    ) \
    .select(
        col("state"),
        col("report_year"),
        coalesce(col("avg_aqi"), lit(0)).alias("avg_aqi"),
        coalesce(col("max_aqi"), lit(0)).alias("max_aqi"),
        coalesce(col("total_exceedance_days"), lit(0)).alias("total_exceedance_days"),
        coalesce(col("total_toxic_releases"), lit(0)).alias("total_toxic_releases"),
        coalesce(col("reporting_facilities"), lit(0)).alias("reporting_facilities"),
        coalesce(col("water_violation_rate"), lit(0)).alias("water_violation_rate"),
        coalesce(col("avg_compliance_score"), lit(0)).alias("avg_water_compliance"),
        coalesce(col("critical_violations"), lit(0)).alias("critical_water_violations"),
        coalesce(col("population_served"), lit(0)).alias("population_served"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Environmental Health Index

# COMMAND ----------

# Composite environmental health index (0-100, higher = healthier)
# Inverse of risk: lower AQI, lower releases, lower violations = higher score
df_env_scorecard = df_scorecard \
    .withColumn("aqi_score",
        when(col("avg_aqi") <= 50, lit(100))
        .when(col("avg_aqi") <= 100, lit(75))
        .when(col("avg_aqi") <= 150, lit(50))
        .when(col("avg_aqi") <= 200, lit(25))
        .otherwise(lit(0))
    ) \
    .withColumn("tri_score",
        when(col("total_toxic_releases") == 0, lit(100))
        .when(col("total_toxic_releases") < 10000, lit(80))
        .when(col("total_toxic_releases") < 100000, lit(60))
        .when(col("total_toxic_releases") < 1000000, lit(40))
        .when(col("total_toxic_releases") < 10000000, lit(20))
        .otherwise(lit(0))
    ) \
    .withColumn("water_score",
        col("avg_water_compliance")
    ) \
    .withColumn("environmental_health_index",
        round(
            col("aqi_score") * 0.35 +
            col("tri_score") * 0.35 +
            col("water_score") * 0.30,
            2
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Rankings and Metadata

# COMMAND ----------

health_rank_window = Window.partitionBy("report_year") \
    .orderBy(col("environmental_health_index").desc())

df_scorecard_final = df_env_scorecard \
    .withColumn("state_health_rank",
        row_number().over(health_rank_window)
    ) \
    .withColumn("health_tier",
        when(col("environmental_health_index") >= 80, lit("EXCELLENT"))
        .when(col("environmental_health_index") >= 60, lit("GOOD"))
        .when(col("environmental_health_index") >= 40, lit("FAIR"))
        .when(col("environmental_health_index") >= 20, lit("POOR"))
        .otherwise(lit("CRITICAL"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Environmental Scorecard Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_ENV_SCORECARD):
        deltaTable = DeltaTable.forName(spark, TARGET_ENV_SCORECARD)
        deltaTable.alias("target").merge(
            df_scorecard_final.alias("source"),
            "target.state = source.state AND target.report_year = source.report_year"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_scorecard_final.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("report_year") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_ENV_SCORECARD)

    print(f"Merged {df_scorecard_final.count():,} records into {TARGET_ENV_SCORECARD}")
except Exception as e:
    print(f"ERROR writing environmental scorecard (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Optimize All Gold Tables for Direct Lake

# COMMAND ----------

spark.sql(f"OPTIMIZE {TARGET_AIR_QUALITY} ZORDER BY (county_fips, date)")
print(f"Optimized {TARGET_AIR_QUALITY}")

spark.sql(f"OPTIMIZE {TARGET_FACILITY_RISK} ZORDER BY (facility_id)")
print(f"Optimized {TARGET_FACILITY_RISK}")

spark.sql(f"OPTIMIZE {TARGET_WATER_COMPLIANCE} ZORDER BY (pwsid)")
print(f"Optimized {TARGET_WATER_COMPLIANCE}")

spark.sql(f"OPTIMIZE {TARGET_ENV_SCORECARD} ZORDER BY (state, report_year)")
print(f"Optimized {TARGET_ENV_SCORECARD}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Validation & Summary

# COMMAND ----------

# MAGIC %md
# MAGIC ### Air Quality Index Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        COUNT(DISTINCT county_fips) as counties,
        COUNT(DISTINCT date) as days,
        ROUND(AVG(daily_aqi), 1) as overall_avg_aqi,
        SUM(exceedance_day) as total_exceedance_days,
        SUM(unhealthy_hours) as total_unhealthy_hours
    FROM {TARGET_AIR_QUALITY}
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Facility Risk Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        risk_tier,
        COUNT(*) as facilities,
        ROUND(SUM(total_releases_lbs), 0) as total_releases_lbs,
        ROUND(AVG(chemical_count), 1) as avg_chemicals,
        ROUND(AVG(air_pct), 1) as avg_air_pct,
        ROUND(AVG(water_pct), 1) as avg_water_pct,
        ROUND(AVG(land_pct), 1) as avg_land_pct
    FROM {TARGET_FACILITY_RISK}
    GROUP BY risk_tier
    ORDER BY total_releases_lbs DESC
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Water Compliance Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        compliance_tier,
        COUNT(*) as water_systems,
        SUM(violation_count) as total_violations,
        SUM(critical_violations) as critical_violations,
        ROUND(AVG(violation_rate), 2) as avg_violation_rate,
        ROUND(AVG(compliance_score), 2) as avg_compliance_score
    FROM {TARGET_WATER_COMPLIANCE}
    GROUP BY compliance_tier
    ORDER BY avg_compliance_score DESC
""").show(truncate=False)

# COMMAND ----------

# Top 10 worst-compliance water systems
print("Top 10 Worst-Compliance Water Systems:")
spark.sql(f"""
    SELECT
        risk_rank,
        pws_name,
        state,
        violation_count,
        critical_violations,
        violation_rate,
        compliance_score,
        compliance_tier
    FROM {TARGET_WATER_COMPLIANCE}
    ORDER BY risk_rank
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Environmental Scorecard Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        health_tier,
        COUNT(*) as states,
        ROUND(AVG(environmental_health_index), 2) as avg_health_index,
        ROUND(AVG(avg_aqi), 1) as avg_aqi,
        ROUND(SUM(total_toxic_releases) / 1000000, 2) as total_releases_million_lbs,
        ROUND(AVG(water_violation_rate), 2) as avg_water_violation_rate
    FROM {TARGET_ENV_SCORECARD}
    GROUP BY health_tier
    ORDER BY avg_health_index DESC
""").show(truncate=False)

# COMMAND ----------

# Top 10 healthiest states (latest year)
print("Top 10 Healthiest States (Latest Year):")
spark.sql(f"""
    SELECT
        state_health_rank,
        state,
        environmental_health_index,
        health_tier,
        avg_aqi,
        total_toxic_releases,
        water_violation_rate
    FROM {TARGET_ENV_SCORECARD}
    WHERE report_year = (SELECT MAX(report_year) FROM {TARGET_ENV_SCORECARD})
    ORDER BY state_health_rank
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Gold Layer Output Summary
# MAGIC
# MAGIC | Table | Description | Partitioned By | Z-Order |
# MAGIC |-------|-------------|----------------|---------|
# MAGIC | gold_epa_air_quality_index | Daily county-level AQI, exceedances, 30-day rolling avg | state | county_fips, date |
# MAGIC | gold_epa_facility_risk | TRI facility releases, media breakdown, risk tiers | state | facility_id |
# MAGIC | gold_epa_water_compliance | Water system violations, compliance scoring | state | pwsid |
# MAGIC | gold_epa_environmental_scorecard | Cross-domain state-level environmental health index | report_year | state, report_year |
# MAGIC
# MAGIC **Dashboard Ready:** All tables optimized for Power BI Direct Lake connectivity.
