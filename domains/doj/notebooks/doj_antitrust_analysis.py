# Databricks notebook source
# MAGIC %md
# MAGIC # CSA-in-a-Box: DOJ Antitrust Analysis
# MAGIC
# MAGIC DOJ-domain notebook that analyzes gold-layer tables produced by the
# MAGIC dbt pipeline: enforcement actions, trends, merger reviews, and penalty analysis.
# MAGIC
# MAGIC **Key analyses:**
# MAGIC - Antitrust enforcement trends over time
# MAGIC - Criminal vs civil case distribution analysis
# MAGIC - Fine and penalty analysis by industry and violation type
# MAGIC - HSR filing trends and second request rates
# MAGIC - Merger review outcomes by industry sector
# MAGIC - Average review timeline analysis
# MAGIC - Top industries by enforcement activity
# MAGIC - HHI concentration analysis for merger reviews

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Configuration

# COMMAND ----------

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns
from pyspark.sql import functions as F
from pyspark.sql.window import Window

dbutils.widgets.text("catalog", "csa_inabox", "Unity Catalog Name")
catalog = dbutils.widgets.get("catalog")

# Table references
ENFORCEMENT_ACTIONS_TABLE = f"{catalog}.gold.fact_enforcement_actions"
ANTITRUST_TRENDS_TABLE = f"{catalog}.gold.gld_antitrust_trends"
MERGER_REVIEW_TABLE = f"{catalog}.gold.gld_merger_review_summary"
PENALTY_ANALYSIS_TABLE = f"{catalog}.gold.gld_penalty_analysis"
INDUSTRIES_DIM_TABLE = f"{catalog}.gold.dim_industries"
VIOLATIONS_DIM_TABLE = f"{catalog}.gold.dim_violation_types"

print(f"Catalog: {catalog}")
print("Using tables from gold schema")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Antitrust Enforcement Trends Over Time

# COMMAND ----------

# Load enforcement trends data
trends_df = spark.table(ANTITRUST_TRENDS_TABLE)
trends_pdf = trends_df.orderBy("fiscal_year").toPandas()

print("=== Enforcement Trends Summary ===")
print(f"Years covered: {trends_pdf['fiscal_year'].min()} - {trends_pdf['fiscal_year'].max()}")
print(f"Total cases across all years: {trends_pdf['total_cases'].sum():,}")
print(f"Total criminal fines: ${trends_pdf['total_criminal_fines'].sum():,.0f}")
print(f"Average success rate: {trends_pdf['success_rate_pct'].mean():.1f}%")

# Display key trends
display(trends_df.select(
    "fiscal_year", "total_cases", "criminal_cases", "civil_cases",
    "success_rate_pct", "total_criminal_fines", "cases_yoy_change_pct"
))

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Criminal vs Civil Case Distribution

# COMMAND ----------

# Analyze case type distribution
enforcement_df = spark.table(ENFORCEMENT_ACTIONS_TABLE)

case_type_analysis = (
    enforcement_df
    .groupBy("case_type", "fiscal_year")
    .agg(
        F.count("*").alias("case_count"),
        F.sum("total_criminal_fines").alias("total_fines"),
        F.avg("total_criminal_fines").alias("avg_fine"),
        F.sum("total_jail_days").alias("total_jail_days"),
        F.avg("days_to_resolution").alias("avg_resolution_days")
    )
    .orderBy("fiscal_year", "case_type")
)

print("=== Criminal vs Civil Case Analysis ===")
display(case_type_analysis)

# Overall distribution
overall_distribution = (
    enforcement_df
    .groupBy("case_type")
    .agg(
        F.count("*").alias("total_cases"),
        F.sum("total_criminal_fines").alias("total_fines"),
        F.avg("total_criminal_fines").alias("avg_fine_per_case")
    )
)

print("\n=== Overall Case Type Distribution ===")
display(overall_distribution)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Fine/Penalty Analysis by Industry and Violation Type

# COMMAND ----------

# Load penalty analysis data
penalty_df = spark.table(PENALTY_ANALYSIS_TABLE)

# Violation type analysis
violation_penalties = (
    penalty_df
    .filter(F.col("analysis_type") == "VIOLATION_TYPE")
    .orderBy(F.col("penalty_amount").desc())
)

print("=== Penalty Analysis by Violation Type ===")
display(violation_penalties.select(
    "category", "cases_with_penalties", "penalty_amount",
    "avg_penalty_per_case", "total_jail_days", "priority_level"
))

# Industry analysis
industry_penalties = (
    penalty_df
    .filter(F.col("analysis_type") == "INDUSTRY")
    .orderBy(F.col("penalty_amount").desc())
)

print("\n=== Penalty Analysis by Industry ===")
display(industry_penalties.select(
    "category", "cases_with_penalties", "penalty_amount",
    "avg_penalty_per_case", "total_jail_days"
))

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. HSR Filing Trends and Second Request Rates

# COMMAND ----------

# Load merger review data
merger_df = spark.table(MERGER_REVIEW_TABLE)

