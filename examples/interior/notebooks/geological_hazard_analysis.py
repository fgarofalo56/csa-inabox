# Databricks notebook source
# MAGIC %md
# MAGIC # Geological Hazard Analysis
# MAGIC
# MAGIC Comprehensive analytics for USGS earthquake and water resource data:
# MAGIC - Seismic activity pattern analysis
# MAGIC - Earthquake magnitude and depth distributions
# MAGIC - Spatial clustering of seismic events (DBSCAN)
# MAGIC - Gutenberg-Richter frequency-magnitude analysis
# MAGIC - Fault line proximity and recurrence interval calculation
# MAGIC - Probabilistic seismic hazard assessment (PSHA)
# MAGIC - Spatial autocorrelation (Moran's I)
# MAGIC - Water resource trend analysis and flood risk
# MAGIC - Cross-hazard correlation assessment and risk mapping
# MAGIC
# MAGIC **Data Sources:**
# MAGIC - USGS ComCat earthquake catalog (silver layer)
# MAGIC - USGS NWIS water gauge data (silver layer)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup and Configuration

# COMMAND ----------

import warnings
from datetime import datetime

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

warnings.filterwarnings("ignore")

import mlflow
import mlflow.sklearn
from pyspark.sql.functions import *
from pyspark.sql.types import *
from scipy import stats
from scipy.spatial.distance import cdist
from sklearn.cluster import DBSCAN, KMeans
from sklearn.ensemble import GradientBoostingRegressor, RandomForestClassifier
from sklearn.metrics import (
    mean_absolute_error,
    r2_score,
    roc_auc_score,
    roc_curve,
    silhouette_score,
)
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler

plt.style.use("seaborn-v0_8")
sns.set_palette("husl")

# MLflow setup
mlflow.set_experiment("/Interior/geological_hazard_analysis")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading

# COMMAND ----------


def load_earthquake_data():
    """Load earthquake data from silver layer."""
    df = spark.table("silver.slv_earthquake_events").toPandas()
    df["event_time"] = pd.to_datetime(df["event_time"])
    print(f"Loaded {len(df):,} earthquake events")
    print(f"Magnitude range: {df['magnitude'].min():.1f} - {df['magnitude'].max():.1f}")
    print(f"Date range: {df['event_time'].min()} to {df['event_time'].max()}")
    return df


def load_water_data():
    """Load water resource data from silver layer."""
    df = spark.table("silver.slv_water_resources").toPandas()
    df["measurement_date"] = pd.to_datetime(df["measurement_date"])
    print(f"\nLoaded {len(df):,} water measurements")
    print(f"Sites: {df['site_id'].nunique()}")
    print(f"Parameters: {df['parameter_name'].unique()}")
    return df


df_eq = load_earthquake_data()
df_water = load_water_data()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Earthquake Magnitude Distribution and Gutenberg-Richter Analysis

# COMMAND ----------


def analyze_magnitude_distribution(df):
    """Analyze earthquake magnitude distribution and Gutenberg-Richter law."""
    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Magnitude histogram
    axes[0, 0].hist(df["magnitude"], bins=50, edgecolor="black", alpha=0.7, color="steelblue")
    axes[0, 0].set_title("Earthquake Magnitude Distribution", fontweight="bold")
    axes[0, 0].set_xlabel("Magnitude")
    axes[0, 0].set_ylabel("Count")
    axes[0, 0].axvline(
        x=df["magnitude"].median(), color="red", linestyle="--", label=f"Median: {df['magnitude'].median():.1f}"
    )
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)

    # Gutenberg-Richter frequency-magnitude relation
    mag_bins = np.arange(1.0, df["magnitude"].max() + 0.5, 0.5)
    counts = []
    for m in mag_bins:
        counts.append(len(df[df["magnitude"] >= m]))

    axes[0, 1].semilogy(mag_bins, counts, "ko-", markersize=4)
    # Fit linear regression on log scale for b-value estimation
    log_counts = np.log10(np.array(counts, dtype=float) + 1)
    valid = log_counts > 0
    b_value = np.nan
    a_value = np.nan
    if valid.sum() > 2:
        slope, intercept, r, p, se = stats.linregress(mag_bins[valid], log_counts[valid])
        b_value = abs(slope)
        a_value = intercept
        axes[0, 1].semilogy(
            mag_bins,
            10 ** (slope * mag_bins + intercept),
            "r--",
            label=f"b-value: {b_value:.2f}, a-value: {a_value:.2f}",
        )
    axes[0, 1].set_title("Gutenberg-Richter Relation", fontweight="bold")
    axes[0, 1].set_xlabel("Magnitude")
    axes[0, 1].set_ylabel("Cumulative Count (log scale)")
    axes[0, 1].legend()
    axes[0, 1].grid(True, alpha=0.3)

    # Depth distribution
    axes[1, 0].hist(df["depth_km"], bins=40, edgecolor="black", alpha=0.7, color="coral")
    axes[1, 0].set_title("Depth Distribution", fontweight="bold")
    axes[1, 0].set_xlabel("Depth (km)")
    axes[1, 0].set_ylabel("Count")
    axes[1, 0].grid(True, alpha=0.3)

    # Magnitude vs Depth
    scatter = axes[1, 1].scatter(df["depth_km"], df["magnitude"], alpha=0.4, s=15, c=df["magnitude"], cmap="hot_r")
    axes[1, 1].set_title("Magnitude vs Depth", fontweight="bold")
    axes[1, 1].set_xlabel("Depth (km)")
    axes[1, 1].set_ylabel("Magnitude")
    plt.colorbar(scatter, ax=axes[1, 1], label="Magnitude")
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/earthquake_magnitude_analysis.png", dpi=300, bbox_inches="tight")
    plt.show()

    print("\nGutenberg-Richter Parameters:")
    print(f"  b-value: {b_value:.3f} (global average ~1.0)")
    print(f"  a-value: {a_value:.3f}")
    print(f"  Events M >= 4.0: {len(df[df['magnitude'] >= 4.0]):,}")
    print(f"  Events M >= 5.0: {len(df[df['magnitude'] >= 5.0]):,}")

    return b_value, a_value


