# Databricks notebook source
# MAGIC %md
# MAGIC # Economic Analysis and Demographic Trends
# MAGIC
# MAGIC This notebook provides comprehensive analytics for Department of Commerce data, including:
# MAGIC - Census ACS demographic trend analysis
# MAGIC - GDP composition and growth patterns by state and industry
# MAGIC - Trade flow analysis and balance of payments
# MAGIC - Cross-domain correlations (demographics vs economic indicators)
# MAGIC
# MAGIC **Data Sources:**
# MAGIC - Census Bureau ACS (api.census.gov) — demographics, income, employment
# MAGIC - Bureau of Economic Analysis (apps.bea.gov) — state/national GDP
# MAGIC - International Trade Administration — trade flows by HS code

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup and Configuration

# COMMAND ----------

# Import required libraries
import warnings

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

warnings.filterwarnings("ignore")

# Statistical libraries
# Spark and Delta libraries
from pyspark.sql.functions import *
from pyspark.sql.types import *
from scipy.stats import pearsonr

# Plotly for interactive visualizations
try:
    import plotly.express as px
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots

    PLOTLY_AVAILABLE = True
except ImportError:
    print("Plotly not available. Using matplotlib only.")
    PLOTLY_AVAILABLE = False

# Configuration
plt.style.use("seaborn-v0_8")
sns.set_palette("husl")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading

# COMMAND ----------


# Load Census demographics from silver layer
def load_census_data():
    """Load Census ACS demographic data from silver layer."""
    df = spark.table("silver.slv_census_demographics").toPandas()
    print(f"Loaded {len(df):,} Census ACS records")
    print(f"States: {df['state_name'].nunique()}")
    print(f"Years: {df['year'].min()} - {df['year'].max()}")
    print(f"Variables: {df['variable_code'].nunique()}")
    return df


def load_gdp_data():
    """Load BEA GDP data from silver layer."""
    df = spark.table("silver.slv_gdp_data").toPandas()
    print(f"\nLoaded {len(df):,} GDP records")
    print(f"States: {df['state_name'].nunique()}")
    print(f"Quarters: {df['year'].min()}Q1 - {df['year'].max()}Q4")
    print(f"Industries: {df['industry_name'].nunique()}")
    return df


def load_trade_data():
    """Load international trade data from silver layer."""
    df = spark.table("silver.slv_trade_data").toPandas()
    print(f"\nLoaded {len(df):,} trade records")
    print(f"Countries: {df['partner_country_name'].nunique()}")
    print(f"HS Codes: {df['hs_code'].nunique()}")
    return df


df_census = load_census_data()
df_gdp = load_gdp_data()
df_trade = load_trade_data()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Census Demographic Analysis

# COMMAND ----------


def analyze_population_trends(df):
    """Analyze population trends across states."""
    # Filter for total population variable
    pop_data = df[df["variable_code"] == "B01001_001E"].copy()

    if len(pop_data) == 0:
        print("No population data found. Checking available variables...")
        print(df["variable_code"].unique())
        return

    # Aggregate by state and year
    state_pop = pop_data.groupby(["state_name", "year"])["estimate"].sum().reset_index()

    # Plot top 10 states by latest population
    latest_year = state_pop["year"].max()
    top_states = state_pop[state_pop["year"] == latest_year].nlargest(10, "estimate")["state_name"].tolist()

    fig, axes = plt.subplots(1, 2, figsize=(18, 8))

    # Population over time for top states
    for state in top_states:
        state_data = state_pop[state_pop["state_name"] == state]
        axes[0].plot(state_data["year"], state_data["estimate"] / 1e6, marker="o", label=state)

    axes[0].set_title("Population Trends by State (Top 10)", fontsize=14, fontweight="bold")
    axes[0].set_xlabel("Year")
    axes[0].set_ylabel("Population (Millions)")
    axes[0].legend(bbox_to_anchor=(1.05, 1), loc="upper left", fontsize=8)
    axes[0].grid(True, alpha=0.3)

    # Population growth rate
    growth_data = state_pop.copy()
    growth_data["pop_growth"] = growth_data.groupby("state_name")["estimate"].pct_change() * 100

    latest_growth = growth_data[growth_data["year"] == latest_year].dropna()
    latest_growth = latest_growth.sort_values("pop_growth", ascending=True)

    colors = ["red" if x < 0 else "green" for x in latest_growth["pop_growth"]]
    axes[1].barh(latest_growth["state_name"], latest_growth["pop_growth"], color=colors)
    axes[1].set_title(f"Population Growth Rate ({latest_year})", fontsize=14, fontweight="bold")
    axes[1].set_xlabel("Growth Rate (%)")
    axes[1].axvline(x=0, color="black", linestyle="-", alpha=0.5)
    axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/population_trends.png", dpi=300, bbox_inches="tight")
    plt.show()