# HSR filing trends
hsr_trends = merger_df.select(
    "fiscal_year", "total_hsr_filings", "early_termination_granted",
    "second_requests_issued", "transactions_challenged",
    "early_termination_rate_pct", "second_request_rate_pct", "challenge_rate_pct",
    "total_transaction_value", "avg_transaction_value"
).orderBy("fiscal_year")

print("=== HSR Filing and Review Trends ===")
display(hsr_trends)

# Calculate key statistics
hsr_pdf = hsr_trends.toPandas()
print("\n=== HSR Key Statistics ===")
print(f"Average filings per year: {hsr_pdf['total_hsr_filings'].mean():.0f}")
print(f"Average early termination rate: {hsr_pdf['early_termination_rate_pct'].mean():.1f}%")
print(f"Average second request rate: {hsr_pdf['second_request_rate_pct'].mean():.1f}%")
print(f"Average challenge rate: {hsr_pdf['challenge_rate_pct'].mean():.1f}%")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Merger Review Outcomes by Industry

# COMMAND ----------

# Analyze enforcement actions by industry
industry_enforcement = (
    enforcement_df
    .join(spark.table(INDUSTRIES_DIM_TABLE), "industry_sk", "left")
    .groupBy("industry_sector", "industry_code", "is_highly_regulated")
    .agg(
        F.count("*").alias("total_cases"),
        F.sum("total_criminal_fines").alias("total_fines"),
        F.avg("total_criminal_fines").alias("avg_fine"),
        F.sum("criminal_defendants").alias("total_defendants"),
        F.countDistinct("case_id").alias("unique_cases"),
        F.avg("days_to_resolution").alias("avg_resolution_days")
    )
    .orderBy(F.col("total_cases").desc())
)

print("=== Enforcement Activity by Industry ===")
display(industry_enforcement)

# Focus on highly regulated industries
regulated_industries = (
    industry_enforcement
    .filter(F.col("is_highly_regulated") == True)
    .orderBy(F.col("total_fines").desc())
)

print("\n=== Highly Regulated Industries - Enforcement Focus ===")
display(regulated_industries)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 7. Average Review Timeline Analysis

# COMMAND ----------

# Timeline analysis from enforcement actions
timeline_analysis = (
    enforcement_df
    .filter(F.col("days_to_resolution").isNotNull())
    .groupBy("fiscal_year", "case_type")
    .agg(
        F.count("*").alias("resolved_cases"),
        F.avg("days_to_resolution").alias("avg_days_to_resolution"),
        F.percentile_approx("days_to_resolution", 0.5).alias("median_days"),
        F.percentile_approx("days_to_resolution", 0.75).alias("p75_days"),
        F.min("days_to_resolution").alias("min_days"),
        F.max("days_to_resolution").alias("max_days")
    )
    .orderBy("fiscal_year", "case_type")
)

print("=== Case Resolution Timeline Analysis ===")
display(timeline_analysis)

# Overall timeline statistics
overall_timeline = (
    enforcement_df
    .filter(F.col("days_to_resolution").isNotNull())
    .agg(
        F.count("*").alias("total_resolved"),
        F.avg("days_to_resolution").alias("overall_avg_days"),
        F.percentile_approx("days_to_resolution", 0.5).alias("overall_median"),
        F.stddev("days_to_resolution").alias("std_dev_days")
    )
)

print("\n=== Overall Timeline Statistics ===")
display(overall_timeline)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 8. Top Industries by Enforcement Activity

# COMMAND ----------

# Rank industries by various enforcement metrics
industry_rankings = (
    enforcement_df
    .join(spark.table(INDUSTRIES_DIM_TABLE), "industry_sk", "left")
    .groupBy("industry_sector", "industry_code")
    .agg(
        F.count("*").alias("total_enforcement_actions"),
        F.sum("total_criminal_fines").alias("total_fines_collected"),
        F.sum("criminal_defendants").alias("total_defendants"),
        F.sum("civil_actions_count").alias("total_civil_actions"),
        F.countDistinct("case_id").alias("unique_cases"),
        F.avg("total_criminal_fines").alias("avg_fine_per_action")
    )
)

# Add rankings
window_spec = Window.orderBy(F.col("total_fines_collected").desc())
industry_rankings_with_rank = (
    industry_rankings
    .withColumn("fine_rank", F.row_number().over(window_spec))
    .orderBy("fine_rank")
)

print("=== Industries Ranked by Total Fines Collected ===")
display(industry_rankings_with_rank.select(
    "fine_rank", "industry_sector", "industry_code",
    "total_enforcement_actions", "total_fines_collected",
    "unique_cases", "avg_fine_per_action"
))

# COMMAND ----------

# MAGIC %md
# MAGIC ## 9. HHI Concentration Analysis for Merger Reviews

# COMMAND ----------

# HHI analysis from merger review data
hhi_analysis = merger_df.select(
    "fiscal_year", "unconcentrated_markets", "moderately_concentrated_markets",
    "highly_concentrated_markets", "avg_hhi_increase",
    "significant_concentration_increases", "post_merger_highly_concentrated"
).orderBy("fiscal_year")