b_value, a_value = analyze_magnitude_distribution(df_eq)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Temporal Pattern Analysis

# COMMAND ----------


def analyze_temporal_patterns(df):
    """Analyze temporal patterns in earthquake occurrence."""
    df_temp = df.copy()
    df_temp["year"] = df_temp["event_time"].dt.year
    df_temp["month"] = df_temp["event_time"].dt.month
    df_temp["day_of_week"] = df_temp["event_time"].dt.dayofweek
    df_temp["hour"] = df_temp["event_time"].dt.hour

    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Monthly event count
    monthly = df_temp.groupby([df_temp["event_time"].dt.to_period("M")]).size()
    monthly.index = monthly.index.to_timestamp()
    axes[0, 0].plot(monthly.index, monthly.values, linewidth=1, color="steelblue")
    axes[0, 0].fill_between(monthly.index, monthly.values, alpha=0.3)
    axes[0, 0].set_title("Monthly Earthquake Count", fontweight="bold")
    axes[0, 0].set_xlabel("Date")
    axes[0, 0].set_ylabel("Event Count")
    axes[0, 0].grid(True, alpha=0.3)

    # Significant events (M >= 5.0)
    significant = df_temp[df_temp["magnitude"] >= 5.0]
    yearly_sig = significant.groupby("year").size()
    axes[0, 1].bar(yearly_sig.index, yearly_sig.values, color="darkred", alpha=0.7)
    axes[0, 1].set_title("Significant Earthquakes (M >= 5.0) by Year", fontweight="bold")
    axes[0, 1].set_xlabel("Year")
    axes[0, 1].set_ylabel("Count")
    axes[0, 1].grid(True, alpha=0.3)

    # Hourly distribution (UTC)
    hourly = df_temp.groupby("hour").size()
    axes[1, 0].bar(hourly.index, hourly.values, color="teal", alpha=0.7)
    axes[1, 0].set_title("Earthquakes by Hour (UTC)", fontweight="bold")
    axes[1, 0].set_xlabel("Hour")
    axes[1, 0].set_ylabel("Count")
    axes[1, 0].grid(True, alpha=0.3)

    # Magnitude by month (seasonality check)
    monthly_mag = df_temp.groupby("month")["magnitude"].agg(["mean", "std"]).reset_index()
    axes[1, 1].errorbar(
        monthly_mag["month"], monthly_mag["mean"], yerr=monthly_mag["std"], fmt="o-", capsize=5, color="purple"
    )
    axes[1, 1].set_title("Average Magnitude by Month", fontweight="bold")
    axes[1, 1].set_xlabel("Month")
    axes[1, 1].set_ylabel("Average Magnitude")
    axes[1, 1].set_xticks(range(1, 13))
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/earthquake_temporal_patterns.png", dpi=300, bbox_inches="tight")
    plt.show()

    return df_temp


df_temporal = analyze_temporal_patterns(df_eq)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Seismic Event Clustering (DBSCAN)

# COMMAND ----------


def cluster_seismic_zones(df):
    """Identify seismic zones using DBSCAN clustering on geographic coordinates."""
    coords = df[["latitude", "longitude"]].values
    # DBSCAN with ~50km radius (0.5 degrees approx)
    clustering = DBSCAN(eps=0.5, min_samples=5, metric="haversine", algorithm="ball_tree")

    # Convert to radians for haversine
    coords_rad = np.radians(coords)
    df = df.copy()
    df["cluster"] = clustering.fit_predict(coords_rad)

    n_clusters = len(set(df["cluster"])) - (1 if -1 in df["cluster"].values else 0)
    noise_points = (df["cluster"] == -1).sum()
    print(f"Identified {n_clusters} seismic clusters")
    print(f"Noise points (unclustered): {noise_points:,}")

    fig, axes = plt.subplots(1, 2, figsize=(20, 8))

    # Spatial cluster map
    scatter = axes[0].scatter(
        df["longitude"], df["latitude"], c=df["cluster"], s=df["magnitude"] ** 2 * 3, alpha=0.5, cmap="tab20"
    )
    axes[0].set_title(f"Seismic Clusters ({n_clusters} zones identified)", fontweight="bold")
    axes[0].set_xlabel("Longitude")
    axes[0].set_ylabel("Latitude")
    axes[0].grid(True, alpha=0.3)
    plt.colorbar(scatter, ax=axes[0], label="Cluster ID")

    # Cluster size distribution
    cluster_sizes = df[df["cluster"] >= 0]["cluster"].value_counts().sort_values(ascending=False)
    if len(cluster_sizes) > 0:
        axes[1].bar(range(min(len(cluster_sizes), 20)), cluster_sizes.values[:20], color="steelblue", alpha=0.7)
        axes[1].set_title("Top 20 Clusters by Event Count", fontweight="bold")
        axes[1].set_xlabel("Cluster Rank")
        axes[1].set_ylabel("Event Count")
        axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/seismic_clusters.png", dpi=300, bbox_inches="tight")
    plt.show()

    # Cluster statistics
    cluster_stats = (
        df[df["cluster"] >= 0]
        .groupby("cluster")
        .agg(
            count=("event_id", "count"),
            avg_magnitude=("magnitude", "mean"),
            max_magnitude=("magnitude", "max"),
            min_magnitude=("magnitude", "min"),
            avg_depth=("depth_km", "mean"),
            std_depth=("depth_km", "std"),
            center_lat=("latitude", "mean"),
            center_lon=("longitude", "mean"),
            lat_spread=("latitude", "std"),
            lon_spread=("longitude", "std"),
        )
        .round(3)
    )

    # Estimate cluster area (approximate ellipse in km^2)
    cluster_stats["approx_area_km2"] = (
        np.pi * cluster_stats["lat_spread"] * 111 * cluster_stats["lon_spread"] * 85
    ).round(1)

    print("\nTop 10 seismic clusters by event count:")
    print(cluster_stats.sort_values("count", ascending=False).head(10).to_string())

    return df, cluster_stats


