# Databricks notebook source
# MAGIC %md
# MAGIC # USPS Delivery Performance Optimization Analysis
# MAGIC
# MAGIC This notebook provides comprehensive analytics for USPS delivery operations, including:
# MAGIC - On-time delivery rate analysis by product class, region, and time period
# MAGIC - Facility throughput and capacity utilization patterns
# MAGIC - Route efficiency and carrier workload analysis
# MAGIC - Mail volume trends and seasonal decomposition
# MAGIC - Service standard compliance monitoring
# MAGIC
# MAGIC **Data Sources:**
# MAGIC - USPS delivery performance tracking data (silver layer)
# MAGIC - USPS facility operations data (silver layer)
# MAGIC - USPS mail volume data (silver layer)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup and Configuration

# COMMAND ----------

# Import required libraries
import warnings

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns

warnings.filterwarnings("ignore")

# Statistical libraries
# Spark and Delta libraries
from pyspark.sql.functions import *
from pyspark.sql.types import *
from scipy.stats import chi2_contingency, mannwhitneyu
from statsmodels.tsa.seasonal import seasonal_decompose

# Configuration
plt.style.use("seaborn-v0_8")
sns.set_palette("husl")
FIGURE_DPI = 300

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading and Preparation

# COMMAND ----------


# Load delivery performance data
def load_delivery_data():
    """Load delivery tracking data from silver layer."""

    delivery_df = spark.table("silver.slv_delivery_performance").toPandas()

    delivery_df = delivery_df[
        (delivery_df["tracking_id"].notna())
        & (delivery_df["delivery_status"].notna())
        & (delivery_df["is_valid_record"] == True)
    ].copy()

    print(f"Loaded {len(delivery_df):,} delivery records")
    print(f"Product classes: {', '.join(delivery_df['product_class'].unique())}")
    print("Status distribution:")
    print(delivery_df["delivery_status"].value_counts().to_string())

    return delivery_df


df_delivery = load_delivery_data()

# COMMAND ----------


# Load facility operations data
def load_facility_data():
    """Load facility operations data from silver layer."""

    facility_df = spark.table("silver.slv_facility_operations").toPandas()

    facility_df = facility_df[
        (facility_df["facility_id"].notna())
        & (facility_df["report_date"].notna())
        & (facility_df["is_valid_record"] == True)
    ].copy()

    print(f"Loaded {len(facility_df):,} facility records")
    print(f"Facilities: {facility_df['facility_id'].nunique()}")
    print(f"Facility types: {', '.join(facility_df['facility_type'].unique())}")

    return facility_df


df_facility = load_facility_data()

# COMMAND ----------


# Load mail volume data
def load_volume_data():
    """Load mail volume data from silver layer."""

    volume_df = spark.table("silver.slv_mail_volume").toPandas()

    volume_df = volume_df[
        (volume_df["facility_id"].notna()) & (volume_df["volume_date"].notna()) & (volume_df["is_valid_record"] == True)
    ].copy()

    print(f"Loaded {len(volume_df):,} volume records")
    print(f"Product classes: {', '.join(volume_df['product_class'].unique())}")

    return volume_df


df_volume = load_volume_data()

# COMMAND ----------


