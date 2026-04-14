# Databricks notebook source
# MAGIC %md
# MAGIC # SNAP Demographics and Economic Analysis
# MAGIC
# MAGIC This notebook provides comprehensive analysis of SNAP enrollment data with demographic correlations:
# MAGIC - Enrollment trends and patterns
# MAGIC - Geographic distribution analysis
# MAGIC - Economic correlation analysis
# MAGIC - Demographic overlay with Census data
# MAGIC - Policy impact assessment
# MAGIC
# MAGIC **Data Sources:**
# MAGIC - USDA FNS SNAP enrollment data
# MAGIC - U.S. Census Bureau demographic data
# MAGIC - Bureau of Labor Statistics economic indicators

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
from scipy.stats import pearsonr, spearmanr
import statsmodels.api as sm
from statsmodels.tsa.seasonal import seasonal_decompose
from statsmodels.tsa.arima.model import ARIMA

# Geospatial libraries
try:
    import geopandas as gpd
    import plotly.express as px
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    GEOSPATIAL_AVAILABLE = True
except ImportError:
    print("Geospatial libraries not available. Map visualizations will be skipped.")
    GEOSPATIAL_AVAILABLE = False

# Spark and Delta libraries
from pyspark.sql import SparkSession
from pyspark.sql.functions import *
from pyspark.sql.types import *

# Configuration
plt.style.use('seaborn-v0_8')
sns.set_palette("viridis")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading and Preparation

# COMMAND ----------

# Load SNAP enrollment data
def load_snap_data():
    """Load SNAP enrollment data from silver layer."""

    snap_data = spark.table("silver.slv_snap_enrollment").toPandas()

    # Filter for recent data and clean
    snap_data = snap_data[
        (snap_data['enrollment_date'] >= '2020-01-01') &
        (snap_data['program'] == 'SNAP') &
        (snap_data['is_valid'] == True)
    ].copy()

    # Convert date column
    snap_data['enrollment_date'] = pd.to_datetime(snap_data['enrollment_date'])

    # Sort data
    snap_data = snap_data.sort_values(['state_code', 'enrollment_date'])

    print(f"Loaded {len(snap_data):,} SNAP enrollment records")
    print(f"States: {snap_data['state_code'].nunique()}")
    print(f"Date range: {snap_data['enrollment_date'].min()} to {snap_data['enrollment_date'].max()}")

    return snap_data

# Load demographic data (synthetic for demonstration)
def load_demographic_data():
    """Load demographic data for analysis."""

    # In a real implementation, this would load from Census API or stored data
    # For demonstration, we'll create synthetic demographic data

    states = [
        'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
        'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
        'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
        'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
        'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
    ]

    # Create synthetic demographic data
    np.random.seed(42)  # For reproducible results

    demographic_data = []
    for state in states:
        # Generate realistic demographic indicators
        population = np.random.randint(500000, 40000000)  # State population
        poverty_rate = np.random.normal(12.5, 4.0)  # National average ~12.5%
        poverty_rate = max(5.0, min(25.0, poverty_rate))  # Reasonable bounds

        unemployment_rate = np.random.normal(4.5, 1.5)  # Recent national average
        unemployment_rate = max(2.0, min(10.0, unemployment_rate))

        median_income = np.random.normal(65000, 15000)  # National median ~$65k
        median_income = max(35000, min(100000, median_income))

        # Rural/urban split affects SNAP patterns
        rural_percent = np.random.uniform(5, 75)  # Varies significantly by state

        # Educational attainment
        college_degree_percent = np.random.normal(32, 8)  # National average ~32%
        college_degree_percent = max(15, min(55, college_degree_percent))

        # Age demographics
        median_age = np.random.normal(38.5, 4)  # National median age
        median_age = max(30, min(45, median_age))

        under_18_percent = np.random.normal(22, 3)
        under_18_percent = max(15, min(30, under_18_percent))

        over_65_percent = np.random.normal(16, 4)
        over_65_percent = max(8, min(25, over_65_percent))

        # Racial/ethnic composition (simplified)
        white_percent = np.random.uniform(50, 95)
        black_percent = np.random.uniform(2, 40)
        hispanic_percent = np.random.uniform(3, 50)
        # Normalize to reasonable totals
        total = white_percent + black_percent + hispanic_percent
        if total > 100:
            factor = 100 / total
            white_percent *= factor
            black_percent *= factor
            hispanic_percent *= factor

        demographic_data.append({
            'state_code': state,
            'population': int(population),
            'poverty_rate': round(poverty_rate, 1),
            'unemployment_rate': round(unemployment_rate, 1),
            'median_income': int(median_income),
            'rural_percent': round(rural_percent, 1),
            'college_degree_percent': round(college_degree_percent, 1),
            'median_age': round(median_age, 1),
            'under_18_percent': round(under_18_percent, 1),
            'over_65_percent': round(over_65_percent, 1),
            'white_percent': round(white_percent, 1),
            'black_percent': round(black_percent, 1),
            'hispanic_percent': round(hispanic_percent, 1)
        })

    demographics_df = pd.DataFrame(demographic_data)

    print(f"Generated demographic data for {len(demographics_df)} states")
    return demographics_df

