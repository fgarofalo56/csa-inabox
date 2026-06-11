# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: SBA Loan Program Analytics
# MAGIC
# MAGIC This notebook creates aggregated SBA loan analytics tables optimized for
# MAGIC Power BI Direct Lake dashboards and economic impact reporting.
# MAGIC
# MAGIC ## Output Tables:
# MAGIC - **gold_sba_loan_portfolio** - PPP + 7a/504 loans by state, NAICS sector, year with risk flags
# MAGIC - **gold_sba_economic_impact** - Lending volume, jobs supported, growth by state and year
# MAGIC - **gold_sba_lender_scorecard** - Lender performance: origination volume, defaults, forgiveness
# MAGIC
# MAGIC ## Key Metrics:
# MAGIC - Total loans, amounts, average loan sizes by program
# MAGIC - Jobs retained and forgiveness rates
# MAGIC - Default rates with HIGH_RISK_SECTOR flagging
# MAGIC - Year-over-year lending growth
# MAGIC - Lender origination and portfolio health

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
)
from pyspark.sql.window import Window

# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source tables (Silver)
SOURCE_PPP_LOANS = "lh_silver.silver_sba_ppp_loans"
SOURCE_7A_504_LOANS = "lh_silver.silver_sba_7a_504_loans"
SOURCE_LENDER_DATA = "lh_silver.silver_sba_lender_activity"

# Target tables (Gold)
TARGET_LOAN_PORTFOLIO = "lh_gold.gold_sba_loan_portfolio"
TARGET_ECONOMIC_IMPACT = "lh_gold.gold_sba_economic_impact"
TARGET_LENDER_SCORECARD = "lh_gold.gold_sba_lender_scorecard"

