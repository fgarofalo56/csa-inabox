# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: USDA Agriculture & Food Safety Analytics
# MAGIC
# MAGIC This notebook creates aggregated USDA analytics tables from Silver crop production
# MAGIC and food safety data, optimized for Power BI Direct Lake dashboards.
# MAGIC
# MAGIC ## Output Tables:
# MAGIC - **gold_usda_crop_summary** - Commodity-level production KPIs with YoY trends and performance flags
# MAGIC - **gold_usda_state_agriculture** - State-level agricultural profile with diversity and dominance metrics
# MAGIC - **gold_usda_food_safety_dashboard** - Recall analytics with severity scoring and rolling trends
# MAGIC - **gold_usda_executive_summary** - Cross-domain annual executive view combining crop and recall data
# MAGIC
# MAGIC ## Key Metrics:
# MAGIC - Year-over-year production change, commodity ranking, performance flags
# MAGIC - State crop diversity index, dominant commodity, production value
# MAGIC - Recall severity-weighted scores, rolling 12-month trends, nationwide distribution rate
# MAGIC - Food safety index (inverse Class I recall rate), top commodities and recall reasons

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
    collect_list,
    concat_ws,
    count,
    countDistinct,
    current_timestamp,
    date_format,
    desc,
    desc_nulls_last,
    explode,
    filter,
    lag,
    lit,
    max,
    min,
    months,
    quarter,
    round,
    row_number,
    sum,
    to_date,
    when,
    window,
    year,
    years,
)
from pyspark.sql.window import Window

# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source tables (Silver)
SOURCE_CROP_PRODUCTION = "lh_silver.silver_usda_crop_production"
SOURCE_FOOD_SAFETY = "lh_silver.silver_usda_food_safety"

# Target tables (Gold)
TARGET_CROP_SUMMARY = "lh_gold.gold_usda_crop_summary"
TARGET_STATE_AGRICULTURE = "lh_gold.gold_usda_state_agriculture"
TARGET_FOOD_SAFETY_DASHBOARD = "lh_gold.gold_usda_food_safety_dashboard"
TARGET_EXECUTIVE_SUMMARY = "lh_gold.gold_usda_executive_summary"