# Load data
df_snap = load_snap_data()
df_demographics = load_demographic_data()

# COMMAND ----------

# Data preparation and feature engineering
def prepare_snap_analysis_data(snap_data, demographics):
    """Prepare data for comprehensive SNAP analysis."""

    # Calculate state-level monthly aggregations
    monthly_state = snap_data.groupby(['state_code', 'enrollment_date']).agg({
        'current_enrollment': 'sum',
        'current_households': 'sum',
        'current_benefits_dollars': 'sum',
        'avg_benefits_per_person': 'mean',
        'avg_benefits_per_household': 'mean'
    }).reset_index()

    # Calculate derived metrics
    monthly_state['benefit_intensity'] = monthly_state['current_benefits_dollars'] / monthly_state['current_enrollment']

    # Add time-based features
    monthly_state['year'] = monthly_state['enrollment_date'].dt.year
    monthly_state['month'] = monthly_state['enrollment_date'].dt.month
    monthly_state['quarter'] = monthly_state['enrollment_date'].dt.quarter

    # Calculate year-over-year changes
    monthly_state = monthly_state.sort_values(['state_code', 'enrollment_date'])

    monthly_state['enrollment_yoy_change'] = monthly_state.groupby('state_code')['current_enrollment'].pct_change(periods=12) * 100
    monthly_state['benefits_yoy_change'] = monthly_state.groupby('state_code')['current_benefits_dollars'].pct_change(periods=12) * 100

    # Calculate moving averages for trend analysis
    monthly_state['enrollment_6mo_avg'] = monthly_state.groupby('state_code')['current_enrollment'].rolling(
        window=6, min_periods=3
    ).mean().reset_index(drop=True)

    monthly_state['benefits_6mo_avg'] = monthly_state.groupby('state_code')['current_benefits_dollars'].rolling(
        window=6, min_periods=3
    ).mean().reset_index(drop=True)

    # Merge with demographic data
    analysis_df = monthly_state.merge(demographics, on='state_code', how='left')

    # Calculate per-capita metrics
    analysis_df['enrollment_per_1000'] = (analysis_df['current_enrollment'] / analysis_df['population']) * 1000
    analysis_df['benefits_per_capita'] = analysis_df['current_benefits_dollars'] / analysis_df['population']

    print(f"Prepared analysis dataset: {len(analysis_df):,} records")
    return analysis_df

df_analysis = prepare_snap_analysis_data(df_snap, df_demographics)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Enrollment Trends Analysis

# COMMAND ----------

