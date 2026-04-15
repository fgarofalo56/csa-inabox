# Databricks notebook source
# MAGIC %md
# MAGIC # Trade Pattern Prediction and Economic Forecasting
# MAGIC
# MAGIC This notebook implements ML models for predicting trade patterns and economic indicators:
# MAGIC - Trade flow forecasting using time series models
# MAGIC - GDP growth prediction with demographic features
# MAGIC - Partner country risk scoring
# MAGIC - Commodity demand forecasting
# MAGIC
# MAGIC **Data Sources:**
# MAGIC - Silver layer trade flows, GDP, and Census demographics
# MAGIC - Feature engineering from cross-domain correlations

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup and Configuration

# COMMAND ----------

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
from datetime import datetime
import warnings
warnings.filterwarnings('ignore')

from scipy import stats
from sklearn.linear_model import LinearRegression, Ridge, Lasso
from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
from sklearn.model_selection import train_test_split, cross_val_score, TimeSeriesSplit
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.preprocessing import StandardScaler, LabelEncoder
from sklearn.pipeline import Pipeline

from pyspark.sql import SparkSession
from pyspark.sql.functions import *
from pyspark.sql.types import *
import mlflow
import mlflow.sklearn

plt.style.use('seaborn-v0_8')
sns.set_palette("husl")

mlflow.set_experiment("/Commerce/trade_pattern_prediction")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading and Feature Engineering

# COMMAND ----------

def load_and_prepare_data():
    """Load trade, GDP, and census data and engineer features."""
    df_trade = spark.table("silver.slv_trade_data").toPandas()
    df_gdp = spark.table("silver.slv_gdp_data").toPandas()
    df_census = spark.table("silver.slv_census_demographics").toPandas()

    print(f"Trade records: {len(df_trade):,}")
    print(f"GDP records: {len(df_gdp):,}")
    print(f"Census records: {len(df_census):,}")
    return df_trade, df_gdp, df_census

df_trade, df_gdp, df_census = load_and_prepare_data()

# COMMAND ----------

def engineer_trade_features(df):
    """Create ML features from trade data."""
    df_ml = df.copy()

    # Time features
    df_ml['year_month'] = df_ml['year'] * 100 + df_ml['month']
    df_ml['year_sin'] = np.sin(2 * np.pi * df_ml['month'] / 12)
    df_ml['year_cos'] = np.cos(2 * np.pi * df_ml['month'] / 12)
    df_ml['quarter'] = (df_ml['month'] - 1) // 3 + 1

    # Encode categoricals
    le_country = LabelEncoder()
    le_flow = LabelEncoder()
    le_commodity = LabelEncoder()
    le_transport = LabelEncoder()

    df_ml['country_encoded'] = le_country.fit_transform(df_ml['partner_country_code'].fillna('UNK'))
    df_ml['flow_encoded'] = le_flow.fit_transform(df_ml['flow_type'].fillna('UNK'))
    df_ml['commodity_encoded'] = le_commodity.fit_transform(df_ml['hs_code'].fillna('UNK'))
    df_ml['transport_encoded'] = le_transport.fit_transform(df_ml['transport_method'].fillna('UNK'))

    # Lag features by country-commodity
    df_ml = df_ml.sort_values(['partner_country_code', 'hs_code', 'flow_type', 'year', 'month'])
    group_cols = ['partner_country_code', 'hs_code', 'flow_type']

    for lag in [1, 3, 6, 12]:
        df_ml[f'value_lag_{lag}'] = df_ml.groupby(group_cols)['trade_value_usd'].shift(lag)

    # Rolling statistics
    for window in [3, 6]:
        df_ml[f'value_rolling_mean_{window}'] = (
            df_ml.groupby(group_cols)['trade_value_usd']
            .rolling(window=window, min_periods=2).mean()
            .reset_index(drop=True)
        )
        df_ml[f'value_rolling_std_{window}'] = (
            df_ml.groupby(group_cols)['trade_value_usd']
            .rolling(window=window, min_periods=2).std()
            .reset_index(drop=True)
        )

    # Year-over-year change
    df_ml['yoy_change'] = df_ml.groupby(group_cols)['trade_value_usd'].pct_change(periods=12)

    df_ml = df_ml.dropna()
    print(f"Feature engineering complete: {df_ml.shape[1]} features, {len(df_ml):,} samples")
    return df_ml, le_country, le_flow, le_commodity, le_transport

