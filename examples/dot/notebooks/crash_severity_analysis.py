# Databricks notebook source
# MAGIC %md
# MAGIC # Crash Severity Analysis and Visualization
# MAGIC
# MAGIC This notebook provides comprehensive analytics for DOT/NHTSA FARS crash data, including:
# MAGIC - Temporal trend analysis of fatal crashes
# MAGIC - Geographic hotspot identification
# MAGIC - Environmental and road condition correlations
# MAGIC - Crash severity factor analysis
# MAGIC - Interactive visualizations for safety policy insights
# MAGIC
# MAGIC **Data Sources:**
# MAGIC - NHTSA Fatality Analysis Reporting System (FARS)
# MAGIC - FHWA Highway Performance Monitoring System
# MAGIC - State DOT crash reporting systems

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup and Configuration

# COMMAND ----------

# Import required libraries
import warnings
from datetime import datetime

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

warnings.filterwarnings("ignore")

# Statistical libraries
from scipy.stats import chi2_contingency, pearsonr

# Geospatial and advanced viz
try:
    import plotly.express as px
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots

    PLOTLY_AVAILABLE = True
except ImportError:
    print("Plotly not available. Using matplotlib for all visualizations.")
    PLOTLY_AVAILABLE = False

# Spark and Delta libraries
from pyspark.sql.functions import *
from pyspark.sql.types import *

# Configuration
plt.style.use("seaborn-v0_8")
sns.set_palette("husl")
FIGURE_DPI = 300

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading and Preparation

# COMMAND ----------


# Load crash data from silver layer
def load_crash_data():
    """Load fatal crash data from silver layer Delta tables."""

    # Load silver layer crash records
    crash_df = spark.table("silver.slv_crash_data").toPandas()

    # Filter for valid records with recent data
    crash_df = crash_df[
        (crash_df["crash_year"].between(2015, datetime.now().year))
        & (crash_df["fatality_count"] > 0)
        & (crash_df["state_code"].notna())
        & (crash_df["is_valid_record"] == True)
    ].copy()

    print(f"Loaded {len(crash_df):,} fatal crash records")
    print(f"States: {crash_df['state_fips'].nunique()}")
    print(f"Years: {crash_df['crash_year'].min()} - {crash_df['crash_year'].max()}")
    print(f"Total fatalities: {crash_df['fatality_count'].sum():,}")

    return crash_df


df_crashes = load_crash_data()

# COMMAND ----------