print("=== HHI Concentration Analysis ===")
display(hhi_analysis)

# Calculate concentration trends
concentration_summary = (
    merger_df
    .agg(
        F.sum("unconcentrated_markets").alias("total_unconcentrated"),
        F.sum("moderately_concentrated_markets").alias("total_moderately_concentrated"),
        F.sum("highly_concentrated_markets").alias("total_highly_concentrated"),
        F.avg("avg_hhi_increase").alias("overall_avg_hhi_increase"),
        F.sum("significant_concentration_increases").alias("total_significant_increases")
    )
)

print("\n=== Overall Market Concentration Summary ===")
display(concentration_summary)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 10. Violation Type Enforcement Patterns

# COMMAND ----------

# Analyze enforcement by violation type
violation_enforcement = (
    enforcement_df
    .join(spark.table(VIOLATIONS_DIM_TABLE), "violation_sk", "left")
    .groupBy("violation_type", "statutory_basis", "enforcement_priority", "is_criminal_violation")
    .agg(
        F.count("*").alias("total_cases"),
        F.sum("total_criminal_fines").alias("total_fines"),
        F.avg("total_criminal_fines").alias("avg_fine"),
        F.sum("total_jail_days").alias("total_jail_days"),
        F.avg("total_jail_days").alias("avg_jail_days"),
        F.sum("criminal_defendants").alias("total_defendants"),
        F.countDistinct("fiscal_year").alias("years_active")
    )
    .orderBy(F.col("total_fines").desc())
)

print("=== Enforcement Patterns by Violation Type ===")
display(violation_enforcement)

# Focus on high-priority violations
high_priority_violations = (
    violation_enforcement
    .filter(F.col("enforcement_priority") == "HIGH")
    .orderBy(F.col("total_cases").desc())
)

print("\n=== High Priority Violation Enforcement ===")
display(high_priority_violations)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 11. Summary Dashboard Export

# COMMAND ----------

# Create summary metrics for dashboard
dashboard_summary = {
    "total_cases": enforcement_df.count(),
    "total_fines_collected": enforcement_df.agg(F.sum("total_criminal_fines")).collect()[0][0] or 0,
    "total_jail_days_imposed": enforcement_df.agg(F.sum("total_jail_days")).collect()[0][0] or 0,
    "total_defendants": enforcement_df.agg(F.sum("criminal_defendants")).collect()[0][0] or 0,
    "unique_industries": enforcement_df.select("industry_sk").distinct().count(),
    "avg_case_resolution_days": enforcement_df.agg(F.avg("days_to_resolution")).collect()[0][0] or 0
}

# Recent year statistics
current_year = 2024  # Adjust based on latest data
recent_trends = trends_df.filter(F.col("fiscal_year") == current_year).collect()

if recent_trends:
    recent_data = recent_trends[0]
    dashboard_summary.update({
        "recent_year_cases": recent_data["total_cases"],
        "recent_success_rate": recent_data["success_rate_pct"],
        "recent_criminal_cases": recent_data["criminal_cases"],
        "recent_civil_cases": recent_data["civil_cases"]
    })

print("=== Dashboard Summary Metrics ===")
for key, value in dashboard_summary.items():
    if isinstance(value, (int, float)):
        print(f"{key}: {value:,.1f}")
    else:
        print(f"{key}: {value}")

# Export key tables for external dashboards
print("\n=== Key Tables for External Dashboard Integration ===")
print(f"1. Enforcement Actions Fact Table: {ENFORCEMENT_ACTIONS_TABLE}")
print(f"2. Antitrust Trends: {ANTITRUST_TRENDS_TABLE}")
print(f"3. Merger Review Summary: {MERGER_REVIEW_TABLE}")
print(f"4. Penalty Analysis: {PENALTY_ANALYSIS_TABLE}")
print(f"5. Industries Dimension: {INDUSTRIES_DIM_TABLE}")
print(f"6. Violations Dimension: {VIOLATIONS_DIM_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Analysis Complete
# MAGIC
# MAGIC This notebook provides comprehensive analysis of DOJ Antitrust Division enforcement data including:
# MAGIC
# MAGIC 1. **Enforcement Trends**: Year-over-year changes in case volume, success rates, and penalty amounts
# MAGIC 2. **Case Type Analysis**: Criminal vs civil case distribution and outcomes
# MAGIC 3. **Industry Impact**: Which industries face the most enforcement activity and highest penalties
# MAGIC 4. **Violation Patterns**: Analysis of different violation types and their enforcement outcomes
# MAGIC 5. **Merger Review**: HSR filing trends, review timelines, and market concentration analysis
# MAGIC 6. **Penalty Effectiveness**: Analysis of fines, jail time, and restitution by various dimensions
# MAGIC 7. **Timeline Analysis**: How long cases take to resolve across different types and years
# MAGIC 8. **Market Concentration**: HHI analysis showing impact on market competition
# MAGIC
# MAGIC The analysis supports policy evaluation, enforcement strategy assessment, and public transparency initiatives.
