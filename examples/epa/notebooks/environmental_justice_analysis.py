# Databricks notebook source
# MAGIC %md
# MAGIC # Environmental Justice Analysis
# MAGIC
# MAGIC This notebook provides comprehensive analytics for EPA environmental justice, including:
# MAGIC - Air quality disparities across communities
# MAGIC - Water system violation patterns by demographics
# MAGIC - Toxic release inventory analysis by community characteristics
# MAGIC - Correlation between pollution burden and socioeconomic indicators
# MAGIC - Environmental compliance gap analysis
# MAGIC
# MAGIC **Data Sources:**
# MAGIC - EPA AQS air quality monitoring data (silver layer)
# MAGIC - EPA SDWIS water system violations (silver layer)
# MAGIC - EPA TRI toxic release inventory (silver layer)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup and Configuration

# COMMAND ----------

# Import required libraries
import warnings

import matplotlib.pyplot as plt
import seaborn as sns

warnings.filterwarnings('ignore')

# Statistical libraries
# Spark and Delta
from pyspark.sql.functions import *
from pyspark.sql.types import *
from scipy.stats import kruskal, spearmanr

# Configuration
plt.style.use('seaborn-v0_8')
sns.set_palette("husl")
FIGURE_DPI = 300

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading

# COMMAND ----------

# Load air quality data
def load_air_quality():
    """Load air quality monitoring data from silver layer."""

    aq_df = spark.table("silver.slv_air_quality").toPandas()

    aq_df = aq_df[
        (aq_df['site_id'].notna()) &
        (aq_df['parameter_name'].notna()) &
        (aq_df['is_valid_record'] == True)
    ].copy()

    print(f"Loaded {len(aq_df):,} air quality records")
    print(f"Parameters: {', '.join(aq_df['parameter_name'].unique())}")
    print(f"States: {aq_df['state_name'].nunique()}")

    return aq_df

df_air = load_air_quality()

# COMMAND ----------

# Load water system data
def load_water_systems():
    """Load water system violation data from silver layer."""

    water_df = spark.table("silver.slv_water_systems").toPandas()

    water_df = water_df[
        (water_df['pwsid'].notna()) &
        (water_df['is_valid_record'] == True)
    ].copy()

    print(f"Loaded {len(water_df):,} water system records")
    print(f"Systems: {water_df['pwsid'].nunique()}")

    return water_df

df_water = load_water_systems()

# COMMAND ----------

# Load toxic release data
def load_toxic_releases():
    """Load TRI data from silver layer."""

    tri_df = spark.table("silver.slv_toxic_releases").toPandas()

    tri_df = tri_df[
        (tri_df['trifid'].notna()) &
        (tri_df['is_valid_record'] == True)
    ].copy()

    print(f"Loaded {len(tri_df):,} TRI records")
    print(f"Facilities: {tri_df['trifid'].nunique()}")
    print(f"Chemicals: {tri_df['chemical_name'].nunique()}")

    return tri_df

df_tri = load_toxic_releases()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Air Quality Disparity Analysis

# COMMAND ----------