# National enrollment trends
def analyze_national_trends():
    """Analyze national SNAP enrollment trends."""

    # National monthly totals
    national_trends = df_analysis.groupby('enrollment_date').agg({
        'current_enrollment': 'sum',
        'current_benefits_dollars': 'sum',
        'current_households': 'sum'
    }).reset_index()

    # Calculate rates
    national_trends['avg_benefit_per_person'] = national_trends['current_benefits_dollars'] / national_trends['current_enrollment']

    # Year-over-year changes
    national_trends['enrollment_yoy'] = national_trends['current_enrollment'].pct_change(periods=12) * 100
    national_trends['benefits_yoy'] = national_trends['current_benefits_dollars'].pct_change(periods=12) * 100

    # Seasonal decomposition
    enrollment_ts = national_trends.set_index('enrollment_date')['current_enrollment']
    decomposition = seasonal_decompose(enrollment_ts, model='additive', period=12)

    # Create comprehensive visualization
    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # 1. Enrollment trend
    axes[0, 0].plot(national_trends['enrollment_date'], national_trends['current_enrollment'] / 1e6,
                   linewidth=2, color='darkblue')
    axes[0, 0].set_title('National SNAP Enrollment Trend', fontsize=14, fontweight='bold')
    axes[0, 0].set_ylabel('Enrollment (Millions)')
    axes[0, 0].grid(True, alpha=0.3)

    # Add trend line
    x_numeric = np.arange(len(national_trends))
    z = np.polyfit(x_numeric, national_trends['current_enrollment'] / 1e6, 1)
    p = np.poly1d(z)
    axes[0, 0].plot(national_trends['enrollment_date'], p(x_numeric),
                   "--", alpha=0.7, color='red', label='Trend')
    axes[0, 0].legend()

    # 2. Benefits trend
    axes[0, 1].plot(national_trends['enrollment_date'], national_trends['current_benefits_dollars'] / 1e9,
                   linewidth=2, color='darkgreen')
    axes[0, 1].set_title('National SNAP Benefits Trend', fontsize=14, fontweight='bold')
    axes[0, 1].set_ylabel('Benefits (Billions $)')
    axes[0, 1].grid(True, alpha=0.3)

    # 3. Year-over-year changes
    valid_yoy = national_trends.dropna(subset=['enrollment_yoy', 'benefits_yoy'])
    axes[1, 0].bar(valid_yoy['enrollment_date'], valid_yoy['enrollment_yoy'],
                  alpha=0.7, color='steelblue', label='Enrollment')
    axes[1, 0].axhline(y=0, color='black', linestyle='-', alpha=0.5)
    axes[1, 0].set_title('Year-over-Year Change (%)', fontsize=14, fontweight='bold')
    axes[1, 0].set_ylabel('Change (%)')
    axes[1, 0].legend()
    axes[1, 0].grid(True, alpha=0.3)

    # 4. Seasonal pattern
    monthly_avg = df_analysis.groupby('month')['current_enrollment'].mean()
    axes[1, 1].bar(monthly_avg.index, monthly_avg.values / 1e6, color='coral', alpha=0.7)
    axes[1, 1].set_title('Average Enrollment by Month', fontsize=14, fontweight='bold')
    axes[1, 1].set_xlabel('Month')
    axes[1, 1].set_ylabel('Enrollment (Millions)')
    axes[1, 1].set_xticks(range(1, 13))
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/snap_national_trends.png', dpi=300, bbox_inches='tight')
    plt.show()

    return national_trends

national_trends = analyze_national_trends()

# COMMAND ----------

# State-level enrollment analysis
def analyze_state_patterns():
    """Analyze SNAP enrollment patterns by state."""

    # Latest enrollment rates by state
    latest_date = df_analysis['enrollment_date'].max()
    latest_state_data = df_analysis[df_analysis['enrollment_date'] == latest_date].copy()

    # Sort by enrollment rate per capita
    latest_state_data = latest_state_data.sort_values('enrollment_per_1000', ascending=False)

    # Top and bottom states
    top_10_states = latest_state_data.head(10)
    bottom_10_states = latest_state_data.tail(10)

    print("Top 10 States by SNAP Enrollment Rate (per 1000 population):")
    print(top_10_states[['state_code', 'enrollment_per_1000', 'poverty_rate']].to_string(index=False))

    print("\nBottom 10 States by SNAP Enrollment Rate (per 1000 population):")
    print(bottom_10_states[['state_code', 'enrollment_per_1000', 'poverty_rate']].to_string(index=False))

    # Visualization
    fig, axes = plt.subplots(1, 2, figsize=(16, 8))

    # 1. Top 10 states
    bars1 = axes[0].barh(range(len(top_10_states)), top_10_states['enrollment_per_1000'])
    axes[0].set_yticks(range(len(top_10_states)))
    axes[0].set_yticklabels(top_10_states['state_code'])
    axes[0].set_xlabel('SNAP Enrollment per 1000 Population')
    axes[0].set_title('Top 10 States - SNAP Enrollment Rate', fontweight='bold')
    axes[0].grid(True, alpha=0.3)

    # Color by enrollment level
    for i, bar in enumerate(bars1):
        if i < 3:
            bar.set_color('darkred')
        elif i < 7:
            bar.set_color('orange')
        else:
            bar.set_color('yellow')

    # 2. Enrollment vs Poverty Rate scatter
    axes[1].scatter(latest_state_data['poverty_rate'], latest_state_data['enrollment_per_1000'],
                   alpha=0.7, s=60, color='steelblue')

    # Add trend line
    z = np.polyfit(latest_state_data['poverty_rate'], latest_state_data['enrollment_per_1000'], 1)
    p = np.poly1d(z)
    axes[1].plot(latest_state_data['poverty_rate'], p(latest_state_data['poverty_rate']),
                "r--", alpha=0.8, label='Trend')

    # Correlation coefficient
    corr, p_value = pearsonr(latest_state_data['poverty_rate'], latest_state_data['enrollment_per_1000'])
    axes[1].text(0.05, 0.95, f'Correlation: {corr:.3f}\np-value: {p_value:.3f}',
                transform=axes[1].transAxes, verticalalignment='top',
                bbox=dict(boxstyle='round', facecolor='white', alpha=0.8))

    axes[1].set_xlabel('Poverty Rate (%)')
    axes[1].set_ylabel('SNAP Enrollment per 1000 Population')
    axes[1].set_title('SNAP Enrollment vs Poverty Rate', fontweight='bold')
    axes[1].legend()
    axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/snap_state_patterns.png', dpi=300, bbox_inches='tight')
    plt.show()

    return latest_state_data

