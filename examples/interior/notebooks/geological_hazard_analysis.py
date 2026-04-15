# Databricks notebook source
# MAGIC %md
# MAGIC # Geological Hazard Analysis
# MAGIC
# MAGIC Comprehensive analytics for USGS earthquake and water resource data:
# MAGIC - Seismic activity pattern analysis
# MAGIC - Earthquake magnitude and depth distributions
# MAGIC - Spatial clustering of seismic events
# MAGIC - Water resource trend analysis and flood risk
# MAGIC - Cross-hazard correlation assessment
# MAGIC
# MAGIC **Data Sources:**
# MAGIC - USGS ComCat earthquake catalog (silver layer)
# MAGIC - USGS NWIS water gauge data (silver layer)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup and Configuration

# COMMAND ----------

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
from datetime import datetime, timedelta
import warnings
warnings.filterwarnings('ignore')

from scipy import stats
from scipy.signal import find_peaks
from scipy.spatial.distance import pdist, squareform
from sklearn.cluster import DBSCAN

from pyspark.sql import SparkSession
from pyspark.sql.functions import *
from pyspark.sql.types import *

plt.style.use('seaborn-v0_8')
sns.set_palette("husl")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading

# COMMAND ----------

def load_earthquake_data():
    """Load earthquake data from silver layer."""
    df = spark.table("silver.slv_earthquake_events").toPandas()
    df['event_time'] = pd.to_datetime(df['event_time'])
    print(f"Loaded {len(df):,} earthquake events")
    print(f"Magnitude range: {df['magnitude'].min():.1f} - {df['magnitude'].max():.1f}")
    print(f"Date range: {df['event_time'].min()} to {df['event_time'].max()}")
    return df

def load_water_data():
    """Load water resource data from silver layer."""
    df = spark.table("silver.slv_water_resources").toPandas()
    df['measurement_date'] = pd.to_datetime(df['measurement_date'])
    print(f"\nLoaded {len(df):,} water measurements")
    print(f"Sites: {df['site_id'].nunique()}")
    print(f"Parameters: {df['parameter_name'].unique()}")
    return df

df_eq = load_earthquake_data()
df_water = load_water_data()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Earthquake Analysis

# COMMAND ----------

def analyze_magnitude_distribution(df):
    """Analyze earthquake magnitude distribution and Gutenberg-Richter law."""
    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Magnitude histogram
    axes[0, 0].hist(df['magnitude'], bins=50, edgecolor='black', alpha=0.7, color='steelblue')
    axes[0, 0].set_title('Earthquake Magnitude Distribution', fontweight='bold')
    axes[0, 0].set_xlabel('Magnitude')
    axes[0, 0].set_ylabel('Count')
    axes[0, 0].axvline(x=df['magnitude'].median(), color='red', linestyle='--',
                       label=f'Median: {df["magnitude"].median():.1f}')
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)

    # Gutenberg-Richter frequency-magnitude relation
    mag_bins = np.arange(1.0, df['magnitude'].max() + 0.5, 0.5)
    counts = []
    for m in mag_bins:
        counts.append(len(df[df['magnitude'] >= m]))

    axes[0, 1].semilogy(mag_bins, counts, 'ko-', markersize=4)
    # Fit linear regression on log scale
    log_counts = np.log10(np.array(counts, dtype=float) + 1)
    valid = log_counts > 0
    if valid.sum() > 2:
        slope, intercept, r, p, se = stats.linregress(mag_bins[valid], log_counts[valid])
        axes[0, 1].semilogy(mag_bins, 10**(slope * mag_bins + intercept), 'r--',
                           label=f'b-value: {abs(slope):.2f}')
    axes[0, 1].set_title('Gutenberg-Richter Relation', fontweight='bold')
    axes[0, 1].set_xlabel('Magnitude')
    axes[0, 1].set_ylabel('Cumulative Count (log scale)')
    axes[0, 1].legend()
    axes[0, 1].grid(True, alpha=0.3)

    # Depth distribution
    axes[1, 0].hist(df['depth_km'], bins=40, edgecolor='black', alpha=0.7, color='coral')
    axes[1, 0].set_title('Depth Distribution', fontweight='bold')
    axes[1, 0].set_xlabel('Depth (km)')
    axes[1, 0].set_ylabel('Count')
    axes[1, 0].grid(True, alpha=0.3)

    # Magnitude vs Depth
    scatter = axes[1, 1].scatter(df['depth_km'], df['magnitude'], alpha=0.4, s=15,
                                c=df['magnitude'], cmap='hot_r')
    axes[1, 1].set_title('Magnitude vs Depth', fontweight='bold')
    axes[1, 1].set_xlabel('Depth (km)')
    axes[1, 1].set_ylabel('Magnitude')
    plt.colorbar(scatter, ax=axes[1, 1], label='Magnitude')
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/earthquake_magnitude_analysis.png', dpi=300, bbox_inches='tight')
    plt.show()

