# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: DOJ Law Enforcement Analytics
# MAGIC
# MAGIC This notebook creates aggregated DOJ law enforcement analytics tables optimized for
# MAGIC Power BI Direct Lake dashboards and criminal justice policy reporting.
# MAGIC
# MAGIC ## Output Tables:
# MAGIC - **gold_doj_crime_trends** - Crime statistics by state, offense category, year with trend analysis
# MAGIC - **gold_doj_sentencing_analytics** - Federal sentencing patterns by district, offense, year
# MAGIC - **gold_doj_antitrust_metrics** - Antitrust enforcement by industry with market concentration
# MAGIC - **gold_doj_drug_enforcement** - DEA drug seizures by region, drug type, year
# MAGIC
# MAGIC ## Key Metrics:
# MAGIC - Crime incident counts, clearance rates, arrest rates by category
# MAGIC - Sentencing patterns: guidelines compliance, plea rates, fine amounts
# MAGIC - Antitrust: merger reviews, market concentration (HHI), penalty amounts
# MAGIC - Drug enforcement: seizure volumes, street values, arrest counts

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
    asc,
    avg,
    coalesce,
    col,
    count,
    countDistinct,
    current_timestamp,
    desc,
    lag,
    lit,
    max,
    min,
    round,
    row_number,
    sum,
    when,
    window,
    year,
    expr,
)
from pyspark.sql.window import Window

# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source tables (Silver)
SOURCE_CRIME_STATS = "lh_silver.silver_doj_crime_statistics"
SOURCE_FEDERAL_SENTENCING = "lh_silver.silver_doj_federal_sentencing"
SOURCE_ANTITRUST = "lh_silver.silver_doj_antitrust_cases"
SOURCE_DRUG_SEIZURES = "lh_silver.silver_doj_drug_seizures"

# Target tables (Gold)
TARGET_CRIME_TRENDS = "lh_gold.gold_doj_crime_trends"
TARGET_SENTENCING_ANALYTICS = "lh_gold.gold_doj_sentencing_analytics"
TARGET_ANTITRUST_METRICS = "lh_gold.gold_doj_antitrust_metrics"
TARGET_DRUG_ENFORCEMENT = "lh_gold.gold_doj_drug_enforcement"