df_eq_clustered, cluster_stats = cluster_seismic_zones(df_eq)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Historical Recurrence Interval Calculation

# COMMAND ----------


def calculate_recurrence_intervals(df):
    """Calculate recurrence intervals for earthquakes of various magnitudes.

    The recurrence interval (return period) estimates how often earthquakes
    of a given magnitude or greater occur in the study region.
    """
    df_sorted = df.sort_values("event_time").copy()

    # Calculate time span of the catalog in years
    time_span_days = (df_sorted["event_time"].max() - df_sorted["event_time"].min()).days
    time_span_years = time_span_days / 365.25

    # Magnitude thresholds to analyze
    mag_thresholds = np.arange(2.0, df["magnitude"].max() + 0.5, 0.5)

    recurrence_data = []
    for mag_threshold in mag_thresholds:
        events_above = df_sorted[df_sorted["magnitude"] >= mag_threshold]
        n_events = len(events_above)
        if n_events > 1:
            # Annual rate
            annual_rate = n_events / time_span_years
            # Recurrence interval in years
            recurrence_years = 1.0 / annual_rate if annual_rate > 0 else np.inf

            # Inter-event times
            event_times_sorted = events_above["event_time"].sort_values()
            inter_event_days = event_times_sorted.diff().dt.total_seconds() / 86400
            inter_event_days = inter_event_days.dropna()

            recurrence_data.append(
                {
                    "magnitude_threshold": mag_threshold,
                    "event_count": n_events,
                    "annual_rate": round(annual_rate, 4),
                    "recurrence_years": round(recurrence_years, 4),
                    "mean_inter_event_days": round(inter_event_days.mean(), 1),
                    "median_inter_event_days": round(inter_event_days.median(), 1),
                    "std_inter_event_days": round(inter_event_days.std(), 1),
                    "cv_inter_event": round(inter_event_days.std() / inter_event_days.mean(), 3)
                    if inter_event_days.mean() > 0
                    else np.nan,
                }
            )

    recurrence_df = pd.DataFrame(recurrence_data)

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Recurrence interval vs magnitude
    axes[0, 0].semilogy(recurrence_df["magnitude_threshold"], recurrence_df["recurrence_years"], "bo-", linewidth=2)
    axes[0, 0].set_title("Recurrence Interval vs Magnitude", fontweight="bold")
    axes[0, 0].set_xlabel("Magnitude Threshold")
    axes[0, 0].set_ylabel("Recurrence Interval (years, log scale)")
    axes[0, 0].grid(True, alpha=0.3)

    # Annual rate vs magnitude
    axes[0, 1].semilogy(recurrence_df["magnitude_threshold"], recurrence_df["annual_rate"], "rs-", linewidth=2)
    axes[0, 1].set_title("Annual Exceedance Rate vs Magnitude", fontweight="bold")
    axes[0, 1].set_xlabel("Magnitude Threshold")
    axes[0, 1].set_ylabel("Events per Year (log scale)")
    axes[0, 1].grid(True, alpha=0.3)

    # Inter-event time distribution for M >= 4.0
    events_m4 = df_sorted[df_sorted["magnitude"] >= 4.0].sort_values("event_time")
    if len(events_m4) > 2:
        inter_m4 = events_m4["event_time"].diff().dt.total_seconds() / 86400
        inter_m4 = inter_m4.dropna()
        axes[1, 0].hist(inter_m4, bins=30, edgecolor="black", alpha=0.7, color="coral")
        axes[1, 0].axvline(x=inter_m4.mean(), color="red", linestyle="--", label=f"Mean: {inter_m4.mean():.0f} days")
        axes[1, 0].axvline(
            x=inter_m4.median(), color="blue", linestyle="--", label=f"Median: {inter_m4.median():.0f} days"
        )
        axes[1, 0].set_title("Inter-Event Time Distribution (M >= 4.0)", fontweight="bold")
        axes[1, 0].set_xlabel("Days Between Events")
        axes[1, 0].set_ylabel("Count")
        axes[1, 0].legend()
        axes[1, 0].grid(True, alpha=0.3)

    # Coefficient of variation (clustering indicator)
    valid_cv = recurrence_df.dropna(subset=["cv_inter_event"])
    axes[1, 1].bar(valid_cv["magnitude_threshold"], valid_cv["cv_inter_event"], color="teal", alpha=0.7)
    axes[1, 1].axhline(y=1.0, color="red", linestyle="--", alpha=0.5, label="Poisson (CV=1)")
    axes[1, 1].set_title("Inter-Event Time CV (clustering indicator)", fontweight="bold")
    axes[1, 1].set_xlabel("Magnitude Threshold")
    axes[1, 1].set_ylabel("Coefficient of Variation")
    axes[1, 1].legend()
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/recurrence_intervals.png", dpi=300, bbox_inches="tight")
    plt.show()

    print(f"\nRecurrence Interval Summary (catalog span: {time_span_years:.1f} years):")
    print(recurrence_df.to_string(index=False))

    return recurrence_df


recurrence_df = calculate_recurrence_intervals(df_eq)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Probabilistic Seismic Hazard Assessment (PSHA)

# COMMAND ----------