analyze_magnitude_distribution(df_eq)

# COMMAND ----------

def analyze_temporal_patterns(df):
    """Analyze temporal patterns in earthquake occurrence."""
    df_temp = df.copy()
    df_temp['year'] = df_temp['event_time'].dt.year
    df_temp['month'] = df_temp['event_time'].dt.month
    df_temp['day_of_week'] = df_temp['event_time'].dt.dayofweek
    df_temp['hour'] = df_temp['event_time'].dt.hour

    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Monthly event count
    monthly = df_temp.groupby([df_temp['event_time'].dt.to_period('M')]).size()
    monthly.index = monthly.index.to_timestamp()
    axes[0, 0].plot(monthly.index, monthly.values, linewidth=1, color='steelblue')
    axes[0, 0].fill_between(monthly.index, monthly.values, alpha=0.3)
    axes[0, 0].set_title('Monthly Earthquake Count', fontweight='bold')
    axes[0, 0].set_xlabel('Date')
    axes[0, 0].set_ylabel('Event Count')
    axes[0, 0].grid(True, alpha=0.3)

    # Significant events (M >= 5.0)
    significant = df_temp[df_temp['magnitude'] >= 5.0]
    yearly_sig = significant.groupby('year').size()
    axes[0, 1].bar(yearly_sig.index, yearly_sig.values, color='darkred', alpha=0.7)
    axes[0, 1].set_title('Significant Earthquakes (M >= 5.0) by Year', fontweight='bold')
    axes[0, 1].set_xlabel('Year')
    axes[0, 1].set_ylabel('Count')
    axes[0, 1].grid(True, alpha=0.3)

    # Hourly distribution (UTC)
    hourly = df_temp.groupby('hour').size()
    axes[1, 0].bar(hourly.index, hourly.values, color='teal', alpha=0.7)
    axes[1, 0].set_title('Earthquakes by Hour (UTC)', fontweight='bold')
    axes[1, 0].set_xlabel('Hour')
    axes[1, 0].set_ylabel('Count')
    axes[1, 0].grid(True, alpha=0.3)

    # Magnitude by month (seasonality check)
    monthly_mag = df_temp.groupby('month')['magnitude'].agg(['mean', 'std']).reset_index()
    axes[1, 1].errorbar(monthly_mag['month'], monthly_mag['mean'],
                       yerr=monthly_mag['std'], fmt='o-', capsize=5, color='purple')
    axes[1, 1].set_title('Average Magnitude by Month', fontweight='bold')
    axes[1, 1].set_xlabel('Month')
    axes[1, 1].set_ylabel('Average Magnitude')
    axes[1, 1].set_xticks(range(1, 13))
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/earthquake_temporal_patterns.png', dpi=300, bbox_inches='tight')
    plt.show()

analyze_temporal_patterns(df_eq)

# COMMAND ----------

def cluster_seismic_zones(df):
    """Identify seismic zones using DBSCAN clustering."""
    coords = df[['latitude', 'longitude']].values
    # DBSCAN with ~50km radius (0.5 degrees approx)
    clustering = DBSCAN(eps=0.5, min_samples=5, metric='haversine', algorithm='ball_tree')

    # Convert to radians for haversine
    coords_rad = np.radians(coords)
    df['cluster'] = clustering.fit_predict(coords_rad)

    n_clusters = len(set(df['cluster'])) - (1 if -1 in df['cluster'].values else 0)
    print(f"Identified {n_clusters} seismic clusters")

    fig, ax = plt.subplots(figsize=(14, 8))
    scatter = ax.scatter(df['longitude'], df['latitude'], c=df['cluster'],
                        s=df['magnitude'] ** 2 * 3, alpha=0.5, cmap='tab20')
    ax.set_title(f'Seismic Clusters ({n_clusters} zones identified)', fontweight='bold')
    ax.set_xlabel('Longitude')
    ax.set_ylabel('Latitude')
    ax.grid(True, alpha=0.3)
    plt.colorbar(scatter, ax=ax, label='Cluster ID')

    plt.tight_layout()
    plt.savefig('/tmp/seismic_clusters.png', dpi=300, bbox_inches='tight')
    plt.show()

    # Cluster statistics
    cluster_stats = df[df['cluster'] >= 0].groupby('cluster').agg(
        count=('event_id', 'count'),
        avg_magnitude=('magnitude', 'mean'),
        max_magnitude=('magnitude', 'max'),
        avg_depth=('depth_km', 'mean'),
        center_lat=('latitude', 'mean'),
        center_lon=('longitude', 'mean')
    ).round(2)
    print("\nTop seismic clusters:")
    print(cluster_stats.sort_values('count', ascending=False).head(10))

    return cluster_stats