print(f"Processing batch: {batch_id}")
print(f"Sources: {SOURCE_CRIME_STATS}, {SOURCE_FEDERAL_SENTENCING}, {SOURCE_ANTITRUST}, {SOURCE_DRUG_SEIZURES}")
print(f"Targets:")
print(f"  - {TARGET_CRIME_TRENDS}")
print(f"  - {TARGET_SENTENCING_ANALYTICS}")
print(f"  - {TARGET_ANTITRUST_METRICS}")
print(f"  - {TARGET_DRUG_ENFORCEMENT}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Data

# COMMAND ----------

df_crime = spark.table(SOURCE_CRIME_STATS)
df_sentencing = spark.table(SOURCE_FEDERAL_SENTENCING)
df_antitrust = spark.table(SOURCE_ANTITRUST)
df_drug = spark.table(SOURCE_DRUG_SEIZURES)

print(f"Silver crime statistics:   {df_crime.count():,} records")
print(f"Silver federal sentencing: {df_sentencing.count():,} records")
print(f"Silver antitrust cases:    {df_antitrust.count():,} records")
print(f"Silver drug seizures:      {df_drug.count():,} records")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 1: Crime Trends Analytics

# COMMAND ----------

# MAGIC %md
# MAGIC ### Aggregate by State, Offense Category, Year

# COMMAND ----------

df_crime_agg = df_crime \
    .groupBy("state_code", "offense_category", "reporting_year") \
    .agg(
        # Incident counts
        count("*").alias("total_incidents"),
        sum(coalesce(col("victim_count"), lit(1))).alias("total_victims"),
        sum(when(col("arrest_made") == True, 1).otherwise(0)).alias("total_arrests"),
        sum(when(col("case_cleared") == True, 1).otherwise(0)).alias("cleared_incidents"),

        # Weapon involvement
        sum(when(col("weapon_involved") == "Firearm", 1).otherwise(0)).alias("firearm_incidents"),
        sum(when(col("weapon_involved").isNotNull(), 1).otherwise(0)).alias("weapon_incidents"),

        # Offender patterns
        avg(coalesce(col("offender_count"), lit(1))).alias("avg_offenders_per_incident"),

        # Severity indicators
        sum(when(col("severity_level") == "Felony", 1).otherwise(0)).alias("felony_incidents"),
        sum(when(col("severity_level") == "Misdemeanor", 1).otherwise(0)).alias("misdemeanor_incidents"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Derived Metrics and Year-over-Year Changes

# COMMAND ----------

yoy_window = Window.partitionBy("state_code", "offense_category").orderBy("reporting_year")

df_crime_trends = df_crime_agg \
    .withColumn("clearance_rate",
        when(col("total_incidents") > 0,
            round(col("cleared_incidents") / col("total_incidents") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("arrest_rate",
        when(col("total_incidents") > 0,
            round(col("total_arrests") / col("total_incidents") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("firearm_involvement_pct",
        when(col("total_incidents") > 0,
            round(col("firearm_incidents") / col("total_incidents") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("felony_rate",
        when(col("total_incidents") > 0,
            round(col("felony_incidents") / col("total_incidents") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("prev_year_incidents",
        lag("total_incidents", 1).over(yoy_window)
    ) \
    .withColumn("yoy_change",
        when(col("prev_year_incidents").isNotNull() & (col("prev_year_incidents") > 0),
            round((col("total_incidents") - col("prev_year_incidents")) /
                  col("prev_year_incidents") * 100, 2))
        .otherwise(lit(None))
    ) \
    .drop("prev_year_incidents")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Apply Performance Flags

# COMMAND ----------

df_crime_flagged = df_crime_trends \
    .withColumn("performance_flags",
        array_compact(array(
            when(col("clearance_rate") < 30, lit("LOW_CLEARANCE")),
            when(col("firearm_involvement_pct") > 50, lit("HIGH_FIREARM_INVOLVEMENT")),
            when(col("yoy_change") > 25, lit("RISING_CRIME")),
            when(col("yoy_change") < -25, lit("DECLINING_CRIME")),
        ))
    ) \
    .withColumn("risk_tier",
        when((col("clearance_rate") < 20) & (col("yoy_change") > 20), lit("CRITICAL"))
        .when(col("clearance_rate") < 30, lit("HIGH"))
        .when(col("clearance_rate") < 50, lit("MODERATE"))
        .otherwise(lit("LOW"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Crime Trends Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_CRIME_TRENDS):
        deltaTable = DeltaTable.forName(spark, TARGET_CRIME_TRENDS)
        deltaTable.alias("target").merge(
            df_crime_flagged.alias("source"),
            "target.state_code = source.state_code AND target.offense_category = source.offense_category AND target.reporting_year = source.reporting_year"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_crime_flagged.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("reporting_year") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_CRIME_TRENDS)

    print(f"Merged {spark.table(TARGET_CRIME_TRENDS).count():,} records into {TARGET_CRIME_TRENDS}")
except Exception as e:
    print(f"ERROR writing crime trends (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 2: Federal Sentencing Analytics

# COMMAND ----------

# MAGIC %md
# MAGIC ### Aggregate by District Court, Offense Category, Fiscal Year

# COMMAND ----------

df_sentencing_agg = df_sentencing \
    .groupBy("district_court", "offense_category", "fiscal_year") \
    .agg(
        # Case counts
        count("*").alias("total_cases"),

        # Sentencing patterns
        avg("sentence_months").alias("avg_sentence_months"),
        expr("percentile_approx(sentence_months, 0.5)").alias("median_sentence_months"),
        avg("guideline_range_min_months").alias("avg_guideline_min"),
        avg("guideline_range_max_months").alias("avg_guideline_max"),

        # Guidelines compliance
        count(when(
            (col("sentence_months") >= col("guideline_range_min_months")) &
            (col("sentence_months") <= col("guideline_range_max_months")), True
        )).alias("within_guidelines_count"),
        count(when(col("sentence_months") < col("guideline_range_min_months"), True)).alias("below_guidelines_count"),
        count(when(col("sentence_months") > col("guideline_range_max_months"), True)).alias("above_guidelines_count"),

        # Special circumstances
        count(when(col("substantial_assistance") == True, True)).alias("substantial_assistance_count"),

        # Financial penalties
        avg(when(col("fine_amount_usd") > 0, col("fine_amount_usd"))).alias("avg_fine_amount"),
        avg(when(col("restitution_amount_usd") > 0, col("restitution_amount_usd"))).alias("avg_restitution"),

        # Case resolution
        count(when(col("plea_type") == "Guilty Plea", True)).alias("guilty_plea_count"),
        count(when(col("trial_outcome") == "Jury Trial", True)).alias("jury_trial_count"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Sentencing Performance Metrics

# COMMAND ----------

df_sentencing_analytics = df_sentencing_agg \
    .withColumn("within_guidelines_pct",
        when(col("total_cases") > 0,
            round(col("within_guidelines_count") / col("total_cases") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("below_guidelines_pct",
        when(col("total_cases") > 0,
            round(col("below_guidelines_count") / col("total_cases") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("above_guidelines_pct",
        when(col("total_cases") > 0,
            round(col("above_guidelines_count") / col("total_cases") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("substantial_assistance_pct",
        when(col("total_cases") > 0,
            round(col("substantial_assistance_count") / col("total_cases") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("plea_rate",
        when(col("total_cases") > 0,
            round(col("guilty_plea_count") / col("total_cases") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("trial_rate",
        when(col("total_cases") > 0,
            round(col("jury_trial_count") / col("total_cases") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("avg_sentence_months", round(col("avg_sentence_months"), 2)) \
    .withColumn("avg_guideline_min", round(col("avg_guideline_min"), 2)) \
    .withColumn("avg_guideline_max", round(col("avg_guideline_max"), 2)) \
    .withColumn("avg_fine_amount", round(col("avg_fine_amount"), 2)) \
    .withColumn("avg_restitution", round(col("avg_restitution"), 2)) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Sentencing Analytics Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_SENTENCING_ANALYTICS):
        deltaTable = DeltaTable.forName(spark, TARGET_SENTENCING_ANALYTICS)
        deltaTable.alias("target").merge(
            df_sentencing_analytics.alias("source"),
            "target.district_court = source.district_court AND target.offense_category = source.offense_category AND target.fiscal_year = source.fiscal_year"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_sentencing_analytics.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("fiscal_year") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_SENTENCING_ANALYTICS)

    print(f"Merged {spark.table(TARGET_SENTENCING_ANALYTICS).count():,} records into {TARGET_SENTENCING_ANALYTICS}")
except Exception as e:
    print(f"ERROR writing sentencing analytics (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 3: Antitrust Enforcement Metrics

# COMMAND ----------

# MAGIC %md
# MAGIC ### Aggregate by Industry Sector, Industry Name, Fiscal Year

# COMMAND ----------

df_antitrust_agg = df_antitrust \
    .groupBy("industry_sector", "industry_name", "fiscal_year") \
    .agg(
        # Case counts by type
        count("*").alias("total_cases"),
        count(when(col("case_type") == "Merger Review", True)).alias("merger_reviews"),
        count(when(col("case_type") == "Criminal", True)).alias("criminal_cases"),
        count(when(col("case_type") == "Civil", True)).alias("civil_cases"),

        # Merger outcomes
        count(when(col("merger_outcome").isin("Challenged", "Blocked"), True)).alias("challenged_blocked_count"),
        count(when(col("merger_outcome") == "Consent Decree", True)).alias("consent_decree_count"),

        # Market concentration
        avg(when(col("hhi_delta").isNotNull(), col("hhi_delta"))).alias("avg_hhi_delta"),
        avg(when(col("hhi_post_merger").isNotNull(), col("hhi_post_merger"))).alias("avg_hhi_post"),
        count(when(col("hhi_post_merger") > 2500, True)).alias("highly_concentrated_count"),

        # Financial metrics
        avg(when(col("transaction_value_usd") > 0, col("transaction_value_usd"))).alias("avg_transaction_value"),
        sum(coalesce(col("penalty_amount_usd"), lit(0))).alias("total_penalties"),

        # Investigation intensity
        count(when(col("second_request_issued") == True, True)).alias("second_request_count"),

        # Cartel types
        count(when(col("cartel_type") == "Price-fixing", True)).alias("price_fixing_cases"),
        count(when(col("cartel_type") == "Bid-rigging", True)).alias("bid_rigging_cases"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Antitrust Performance Metrics

# COMMAND ----------

df_antitrust_metrics = df_antitrust_agg \
    .withColumn("challenge_rate",
        when(col("merger_reviews") > 0,
            round(col("challenged_blocked_count") / col("merger_reviews") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("consent_decree_rate",
        when(col("merger_reviews") > 0,
            round(col("consent_decree_count") / col("merger_reviews") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("second_request_rate",
        when(col("merger_reviews") > 0,
            round(col("second_request_count") / col("merger_reviews") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("highly_concentrated_pct",
        when(col("merger_reviews") > 0,
            round(col("highly_concentrated_count") / col("merger_reviews") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("performance_flags",
        array_compact(array(
            when(col("avg_hhi_post") > 2500, lit("HIGH_CONCENTRATION")),
            when(col("total_penalties") > 100000000, lit("HIGH_PENALTY")),
            when(col("challenge_rate") > 30, lit("HIGH_ENFORCEMENT")),
        ))
    ) \
    .withColumn("market_risk_tier",
        when(col("avg_hhi_post") > 2500, lit("HIGHLY_CONCENTRATED"))
        .when(col("avg_hhi_post") > 1800, lit("MODERATELY_CONCENTRATED"))
        .otherwise(lit("COMPETITIVE"))
    ) \
    .withColumn("avg_transaction_value", round(col("avg_transaction_value"), 2)) \
    .withColumn("avg_hhi_delta", round(col("avg_hhi_delta"), 2)) \
    .withColumn("avg_hhi_post", round(col("avg_hhi_post"), 2)) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Antitrust Metrics Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_ANTITRUST_METRICS):
        deltaTable = DeltaTable.forName(spark, TARGET_ANTITRUST_METRICS)
        deltaTable.alias("target").merge(
            df_antitrust_metrics.alias("source"),
            "target.industry_sector = source.industry_sector AND target.industry_name = source.industry_name AND target.fiscal_year = source.fiscal_year"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_antitrust_metrics.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("fiscal_year") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_ANTITRUST_METRICS)

    print(f"Merged {spark.table(TARGET_ANTITRUST_METRICS).count():,} records into {TARGET_ANTITRUST_METRICS}")
except Exception as e:
    print(f"ERROR writing antitrust metrics (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 4: Drug Enforcement Analytics

# COMMAND ----------

# MAGIC %md
# MAGIC ### Aggregate by DEA Region, Drug Type, Fiscal Year

# COMMAND ----------

df_drug_agg = df_drug \
    .groupBy("dea_region", "drug_type", "fiscal_year") \
    .agg(
        # Seizure counts
        count("*").alias("total_seizures"),
        sum("quantity_kg").alias("total_quantity_kg"),
        sum("estimated_street_value_usd").alias("total_street_value"),

        # Seizure characteristics
        avg("quantity_kg").alias("avg_seizure_kg"),
        max("quantity_kg").alias("largest_seizure_kg"),

        # Arrests
        sum(coalesce(col("arrests_count"), lit(0))).alias("total_arrests"),

        # Seizure methods
        count(when(col("seizure_method") == "Land", True)).alias("land_seizures"),
        count(when(col("seizure_method") == "Maritime", True)).alias("maritime_seizures"),
        count(when(col("seizure_method") == "Air", True)).alias("air_seizures"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Drug Enforcement Performance Metrics

# COMMAND ----------

df_drug_enforcement = df_drug_agg \
    .withColumn("arrests_per_seizure",
        when(col("total_seizures") > 0,
            round(col("total_arrests") / col("total_seizures"), 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("land_seizures_pct",
        when(col("total_seizures") > 0,
            round(col("land_seizures") / col("total_seizures") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("maritime_seizures_pct",
        when(col("total_seizures") > 0,
            round(col("maritime_seizures") / col("total_seizures") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("air_seizures_pct",
        when(col("total_seizures") > 0,
            round(col("air_seizures") / col("total_seizures") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("performance_flags",
        array_compact(array(
            when(col("total_street_value") > 1000000000, lit("BILLION_DOLLAR_SEIZURES")),
            when(col("largest_seizure_kg") > 1000, lit("MAJOR_SEIZURE")),
            when(col("arrests_per_seizure") > 5, lit("HIGH_ARREST_EFFICIENCY")),
        ))
    ) \
    .withColumn("enforcement_tier",
        when(col("total_street_value") > 1000000000, lit("CRITICAL_IMPACT"))
        .when(col("total_street_value") > 100000000, lit("HIGH_IMPACT"))
        .when(col("total_street_value") > 10000000, lit("MODERATE_IMPACT"))
        .otherwise(lit("STANDARD"))
    ) \
    .withColumn("total_quantity_kg", round(col("total_quantity_kg"), 2)) \
    .withColumn("total_street_value", round(col("total_street_value"), 2)) \
    .withColumn("avg_seizure_kg", round(col("avg_seizure_kg"), 2)) \
    .withColumn("largest_seizure_kg", round(col("largest_seizure_kg"), 2)) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Drug Enforcement Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_DRUG_ENFORCEMENT):
        deltaTable = DeltaTable.forName(spark, TARGET_DRUG_ENFORCEMENT)
        deltaTable.alias("target").merge(
            df_drug_enforcement.alias("source"),
            "target.dea_region = source.dea_region AND target.drug_type = source.drug_type AND target.fiscal_year = source.fiscal_year"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_drug_enforcement.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("fiscal_year") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_DRUG_ENFORCEMENT)

    print(f"Merged {spark.table(TARGET_DRUG_ENFORCEMENT).count():,} records into {TARGET_DRUG_ENFORCEMENT}")
except Exception as e:
    print(f"ERROR writing drug enforcement (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Optimize All Gold Tables for Direct Lake

# COMMAND ----------

spark.sql(f"OPTIMIZE {TARGET_CRIME_TRENDS} ZORDER BY (state_code, offense_category)")
print(f"Optimized {TARGET_CRIME_TRENDS}")

spark.sql(f"OPTIMIZE {TARGET_SENTENCING_ANALYTICS} ZORDER BY (district_court, offense_category)")
print(f"Optimized {TARGET_SENTENCING_ANALYTICS}")

spark.sql(f"OPTIMIZE {TARGET_ANTITRUST_METRICS} ZORDER BY (industry_sector, fiscal_year)")
print(f"Optimized {TARGET_ANTITRUST_METRICS}")

spark.sql(f"OPTIMIZE {TARGET_DRUG_ENFORCEMENT} ZORDER BY (dea_region, drug_type)")
print(f"Optimized {TARGET_DRUG_ENFORCEMENT}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Validation & Summary

# COMMAND ----------

# MAGIC %md
# MAGIC ### Crime Trends Summary

# COMMAND ----------

spark.sql(f"""
    SELECT
        offense_category,
        COUNT(*) as state_year_segments,
        SUM(total_incidents) as total_incidents,
        ROUND(AVG(clearance_rate), 2) as avg_clearance_rate,
        ROUND(AVG(arrest_rate), 2) as avg_arrest_rate,
        SUM(firearm_incidents) as firearm_incidents,
        ROUND(AVG(yoy_change), 2) as avg_yoy_change
    FROM {TARGET_CRIME_TRENDS}
    GROUP BY offense_category
    ORDER BY total_incidents DESC
""").show(truncate=False)

# COMMAND ----------

# High-risk crime areas
print("High-Risk Crime Areas (low clearance, high firearm involvement):")
spark.sql(f"""
    SELECT
        state_code,
        offense_category,
        total_incidents,
        clearance_rate,
        firearm_involvement_pct,
        yoy_change,
        risk_tier,
        performance_flags
    FROM {TARGET_CRIME_TRENDS}
    WHERE clearance_rate < 30 OR firearm_involvement_pct > 50
    ORDER BY clearance_rate ASC, firearm_involvement_pct DESC
    LIMIT 15
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Sentencing Analytics Summary

# COMMAND ----------

spark.sql(f"""
    SELECT
        offense_category,
        COUNT(*) as district_year_segments,
        SUM(total_cases) as total_cases,
        ROUND(AVG(avg_sentence_months), 2) as avg_sentence_months,
        ROUND(AVG(within_guidelines_pct), 2) as avg_within_guidelines,
        ROUND(AVG(plea_rate), 2) as avg_plea_rate,
        ROUND(AVG(avg_fine_amount), 2) as avg_fine_amount
    FROM {TARGET_SENTENCING_ANALYTICS}
    GROUP BY offense_category
    ORDER BY total_cases DESC
""").show(truncate=False)

# COMMAND ----------

# Districts with sentencing patterns
print("District Sentencing Patterns (latest year):")
spark.sql(f"""
    SELECT
        district_court,
        offense_category,
        total_cases,
        avg_sentence_months,
        within_guidelines_pct,
        plea_rate,
        avg_fine_amount
    FROM {TARGET_SENTENCING_ANALYTICS}
    WHERE fiscal_year = (SELECT MAX(fiscal_year) FROM {TARGET_SENTENCING_ANALYTICS})
    ORDER BY total_cases DESC
    LIMIT 15
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Antitrust Metrics Summary

# COMMAND ----------

spark.sql(f"""
    SELECT
        industry_sector,
        COUNT(*) as industry_year_segments,
        SUM(total_cases) as total_cases,
        SUM(merger_reviews) as merger_reviews,
        ROUND(AVG(challenge_rate), 2) as avg_challenge_rate,
        ROUND(SUM(total_penalties), 2) as total_penalties,
        ROUND(AVG(avg_hhi_post), 2) as avg_hhi_post,
        ROUND(AVG(highly_concentrated_pct), 2) as avg_concentrated_pct
    FROM {TARGET_ANTITRUST_METRICS}
    GROUP BY industry_sector
    ORDER BY total_penalties DESC
""").show(truncate=False)

# COMMAND ----------

# High-concentration markets
print("High-Concentration Markets (HHI > 2500):")
spark.sql(f"""
    SELECT
        industry_sector,
        industry_name,
        fiscal_year,
        merger_reviews,
        challenge_rate,
        avg_hhi_post,
        total_penalties,
        market_risk_tier,
        performance_flags
    FROM {TARGET_ANTITRUST_METRICS}
    WHERE avg_hhi_post > 2500
    ORDER BY avg_hhi_post DESC
    LIMIT 15
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Drug Enforcement Summary

# COMMAND ----------

spark.sql(f"""
    SELECT
        drug_type,
        COUNT(*) as region_year_segments,
        SUM(total_seizures) as total_seizures,
        ROUND(SUM(total_quantity_kg), 2) as total_quantity_kg,
        ROUND(SUM(total_street_value), 2) as total_street_value,
        SUM(total_arrests) as total_arrests,
        ROUND(AVG(arrests_per_seizure), 2) as avg_arrests_per_seizure,
        ROUND(MAX(largest_seizure_kg), 2) as largest_seizure_kg
    FROM {TARGET_DRUG_ENFORCEMENT}
    GROUP BY drug_type
    ORDER BY total_street_value DESC
""").show(truncate=False)

# COMMAND ----------

# Top DEA regions by enforcement
print("Top DEA Regions by Enforcement Activity (latest year):")
spark.sql(f"""
    SELECT
        dea_region,
        drug_type,
        total_seizures,
        total_quantity_kg,
        total_street_value,
        total_arrests,
        arrests_per_seizure,
        enforcement_tier,
        performance_flags
    FROM {TARGET_DRUG_ENFORCEMENT}
    WHERE fiscal_year = (SELECT MAX(fiscal_year) FROM {TARGET_DRUG_ENFORCEMENT})
    ORDER BY total_street_value DESC
    LIMIT 15
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Gold Layer Output Summary
# MAGIC
# MAGIC | Table | Description | Partitioned By | Z-Order |
# MAGIC |-------|-------------|----------------|---------|
# MAGIC | gold_doj_crime_trends | Crime statistics by state, offense, year with clearance/arrest rates | reporting_year | state_code, offense_category |
# MAGIC | gold_doj_sentencing_analytics | Federal sentencing patterns by district, offense, year | fiscal_year | district_court, offense_category |
# MAGIC | gold_doj_antitrust_metrics | Antitrust enforcement by industry with market concentration | fiscal_year | industry_sector, fiscal_year |
# MAGIC | gold_doj_drug_enforcement | DEA drug seizures by region, drug type, year | fiscal_year | dea_region, drug_type |
# MAGIC
# MAGIC **Dashboard Ready:** All tables optimized for Power BI Direct Lake connectivity.