def probabilistic_hazard_assessment(df, recurrence_df, cluster_stats):
    """Simplified probabilistic seismic hazard assessment.

    Estimates the probability of exceeding various magnitude thresholds
    within given time windows using Poisson and cluster-based models.
    """
    # Poisson probability: P(N>=1) = 1 - exp(-lambda * t)
    time_windows = [1, 5, 10, 25, 50]  # years
    mag_thresholds = [3.0, 4.0, 5.0, 6.0]

    psha_results = []
    for mag in mag_thresholds:
        rec_row = recurrence_df[recurrence_df["magnitude_threshold"] == mag]
        if len(rec_row) == 0:
            continue
        annual_rate = rec_row["annual_rate"].values[0]
        for t in time_windows:
            prob = 1 - np.exp(-annual_rate * t)
            psha_results.append(
                {
                    "magnitude": mag,
                    "time_window_years": t,
                    "annual_rate": annual_rate,
                    "exceedance_probability": round(prob, 4),
                }
            )

    psha_df = pd.DataFrame(psha_results)

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Exceedance probability matrix
    if len(psha_df) > 0:
        prob_matrix = psha_df.pivot(index="magnitude", columns="time_window_years", values="exceedance_probability")
        sns.heatmap(prob_matrix, annot=True, fmt=".3f", cmap="YlOrRd", ax=axes[0, 0], cbar_kws={"label": "Probability"})
        axes[0, 0].set_title("Exceedance Probability (Poisson Model)", fontweight="bold")
        axes[0, 0].set_xlabel("Time Window (years)")
        axes[0, 0].set_ylabel("Magnitude Threshold")

    # Hazard curves for each magnitude
    for mag in mag_thresholds:
        subset = psha_df[psha_df["magnitude"] == mag]
        if len(subset) > 0:
            axes[0, 1].plot(
                subset["time_window_years"], subset["exceedance_probability"], "o-", label=f"M >= {mag}", linewidth=2
            )
    axes[0, 1].set_title("Hazard Curves by Magnitude", fontweight="bold")
    axes[0, 1].set_xlabel("Time Window (years)")
    axes[0, 1].set_ylabel("Exceedance Probability")
    axes[0, 1].legend()
    axes[0, 1].grid(True, alpha=0.3)

    # Cluster-level hazard: max magnitude per cluster
    if len(cluster_stats) > 0:
        cluster_hazard = cluster_stats.copy()
        cluster_hazard["hazard_level"] = pd.cut(
            cluster_hazard["max_magnitude"], bins=[0, 3, 4, 5, 10], labels=["Low", "Moderate", "High", "Very High"]
        )
        hazard_counts = cluster_hazard["hazard_level"].value_counts()
        colors_hazard = {"Low": "green", "Moderate": "yellow", "High": "orange", "Very High": "red"}
        bar_colors = [colors_hazard.get(h, "gray") for h in hazard_counts.index]
        axes[1, 0].bar(hazard_counts.index.astype(str), hazard_counts.values, color=bar_colors)
        axes[1, 0].set_title("Cluster Hazard Level Distribution", fontweight="bold")
        axes[1, 0].set_xlabel("Hazard Level")
        axes[1, 0].set_ylabel("Number of Clusters")
        axes[1, 0].grid(True, alpha=0.3)

    # Spatial hazard density (events per degree^2)
    lat_bins = np.arange(df["latitude"].min(), df["latitude"].max() + 1, 1)
    lon_bins = np.arange(df["longitude"].min(), df["longitude"].max() + 1, 1)
    density, _, _ = np.histogram2d(df["latitude"], df["longitude"], bins=[lat_bins, lon_bins])

    im = axes[1, 1].imshow(
        density.T,
        origin="lower",
        aspect="auto",
        cmap="hot",
        extent=[lat_bins[0], lat_bins[-1], lon_bins[0], lon_bins[-1]],
    )
    axes[1, 1].set_title("Seismic Event Density Map", fontweight="bold")
    axes[1, 1].set_xlabel("Latitude")
    axes[1, 1].set_ylabel("Longitude")
    plt.colorbar(im, ax=axes[1, 1], label="Event Count")

    plt.tight_layout()
    plt.savefig("/tmp/psha_results.png", dpi=300, bbox_inches="tight")
    plt.show()

    print("\nPSHA Exceedance Probabilities:")
    print(psha_df.to_string(index=False))

    return psha_df