print(f"Processing batch: {batch_id}")
print(f"Sources: {SOURCE_CROP_PRODUCTION}, {SOURCE_FOOD_SAFETY}")
print(f"Targets:")
print(f"  - {TARGET_CROP_SUMMARY}")
print(f"  - {TARGET_STATE_AGRICULTURE}")
print(f"  - {TARGET_FOOD_SAFETY_DASHBOARD}")
print(f"  - {TARGET_EXECUTIVE_SUMMARY}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Data

# COMMAND ----------

df_crop = spark.table(SOURCE_CROP_PRODUCTION)
df_food_safety = spark.table(SOURCE_FOOD_SAFETY)

crop_count = df_crop.count()
food_safety_count = df_food_safety.count()

print(f"Silver crop production: {crop_count:,} records")
print(f"Silver food safety:     {food_safety_count:,} records")

crop_year_range = df_crop.agg(min("year"), max("year")).collect()[0]
print(f"Crop year range: {crop_year_range[0]} to {crop_year_range[1]}")

recall_date_range = df_food_safety.agg(min("recall_date"), max("recall_date")).collect()[0]
print(f"Recall date range: {recall_date_range[0]} to {recall_date_range[1]}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## TABLE 1: gold_usda_crop_summary
# MAGIC ---
# MAGIC
# MAGIC Commodity-level production KPIs aggregated by commodity, year, state, and
# MAGIC aggregation level. Includes year-over-year change, commodity ranking, and
# MAGIC performance flags for actionable dashboard filtering.

# COMMAND ----------

# MAGIC %md
# MAGIC ### Pivot Statistic Categories into Columns

# COMMAND ----------

# Each Silver record represents a single statistic category (AREA PLANTED, YIELD, etc.)
# Pivot these into one row per (commodity, year, state_name, agg_level_desc) with
# separate KPI columns for each statistic category.

df_crop_pivoted = df_crop \
    .groupBy("commodity", "year", "state_name", "agg_level_desc") \
    .agg(
        # Production: sum of PRODUCTION values
        sum(when(col("statisticcat_desc") == "PRODUCTION", col("value"))
            ).alias("total_production"),

        # Yield: average of YIELD values
        avg(when(col("statisticcat_desc") == "YIELD", col("value"))
            ).alias("avg_yield"),

        # Area Planted: sum of AREA PLANTED values
        sum(when(col("statisticcat_desc") == "AREA PLANTED", col("value"))
            ).alias("total_area_planted"),

        # Area Harvested: sum of AREA HARVESTED values
        sum(when(col("statisticcat_desc") == "AREA HARVESTED", col("value"))
            ).alias("total_area_harvested"),

        # Price Received: average of PRICE RECEIVED values
        avg(when(col("statisticcat_desc") == "PRICE RECEIVED", col("value"))
            ).alias("avg_price_received"),

        # Data quality from Silver layer
        round(avg("_dq_score"), 2).alias("avg_data_quality"),

        # Record count for traceability
        count("*").alias("source_record_count"),
    )

print(f"Pivoted crop records: {df_crop_pivoted.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Compute Year-over-Year Change

# COMMAND ----------

# Window for YoY comparison: partition by commodity + state + agg level, order by year
yoy_window = Window.partitionBy(
    "commodity", "state_name", "agg_level_desc"
).orderBy("year")

df_crop_yoy = df_crop_pivoted \
    .withColumn("prev_year_production",
        lag("total_production", 1).over(yoy_window)
    ) \
    .withColumn("year_over_year_change_pct",
        when(
            col("prev_year_production").isNotNull() & (col("prev_year_production") > 0),
            round(
                (col("total_production") - col("prev_year_production"))
                / col("prev_year_production") * 100, 2
            )
        ).otherwise(lit(None))
    ) \
    .drop("prev_year_production")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Compute Commodity Rank and Performance Flags

# COMMAND ----------

# Rank commodities by total_production within each year
rank_window = Window.partitionBy("year").orderBy(col("total_production").desc_nulls_last())

# Window for yield trend detection (prev year yield for same commodity+state)
yield_trend_window = Window.partitionBy(
    "commodity", "state_name", "agg_level_desc"
).orderBy("year")

# Window for acreage trend detection
acreage_trend_window = Window.partitionBy(
    "commodity", "state_name", "agg_level_desc"
).orderBy("year")

df_crop_ranked = df_crop_yoy \
    .withColumn("commodity_rank",
        row_number().over(rank_window)
    ) \
    .withColumn("prev_yield",
        lag("avg_yield", 1).over(yield_trend_window)
    ) \
    .withColumn("prev_area_planted",
        lag("total_area_planted", 1).over(acreage_trend_window)
    )

# COMMAND ----------

# Apply performance flags based on rank, yield trend, and acreage trend
df_crop_flagged = df_crop_ranked \
    .withColumn("performance_flag",
        when(col("commodity_rank") <= 5, lit("TOP_PRODUCER"))
        .when(
            col("prev_yield").isNotNull() & (col("prev_yield") > 0) &
            (col("avg_yield") < col("prev_yield") * 0.95),
            lit("DECLINING_YIELD")
        )
        .when(
            col("prev_area_planted").isNotNull() & (col("prev_area_planted") > 0) &
            (col("total_area_planted") > col("prev_area_planted") * 1.05),
            lit("EXPANDING_ACREAGE")
        )
        .otherwise(lit(None))
    ) \
    .drop("prev_yield", "prev_area_planted")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Metadata and Write Crop Summary

# COMMAND ----------

try:
    df_crop_summary = df_crop_flagged \
        .withColumn("_gold_timestamp", current_timestamp()) \
        .withColumn("_batch_id", lit(batch_id)) \
        .select(
            "commodity", "year", "state_name", "agg_level_desc",
            "total_production", "avg_yield", "total_area_planted",
            "total_area_harvested", "avg_price_received",
            "year_over_year_change_pct", "commodity_rank", "performance_flag",
            "avg_data_quality", "source_record_count",
            "_gold_timestamp", "_batch_id"
        )

    if spark.catalog.tableExists(TARGET_CROP_SUMMARY):
        deltaTable = DeltaTable.forName(spark, TARGET_CROP_SUMMARY)
        deltaTable.alias("target").merge(
            df_crop_summary.alias("source"),
            "target.commodity = source.commodity AND target.year = source.year AND target.state_name = source.state_name AND target.agg_level_desc = source.agg_level_desc"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_crop_summary.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_CROP_SUMMARY)

    print(f"Merged {spark.table(TARGET_CROP_SUMMARY).count():,} records into {TARGET_CROP_SUMMARY}")
except Exception as e:
    print(f"ERROR writing crop summary (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## TABLE 2: gold_usda_state_agriculture
# MAGIC ---
# MAGIC
# MAGIC State-level agricultural profile aggregated by state, FIPS code, and year.
# MAGIC Captures crop diversity, dominant commodity, and estimated production value.

# COMMAND ----------

# MAGIC %md
# MAGIC ### Aggregate State-Level Metrics

# COMMAND ----------

# Production records only (to compute total production value)
df_crop_production_rows = df_crop.filter(col("statisticcat_desc") == "PRODUCTION")
df_crop_price_rows = df_crop.filter(col("statisticcat_desc") == "PRICE RECEIVED")

# Build per-state, per-year aggregations from production rows
df_state_base = df_crop_production_rows \
    .groupBy("state_name", "state_fips", "year") \
    .agg(
        countDistinct("commodity").alias("total_commodities_grown"),
        sum("value").alias("total_production_volume"),
        count("*").alias("production_record_count"),
    )

# Get average price per commodity per state per year
df_price_avg = df_crop_price_rows \
    .groupBy("state_name", "state_fips", "year", "commodity") \
    .agg(
        avg("value").alias("avg_price")
    )

# Get production per commodity per state per year
df_prod_by_commodity = df_crop_production_rows \
    .groupBy("state_name", "state_fips", "year", "commodity") \
    .agg(
        sum("value").alias("commodity_production")
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Compute Production Value and Dominant Commodity

# COMMAND ----------

# Join production with price to estimate production value
df_prod_value = df_prod_by_commodity.alias("p") \
    .join(
        df_price_avg.alias("pr"),
        (col("p.state_name") == col("pr.state_name")) &
        (col("p.state_fips") == col("pr.state_fips")) &
        (col("p.year") == col("pr.year")) &
        (col("p.commodity") == col("pr.commodity")),
        "left"
    ) \
    .select(
        col("p.state_name"),
        col("p.state_fips"),
        col("p.year"),
        col("p.commodity"),
        col("p.commodity_production"),
        (coalesce(col("p.commodity_production"), lit(0)) *
         coalesce(col("pr.avg_price"), lit(0))).alias("estimated_value")
    )

# Total production value per state per year
df_state_value = df_prod_value \
    .groupBy("state_name", "state_fips", "year") \
    .agg(
        round(sum("estimated_value"), 2).alias("total_production_value")
    )

# Dominant commodity: highest production volume per state per year
dom_window = Window.partitionBy("state_name", "state_fips", "year") \
    .orderBy(col("commodity_production").desc_nulls_last())

df_dominant = df_prod_value \
    .withColumn("_rank", row_number().over(dom_window)) \
    .filter(col("_rank") == 1) \
    .select(
        col("state_name").alias("dom_state_name"),
        col("state_fips").alias("dom_state_fips"),
        col("year").alias("dom_year"),
        col("commodity").alias("dominant_commodity")
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Compute Crop Diversity Index and Data Quality

# COMMAND ----------

# Crop diversity index = count of distinct commodities grown (already in total_commodities_grown)
# Average data quality from all crop records per state per year
df_state_quality = df_crop \
    .groupBy("state_name", "state_fips", "year") \
    .agg(
        round(avg("_dq_score"), 2).alias("avg_data_quality")
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Join All State Components and Write

# COMMAND ----------

df_state_agriculture = df_state_base.alias("b") \
    .join(
        df_state_value.alias("v"),
        (col("b.state_name") == col("v.state_name")) &
        (col("b.state_fips") == col("v.state_fips")) &
        (col("b.year") == col("v.year")),
        "left"
    ) \
    .join(
        df_dominant.alias("d"),
        (col("b.state_name") == col("d.dom_state_name")) &
        (col("b.state_fips") == col("d.dom_state_fips")) &
        (col("b.year") == col("d.dom_year")),
        "left"
    ) \
    .join(
        df_state_quality.alias("q"),
        (col("b.state_name") == col("q.state_name")) &
        (col("b.state_fips") == col("q.state_fips")) &
        (col("b.year") == col("q.year")),
        "left"
    ) \
    .select(
        col("b.state_name"),
        col("b.state_fips"),
        col("b.year"),
        col("b.total_commodities_grown"),
        coalesce(col("v.total_production_value"), lit(0.0)).alias("total_production_value"),
        col("b.total_commodities_grown").alias("crop_diversity_index"),
        col("d.dominant_commodity"),
        coalesce(col("q.avg_data_quality"), lit(0.0)).alias("avg_data_quality"),
        col("b.production_record_count"),
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

try:
    if spark.catalog.tableExists(TARGET_STATE_AGRICULTURE):
        deltaTable = DeltaTable.forName(spark, TARGET_STATE_AGRICULTURE)
        deltaTable.alias("target").merge(
            df_state_agriculture.alias("source"),
            "target.state_name = source.state_name AND target.state_fips = source.state_fips AND target.year = source.year"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_state_agriculture.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("year") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_STATE_AGRICULTURE)

    print(f"Merged {df_state_agriculture.count():,} records into {TARGET_STATE_AGRICULTURE}")
except Exception as e:
    print(f"ERROR writing state agriculture (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## TABLE 3: gold_usda_food_safety_dashboard
# MAGIC ---
# MAGIC
# MAGIC Recall analytics aggregated by year, quarter, recall class, and product type.
# MAGIC Includes severity-weighted scoring and rolling 12-month trend indicators.

# COMMAND ----------

# MAGIC %md
# MAGIC ### Parse Dates and Aggregate Recall Metrics

# COMMAND ----------

# Parse recall_date and extract temporal dimensions
df_recalls = df_food_safety \
    .withColumn("recall_date_parsed", to_date(col("recall_date"), "yyyy-MM-dd")) \
    .withColumn("recall_year", year("recall_date_parsed")) \
    .withColumn("recall_quarter", quarter("recall_date_parsed")) \
    .withColumn("recall_year_month",
        date_format(col("recall_date_parsed"), "yyyy-MM"))

# Aggregate by year, quarter, recall_class, product_type
df_recall_agg = df_recalls \
    .groupBy("recall_year", "recall_quarter", "recall_class", "product_type") \
    .agg(
        # Volume KPIs
        count("*").alias("total_recalls"),
        sum(coalesce(col("pounds_recalled"), lit(0))).alias("total_pounds_recalled"),
        round(avg(coalesce(col("pounds_recalled"), lit(0))), 2).alias("avg_pounds_per_recall"),

        # Distribution scope
        round(
            sum(when(col("distribution") == "Nationwide", 1).otherwise(0))
            / count("*") * 100, 2
        ).alias("pct_nationwide_distribution"),

        # Most common reason: use mode via grouping
        # We collect all reasons and pick the most frequent below
        collect_list("reason").alias("_reasons_list"),

        # Status breakdown
        sum(when(col("status") == "OPEN", 1).otherwise(0)).alias("open_recalls"),
        sum(when(col("status") == "CLOSED", 1).otherwise(0)).alias("closed_recalls"),
        sum(when(col("status") == "EXPANDED", 1).otherwise(0)).alias("expanded_recalls"),

        # Risk level breakdown
        sum(when(col("risk_level") == "HIGH", 1).otherwise(0)).alias("high_risk_count"),
        sum(when(col("risk_level") == "MEDIUM", 1).otherwise(0)).alias("medium_risk_count"),
        sum(when(col("risk_level") == "LOW", 1).otherwise(0)).alias("low_risk_count"),

        # Companies involved
        countDistinct("company_name").alias("companies_involved"),
        countDistinct("state").alias("states_involved"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Extract Most Common Reason per Group

# COMMAND ----------

# UDF-free approach: explode reasons, count, and rejoin the top reason
# The _reasons_list column is an array of all reasons in the group.
# We derive the mode by finding the most frequent element.

# Helper: extract mode from array column using inline SQL expression
# Sort the array, find the most frequent element via a subquery approach
df_recall_with_reason = df_recall_agg \
    .withColumn("_reason_exploded", explode("_reasons_list")) \
    .groupBy(
        "recall_year", "recall_quarter", "recall_class", "product_type",
        "total_recalls", "total_pounds_recalled", "avg_pounds_per_recall",
        "pct_nationwide_distribution", "open_recalls", "closed_recalls",
        "expanded_recalls", "high_risk_count", "medium_risk_count",
        "low_risk_count", "companies_involved", "states_involved",
        "_reason_exploded"
    ) \
    .agg(count("*").alias("_reason_freq"))

# Rank reasons within each group and pick the top one
reason_rank_window = Window.partitionBy(
    "recall_year", "recall_quarter", "recall_class", "product_type"
).orderBy(col("_reason_freq").desc())

df_recall_top_reason = df_recall_with_reason \
    .withColumn("_rn", row_number().over(reason_rank_window)) \
    .filter(col("_rn") == 1) \
    .withColumnRenamed("_reason_exploded", "most_common_reason") \
    .drop("_rn", "_reason_freq")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Compute Severity-Weighted Score

# COMMAND ----------

# Severity weights: Class I = 3, Class II = 2, Class III = 1
# severity_weighted_score = (high_risk * 3 + medium_risk * 2 + low_risk * 1) / total_recalls
df_recall_scored = df_recall_top_reason \
    .withColumn("severity_weighted_score",
        round(
            (col("high_risk_count") * 3 + col("medium_risk_count") * 2 + col("low_risk_count") * 1)
            / col("total_recalls"), 2
        )
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Compute Rolling 12-Month Trends

# COMMAND ----------

# Rolling window: 4 quarters back (approximately 12 months) partitioned by recall_class + product_type
# Order by year and quarter combined as a sortable integer
df_recall_ordered = df_recall_scored \
    .withColumn("_year_quarter_sort",
        col("recall_year") * 10 + col("recall_quarter")
    )

rolling_window = Window.partitionBy("recall_class", "product_type") \
    .orderBy("_year_quarter_sort") \
    .rowsBetween(-3, 0)  # Current quarter plus 3 prior = ~12 months

df_recall_rolling = df_recall_ordered \
    .withColumn("rolling_12m_recalls",
        sum("total_recalls").over(rolling_window)
    ) \
    .withColumn("rolling_12m_pounds",
        sum("total_pounds_recalled").over(rolling_window)
    ) \
    .withColumn("rolling_12m_avg_severity",
        round(avg("severity_weighted_score").over(rolling_window), 2)
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Trend Direction Indicator

# COMMAND ----------

# Compare current quarter recalls to the prior quarter
trend_window = Window.partitionBy("recall_class", "product_type") \
    .orderBy("_year_quarter_sort")

df_recall_trends = df_recall_rolling \
    .withColumn("_prev_quarter_recalls",
        lag("total_recalls", 1).over(trend_window)
    ) \
    .withColumn("recall_trend",
        when(col("_prev_quarter_recalls").isNull(), lit("NEW"))
        .when(col("total_recalls") > col("_prev_quarter_recalls") * 1.10, lit("INCREASING"))
        .when(col("total_recalls") < col("_prev_quarter_recalls") * 0.90, lit("DECREASING"))
        .otherwise(lit("STABLE"))
    ) \
    .drop("_prev_quarter_recalls", "_year_quarter_sort")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Metadata and Write Food Safety Dashboard

# COMMAND ----------

df_food_safety_dashboard = df_recall_trends \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id)) \
    .select(
        "recall_year", "recall_quarter", "recall_class", "product_type",
        "total_recalls", "total_pounds_recalled", "avg_pounds_per_recall",
        "pct_nationwide_distribution", "most_common_reason",
        "severity_weighted_score",
        "open_recalls", "closed_recalls", "expanded_recalls",
        "high_risk_count", "medium_risk_count", "low_risk_count",
        "companies_involved", "states_involved",
        "rolling_12m_recalls", "rolling_12m_pounds", "rolling_12m_avg_severity",
        "recall_trend",
        "_gold_timestamp", "_batch_id"
    )

try:
    if spark.catalog.tableExists(TARGET_FOOD_SAFETY_DASHBOARD):
        deltaTable = DeltaTable.forName(spark, TARGET_FOOD_SAFETY_DASHBOARD)
        deltaTable.alias("target").merge(
            df_food_safety_dashboard.alias("source"),
            "target.recall_year = source.recall_year AND target.recall_quarter = source.recall_quarter AND target.recall_class = source.recall_class AND target.product_type = source.product_type"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_food_safety_dashboard.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_FOOD_SAFETY_DASHBOARD)

    print(f"Merged {df_food_safety_dashboard.count():,} records into {TARGET_FOOD_SAFETY_DASHBOARD}")
except Exception as e:
    print(f"ERROR writing food safety dashboard (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## TABLE 4: gold_usda_executive_summary
# MAGIC ---
# MAGIC
# MAGIC Cross-domain annual executive view with one row per year combining
# MAGIC crop production metrics and food safety recall metrics for high-level
# MAGIC leadership dashboards.

# COMMAND ----------

# MAGIC %md
# MAGIC ### Aggregate Annual Crop Production Metrics

# COMMAND ----------

df_annual_crop = df_crop \
    .groupBy("year") \
    .agg(
        count("*").alias("total_crop_production_records"),
        countDistinct("commodity").alias("distinct_commodities"),
        countDistinct("state_name").alias("distinct_states_reporting"),
    )

# Top 3 commodities by record count per year
df_top_commodities = df_crop \
    .groupBy("year", "commodity") \
    .agg(count("*").alias("_cnt"))

top_comm_window = Window.partitionBy("year").orderBy(col("_cnt").desc())

df_top3_commodities = df_top_commodities \
    .withColumn("_rn", row_number().over(top_comm_window)) \
    .filter(col("_rn") <= 3) \
    .groupBy("year") \
    .agg(
        concat_ws(", ", collect_list("commodity")).alias("top_3_commodities")
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Aggregate Annual Food Safety Metrics

# COMMAND ----------

df_annual_recalls = df_recalls \
    .groupBy("recall_year") \
    .agg(
        count("*").alias("total_recall_events"),
        sum(when(col("recall_class") == "Class I", 1).otherwise(0)).alias("class_i_recalls"),
        sum(coalesce(col("pounds_recalled"), lit(0))).alias("total_pounds_recalled"),
        countDistinct("company_name").alias("distinct_companies_recalled"),
    ) \
    .withColumnRenamed("recall_year", "year")

# Food safety index: inverse of Class I recall rate
# Higher index = safer (fewer Class I recalls relative to total)
df_annual_recalls = df_annual_recalls \
    .withColumn("food_safety_index",
        when(col("total_recall_events") > 0,
            round(
                (1 - (col("class_i_recalls") / col("total_recall_events"))) * 100, 2
            )
        ).otherwise(lit(100.0))
    )

# Top 3 recall reasons per year
df_top_reasons = df_recalls \
    .groupBy("recall_year", "reason") \
    .agg(count("*").alias("_cnt"))

top_reason_window = Window.partitionBy("recall_year").orderBy(col("_cnt").desc())

df_top3_reasons = df_top_reasons \
    .withColumn("_rn", row_number().over(top_reason_window)) \
    .filter(col("_rn") <= 3) \
    .groupBy("recall_year") \
    .agg(
        concat_ws(", ", collect_list("reason")).alias("top_3_recall_reasons")
    ) \
    .withColumnRenamed("recall_year", "year")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Join Crop and Recall Annual Data

# COMMAND ----------

df_executive_summary = df_annual_crop.alias("c") \
    .join(
        df_annual_recalls.alias("r"),
        col("c.year") == col("r.year"),
        "full_outer"
    ) \
    .join(
        df_top3_commodities.alias("tc"),
        coalesce(col("c.year"), col("r.year")) == col("tc.year"),
        "left"
    ) \
    .join(
        df_top3_reasons.alias("tr"),
        coalesce(col("c.year"), col("r.year")) == col("tr.year"),
        "left"
    ) \
    .select(
        coalesce(col("c.year"), col("r.year")).alias("year"),
        coalesce(col("c.total_crop_production_records"), lit(0)).alias("total_crop_production_records"),
        coalesce(col("c.distinct_commodities"), lit(0)).alias("distinct_commodities"),
        coalesce(col("c.distinct_states_reporting"), lit(0)).alias("distinct_states_reporting"),
        coalesce(col("r.total_recall_events"), lit(0)).alias("total_recall_events"),
        coalesce(col("r.class_i_recalls"), lit(0)).alias("class_i_recalls"),
        coalesce(col("r.total_pounds_recalled"), lit(0)).alias("total_pounds_recalled"),
        coalesce(col("r.distinct_companies_recalled"), lit(0)).alias("distinct_companies_recalled"),
        coalesce(col("r.food_safety_index"), lit(100.0)).alias("food_safety_index"),
        col("tc.top_3_commodities"),
        col("tr.top_3_recall_reasons"),
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

try:
    if spark.catalog.tableExists(TARGET_EXECUTIVE_SUMMARY):
        deltaTable = DeltaTable.forName(spark, TARGET_EXECUTIVE_SUMMARY)
        deltaTable.alias("target").merge(
            df_executive_summary.alias("source"),
            "target.year = source.year"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_executive_summary.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_EXECUTIVE_SUMMARY)

    print(f"Merged {df_executive_summary.count():,} records into {TARGET_EXECUTIVE_SUMMARY}")
except Exception as e:
    print(f"ERROR writing executive summary (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Optimize All Gold Tables for Direct Lake

# COMMAND ----------

spark.sql(f"OPTIMIZE {TARGET_CROP_SUMMARY} ZORDER BY (commodity, year, state_name)")
print(f"Optimized {TARGET_CROP_SUMMARY}")

spark.sql(f"OPTIMIZE {TARGET_STATE_AGRICULTURE} ZORDER BY (state_name, state_fips)")
print(f"Optimized {TARGET_STATE_AGRICULTURE}")

spark.sql(f"OPTIMIZE {TARGET_FOOD_SAFETY_DASHBOARD} ZORDER BY (recall_year, recall_quarter, recall_class)")
print(f"Optimized {TARGET_FOOD_SAFETY_DASHBOARD}")

spark.sql(f"OPTIMIZE {TARGET_EXECUTIVE_SUMMARY} ZORDER BY (year)")
print(f"Optimized {TARGET_EXECUTIVE_SUMMARY}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Validation & Summary

# COMMAND ----------

# MAGIC %md
# MAGIC ### Crop Summary Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        COUNT(DISTINCT commodity) as commodities,
        COUNT(DISTINCT state_name) as states,
        COUNT(DISTINCT year) as years,
        ROUND(AVG(total_production), 0) as avg_production,
        ROUND(AVG(avg_yield), 2) as avg_yield,
        ROUND(AVG(avg_price_received), 2) as avg_price
    FROM {TARGET_CROP_SUMMARY}
""").show(truncate=False)

# COMMAND ----------

# Performance flag distribution
print("Performance Flag Distribution:")
spark.sql(f"""
    SELECT
        COALESCE(performance_flag, 'NO_FLAG') as flag,
        COUNT(*) as record_count,
        ROUND(AVG(total_production), 0) as avg_production,
        ROUND(AVG(avg_yield), 2) as avg_yield
    FROM {TARGET_CROP_SUMMARY}
    GROUP BY COALESCE(performance_flag, 'NO_FLAG')
    ORDER BY record_count DESC
""").show(truncate=False)

# COMMAND ----------

# Top 10 commodity-state combinations by production (latest year)
print("Top 10 Producers (Latest Year):")
spark.sql(f"""
    SELECT
        commodity_rank,
        commodity,
        state_name,
        total_production,
        avg_yield,
        avg_price_received,
        year_over_year_change_pct,
        performance_flag
    FROM {TARGET_CROP_SUMMARY}
    WHERE year = (SELECT MAX(year) FROM {TARGET_CROP_SUMMARY})
    ORDER BY commodity_rank
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### State Agriculture Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        COUNT(DISTINCT state_name) as states,
        COUNT(DISTINCT year) as years,
        ROUND(AVG(total_commodities_grown), 1) as avg_commodities,
        ROUND(AVG(crop_diversity_index), 1) as avg_diversity,
        ROUND(SUM(total_production_value), 2) as total_value
    FROM {TARGET_STATE_AGRICULTURE}
""").show(truncate=False)

# COMMAND ----------

# Top 10 states by production value (latest year)
print("Top 10 States by Production Value (Latest Year):")
spark.sql(f"""
    SELECT
        state_name,
        state_fips,
        total_commodities_grown,
        total_production_value,
        crop_diversity_index,
        dominant_commodity,
        avg_data_quality
    FROM {TARGET_STATE_AGRICULTURE}
    WHERE year = (SELECT MAX(year) FROM {TARGET_STATE_AGRICULTURE})
    ORDER BY total_production_value DESC
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Food Safety Dashboard Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        COUNT(*) as total_records,
        SUM(total_recalls) as total_recalls,
        SUM(total_pounds_recalled) as total_pounds,
        ROUND(AVG(severity_weighted_score), 2) as avg_severity,
        ROUND(AVG(pct_nationwide_distribution), 2) as avg_nationwide_pct,
        COUNT(DISTINCT recall_class) as recall_classes,
        COUNT(DISTINCT product_type) as product_types
    FROM {TARGET_FOOD_SAFETY_DASHBOARD}
""").show(truncate=False)

# COMMAND ----------

# Recall trend distribution
print("Recall Trend Distribution:")
spark.sql(f"""
    SELECT
        recall_trend,
        COUNT(*) as record_count,
        SUM(total_recalls) as total_recalls,
        ROUND(AVG(severity_weighted_score), 2) as avg_severity
    FROM {TARGET_FOOD_SAFETY_DASHBOARD}
    GROUP BY recall_trend
    ORDER BY total_recalls DESC
""").show(truncate=False)

# COMMAND ----------

# Rolling 12-month trend by recall class
print("Rolling 12-Month Trends by Recall Class:")
spark.sql(f"""
    SELECT
        recall_class,
        recall_year,
        recall_quarter,
        total_recalls,
        rolling_12m_recalls,
        rolling_12m_avg_severity,
        recall_trend
    FROM {TARGET_FOOD_SAFETY_DASHBOARD}
    WHERE recall_year = (SELECT MAX(recall_year) FROM {TARGET_FOOD_SAFETY_DASHBOARD})
    ORDER BY recall_class, recall_quarter
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Executive Summary Validation

# COMMAND ----------

spark.sql(f"""
    SELECT
        year,
        total_crop_production_records,
        total_recall_events,
        food_safety_index,
        top_3_commodities,
        top_3_recall_reasons
    FROM {TARGET_EXECUTIVE_SUMMARY}
    ORDER BY year DESC
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Final Record Counts

# COMMAND ----------

print("=" * 70)
print("GOLD LAYER - USDA ANALYTICS - FINAL SUMMARY")
print("=" * 70)
print(f"  {TARGET_CROP_SUMMARY}:          {spark.table(TARGET_CROP_SUMMARY).count():,} records")
print(f"  {TARGET_STATE_AGRICULTURE}:  {spark.table(TARGET_STATE_AGRICULTURE).count():,} records")
print(f"  {TARGET_FOOD_SAFETY_DASHBOARD}: {spark.table(TARGET_FOOD_SAFETY_DASHBOARD).count():,} records")
print(f"  {TARGET_EXECUTIVE_SUMMARY}:  {spark.table(TARGET_EXECUTIVE_SUMMARY).count():,} records")
print("=" * 70)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Gold Layer Output Summary
# MAGIC
# MAGIC | Table | Description | Partitioned By | Z-Order |
# MAGIC |-------|-------------|----------------|---------|
# MAGIC | gold_usda_crop_summary | Commodity KPIs: production, yield, price, YoY change, ranking | - | commodity, year, state_name |
# MAGIC | gold_usda_state_agriculture | State profile: diversity, dominance, production value | year | state_name, state_fips |
# MAGIC | gold_usda_food_safety_dashboard | Recall analytics: severity score, rolling trends, nationwide pct | - | recall_year, recall_quarter, recall_class |
# MAGIC | gold_usda_executive_summary | Cross-domain annual view: crop + recall + food safety index | - | year |
# MAGIC
# MAGIC ### Performance Flags (Crop Summary):
# MAGIC - **TOP_PRODUCER** - Ranked in top 5 by total production within the year
# MAGIC - **DECLINING_YIELD** - Average yield dropped more than 5% versus prior year
# MAGIC - **EXPANDING_ACREAGE** - Area planted increased more than 5% versus prior year
# MAGIC
# MAGIC ### Severity-Weighted Score (Food Safety):
# MAGIC - Class I (life-threatening) = weight 3
# MAGIC - Class II (remote health risk) = weight 2
# MAGIC - Class III (unlikely adverse) = weight 1
# MAGIC - Score range: 1.0 (all Class III) to 3.0 (all Class I)
# MAGIC
# MAGIC ### Food Safety Index (Executive Summary):
# MAGIC - Formula: (1 - Class I rate) * 100
# MAGIC - Range: 0 (all Class I) to 100 (no Class I recalls)
# MAGIC - Higher is safer
# MAGIC
# MAGIC **Dashboard Ready:** All tables optimized for Power BI Direct Lake connectivity.
