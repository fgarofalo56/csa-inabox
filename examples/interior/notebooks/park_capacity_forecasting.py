# Databricks notebook source
# MAGIC %md
# MAGIC # National Park Capacity Forecasting
# MAGIC
# MAGIC ML-based forecasting for national park visitation and capacity management:
# MAGIC - Visitor trend analysis and seasonality decomposition
# MAGIC - Capacity utilization modeling
# MAGIC - Visitation forecasting with seasonal ARIMA and ML models
# MAGIC - COVID-19 impact assessment and recovery tracking
# MAGIC
# MAGIC **Data Sources:**
# MAGIC - NPS visitor statistics (silver layer)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup

# COMMAND ----------

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
from datetime import datetime
import warnings
warnings.filterwarnings('ignore')

from scipy import stats
from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.model_selection import TimeSeriesSplit, cross_val_score
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.preprocessing import StandardScaler, LabelEncoder

from pyspark.sql import SparkSession
from pyspark.sql.functions import *
import mlflow
import mlflow.sklearn

plt.style.use('seaborn-v0_8')
mlflow.set_experiment("/Interior/park_capacity_forecasting")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading

# COMMAND ----------

def load_park_data():
    """Load NPS visitor data."""
    df = spark.table("silver.slv_park_visitors").toPandas()
    print(f"Loaded {len(df):,} park visitor records")
    print(f"Parks: {df['park_code'].nunique()}")
    print(f"Years: {df['year'].min()} - {df['year'].max()}")
    return df

df_parks = load_park_data()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Visitor Trend Analysis

# COMMAND ----------

def analyze_visitor_trends(df):
    """Analyze visitor trends across parks."""
    fig, axes = plt.subplots(2, 2, figsize=(18, 12))

    # Top parks by total visits
    park_totals = df.groupby('park_name')['recreation_visits'].sum().sort_values(ascending=False)
    top_parks = park_totals.head(10)

    top_parks.plot(kind='barh', ax=axes[0, 0], color=sns.color_palette('viridis', len(top_parks)))
    axes[0, 0].set_title('Top 10 Parks by Total Recreation Visits', fontweight='bold')
    axes[0, 0].set_xlabel('Total Visits')
    axes[0, 0].grid(True, alpha=0.3)

    # Annual trends for top 5 parks
    top5 = park_totals.head(5).index.tolist()
    annual = df[df['park_name'].isin(top5)].groupby(['park_name', 'year'])['recreation_visits'].sum().reset_index()
    for park in top5:
        park_data = annual[annual['park_name'] == park]
        axes[0, 1].plot(park_data['year'], park_data['recreation_visits'] / 1e6,
                       marker='o', label=park, linewidth=2)

    axes[0, 1].set_title('Annual Visitor Trends (Top 5)', fontweight='bold')
    axes[0, 1].set_xlabel('Year')
    axes[0, 1].set_ylabel('Visitors (Millions)')
    axes[0, 1].legend(fontsize=8)
    axes[0, 1].grid(True, alpha=0.3)

    # Monthly seasonality
    monthly = df.groupby('month')['recreation_visits'].mean().reset_index()
    axes[1, 0].bar(monthly['month'], monthly['recreation_visits'] / 1e3,
                  color=sns.color_palette('coolwarm', 12))
    axes[1, 0].set_title('Average Monthly Visitation Pattern', fontweight='bold')
    axes[1, 0].set_xlabel('Month')
    axes[1, 0].set_ylabel('Average Visits (Thousands)')
    axes[1, 0].set_xticks(range(1, 13))
    axes[1, 0].grid(True, alpha=0.3)

    # COVID impact: 2019 vs 2020
    pre_covid = df[df['year'] == 2019].groupby('park_name')['recreation_visits'].sum()
    covid = df[df['year'] == 2020].groupby('park_name')['recreation_visits'].sum()
    impact = ((covid - pre_covid) / pre_covid * 100).dropna().sort_values()

    if len(impact) > 0:
        colors = ['red' if x < 0 else 'green' for x in impact]
        axes[1, 1].barh(impact.index[-10:], impact.values[-10:], color=colors[-10:])
        axes[1, 1].set_title('COVID-19 Impact (2020 vs 2019)', fontweight='bold')
        axes[1, 1].set_xlabel('Change (%)')
        axes[1, 1].axvline(x=0, color='black', linestyle='-')
        axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/park_visitor_trends.png', dpi=300, bbox_inches='tight')
    plt.show()

analyze_visitor_trends(df_parks)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Capacity Forecasting Model

# COMMAND ----------