psha_results = probabilistic_hazard_assessment(df_eq, recurrence_df, cluster_stats)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Spatial Autocorrelation (Moran's I)

# COMMAND ----------


def compute_spatial_autocorrelation(df, cluster_stats):
    """Compute Moran's I to measure spatial autocorrelation of seismic activity.

    Moran's I > 0 indicates spatial clustering; I < 0 indicates dispersion;
    I ~ 0 indicates random spatial distribution.
    """
    # Grid-based approach: bin events into spatial cells
    lat_step = 0.5
    lon_step = 0.5
    df_copy = df.copy()
    df_copy["lat_bin"] = (df_copy["latitude"] / lat_step).round() * lat_step
    df_copy["lon_bin"] = (df_copy["longitude"] / lon_step).round() * lon_step

    # Count events per cell
    grid_counts = (
        df_copy.groupby(["lat_bin", "lon_bin"])
        .agg(
            n_events=("event_id", "count"),
            avg_magnitude=("magnitude", "mean"),
            max_magnitude=("magnitude", "max"),
            avg_depth=("depth_km", "mean"),
        )
        .reset_index()
    )

    n = len(grid_counts)
    if n < 4:
        print("Insufficient grid cells for Moran's I calculation.")
        return None

    # Compute spatial weights (inverse distance)
    coords = grid_counts[["lat_bin", "lon_bin"]].values
    dist_matrix = cdist(coords, coords, metric="euclidean")
    np.fill_diagonal(dist_matrix, np.inf)

    # Use distance threshold for neighbors (1 degree)
    W = np.where(dist_matrix <= 1.0, 1.0 / dist_matrix, 0)
    W_sum = W.sum()

    if W_sum == 0:
        print("No spatial neighbors found within threshold.")
        return None

    # Compute Moran's I for event counts
    x = grid_counts["n_events"].values.astype(float)
    x_bar = x.mean()
    x_dev = x - x_bar

    numerator = n * np.sum(W * np.outer(x_dev, x_dev))
    denominator = W_sum * np.sum(x_dev**2)
    morans_i = numerator / denominator if denominator != 0 else 0

    # Expected value under null hypothesis
    expected_i = -1.0 / (n - 1)

    # Variance (normality assumption)
    s1 = 0.5 * np.sum((W + W.T) ** 2)
    s2 = np.sum(np.sum(W, axis=1) + np.sum(W, axis=0)) ** 2
    var_i = (n * ((n**2 - 3 * n + 3) * s1 - n * s2 + 3 * W_sum**2) - (n**2 - n) * s1 - 2 * n * s2 + 6 * W_sum**2) / (
        (n - 1) * (n - 2) * (n - 3) * W_sum**2 + 1e-10
    )
    z_score = (morans_i - expected_i) / (np.sqrt(abs(var_i)) + 1e-10)

    print(f"\nMoran's I Analysis (grid cells: {n}):")
    print(f"  Moran's I: {morans_i:.4f}")
    print(f"  Expected I: {expected_i:.4f}")
    print(f"  Z-score: {z_score:.4f}")
    print(f"  Interpretation: {'Clustered' if morans_i > expected_i else 'Dispersed'}")

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Moran scatter plot: x_dev vs spatial lag
    spatial_lag = W @ x_dev / (W.sum(axis=1) + 1e-10)
    axes[0, 0].scatter(x_dev, spatial_lag, alpha=0.5, s=30, c="steelblue")
    axes[0, 0].axhline(y=0, color="black", linestyle="-", alpha=0.3)
    axes[0, 0].axvline(x=0, color="black", linestyle="-", alpha=0.3)
    # Fit line
    if len(x_dev) > 2:
        slope_m, intercept_m, _, _, _ = stats.linregress(x_dev, spatial_lag)
        x_line = np.linspace(x_dev.min(), x_dev.max(), 100)
        axes[0, 0].plot(x_line, slope_m * x_line + intercept_m, "r-", label=f"Slope (Moran's I) = {slope_m:.3f}")
    axes[0, 0].set_title("Moran's Scatter Plot", fontweight="bold")
    axes[0, 0].set_xlabel("Event Count (deviation)")
    axes[0, 0].set_ylabel("Spatial Lag")
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)

    # Local indicator classification (HH, HL, LH, LL)
    quadrant = np.where(
        (x_dev > 0) & (spatial_lag > 0),
        "HH",
        np.where((x_dev > 0) & (spatial_lag < 0), "HL", np.where((x_dev < 0) & (spatial_lag > 0), "LH", "LL")),
    )
    grid_counts["quadrant"] = quadrant
    quad_counts = pd.Series(quadrant).value_counts()
    quad_colors = {"HH": "red", "HL": "orange", "LH": "lightblue", "LL": "blue"}
    axes[0, 1].bar(quad_counts.index, quad_counts.values, color=[quad_colors.get(q, "gray") for q in quad_counts.index])
    axes[0, 1].set_title("LISA Quadrant Distribution", fontweight="bold")
    axes[0, 1].set_xlabel("Quadrant")
    axes[0, 1].set_ylabel("Cell Count")
    axes[0, 1].grid(True, alpha=0.3)

    # Spatial hot/cold spot map
    quad_color_map = {"HH": "red", "HL": "orange", "LH": "lightblue", "LL": "blue"}
    colors_plot = [quad_color_map.get(q, "gray") for q in grid_counts["quadrant"]]
    axes[1, 0].scatter(
        grid_counts["lon_bin"], grid_counts["lat_bin"], c=colors_plot, s=grid_counts["n_events"] * 2, alpha=0.7
    )
    axes[1, 0].set_title("LISA Cluster Map (HH=hotspot, LL=coldspot)", fontweight="bold")
    axes[1, 0].set_xlabel("Longitude")
    axes[1, 0].set_ylabel("Latitude")
    axes[1, 0].grid(True, alpha=0.3)

    # Event density by grid cell
    sorted_grid = grid_counts.sort_values("n_events", ascending=False).head(20)
    axes[1, 1].barh(
        [f"({r['lat_bin']:.1f},{r['lon_bin']:.1f})" for _, r in sorted_grid.iterrows()],
        sorted_grid["n_events"],
        color="coral",
        alpha=0.7,
    )
    axes[1, 1].set_title("Top 20 Grid Cells by Event Count", fontweight="bold")
    axes[1, 1].set_xlabel("Event Count")
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/spatial_autocorrelation.png", dpi=300, bbox_inches="tight")
    plt.show()

    return {"morans_i": morans_i, "expected_i": expected_i, "z_score": z_score, "grid_counts": grid_counts}


spatial_results = compute_spatial_autocorrelation(df_eq, cluster_stats)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Water Resource Analysis

# COMMAND ----------