df_features, le_country, le_flow, le_commodity, le_transport = engineer_trade_features(df_trade)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Trade Value Prediction Models

# COMMAND ----------

def train_trade_models(df_ml):
    """Train multiple models to predict trade values."""
    feature_cols = [c for c in df_ml.columns if c not in [
        'trade_id', 'partner_country_code', 'partner_country_name', 'partner_region',
        'partner_income_group', 'hs_code', 'commodity_description', 'commodity_section',
        'flow_type', 'district_code', 'district_name', 'transport_method',
        'quantity_unit', 'trade_value_usd', 'raw_json', 'record_hash',
        'load_time', '_dbt_loaded_at', 'is_valid_record', 'validation_errors',
        'source_system', 'ingestion_timestamp', 'year_month'
    ]]

    # Remove non-numeric
    numeric_cols = [c for c in feature_cols if df_ml[c].dtype in ['int64', 'float64', 'int32', 'float32']]

    X = df_ml[numeric_cols].fillna(0)
    y = np.log1p(df_ml['trade_value_usd'])  # Log transform for better distribution

    # Time-based split
    tscv = TimeSeriesSplit(n_splits=5)
    train_idx, test_idx = list(tscv.split(X))[-1]
    X_train, X_test = X.iloc[train_idx], X.iloc[test_idx]
    y_train, y_test = y.iloc[train_idx], y.iloc[test_idx]

    print(f"Training: {len(X_train):,} | Test: {len(X_test):,}")

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    models = {
        'Ridge Regression': Ridge(alpha=1.0),
        'Random Forest': RandomForestRegressor(n_estimators=100, max_depth=15, random_state=42),
        'Gradient Boosting': GradientBoostingRegressor(n_estimators=100, max_depth=5, random_state=42),
    }

    results = {}
    for name, model in models.items():
        print(f"\nTraining {name}...")
        with mlflow.start_run(run_name=f"trade_{name.lower().replace(' ', '_')}"):
            model.fit(X_train_scaled, y_train)
            y_pred_train = model.predict(X_train_scaled)
            y_pred_test = model.predict(X_test_scaled)

            train_mae = mean_absolute_error(y_train, y_pred_train)
            test_mae = mean_absolute_error(y_test, y_pred_test)
            train_r2 = r2_score(y_train, y_pred_train)
            test_r2 = r2_score(y_test, y_pred_test)
            test_rmse = np.sqrt(mean_squared_error(y_test, y_pred_test))

            results[name] = {
                'model': model, 'train_mae': train_mae, 'test_mae': test_mae,
                'train_r2': train_r2, 'test_r2': test_r2, 'test_rmse': test_rmse,
                'predictions': y_pred_test
            }

            mlflow.log_param("model_type", name)
            mlflow.log_metric("test_mae", test_mae)
            mlflow.log_metric("test_r2", test_r2)
            mlflow.log_metric("test_rmse", test_rmse)
            mlflow.sklearn.log_model(model, f"trade_{name.lower().replace(' ', '_')}")

            print(f"  Train MAE: {train_mae:.4f} | Test MAE: {test_mae:.4f}")
            print(f"  Train R2: {train_r2:.4f} | Test R2: {test_r2:.4f}")

    return results, X_test, y_test, scaler, numeric_cols

results, X_test, y_test, scaler, feature_names = train_trade_models(df_features)

# COMMAND ----------