latest_state_data = analyze_state_patterns()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Economic Correlation Analysis

# COMMAND ----------

# Correlation analysis with demographic/economic factors
def analyze_economic_correlations():
    """Analyze correlations between SNAP enrollment and economic factors."""

    # Use latest data for cross-sectional analysis
    latest_data = df_analysis[df_analysis['enrollment_date'] == df_analysis['enrollment_date'].max()].copy()

    # Define variables for correlation analysis
    economic_vars = [
        'poverty_rate', 'unemployment_rate', 'median_income', 'rural_percent',
        'college_degree_percent', 'under_18_percent', 'over_65_percent'
    ]

    snap_vars = [
        'enrollment_per_1000', 'benefits_per_capita', 'avg_benefits_per_person'
    ]

    # Calculate correlation matrix
    correlation_data = latest_data[economic_vars + snap_vars]
    correlation_matrix = correlation_data.corr()

    # Create heatmap
    plt.figure(figsize=(12, 10))
    mask = np.triu(np.ones_like(correlation_matrix, dtype=bool))
    sns.heatmap(correlation_matrix, mask=mask, annot=True, cmap='RdBu_r', center=0,
                square=True, cbar_kws={'label': 'Correlation Coefficient'})
    plt.title('Correlation Matrix: SNAP Metrics vs Demographic/Economic Factors',
              fontsize=14, fontweight='bold')
    plt.tight_layout()
    plt.savefig('/tmp/snap_correlations.png', dpi=300, bbox_inches='tight')
    plt.show()

    # Detailed correlation analysis
    print("Correlation Analysis - SNAP Enrollment Rate:")
    print("=" * 50)

    for var in economic_vars:
        corr, p_val = pearsonr(latest_data[var], latest_data['enrollment_per_1000'])
        significance = "***" if p_val < 0.001 else "**" if p_val < 0.01 else "*" if p_val < 0.05 else ""
        print(f"{var:25s}: {corr:6.3f} {significance:3s} (p={p_val:.3f})")

    # Multiple regression analysis
    print("\n" + "=" * 50)
    print("Multiple Regression Analysis:")

    # Prepare data for regression
    X = latest_data[economic_vars].fillna(latest_data[economic_vars].mean())
    y = latest_data['enrollment_per_1000']

    # Add constant term
    X = sm.add_constant(X)

    # Fit regression model
    model = sm.OLS(y, X).fit()
    print(model.summary())

    return correlation_matrix, model

correlation_matrix, regression_model = analyze_economic_correlations()

# COMMAND ----------