def analyze_streamflow(df):
    """Analyze streamflow trends and anomalies."""
    stream_data = df[df["parameter_code"] == "00060"].copy()

    if len(stream_data) == 0:
        print("No streamflow data found.")
        return None

    fig, axes = plt.subplots(2, 2, figsize=(18, 12))

    # Streamflow trends by site
    sites = stream_data["site_name"].unique()[:6]
    for site in sites:
        site_data = stream_data[stream_data["site_name"] == site]
        site_data = site_data.sort_values("measurement_date")
        label = site[:30] + "..." if len(site) > 30 else site
        axes[0, 0].plot(site_data["measurement_date"], site_data["daily_mean"], alpha=0.7, linewidth=1, label=label)

    axes[0, 0].set_title("Streamflow Trends by Site", fontweight="bold")
    axes[0, 0].set_xlabel("Date")
    axes[0, 0].set_ylabel("Daily Mean Discharge (cfs)")
    axes[0, 0].legend(fontsize=7, bbox_to_anchor=(1.05, 1))
    axes[0, 0].grid(True, alpha=0.3)

    # Monthly seasonality
    stream_data["month"] = stream_data["measurement_date"].dt.month
    monthly_flow = stream_data.groupby("month")["daily_mean"].agg(["mean", "std"]).reset_index()
    axes[0, 1].bar(
        monthly_flow["month"], monthly_flow["mean"], yerr=monthly_flow["std"], capsize=3, color="steelblue", alpha=0.7
    )
    axes[0, 1].set_title("Seasonal Streamflow Pattern", fontweight="bold")
    axes[0, 1].set_xlabel("Month")
    axes[0, 1].set_ylabel("Mean Discharge (cfs)")
    axes[0, 1].set_xticks(range(1, 13))
    axes[0, 1].grid(True, alpha=0.3)

    # Flood risk: compare to flood stage
    gauge_data = df[df["parameter_code"] == "00065"].copy()
    if len(gauge_data) > 0:
        gauge_data = gauge_data.dropna(subset=["daily_max", "flood_stage_ft"])
        if len(gauge_data) > 0:
            gauge_data["above_flood"] = gauge_data["daily_max"] > gauge_data["flood_stage_ft"]
            flood_pct = gauge_data["above_flood"].mean() * 100
            axes[1, 0].scatter(
                gauge_data["daily_mean"],
                gauge_data["flood_stage_ft"],
                alpha=0.5,
                s=20,
                c=gauge_data["above_flood"].astype(int),
                cmap="RdYlGn_r",
            )
            axes[1, 0].plot([0, gauge_data["daily_mean"].max()], [0, gauge_data["daily_mean"].max()], "r--", alpha=0.5)
            axes[1, 0].set_title(f"Gauge Height vs Flood Stage ({flood_pct:.1f}% above)", fontweight="bold")
            axes[1, 0].set_xlabel("Daily Mean Gauge Height (ft)")
            axes[1, 0].set_ylabel("Flood Stage (ft)")
            axes[1, 0].grid(True, alpha=0.3)

    # Discharge distribution
    axes[1, 1].hist(
        np.log10(stream_data["daily_mean"].clip(lower=0.1)), bins=40, edgecolor="black", alpha=0.7, color="teal"
    )
    axes[1, 1].set_title("Log10 Discharge Distribution", fontweight="bold")
    axes[1, 1].set_xlabel("log10(Discharge cfs)")
    axes[1, 1].set_ylabel("Count")
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/water_resource_analysis.png", dpi=300, bbox_inches="tight")
    plt.show()

    return stream_data


stream_analysis = analyze_streamflow(df_water)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Fault Line Proximity Analysis

# COMMAND ----------


def analyze_fault_proximity(df, cluster_stats):
    """Analyze fault line proximity using linear alignment detection within clusters.

    Identifies potential fault structures by fitting lines through earthquake
    clusters and analyzing the residual scatter.
    """
    fault_analysis = []
    top_clusters = cluster_stats.sort_values("count", ascending=False).head(10)

    fig, axes = plt.subplots(2, 3, figsize=(20, 12))
    axes = axes.flatten()

    for idx, (cluster_id, row) in enumerate(top_clusters.iterrows()):
        if idx >= 6:
            break

        cluster_events = df[df["cluster"] == cluster_id]
        if len(cluster_events) < 5:
            continue

        lats = cluster_events["latitude"].values
        lons = cluster_events["longitude"].values

        # Fit line through cluster (potential fault alignment)
        slope, intercept, r_value, p_value, std_err = stats.linregress(lons, lats)

        # Calculate perpendicular distances (proxy for fault zone width)
        predicted = slope * lons + intercept
        residuals = lats - predicted
        fault_width_km = residuals.std() * 111  # approximate km

        fault_analysis.append(
            {
                "cluster_id": cluster_id,
                "n_events": int(row["count"]),
                "fault_azimuth_deg": round(np.degrees(np.arctan(slope)), 1),
                "r_squared": round(r_value**2, 4),
                "fault_width_km": round(fault_width_km, 2),
                "max_magnitude": row["max_magnitude"],
                "avg_depth_km": row["avg_depth"],
            }
        )

        # Plot cluster with fault line fit
        axes[idx].scatter(
            lons, lats, c=cluster_events["magnitude"], cmap="hot_r", s=cluster_events["magnitude"] ** 2 * 5, alpha=0.6
        )
        lon_range = np.linspace(lons.min(), lons.max(), 100)
        axes[idx].plot(lon_range, slope * lon_range + intercept, "b--", linewidth=2, label=f"R2={r_value**2:.3f}")
        axes[idx].set_title(f"Cluster {cluster_id} (n={int(row['count'])})", fontweight="bold")
        axes[idx].set_xlabel("Longitude")
        axes[idx].set_ylabel("Latitude")
        axes[idx].legend(fontsize=8)
        axes[idx].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/fault_proximity_analysis.png", dpi=300, bbox_inches="tight")
    plt.show()

    fault_df = pd.DataFrame(fault_analysis)
    if len(fault_df) > 0:
        print("\nFault Line Analysis Summary:")
        print(fault_df.to_string(index=False))

        # Fault width vs max magnitude
        fig2, axes2 = plt.subplots(1, 2, figsize=(14, 6))
        axes2[0].scatter(
            fault_df["fault_width_km"], fault_df["max_magnitude"], s=fault_df["n_events"], alpha=0.7, c="darkred"
        )
        for _, row in fault_df.iterrows():
            axes2[0].annotate(f"C{int(row['cluster_id'])}", (row["fault_width_km"], row["max_magnitude"]), fontsize=8)
        axes2[0].set_title("Fault Zone Width vs Max Magnitude", fontweight="bold")
        axes2[0].set_xlabel("Fault Width (km)")
        axes2[0].set_ylabel("Maximum Magnitude")
        axes2[0].grid(True, alpha=0.3)

        # Linearity (R-squared) distribution
        axes2[1].barh([f"C{int(c)}" for c in fault_df["cluster_id"]], fault_df["r_squared"], color="teal", alpha=0.7)
        axes2[1].set_title("Fault Linearity (R-squared)", fontweight="bold")
        axes2[1].set_xlabel("R-squared")
        axes2[1].axvline(x=0.5, color="red", linestyle="--", alpha=0.5, label="Linear threshold")
        axes2[1].legend()
        axes2[1].grid(True, alpha=0.3)

        plt.tight_layout()
        plt.savefig("/tmp/fault_characteristics.png", dpi=300, bbox_inches="tight")
        plt.show()

    return fault_df