cluster_stats = cluster_seismic_zones(df_eq)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Water Resource Analysis

# COMMAND ----------

def analyze_streamflow(df):
    """Analyze streamflow trends and anomalies."""
    stream_data = df[df['parameter_code'] == '00060'].copy()

    if len(stream_data) == 0:
        print("No streamflow data found.")
        return

    fig, axes = plt.subplots(2, 2, figsize=(18, 12))

    # Streamflow trends by site
    sites = stream_data['site_name'].unique()[:6]
    for site in sites:
        site_data = stream_data[stream_data['site_name'] == site]
        site_data = site_data.sort_values('measurement_date')
        label = site[:30] + '...' if len(site) > 30 else site
        axes[0, 0].plot(site_data['measurement_date'], site_data['daily_mean'],
                       alpha=0.7, linewidth=1, label=label)

    axes[0, 0].set_title('Streamflow Trends by Site', fontweight='bold')
    axes[0, 0].set_xlabel('Date')
    axes[0, 0].set_ylabel('Daily Mean Discharge (cfs)')
    axes[0, 0].legend(fontsize=7, bbox_to_anchor=(1.05, 1))
    axes[0, 0].grid(True, alpha=0.3)

    # Monthly seasonality
    stream_data['month'] = stream_data['measurement_date'].dt.month
    monthly_flow = stream_data.groupby('month')['daily_mean'].agg(['mean', 'std']).reset_index()
    axes[0, 1].bar(monthly_flow['month'], monthly_flow['mean'], yerr=monthly_flow['std'],
                  capsize=3, color='steelblue', alpha=0.7)
    axes[0, 1].set_title('Seasonal Streamflow Pattern', fontweight='bold')
    axes[0, 1].set_xlabel('Month')
    axes[0, 1].set_ylabel('Mean Discharge (cfs)')
    axes[0, 1].set_xticks(range(1, 13))
    axes[0, 1].grid(True, alpha=0.3)

    # Flood risk: compare to flood stage
    gauge_data = df[df['parameter_code'] == '00065'].copy()
    if len(gauge_data) > 0:
        gauge_data = gauge_data.dropna(subset=['daily_max', 'flood_stage_ft'])
        if len(gauge_data) > 0:
            gauge_data['above_flood'] = gauge_data['daily_max'] > gauge_data['flood_stage_ft']
            flood_pct = gauge_data['above_flood'].mean() * 100
            axes[1, 0].scatter(gauge_data['daily_mean'], gauge_data['flood_stage_ft'],
                             alpha=0.5, s=20, c=gauge_data['above_flood'].astype(int), cmap='RdYlGn_r')
            axes[1, 0].plot([0, gauge_data['daily_mean'].max()],
                           [0, gauge_data['daily_mean'].max()], 'r--', alpha=0.5)
            axes[1, 0].set_title(f'Gauge Height vs Flood Stage ({flood_pct:.1f}% above)', fontweight='bold')
            axes[1, 0].set_xlabel('Daily Mean Gauge Height (ft)')
            axes[1, 0].set_ylabel('Flood Stage (ft)')
            axes[1, 0].grid(True, alpha=0.3)

    # Discharge distribution
    axes[1, 1].hist(np.log10(stream_data['daily_mean'].clip(lower=0.1)), bins=40,
                   edgecolor='black', alpha=0.7, color='teal')
    axes[1, 1].set_title('Log10 Discharge Distribution', fontweight='bold')
    axes[1, 1].set_xlabel('log10(Discharge cfs)')
    axes[1, 1].set_ylabel('Count')
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/water_resource_analysis.png', dpi=300, bbox_inches='tight')
    plt.show()

analyze_streamflow(df_water)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results to Delta Lake

# COMMAND ----------

def save_hazard_results():
    """Save hazard analysis results to gold layer."""
    cluster_df = spark.createDataFrame(cluster_stats.reset_index())
    cluster_df = cluster_df.withColumn("analysis_date", current_date())

    (cluster_df.write
     .mode("overwrite")
     .option("mergeSchema", "true")
     .saveAsTable("gold.gld_seismic_clusters"))

    print("Saved seismic clusters to gold.gld_seismic_clusters")

save_hazard_results()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print("=" * 65)
print("GEOLOGICAL HAZARD ANALYSIS - SUMMARY")
print("=" * 65)
print(f"\nEarthquake Events: {len(df_eq):,}")
print(f"Magnitude range: {df_eq['magnitude'].min():.1f} - {df_eq['magnitude'].max():.1f}")
print(f"Seismic clusters identified: {len(cluster_stats)}")
print(f"\nWater Measurements: {len(df_water):,}")
print(f"Monitoring sites: {df_water['site_id'].nunique()}")
print(f"\nOutputs: gold.gld_seismic_clusters")
print("=" * 65)