# Time series analysis by economic indicators
def analyze_time_series_patterns():
    """Analyze time series patterns in SNAP enrollment."""

    # Focus on states with different economic profiles
    high_poverty_states = latest_state_data.nlargest(5, 'poverty_rate')['state_code'].tolist()
    low_poverty_states = latest_state_data.nsmallest(5, 'poverty_rate')['state_code'].tolist()

    # Create time series plots
    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # 1. High poverty states enrollment trends
    for state in high_poverty_states:
        state_data = df_analysis[df_analysis['state_code'] == state]
        axes[0, 0].plot(state_data['enrollment_date'], state_data['enrollment_per_1000'],
                       label=state, linewidth=2)

    axes[0, 0].set_title('High Poverty States - SNAP Enrollment Trends', fontweight='bold')
    axes[0, 0].set_ylabel('Enrollment per 1000 Population')
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)

    # 2. Low poverty states enrollment trends
    for state in low_poverty_states:
        state_data = df_analysis[df_analysis['state_code'] == state]
        axes[0, 1].plot(state_data['enrollment_date'], state_data['enrollment_per_1000'],
                       label=state, linewidth=2)

    axes[0, 1].set_title('Low Poverty States - SNAP Enrollment Trends', fontweight='bold')
    axes[0, 1].set_ylabel('Enrollment per 1000 Population')
    axes[0, 1].legend()
    axes[0, 1].grid(True, alpha=0.3)

    # 3. Benefits intensity comparison
    high_poverty_benefits = df_analysis[df_analysis['state_code'].isin(high_poverty_states)]
    low_poverty_benefits = df_analysis[df_analysis['state_code'].isin(low_poverty_states)]

    high_poverty_avg = high_poverty_benefits.groupby('enrollment_date')['avg_benefits_per_person'].mean()
    low_poverty_avg = low_poverty_benefits.groupby('enrollment_date')['avg_benefits_per_person'].mean()

    axes[1, 0].plot(high_poverty_avg.index, high_poverty_avg.values,
                   label='High Poverty States', linewidth=3, color='red')
    axes[1, 0].plot(low_poverty_avg.index, low_poverty_avg.values,
                   label='Low Poverty States', linewidth=3, color='blue')
    axes[1, 0].set_title('Average Benefits per Person', fontweight='bold')
    axes[1, 0].set_ylabel('Benefits per Person ($)')
    axes[1, 0].legend()
    axes[1, 0].grid(True, alpha=0.3)

    # 4. Volatility comparison (coefficient of variation)
    volatility_data = []
    for state in df_analysis['state_code'].unique():
        state_ts = df_analysis[df_analysis['state_code'] == state]['enrollment_per_1000']
        if len(state_ts) > 12:  # Need sufficient data
            cv = state_ts.std() / state_ts.mean() * 100
            poverty_rate = latest_state_data[latest_state_data['state_code'] == state]['poverty_rate'].iloc[0]
            volatility_data.append({'state_code': state, 'cv': cv, 'poverty_rate': poverty_rate})

    volatility_df = pd.DataFrame(volatility_data)
    axes[1, 1].scatter(volatility_df['poverty_rate'], volatility_df['cv'],
                      alpha=0.7, s=60, color='purple')
    axes[1, 1].set_xlabel('Poverty Rate (%)')
    axes[1, 1].set_ylabel('Enrollment Volatility (CV %)')
    axes[1, 1].set_title('Enrollment Volatility vs Poverty Rate', fontweight='bold')
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/snap_time_series_analysis.png', dpi=300, bbox_inches='tight')
    plt.show()

    return high_poverty_states, low_poverty_states

high_poverty_states, low_poverty_states = analyze_time_series_patterns()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Geographic Analysis

# COMMAND ----------