fault_results = analyze_fault_proximity(df_eq_clustered, cluster_stats)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Risk Mapping and Composite Hazard Score

# COMMAND ----------


def create_risk_map(df, cluster_stats, recurrence_df, spatial_results):
    """Create a composite geological hazard risk map combining seismic
    activity, recurrence rates, and spatial clustering indicators."""

    # Grid-based risk scoring
    lat_step = 1.0
    lon_step = 1.0
    df_copy = df.copy()
    df_copy["lat_grid"] = (df_copy["latitude"] / lat_step).round() * lat_step
    df_copy["lon_grid"] = (df_copy["longitude"] / lon_step).round() * lon_step

    grid_risk = (
        df_copy.groupby(["lat_grid", "lon_grid"])
        .agg(
            n_events=("event_id", "count"),
            max_magnitude=("magnitude", "max"),
            avg_magnitude=("magnitude", "mean"),
            avg_depth=("depth_km", "mean"),
            recent_events=("event_time", lambda x: (x >= x.max() - pd.Timedelta(days=365)).sum()),
        )
        .reset_index()
    )

    # Normalize components to 0-100
    for col in ["n_events", "max_magnitude", "recent_events"]:
        col_min = grid_risk[col].min()
        col_max = grid_risk[col].max()
        if col_max > col_min:
            grid_risk[f"{col}_norm"] = ((grid_risk[col] - col_min) / (col_max - col_min) * 100).round(1)
        else:
            grid_risk[f"{col}_norm"] = 50.0

    # Depth penalty: shallow events are more dangerous
    depth_max = grid_risk["avg_depth"].max()
    grid_risk["depth_risk_norm"] = ((1 - grid_risk["avg_depth"] / max(depth_max, 1)) * 100).round(1).clip(lower=0)

    # Composite risk score (weighted)
    grid_risk["composite_risk"] = (
        grid_risk["n_events_norm"] * 0.25
        + grid_risk["max_magnitude_norm"] * 0.30
        + grid_risk["recent_events_norm"] * 0.25
        + grid_risk["depth_risk_norm"] * 0.20
    ).round(1)

    # Risk classification
    grid_risk["risk_level"] = pd.cut(
        grid_risk["composite_risk"], bins=[0, 25, 50, 75, 100], labels=["Low", "Moderate", "High", "Very High"]
    )

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Composite risk scatter map
    risk_colors = {"Low": "green", "Moderate": "yellow", "High": "orange", "Very High": "red"}
    for level, color in risk_colors.items():
        subset = grid_risk[grid_risk["risk_level"] == level]
        axes[0, 0].scatter(
            subset["lon_grid"],
            subset["lat_grid"],
            c=color,
            s=subset["composite_risk"] * 3,
            alpha=0.7,
            label=level,
            edgecolors="black",
            linewidth=0.5,
        )
    axes[0, 0].set_title("Composite Hazard Risk Map", fontweight="bold")
    axes[0, 0].set_xlabel("Longitude")
    axes[0, 0].set_ylabel("Latitude")
    axes[0, 0].legend(title="Risk Level")
    axes[0, 0].grid(True, alpha=0.3)

    # Risk score distribution
    axes[0, 1].hist(grid_risk["composite_risk"], bins=30, edgecolor="black", alpha=0.7, color="coral")
    axes[0, 1].axvline(
        x=grid_risk["composite_risk"].mean(),
        color="red",
        linestyle="--",
        label=f"Mean: {grid_risk['composite_risk'].mean():.1f}",
    )
    axes[0, 1].set_title("Composite Risk Score Distribution", fontweight="bold")
    axes[0, 1].set_xlabel("Composite Risk Score")
    axes[0, 1].set_ylabel("Grid Cell Count")
    axes[0, 1].legend()
    axes[0, 1].grid(True, alpha=0.3)

    # Risk component breakdown for top 10 cells
    top_cells = grid_risk.nlargest(10, "composite_risk")
    components = ["n_events_norm", "max_magnitude_norm", "recent_events_norm", "depth_risk_norm"]
    comp_labels = ["Event Count", "Max Magnitude", "Recent Activity", "Shallow Depth"]
    x_pos = range(len(top_cells))
    bottom = np.zeros(len(top_cells))
    colors_comp = ["steelblue", "coral", "teal", "purple"]

    for comp, label, color in zip(components, comp_labels, colors_comp):
        values = top_cells[comp].values * [0.25, 0.30, 0.25, 0.20][components.index(comp)]
        axes[1, 0].bar(x_pos, values, bottom=bottom, label=label, color=color, alpha=0.7)
        bottom += values

    axes[1, 0].set_xticks(x_pos)
    axes[1, 0].set_xticklabels(
        [f"({r['lat_grid']:.0f},{r['lon_grid']:.0f})" for _, r in top_cells.iterrows()], rotation=45, fontsize=7
    )
    axes[1, 0].set_title("Risk Component Breakdown (Top 10 Cells)", fontweight="bold")
    axes[1, 0].set_ylabel("Weighted Risk Score")
    axes[1, 0].legend(fontsize=8)
    axes[1, 0].grid(True, alpha=0.3)

    # Risk level summary
    risk_summary = (
        grid_risk.groupby("risk_level")
        .agg(
            n_cells=("composite_risk", "count"), avg_events=("n_events", "mean"), avg_max_mag=("max_magnitude", "mean")
        )
        .reset_index()
    )
    risk_summary_sorted = risk_summary.sort_values("n_cells", ascending=True)
    bar_colors_summary = [risk_colors.get(r, "gray") for r in risk_summary_sorted["risk_level"]]
    axes[1, 1].barh(
        risk_summary_sorted["risk_level"].astype(str), risk_summary_sorted["n_cells"], color=bar_colors_summary
    )
    axes[1, 1].set_title("Grid Cells by Risk Level", fontweight="bold")
    axes[1, 1].set_xlabel("Number of Grid Cells")
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/hazard_risk_map.png", dpi=300, bbox_inches="tight")
    plt.show()

    print("\nRisk Level Summary:")
    print(risk_summary.to_string(index=False))

    return grid_risk