# Model comparison visualization
def visualize_model_comparison(results, y_test):
    """Compare model performance with visualizations."""
    fig, axes = plt.subplots(1, 3, figsize=(18, 6))

    for i, (name, res) in enumerate(results.items()):
        axes[i].scatter(y_test, res['predictions'], alpha=0.4, s=20)
        min_val = min(y_test.min(), res['predictions'].min())
        max_val = max(y_test.max(), res['predictions'].max())
        axes[i].plot([min_val, max_val], [min_val, max_val], 'r--', alpha=0.8)
        axes[i].text(0.05, 0.95, f"R2={res['test_r2']:.3f}\nMAE={res['test_mae']:.3f}",
                    transform=axes[i].transAxes, va='top',
                    bbox=dict(boxstyle='round', facecolor='white', alpha=0.8))
        axes[i].set_title(f'{name}', fontweight='bold')
        axes[i].set_xlabel('Actual (log)')
        axes[i].set_ylabel('Predicted (log)')
        axes[i].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/trade_model_comparison.png', dpi=300, bbox_inches='tight')
    plt.show()

visualize_model_comparison(results, y_test)

# COMMAND ----------

# MAGIC %md
# MAGIC ## GDP Growth Prediction

# COMMAND ----------

def predict_gdp_growth(df_gdp):
    """Predict GDP growth using time series features."""
    gdp_agg = df_gdp.groupby(['state_name', 'year', 'quarter']).agg(
        total_gdp=('gdp_current_dollars', 'sum'),
        real_gdp=('gdp_chained_dollars', 'sum'),
        n_industries=('naics_sector', 'nunique')
    ).reset_index()

    gdp_agg = gdp_agg.sort_values(['state_name', 'year', 'quarter'])
    gdp_agg['gdp_growth'] = gdp_agg.groupby('state_name')['total_gdp'].pct_change()
    gdp_agg['real_gdp_growth'] = gdp_agg.groupby('state_name')['real_gdp'].pct_change()

    # Lag features
    for lag in [1, 2, 4]:
        gdp_agg[f'gdp_lag_{lag}'] = gdp_agg.groupby('state_name')['total_gdp'].shift(lag)
        gdp_agg[f'growth_lag_{lag}'] = gdp_agg.groupby('state_name')['gdp_growth'].shift(lag)

    # Rolling mean
    gdp_agg['gdp_rolling_4q'] = (
        gdp_agg.groupby('state_name')['total_gdp']
        .rolling(window=4, min_periods=2).mean()
        .reset_index(drop=True)
    )

    le_state = LabelEncoder()
    gdp_agg['state_encoded'] = le_state.fit_transform(gdp_agg['state_name'])
    gdp_agg['time_idx'] = gdp_agg['year'] * 4 + gdp_agg['quarter']

    gdp_agg = gdp_agg.dropna()

    features = ['state_encoded', 'year', 'quarter', 'n_industries', 'total_gdp',
                'gdp_lag_1', 'gdp_lag_2', 'gdp_lag_4', 'growth_lag_1',
                'growth_lag_2', 'growth_lag_4', 'gdp_rolling_4q', 'time_idx']

    X = gdp_agg[features]
    y = gdp_agg['gdp_growth']

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, shuffle=False)

    model = GradientBoostingRegressor(n_estimators=100, max_depth=4, random_state=42)
    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    mae = mean_absolute_error(y_test, y_pred)
    r2 = r2_score(y_test, y_pred)

    print(f"GDP Growth Prediction - MAE: {mae:.4f}, R2: {r2:.4f}")

    # Feature importance
    importance_df = pd.DataFrame({
        'feature': features,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)

    fig, axes = plt.subplots(1, 2, figsize=(16, 6))

    axes[0].scatter(y_test.values, y_pred, alpha=0.6)
    axes[0].plot([y_test.min(), y_test.max()], [y_test.min(), y_test.max()], 'r--')
    axes[0].set_title(f'GDP Growth Prediction (R2={r2:.3f})', fontweight='bold')
    axes[0].set_xlabel('Actual Growth')
    axes[0].set_ylabel('Predicted Growth')
    axes[0].grid(True, alpha=0.3)

    axes[1].barh(importance_df['feature'], importance_df['importance'])
    axes[1].set_title('Feature Importance', fontweight='bold')
    axes[1].set_xlabel('Importance')
    axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/gdp_prediction.png', dpi=300, bbox_inches='tight')
    plt.show()

    return model, gdp_agg

gdp_model, gdp_prepared = predict_gdp_growth(df_gdp)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Partner Country Risk Scoring

# COMMAND ----------

def score_partner_risk(df_trade):
    """Score trade partners by volatility and concentration risk."""
    partner_stats = df_trade.groupby('partner_country_name').agg(
        total_trade=('trade_value_usd', 'sum'),
        avg_monthly=('trade_value_usd', 'mean'),
        std_monthly=('trade_value_usd', 'std'),
        n_commodities=('hs_code', 'nunique'),
        n_months=('month', 'nunique')
    ).reset_index()

    partner_stats['cv'] = partner_stats['std_monthly'] / partner_stats['avg_monthly']
    partner_stats['concentration'] = 1 / partner_stats['n_commodities']

    # Composite risk score (0-100, higher = riskier)
    partner_stats['volatility_score'] = (
        partner_stats['cv'].rank(pct=True) * 40
    )
    partner_stats['concentration_score'] = (
        partner_stats['concentration'].rank(pct=True) * 30
    )
    partner_stats['volume_score'] = (
        (1 - partner_stats['total_trade'].rank(pct=True)) * 30
    )
    partner_stats['risk_score'] = (
        partner_stats['volatility_score'] +
        partner_stats['concentration_score'] +
        partner_stats['volume_score']
    ).round(1)

    partner_stats = partner_stats.sort_values('risk_score', ascending=False)

    fig, ax = plt.subplots(figsize=(12, 6))
    colors = ['red' if s > 60 else 'orange' if s > 40 else 'green' for s in partner_stats['risk_score']]
    ax.barh(partner_stats['partner_country_name'], partner_stats['risk_score'], color=colors)
    ax.set_title('Trade Partner Risk Score', fontsize=14, fontweight='bold')
    ax.set_xlabel('Risk Score (0-100)')
    ax.axvline(x=60, color='red', linestyle='--', alpha=0.5, label='High Risk')
    ax.axvline(x=40, color='orange', linestyle='--', alpha=0.5, label='Moderate Risk')
    ax.legend()
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/partner_risk_scores.png', dpi=300, bbox_inches='tight')
    plt.show()

    return partner_stats

risk_scores = score_partner_risk(df_trade)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Predictions to Delta Lake

# COMMAND ----------

def save_predictions():
    """Save model predictions and risk scores to gold layer."""
    risk_spark = spark.createDataFrame(risk_scores)
    risk_spark = risk_spark.withColumn("scoring_date", current_date())

    (risk_spark.write
     .mode("overwrite")
     .option("mergeSchema", "true")
     .saveAsTable("gold.gld_partner_risk_scores"))

    print("Saved partner risk scores to gold.gld_partner_risk_scores")

save_predictions()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print("=" * 65)
print("TRADE PATTERN PREDICTION - SUMMARY")
print("=" * 65)

best_model = min(results.keys(), key=lambda k: results[k]['test_mae'])
print(f"\nBest trade model: {best_model}")
print(f"  Test MAE: {results[best_model]['test_mae']:.4f}")
print(f"  Test R2: {results[best_model]['test_r2']:.4f}")

print(f"\nGDP Growth Prediction trained successfully")
print(f"Partner risk scores computed for {len(risk_scores)} countries")

print(f"\nOutputs:")
print(f"  gold.gld_partner_risk_scores")
print(f"  MLflow: /Commerce/trade_pattern_prediction")
print("=" * 65)