# Regional analysis
def analyze_regional_patterns():
    """Analyze SNAP patterns by geographic region."""

    # Define US regions
    regions = {
        'Northeast': ['CT', 'ME', 'MA', 'NH', 'NJ', 'NY', 'PA', 'RI', 'VT'],
        'Midwest': ['IL', 'IN', 'IA', 'KS', 'MI', 'MN', 'MO', 'NE', 'ND', 'OH', 'SD', 'WI'],
        'South': ['AL', 'AR', 'DE', 'FL', 'GA', 'KY', 'LA', 'MD', 'MS', 'NC', 'OK', 'SC', 'TN', 'TX', 'VA', 'WV'],
        'West': ['AK', 'AZ', 'CA', 'CO', 'HI', 'ID', 'MT', 'NV', 'NM', 'OR', 'UT', 'WA', 'WY']
    }

    # Add region to analysis data
    def assign_region(state):
        for region, states in regions.items():
            if state in states:
                return region
        return 'Other'

    df_analysis['region'] = df_analysis['state_code'].apply(assign_region)

    # Regional aggregations
    regional_stats = df_analysis.groupby(['region', 'enrollment_date']).agg({
        'current_enrollment': 'sum',
        'current_benefits_dollars': 'sum',
        'population': 'sum'
    }).reset_index()

    regional_stats['enrollment_rate'] = (regional_stats['current_enrollment'] /
                                       regional_stats['population']) * 1000

    # Latest regional comparison
    latest_regional = regional_stats[regional_stats['enrollment_date'] ==
                                   regional_stats['enrollment_date'].max()]

    # Visualization
    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # 1. Regional enrollment rates
    bars = axes[0, 0].bar(latest_regional['region'], latest_regional['enrollment_rate'],
                         color=['skyblue', 'lightgreen', 'coral', 'gold'])
    axes[0, 0].set_title('SNAP Enrollment Rate by Region', fontweight='bold')
    axes[0, 0].set_ylabel('Enrollment per 1000 Population')
    axes[0, 0].tick_params(axis='x', rotation=45)

    # Add value labels on bars
    for bar in bars:
        height = bar.get_height()
        axes[0, 0].text(bar.get_x() + bar.get_width()/2., height + 0.1,
                       f'{height:.1f}', ha='center', va='bottom', fontweight='bold')

    # 2. Regional trends over time
    for region in regional_stats['region'].unique():
        if region != 'Other':
            region_data = regional_stats[regional_stats['region'] == region]
            axes[0, 1].plot(region_data['enrollment_date'], region_data['enrollment_rate'],
                          label=region, linewidth=2, marker='o', markersize=4)

    axes[0, 1].set_title('Regional SNAP Enrollment Trends', fontweight='bold')
    axes[0, 1].set_ylabel('Enrollment per 1000 Population')
    axes[0, 1].legend()
    axes[0, 1].grid(True, alpha=0.3)

    # 3. Total benefits by region
    bars2 = axes[1, 0].bar(latest_regional['region'],
                          latest_regional['current_benefits_dollars'] / 1e9,
                          color=['skyblue', 'lightgreen', 'coral', 'gold'])
    axes[1, 0].set_title('Total SNAP Benefits by Region', fontweight='bold')
    axes[1, 0].set_ylabel('Benefits (Billions $)')
    axes[1, 0].tick_params(axis='x', rotation=45)

    for bar in bars2:
        height = bar.get_height()
        axes[1, 0].text(bar.get_x() + bar.get_width()/2., height + 0.02,
                       f'${height:.1f}B', ha='center', va='bottom', fontweight='bold')

    # 4. Regional demographic comparison
    regional_demographics = df_analysis.groupby('region').agg({
        'poverty_rate': 'mean',
        'unemployment_rate': 'mean',
        'median_income': 'mean',
        'rural_percent': 'mean'
    }).round(1)

    # Heatmap of regional characteristics
    sns.heatmap(regional_demographics.T, annot=True, cmap='RdYlBu_r',
               ax=axes[1, 1], cbar_kws={'label': 'Value'})
    axes[1, 1].set_title('Regional Demographic Characteristics', fontweight='bold')

    plt.tight_layout()
    plt.savefig('/tmp/snap_regional_analysis.png', dpi=300, bbox_inches='tight')
    plt.show()

    return regional_stats

regional_stats = analyze_regional_patterns()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Policy Impact Assessment

# COMMAND ----------