# Prepare delivery data
def prepare_delivery_data(df):
    """Enrich delivery tracking data for analysis."""

    df_clean = df.copy()

    # Parse dates
    df_clean["acceptance_date"] = pd.to_datetime(df_clean["acceptance_date"], errors="coerce")
    df_clean["actual_delivery_date"] = pd.to_datetime(df_clean["actual_delivery_date"], errors="coerce")
    df_clean["expected_delivery_date"] = pd.to_datetime(df_clean["expected_delivery_date"], errors="coerce")

    # On-time flag
    df_clean["is_on_time"] = (df_clean["actual_delivery_date"] <= df_clean["expected_delivery_date"]).astype(int)

    # Late days
    df_clean["days_late"] = (df_clean["actual_delivery_date"] - df_clean["expected_delivery_date"]).dt.days.clip(
        lower=0
    )

    # Delivery speed category
    def speed_category(days):
        if pd.isna(days):
            return "Unknown"
        if days <= 1:
            return "Same/Next Day"
        if days <= 3:
            return "2-3 Days"
        if days <= 5:
            return "4-5 Days"
        if days <= 7:
            return "6-7 Days"
        return "8+ Days"

    df_clean["speed_category"] = df_clean["delivery_time_days"].apply(speed_category)

    # Acceptance day of week
    df_clean["acceptance_dow"] = df_clean["acceptance_date"].dt.day_name()
    df_clean["acceptance_month"] = df_clean["acceptance_date"].dt.month

    # Route type classification
    df_clean["is_interstate"] = (df_clean["origin_state"] != df_clean["destination_state"]).astype(int)

    # Distance proxy using ZIP prefix
    df_clean["origin_region"] = df_clean["origin_zip"].astype(str).str[:1]
    df_clean["dest_region"] = df_clean["destination_zip"].astype(str).str[:1]
    df_clean["is_cross_region"] = (df_clean["origin_region"] != df_clean["dest_region"]).astype(int)

    delivered = df_clean[df_clean["delivery_status"] == "DELIVERED"]
    on_time_rate = delivered["is_on_time"].mean() * 100 if len(delivered) > 0 else 0

    print(f"Data prepared: {len(df_clean):,} records")
    print(f"Delivered: {len(delivered):,}  On-time rate: {on_time_rate:.1f}%")

    return df_clean


df_prepared = prepare_delivery_data(df_delivery)

# COMMAND ----------

# MAGIC %md
# MAGIC ## On-Time Delivery Analysis

# COMMAND ----------


