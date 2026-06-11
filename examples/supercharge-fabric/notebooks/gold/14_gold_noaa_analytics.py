# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: NOAA Weather & Climate Analytics
# MAGIC
# MAGIC This notebook creates aggregated NOAA weather and climate analytics tables optimized for
# MAGIC Power BI Direct Lake dashboards and severe weather risk assessment.
# MAGIC
# MAGIC ## Output Tables:
# MAGIC - **gold_noaa_weather_summary** - Daily station-level weather KPIs and extreme event counts
# MAGIC - **gold_noaa_storm_impact** - Storm event casualties, damage, and 5-year rolling averages by state
# MAGIC - **gold_noaa_climate_trends** - Annual station-level climate trend analysis (warming/cooling/stable)
# MAGIC - **gold_noaa_severe_weather_risk** - County-level composite risk scoring combining storm + weather data
# MAGIC
# MAGIC ## Key Metrics:
# MAGIC - Temperature, precipitation, humidity, wind speed summaries
# MAGIC - Storm casualties, property/crop damage, deadliest/costliest event types
# MAGIC - Heating/cooling degree days and frost day counts
# MAGIC - Composite severe weather risk scores by county

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
    collect_set,
    count,
    countDistinct,
    current_timestamp,
    days,
    desc,
    filter,
    greatest,
    lag,
    least,
    lit,
    max,
    min,
    rank,
    round,
    row_number,
    slice,
    sum,
    when,
    window,
    year,
)
from pyspark.sql.window import Window

# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source tables (Silver)
SOURCE_WEATHER_OBS = "lh_silver.silver_noaa_weather_observations"
SOURCE_STORM_EVENTS = "lh_silver.silver_noaa_storm_events"
SOURCE_STATION_META = "lh_silver.silver_noaa_station_metadata"

# Target tables (Gold)
TARGET_WEATHER_SUMMARY = "lh_gold.gold_noaa_weather_summary"
TARGET_STORM_IMPACT = "lh_gold.gold_noaa_storm_impact"
TARGET_CLIMATE_TRENDS = "lh_gold.gold_noaa_climate_trends"
TARGET_SEVERE_WEATHER_RISK = "lh_gold.gold_noaa_severe_weather_risk"