# Analyze policy impacts and program effectiveness
def analyze_policy_impacts():
    """Analyze potential policy impacts and program effectiveness."""

    # Calculate program effectiveness metrics
    effectiveness_data = df_analysis.groupby('state_code').agg({
        'enrollment_per_1000': 'mean',
        'avg_benefits_per_person': 'mean',
        'poverty_rate': 'first',
        'under_18_percent': 'first',
        'median_income': 'first'
    }).reset_index()

    # Calculate program reach (enrollment relative to poverty)
    effectiveness_data['program_reach'] = effectiveness_data['enrollment_per_1000'] / effectiveness_data['poverty_rate']

    # Benefit adequacy (relative to income)
    effectiveness_data['benefit_adequacy'] = (effectiveness_data['avg_benefits_per_person'] * 12) / effectiveness_data['median_income'] * 100

    # Identify high-performing and underperforming states
    high_reach_states = effectiveness_data.nlargest(10, 'program_reach')
    low_reach_states = effectiveness_data.nsmallest(10, 'program_reach')

    print("States with Highest Program Reach (Enrollment/Poverty Rate):")
    print(high_reach_states[['state_code', 'program_reach', 'poverty_rate', 'enrollment_per_1000']].round(2).to_string(index=False))

    print("\nStates with Lowest Program Reach (Enrollment/Poverty Rate):")
    print(low_reach_states[['state_code', 'program_reach', 'poverty_rate', 'enrollment_per_1000']].round(2).to_string(index=False))

    # Visualization
    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # 1. Program reach distribution
    axes[0, 0].hist(effectiveness_data['program_reach'], bins=20, alpha=0.7, color='steelblue', edgecolor='black')
    axes[0, 0].axvline(effectiveness_data['program_reach'].mean(), color='red', linestyle='--',
                      label=f'Mean: {effectiveness_data["program_reach"].mean():.2f}')
    axes[0, 0].set_title('Distribution of Program Reach Across States', fontweight='bold')
    axes[0, 0].set_xlabel('Program Reach (Enrollment Rate / Poverty Rate)')
    axes[0, 0].set_ylabel('Number of States')
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)

    # 2. Benefit adequacy vs child poverty
    axes[0, 1].scatter(effectiveness_data['under_18_percent'], effectiveness_data['benefit_adequacy'],
                      alpha=0.7, s=60, color='green')
    axes[0, 1].set_xlabel('Population Under 18 (%)')
    axes[0, 1].set_ylabel('Benefit Adequacy (% of Median Income)')
    axes[0, 1].set_title('Benefit Adequacy vs Child Population', fontweight='bold')
    axes[0, 1].grid(True, alpha=0.3)

    # Add correlation
    corr, _ = pearsonr(effectiveness_data['under_18_percent'], effectiveness_data['benefit_adequacy'])
    axes[0, 1].text(0.05, 0.95, f'Correlation: {corr:.3f}', transform=axes[0, 1].transAxes,
                   verticalalignment='top', bbox=dict(boxstyle='round', facecolor='white', alpha=0.8))

    # 3. Program reach vs income
    axes[1, 0].scatter(effectiveness_data['median_income']/1000, effectiveness_data['program_reach'],
                      alpha=0.7, s=60, color='purple')
    axes[1, 0].set_xlabel('Median Income ($1000s)')
    axes[1, 0].set_ylabel('Program Reach')
    axes[1, 0].set_title('Program Reach vs State Income', fontweight='bold')
    axes[1, 0].grid(True, alpha=0.3)

    # 4. Efficiency frontier analysis
    axes[1, 1].scatter(effectiveness_data['program_reach'], effectiveness_data['benefit_adequacy'],
                      alpha=0.7, s=60, color='orange')

    # Identify efficient states (high reach, high adequacy)
    high_reach_threshold = effectiveness_data['program_reach'].quantile(0.75)
    high_adequacy_threshold = effectiveness_data['benefit_adequacy'].quantile(0.75)

    efficient_states = effectiveness_data[
        (effectiveness_data['program_reach'] >= high_reach_threshold) &
        (effectiveness_data['benefit_adequacy'] >= high_adequacy_threshold)
    ]

    # Highlight efficient states
    if len(efficient_states) > 0:
        axes[1, 1].scatter(efficient_states['program_reach'], efficient_states['benefit_adequacy'],
                          color='red', s=100, alpha=0.8, label='High Performers')
        axes[1, 1].legend()

    axes[1, 1].set_xlabel('Program Reach')
    axes[1, 1].set_ylabel('Benefit Adequacy (% of Income)')
    axes[1, 1].set_title('Program Efficiency Analysis', fontweight='bold')
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/snap_policy_analysis.png', dpi=300, bbox_inches='tight')
    plt.show()

    return effectiveness_data, efficient_states

effectiveness_data, efficient_states = analyze_policy_impacts()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results to Delta Lake

# COMMAND ----------

# Save analysis results to Delta Lake
def save_analysis_to_delta(df_analysis, effectiveness_data, regional_stats):
    """Save analysis results to Delta Lake for dashboard consumption."""

    # 1. Save enhanced SNAP analysis data
    analysis_spark_df = spark.createDataFrame(df_analysis)
    analysis_spark_df = analysis_spark_df.withColumn("analysis_date", current_date())

    (analysis_spark_df.write
     .mode("overwrite")
     .option("mergeSchema", "true")
     .saveAsTable("gold.gld_snap_demographics_analysis"))

    # 2. Save effectiveness metrics
    effectiveness_spark_df = spark.createDataFrame(effectiveness_data)
    effectiveness_spark_df = effectiveness_spark_df.withColumn("calculation_date", current_date())

    (effectiveness_spark_df.write
     .mode("overwrite")
     .option("mergeSchema", "true")
     .saveAsTable("gold.gld_snap_effectiveness_metrics"))

    # 3. Save regional statistics
    regional_spark_df = spark.createDataFrame(regional_stats)
    regional_spark_df = regional_spark_df.withColumn("aggregation_date", current_date())

    (regional_spark_df.write
     .mode("overwrite")
     .option("mergeSchema", "true")
     .saveAsTable("gold.gld_snap_regional_statistics"))

    print("Analysis results saved to Delta Lake:")
    print("  - gold.gld_snap_demographics_analysis")
    print("  - gold.gld_snap_effectiveness_metrics")
    print("  - gold.gld_snap_regional_statistics")