analyze_population_trends(df_census)

# COMMAND ----------


def analyze_income_distribution(df):
    """Analyze median household income distribution."""
    income_data = df[df["variable_code"] == "B19013_001E"].copy()

    if len(income_data) == 0:
        print("No income data found.")
        return

    # State-level income summary
    state_income = (
        income_data.groupby(["state_name", "year"])
        .agg(
            median_income=("estimate", "median"),
            mean_income=("estimate", "mean"),
            income_std=("estimate", "std"),
            count=("estimate", "count"),
        )
        .reset_index()
    )

    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Income distribution by year
    for year in sorted(state_income["year"].unique()):
        year_data = state_income[state_income["year"] == year]
        axes[0, 0].hist(year_data["median_income"], bins=15, alpha=0.5, label=str(year))

    axes[0, 0].set_title("Median Income Distribution by Year", fontweight="bold")
    axes[0, 0].set_xlabel("Median Household Income ($)")
    axes[0, 0].set_ylabel("Number of States")
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)

    # Income inequality (coefficient of variation)
    state_income["cv"] = (state_income["income_std"] / state_income["mean_income"] * 100).round(1)
    cv_by_year = state_income.groupby("year")["cv"].mean().reset_index()

    axes[0, 1].plot(cv_by_year["year"], cv_by_year["cv"], marker="s", linewidth=2, color="purple")
    axes[0, 1].set_title("Income Inequality Trend (CV)", fontweight="bold")
    axes[0, 1].set_xlabel("Year")
    axes[0, 1].set_ylabel("Coefficient of Variation (%)")
    axes[0, 1].grid(True, alpha=0.3)

    # Top/bottom states by latest income
    latest = state_income[state_income["year"] == state_income["year"].max()]

    top5 = latest.nlargest(5, "median_income")
    bottom5 = latest.nsmallest(5, "median_income")
    combined = pd.concat([top5, bottom5]).sort_values("median_income")

    colors = ["red"] * 5 + ["green"] * 5
    axes[1, 0].barh(combined["state_name"], combined["median_income"], color=colors)
    axes[1, 0].set_title("Top/Bottom 5 States by Income", fontweight="bold")
    axes[1, 0].set_xlabel("Median Household Income ($)")
    axes[1, 0].grid(True, alpha=0.3)

    # Income vs poverty correlation
    poverty_data = df[df["variable_code"] == "B17001_002E"].copy()
    if len(poverty_data) > 0:
        merged = pd.merge(
            income_data.groupby("state_name")["estimate"]
            .mean()
            .reset_index()
            .rename(columns={"estimate": "avg_income"}),
            poverty_data.groupby("state_name")["estimate"]
            .mean()
            .reset_index()
            .rename(columns={"estimate": "avg_poverty"}),
            on="state_name",
        )
        axes[1, 1].scatter(merged["avg_income"], merged["avg_poverty"], alpha=0.7, s=80)
        for _, row in merged.iterrows():
            axes[1, 1].annotate(row["state_name"][:2], (row["avg_income"], row["avg_poverty"]), fontsize=7)
        axes[1, 1].set_title("Income vs Poverty Level", fontweight="bold")
        axes[1, 1].set_xlabel("Average Median Income ($)")
        axes[1, 1].set_ylabel("Average Population Below Poverty")
        axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/income_analysis.png", dpi=300, bbox_inches="tight")
    plt.show()


analyze_income_distribution(df_census)

# COMMAND ----------

# MAGIC %md
# MAGIC ## GDP Analysis

# COMMAND ----------