print(f"Processing batch: {batch_id}")
print(f"Sources: {SOURCE_WEATHER_OBS}, {SOURCE_STORM_EVENTS}, {SOURCE_STATION_META}")
print(f"Targets:")
print(f"  - {TARGET_WEATHER_SUMMARY}")
print(f"  - {TARGET_STORM_IMPACT}")
print(f"  - {TARGET_CLIMATE_TRENDS}")
print(f"  - {TARGET_SEVERE_WEATHER_RISK}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Data

# COMMAND ----------

df_weather = spark.table(SOURCE_WEATHER_OBS)
df_storms = spark.table(SOURCE_STORM_EVENTS)
df_stations = spark.table(SOURCE_STATION_META)

print(f"Silver weather observations: {df_weather.count():,} records")
print(f"Silver storm events:         {df_storms.count():,} records")
print(f"Silver station metadata:     {df_stations.count():,} records")

weather_date_range = df_weather.agg(
    min("observation_date"), max("observation_date")
).collect()[0]
print(f"Weather date range: {weather_date_range[0]} to {weather_date_range[1]}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 1: Weather Summary

# COMMAND ----------

# MAGIC %md
# MAGIC ### Daily Station-Level Aggregation

# COMMAND ----------

# Enrich weather observations with station metadata
df_weather_enriched = df_weather.alias("w") \
    .join(
        df_stations.select(
            col("station_id"),
            col("station_name"),
            col("state").alias("station_state"),
            col("county").alias("station_county"),
            col("latitude"),
            col("longitude"),
            col("elevation_m"),
        ).alias("s"),
        col("w.station_id") == col("s.station_id"),
        "left"
    )

# COMMAND ----------

# Daily station-level weather summary
df_weather_daily = df_weather_enriched \
    .groupBy(
        col("w.station_id").alias("station_id"),
        "station_name", "station_state", "station_county",
        col("observation_date").alias("date")
    ) \
    .agg(
        # Temperature KPIs
        round(avg("temperature_f"), 1).alias("avg_temp"),
        round(max("temperature_f"), 1).alias("max_temp"),
        round(min("temperature_f"), 1).alias("min_temp"),
        round(max("temperature_f") - min("temperature_f"), 1).alias("temp_range"),

        # Precipitation
        round(sum(coalesce(col("precipitation_in"), lit(0))), 2).alias("total_precip"),

        # Humidity
        round(avg(coalesce(col("relative_humidity_pct"), lit(0))), 1).alias("avg_humidity"),
        round(max(coalesce(col("relative_humidity_pct"), lit(0))), 1).alias("max_humidity"),

        # Wind
        round(avg(coalesce(col("wind_speed_mph"), lit(0))), 1).alias("avg_wind"),
        round(max(coalesce(col("wind_speed_mph"), lit(0))), 1).alias("max_wind_gust"),

        # Extreme weather event counts
        sum(when(col("temperature_f") > 100, 1).otherwise(0)).alias("extreme_heat_obs"),
        sum(when(col("temperature_f") < 0, 1).otherwise(0)).alias("extreme_cold_obs"),
        sum(when(col("wind_speed_mph") > 50, 1).otherwise(0)).alias("high_wind_obs"),
        sum(when(col("precipitation_in") > 2, 1).otherwise(0)).alias("heavy_precip_obs"),

        # Observation count for data quality
        count("*").alias("observation_count"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Extreme Weather Events and Metadata

# COMMAND ----------

df_weather_summary = df_weather_daily \
    .withColumn("extreme_weather_events",
        col("extreme_heat_obs") + col("extreme_cold_obs") +
        col("high_wind_obs") + col("heavy_precip_obs")
    ) \
    .withColumn("weather_severity",
        when(col("extreme_weather_events") >= 3, lit("SEVERE"))
        .when(col("extreme_weather_events") >= 1, lit("MODERATE"))
        .otherwise(lit("NORMAL"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Weather Summary Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_WEATHER_SUMMARY):
        deltaTable = DeltaTable.forName(spark, TARGET_WEATHER_SUMMARY)
        deltaTable.alias("target").merge(
            df_weather_summary.alias("source"),
            "target.station_id = source.station_id AND target.date = source.date"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_weather_summary.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("station_state") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_WEATHER_SUMMARY)

    print(f"Merged {spark.table(TARGET_WEATHER_SUMMARY).count():,} records into {TARGET_WEATHER_SUMMARY}")
except Exception as e:
    print(f"ERROR writing weather summary (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 2: Storm Impact Analytics

# COMMAND ----------

# MAGIC %md
# MAGIC ### Aggregate Storm Events by State, Year, Event Type

# COMMAND ----------

df_storm_agg = df_storms \
    .withColumn("event_year", year("event_date")) \
    .groupBy("state", "event_year", "event_type") \
    .agg(
        # Event counts
        count("*").alias("total_events"),

        # Casualties
        sum(coalesce(col("deaths_direct"), lit(0)) +
            coalesce(col("deaths_indirect"), lit(0))).alias("total_deaths"),
        sum(coalesce(col("injuries_direct"), lit(0)) +
            coalesce(col("injuries_indirect"), lit(0))).alias("total_injuries"),

        # Damage
        round(sum(coalesce(col("damage_property_usd"), lit(0)) +
                  coalesce(col("damage_crops_usd"), lit(0))), 2).alias("total_damage_usd"),
        round(sum(coalesce(col("damage_property_usd"), lit(0))), 2).alias("property_damage_usd"),
        round(sum(coalesce(col("damage_crops_usd"), lit(0))), 2).alias("crop_damage_usd"),

        # Event characteristics
        round(avg(coalesce(col("magnitude"), lit(0))), 2).alias("avg_magnitude"),
        max(coalesce(col("magnitude"), lit(0))).alias("max_magnitude"),

        # Counties affected
        countDistinct("county_fips").alias("counties_affected"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Derived KPIs and Casualties

# COMMAND ----------

df_storm_impact = df_storm_agg \
    .withColumn("total_casualties",
        col("total_deaths") + col("total_injuries")
    ) \
    .withColumn("avg_damage_per_event",
        when(col("total_events") > 0,
            round(col("total_damage_usd") / col("total_events"), 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("fatality_rate",
        when(col("total_events") > 0,
            round(col("total_deaths") / col("total_events"), 4))
        .otherwise(lit(0.0))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Identify Deadliest and Costliest Event Types per State-Year

# COMMAND ----------

# Rank event types within each state-year by casualties and damage
casualty_rank_window = Window.partitionBy("state", "event_year").orderBy(col("total_casualties").desc())
damage_rank_window = Window.partitionBy("state", "event_year").orderBy(col("total_damage_usd").desc())

df_storm_ranked = df_storm_impact \
    .withColumn("casualty_rank", row_number().over(casualty_rank_window)) \
    .withColumn("damage_rank", row_number().over(damage_rank_window))

# Get deadliest and costliest event types per state-year
df_deadliest = df_storm_ranked \
    .filter(col("casualty_rank") == 1) \
    .select(
        col("state").alias("d_state"),
        col("event_year").alias("d_year"),
        col("event_type").alias("deadliest_event_type")
    )

df_costliest = df_storm_ranked \
    .filter(col("damage_rank") == 1) \
    .select(
        col("state").alias("c_state"),
        col("event_year").alias("c_year"),
        col("event_type").alias("costliest_event_type")
    )

# Join back
df_storm_enriched = df_storm_impact.alias("s") \
    .join(df_deadliest.alias("d"),
          (col("s.state") == col("d.d_state")) &
          (col("s.event_year") == col("d.d_year")),
          "left") \
    .join(df_costliest.alias("c"),
          (col("s.state") == col("c.c_state")) &
          (col("s.event_year") == col("c.c_year")),
          "left") \
    .drop("d_state", "d_year", "c_state", "c_year")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Rolling 5-Year Averages

# COMMAND ----------

rolling_window = Window.partitionBy("state", "event_type") \
    .orderBy("event_year") \
    .rowsBetween(-4, 0)

df_storm_final = df_storm_enriched \
    .withColumn("rolling_5yr_avg_events",
        round(avg("total_events").over(rolling_window), 1)
    ) \
    .withColumn("rolling_5yr_avg_damage",
        round(avg("total_damage_usd").over(rolling_window), 2)
    ) \
    .withColumn("rolling_5yr_avg_casualties",
        round(avg("total_casualties").over(rolling_window), 1)
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Storm Impact Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_STORM_IMPACT):
        deltaTable = DeltaTable.forName(spark, TARGET_STORM_IMPACT)
        deltaTable.alias("target").merge(
            df_storm_final.alias("source"),
            "target.state = source.state AND target.event_year = source.event_year AND target.event_type = source.event_type"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_storm_final.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("event_year") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_STORM_IMPACT)

    print(f"Merged {df_storm_final.count():,} records into {TARGET_STORM_IMPACT}")
except Exception as e:
    print(f"ERROR writing storm impact (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 3: Climate Trends

# COMMAND ----------

# MAGIC %md
# MAGIC ### Annual Station-Level Climate Aggregation

# COMMAND ----------

# Base temperature for degree day calculation (65 degrees F)
BASE_TEMP_F = 65

df_annual_climate = df_weather_enriched \
    .withColumn("obs_year", year("observation_date")) \
    .groupBy(col("w.station_id").alias("station_id"),
             "station_name", "station_state",
             "latitude", "longitude", "elevation_m",
             "obs_year") \
    .agg(
        # Temperature
        round(avg("temperature_f"), 2).alias("annual_avg_temp"),
        round(max("temperature_f"), 1).alias("annual_max_temp"),
        round(min("temperature_f"), 1).alias("annual_min_temp"),

        # Precipitation
        round(sum(coalesce(col("precipitation_in"), lit(0))), 2).alias("annual_precip"),

        # Degree days
        round(sum(
            when(col("temperature_f") < BASE_TEMP_F,
                 lit(BASE_TEMP_F) - col("temperature_f"))
            .otherwise(lit(0))
        ), 1).alias("heating_degree_days"),
        round(sum(
            when(col("temperature_f") > BASE_TEMP_F,
                 col("temperature_f") - lit(BASE_TEMP_F))
            .otherwise(lit(0))
        ), 1).alias("cooling_degree_days"),

        # Frost days (min temp <= 32 F)
        sum(when(col("temperature_f") <= 32, 1).otherwise(0)).alias("frost_days"),

        # Hot days (max temp >= 90 F)
        sum(when(col("temperature_f") >= 90, 1).otherwise(0)).alias("hot_days"),

        # Observation count
        count("*").alias("total_observations"),
        countDistinct("observation_date").alias("days_with_data"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Temperature Trend Direction

# COMMAND ----------

# Year-over-year temperature change for trend detection
trend_window = Window.partitionBy("station_id").orderBy("obs_year")
trend_3yr_window = Window.partitionBy("station_id").orderBy("obs_year").rowsBetween(-2, 0)

df_climate_trends = df_annual_climate \
    .withColumn("prev_year_avg_temp",
        lag("annual_avg_temp", 1).over(trend_window)
    ) \
    .withColumn("temp_change_yoy",
        when(col("prev_year_avg_temp").isNotNull(),
            round(col("annual_avg_temp") - col("prev_year_avg_temp"), 2))
        .otherwise(lit(None))
    ) \
    .withColumn("rolling_3yr_avg_temp",
        round(avg("annual_avg_temp").over(trend_3yr_window), 2)
    ) \
    .withColumn("prev_3yr_avg_temp",
        lag("rolling_3yr_avg_temp", 3).over(trend_window)
    ) \
    .withColumn("trend_direction",
        when(col("prev_3yr_avg_temp").isNull(), lit("INSUFFICIENT_DATA"))
        .when(col("rolling_3yr_avg_temp") - col("prev_3yr_avg_temp") > 0.5, lit("WARMING"))
        .when(col("rolling_3yr_avg_temp") - col("prev_3yr_avg_temp") < -0.5, lit("COOLING"))
        .otherwise(lit("STABLE"))
    ) \
    .withColumn("precip_trend",
        when(col("annual_precip") > 60, lit("WET"))
        .when(col("annual_precip") < 20, lit("DRY"))
        .otherwise(lit("NORMAL"))
    ) \
    .drop("prev_year_avg_temp", "prev_3yr_avg_temp") \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Climate Trends Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_CLIMATE_TRENDS):
        deltaTable = DeltaTable.forName(spark, TARGET_CLIMATE_TRENDS)
        deltaTable.alias("target").merge(
            df_climate_trends.alias("source"),
            "target.station_id = source.station_id AND target.obs_year = source.obs_year"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_climate_trends.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("station_state") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_CLIMATE_TRENDS)

    print(f"Merged {df_climate_trends.count():,} records into {TARGET_CLIMATE_TRENDS}")
except Exception as e:
    print(f"ERROR writing climate trends (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 4: Severe Weather Risk (County-Level)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Combine Storm and Weather Data by County

# COMMAND ----------

# County-level storm history
df_county_storms = df_storms \
    .groupBy("state", "county_fips", "county_name") \
    .agg(
        count("*").alias("historical_storm_events"),
        sum(coalesce(col("deaths_direct"), lit(0)) +
            coalesce(col("deaths_indirect"), lit(0))).alias("historical_deaths"),
        sum(coalesce(col("injuries_direct"), lit(0)) +
            coalesce(col("injuries_indirect"), lit(0))).alias("historical_injuries"),
        round(sum(coalesce(col("damage_property_usd"), lit(0)) +
                  coalesce(col("damage_crops_usd"), lit(0))), 2).alias("historical_damage"),
        countDistinct("event_type").alias("hazard_type_count"),
        countDistinct(year("event_date")).alias("years_with_events"),

        # Top hazards
        collect_set("event_type").alias("top_hazards_array"),
    )

# COMMAND ----------

# County-level weather extremes
df_county_weather = df_weather_enriched \
    .filter(col("station_county").isNotNull()) \
    .groupBy(col("station_state").alias("w_state"),
             col("station_county").alias("w_county")) \
    .agg(
        round(avg("temperature_f"), 1).alias("avg_temperature"),
        round(max("temperature_f"), 1).alias("record_high"),
        round(min("temperature_f"), 1).alias("record_low"),
        round(sum(coalesce(col("precipitation_in"), lit(0))), 2).alias("total_precip"),
        round(max(coalesce(col("wind_speed_mph"), lit(0))), 1).alias("max_wind"),
        count(when(col("temperature_f") > 100, True)).alias("extreme_heat_days"),
        count(when(col("wind_speed_mph") > 50, True)).alias("high_wind_days"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Composite Risk Score

# COMMAND ----------

# Join storm and weather data at county level
df_county_risk = df_county_storms.alias("s") \
    .join(
        df_county_weather.alias("w"),
        (col("s.state") == col("w.w_state")) &
        (col("s.county_name") == col("w.w_county")),
        "left"
    ) \
    .drop("w_state", "w_county")

# COMMAND ----------

# Calculate frequency index and composite risk score
df_severe_risk = df_county_risk \
    .withColumn("frequency_index",
        when(col("years_with_events") > 0,
            round(col("historical_storm_events") / col("years_with_events"), 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("casualty_score",
        least(
            round((col("historical_deaths") * 10 + col("historical_injuries")) / greatest(col("years_with_events"), lit(1)), 2),
            lit(100.0)
        )
    ) \
    .withColumn("damage_score",
        least(
            round(col("historical_damage") / greatest(col("years_with_events"), lit(1)) / 1000000, 2),
            lit(100.0)
        )
    ) \
    .withColumn("hazard_diversity_score",
        least(round(col("hazard_type_count") * 5, 0), lit(50.0))
    ) \
    .withColumn("weather_extreme_score",
        least(
            round(
                coalesce(col("extreme_heat_days"), lit(0)) * 2 +
                coalesce(col("high_wind_days"), lit(0)) * 3, 2
            ),
            lit(50.0)
        )
    )

# COMMAND ----------

# Composite risk score (weighted)
df_risk_scored = df_severe_risk \
    .withColumn("risk_score",
        round(
            col("casualty_score") * 0.30 +
            col("damage_score") * 0.25 +
            col("frequency_index") * 0.20 +
            col("hazard_diversity_score") * 0.15 +
            col("weather_extreme_score") * 0.10,
            2
        )
    ) \
    .withColumn("top_hazards",
        slice(col("top_hazards_array"), 1, 5)
    ) \
    .drop("top_hazards_array")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Risk Tier and Rankings

# COMMAND ----------

risk_rank_window = Window.orderBy(col("risk_score").desc())
state_risk_rank_window = Window.partitionBy("state").orderBy(col("risk_score").desc())

df_risk_final = df_risk_scored \
    .withColumn("national_risk_rank",
        row_number().over(risk_rank_window)
    ) \
    .withColumn("state_risk_rank",
        row_number().over(state_risk_rank_window)
    ) \
    .withColumn("risk_tier",
        when(col("risk_score") >= 75, lit("CRITICAL"))
        .when(col("risk_score") >= 50, lit("HIGH"))
        .when(col("risk_score") >= 25, lit("MODERATE"))
        .when(col("risk_score") >= 10, lit("LOW"))
        .otherwise(lit("MINIMAL"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Severe Weather Risk Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_SEVERE_WEATHER_RISK):
        deltaTable = DeltaTable.forName(spark, TARGET_SEVERE_WEATHER_RISK)
        deltaTable.alias("target").merge(
            df_risk_final.alias("source"),
            "target.state = source.state AND target.county_fips = source.county_fips"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_risk_final.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("state") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_SEVERE_WEATHER_RISK)

    print(f"Merged {df_risk_final.count():,} records into {TARGET_SEVERE_WEATHER_RISK}")
except Exception as e:
    print(f"ERROR writing severe weather risk (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Optimize All Gold Tables for Direct Lake

# COMMAND ----------

spark.sql(f"OPTIMIZE {TARGET_WEATHER_SUMMARY} ZORDER BY (station_id, date)")
print(f"Optimized {TARGET_WEATHER_SUMMARY}")

spark.sql(f"OPTIMIZE {TARGET_STORM_IMPACT} ZORDER BY (state, event_type)")
print(f"Optimized {TARGET_STORM_IMPACT}")

spark.sql(f"OPTIMIZE {TARGET_CLIMATE_TRENDS} ZORDER BY (station_id, obs_year)")
print(f"Optimized {TARGET_CLIMATE_TRENDS}")

spark.sql(f"OPTIMIZE {TARGET_SEVERE_WEATHER_RISK} ZORDER BY (county_fips, risk_score)")
print(f"Optimized {TARGET_SEVERE_WEATHER_RISK}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Validation & Summary

# COMMAND ----------

# MAGIC %md
# MAGIC ### Weather Summary Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        COUNT(DISTINCT station_id) as stations,
        COUNT(DISTINCT date) as days,
        ROUND(AVG(avg_temp), 1) as overall_avg_temp,
        ROUND(SUM(total_precip), 2) as total_precip,
        SUM(extreme_weather_events) as extreme_events
    FROM {TARGET_WEATHER_SUMMARY}
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Storm Impact Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        event_year,
        COUNT(DISTINCT state) as states,
        SUM(total_events) as total_events,
        SUM(total_casualties) as total_casualties,
        ROUND(SUM(total_damage_usd) / 1000000, 2) as total_damage_millions
    FROM {TARGET_STORM_IMPACT}
    GROUP BY event_year
    ORDER BY event_year DESC
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Climate Trends Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        trend_direction,
        COUNT(*) as station_years,
        ROUND(AVG(annual_avg_temp), 2) as avg_temp,
        ROUND(AVG(annual_precip), 2) as avg_precip,
        ROUND(AVG(heating_degree_days), 0) as avg_hdd,
        ROUND(AVG(cooling_degree_days), 0) as avg_cdd
    FROM {TARGET_CLIMATE_TRENDS}
    GROUP BY trend_direction
    ORDER BY station_years DESC
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Severe Weather Risk Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        risk_tier,
        COUNT(*) as counties,
        ROUND(AVG(risk_score), 2) as avg_risk_score,
        ROUND(SUM(historical_damage) / 1000000, 2) as total_damage_millions,
        ROUND(AVG(frequency_index), 2) as avg_frequency_index
    FROM {TARGET_SEVERE_WEATHER_RISK}
    GROUP BY risk_tier
    ORDER BY avg_risk_score DESC
""").show(truncate=False)

# COMMAND ----------

# Top 10 highest-risk counties
print("Top 10 Highest-Risk Counties:")
spark.sql(f"""
    SELECT
        national_risk_rank as rank,
        state,
        county_name,
        risk_score,
        risk_tier,
        historical_storm_events,
        historical_damage,
        frequency_index,
        top_hazards
    FROM {TARGET_SEVERE_WEATHER_RISK}
    ORDER BY national_risk_rank
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Gold Layer Output Summary
# MAGIC
# MAGIC | Table | Description | Partitioned By | Z-Order |
# MAGIC |-------|-------------|----------------|---------|
# MAGIC | gold_noaa_weather_summary | Daily station-level weather KPIs and extreme events | station_state | station_id, date |
# MAGIC | gold_noaa_storm_impact | Storm casualties, damage, 5-yr rolling averages | event_year | state, event_type |
# MAGIC | gold_noaa_climate_trends | Annual temp/precip trends, degree days, frost days | station_state | station_id, obs_year |
# MAGIC | gold_noaa_severe_weather_risk | County-level composite risk scoring | state | county_fips, risk_score |
# MAGIC
# MAGIC **Dashboard Ready:** All tables optimized for Power BI Direct Lake connectivity.
