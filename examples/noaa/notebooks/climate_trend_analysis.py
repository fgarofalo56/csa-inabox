# Databricks notebook source
# MAGIC %md
# MAGIC # Climate Trend Analysis
# MAGIC
# MAGIC This notebook provides comprehensive analytics for NOAA climate and weather data, including:
# MAGIC - Long-term temperature and precipitation trend analysis
# MAGIC - Extreme weather event frequency and severity tracking
# MAGIC - Station-level climate variability assessment
# MAGIC - Ocean buoy observations and sea surface temperature trends
# MAGIC - Seasonal decomposition and anomaly detection
# MAGIC
# MAGIC **Data Sources:**
# MAGIC - NOAA GHCN-Daily weather observations (silver layer)
# MAGIC - NOAA Storm Events database (silver layer)
# MAGIC - NDBC ocean buoy observations (silver layer)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup and Configuration

# COMMAND ----------

# Import required libraries
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
from datetime import datetime, timedelta
import warnings
warnings.filterwarnings('ignore')

# Statistical libraries
from scipy import stats
from scipy.stats import mannwhitneyu, kruskal
import statsmodels.api as sm
from statsmodels.tsa.seasonal import seasonal_decompose

# Spark and Delta libraries
from pyspark.sql import SparkSession
from pyspark.sql.functions import *
from pyspark.sql.types import *

# Configuration
plt.style.use('seaborn-v0_8')
sns.set_palette("husl")
FIGURE_DPI = 300

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading and Preparation

# COMMAND ----------

# Load weather station observations
def load_weather_data():
    """Load weather observation data from silver layer."""

    weather_df = spark.table("silver.slv_weather_stations").toPandas()

    weather_df = weather_df[
        (weather_df['station_id'].notna()) &
        (weather_df['observation_date'].notna()) &
        (weather_df['is_valid_record'] == True)
    ].copy()

    weather_df['observation_date'] = pd.to_datetime(weather_df['observation_date'], errors='coerce')

    print(f"Loaded {len(weather_df):,} weather observations")
    print(f"Stations: {weather_df['station_id'].nunique()}")
    print(f"Elements: {', '.join(weather_df['element'].unique())}")
    print(f"Date range: {weather_df['observation_date'].min()} to {weather_df['observation_date'].max()}")

    return weather_df

df_weather = load_weather_data()

# COMMAND ----------

# Load storm events
def load_storm_data():
    """Load storm event data from silver layer."""

    storm_df = spark.table("silver.slv_storm_events").toPandas()

    storm_df = storm_df[
        (storm_df['event_id'].notna()) &
        (storm_df['begin_date'].notna()) &
        (storm_df['is_valid_record'] == True)
    ].copy()

    storm_df['begin_date'] = pd.to_datetime(storm_df['begin_date'], errors='coerce')
    storm_df['end_date'] = pd.to_datetime(storm_df['end_date'], errors='coerce')

    print(f"Loaded {len(storm_df):,} storm events")
    print(f"Event types: {storm_df['event_type'].nunique()}")
    print(f"States: {storm_df['state'].nunique()}")

    return storm_df

df_storms = load_storm_data()

# COMMAND ----------

# Load ocean buoy data
def load_buoy_data():
    """Load ocean buoy observation data from silver layer."""

    buoy_df = spark.table("silver.slv_ocean_buoys").toPandas()

    buoy_df = buoy_df[
        (buoy_df['station_id'].notna()) &
        (buoy_df['observation_date'].notna()) &
        (buoy_df['is_valid_record'] == True)
    ].copy()

    buoy_df['observation_date'] = pd.to_datetime(buoy_df['observation_date'], errors='coerce')

    print(f"Loaded {len(buoy_df):,} buoy observations")
    print(f"Buoys: {buoy_df['station_id'].nunique()}")

    return buoy_df

df_buoys = load_buoy_data()

# COMMAND ----------