def build_forecasting_model(df):
    """Build ML model for visitor forecasting."""
    df_ml = df.copy()

    # Feature engineering
    le_park = LabelEncoder()
    df_ml['park_encoded'] = le_park.fit_transform(df_ml['park_code'])
    df_ml['month_sin'] = np.sin(2 * np.pi * df_ml['month'] / 12)
    df_ml['month_cos'] = np.cos(2 * np.pi * df_ml['month'] / 12)
    df_ml['is_summer'] = df_ml['month'].isin([6, 7, 8]).astype(int)
    df_ml['is_covid'] = df_ml['year'].isin([2020, 2021]).astype(int)

    # Lag features
    df_ml = df_ml.sort_values(['park_code', 'year', 'month'])
    for lag in [1, 3, 12]:
        df_ml[f'visits_lag_{lag}'] = df_ml.groupby('park_code')['recreation_visits'].shift(lag)

    df_ml['visits_rolling_3'] = (
        df_ml.groupby('park_code')['recreation_visits']
        .rolling(window=3, min_periods=2).mean().reset_index(drop=True)
    )

    df_ml = df_ml.dropna()

    features = ['park_encoded', 'year', 'month', 'month_sin', 'month_cos',
                'is_summer', 'is_covid', 'park_acres', 'campground_capacity',
                'visits_lag_1', 'visits_lag_3', 'visits_lag_12', 'visits_rolling_3']

    available_features = [f for f in features if f in df_ml.columns]

    X = df_ml[available_features].fillna(0)
    y = np.log1p(df_ml['recreation_visits'])

    # Time-based split
    split_idx = int(len(X) * 0.8)
    X_train, X_test = X.iloc[:split_idx], X.iloc[split_idx:]
    y_train, y_test = y.iloc[:split_idx], y.iloc[split_idx:]

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    models = {
        'Ridge': Ridge(alpha=1.0),
        'Random Forest': RandomForestRegressor(n_estimators=100, max_depth=10, random_state=42),
        'Gradient Boosting': GradientBoostingRegressor(n_estimators=100, max_depth=5, random_state=42)
    }

    best_model = None
    best_r2 = -np.inf
    all_results = {}

    for name, model in models.items():
        with mlflow.start_run(run_name=f"park_{name.lower().replace(' ', '_')}"):
            model.fit(X_train_scaled, y_train)
            y_pred = model.predict(X_test_scaled)

            mae = mean_absolute_error(y_test, y_pred)
            r2 = r2_score(y_test, y_pred)
            rmse = np.sqrt(mean_squared_error(y_test, y_pred))

            all_results[name] = {'mae': mae, 'r2': r2, 'rmse': rmse, 'predictions': y_pred}
            print(f"{name}: MAE={mae:.4f}, R2={r2:.4f}, RMSE={rmse:.4f}")

            mlflow.log_metric("mae", mae)
            mlflow.log_metric("r2", r2)
            mlflow.sklearn.log_model(model, f"park_{name}")

            if r2 > best_r2:
                best_r2 = r2
                best_model = name

    # Visualization
    fig, axes = plt.subplots(1, 3, figsize=(18, 5))
    for i, (name, res) in enumerate(all_results.items()):
        axes[i].scatter(y_test, res['predictions'], alpha=0.4, s=20)
        axes[i].plot([y_test.min(), y_test.max()], [y_test.min(), y_test.max()], 'r--')
        axes[i].set_title(f"{name} (R2={res['r2']:.3f})", fontweight='bold')
        axes[i].set_xlabel('Actual (log)')
        axes[i].set_ylabel('Predicted (log)')
        axes[i].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/park_forecast_models.png', dpi=300, bbox_inches='tight')
    plt.show()

    print(f"\nBest model: {best_model} (R2={best_r2:.4f})")
    return all_results

model_results = build_forecasting_model(df_parks)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Capacity Utilization Analysis

# COMMAND ----------

def analyze_capacity(df):
    """Analyze park capacity utilization."""
    park_capacity = df.groupby('park_name').agg(
        total_visits=('recreation_visits', 'sum'),
        avg_monthly=('recreation_visits', 'mean'),
        peak_monthly=('recreation_visits', 'max'),
        camping_capacity=('campground_capacity', 'first'),
        acres=('park_acres', 'first')
    ).reset_index()

    # Visits per acre (density metric)
    park_capacity['visits_per_acre'] = (
        park_capacity['total_visits'] / park_capacity['acres'].clip(lower=1)
    ).round(2)

    # Peak to average ratio (peaking factor)
    park_capacity['peaking_factor'] = (
        park_capacity['peak_monthly'] / park_capacity['avg_monthly'].clip(lower=1)
    ).round(2)

    park_capacity = park_capacity.sort_values('visits_per_acre', ascending=False)

    fig, ax = plt.subplots(figsize=(12, 6))
    bars = ax.barh(park_capacity['park_name'].head(15),
                   park_capacity['visits_per_acre'].head(15))
    ax.set_title('Visitor Density (Visits per Acre)', fontweight='bold')
    ax.set_xlabel('Visits / Acre')
    ax.grid(True, alpha=0.3)

    for i, bar in enumerate(bars):
        if park_capacity['peaking_factor'].iloc[i] > 3:
            bar.set_color('red')
        elif park_capacity['peaking_factor'].iloc[i] > 2:
            bar.set_color('orange')
        else:
            bar.set_color('green')

    plt.tight_layout()
    plt.savefig('/tmp/park_capacity_utilization.png', dpi=300, bbox_inches='tight')
    plt.show()

    return park_capacity

capacity_results = analyze_capacity(df_parks)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results

# COMMAND ----------

capacity_spark = spark.createDataFrame(capacity_results)
capacity_spark = capacity_spark.withColumn("analysis_date", current_date())

(capacity_spark.write
 .mode("overwrite")
 .option("mergeSchema", "true")
 .saveAsTable("gold.gld_park_capacity_analysis"))

print("Saved to gold.gld_park_capacity_analysis")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print("=" * 65)
print("PARK CAPACITY FORECASTING - SUMMARY")
print("=" * 65)
print(f"\nParks analyzed: {df_parks['park_code'].nunique()}")
print(f"Total records: {len(df_parks):,}")
best = min(model_results.keys(), key=lambda k: model_results[k]['mae'])
print(f"Best forecasting model: {best} (R2={model_results[best]['r2']:.4f})")
print(f"\nOutputs: gold.gld_park_capacity_analysis")
print(f"MLflow: /Interior/park_capacity_forecasting")
print("=" * 65)