# Data quality assessment and preparation
def prepare_crash_data(df):
    """Clean and enrich crash data for analysis."""

    df_clean = df.copy()

    # Decode time-of-day categories
    def classify_time_of_day(hour):
        if pd.isna(hour) or hour == 99:
            return "Unknown"
        if 6 <= hour < 10:
            return "Morning Rush"
        if 10 <= hour < 16:
            return "Midday"
        if 16 <= hour < 20:
            return "Evening Rush"
        if 20 <= hour < 24 or 0 <= hour < 2:
            return "Night"
        return "Late Night"

    df_clean["time_of_day"] = df_clean["crash_hour"].apply(classify_time_of_day)

    # Decode day of week
    dow_map = {1: "Sunday", 2: "Monday", 3: "Tuesday", 4: "Wednesday", 5: "Thursday", 6: "Friday", 7: "Saturday"}
    df_clean["day_name"] = df_clean["day_of_week"].map(dow_map)

    # Weekend flag
    df_clean["is_weekend"] = df_clean["day_of_week"].isin([1, 7])

    # Decode weather conditions
    weather_map = {
        1: "Clear",
        2: "Rain",
        3: "Sleet/Hail",
        4: "Snow",
        5: "Fog",
        6: "Wind",
        7: "Blowing Sand",
        8: "Other",
        10: "Cloudy",
        11: "Blowing Snow",
        12: "Freezing Rain",
    }
    df_clean["weather_desc"] = df_clean["weather_condition_code"].map(weather_map).fillna("Unknown")

    # Decode light conditions
    light_map = {
        1: "Daylight",
        2: "Dark-Not Lighted",
        3: "Dark-Lighted",
        4: "Dawn",
        5: "Dusk",
        6: "Dark-Unknown Lighting",
    }
    df_clean["light_desc"] = df_clean["light_condition_code"].map(light_map).fillna("Unknown")

    # Decode rural/urban
    df_clean["area_type"] = df_clean["rural_urban_code"].map({1: "Rural", 2: "Urban"}).fillna("Unknown")

    # Decode manner of collision
    collision_map = {
        0: "Not Collision",
        1: "Rear-End",
        2: "Head-On",
        5: "Angle",
        6: "Sideswipe-Same Dir",
        7: "Sideswipe-Opp Dir",
        8: "Rear-to-Rear",
        9: "Other",
    }
    df_clean["collision_type"] = df_clean["manner_of_collision_code"].map(collision_map).fillna("Other")

    # Crash severity classification
    def classify_severity(row):
        if row["fatality_count"] >= 3:
            return "Mass Casualty (3+)"
        if row["fatality_count"] == 2:
            return "Multiple Fatality"
        if row["drunk_driver_count"] > 0:
            return "DUI-Related"
        if row["pedestrians_involved"] > 0:
            return "Pedestrian-Involved"
        return "Single Fatality"

    df_clean["severity_class"] = df_clean.apply(classify_severity, axis=1)

    # Speed category
    def speed_category(limit):
        if pd.isna(limit) or limit == 0:
            return "Unknown"
        if limit <= 30:
            return "Low (≤30 mph)"
        if limit <= 45:
            return "Medium (31-45 mph)"
        if limit <= 55:
            return "Moderate (46-55 mph)"
        if limit <= 65:
            return "High (56-65 mph)"
        return "Very High (>65 mph)"

    df_clean["speed_category"] = df_clean["posted_speed_limit"].apply(speed_category)

    print(f"Data prepared: {len(df_clean):,} records after enrichment")
    return df_clean


df_prepared = prepare_crash_data(df_crashes)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Temporal Analysis

# COMMAND ----------


# Annual fatality trends
def plot_annual_trends():
    """Analyze and visualize annual crash fatality trends."""

    annual_stats = (
        df_prepared.groupby("crash_year")
        .agg(
            {
                "case_id": "count",
                "fatality_count": "sum",
                "drunk_driver_count": lambda x: (x > 0).sum(),
                "pedestrians_involved": lambda x: (x > 0).sum(),
                "total_persons": "sum",
            }
        )
        .rename(
            columns={
                "case_id": "total_crashes",
                "fatality_count": "total_fatalities",
                "drunk_driver_count": "dui_crashes",
                "pedestrians_involved": "pedestrian_crashes",
            }
        )
        .reset_index()
    )

    annual_stats["fatalities_per_crash"] = (annual_stats["total_fatalities"] / annual_stats["total_crashes"]).round(3)

    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Total fatalities trend
    ax1 = axes[0, 0]
    ax1.bar(annual_stats["crash_year"], annual_stats["total_fatalities"], color="#e74c3c", alpha=0.8)
    z = np.polyfit(annual_stats["crash_year"], annual_stats["total_fatalities"], 1)
    p = np.poly1d(z)
    ax1.plot(
        annual_stats["crash_year"], p(annual_stats["crash_year"]), "--", color="darkred", linewidth=2, label="Trend"
    )
    ax1.set_title("Annual Traffic Fatalities", fontsize=14, fontweight="bold")
    ax1.set_xlabel("Year")
    ax1.set_ylabel("Fatalities")
    ax1.legend()
    ax1.grid(True, alpha=0.3)

    # DUI crashes trend
    ax2 = axes[0, 1]
    ax2.bar(annual_stats["crash_year"], annual_stats["dui_crashes"], color="#f39c12", alpha=0.8)
    ax2.set_title("DUI-Related Fatal Crashes", fontsize=14, fontweight="bold")
    ax2.set_xlabel("Year")
    ax2.set_ylabel("Crashes")
    ax2.grid(True, alpha=0.3)

    # Pedestrian crashes
    ax3 = axes[1, 0]
    ax3.bar(annual_stats["crash_year"], annual_stats["pedestrian_crashes"], color="#3498db", alpha=0.8)
    ax3.set_title("Pedestrian-Involved Fatal Crashes", fontsize=14, fontweight="bold")
    ax3.set_xlabel("Year")
    ax3.set_ylabel("Crashes")
    ax3.grid(True, alpha=0.3)

    # Fatalities per crash
    ax4 = axes[1, 1]
    ax4.plot(annual_stats["crash_year"], annual_stats["fatalities_per_crash"], marker="o", linewidth=2, color="#2ecc71")
    ax4.set_title("Average Fatalities per Crash", fontsize=14, fontweight="bold")
    ax4.set_xlabel("Year")
    ax4.set_ylabel("Fatalities/Crash")
    ax4.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/dot_annual_trends.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()

    return annual_stats