print(f"Processing batch: {batch_id}")
print(f"Sources: {SOURCE_PPP_LOANS}, {SOURCE_7A_504_LOANS}, {SOURCE_LENDER_DATA}")
print(f"Targets:")
print(f"  - {TARGET_LOAN_PORTFOLIO}")
print(f"  - {TARGET_ECONOMIC_IMPACT}")
print(f"  - {TARGET_LENDER_SCORECARD}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Silver Data

# COMMAND ----------

df_ppp = spark.table(SOURCE_PPP_LOANS)
df_7a_504 = spark.table(SOURCE_7A_504_LOANS)
df_lenders = spark.table(SOURCE_LENDER_DATA)

print(f"Silver PPP loans:       {df_ppp.count():,} records")
print(f"Silver 7a/504 loans:    {df_7a_504.count():,} records")
print(f"Silver lender activity: {df_lenders.count():,} records")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Unify Loan Programs

# COMMAND ----------

# Standardize PPP loans
df_ppp_std = df_ppp.select(
    col("loan_id"),
    lit("PPP").alias("program_type"),
    col("borrower_state").alias("state"),
    col("naics_code"),
    col("naics_sector"),
    col("approval_date"),
    year("approval_date").alias("approval_year"),
    col("loan_amount"),
    col("jobs_retained"),
    col("forgiveness_amount"),
    col("loan_status"),
    col("lender_name"),
    col("lender_id"),
)

# Standardize 7a/504 loans
df_7a_std = df_7a_504.select(
    col("loan_id"),
    col("program").alias("program_type"),
    col("borrower_state").alias("state"),
    col("naics_code"),
    col("naics_sector"),
    col("approval_date"),
    year("approval_date").alias("approval_year"),
    col("gross_approval").alias("loan_amount"),
    col("jobs_supported").alias("jobs_retained"),
    lit(None).cast("double").alias("forgiveness_amount"),
    col("loan_status"),
    col("lender_name"),
    col("lender_id"),
)

# Combine all loan programs
df_all_loans = df_ppp_std.unionByName(df_7a_std)

print(f"Unified loan records: {df_all_loans.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 1: Loan Portfolio Analytics

# COMMAND ----------

# MAGIC %md
# MAGIC ### Aggregate by State, NAICS Sector, Year

# COMMAND ----------

df_portfolio_agg = df_all_loans \
    .groupBy("state", "naics_sector", "approval_year", "program_type") \
    .agg(
        # Volume KPIs
        count("*").alias("total_loans"),
        round(sum("loan_amount"), 2).alias("total_amount"),
        round(avg("loan_amount"), 2).alias("avg_loan_size"),
        round(min("loan_amount"), 2).alias("min_loan_size"),
        round(max("loan_amount"), 2).alias("max_loan_size"),

        # Jobs
        sum(coalesce(col("jobs_retained"), lit(0))).alias("total_jobs_retained"),

        # Forgiveness (PPP-specific, null for 7a/504)
        sum(coalesce(col("forgiveness_amount"), lit(0))).alias("total_forgiveness_amount"),
        count(when(col("forgiveness_amount").isNotNull() & (col("forgiveness_amount") > 0), True)).alias("forgiven_loans"),

        # Default tracking
        sum(when(col("loan_status") == "DEFAULTED", 1).otherwise(0)).alias("defaulted_loans"),
        sum(when(col("loan_status") == "CHARGED_OFF", 1).otherwise(0)).alias("charged_off_loans"),
        sum(when(col("loan_status") == "ACTIVE", 1).otherwise(0)).alias("active_loans"),

        # Lender diversity
        countDistinct("lender_id").alias("unique_lenders"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Derived KPIs and Performance Flags

# COMMAND ----------

df_portfolio = df_portfolio_agg \
    .withColumn("forgiveness_rate",
        when(col("total_loans") > 0,
            round(col("forgiven_loans") / col("total_loans") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("default_rate",
        when(col("total_loans") > 0,
            round((col("defaulted_loans") + col("charged_off_loans")) / col("total_loans") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("avg_jobs_per_loan",
        when(col("total_loans") > 0,
            round(col("total_jobs_retained") / col("total_loans"), 1))
        .otherwise(lit(0.0))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Apply Performance Flags

# COMMAND ----------

# Performance classification flags
df_portfolio_flagged = df_portfolio \
    .withColumn("performance_flags",
        array_compact(array(
            when(col("default_rate") > 15, lit("HIGH_RISK_SECTOR")),
            when(col("forgiveness_rate") > 85, lit("STRONG_FORGIVENESS")),
            when(col("default_rate") > 25, lit("HIGH_DEFAULT")),
        ))
    ) \
    .withColumn("risk_tier",
        when(col("default_rate") > 25, lit("CRITICAL"))
        .when(col("default_rate") > 15, lit("HIGH"))
        .when(col("default_rate") > 8, lit("MODERATE"))
        .otherwise(lit("LOW"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Loan Portfolio Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_LOAN_PORTFOLIO):
        deltaTable = DeltaTable.forName(spark, TARGET_LOAN_PORTFOLIO)
        deltaTable.alias("target").merge(
            df_portfolio_flagged.alias("source"),
            "target.state = source.state AND target.naics_sector = source.naics_sector AND target.approval_year = source.approval_year AND target.program_type = source.program_type"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_portfolio_flagged.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("approval_year") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_LOAN_PORTFOLIO)

    print(f"Merged {spark.table(TARGET_LOAN_PORTFOLIO).count():,} records into {TARGET_LOAN_PORTFOLIO}")
except Exception as e:
    print(f"ERROR writing loan portfolio (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 2: Economic Impact Analytics

# COMMAND ----------

# MAGIC %md
# MAGIC ### Aggregate by State and Year

# COMMAND ----------

df_state_year = df_all_loans \
    .groupBy("state", "approval_year") \
    .agg(
        # Lending volume
        count("*").alias("total_loans"),
        round(sum("loan_amount"), 2).alias("total_lending_volume"),
        round(avg("loan_amount"), 2).alias("avg_loan_size"),

        # Jobs
        sum(coalesce(col("jobs_retained"), lit(0))).alias("jobs_supported"),

        # Business counts
        countDistinct("naics_sector").alias("sectors_served"),
        countDistinct("lender_id").alias("active_lenders"),

        # Program mix
        sum(when(col("program_type") == "PPP", 1).otherwise(0)).alias("ppp_loans"),
        sum(when(col("program_type") == "7(a)", 1).otherwise(0)).alias("sba_7a_loans"),
        sum(when(col("program_type") == "504", 1).otherwise(0)).alias("sba_504_loans"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Economic Density and Year-over-Year Growth

# COMMAND ----------

yoy_window = Window.partitionBy("state").orderBy("approval_year")

df_economic_impact = df_state_year \
    .withColumn("small_business_density",
        when(col("jobs_supported") > 0,
            round(col("total_loans") / col("jobs_supported") * 1000, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("loan_to_job_ratio",
        when(col("jobs_supported") > 0,
            round(col("total_lending_volume") / col("jobs_supported"), 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("prev_year_volume",
        lag("total_lending_volume", 1).over(yoy_window)
    ) \
    .withColumn("yoy_growth",
        when(col("prev_year_volume").isNotNull() & (col("prev_year_volume") > 0),
            round((col("total_lending_volume") - col("prev_year_volume")) /
                  col("prev_year_volume") * 100, 2))
        .otherwise(lit(None))
    ) \
    .withColumn("prev_year_loans",
        lag("total_loans", 1).over(yoy_window)
    ) \
    .withColumn("yoy_loan_count_growth",
        when(col("prev_year_loans").isNotNull() & (col("prev_year_loans") > 0),
            round((col("total_loans") - col("prev_year_loans")) /
                  col("prev_year_loans") * 100, 2))
        .otherwise(lit(None))
    ) \
    .drop("prev_year_volume", "prev_year_loans")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add State Rankings and Metadata

# COMMAND ----------

state_rank_window = Window.partitionBy("approval_year").orderBy(col("total_lending_volume").desc())

df_economic_final = df_economic_impact \
    .withColumn("state_lending_rank",
        row_number().over(state_rank_window)
    ) \
    .withColumn("growth_category",
        when(col("yoy_growth") > 20, lit("HIGH_GROWTH"))
        .when(col("yoy_growth") > 0, lit("MODERATE_GROWTH"))
        .when(col("yoy_growth") == 0, lit("FLAT"))
        .when(col("yoy_growth").isNull(), lit("BASELINE"))
        .otherwise(lit("DECLINING"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Economic Impact Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_ECONOMIC_IMPACT):
        deltaTable = DeltaTable.forName(spark, TARGET_ECONOMIC_IMPACT)
        deltaTable.alias("target").merge(
            df_economic_final.alias("source"),
            "target.state = source.state AND target.approval_year = source.approval_year"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_economic_final.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("approval_year") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_ECONOMIC_IMPACT)

    print(f"Merged {df_economic_final.count():,} records into {TARGET_ECONOMIC_IMPACT}")
except Exception as e:
    print(f"ERROR writing economic impact (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## SECTION 3: Lender Scorecard

# COMMAND ----------

# MAGIC %md
# MAGIC ### Aggregate by Lender

# COMMAND ----------

df_lender_agg = df_all_loans \
    .groupBy("lender_id", "lender_name") \
    .agg(
        # Origination volume
        count("*").alias("total_loans_originated"),
        round(sum("loan_amount"), 2).alias("total_portfolio_amount"),
        round(avg("loan_amount"), 2).alias("avg_loan_size"),
        round(min("loan_amount"), 2).alias("min_loan_size"),
        round(max("loan_amount"), 2).alias("max_loan_size"),

        # Program mix
        sum(when(col("program_type") == "PPP", 1).otherwise(0)).alias("ppp_loans"),
        sum(when(col("program_type") == "7(a)", 1).otherwise(0)).alias("sba_7a_loans"),
        sum(when(col("program_type") == "504", 1).otherwise(0)).alias("sba_504_loans"),

        # Defaults
        sum(when(col("loan_status").isin("DEFAULTED", "CHARGED_OFF"), 1).otherwise(0)).alias("defaulted_loans"),

        # Forgiveness (PPP)
        count(when(
            (col("program_type") == "PPP") &
            col("forgiveness_amount").isNotNull() &
            (col("forgiveness_amount") > 0), True
        )).alias("forgiven_loans"),
        count(when(col("program_type") == "PPP", True)).alias("ppp_total_for_forgiveness"),

        # Jobs
        sum(coalesce(col("jobs_retained"), lit(0))).alias("total_jobs_supported"),

        # Geographic reach
        countDistinct("state").alias("states_served"),
        countDistinct("naics_sector").alias("sectors_served"),

        # Time range
        min("approval_date").alias("first_loan_date"),
        max("approval_date").alias("last_loan_date"),
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Calculate Lender Performance KPIs

# COMMAND ----------

df_lender_scorecard = df_lender_agg \
    .withColumn("portfolio_default_rate",
        when(col("total_loans_originated") > 0,
            round(col("defaulted_loans") / col("total_loans_originated") * 100, 2))
        .otherwise(lit(0.0))
    ) \
    .withColumn("forgiveness_success_rate",
        when(col("ppp_total_for_forgiveness") > 0,
            round(col("forgiven_loans") / col("ppp_total_for_forgiveness") * 100, 2))
        .otherwise(lit(None))
    ) \
    .withColumn("avg_jobs_per_loan",
        when(col("total_loans_originated") > 0,
            round(col("total_jobs_supported") / col("total_loans_originated"), 1))
        .otherwise(lit(0.0))
    ) \
    .withColumn("portfolio_concentration",
        when(col("total_loans_originated") >= 1000, lit("LARGE"))
        .when(col("total_loans_originated") >= 100, lit("MEDIUM"))
        .otherwise(lit("SMALL"))
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ### Add Lender Ranking and Metadata

# COMMAND ----------

volume_rank_window = Window.orderBy(col("total_loans_originated").desc())
quality_rank_window = Window.orderBy(col("portfolio_default_rate").asc())

df_lender_final = df_lender_scorecard \
    .withColumn("volume_rank",
        row_number().over(volume_rank_window)
    ) \
    .withColumn("quality_rank",
        row_number().over(quality_rank_window)
    ) \
    .withColumn("lender_tier",
        when((col("portfolio_default_rate") < 5) & (col("total_loans_originated") >= 100), lit("PREFERRED"))
        .when(col("portfolio_default_rate") < 10, lit("STANDARD"))
        .when(col("portfolio_default_rate") < 20, lit("WATCH"))
        .otherwise(lit("RESTRICTED"))
    ) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id))

# COMMAND ----------

# MAGIC %md
# MAGIC ### Write Lender Scorecard Table

# COMMAND ----------

try:
    if spark.catalog.tableExists(TARGET_LENDER_SCORECARD):
        deltaTable = DeltaTable.forName(spark, TARGET_LENDER_SCORECARD)
        deltaTable.alias("target").merge(
            df_lender_final.alias("source"),
            "target.lender_id = source.lender_id"
        ).whenMatchedUpdateAll(
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        df_lender_final.write.format("delta") \
            .mode("overwrite") \
            .option("overwriteSchema", "true") \
            .saveAsTable(TARGET_LENDER_SCORECARD)

    print(f"Merged {df_lender_final.count():,} records into {TARGET_LENDER_SCORECARD}")
except Exception as e:
    print(f"ERROR writing lender scorecard (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Optimize All Gold Tables for Direct Lake

# COMMAND ----------

spark.sql(f"OPTIMIZE {TARGET_LOAN_PORTFOLIO} ZORDER BY (state, naics_sector, approval_year)")
print(f"Optimized {TARGET_LOAN_PORTFOLIO}")

spark.sql(f"OPTIMIZE {TARGET_ECONOMIC_IMPACT} ZORDER BY (state, approval_year)")
print(f"Optimized {TARGET_ECONOMIC_IMPACT}")

spark.sql(f"OPTIMIZE {TARGET_LENDER_SCORECARD} ZORDER BY (lender_id)")
print(f"Optimized {TARGET_LENDER_SCORECARD}")

# COMMAND ----------

# MAGIC %md
# MAGIC ---
# MAGIC ## Validation & Summary

# COMMAND ----------

# MAGIC %md
# MAGIC ### Loan Portfolio Summary

# COMMAND ----------

spark.sql(f"""
    SELECT
        program_type,
        COUNT(*) as segments,
        SUM(total_loans) as total_loans,
        ROUND(SUM(total_amount), 2) as total_amount,
        ROUND(AVG(avg_loan_size), 2) as avg_loan_size,
        SUM(total_jobs_retained) as total_jobs,
        ROUND(AVG(forgiveness_rate), 2) as avg_forgiveness_rate,
        ROUND(AVG(default_rate), 2) as avg_default_rate
    FROM {TARGET_LOAN_PORTFOLIO}
    GROUP BY program_type
    ORDER BY total_amount DESC
""").show(truncate=False)

# COMMAND ----------

# High-risk sectors
print("High-Risk Sectors (default_rate > 15%):")
spark.sql(f"""
    SELECT
        naics_sector,
        state,
        program_type,
        total_loans,
        default_rate,
        risk_tier,
        performance_flags
    FROM {TARGET_LOAN_PORTFOLIO}
    WHERE default_rate > 15
    ORDER BY default_rate DESC
    LIMIT 15
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Economic Impact Summary

# COMMAND ----------

spark.sql(f"""
    SELECT
        approval_year,
        COUNT(DISTINCT state) as states,
        SUM(total_loans) as total_loans,
        ROUND(SUM(total_lending_volume), 2) as total_volume,
        SUM(jobs_supported) as total_jobs,
        ROUND(AVG(yoy_growth), 2) as avg_yoy_growth
    FROM {TARGET_ECONOMIC_IMPACT}
    GROUP BY approval_year
    ORDER BY approval_year DESC
""").show(truncate=False)

# COMMAND ----------

# Top states by lending volume (latest year)
print("Top 10 States by Lending Volume (Latest Year):")
spark.sql(f"""
    SELECT
        state,
        state_lending_rank,
        total_loans,
        total_lending_volume,
        jobs_supported,
        yoy_growth,
        growth_category
    FROM {TARGET_ECONOMIC_IMPACT}
    WHERE approval_year = (SELECT MAX(approval_year) FROM {TARGET_ECONOMIC_IMPACT})
    ORDER BY state_lending_rank
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Lender Scorecard Summary

# COMMAND ----------

spark.sql(f"""
    SELECT
        lender_tier,
        COUNT(*) as lenders,
        SUM(total_loans_originated) as total_loans,
        ROUND(SUM(total_portfolio_amount), 2) as total_portfolio,
        ROUND(AVG(portfolio_default_rate), 2) as avg_default_rate,
        ROUND(AVG(forgiveness_success_rate), 2) as avg_forgiveness_rate
    FROM {TARGET_LENDER_SCORECARD}
    GROUP BY lender_tier
    ORDER BY total_portfolio DESC
""").show(truncate=False)

# COMMAND ----------

# Top lenders by volume
print("Top 10 Lenders by Origination Volume:")
spark.sql(f"""
    SELECT
        volume_rank,
        lender_name,
        total_loans_originated,
        avg_loan_size,
        portfolio_default_rate,
        forgiveness_success_rate,
        lender_tier,
        states_served
    FROM {TARGET_LENDER_SCORECARD}
    ORDER BY volume_rank
    LIMIT 10
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Gold Layer Output Summary
# MAGIC
# MAGIC | Table | Description | Partitioned By | Z-Order |
# MAGIC |-------|-------------|----------------|---------|
# MAGIC | gold_sba_loan_portfolio | PPP + 7a/504 by state, NAICS, year with risk flags | approval_year | state, naics_sector, approval_year |
# MAGIC | gold_sba_economic_impact | State-level lending volume, jobs, YoY growth | approval_year | state, approval_year |
# MAGIC | gold_sba_lender_scorecard | Lender origination, defaults, forgiveness rates | - | lender_id |
# MAGIC
# MAGIC **Dashboard Ready:** All tables optimized for Power BI Direct Lake connectivity.