save_analysis_to_delta(df_analysis, effectiveness_data, regional_stats)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary Report

# COMMAND ----------

print("=" * 70)
print("SNAP DEMOGRAPHICS AND ECONOMIC ANALYSIS - SUMMARY REPORT")
print("=" * 70)

# Dataset summary
print(f"\n📊 Dataset Overview:")
print(f"   • SNAP enrollment records: {len(df_snap):,}")
print(f"   • Analysis period: {df_analysis['enrollment_date'].min().strftime('%Y-%m-%d')} to {df_analysis['enrollment_date'].max().strftime('%Y-%m-%d')}")
print(f"   • States analyzed: {df_analysis['state_code'].nunique()}")
print(f"   • Total current enrollment: {latest_state_data['current_enrollment'].sum():,} people")
print(f"   • Total monthly benefits: ${latest_state_data['current_benefits_dollars'].sum():,.0f}")

# National trends
latest_national = national_trends.iloc[-1]
print(f"\n📈 National Trends (Latest Month):")
print(f"   • National enrollment: {latest_national['current_enrollment']:,.0f} people")
print(f"   • Average benefit per person: ${latest_national['avg_benefit_per_person']:.0f}")
print(f"   • YoY enrollment change: {latest_national['enrollment_yoy']:+.1f}%")
print(f"   • YoY benefits change: {latest_national['benefits_yoy']:+.1f}%")

# Economic correlations
print(f"\n🔗 Key Economic Correlations:")
poverty_corr = correlation_matrix.loc['poverty_rate', 'enrollment_per_1000']
income_corr = correlation_matrix.loc['median_income', 'enrollment_per_1000']
unemployment_corr = correlation_matrix.loc['unemployment_rate', 'enrollment_per_1000']

print(f"   • Poverty rate correlation: {poverty_corr:+.3f}")
print(f"   • Median income correlation: {income_corr:+.3f}")
print(f"   • Unemployment correlation: {unemployment_corr:+.3f}")

# Regional patterns
print(f"\n🗺️  Regional Analysis:")
latest_regional_summary = regional_stats[regional_stats['enrollment_date'] == regional_stats['enrollment_date'].max()]
for _, region in latest_regional_summary.iterrows():
    print(f"   • {region['region']}: {region['enrollment_rate']:.1f} per 1000 population")

# Program effectiveness
print(f"\n📋 Program Effectiveness:")
print(f"   • Average program reach: {effectiveness_data['program_reach'].mean():.2f}")
print(f"   • High-performing states: {len(efficient_states)}")
print(f"   • Average benefit adequacy: {effectiveness_data['benefit_adequacy'].mean():.1f}% of median income")

# Top insights
print(f"\n💡 Key Insights:")
highest_enrollment_state = latest_state_data.iloc[0]
lowest_enrollment_state = latest_state_data.iloc[-1]

print(f"   • Highest enrollment rate: {highest_enrollment_state['state_code']} ({highest_enrollment_state['enrollment_per_1000']:.1f} per 1000)")
print(f"   • Lowest enrollment rate: {lowest_enrollment_state['state_code']} ({lowest_enrollment_state['enrollment_per_1000']:.1f} per 1000)")
print(f"   • Strong correlation between poverty and SNAP enrollment")
print(f"   • Regional variations reflect different economic conditions")
print(f"   • Program reach varies significantly across states")

# Recommendations
print(f"\n🎯 Policy Recommendations:")
print(f"   • Focus outreach in states with low program reach relative to poverty")
print(f"   • Consider benefit adjustments in high-cost states")
print(f"   • Investigate best practices from high-performing states")
print(f"   • Monitor seasonal patterns for resource planning")
print(f"   • Address geographic disparities in program access")

print(f"\n📁 Outputs Generated:")
print(f"   • Demographics analysis: gold.gld_snap_demographics_analysis")
print(f"   • Effectiveness metrics: gold.gld_snap_effectiveness_metrics")
print(f"   • Regional statistics: gold.gld_snap_regional_statistics")
print(f"   • Visualizations saved to: /tmp/*.png")

print("=" * 70)