# Prepare weather data
def prepare_weather_data(df):
    """Pivot and enrich weather observations for analysis."""

    df_clean = df.copy()

    # Pivot elements to columns (TMAX, TMIN, PRCP, SNOW, etc.)
    # GHCN values are in tenths of degrees C for temp, tenths of mm for precip
    pivot = df_clean.pivot_table(
        index=['station_id', 'station_name', 'observation_date', 'state_code', 'latitude', 'longitude'],
        columns='element',
        values='value',
        aggfunc='first'
    ).reset_index()

    pivot.columns.name = None

    # Convert units: TMAX/TMIN from tenths of C to C
    for col in ['TMAX', 'TMIN']:
        if col in pivot.columns:
            pivot[col] = pivot[col] / 10.0

    # PRCP from tenths of mm to mm
    if 'PRCP' in pivot.columns:
        pivot['PRCP'] = pivot['PRCP'] / 10.0

    # SNOW from mm to mm (already correct)

    # Derived features
    if 'TMAX' in pivot.columns and 'TMIN' in pivot.columns:
        pivot['TAVG'] = (pivot['TMAX'] + pivot['TMIN']) / 2.0
        pivot['TRANGE'] = pivot['TMAX'] - pivot['TMIN']

    pivot['year'] = pivot['observation_date'].dt.year
    pivot['month'] = pivot['observation_date'].dt.month
    pivot['season'] = pivot['month'].map({
        12: 'Winter', 1: 'Winter', 2: 'Winter',
        3: 'Spring', 4: 'Spring', 5: 'Spring',
        6: 'Summer', 7: 'Summer', 8: 'Summer',
        9: 'Fall', 10: 'Fall', 11: 'Fall'
    })

    print(f"Prepared {len(pivot):,} observation records across {pivot['station_id'].nunique()} stations")

    return pivot

df_prepared = prepare_weather_data(df_weather)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Temperature Trend Analysis

# COMMAND ----------