annual_stats = plot_annual_trends()

# COMMAND ----------


# Day of week and hour heatmap
def plot_temporal_heatmap():
    """Create a heatmap of crash frequency by day of week and hour."""

    temporal = df_prepared.groupby(["day_of_week", "crash_hour"]).size().reset_index(name="crash_count")

    # Filter valid hours
    temporal = temporal[(temporal["crash_hour"] >= 0) & (temporal["crash_hour"] <= 23)]

    pivot = temporal.pivot(index="day_of_week", columns="crash_hour", values="crash_count").fillna(0)

    # Rename index
    dow_labels = {1: "Sun", 2: "Mon", 3: "Tue", 4: "Wed", 5: "Thu", 6: "Fri", 7: "Sat"}
    pivot.index = pivot.index.map(dow_labels)

    plt.figure(figsize=(18, 6))
    sns.heatmap(pivot, cmap="YlOrRd", annot=False, cbar_kws={"label": "Fatal Crashes"})
    plt.title("Fatal Crash Frequency by Day of Week and Hour", fontsize=16, fontweight="bold")
    plt.xlabel("Hour of Day")
    plt.ylabel("Day of Week")
    plt.tight_layout()
    plt.savefig("/tmp/dot_temporal_heatmap.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()


plot_temporal_heatmap()

# COMMAND ----------


# Monthly seasonality
def analyze_seasonality():
    """Analyze monthly crash seasonality patterns."""

    monthly = (
        df_prepared.groupby(["crash_year", "crash_month"])
        .agg({"case_id": "count", "fatality_count": "sum"})
        .rename(columns={"case_id": "crashes", "fatality_count": "fatalities"})
        .reset_index()
    )

    monthly_avg = (
        monthly.groupby("crash_month").agg({"crashes": ["mean", "std"], "fatalities": ["mean", "std"]}).round(1)
    )
    monthly_avg.columns = ["avg_crashes", "std_crashes", "avg_fatalities", "std_fatalities"]
    monthly_avg = monthly_avg.reset_index()

    month_names = {
        1: "Jan",
        2: "Feb",
        3: "Mar",
        4: "Apr",
        5: "May",
        6: "Jun",
        7: "Jul",
        8: "Aug",
        9: "Sep",
        10: "Oct",
        11: "Nov",
        12: "Dec",
    }
    monthly_avg["month_name"] = monthly_avg["crash_month"].map(month_names)

    fig, ax = plt.subplots(figsize=(12, 6))
    x = range(len(monthly_avg))
    bars = ax.bar(
        x, monthly_avg["avg_fatalities"], yerr=monthly_avg["std_fatalities"], capsize=3, color="#e74c3c", alpha=0.8
    )
    ax.set_xticks(x)
    ax.set_xticklabels(monthly_avg["month_name"])
    ax.set_title("Average Monthly Traffic Fatalities (with Std Dev)", fontsize=14, fontweight="bold")
    ax.set_xlabel("Month")
    ax.set_ylabel("Average Fatalities")
    ax.grid(True, alpha=0.3, axis="y")

    # Highlight peak months
    peak_threshold = monthly_avg["avg_fatalities"].quantile(0.75)
    for i, bar in enumerate(bars):
        if monthly_avg.iloc[i]["avg_fatalities"] > peak_threshold:
            bar.set_color("#c0392b")

    plt.tight_layout()
    plt.savefig("/tmp/dot_monthly_seasonality.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()

    return monthly_avg


monthly_stats = analyze_seasonality()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Geographic Analysis

# COMMAND ----------


# State-level crash rates
def analyze_state_performance():
    """Analyze crash fatality rates by state."""

    state_stats = (
        df_prepared.groupby("state_fips")
        .agg(
            {
                "case_id": "count",
                "fatality_count": "sum",
                "drunk_driver_count": lambda x: (x > 0).sum(),
                "pedestrians_involved": lambda x: (x > 0).sum(),
                "total_vehicles": "mean",
            }
        )
        .rename(
            columns={
                "case_id": "total_crashes",
                "fatality_count": "total_fatalities",
                "drunk_driver_count": "dui_crashes",
                "pedestrians_involved": "ped_crashes",
            }
        )
        .reset_index()
    )

    state_stats["dui_rate"] = (state_stats["dui_crashes"] / state_stats["total_crashes"] * 100).round(1)
    state_stats["ped_rate"] = (state_stats["ped_crashes"] / state_stats["total_crashes"] * 100).round(1)

    # Top 15 states by total fatalities
    top_states = state_stats.nlargest(15, "total_fatalities")

    fig, axes = plt.subplots(1, 2, figsize=(16, 8))

    # Total fatalities by state
    ax1 = axes[0]
    bars = ax1.barh(range(len(top_states)), top_states["total_fatalities"].values)
    ax1.set_yticks(range(len(top_states)))
    ax1.set_yticklabels(top_states["state_fips"].values)
    ax1.set_title("Top 15 States by Traffic Fatalities", fontsize=14, fontweight="bold")
    ax1.set_xlabel("Total Fatalities")

    for i, bar in enumerate(bars):
        if i < 3:
            bar.set_color("#c0392b")
        elif i < 8:
            bar.set_color("#e74c3c")
        else:
            bar.set_color("#f39c12")

    ax1.invert_yaxis()
    ax1.grid(True, alpha=0.3, axis="x")

    # DUI rate vs pedestrian rate scatter
    ax2 = axes[1]
    scatter = ax2.scatter(
        state_stats["dui_rate"],
        state_stats["ped_rate"],
        s=state_stats["total_fatalities"] / state_stats["total_fatalities"].max() * 500,
        alpha=0.6,
        c=state_stats["total_fatalities"],
        cmap="YlOrRd",
    )
    ax2.set_title("DUI Rate vs Pedestrian Rate by State", fontsize=14, fontweight="bold")
    ax2.set_xlabel("DUI Crash Rate (%)")
    ax2.set_ylabel("Pedestrian Crash Rate (%)")
    ax2.grid(True, alpha=0.3)
    plt.colorbar(scatter, ax=ax2, label="Total Fatalities")

    plt.tight_layout()
    plt.savefig("/tmp/dot_state_analysis.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()

    return state_stats


state_stats = analyze_state_performance()

# COMMAND ----------


# Rural vs Urban analysis
def analyze_rural_urban():
    """Compare crash characteristics between rural and urban areas."""

    area_stats = (
        df_prepared.groupby("area_type")
        .agg(
            {
                "case_id": "count",
                "fatality_count": ["sum", "mean"],
                "drunk_driver_count": lambda x: (x > 0).sum(),
                "posted_speed_limit": "mean",
                "total_vehicles": "mean",
                "pedestrians_involved": lambda x: (x > 0).sum(),
            }
        )
        .round(2)
    )

    area_stats.columns = [
        "total_crashes",
        "total_fatalities",
        "avg_fatalities",
        "dui_crashes",
        "avg_speed_limit",
        "avg_vehicles",
        "ped_crashes",
    ]
    area_stats = area_stats.reset_index()
    area_stats = area_stats[area_stats["area_type"] != "Unknown"]

    fig, axes = plt.subplots(1, 3, figsize=(16, 5))

    # Crash distribution
    ax1 = axes[0]
    ax1.pie(
        area_stats["total_crashes"],
        labels=area_stats["area_type"],
        autopct="%1.1f%%",
        colors=["#27ae60", "#e74c3c"],
        startangle=90,
    )
    ax1.set_title("Crash Distribution", fontsize=14, fontweight="bold")

    # Fatality comparison
    ax2 = axes[1]
    x = range(len(area_stats))
    ax2.bar(x, area_stats["avg_fatalities"], color=["#27ae60", "#e74c3c"], alpha=0.8)
    ax2.set_xticks(x)
    ax2.set_xticklabels(area_stats["area_type"])
    ax2.set_title("Avg Fatalities per Crash", fontsize=14, fontweight="bold")
    ax2.set_ylabel("Average Fatalities")
    ax2.grid(True, alpha=0.3, axis="y")

    # Speed limit comparison
    ax3 = axes[2]
    ax3.bar(x, area_stats["avg_speed_limit"], color=["#27ae60", "#e74c3c"], alpha=0.8)
    ax3.set_xticks(x)
    ax3.set_xticklabels(area_stats["area_type"])
    ax3.set_title("Avg Posted Speed Limit", fontsize=14, fontweight="bold")
    ax3.set_ylabel("Speed Limit (mph)")
    ax3.grid(True, alpha=0.3, axis="y")

    plt.tight_layout()
    plt.savefig("/tmp/dot_rural_urban.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()

    return area_stats


area_stats = analyze_rural_urban()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Environmental Factor Analysis

# COMMAND ----------


# Weather and lighting conditions
def analyze_environmental_factors():
    """Analyze the impact of weather and lighting on crash severity."""

    # Weather condition analysis
    weather_stats = (
        df_prepared.groupby("weather_desc")
        .agg({"case_id": "count", "fatality_count": ["sum", "mean"], "total_vehicles": "mean"})
        .round(2)
    )
    weather_stats.columns = ["crashes", "fatalities", "avg_fatalities", "avg_vehicles"]
    weather_stats = weather_stats.reset_index()
    weather_stats = weather_stats[weather_stats["weather_desc"] != "Unknown"]
    weather_stats = weather_stats.sort_values("crashes", ascending=False)

    # Light condition analysis
    light_stats = (
        df_prepared.groupby("light_desc").agg({"case_id": "count", "fatality_count": ["sum", "mean"]}).round(2)
    )
    light_stats.columns = ["crashes", "fatalities", "avg_fatalities"]
    light_stats = light_stats.reset_index()
    light_stats = light_stats[light_stats["light_desc"] != "Unknown"]
    light_stats = light_stats.sort_values("crashes", ascending=False)

    fig, axes = plt.subplots(1, 2, figsize=(16, 7))

    # Weather conditions
    ax1 = axes[0]
    top_weather = weather_stats.head(8)
    y_pos = range(len(top_weather))
    bars = ax1.barh(y_pos, top_weather["crashes"])
    ax1.set_yticks(y_pos)
    ax1.set_yticklabels(top_weather["weather_desc"])
    ax1.set_title("Fatal Crashes by Weather Condition", fontsize=14, fontweight="bold")
    ax1.set_xlabel("Number of Crashes")
    ax1.invert_yaxis()
    ax1.grid(True, alpha=0.3, axis="x")

    # Add avg fatalities annotation
    for i, (_idx, row) in enumerate(top_weather.iterrows()):
        ax1.text(
            row["crashes"] + max(top_weather["crashes"]) * 0.01,
            i,
            f"avg: {row['avg_fatalities']:.2f}",
            va="center",
            fontsize=9,
        )

    # Light conditions
    ax2 = axes[1]
    colors_light = {
        "Daylight": "#f1c40f",
        "Dark-Not Lighted": "#2c3e50",
        "Dark-Lighted": "#7f8c8d",
        "Dawn": "#e67e22",
        "Dusk": "#e74c3c",
    }
    bar_colors = [colors_light.get(x, "#95a5a6") for x in light_stats["light_desc"]]
    y_pos2 = range(len(light_stats))
    ax2.barh(y_pos2, light_stats["crashes"], color=bar_colors)
    ax2.set_yticks(y_pos2)
    ax2.set_yticklabels(light_stats["light_desc"])
    ax2.set_title("Fatal Crashes by Light Condition", fontsize=14, fontweight="bold")
    ax2.set_xlabel("Number of Crashes")
    ax2.invert_yaxis()
    ax2.grid(True, alpha=0.3, axis="x")

    plt.tight_layout()
    plt.savefig("/tmp/dot_environmental_factors.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()

    return weather_stats, light_stats


weather_stats, light_stats = analyze_environmental_factors()

# COMMAND ----------


# Speed limit and collision type analysis
def analyze_crash_characteristics():
    """Analyze crash characteristics: speed limits and collision types."""

    # Speed category distribution
    speed_stats = (
        df_prepared.groupby("speed_category").agg({"case_id": "count", "fatality_count": ["sum", "mean"]}).round(2)
    )
    speed_stats.columns = ["crashes", "fatalities", "avg_fatalities"]
    speed_stats = speed_stats.reset_index()
    speed_stats = speed_stats[speed_stats["speed_category"] != "Unknown"]

    # Collision type distribution
    collision_stats = (
        df_prepared.groupby("collision_type").agg({"case_id": "count", "fatality_count": ["sum", "mean"]}).round(2)
    )
    collision_stats.columns = ["crashes", "fatalities", "avg_fatalities"]
    collision_stats = collision_stats.reset_index()
    collision_stats = collision_stats.sort_values("crashes", ascending=False)

    fig, axes = plt.subplots(1, 2, figsize=(16, 7))

    # Speed category
    ax1 = axes[0]
    speed_order = [
        "Low (≤30 mph)",
        "Medium (31-45 mph)",
        "Moderate (46-55 mph)",
        "High (56-65 mph)",
        "Very High (>65 mph)",
    ]
    speed_sorted = speed_stats.set_index("speed_category").reindex(speed_order).dropna().reset_index()
    colors_speed = ["#27ae60", "#2ecc71", "#f1c40f", "#e67e22", "#e74c3c"]
    ax1.bar(range(len(speed_sorted)), speed_sorted["crashes"], color=colors_speed[: len(speed_sorted)], alpha=0.8)
    ax1.set_xticks(range(len(speed_sorted)))
    ax1.set_xticklabels(speed_sorted["speed_category"], rotation=30, ha="right")
    ax1.set_title("Fatal Crashes by Speed Limit Zone", fontsize=14, fontweight="bold")
    ax1.set_ylabel("Number of Crashes")
    ax1.grid(True, alpha=0.3, axis="y")

    # Add severity labels
    ax1_twin = ax1.twinx()
    ax1_twin.plot(
        range(len(speed_sorted)),
        speed_sorted["avg_fatalities"],
        marker="D",
        color="darkred",
        linewidth=2,
        markersize=8,
        label="Avg Fatalities",
    )
    ax1_twin.set_ylabel("Avg Fatalities per Crash", color="darkred")
    ax1_twin.legend(loc="upper left")

    # Collision type
    ax2 = axes[1]
    top_collisions = collision_stats.head(7)
    ax2.barh(range(len(top_collisions)), top_collisions["crashes"], color="#3498db", alpha=0.8)
    ax2.set_yticks(range(len(top_collisions)))
    ax2.set_yticklabels(top_collisions["collision_type"])
    ax2.set_title("Fatal Crashes by Collision Type", fontsize=14, fontweight="bold")
    ax2.set_xlabel("Number of Crashes")
    ax2.invert_yaxis()
    ax2.grid(True, alpha=0.3, axis="x")

    plt.tight_layout()
    plt.savefig("/tmp/dot_crash_characteristics.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()

    return speed_stats, collision_stats


speed_stats, collision_stats = analyze_crash_characteristics()

# COMMAND ----------

# MAGIC %md
# MAGIC ## DUI and Pedestrian Deep Dive

# COMMAND ----------


# DUI crash analysis
def analyze_dui_patterns():
    """Deep dive into DUI-related fatal crashes."""

    df_dui = df_prepared.copy()
    df_dui["is_dui"] = df_dui["drunk_driver_count"] > 0

    # DUI by time of day
    dui_time = df_dui.groupby(["time_of_day", "is_dui"]).size().unstack(fill_value=0)
    dui_time["dui_rate"] = (dui_time[True] / (dui_time[True] + dui_time[False]) * 100).round(1)

    # DUI by day of week
    dui_dow = df_dui.groupby(["day_name", "is_dui"]).size().unstack(fill_value=0)
    dui_dow["dui_rate"] = (dui_dow[True] / (dui_dow[True] + dui_dow[False]) * 100).round(1)
    dow_order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    dui_dow = dui_dow.reindex(dow_order)

    fig, axes = plt.subplots(1, 2, figsize=(16, 6))

    # DUI rate by time of day
    ax1 = axes[0]
    time_order = ["Morning Rush", "Midday", "Evening Rush", "Night", "Late Night"]
    dui_time_sorted = dui_time.reindex(time_order).dropna()
    bars = ax1.bar(
        range(len(dui_time_sorted)),
        dui_time_sorted["dui_rate"],
        color=["#f39c12" if r > 30 else "#3498db" for r in dui_time_sorted["dui_rate"]],
        alpha=0.8,
    )
    ax1.set_xticks(range(len(dui_time_sorted)))
    ax1.set_xticklabels(dui_time_sorted.index, rotation=30, ha="right")
    ax1.set_title("DUI Rate by Time of Day", fontsize=14, fontweight="bold")
    ax1.set_ylabel("DUI Rate (%)")
    ax1.grid(True, alpha=0.3, axis="y")
    ax1.axhline(y=dui_time_sorted["dui_rate"].mean(), color="red", linestyle="--", alpha=0.5)

    # DUI rate by day of week
    ax2 = axes[1]
    bars2 = ax2.bar(
        range(len(dui_dow)),
        dui_dow["dui_rate"],
        color=["#e74c3c" if d in ("Friday", "Saturday", "Sunday") else "#3498db" for d in dui_dow.index],
        alpha=0.8,
    )
    ax2.set_xticks(range(len(dui_dow)))
    ax2.set_xticklabels([d[:3] for d in dui_dow.index])
    ax2.set_title("DUI Rate by Day of Week", fontsize=14, fontweight="bold")
    ax2.set_ylabel("DUI Rate (%)")
    ax2.grid(True, alpha=0.3, axis="y")
    ax2.axhline(y=dui_dow["dui_rate"].mean(), color="red", linestyle="--", alpha=0.5)

    plt.tight_layout()
    plt.savefig("/tmp/dot_dui_analysis.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()


analyze_dui_patterns()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Statistical Tests and Correlations

# COMMAND ----------


# Chi-square tests for categorical associations
def perform_statistical_tests():
    """Perform chi-square tests for crash factor associations."""

    results = {}

    # Test 1: Weekend vs DUI
    ct1 = pd.crosstab(df_prepared["is_weekend"], df_prepared["drunk_driver_count"] > 0)
    chi2, p_val, dof, expected = chi2_contingency(ct1)
    results["Weekend vs DUI"] = {"chi2": chi2, "p_value": p_val, "dof": dof}

    # Test 2: Area type vs Severity class
    ct2 = pd.crosstab(df_prepared["area_type"], df_prepared["severity_class"])
    chi2, p_val, dof, expected = chi2_contingency(ct2)
    results["Area vs Severity"] = {"chi2": chi2, "p_value": p_val, "dof": dof}

    # Test 3: Light condition vs Pedestrian involvement
    ct3 = pd.crosstab(df_prepared["light_desc"], df_prepared["pedestrians_involved"] > 0)
    chi2, p_val, dof, expected = chi2_contingency(ct3)
    results["Light vs Pedestrian"] = {"chi2": chi2, "p_value": p_val, "dof": dof}

    # Correlation: Speed limit vs Fatality count
    valid_speed = df_prepared[(df_prepared["posted_speed_limit"] > 0) & (df_prepared["posted_speed_limit"] < 100)]
    r, p = pearsonr(valid_speed["posted_speed_limit"], valid_speed["fatality_count"])
    results["Speed-Fatality Correlation"] = {"r": r, "p_value": p}

    print("\n" + "=" * 60)
    print("STATISTICAL TEST RESULTS")
    print("=" * 60)
    for test_name, result in results.items():
        print(f"\n{test_name}:")
        for k, v in result.items():
            if isinstance(v, float):
                print(
                    f"  {k}: {v:.4f}"
                    + (
                        " ***"
                        if k == "p_value" and v < 0.001
                        else " **"
                        if k == "p_value" and v < 0.01
                        else " *"
                        if k == "p_value" and v < 0.05
                        else ""
                    )
                )
            else:
                print(f"  {k}: {v}")

    return results


stat_results = perform_statistical_tests()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results to Delta Lake

# COMMAND ----------


# Save analytical results to gold layer
def save_results_to_delta():
    """Save crash severity analysis results to Delta Lake gold layer."""

    # Save state-level statistics
    state_spark = spark.createDataFrame(state_stats)
    state_spark = state_spark.withColumn("analysis_date", current_date())
    (state_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_crash_severity_by_state"))

    # Save monthly statistics
    monthly_spark = spark.createDataFrame(monthly_stats)
    monthly_spark = monthly_spark.withColumn("analysis_date", current_date())
    (monthly_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_crash_monthly_patterns"))

    print("Results saved to gold layer:")
    print("  - gold.gld_crash_severity_by_state")
    print("  - gold.gld_crash_monthly_patterns")


save_results_to_delta()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary Report

# COMMAND ----------

print("=" * 60)
print("CRASH SEVERITY ANALYSIS - SUMMARY REPORT")
print("=" * 60)

print("\nDataset Overview:")
print(f"  Total records analyzed: {len(df_prepared):,}")
print(f"  States covered: {df_prepared['state_fips'].nunique()}")
print(f"  Year range: {df_prepared['crash_year'].min()}-{df_prepared['crash_year'].max()}")
print(f"  Total fatalities: {df_prepared['fatality_count'].sum():,}")

print("\nKey Findings:")
total = len(df_prepared)
dui_pct = (df_prepared["drunk_driver_count"] > 0).sum() / total * 100
ped_pct = (df_prepared["pedestrians_involved"] > 0).sum() / total * 100
night_pct = df_prepared[df_prepared["light_desc"].isin(["Dark-Not Lighted", "Dark-Lighted"])].shape[0] / total * 100
rural_pct = (df_prepared["area_type"] == "Rural").sum() / total * 100

print(f"  DUI-related crashes: {dui_pct:.1f}%")
print(f"  Pedestrian-involved: {ped_pct:.1f}%")
print(f"  Nighttime crashes: {night_pct:.1f}%")
print(f"  Rural area crashes: {rural_pct:.1f}%")

print("\nRecommendations:")
print("  1. Increase nighttime enforcement during weekend hours")
print("  2. Prioritize pedestrian infrastructure in urban areas")
print("  3. Target high-speed rural corridors for safety improvements")
print("  4. Deploy DUI checkpoints during peak risk periods (Fri-Sun, 10pm-3am)")

print("\nOutputs:")
print("  - Analysis tables saved to gold layer")
print("  - Visualizations saved to /tmp/dot_*.png")

print("=" * 60)