# On-time rate by product class
def analyze_on_time_by_product():
    """Analyze on-time delivery rates by product class."""

    delivered = df_prepared[df_prepared["delivery_status"] == "DELIVERED"]

    product_stats = (
        delivered.groupby("product_class")
        .agg(
            total_deliveries=("tracking_id", "count"),
            on_time_count=("is_on_time", "sum"),
            avg_delivery_days=("delivery_time_days", "mean"),
            median_delivery_days=("delivery_time_days", "median"),
            avg_days_late=("days_late", "mean"),
            avg_attempts=("delivery_attempt_count", "mean"),
        )
        .round(2)
        .reset_index()
    )

    product_stats["on_time_rate"] = (product_stats["on_time_count"] / product_stats["total_deliveries"] * 100).round(1)

    fig, axes = plt.subplots(1, 3, figsize=(18, 6))

    # On-time rate by product
    ax1 = axes[0]
    colors = ["#27ae60" if r >= 90 else "#f39c12" if r >= 80 else "#e74c3c" for r in product_stats["on_time_rate"]]
    bars = ax1.bar(range(len(product_stats)), product_stats["on_time_rate"], color=colors, alpha=0.85)
    ax1.set_xticks(range(len(product_stats)))
    ax1.set_xticklabels(product_stats["product_class"], rotation=30, ha="right")
    ax1.set_title("On-Time Delivery Rate by Product Class", fontsize=13, fontweight="bold")
    ax1.set_ylabel("On-Time Rate (%)")
    ax1.axhline(y=90, color="green", linestyle="--", alpha=0.5, label="90% Target")
    ax1.legend()
    ax1.grid(True, alpha=0.3, axis="y")

    # Average delivery time
    ax2 = axes[1]
    ax2.bar(range(len(product_stats)), product_stats["avg_delivery_days"], color="#3498db", alpha=0.85)
    ax2.set_xticks(range(len(product_stats)))
    ax2.set_xticklabels(product_stats["product_class"], rotation=30, ha="right")
    ax2.set_title("Average Delivery Time by Product Class", fontsize=13, fontweight="bold")
    ax2.set_ylabel("Days")
    ax2.grid(True, alpha=0.3, axis="y")

    # Average days late (for late deliveries)
    ax3 = axes[2]
    ax3.bar(range(len(product_stats)), product_stats["avg_days_late"], color="#e74c3c", alpha=0.85)
    ax3.set_xticks(range(len(product_stats)))
    ax3.set_xticklabels(product_stats["product_class"], rotation=30, ha="right")
    ax3.set_title("Average Days Late (Late Deliveries)", fontsize=13, fontweight="bold")
    ax3.set_ylabel("Days Late")
    ax3.grid(True, alpha=0.3, axis="y")

    plt.tight_layout()
    plt.savefig("/tmp/usps_on_time_by_product.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()

    return product_stats


product_stats = analyze_on_time_by_product()

# COMMAND ----------


# On-time rate by region and state
def analyze_on_time_by_geography():
    """Analyze on-time rates by destination state and region."""

    delivered = df_prepared[df_prepared["delivery_status"] == "DELIVERED"]

    state_stats = (
        delivered.groupby("destination_state")
        .agg(total=("tracking_id", "count"), on_time=("is_on_time", "sum"), avg_days=("delivery_time_days", "mean"))
        .reset_index()
    )
    state_stats["on_time_rate"] = (state_stats["on_time"] / state_stats["total"] * 100).round(1)
    state_stats = state_stats[state_stats["total"] >= 5]  # Min sample size

    # Sort by on-time rate
    state_stats = state_stats.sort_values("on_time_rate", ascending=False)

    fig, axes = plt.subplots(1, 2, figsize=(16, 7))

    # Top and bottom states
    ax1 = axes[0]
    top_bottom = pd.concat([state_stats.head(8), state_stats.tail(8)])
    colors = ["#27ae60" if r >= 90 else "#f39c12" if r >= 80 else "#e74c3c" for r in top_bottom["on_time_rate"]]
    ax1.barh(range(len(top_bottom)), top_bottom["on_time_rate"], color=colors, alpha=0.85)
    ax1.set_yticks(range(len(top_bottom)))
    ax1.set_yticklabels(top_bottom["destination_state"])
    ax1.set_title("On-Time Rate by Destination State", fontsize=13, fontweight="bold")
    ax1.set_xlabel("On-Time Rate (%)")
    ax1.axvline(x=90, color="green", linestyle="--", alpha=0.5)
    ax1.invert_yaxis()
    ax1.grid(True, alpha=0.3, axis="x")

    # Interstate vs intrastate
    ax2 = axes[1]
    interstate_stats = (
        delivered.groupby("is_interstate")
        .agg(
            on_time_rate=("is_on_time", "mean"), avg_days=("delivery_time_days", "mean"), count=("tracking_id", "count")
        )
        .round(3)
        .reset_index()
    )
    interstate_stats["label"] = interstate_stats["is_interstate"].map({0: "Intrastate", 1: "Interstate"})

    x = range(len(interstate_stats))
    bars = ax2.bar(x, interstate_stats["on_time_rate"] * 100, color=["#3498db", "#e67e22"], alpha=0.85)
    ax2.set_xticks(x)
    ax2.set_xticklabels(interstate_stats["label"])
    ax2.set_title("On-Time Rate: Interstate vs Intrastate", fontsize=13, fontweight="bold")
    ax2.set_ylabel("On-Time Rate (%)")
    ax2.axhline(y=90, color="green", linestyle="--", alpha=0.5, label="90% Target")
    ax2.legend()
    ax2.grid(True, alpha=0.3, axis="y")

    # Add value labels
    for bar, val in zip(bars, interstate_stats["on_time_rate"] * 100):
        ax2.text(
            bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.5, f"{val:.1f}%", ha="center", fontweight="bold"
        )

    plt.tight_layout()
    plt.savefig("/tmp/usps_on_time_geography.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()

    return state_stats


state_delivery_stats = analyze_on_time_by_geography()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Facility Operations Analysis

# COMMAND ----------


# Facility throughput and utilization
def analyze_facility_utilization():
    """Analyze facility throughput and capacity utilization."""

    fac = df_facility.copy()
    fac["utilization_pct"] = (fac["actual_throughput_daily"] / fac["max_throughput_daily"] * 100).clip(0, 150)
    fac["report_date"] = pd.to_datetime(fac["report_date"], errors="coerce")
    fac["report_dow"] = fac["report_date"].dt.day_name()

    # Utilization by facility type
    type_stats = (
        fac.groupby("facility_type")
        .agg(
            avg_utilization=("utilization_pct", "mean"),
            avg_throughput=("actual_throughput_daily", "mean"),
            total_employees=("total_employees", "mean"),
            avg_overtime=("overtime_hours", "mean"),
        )
        .round(1)
        .reset_index()
    )

    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Utilization by facility type
    ax1 = axes[0, 0]
    colors = ["#27ae60" if u < 70 else "#f39c12" if u < 85 else "#e74c3c" for u in type_stats["avg_utilization"]]
    ax1.bar(range(len(type_stats)), type_stats["avg_utilization"], color=colors, alpha=0.85)
    ax1.set_xticks(range(len(type_stats)))
    ax1.set_xticklabels(type_stats["facility_type"], rotation=30, ha="right")
    ax1.set_title("Average Utilization by Facility Type", fontsize=13, fontweight="bold")
    ax1.set_ylabel("Utilization (%)")
    ax1.axhline(y=85, color="red", linestyle="--", alpha=0.5, label="85% Threshold")
    ax1.legend()
    ax1.grid(True, alpha=0.3, axis="y")

    # Throughput over time
    ax2 = axes[0, 1]
    for ftype in fac["facility_type"].unique():
        subset = fac[fac["facility_type"] == ftype]
        daily_avg = subset.groupby("report_date")["actual_throughput_daily"].mean()
        ax2.plot(daily_avg.index, daily_avg.values, label=ftype, linewidth=1.5, alpha=0.8)
    ax2.set_title("Daily Throughput Trend by Facility Type", fontsize=13, fontweight="bold")
    ax2.set_xlabel("Date")
    ax2.set_ylabel("Avg Daily Throughput")
    ax2.legend(fontsize=8)
    ax2.grid(True, alpha=0.3)

    # Equipment utilization (sorting machines)
    ax3 = axes[1, 0]
    fac["machine_utilization"] = (fac["sorting_machines_active"] / fac["sorting_machines"] * 100).clip(0, 100)
    machine_by_type = fac.groupby("facility_type")["machine_utilization"].mean().round(1)
    ax3.bar(range(len(machine_by_type)), machine_by_type.values, color="#3498db", alpha=0.85)
    ax3.set_xticks(range(len(machine_by_type)))
    ax3.set_xticklabels(machine_by_type.index, rotation=30, ha="right")
    ax3.set_title("Sorting Machine Utilization", fontsize=13, fontweight="bold")
    ax3.set_ylabel("Active Machine Rate (%)")
    ax3.grid(True, alpha=0.3, axis="y")

    # Overtime hours distribution
    ax4 = axes[1, 1]
    for ftype in fac["facility_type"].unique():
        subset = fac[fac["facility_type"] == ftype]["overtime_hours"].dropna()
        ax4.hist(subset, bins=20, alpha=0.5, label=ftype, density=True)
    ax4.set_title("Overtime Hours Distribution", fontsize=13, fontweight="bold")
    ax4.set_xlabel("Overtime Hours")
    ax4.set_ylabel("Density")
    ax4.legend(fontsize=8)
    ax4.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/usps_facility_utilization.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()

    return type_stats


facility_stats = analyze_facility_utilization()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Mail Volume Analysis

# COMMAND ----------


# Volume trends and seasonal decomposition
def analyze_volume_trends():
    """Analyze mail volume trends and seasonal patterns."""

    vol = df_volume.copy()
    vol["volume_date"] = pd.to_datetime(vol["volume_date"], errors="coerce")

    # Daily total by product class
    daily_vol = vol.groupby(["volume_date", "product_class"])["total_pieces"].sum().reset_index()

    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Volume by product class over time
    ax1 = axes[0, 0]
    for pc in daily_vol["product_class"].unique():
        subset = daily_vol[daily_vol["product_class"] == pc].sort_values("volume_date")
        ax1.plot(subset["volume_date"], subset["total_pieces"], label=pc, linewidth=1.5)
    ax1.set_title("Daily Mail Volume by Product Class", fontsize=13, fontweight="bold")
    ax1.set_xlabel("Date")
    ax1.set_ylabel("Total Pieces")
    ax1.legend(fontsize=8)
    ax1.grid(True, alpha=0.3)

    # Product class share
    ax2 = axes[0, 1]
    pc_totals = vol.groupby("product_class")["total_pieces"].sum().sort_values(ascending=False)
    ax2.pie(pc_totals, labels=pc_totals.index, autopct="%1.1f%%", startangle=90)
    ax2.set_title("Mail Volume Share by Product Class", fontsize=13, fontweight="bold")

    # Inbound vs Outbound
    ax3 = axes[1, 0]
    io_totals = vol.groupby("product_class")[["inbound_pieces", "outbound_pieces"]].sum()
    io_totals.plot(kind="bar", ax=ax3, alpha=0.85)
    ax3.set_title("Inbound vs Outbound by Product Class", fontsize=13, fontweight="bold")
    ax3.set_xlabel("Product Class")
    ax3.set_ylabel("Total Pieces")
    ax3.tick_params(axis="x", rotation=30)
    ax3.legend(["Inbound", "Outbound"])
    ax3.grid(True, alpha=0.3, axis="y")

    # Revenue by product class
    ax4 = axes[1, 1]
    rev_totals = vol.groupby("product_class")["postage_revenue"].sum().sort_values(ascending=False)
    ax4.bar(range(len(rev_totals)), rev_totals.values, color="#27ae60", alpha=0.85)
    ax4.set_xticks(range(len(rev_totals)))
    ax4.set_xticklabels(rev_totals.index, rotation=30, ha="right")
    ax4.set_title("Total Postage Revenue by Product Class", fontsize=13, fontweight="bold")
    ax4.set_ylabel("Revenue ($)")
    ax4.grid(True, alpha=0.3, axis="y")

    plt.tight_layout()
    plt.savefig("/tmp/usps_volume_trends.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()

    return daily_vol


daily_volume = analyze_volume_trends()

# COMMAND ----------


# Seasonal decomposition for dominant product class
def perform_seasonal_decomposition():
    """Decompose time series for seasonal pattern identification."""

    vol = df_volume.copy()
    vol["volume_date"] = pd.to_datetime(vol["volume_date"], errors="coerce")

    # Aggregate total volume per day
    daily_total = vol.groupby("volume_date")["total_pieces"].sum().sort_index()

    if len(daily_total) < 14:
        print("Insufficient data points for seasonal decomposition")
        return None

    # Fill missing days
    full_range = pd.date_range(daily_total.index.min(), daily_total.index.max(), freq="D")
    daily_total = daily_total.reindex(full_range).fillna(method="ffill")

    # Decompose (period=7 for weekly)
    period = min(7, len(daily_total) // 3)
    if period < 2:
        print("Period too short for decomposition")
        return None

    result = seasonal_decompose(daily_total, model="additive", period=period)

    fig, axes = plt.subplots(4, 1, figsize=(16, 12), sharex=True)

    result.observed.plot(ax=axes[0], title="Observed", linewidth=1)
    axes[0].set_ylabel("Pieces")
    axes[0].grid(True, alpha=0.3)

    result.trend.plot(ax=axes[1], title="Trend", linewidth=1, color="red")
    axes[1].set_ylabel("Pieces")
    axes[1].grid(True, alpha=0.3)

    result.seasonal.plot(ax=axes[2], title="Seasonal (Weekly)", linewidth=1, color="green")
    axes[2].set_ylabel("Pieces")
    axes[2].grid(True, alpha=0.3)

    result.resid.plot(ax=axes[3], title="Residual", linewidth=1, color="purple")
    axes[3].set_ylabel("Pieces")
    axes[3].grid(True, alpha=0.3)

    plt.suptitle("Mail Volume Seasonal Decomposition", fontsize=16, fontweight="bold", y=1.01)
    plt.tight_layout()
    plt.savefig("/tmp/usps_seasonal_decomposition.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()

    return result


decomp_result = perform_seasonal_decomposition()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Service Standard Compliance

# COMMAND ----------


# Service standard analysis
def analyze_service_compliance():
    """Analyze compliance with USPS service standards."""

    delivered = df_prepared[df_prepared["delivery_status"] == "DELIVERED"].copy()

    # Calculate service standard compliance
    delivered["meets_standard"] = (delivered["delivery_time_days"] <= delivered["service_standard_days"]).astype(int)

    compliance_by_product = (
        delivered.groupby("product_class")
        .agg(
            total=("tracking_id", "count"),
            compliant=("meets_standard", "sum"),
            avg_delivery_days=("delivery_time_days", "mean"),
            avg_service_standard=("service_standard_days", "mean"),
            pct_1_day_late=("days_late", lambda x: (x == 1).sum()),
            pct_2plus_late=("days_late", lambda x: (x >= 2).sum()),
        )
        .round(2)
        .reset_index()
    )

    compliance_by_product["compliance_rate"] = (
        compliance_by_product["compliant"] / compliance_by_product["total"] * 100
    ).round(1)

    fig, axes = plt.subplots(1, 2, figsize=(14, 6))

    # Compliance vs target
    ax1 = axes[0]
    x = range(len(compliance_by_product))
    ax1.bar(x, compliance_by_product["compliance_rate"], color="#3498db", alpha=0.85)
    ax1.axhline(y=95, color="green", linestyle="--", alpha=0.7, label="95% Target")
    ax1.axhline(y=90, color="orange", linestyle="--", alpha=0.7, label="90% Minimum")
    ax1.set_xticks(x)
    ax1.set_xticklabels(compliance_by_product["product_class"], rotation=30, ha="right")
    ax1.set_title("Service Standard Compliance Rate", fontsize=13, fontweight="bold")
    ax1.set_ylabel("Compliance (%)")
    ax1.legend()
    ax1.grid(True, alpha=0.3, axis="y")

    # Actual vs standard delivery time
    ax2 = axes[1]
    width = 0.35
    ax2.bar(
        [i - width / 2 for i in x],
        compliance_by_product["avg_service_standard"],
        width,
        label="Service Standard",
        color="#27ae60",
        alpha=0.85,
    )
    ax2.bar(
        [i + width / 2 for i in x],
        compliance_by_product["avg_delivery_days"],
        width,
        label="Actual Avg",
        color="#e74c3c",
        alpha=0.85,
    )
    ax2.set_xticks(x)
    ax2.set_xticklabels(compliance_by_product["product_class"], rotation=30, ha="right")
    ax2.set_title("Service Standard vs Actual Delivery Time", fontsize=13, fontweight="bold")
    ax2.set_ylabel("Days")
    ax2.legend()
    ax2.grid(True, alpha=0.3, axis="y")

    plt.tight_layout()
    plt.savefig("/tmp/usps_service_compliance.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()

    return compliance_by_product


compliance_stats = analyze_service_compliance()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Statistical Tests

# COMMAND ----------


# Statistical tests for delivery performance
def perform_statistical_tests():
    """Perform statistical tests on delivery performance factors."""

    delivered = df_prepared[df_prepared["delivery_status"] == "DELIVERED"]
    results = {}

    # Test 1: Interstate vs intrastate on-time rates
    interstate = delivered[delivered["is_interstate"] == 1]["is_on_time"]
    intrastate = delivered[delivered["is_interstate"] == 0]["is_on_time"]
    if len(interstate) > 0 and len(intrastate) > 0:
        stat, p = mannwhitneyu(interstate, intrastate, alternative="two-sided")
        results["Interstate vs Intrastate"] = {"U-statistic": stat, "p_value": p}

    # Test 2: Weekend acceptance effect on delivery time
    weekend = delivered[delivered["acceptance_dow"].isin(["Saturday", "Sunday"])]["delivery_time_days"]
    weekday = delivered[~delivered["acceptance_dow"].isin(["Saturday", "Sunday"])]["delivery_time_days"]
    if len(weekend) > 0 and len(weekday) > 0:
        stat, p = mannwhitneyu(weekend, weekday, alternative="two-sided")
        results["Weekend vs Weekday Acceptance"] = {"U-statistic": stat, "p_value": p}

    # Test 3: Product class independence from on-time delivery
    ct = pd.crosstab(delivered["product_class"], delivered["is_on_time"])
    if ct.shape[0] > 1 and ct.shape[1] > 1:
        chi2, p, dof, expected = chi2_contingency(ct)
        results["Product Class vs On-Time"] = {"chi2": chi2, "p_value": p, "dof": dof}

    print("\n" + "=" * 60)
    print("STATISTICAL TEST RESULTS")
    print("=" * 60)
    for test_name, result in results.items():
        print(f"\n{test_name}:")
        for k, v in result.items():
            if isinstance(v, float):
                sig = (
                    " ***"
                    if k == "p_value" and v < 0.001
                    else " **"
                    if k == "p_value" and v < 0.01
                    else " *"
                    if k == "p_value" and v < 0.05
                    else ""
                )
                print(f"  {k}: {v:.4f}{sig}")
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
    """Save delivery optimization analysis results to Delta Lake gold layer."""

    # Save product-level delivery stats
    product_spark = spark.createDataFrame(product_stats)
    product_spark = product_spark.withColumn("analysis_date", current_date())
    (
        product_spark.write.mode("overwrite")
        .option("mergeSchema", "true")
        .saveAsTable("gold.gld_delivery_product_performance")
    )

    # Save facility utilization stats
    fac_spark = spark.createDataFrame(facility_stats)
    fac_spark = fac_spark.withColumn("analysis_date", current_date())
    (
        fac_spark.write.mode("overwrite")
        .option("mergeSchema", "true")
        .saveAsTable("gold.gld_facility_utilization_summary")
    )

    # Save compliance stats
    comp_spark = spark.createDataFrame(compliance_stats)
    comp_spark = comp_spark.withColumn("analysis_date", current_date())
    (
        comp_spark.write.mode("overwrite")
        .option("mergeSchema", "true")
        .saveAsTable("gold.gld_service_standard_compliance")
    )

    print("Results saved to gold layer:")
    print("  - gold.gld_delivery_product_performance")
    print("  - gold.gld_facility_utilization_summary")
    print("  - gold.gld_service_standard_compliance")


save_results_to_delta()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary Report

# COMMAND ----------

print("=" * 60)
print("USPS DELIVERY OPTIMIZATION - SUMMARY REPORT")
print("=" * 60)

delivered = df_prepared[df_prepared["delivery_status"] == "DELIVERED"]
total = len(delivered)

print("\nDataset Overview:")
print(f"  Total delivery records: {len(df_prepared):,}")
print(f"  Delivered: {total:,}")
print(f"  Product classes: {df_prepared['product_class'].nunique()}")
print(f"  States covered: {df_prepared['destination_state'].nunique()}")

if total > 0:
    on_time_pct = delivered["is_on_time"].mean() * 100
    avg_days = delivered["delivery_time_days"].mean()
    interstate_pct = delivered["is_interstate"].mean() * 100

    print("\nDelivery Performance:")
    print(f"  Overall on-time rate: {on_time_pct:.1f}%")
    print(f"  Average delivery time: {avg_days:.1f} days")
    print(f"  Interstate deliveries: {interstate_pct:.1f}%")

print("\nFacility Operations:")
print(f"  Facilities monitored: {df_facility['facility_id'].nunique()}")
print(f"  Avg daily throughput: {df_facility['actual_throughput_daily'].mean():,.0f} pieces")

print("\nMail Volume:")
print(f"  Total volume records: {len(df_volume):,}")
print(f"  Total pieces tracked: {df_volume['total_pieces'].sum():,.0f}")

print("\nRecommendations:")
print("  1. Focus improvement efforts on underperforming product classes")
print("  2. Monitor high-utilization facilities for capacity expansion needs")
print("  3. Optimize weekend processing to reduce Monday delivery backlogs")
print("  4. Investigate interstate routing for cross-region delivery delays")

print("\nOutputs:")
print("  - Analysis tables saved to gold layer")
print("  - Visualizations saved to /tmp/usps_*.png")

print("=" * 60)