def analyze_gdp_composition(df):
    """Analyze GDP composition by industry and state."""
    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # GDP by industry (national)
    industry_gdp = df.groupby("industry_name")["gdp_current_dollars"].sum().sort_values(ascending=True)
    industry_gdp.plot(kind="barh", ax=axes[0, 0], color=sns.color_palette("viridis", len(industry_gdp)))
    axes[0, 0].set_title("GDP by Industry (Total)", fontsize=13, fontweight="bold")
    axes[0, 0].set_xlabel("GDP (Millions $)")
    axes[0, 0].grid(True, alpha=0.3)

    # GDP growth by quarter
    quarterly_gdp = df.groupby(["year", "quarter"])["gdp_current_dollars"].sum().reset_index()
    quarterly_gdp["year_quarter"] = quarterly_gdp["year"].astype(str) + "-Q" + quarterly_gdp["quarter"].astype(str)
    quarterly_gdp["gdp_growth"] = quarterly_gdp["gdp_current_dollars"].pct_change() * 100

    axes[0, 1].bar(
        range(len(quarterly_gdp)),
        quarterly_gdp["gdp_growth"],
        color=["green" if x >= 0 else "red" for x in quarterly_gdp["gdp_growth"].fillna(0)],
    )
    axes[0, 1].set_title("Quarterly GDP Growth Rate", fontsize=13, fontweight="bold")
    axes[0, 1].set_xlabel("Quarter")
    axes[0, 1].set_ylabel("Growth Rate (%)")
    tick_positions = list(range(0, len(quarterly_gdp), 4))
    axes[0, 1].set_xticks(tick_positions)
    axes[0, 1].set_xticklabels([quarterly_gdp["year_quarter"].iloc[i] for i in tick_positions], rotation=45)
    axes[0, 1].axhline(y=0, color="black", linestyle="-", alpha=0.5)
    axes[0, 1].grid(True, alpha=0.3)

    # State GDP comparison
    state_gdp = df.groupby("state_name")["gdp_current_dollars"].sum().sort_values(ascending=False)
    top_states = state_gdp.head(10)
    top_states.plot(kind="bar", ax=axes[1, 0], color=sns.color_palette("coolwarm", len(top_states)))
    axes[1, 0].set_title("Top 10 States by GDP", fontsize=13, fontweight="bold")
    axes[1, 0].set_ylabel("Total GDP (Millions $)")
    axes[1, 0].set_xticklabels(axes[1, 0].get_xticklabels(), rotation=45, ha="right")
    axes[1, 0].grid(True, alpha=0.3)

    # Real vs Nominal GDP trend
    gdp_trend = (
        df.groupby("year")
        .agg(nominal=("gdp_current_dollars", "sum"), real=("gdp_chained_dollars", "sum"))
        .reset_index()
    )

    axes[1, 1].plot(gdp_trend["year"], gdp_trend["nominal"] / 1e6, marker="o", label="Nominal GDP", linewidth=2)
    axes[1, 1].plot(gdp_trend["year"], gdp_trend["real"] / 1e6, marker="s", label="Real GDP", linewidth=2)
    axes[1, 1].set_title("Nominal vs Real GDP", fontsize=13, fontweight="bold")
    axes[1, 1].set_xlabel("Year")
    axes[1, 1].set_ylabel("GDP (Trillions $)")
    axes[1, 1].legend()
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/gdp_analysis.png", dpi=300, bbox_inches="tight")
    plt.show()


analyze_gdp_composition(df_gdp)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Trade Flow Analysis

# COMMAND ----------


def analyze_trade_flows(df):
    """Analyze international trade patterns."""
    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Trade balance by country
    country_trade = df.groupby(["partner_country_name", "flow_type"])["trade_value_usd"].sum().unstack(fill_value=0)
    if "EXPORT" in country_trade.columns and "IMPORT" in country_trade.columns:
        country_trade["balance"] = country_trade["EXPORT"] - country_trade["IMPORT"]
        country_trade = country_trade.sort_values("balance")

        colors = ["red" if x < 0 else "green" for x in country_trade["balance"]]
        axes[0, 0].barh(country_trade.index, country_trade["balance"] / 1e9, color=colors)
        axes[0, 0].set_title("Trade Balance by Country", fontsize=13, fontweight="bold")
        axes[0, 0].set_xlabel("Balance (Billions $)")
        axes[0, 0].axvline(x=0, color="black", linestyle="-")
        axes[0, 0].grid(True, alpha=0.3)

    # Trade by transport method
    transport_trade = df.groupby("transport_method")["trade_value_usd"].sum().sort_values()
    transport_trade.plot(kind="barh", ax=axes[0, 1], color=sns.color_palette("Set2", len(transport_trade)))
    axes[0, 1].set_title("Trade Value by Transport Method", fontsize=13, fontweight="bold")
    axes[0, 1].set_xlabel("Trade Value ($)")
    axes[0, 1].grid(True, alpha=0.3)

    # Monthly trade trend
    monthly_trade = df.groupby(["year", "month", "flow_type"])["trade_value_usd"].sum().reset_index()
    monthly_trade["date"] = pd.to_datetime(monthly_trade[["year", "month"]].assign(day=1))

    for flow in ["EXPORT", "IMPORT"]:
        flow_data = monthly_trade[monthly_trade["flow_type"] == flow]
        axes[1, 0].plot(flow_data["date"], flow_data["trade_value_usd"] / 1e9, marker=".", label=flow, linewidth=1.5)

    axes[1, 0].set_title("Monthly Trade Trends", fontsize=13, fontweight="bold")
    axes[1, 0].set_xlabel("Date")
    axes[1, 0].set_ylabel("Trade Value (Billions $)")
    axes[1, 0].legend()
    axes[1, 0].grid(True, alpha=0.3)
    plt.setp(axes[1, 0].xaxis.get_majorticklabels(), rotation=45)

    # Top commodities by trade value
    commodity_trade = df.groupby("commodity_description")["trade_value_usd"].sum().sort_values(ascending=False).head(10)
    commodity_trade.plot(kind="bar", ax=axes[1, 1], color=sns.color_palette("mako", len(commodity_trade)))
    axes[1, 1].set_title("Top 10 Traded Commodities", fontsize=13, fontweight="bold")
    axes[1, 1].set_ylabel("Total Trade Value ($)")
    axes[1, 1].set_xticklabels(axes[1, 1].get_xticklabels(), rotation=45, ha="right")
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/trade_analysis.png", dpi=300, bbox_inches="tight")
    plt.show()