grid_risk = create_risk_map(df_eq_clustered, cluster_stats, recurrence_df, spatial_results)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results to Delta Lake

# COMMAND ----------


def save_hazard_results():
    """Save all hazard analysis results to gold layer."""

    # Save seismic clusters
    cluster_df = spark.createDataFrame(cluster_stats.reset_index())
    cluster_df = cluster_df.withColumn("analysis_date", current_date())
    (cluster_df.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_seismic_clusters"))

    # Save recurrence intervals
    recurrence_spark = spark.createDataFrame(recurrence_df)
    recurrence_spark = recurrence_spark.withColumn("analysis_date", current_date())
    (
        recurrence_spark.write.mode("overwrite")
        .option("mergeSchema", "true")
        .saveAsTable("gold.gld_recurrence_intervals")
    )

    # Save PSHA results
    psha_spark = spark.createDataFrame(psha_results)
    psha_spark = psha_spark.withColumn("analysis_date", current_date())
    (psha_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_psha_exceedance"))

    # Save risk grid
    risk_cols = [
        "lat_grid",
        "lon_grid",
        "n_events",
        "max_magnitude",
        "avg_magnitude",
        "avg_depth",
        "composite_risk",
        "risk_level",
    ]
    available_cols = [c for c in risk_cols if c in grid_risk.columns]
    risk_save = grid_risk[available_cols].copy()
    risk_save["risk_level"] = risk_save["risk_level"].astype(str)
    risk_spark = spark.createDataFrame(risk_save)
    risk_spark = risk_spark.withColumn("analysis_date", current_date())
    (risk_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_hazard_risk_grid"))

    # Save fault line analysis
    if len(fault_results) > 0:
        fault_spark = spark.createDataFrame(fault_results)
        fault_spark = fault_spark.withColumn("analysis_date", current_date())
        (fault_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_fault_line_analysis"))

    print("Saved to:")
    print("  gold.gld_seismic_clusters")
    print("  gold.gld_recurrence_intervals")
    print("  gold.gld_psha_exceedance")
    print("  gold.gld_hazard_risk_grid")
    print("  gold.gld_fault_line_analysis")


save_hazard_results()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print("=" * 70)
print("GEOLOGICAL HAZARD ANALYSIS - COMPREHENSIVE SUMMARY")
print("=" * 70)

print(f"\nEarthquake Events: {len(df_eq):,}")
print(f"Magnitude range: {df_eq['magnitude'].min():.1f} - {df_eq['magnitude'].max():.1f}")
print(f"Seismic clusters identified: {len(cluster_stats)}")

print(f"\nGutenberg-Richter b-value: {b_value:.3f}")

if len(recurrence_df) > 0:
    print("\nRecurrence Intervals (selected):")
    for _, row in recurrence_df[recurrence_df["magnitude_threshold"].isin([3.0, 4.0, 5.0])].iterrows():
        print(
            f"  M >= {row['magnitude_threshold']:.1f}: every {row['recurrence_years']:.2f} years "
            f"({row['annual_rate']:.2f}/yr)"
        )

if spatial_results is not None:
    print(f"\nSpatial Autocorrelation (Moran's I): {spatial_results['morans_i']:.4f}")
    print(f"  Z-score: {spatial_results['z_score']:.4f}")

print("\nRisk Grid Summary:")
risk_level_counts = grid_risk["risk_level"].value_counts()
for level in ["Low", "Moderate", "High", "Very High"]:
    count = risk_level_counts.get(level, 0)
    print(f"  {level}: {count} grid cells")

print(f"\nWater Measurements: {len(df_water):,}")
print(f"Monitoring sites: {df_water['site_id'].nunique()}")

print("\nOutputs:")
print("  gold.gld_seismic_clusters")
print("  gold.gld_recurrence_intervals")
print("  gold.gld_psha_exceedance")
print("  gold.gld_hazard_risk_grid")
print("  gold.gld_fault_line_analysis")
print("  MLflow: /Interior/geological_hazard_analysis")
print("  Visualizations: /tmp/*.png")
print("=" * 70)