# AQI analysis by geography
def analyze_air_quality_disparities():
    """Analyze air quality disparities across regions."""

    aq = df_air.copy()

    # Filter for key pollutants
    key_pollutants = ['PM2.5', 'Ozone', 'SO2', 'CO', 'NO2']
    aq_filtered = aq[aq['parameter_name'].isin(key_pollutants)]

    # State-level AQI statistics
    state_aqi = aq_filtered.groupby(['state_name', 'parameter_name']).agg(
        avg_aqi=('aqi', 'mean'),
        max_aqi=('aqi', 'max'),
        avg_concentration=('arithmetic_mean', 'mean'),
        max_concentration=('first_max_value', 'max'),
        monitor_count=('site_id', 'nunique'),
        observation_count=('observation_count', 'sum')
    ).round(2).reset_index()

    # CBSA-level analysis
    cbsa_aqi = aq_filtered.groupby(['cbsa_name', 'parameter_name']).agg(
        avg_aqi=('aqi', 'mean'),
        max_aqi=('aqi', 'max'),
        avg_concentration=('arithmetic_mean', 'mean')
    ).round(2).reset_index()

    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Average AQI by state for PM2.5
    ax1 = axes[0, 0]
    pm25_state = state_aqi[state_aqi['parameter_name'] == 'PM2.5'].nlargest(15, 'avg_aqi')
    colors = ['#e74c3c' if a > 50 else '#f39c12' if a > 35 else '#27ae60'
              for a in pm25_state['avg_aqi']]
    ax1.barh(range(len(pm25_state)), pm25_state['avg_aqi'], color=colors, alpha=0.85)
    ax1.set_yticks(range(len(pm25_state)))
    ax1.set_yticklabels(pm25_state['state_name'])
    ax1.set_title('Top 15 States: Average PM2.5 AQI', fontsize=13, fontweight='bold')
    ax1.set_xlabel('Average AQI')
    ax1.axvline(x=50, color='red', linestyle='--', alpha=0.5, label='Moderate')
    ax1.invert_yaxis()
    ax1.legend()
    ax1.grid(True, alpha=0.3, axis='x')

    # Pollutant comparison across CBSAs
    ax2 = axes[0, 1]
    if len(cbsa_aqi) > 0:
        cbsa_pm25 = cbsa_aqi[cbsa_aqi['parameter_name'] == 'PM2.5'].nlargest(10, 'avg_aqi')
        ax2.barh(range(len(cbsa_pm25)), cbsa_pm25['avg_aqi'], color='#e74c3c', alpha=0.85)
        ax2.set_yticks(range(len(cbsa_pm25)))
        ax2.set_yticklabels(cbsa_pm25['cbsa_name'])
        ax2.set_title('Top 10 Metro Areas: PM2.5 AQI', fontsize=13, fontweight='bold')
        ax2.set_xlabel('Average AQI')
        ax2.invert_yaxis()
        ax2.grid(True, alpha=0.3, axis='x')

    # AQI distribution by pollutant
    ax3 = axes[1, 0]
    for pollutant in key_pollutants:
        subset = aq_filtered[aq_filtered['parameter_name'] == pollutant]['aqi'].dropna()
        if len(subset) > 0:
            ax3.hist(subset.clip(upper=200), bins=25, alpha=0.4, label=pollutant, density=True)
    ax3.set_title('AQI Distribution by Pollutant', fontsize=13, fontweight='bold')
    ax3.set_xlabel('AQI')
    ax3.set_ylabel('Density')
    ax3.legend()
    ax3.grid(True, alpha=0.3)

    # Monitor coverage
    ax4 = axes[1, 1]
    monitor_by_state = state_aqi.groupby('state_name')['monitor_count'].sum().sort_values(ascending=False).head(15)
    ax4.barh(range(len(monitor_by_state)), monitor_by_state.values, color='#3498db', alpha=0.85)
    ax4.set_yticks(range(len(monitor_by_state)))
    ax4.set_yticklabels(monitor_by_state.index)
    ax4.set_title('Monitor Coverage by State', fontsize=13, fontweight='bold')
    ax4.set_xlabel('Number of Monitors')
    ax4.invert_yaxis()
    ax4.grid(True, alpha=0.3, axis='x')

    plt.tight_layout()
    plt.savefig('/tmp/epa_air_quality_disparities.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

    return state_aqi

air_quality_stats = analyze_air_quality_disparities()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Water System Violation Analysis

# COMMAND ----------

# Water system violation patterns
def analyze_water_violations():
    """Analyze drinking water violation patterns."""

    water = df_water.copy()

    # Violation statistics by state
    state_violations = water.groupby('state_code').agg(
        total_violations=('violation_id', 'nunique'),
        total_systems=('pwsid', 'nunique'),
        avg_population=('population_served_count', 'mean'),
        total_pop_affected=('population_served_count', 'sum')
    ).reset_index()
    state_violations['violations_per_system'] = (
        state_violations['total_violations'] / state_violations['total_systems']
    ).round(2)

    # Contaminant analysis
    contam_stats = water.groupby('contaminant_name').agg(
        violation_count=('violation_id', 'nunique'),
        systems_affected=('pwsid', 'nunique'),
        pop_affected=('population_served_count', 'sum')
    ).sort_values('violation_count', ascending=False).reset_index()

    # System type analysis
    type_stats = water.groupby('pws_type_code').agg(
        violations=('violation_id', 'nunique'),
        systems=('pwsid', 'nunique'),
        avg_pop=('population_served_count', 'mean')
    ).reset_index()
    type_map = {'CWS': 'Community', 'NTNCWS': 'Non-Transient\nNon-Community',
                'TNCWS': 'Transient\nNon-Community'}
    type_stats['type_label'] = type_stats['pws_type_code'].map(type_map).fillna(type_stats['pws_type_code'])

    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Violations by state
    ax1 = axes[0, 0]
    top_states = state_violations.nlargest(15, 'total_violations')
    ax1.barh(range(len(top_states)), top_states['total_violations'], color='#e74c3c', alpha=0.85)
    ax1.set_yticks(range(len(top_states)))
    ax1.set_yticklabels(top_states['state_code'])
    ax1.set_title('Top 15 States by Water Violations', fontsize=13, fontweight='bold')
    ax1.set_xlabel('Total Violations')
    ax1.invert_yaxis()
    ax1.grid(True, alpha=0.3, axis='x')

    # Top contaminants
    ax2 = axes[0, 1]
    top_contam = contam_stats.head(10)
    ax2.barh(range(len(top_contam)), top_contam['violation_count'], color='#8e44ad', alpha=0.85)
    ax2.set_yticks(range(len(top_contam)))
    ax2.set_yticklabels(top_contam['contaminant_name'])
    ax2.set_title('Top 10 Contaminants by Violation Count', fontsize=13, fontweight='bold')
    ax2.set_xlabel('Violations')
    ax2.invert_yaxis()
    ax2.grid(True, alpha=0.3, axis='x')

    # Violations by system type
    ax3 = axes[1, 0]
    ax3.bar(range(len(type_stats)), type_stats['violations'],
            color=['#3498db', '#e67e22', '#27ae60'][:len(type_stats)], alpha=0.85)
    ax3.set_xticks(range(len(type_stats)))
    ax3.set_xticklabels(type_stats['type_label'])
    ax3.set_title('Violations by System Type', fontsize=13, fontweight='bold')
    ax3.set_ylabel('Total Violations')
    ax3.grid(True, alpha=0.3, axis='y')

    # Violations per system (rate)
    ax4 = axes[1, 1]
    top_rate = state_violations.nlargest(15, 'violations_per_system')
    colors = ['#e74c3c' if r > 3 else '#f39c12' if r > 1.5 else '#27ae60'
              for r in top_rate['violations_per_system']]
    ax4.barh(range(len(top_rate)), top_rate['violations_per_system'], color=colors, alpha=0.85)
    ax4.set_yticks(range(len(top_rate)))
    ax4.set_yticklabels(top_rate['state_code'])
    ax4.set_title('Violations per Water System by State', fontsize=13, fontweight='bold')
    ax4.set_xlabel('Violations / System')
    ax4.invert_yaxis()
    ax4.grid(True, alpha=0.3, axis='x')

    plt.tight_layout()
    plt.savefig('/tmp/epa_water_violations.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

    return state_violations, contam_stats

water_state_stats, contaminant_stats = analyze_water_violations()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Toxic Release Inventory Analysis

# COMMAND ----------

# TRI analysis
def analyze_toxic_releases():
    """Analyze toxic release patterns and environmental burden."""

    tri = df_tri.copy()

    # State-level releases
    state_tri = tri.groupby('state').agg(
        facility_count=('trifid', 'nunique'),
        total_releases_lbs=('total_releases', 'sum'),
        avg_releases=('total_releases', 'mean'),
        chemical_count=('chemical_name', 'nunique'),
        carcinogen_releases=('carcinogen', lambda x: tri.loc[x[x == True].index, 'total_releases'].sum()),
        avg_employees=('number_of_employees', 'mean')
    ).round(0).reset_index()

    # Chemical analysis
    chem_stats = tri.groupby('chemical_name').agg(
        facility_count=('trifid', 'nunique'),
        total_releases=('total_releases', 'sum'),
        is_carcinogen=('carcinogen', 'first'),
        is_pfas=('pfas_chemical', 'first')
    ).sort_values('total_releases', ascending=False).reset_index()

    # Release medium breakdown
    medium_totals = {
        'Fugitive Air': tri['fugitive_air'].sum(),
        'Stack Air': tri['stack_air'].sum(),
        'Water': tri['water_discharge'].sum(),
        'Land': tri['land_disposal'].sum(),
        'Underground': tri['underground_injection'].sum(),
        'Offsite Transfer': tri['offsite_transfer'].sum()
    }

    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Total releases by state
    ax1 = axes[0, 0]
    top_states = state_tri.nlargest(15, 'total_releases_lbs')
    ax1.barh(range(len(top_states)), top_states['total_releases_lbs'] / 1e6,
             color='#e74c3c', alpha=0.85)
    ax1.set_yticks(range(len(top_states)))
    ax1.set_yticklabels(top_states['state'])
    ax1.set_title('Top 15 States: Total Toxic Releases', fontsize=13, fontweight='bold')
    ax1.set_xlabel('Total Releases (Million lbs)')
    ax1.invert_yaxis()
    ax1.grid(True, alpha=0.3, axis='x')

    # Release by medium
    ax2 = axes[0, 1]
    mediums = list(medium_totals.keys())
    values = [medium_totals[m] / 1e6 for m in mediums]
    colors = ['#3498db', '#e67e22', '#2ecc71', '#9b59b6', '#f1c40f', '#e74c3c']
    ax2.bar(range(len(mediums)), values, color=colors[:len(mediums)], alpha=0.85)
    ax2.set_xticks(range(len(mediums)))
    ax2.set_xticklabels(mediums, rotation=30, ha='right')
    ax2.set_title('Total Releases by Medium', fontsize=13, fontweight='bold')
    ax2.set_ylabel('Releases (Million lbs)')
    ax2.grid(True, alpha=0.3, axis='y')

    # Top chemicals
    ax3 = axes[1, 0]
    top_chems = chem_stats.head(10)
    colors_chem = ['#e74c3c' if c else '#3498db' for c in top_chems['is_carcinogen']]
    ax3.barh(range(len(top_chems)), top_chems['total_releases'] / 1e6,
             color=colors_chem, alpha=0.85)
    ax3.set_yticks(range(len(top_chems)))
    ax3.set_yticklabels(top_chems['chemical_name'])
    ax3.set_title('Top 10 Chemicals (Red=Carcinogen)', fontsize=13, fontweight='bold')
    ax3.set_xlabel('Total Releases (Million lbs)')
    ax3.invert_yaxis()
    ax3.grid(True, alpha=0.3, axis='x')

    # Carcinogen vs non-carcinogen
    ax4 = axes[1, 1]
    carc_total = tri[tri['carcinogen'] == True]['total_releases'].sum()
    non_carc_total = tri[tri['carcinogen'] != True]['total_releases'].sum()
    pfas_total = tri[tri['pfas_chemical'] == True]['total_releases'].sum()
    categories = ['Carcinogen', 'Non-Carcinogen', 'PFAS']
    values_cat = [carc_total / 1e6, non_carc_total / 1e6, pfas_total / 1e6]
    ax4.bar(categories, values_cat, color=['#e74c3c', '#27ae60', '#8e44ad'], alpha=0.85)
    ax4.set_title('Releases by Chemical Category', fontsize=13, fontweight='bold')
    ax4.set_ylabel('Total Releases (Million lbs)')
    ax4.grid(True, alpha=0.3, axis='y')

    plt.tight_layout()
    plt.savefig('/tmp/epa_toxic_releases.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

    return state_tri, chem_stats

tri_state_stats, chemical_stats = analyze_toxic_releases()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cross-Domain Environmental Burden Analysis

# COMMAND ----------

# Combine environmental burden indicators by state
def analyze_cumulative_burden():
    """Analyze cumulative environmental burden by state."""

    # Air quality burden
    air_burden = df_air.groupby('state_code').agg(
        avg_aqi=('aqi', 'mean'),
        max_aqi=('aqi', 'max')
    ).reset_index()
    air_burden.columns = ['state', 'air_avg_aqi', 'air_max_aqi']

    # Water burden
    water_burden = df_water.groupby('state_code').agg(
        water_violations=('violation_id', 'nunique'),
        water_systems=('pwsid', 'nunique')
    ).reset_index()
    water_burden['violations_per_system'] = (
        water_burden['water_violations'] / water_burden['water_systems']
    ).round(2)
    water_burden.columns = ['state', 'water_violations', 'water_systems', 'water_viol_rate']

    # TRI burden
    tri_burden = df_tri.groupby('state').agg(
        tri_facilities=('trifid', 'nunique'),
        tri_total_releases=('total_releases', 'sum')
    ).reset_index()

    # Merge all indicators
    burden = air_burden.merge(water_burden, on='state', how='outer')
    burden = burden.merge(tri_burden, on='state', how='outer')
    burden = burden.fillna(0)

    # Normalize each metric to 0-100 scale for comparison
    for col in ['air_avg_aqi', 'water_viol_rate', 'tri_total_releases']:
        max_val = burden[col].max()
        if max_val > 0:
            burden[f'{col}_norm'] = (burden[col] / max_val * 100).round(1)
        else:
            burden[f'{col}_norm'] = 0

    burden['cumulative_burden'] = (
        burden.get('air_avg_aqi_norm', 0) +
        burden.get('water_viol_rate_norm', 0) +
        burden.get('tri_total_releases_norm', 0)
    ) / 3

    burden = burden.sort_values('cumulative_burden', ascending=False)

    fig, axes = plt.subplots(1, 2, figsize=(16, 7))

    # Top burdened states
    ax1 = axes[0]
    top = burden.head(15)
    ax1.barh(range(len(top)), top['cumulative_burden'], color='#c0392b', alpha=0.85)
    ax1.set_yticks(range(len(top)))
    ax1.set_yticklabels(top['state'])
    ax1.set_title('Cumulative Environmental Burden by State', fontsize=13, fontweight='bold')
    ax1.set_xlabel('Burden Score (0-100)')
    ax1.invert_yaxis()
    ax1.grid(True, alpha=0.3, axis='x')

    # Stacked components for top states
    ax2 = axes[1]
    top10 = burden.head(10)
    x = range(len(top10))
    ax2.bar(x, top10.get('air_avg_aqi_norm', 0), label='Air Quality', color='#e74c3c', alpha=0.85)
    ax2.bar(x, top10.get('water_viol_rate_norm', 0),
            bottom=top10.get('air_avg_aqi_norm', 0),
            label='Water Violations', color='#3498db', alpha=0.85)
    bottom2 = top10.get('air_avg_aqi_norm', 0) + top10.get('water_viol_rate_norm', 0)
    ax2.bar(x, top10.get('tri_total_releases_norm', 0),
            bottom=bottom2, label='Toxic Releases', color='#27ae60', alpha=0.85)
    ax2.set_xticks(x)
    ax2.set_xticklabels(top10['state'], rotation=45, ha='right')
    ax2.set_title('Environmental Burden Components', fontsize=13, fontweight='bold')
    ax2.set_ylabel('Normalized Score')
    ax2.legend()
    ax2.grid(True, alpha=0.3, axis='y')

    plt.tight_layout()
    plt.savefig('/tmp/epa_environmental_burden.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

    return burden

burden_scores = analyze_cumulative_burden()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Statistical Tests

# COMMAND ----------

def perform_statistical_tests():
    """Perform environmental justice statistical tests."""

    results = {}

    # Test 1: AQI differences between states (Kruskal-Wallis)
    aq_groups = [g['aqi'].dropna().values for _, g in df_air.groupby('state_name')]
    aq_groups = [g for g in aq_groups if len(g) > 0]
    if len(aq_groups) >= 2:
        stat, p = kruskal(*aq_groups[:20])  # Limit for computational efficiency
        results['AQI State Differences'] = {'H-statistic': stat, 'p_value': p}

    # Test 2: Correlation between facility count and total releases
    if len(df_tri) > 5:
        state_data = df_tri.groupby('state').agg(
            facilities=('trifid', 'nunique'),
            releases=('total_releases', 'sum')
        ).reset_index()
        if len(state_data) > 2:
            r, p = spearmanr(state_data['facilities'], state_data['releases'])
            results['Facility Count vs Releases'] = {'spearman_r': r, 'p_value': p}

    # Test 3: Carcinogen vs non-carcinogen release quantities
    carc = df_tri[df_tri['carcinogen'] == True]['total_releases'].dropna()
    non_carc = df_tri[df_tri['carcinogen'] != True]['total_releases'].dropna()
    if len(carc) > 0 and len(non_carc) > 0:
        from scipy.stats import mannwhitneyu
        stat, p = mannwhitneyu(carc, non_carc, alternative='two-sided')
        results['Carcinogen vs Non-Carcinogen'] = {'U-statistic': stat, 'p_value': p}

    print("\n" + "=" * 60)
    print("ENVIRONMENTAL JUSTICE STATISTICAL TESTS")
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

def save_results_to_delta():
    """Save environmental justice analysis results to gold layer."""

    # Air quality stats
    aq_spark = spark.createDataFrame(air_quality_stats)
    aq_spark = aq_spark.withColumn("analysis_date", current_date())
    (aq_spark.write.mode("overwrite").option("mergeSchema", "true")
     .saveAsTable("gold.gld_air_quality_by_state"))

    # Water violations
    ws_spark = spark.createDataFrame(water_state_stats)
    ws_spark = ws_spark.withColumn("analysis_date", current_date())
    (ws_spark.write.mode("overwrite").option("mergeSchema", "true")
     .saveAsTable("gold.gld_water_violations_by_state"))

    # TRI statistics
    tri_spark = spark.createDataFrame(tri_state_stats)
    tri_spark = tri_spark.withColumn("analysis_date", current_date())
    (tri_spark.write.mode("overwrite").option("mergeSchema", "true")
     .saveAsTable("gold.gld_toxic_releases_by_state"))

    # Environmental burden
    burden_spark = spark.createDataFrame(burden_scores)
    burden_spark = burden_spark.withColumn("analysis_date", current_date())
    (burden_spark.write.mode("overwrite").option("mergeSchema", "true")
     .saveAsTable("gold.gld_environmental_burden_scores"))

    print("Results saved to gold layer:")
    print("  - gold.gld_air_quality_by_state")
    print("  - gold.gld_water_violations_by_state")
    print("  - gold.gld_toxic_releases_by_state")
    print("  - gold.gld_environmental_burden_scores")

save_results_to_delta()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary Report

# COMMAND ----------

print("=" * 60)
print("ENVIRONMENTAL JUSTICE ANALYSIS - SUMMARY REPORT")
print("=" * 60)

print("\nAir Quality:")
print(f"  Total records: {len(df_air):,}")
print(f"  States monitored: {df_air['state_name'].nunique()}")
print(f"  Average AQI: {df_air['aqi'].mean():.1f}")
print(f"  Max AQI observed: {df_air['aqi'].max():.0f}")

print("\nWater Systems:")
print(f"  Total violations: {len(df_water):,}")
print(f"  Systems affected: {df_water['pwsid'].nunique()}")
print(f"  Contaminants: {df_water['contaminant_name'].nunique()}")

print("\nToxic Release Inventory:")
print(f"  TRI facilities: {df_tri['trifid'].nunique()}")
print(f"  Chemicals tracked: {df_tri['chemical_name'].nunique()}")
print(f"  Total releases: {df_tri['total_releases'].sum():,.0f} lbs")

carc_pct = (df_tri['carcinogen'] == True).sum() / len(df_tri) * 100
pfas_pct = (df_tri['pfas_chemical'] == True).sum() / len(df_tri) * 100
print(f"  Carcinogen releases: {carc_pct:.1f}% of records")
print(f"  PFAS releases: {pfas_pct:.1f}% of records")

print("\nRecommendations:")
print("  1. Prioritize air quality monitoring in high-burden states")
print("  2. Focus drinking water enforcement on underperforming systems")
print("  3. Target PFAS and carcinogen source reduction programs")
print("  4. Develop cumulative impact screening tools for permitting")
print("  5. Increase environmental monitoring in underserved communities")

print("\nOutputs:")
print("  - gold.gld_air_quality_by_state")
print("  - gold.gld_water_violations_by_state")
print("  - gold.gld_toxic_releases_by_state")
print("  - gold.gld_environmental_burden_scores")
print("  - Visualizations: /tmp/epa_*.png")

print("=" * 60)