analyze_trade_flows(df_trade)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cross-Domain Correlation Analysis

# COMMAND ----------


def analyze_cross_domain(df_census, df_gdp, df_trade):
    """Analyze correlations between demographics, GDP, and trade."""

    # Prepare state-level summaries
    income_by_state = df_census[df_census["variable_code"] == "B19013_001E"].groupby("state_name")["estimate"].mean()
    gdp_by_state = df_gdp.groupby("state_name")["gdp_current_dollars"].sum()
    trade_by_state = df_trade.groupby("district_name")["trade_value_usd"].sum()

    # Merge available data
    merged = pd.DataFrame({"median_income": income_by_state, "total_gdp": gdp_by_state}).dropna()

    if len(merged) < 3:
        print("Insufficient overlapping state data for correlation analysis.")
        return

    fig, axes = plt.subplots(1, 2, figsize=(16, 7))

    # Income vs GDP
    axes[0].scatter(merged["median_income"], merged["total_gdp"] / 1e6, alpha=0.7, s=100, c="steelblue")
    for state in merged.index:
        axes[0].annotate(
            state[:5], (merged.loc[state, "median_income"], merged.loc[state, "total_gdp"] / 1e6), fontsize=7
        )

    # Trend line
    if len(merged) > 2:
        z = np.polyfit(merged["median_income"], merged["total_gdp"] / 1e6, 1)
        p = np.poly1d(z)
        x_line = np.linspace(merged["median_income"].min(), merged["median_income"].max(), 100)
        axes[0].plot(x_line, p(x_line), "--", color="red", alpha=0.7)

        r, pval = pearsonr(merged["median_income"], merged["total_gdp"] / 1e6)
        axes[0].text(
            0.05,
            0.95,
            f"r = {r:.3f}\np = {pval:.4f}",
            transform=axes[0].transAxes,
            verticalalignment="top",
            bbox={"boxstyle": "round", "facecolor": "white", "alpha": 0.8},
        )

    axes[0].set_title("Median Income vs Total GDP", fontweight="bold")
    axes[0].set_xlabel("Median Household Income ($)")
    axes[0].set_ylabel("Total GDP (Billions $)")
    axes[0].grid(True, alpha=0.3)

    # GDP composition heatmap
    gdp_composition = df_gdp.groupby(["state_name", "industry_name"])["gdp_current_dollars"].sum().unstack(fill_value=0)
    # Normalize to percentage
    gdp_pct = gdp_composition.div(gdp_composition.sum(axis=1), axis=0) * 100

    sns.heatmap(
        gdp_pct.head(10), annot=True, fmt=".1f", cmap="YlOrRd", ax=axes[1], cbar_kws={"label": "Share of GDP (%)"}
    )
    axes[1].set_title("GDP Composition by Industry (%)", fontweight="bold")
    axes[1].set_xticklabels(axes[1].get_xticklabels(), rotation=45, ha="right", fontsize=8)

    plt.tight_layout()
    plt.savefig("/tmp/cross_domain_analysis.png", dpi=300, bbox_inches="tight")
    plt.show()


analyze_cross_domain(df_census, df_gdp, df_trade)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results to Delta Lake

# COMMAND ----------