# National temperature trends
def analyze_temperature_trends():
    """Analyze long-term temperature trends."""

    if 'TAVG' not in df_prepared.columns:
        print("TAVG not available in data")
        return None

    # Monthly national average
    monthly_avg = df_prepared.groupby(['year', 'month']).agg(
        avg_temp=('TAVG', 'mean'),
        max_temp=('TMAX', 'max'),
        min_temp=('TMIN', 'min'),
        avg_range=('TRANGE', 'mean'),
        station_count=('station_id', 'nunique')
    ).round(2).reset_index()

    # Annual averages
    annual_avg = df_prepared.groupby('year').agg(
        avg_temp=('TAVG', 'mean'),
        avg_tmax=('TMAX', 'mean'),
        avg_tmin=('TMIN', 'mean'),
        station_count=('station_id', 'nunique')
    ).round(2).reset_index()

    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Annual average temperature trend
    ax1 = axes[0, 0]
    ax1.plot(annual_avg['year'], annual_avg['avg_temp'], marker='o', linewidth=2, color='#e74c3c')
    if len(annual_avg) > 2:
        z = np.polyfit(annual_avg['year'], annual_avg['avg_temp'], 1)
        p = np.poly1d(z)
        ax1.plot(annual_avg['year'], p(annual_avg['year']), '--', color='darkred', linewidth=2)
        slope = z[0]
        ax1.text(0.05, 0.95, f"Trend: {slope:.3f} C/year", transform=ax1.transAxes,
                va='top', bbox=dict(facecolor='white', alpha=0.8))
    ax1.set_title('Annual Average Temperature Trend', fontsize=14, fontweight='bold')
    ax1.set_xlabel('Year')
    ax1.set_ylabel('Temperature (C)')
    ax1.grid(True, alpha=0.3)

    # Monthly temperature pattern
    ax2 = axes[0, 1]
    month_avg = df_prepared.groupby('month')['TAVG'].agg(['mean', 'std']).reset_index()
    month_names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    ax2.bar(range(12), month_avg['mean'], yerr=month_avg['std'],
            capsize=3, color='#3498db', alpha=0.85)
    ax2.set_xticks(range(12))
    ax2.set_xticklabels(month_names)
    ax2.set_title('Monthly Temperature Pattern', fontsize=14, fontweight='bold')
    ax2.set_ylabel('Avg Temperature (C)')
    ax2.grid(True, alpha=0.3, axis='y')

    # Temperature range over time
    ax3 = axes[1, 0]
    ax3.fill_between(annual_avg['year'], annual_avg['avg_tmin'], annual_avg['avg_tmax'],
                     alpha=0.3, color='#e74c3c')
    ax3.plot(annual_avg['year'], annual_avg['avg_tmax'], label='Avg Max', color='red')
    ax3.plot(annual_avg['year'], annual_avg['avg_tmin'], label='Avg Min', color='blue')
    ax3.set_title('Temperature Range Over Time', fontsize=14, fontweight='bold')
    ax3.set_xlabel('Year')
    ax3.set_ylabel('Temperature (C)')
    ax3.legend()
    ax3.grid(True, alpha=0.3)

    # Station-level temperature by state
    ax4 = axes[1, 1]
    state_temp = df_prepared.groupby('state_code')['TAVG'].mean().sort_values()
    top_states = pd.concat([state_temp.head(5), state_temp.tail(5)])
    colors = ['#3498db'] * 5 + ['#e74c3c'] * 5
    ax4.barh(range(len(top_states)), top_states.values, color=colors, alpha=0.85)
    ax4.set_yticks(range(len(top_states)))
    ax4.set_yticklabels(top_states.index)
    ax4.set_title('Coldest and Warmest States (Avg Temp)', fontsize=14, fontweight='bold')
    ax4.set_xlabel('Average Temperature (C)')
    ax4.grid(True, alpha=0.3, axis='x')

    plt.tight_layout()
    plt.savefig('/tmp/noaa_temperature_trends.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

    return annual_avg

annual_temp = analyze_temperature_trends()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Precipitation Analysis

# COMMAND ----------

# Precipitation patterns
def analyze_precipitation():
    """Analyze precipitation patterns and extremes."""

    if 'PRCP' not in df_prepared.columns:
        print("PRCP not available in data")
        return None

    precip = df_prepared[df_prepared['PRCP'].notna()].copy()

    # Monthly precipitation
    monthly_precip = precip.groupby(['year', 'month'])['PRCP'].agg(['sum', 'mean', 'max']).reset_index()
    monthly_precip.columns = ['year', 'month', 'total_precip', 'avg_precip', 'max_precip']

    # Seasonal totals
    seasonal = precip.groupby('season')['PRCP'].agg(['sum', 'mean', 'count']).round(2).reset_index()
    seasonal.columns = ['season', 'total_precip', 'avg_daily_precip', 'obs_count']

    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Monthly average precipitation
    ax1 = axes[0, 0]
    month_avg = precip.groupby('month')['PRCP'].mean()
    month_names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    ax1.bar(range(len(month_avg)), month_avg.values, color='#2980b9', alpha=0.85)
    ax1.set_xticks(range(len(month_avg)))
    ax1.set_xticklabels(month_names)
    ax1.set_title('Average Daily Precipitation by Month', fontsize=14, fontweight='bold')
    ax1.set_ylabel('Precipitation (mm)')
    ax1.grid(True, alpha=0.3, axis='y')

    # Seasonal distribution
    ax2 = axes[0, 1]
    season_order = ['Winter', 'Spring', 'Summer', 'Fall']
    seasonal_sorted = seasonal.set_index('season').reindex(season_order).reset_index()
    ax2.bar(range(len(seasonal_sorted)), seasonal_sorted['avg_daily_precip'],
            color=['#3498db', '#2ecc71', '#f1c40f', '#e67e22'], alpha=0.85)
    ax2.set_xticks(range(len(seasonal_sorted)))
    ax2.set_xticklabels(seasonal_sorted['season'])
    ax2.set_title('Average Daily Precipitation by Season', fontsize=14, fontweight='bold')
    ax2.set_ylabel('Avg Daily Precipitation (mm)')
    ax2.grid(True, alpha=0.3, axis='y')

    # Precipitation intensity distribution
    ax3 = axes[1, 0]
    precip_nonzero = precip[precip['PRCP'] > 0]['PRCP']
    ax3.hist(precip_nonzero.clip(upper=50), bins=30, color='#2980b9', alpha=0.85, edgecolor='black')
    ax3.set_title('Precipitation Intensity Distribution (Rain Days)', fontsize=14, fontweight='bold')
    ax3.set_xlabel('Precipitation (mm)')
    ax3.set_ylabel('Frequency')
    ax3.grid(True, alpha=0.3)

    # Heavy precipitation days count by state
    ax4 = axes[1, 1]
    heavy_rain = precip[precip['PRCP'] >= 25.4]  # >= 1 inch
    state_heavy = heavy_rain.groupby('state_code').size().sort_values(ascending=False).head(10)
    ax4.barh(range(len(state_heavy)), state_heavy.values, color='#c0392b', alpha=0.85)
    ax4.set_yticks(range(len(state_heavy)))
    ax4.set_yticklabels(state_heavy.index)
    ax4.set_title('Top 10 States: Heavy Rain Days (>1 inch)', fontsize=14, fontweight='bold')
    ax4.set_xlabel('Number of Heavy Rain Days')
    ax4.invert_yaxis()
    ax4.grid(True, alpha=0.3, axis='x')

    plt.tight_layout()
    plt.savefig('/tmp/noaa_precipitation.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

    return monthly_precip

monthly_precip = analyze_precipitation()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Storm Event Analysis

# COMMAND ----------

# Storm events frequency and severity
def analyze_storm_events():
    """Analyze storm event patterns and severity."""

    storms = df_storms.copy()
    storms['begin_month'] = storms['begin_date'].dt.month
    storms['begin_year'] = storms['begin_date'].dt.year

    # Parse damage values (handle K/M/B suffixes)
    def parse_damage(val):
        if pd.isna(val) or val == '' or val == '0':
            return 0.0
        val = str(val).upper().strip()
        try:
            if val.endswith('K'):
                return float(val[:-1]) * 1000
            elif val.endswith('M'):
                return float(val[:-1]) * 1000000
            elif val.endswith('B'):
                return float(val[:-1]) * 1000000000
            else:
                return float(val)
        except (ValueError, IndexError):
            return 0.0

    storms['property_damage_val'] = storms['damage_property'].apply(parse_damage)
    storms['crop_damage_val'] = storms['damage_crops'].apply(parse_damage)
    storms['total_damage'] = storms['property_damage_val'] + storms['crop_damage_val']
    storms['total_casualties'] = (storms['injuries_direct'].fillna(0) +
                                   storms['injuries_indirect'].fillna(0) +
                                   storms['deaths_direct'].fillna(0) +
                                   storms['deaths_indirect'].fillna(0))

    # Event type statistics
    event_stats = storms.groupby('event_type').agg(
        count=('event_id', 'count'),
        total_damage=('total_damage', 'sum'),
        total_casualties=('total_casualties', 'sum'),
        avg_damage=('total_damage', 'mean')
    ).round(0).sort_values('count', ascending=False).reset_index()

    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Top event types by frequency
    ax1 = axes[0, 0]
    top_events = event_stats.head(10)
    ax1.barh(range(len(top_events)), top_events['count'], color='#e67e22', alpha=0.85)
    ax1.set_yticks(range(len(top_events)))
    ax1.set_yticklabels(top_events['event_type'])
    ax1.set_title('Top 10 Storm Event Types (by Frequency)', fontsize=14, fontweight='bold')
    ax1.set_xlabel('Number of Events')
    ax1.invert_yaxis()
    ax1.grid(True, alpha=0.3, axis='x')

    # Events by month
    ax2 = axes[0, 1]
    monthly_events = storms.groupby('begin_month').size()
    month_names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    ax2.bar(range(12), [monthly_events.get(m+1, 0) for m in range(12)],
            color='#c0392b', alpha=0.85)
    ax2.set_xticks(range(12))
    ax2.set_xticklabels(month_names)
    ax2.set_title('Storm Events by Month', fontsize=14, fontweight='bold')
    ax2.set_ylabel('Number of Events')
    ax2.grid(True, alpha=0.3, axis='y')

    # Top event types by total damage
    ax3 = axes[1, 0]
    top_damage = event_stats[event_stats['total_damage'] > 0].nlargest(10, 'total_damage')
    ax3.barh(range(len(top_damage)), top_damage['total_damage'] / 1e6,
             color='#8e44ad', alpha=0.85)
    ax3.set_yticks(range(len(top_damage)))
    ax3.set_yticklabels(top_damage['event_type'])
    ax3.set_title('Storm Types by Total Damage ($M)', fontsize=14, fontweight='bold')
    ax3.set_xlabel('Total Damage ($ Millions)')
    ax3.invert_yaxis()
    ax3.grid(True, alpha=0.3, axis='x')

    # Casualties by event type
    ax4 = axes[1, 1]
    top_casualty = event_stats[event_stats['total_casualties'] > 0].nlargest(10, 'total_casualties')
    ax4.barh(range(len(top_casualty)), top_casualty['total_casualties'],
             color='#e74c3c', alpha=0.85)
    ax4.set_yticks(range(len(top_casualty)))
    ax4.set_yticklabels(top_casualty['event_type'])
    ax4.set_title('Storm Types by Total Casualties', fontsize=14, fontweight='bold')
    ax4.set_xlabel('Total Injuries + Deaths')
    ax4.invert_yaxis()
    ax4.grid(True, alpha=0.3, axis='x')

    plt.tight_layout()
    plt.savefig('/tmp/noaa_storm_events.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

    return event_stats

storm_stats = analyze_storm_events()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Ocean Buoy Analysis

# COMMAND ----------

# Sea surface temperature and wave analysis
def analyze_buoy_data():
    """Analyze ocean buoy observations."""

    buoys = df_buoys.copy()

    if len(buoys) == 0:
        print("No buoy data available")
        return None

    buoys['month'] = buoys['observation_date'].dt.month

    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # SST over time by station
    ax1 = axes[0, 0]
    if 'sea_surface_temp_c' in buoys.columns:
        valid_sst = buoys[buoys['sea_surface_temp_c'].notna() & (buoys['sea_surface_temp_c'] < 50)]
        for sid in valid_sst['station_id'].unique()[:5]:
            subset = valid_sst[valid_sst['station_id'] == sid].sort_values('observation_date')
            ax1.plot(subset['observation_date'], subset['sea_surface_temp_c'],
                     label=sid, linewidth=1.5, alpha=0.8)
        ax1.set_title('Sea Surface Temperature by Station', fontsize=14, fontweight='bold')
        ax1.set_xlabel('Date')
        ax1.set_ylabel('SST (C)')
        ax1.legend(fontsize=8)
        ax1.grid(True, alpha=0.3)

    # Wave height distribution
    ax2 = axes[0, 1]
    if 'wave_height_m' in buoys.columns:
        valid_waves = buoys[buoys['wave_height_m'].notna() & (buoys['wave_height_m'] < 30)]
        ax2.hist(valid_waves['wave_height_m'], bins=30, color='#2980b9', alpha=0.85, edgecolor='black')
        ax2.set_title('Wave Height Distribution', fontsize=14, fontweight='bold')
        ax2.set_xlabel('Significant Wave Height (m)')
        ax2.set_ylabel('Frequency')
        ax2.grid(True, alpha=0.3)

    # Wind speed over time
    ax3 = axes[1, 0]
    if 'wind_speed_ms' in buoys.columns:
        valid_wind = buoys[buoys['wind_speed_ms'].notna() & (buoys['wind_speed_ms'] < 50)]
        monthly_wind = valid_wind.groupby('month')['wind_speed_ms'].mean()
        month_names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
        ax3.bar(range(len(monthly_wind)), monthly_wind.values, color='#27ae60', alpha=0.85)
        ax3.set_xticks(range(len(monthly_wind)))
        ax3.set_xticklabels([month_names[m-1] for m in monthly_wind.index])
        ax3.set_title('Average Wind Speed by Month', fontsize=14, fontweight='bold')
        ax3.set_ylabel('Wind Speed (m/s)')
        ax3.grid(True, alpha=0.3, axis='y')

    # Pressure over time
    ax4 = axes[1, 1]
    if 'pressure_hpa' in buoys.columns:
        valid_pressure = buoys[buoys['pressure_hpa'].notna() & (buoys['pressure_hpa'] > 900)]
        for sid in valid_pressure['station_id'].unique()[:3]:
            subset = valid_pressure[valid_pressure['station_id'] == sid].sort_values('observation_date')
            ax4.plot(subset['observation_date'], subset['pressure_hpa'],
                     label=sid, linewidth=1, alpha=0.7)
        ax4.set_title('Atmospheric Pressure by Station', fontsize=14, fontweight='bold')
        ax4.set_xlabel('Date')
        ax4.set_ylabel('Pressure (hPa)')
        ax4.legend(fontsize=8)
        ax4.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/noaa_buoy_analysis.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

    return buoys

buoy_analysis = analyze_buoy_data()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Statistical Tests

# COMMAND ----------

# Climate statistical tests
def perform_statistical_tests():
    """Perform statistical tests on climate data."""

    results = {}

    # Test 1: Temperature trend significance (linear regression)
    if 'TAVG' in df_prepared.columns:
        annual = df_prepared.groupby('year')['TAVG'].mean().reset_index()
        if len(annual) > 2:
            slope, intercept, r_val, p_val, std_err = stats.linregress(annual['year'], annual['TAVG'])
            results['Temperature Trend'] = {
                'slope_per_year': slope,
                'r_squared': r_val**2,
                'p_value': p_val,
                'std_error': std_err
            }

    # Test 2: Seasonal temperature differences (Kruskal-Wallis)
    if 'TAVG' in df_prepared.columns:
        groups = [g['TAVG'].dropna().values for _, g in df_prepared.groupby('season')]
        if len(groups) >= 2 and all(len(g) > 0 for g in groups):
            stat, p = kruskal(*groups)
            results['Seasonal Temp Differences'] = {'H-statistic': stat, 'p_value': p}

    # Test 3: Precipitation trend
    if 'PRCP' in df_prepared.columns:
        annual_prcp = df_prepared.groupby('year')['PRCP'].mean().reset_index()
        if len(annual_prcp) > 2:
            slope, intercept, r_val, p_val, std_err = stats.linregress(
                annual_prcp['year'], annual_prcp['PRCP']
            )
            results['Precipitation Trend'] = {
                'slope_per_year': slope,
                'r_squared': r_val**2,
                'p_value': p_val
            }

    print("\n" + "=" * 60)
    print("CLIMATE STATISTICAL TEST RESULTS")
    print("=" * 60)
    for name, result in results.items():
        print(f"\n{name}:")
        for k, v in result.items():
            if isinstance(v, float):
                sig = " ***" if k == 'p_value' and v < 0.001 else \
                      " **" if k == 'p_value' and v < 0.01 else \
                      " *" if k == 'p_value' and v < 0.05 else ""
                print(f"  {k}: {v:.6f}{sig}")
            else:
                print(f"  {k}: {v}")

    return results

stat_results = perform_statistical_tests()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results to Delta Lake

# COMMAND ----------

# Save to gold layer
def save_results_to_delta():
    """Save climate analysis results to Delta Lake gold layer."""

    # Annual temperature stats
    if annual_temp is not None:
        temp_spark = spark.createDataFrame(annual_temp)
        temp_spark = temp_spark.withColumn("analysis_date", current_date())
        (temp_spark.write
         .mode("overwrite")
         .option("mergeSchema", "true")
         .saveAsTable("gold.gld_climate_annual_temperature"))

    # Storm event stats
    if storm_stats is not None:
        storm_spark = spark.createDataFrame(storm_stats)
        storm_spark = storm_spark.withColumn("analysis_date", current_date())
        (storm_spark.write
         .mode("overwrite")
         .option("mergeSchema", "true")
         .saveAsTable("gold.gld_storm_event_summary"))

    print("Results saved to gold layer:")
    print("  - gold.gld_climate_annual_temperature")
    print("  - gold.gld_storm_event_summary")

save_results_to_delta()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary Report

# COMMAND ----------

print("=" * 60)
print("CLIMATE TREND ANALYSIS - SUMMARY REPORT")
print("=" * 60)

print(f"\nWeather Observations:")
print(f"  Total records: {len(df_prepared):,}")
print(f"  Stations: {df_prepared['station_id'].nunique()}")
print(f"  States: {df_prepared['state_code'].nunique()}")

if 'TAVG' in df_prepared.columns:
    print(f"\nTemperature Summary:")
    print(f"  Overall avg temp: {df_prepared['TAVG'].mean():.1f} C")
    print(f"  Max recorded: {df_prepared['TMAX'].max():.1f} C")
    print(f"  Min recorded: {df_prepared['TMIN'].min():.1f} C")

if 'PRCP' in df_prepared.columns:
    print(f"\nPrecipitation Summary:")
    print(f"  Avg daily precip: {df_prepared['PRCP'].mean():.1f} mm")
    print(f"  Max daily precip: {df_prepared['PRCP'].max():.1f} mm")
    rain_days = (df_prepared['PRCP'] > 0).sum()
    total_days = len(df_prepared)
    print(f"  Rain day frequency: {rain_days/total_days*100:.1f}%")

print(f"\nStorm Events:")
print(f"  Total events: {len(df_storms):,}")
print(f"  Event types: {df_storms['event_type'].nunique()}")

print(f"\nOcean Buoys:")
print(f"  Total observations: {len(df_buoys):,}")
print(f"  Stations: {df_buoys['station_id'].nunique()}")

print(f"\nRecommendations:")
print(f"  1. Monitor temperature trends for long-term climate planning")
print(f"  2. Track severe storm frequency increases for emergency preparedness")
print(f"  3. Correlate SST anomalies with coastal storm patterns")
print(f"  4. Integrate drought indices for agricultural impact assessment")

print(f"\nOutputs:")
print(f"  - Analysis tables saved to gold layer")
print(f"  - Visualizations saved to /tmp/noaa_*.png")

print("=" * 60)