def save_analysis_results():
    """Save key analysis outputs to Delta Lake gold layer."""

    # GDP growth summary
    gdp_growth = (
        df_gdp.groupby(["state_name", "year", "quarter"])
        .agg(total_gdp=("gdp_current_dollars", "sum"), real_gdp=("gdp_chained_dollars", "sum"))
        .reset_index()
    )

    gdp_growth_spark = spark.createDataFrame(gdp_growth)
    gdp_growth_spark = gdp_growth_spark.withColumn("analysis_date", current_date())

    (gdp_growth_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_economic_summary"))

    print(f"Saved {len(gdp_growth)} economic summary records to gold.gld_economic_summary")

    # Trade balance summary
    trade_balance = (
        df_trade.groupby(["partner_country_name", "year", "flow_type"])
        .agg(total_value=("trade_value_usd", "sum"), transaction_count=("trade_id", "count"))
        .reset_index()
    )

    trade_spark = spark.createDataFrame(trade_balance)
    trade_spark = trade_spark.withColumn("analysis_date", current_date())

    (trade_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_trade_balance_summary"))

    print(f"Saved {len(trade_balance)} trade balance records to gold.gld_trade_balance_summary")


save_analysis_results()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary Report

# COMMAND ----------

print("=" * 65)
print("COMMERCE ECONOMIC ANALYSIS - INITIAL RESULTS")
print("=" * 65)

print("\nDataset Overview:")
print(f"  Census ACS records: {len(df_census):,}")
print(f"  GDP records: {len(df_gdp):,}")
print(f"  Trade records: {len(df_trade):,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Sector Comparison Analysis

# COMMAND ----------


def analyze_sector_comparison(df_gdp):
    """Deep comparison of GDP sectors across states and time."""
    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Industry growth rates
    industry_yearly = df_gdp.groupby(["industry_name", "year"])["gdp_current_dollars"].sum().reset_index()
    industry_yearly = industry_yearly.sort_values(["industry_name", "year"])
    industry_yearly["growth"] = industry_yearly.groupby("industry_name")["gdp_current_dollars"].pct_change() * 100

    latest_year = industry_yearly["year"].max()
    latest_growth = industry_yearly[industry_yearly["year"] == latest_year].dropna()
    latest_growth = latest_growth.sort_values("growth")

    colors_growth = ["red" if g < 0 else "green" for g in latest_growth["growth"]]
    axes[0, 0].barh(latest_growth["industry_name"], latest_growth["growth"], color=colors_growth)
    axes[0, 0].axvline(x=0, color="black", linestyle="-")
    axes[0, 0].set_title(f"Industry GDP Growth ({latest_year})", fontweight="bold")
    axes[0, 0].set_xlabel("Growth Rate (%)")
    axes[0, 0].grid(True, alpha=0.3)

    # Industry concentration (Herfindahl index per state)
    state_industry = df_gdp.groupby(["state_name", "industry_name"])["gdp_current_dollars"].sum().reset_index()
    state_total = df_gdp.groupby("state_name")["gdp_current_dollars"].sum().reset_index()
    state_total.columns = ["state_name", "total_gdp"]
    state_industry = state_industry.merge(state_total, on="state_name")
    state_industry["share"] = (state_industry["gdp_current_dollars"] / state_industry["total_gdp"]).clip(lower=0)
    state_industry["share_sq"] = state_industry["share"] ** 2

    hhi = state_industry.groupby("state_name")["share_sq"].sum().reset_index()
    hhi.columns = ["state_name", "hhi"]
    hhi = hhi.sort_values("hhi", ascending=False)

    colors_hhi = ["red" if h > 0.25 else "orange" if h > 0.15 else "green" for h in hhi["hhi"]]
    axes[0, 1].barh(hhi["state_name"].head(15), hhi["hhi"].head(15), color=colors_hhi[:15])
    axes[0, 1].set_title("Economic Concentration (HHI) by State", fontweight="bold")
    axes[0, 1].set_xlabel("Herfindahl-Hirschman Index")
    axes[0, 1].axvline(x=0.25, color="red", linestyle="--", alpha=0.5, label="Highly concentrated")
    axes[0, 1].legend()
    axes[0, 1].grid(True, alpha=0.3)

    # Sector composition over time
    industry_total = df_gdp.groupby(["year", "industry_name"])["gdp_current_dollars"].sum().reset_index()
    year_total = industry_total.groupby("year")["gdp_current_dollars"].sum().reset_index()
    year_total.columns = ["year", "yearly_total"]
    industry_total = industry_total.merge(year_total, on="year")
    industry_total["share"] = industry_total["gdp_current_dollars"] / industry_total["yearly_total"] * 100

    top_industries = df_gdp.groupby("industry_name")["gdp_current_dollars"].sum().nlargest(5).index
    for ind in top_industries:
        ind_data = industry_total[industry_total["industry_name"] == ind]
        axes[1, 0].plot(ind_data["year"], ind_data["share"], marker="o", label=ind[:25], linewidth=2)
    axes[1, 0].set_title("Top 5 Industry Share Over Time", fontweight="bold")
    axes[1, 0].set_xlabel("Year")
    axes[1, 0].set_ylabel("GDP Share (%)")
    axes[1, 0].legend(fontsize=7)
    axes[1, 0].grid(True, alpha=0.3)

    # Real vs nominal GDP gap by industry
    industry_gap = (
        df_gdp.groupby("industry_name")
        .agg(nominal=("gdp_current_dollars", "sum"), real=("gdp_chained_dollars", "sum"))
        .reset_index()
    )
    industry_gap["inflation_gap_pct"] = (
        (industry_gap["nominal"] - industry_gap["real"]) / industry_gap["nominal"].clip(lower=1) * 100
    ).round(1)
    industry_gap = industry_gap.sort_values("inflation_gap_pct")

    axes[1, 1].barh(industry_gap["industry_name"], industry_gap["inflation_gap_pct"], color="purple", alpha=0.7)
    axes[1, 1].set_title("Nominal-Real GDP Gap by Industry (%)", fontweight="bold")
    axes[1, 1].set_xlabel("Gap (%)")
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/sector_comparison.png", dpi=300, bbox_inches="tight")
    plt.show()

    return hhi


hhi_scores = analyze_sector_comparison(df_gdp)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Leading Indicator Correlations

# COMMAND ----------

from scipy.stats import spearmanr


def analyze_leading_indicators(df_census, df_gdp, df_trade):
    """Analyze correlations between demographic indicators and economic performance."""
    # State-level economic summary
    gdp_by_state = (
        df_gdp.groupby("state_name")
        .agg(
            total_gdp=("gdp_current_dollars", "sum"),
            real_gdp=("gdp_chained_dollars", "sum"),
            n_industries=("industry_name", "nunique"),
        )
        .reset_index()
    )

    # Census indicators by state
    pop_by_state = df_census[df_census["variable_code"] == "B01001_001E"].groupby("state_name")["estimate"].sum()
    income_by_state = df_census[df_census["variable_code"] == "B19013_001E"].groupby("state_name")["estimate"].mean()
    poverty_by_state = df_census[df_census["variable_code"] == "B17001_002E"].groupby("state_name")["estimate"].sum()

    indicators = pd.DataFrame(
        {"population": pop_by_state, "median_income": income_by_state, "poverty_count": poverty_by_state}
    ).reset_index()

    merged_ind = gdp_by_state.merge(indicators, on="state_name", how="inner").dropna()
    if len(merged_ind) < 5:
        print("Insufficient data for leading indicator analysis.")
        return None

    merged_ind["gdp_per_capita"] = merged_ind["total_gdp"] / merged_ind["population"].clip(lower=1)
    merged_ind["poverty_rate"] = merged_ind["poverty_count"] / merged_ind["population"].clip(lower=1) * 100

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # GDP per capita vs median income
    axes[0, 0].scatter(merged_ind["median_income"], merged_ind["gdp_per_capita"], alpha=0.7, s=80, c="steelblue")
    for _, row in merged_ind.iterrows():
        axes[0, 0].annotate(row["state_name"][:3], (row["median_income"], row["gdp_per_capita"]), fontsize=7)
    if len(merged_ind) > 3:
        r, pval = pearsonr(merged_ind["median_income"], merged_ind["gdp_per_capita"])
        z = np.polyfit(merged_ind["median_income"], merged_ind["gdp_per_capita"], 1)
        p = np.poly1d(z)
        x_line = np.linspace(merged_ind["median_income"].min(), merged_ind["median_income"].max(), 100)
        axes[0, 0].plot(x_line, p(x_line), "r--", alpha=0.7)
        axes[0, 0].text(
            0.05,
            0.95,
            f"r = {r:.3f}",
            transform=axes[0, 0].transAxes,
            va="top",
            bbox={"boxstyle": "round", "facecolor": "white", "alpha": 0.8},
        )
    axes[0, 0].set_title("GDP per Capita vs Median Income", fontweight="bold")
    axes[0, 0].set_xlabel("Median Household Income ($)")
    axes[0, 0].set_ylabel("GDP per Capita ($)")
    axes[0, 0].grid(True, alpha=0.3)

    # Poverty rate vs GDP per capita
    axes[0, 1].scatter(merged_ind["poverty_rate"], merged_ind["gdp_per_capita"], alpha=0.7, s=80, c="coral")
    for _, row in merged_ind.iterrows():
        axes[0, 1].annotate(row["state_name"][:3], (row["poverty_rate"], row["gdp_per_capita"]), fontsize=7)
    axes[0, 1].set_title("Poverty Rate vs GDP per Capita", fontweight="bold")
    axes[0, 1].set_xlabel("Poverty Rate (%)")
    axes[0, 1].set_ylabel("GDP per Capita ($)")
    axes[0, 1].grid(True, alpha=0.3)

    # Correlation heatmap of all indicators
    corr_cols = ["total_gdp", "population", "median_income", "poverty_rate", "gdp_per_capita", "n_industries"]
    available_corr = [c for c in corr_cols if c in merged_ind.columns]
    corr = merged_ind[available_corr].corr()
    mask = np.triu(np.ones_like(corr, dtype=bool))
    sns.heatmap(corr, mask=mask, annot=True, fmt=".2f", cmap="RdBu_r", center=0, ax=axes[1, 0])
    axes[1, 0].set_title("Leading Indicator Correlations", fontweight="bold")

    # Economic diversification vs GDP per capita
    axes[1, 1].scatter(
        merged_ind["n_industries"],
        merged_ind["gdp_per_capita"],
        s=merged_ind["population"] / 50000,
        alpha=0.6,
        c="teal",
    )
    for _, row in merged_ind.iterrows():
        axes[1, 1].annotate(row["state_name"][:3], (row["n_industries"], row["gdp_per_capita"]), fontsize=7)
    axes[1, 1].set_title("Industry Diversification vs GDP/capita (size=pop)", fontweight="bold")
    axes[1, 1].set_xlabel("Number of Industries")
    axes[1, 1].set_ylabel("GDP per Capita ($)")
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/leading_indicators.png", dpi=300, bbox_inches="tight")
    plt.show()

    return merged_ind


indicator_analysis = analyze_leading_indicators(df_census, df_gdp, df_trade)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Recession Indicator Modeling

# COMMAND ----------

import mlflow
import mlflow.sklearn
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import f1_score, roc_auc_score, roc_curve
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder, StandardScaler

mlflow.set_experiment("/Commerce/economic_analysis")


def build_recession_indicators(df_gdp):
    """Build a model to identify recession-like conditions from GDP patterns."""
    # Aggregate GDP by quarter
    quarterly = (
        df_gdp.groupby(["year", "quarter"])
        .agg(
            total_gdp=("gdp_current_dollars", "sum"),
            real_gdp=("gdp_chained_dollars", "sum"),
            n_states=("state_name", "nunique"),
            n_industries=("industry_name", "nunique"),
        )
        .reset_index()
        .sort_values(["year", "quarter"])
    )

    quarterly["gdp_growth"] = quarterly["total_gdp"].pct_change()
    quarterly["real_gdp_growth"] = quarterly["real_gdp"].pct_change()

    # Lag features
    for lag in [1, 2, 4]:
        quarterly[f"gdp_lag_{lag}"] = quarterly["total_gdp"].shift(lag)
        quarterly[f"growth_lag_{lag}"] = quarterly["gdp_growth"].shift(lag)

    quarterly["gdp_rolling_4q"] = quarterly["total_gdp"].rolling(window=4, min_periods=2).mean()
    quarterly["growth_rolling_4q"] = quarterly["gdp_growth"].rolling(window=4, min_periods=2).mean()

    # Define recession: 2 consecutive quarters of negative real growth
    quarterly["negative_growth"] = (quarterly["real_gdp_growth"] < 0).astype(int)
    quarterly["recession_flag"] = (
        (quarterly["negative_growth"] == 1) & (quarterly["negative_growth"].shift(1) == 1)
    ).astype(int)

    quarterly = quarterly.dropna()
    print(f"Recession quarters: {quarterly['recession_flag'].sum()} / {len(quarterly)}")

    features_rec = [
        "gdp_growth",
        "real_gdp_growth",
        "n_states",
        "n_industries",
        "gdp_lag_1",
        "gdp_lag_2",
        "growth_lag_1",
        "growth_lag_2",
        "growth_lag_4",
        "gdp_rolling_4q",
        "growth_rolling_4q",
    ]
    available_rec = [f for f in features_rec if f in quarterly.columns]

    X_rec = quarterly[available_rec].fillna(0)
    y_rec = quarterly["recession_flag"]

    if y_rec.sum() < 2:
        print("Insufficient recession events for robust modeling. Using indicator analysis only.")
        fig, axes = plt.subplots(1, 2, figsize=(16, 6))

        axes[0].plot(
            quarterly["year"] + quarterly["quarter"] / 4, quarterly["real_gdp_growth"] * 100, "b-o", linewidth=1.5
        )
        axes[0].axhline(y=0, color="red", linestyle="--")
        axes[0].fill_between(
            quarterly["year"] + quarterly["quarter"] / 4,
            quarterly["real_gdp_growth"] * 100,
            where=quarterly["real_gdp_growth"] < 0,
            color="red",
            alpha=0.3,
        )
        axes[0].set_title("Real GDP Growth Rate", fontweight="bold")
        axes[0].set_xlabel("Year")
        axes[0].set_ylabel("Growth Rate (%)")
        axes[0].grid(True, alpha=0.3)

        # Growth momentum
        axes[1].plot(
            quarterly["year"] + quarterly["quarter"] / 4,
            quarterly["growth_rolling_4q"] * 100,
            "g-o",
            linewidth=2,
            label="4Q Rolling Avg",
        )
        axes[1].plot(
            quarterly["year"] + quarterly["quarter"] / 4,
            quarterly["gdp_growth"] * 100,
            "b.",
            alpha=0.5,
            label="Quarterly",
        )
        axes[1].axhline(y=0, color="red", linestyle="--")
        axes[1].set_title("GDP Growth Momentum", fontweight="bold")
        axes[1].set_xlabel("Year")
        axes[1].set_ylabel("Growth Rate (%)")
        axes[1].legend()
        axes[1].grid(True, alpha=0.3)

        plt.tight_layout()
        plt.savefig("/tmp/recession_indicators.png", dpi=300, bbox_inches="tight")
        plt.show()
        return quarterly

    X_tr, X_te, y_tr, y_te = train_test_split(X_rec, y_rec, test_size=0.3, stratify=y_rec, random_state=42)
    scaler_rec = StandardScaler()
    X_tr_s = scaler_rec.fit_transform(X_tr)
    X_te_s = scaler_rec.transform(X_te)

    gb_rec = GradientBoostingClassifier(n_estimators=50, max_depth=3, random_state=42)

    with mlflow.start_run(run_name="recession_indicator"):
        gb_rec.fit(X_tr_s, y_tr)
        y_pred_rec = gb_rec.predict(X_te_s)
        y_prob_rec = gb_rec.predict_proba(X_te_s)[:, 1]

        rec_f1 = f1_score(y_te, y_pred_rec, zero_division=0)
        rec_auc = roc_auc_score(y_te, y_prob_rec)

        mlflow.log_metric("f1", rec_f1)
        mlflow.log_metric("auc", rec_auc)
        mlflow.sklearn.log_model(gb_rec, "recession_model")
        print(f"Recession Model - F1: {rec_f1:.3f}, AUC: {rec_auc:.3f}")

    fig, axes = plt.subplots(1, 2, figsize=(16, 6))

    fpr, tpr, _ = roc_curve(y_te, y_prob_rec)
    axes[0].plot(fpr, tpr, linewidth=2, label=f"AUC={rec_auc:.3f}")
    axes[0].plot([0, 1], [0, 1], "k--", alpha=0.5)
    axes[0].set_title("Recession Prediction ROC", fontweight="bold")
    axes[0].set_xlabel("FPR")
    axes[0].set_ylabel("TPR")
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)

    imp_rec = pd.DataFrame({"feature": available_rec, "importance": gb_rec.feature_importances_}).sort_values(
        "importance", ascending=True
    )
    axes[1].barh(imp_rec["feature"], imp_rec["importance"], color="coral")
    axes[1].set_title("Recession Feature Importance", fontweight="bold")
    axes[1].set_xlabel("Importance")
    axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/recession_indicators.png", dpi=300, bbox_inches="tight")
    plt.show()

    return quarterly


recession_data = build_recession_indicators(df_gdp)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Extended Results

# COMMAND ----------

# Save HHI scores
hhi_spark = spark.createDataFrame(hhi_scores)
hhi_spark = hhi_spark.withColumn("analysis_date", current_date())

(hhi_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_state_economic_concentration"))

print("Saved to gold.gld_state_economic_concentration")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary Report

# COMMAND ----------

print("=" * 65)
print("COMMERCE ECONOMIC ANALYSIS - COMPREHENSIVE SUMMARY")
print("=" * 65)

print("\nDataset Overview:")
print(f"  Census ACS records: {len(df_census):,}")
print(f"  GDP records: {len(df_gdp):,}")
print(f"  Trade records: {len(df_trade):,}")

print("\nKey Findings:")
print(f"  GDP data covers {df_gdp['state_name'].nunique()} states, {df_gdp['industry_name'].nunique()} industries")
print(f"  Trade data covers {df_trade['partner_country_name'].nunique()} partner countries")
print(f"  Highly concentrated states (HHI > 0.25): {(hhi_scores['hhi'] > 0.25).sum()}")

if len(df_gdp) > 0:
    total_gdp = df_gdp["gdp_current_dollars"].sum()
    print(f"  Total GDP across all states/years: ${total_gdp / 1e9:,.1f}B")

if len(df_trade) > 0:
    exports = df_trade[df_trade["flow_type"] == "EXPORT"]["trade_value_usd"].sum()
    imports = df_trade[df_trade["flow_type"] == "IMPORT"]["trade_value_usd"].sum()
    balance = exports - imports
    print(f"  Total exports: ${exports / 1e9:,.1f}B")
    print(f"  Total imports: ${imports / 1e9:,.1f}B")
    print(f"  Trade balance: ${balance / 1e9:,.1f}B")

print("\nOutputs Generated:")
print("  gold.gld_economic_summary")
print("  gold.gld_trade_balance_summary")
print("  gold.gld_state_economic_concentration")
print("  Visualizations: /tmp/*.png")

print("=" * 65)
