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

import warnings

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

warnings.filterwarnings('ignore')

import mlflow
import mlflow.sklearn
from pyspark.sql.functions import *
from pyspark.sql.types import *
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import TimeSeriesSplit, train_test_split
from sklearn.preprocessing import LabelEncoder, StandardScaler

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
                    bbox={'boxstyle': 'round', 'facecolor': 'white', 'alpha': 0.8})
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
print("TRADE PATTERN PREDICTION - INITIAL RESULTS")
print("=" * 65)

best_model = min(results.keys(), key=lambda k: results[k]['test_mae'])
print(f"\nBest trade model: {best_model}")
print(f"  Test MAE: {results[best_model]['test_mae']:.4f}")
print(f"  Test R2: {results[best_model]['test_r2']:.4f}")

print("\nGDP Growth Prediction trained successfully")
print(f"Partner risk scores computed for {len(risk_scores)} countries")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Trade Balance Trend Analysis

# COMMAND ----------

def analyze_trade_balance_trends(df):
    """Analyze trade balance trends, deficits, and structural shifts."""
    df_tb = df.copy()

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Monthly trade balance
    monthly_balance = df_tb.groupby(['year', 'month', 'flow_type'])['trade_value_usd'].sum().reset_index()
    monthly_balance['date'] = pd.to_datetime(monthly_balance[['year', 'month']].assign(day=1))
    exports_m = monthly_balance[monthly_balance['flow_type'] == 'EXPORT'].set_index('date')['trade_value_usd']
    imports_m = monthly_balance[monthly_balance['flow_type'] == 'IMPORT'].set_index('date')['trade_value_usd']

    # Align indices
    common_idx = exports_m.index.intersection(imports_m.index)
    if len(common_idx) > 0:
        balance_m = exports_m.loc[common_idx] - imports_m.loc[common_idx]
        axes[0, 0].bar(common_idx, balance_m / 1e9,
                      color=['green' if b > 0 else 'red' for b in balance_m.values],
                      width=25)
        axes[0, 0].axhline(y=0, color='black', linestyle='-')
        axes[0, 0].set_title('Monthly Trade Balance', fontweight='bold')
        axes[0, 0].set_xlabel('Date')
        axes[0, 0].set_ylabel('Balance (Billions $)')
        axes[0, 0].grid(True, alpha=0.3)

    # Cumulative trade balance by country
    country_balance = df_tb.groupby(['partner_country_name', 'flow_type'])['trade_value_usd'].sum().unstack(fill_value=0)
    if 'EXPORT' in country_balance.columns and 'IMPORT' in country_balance.columns:
        country_balance['balance'] = country_balance['EXPORT'] - country_balance['IMPORT']
        country_balance['abs_balance'] = country_balance['balance'].abs()
        top_deficit = country_balance.nsmallest(10, 'balance')
        top_surplus = country_balance.nlargest(5, 'balance')
        combined = pd.concat([top_deficit, top_surplus]).sort_values('balance')

        colors_bal = ['red' if b < 0 else 'green' for b in combined['balance']]
        axes[0, 1].barh(combined.index, combined['balance'] / 1e9, color=colors_bal)
        axes[0, 1].axvline(x=0, color='black', linestyle='-')
        axes[0, 1].set_title('Trade Balance by Country (top deficit/surplus)', fontweight='bold')
        axes[0, 1].set_xlabel('Balance (Billions $)')
        axes[0, 1].grid(True, alpha=0.3)

    # Trade balance by commodity section
    commodity_bal = df_tb.groupby(['commodity_section', 'flow_type'])['trade_value_usd'].sum().unstack(fill_value=0)
    if 'EXPORT' in commodity_bal.columns and 'IMPORT' in commodity_bal.columns:
        commodity_bal['balance'] = commodity_bal['EXPORT'] - commodity_bal['IMPORT']
        commodity_bal = commodity_bal.sort_values('balance')
        colors_cb = ['red' if b < 0 else 'green' for b in commodity_bal['balance']]
        axes[1, 0].barh(commodity_bal.index, commodity_bal['balance'] / 1e9, color=colors_cb)
        axes[1, 0].axvline(x=0, color='black', linestyle='-')
        axes[1, 0].set_title('Trade Balance by Commodity Section', fontweight='bold')
        axes[1, 0].set_xlabel('Balance (Billions $)')
        axes[1, 0].grid(True, alpha=0.3)

    # Export vs Import growth trends
    yearly_trade = df_tb.groupby(['year', 'flow_type'])['trade_value_usd'].sum().unstack(fill_value=0)
    if 'EXPORT' in yearly_trade.columns:
        yearly_trade['export_growth'] = yearly_trade['EXPORT'].pct_change() * 100
    if 'IMPORT' in yearly_trade.columns:
        yearly_trade['import_growth'] = yearly_trade['IMPORT'].pct_change() * 100

    for col, color, label in [('export_growth', 'green', 'Export Growth'),
                               ('import_growth', 'red', 'Import Growth')]:
        if col in yearly_trade.columns:
            axes[1, 1].plot(yearly_trade.index, yearly_trade[col], marker='o',
                           color=color, linewidth=2, label=label)
    axes[1, 1].axhline(y=0, color='black', linestyle='-', alpha=0.5)
    axes[1, 1].set_title('Annual Export vs Import Growth', fontweight='bold')
    axes[1, 1].set_xlabel('Year')
    axes[1, 1].set_ylabel('Growth Rate (%)')
    axes[1, 1].legend()
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/trade_balance_trends.png', dpi=300, bbox_inches='tight')
    plt.show()

analyze_trade_balance_trends(df_trade)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Partner Country Clustering

# COMMAND ----------

from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score


def cluster_trade_partners(df):
    """Cluster trade partner countries by trade profile characteristics."""
    partner_profile = df.groupby('partner_country_name').agg(
        total_trade=('trade_value_usd', 'sum'),
        avg_monthly=('trade_value_usd', 'mean'),
        trade_volatility=('trade_value_usd', 'std'),
        n_commodities=('hs_code', 'nunique'),
        n_months_active=('month', 'nunique'),
        export_share=('flow_type', lambda x: (x == 'EXPORT').mean()),
        n_transport=('transport_method', 'nunique')
    ).reset_index().fillna(0)

    cluster_feats = ['total_trade', 'trade_volatility', 'n_commodities',
                     'export_share', 'n_transport']
    X_partner = partner_profile[cluster_feats]

    scaler_p = StandardScaler()
    X_scaled = scaler_p.fit_transform(X_partner)

    # Optimal k
    sil_scores = []
    k_range = range(2, min(8, len(partner_profile)))
    for k in k_range:
        km = KMeans(n_clusters=k, random_state=42, n_init=10)
        labels = km.fit_predict(X_scaled)
        sil_scores.append(silhouette_score(X_scaled, labels))

    optimal_k = list(k_range)[np.argmax(sil_scores)]
    km_final = KMeans(n_clusters=optimal_k, random_state=42, n_init=10)
    partner_profile['cluster'] = km_final.fit_predict(X_scaled)

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Cluster scatter
    for c in range(optimal_k):
        mask = partner_profile['cluster'] == c
        axes[0, 0].scatter(partner_profile.loc[mask, 'total_trade'] / 1e9,
                          partner_profile.loc[mask, 'n_commodities'],
                          s=80, alpha=0.7, label=f'Cluster {c}')
    for _, row in partner_profile.iterrows():
        axes[0, 0].annotate(row['partner_country_name'][:8],
                           (row['total_trade'] / 1e9, row['n_commodities']), fontsize=6)
    axes[0, 0].set_title(f'Partner Clusters ({optimal_k} groups)', fontweight='bold')
    axes[0, 0].set_xlabel('Total Trade (Billions $)')
    axes[0, 0].set_ylabel('Number of Commodities')
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)

    # Cluster profile heatmap
    cluster_means = partner_profile.groupby('cluster')[cluster_feats].mean()
    # Normalize for heatmap
    cluster_norm = (cluster_means - cluster_means.min()) / (cluster_means.max() - cluster_means.min() + 1e-9)
    sns.heatmap(cluster_norm.T, annot=True, fmt='.2f', cmap='YlOrRd',
                ax=axes[0, 1], cbar_kws={'label': 'Normalized Value'})
    axes[0, 1].set_title('Partner Cluster Profiles', fontweight='bold')
    axes[0, 1].set_xlabel('Cluster')

    # Export share by cluster
    axes[1, 0].boxplot([partner_profile[partner_profile['cluster'] == c]['export_share']
                       for c in range(optimal_k)],
                      labels=[f'C{c}' for c in range(optimal_k)])
    axes[1, 0].set_title('Export Share Distribution by Cluster', fontweight='bold')
    axes[1, 0].set_ylabel('Export Share')
    axes[1, 0].grid(True, alpha=0.3)

    # Countries per cluster
    cluster_counts = partner_profile['cluster'].value_counts().sort_index()
    axes[1, 1].bar(cluster_counts.index, cluster_counts.values,
                  color=sns.color_palette('Set2', optimal_k))
    axes[1, 1].set_title('Countries per Cluster', fontweight='bold')
    axes[1, 1].set_xlabel('Cluster')
    axes[1, 1].set_ylabel('Country Count')
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/partner_clustering.png', dpi=300, bbox_inches='tight')
    plt.show()

    print("\nPartner Cluster Summary:")
    print(partner_profile.groupby('cluster').agg(
        n_countries=('partner_country_name', 'count'),
        avg_trade=('total_trade', 'mean'),
        avg_commodities=('n_commodities', 'mean')
    ).round(0).to_string())

    return partner_profile

partner_clusters = cluster_trade_partners(df_trade)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Tariff Impact Simulation

# COMMAND ----------

def simulate_tariff_impact(df):
    """Simulate the impact of tariff changes on trade flows and balances."""
    # Current trade by country and commodity
    current_trade = df.groupby(['partner_country_name', 'commodity_section', 'flow_type']).agg(
        trade_value=('trade_value_usd', 'sum'),
        quantity=('quantity', 'sum')
    ).reset_index()

    # Simulate tariff scenarios
    tariff_scenarios = [0.05, 0.10, 0.15, 0.25]  # 5%, 10%, 15%, 25%
    elasticity = -0.8  # Price elasticity of imports

    imports = current_trade[current_trade['flow_type'] == 'IMPORT'].copy()
    total_imports = imports['trade_value'].sum()

    scenario_results = []
    for tariff in tariff_scenarios:
        # Volume change = elasticity * price change
        volume_change = elasticity * tariff
        new_value = imports['trade_value'] * (1 + volume_change) * (1 + tariff)
        revenue = imports['trade_value'] * tariff * (1 + volume_change)

        scenario_results.append({
            'tariff_rate': tariff * 100,
            'import_change_pct': volume_change * 100,
            'new_total_imports': new_value.sum(),
            'tariff_revenue': revenue.sum(),
            'trade_loss': (total_imports - new_value.sum() / (1 + tariff)),
            'effective_cost': (new_value.sum() - total_imports)
        })

    scenario_df = pd.DataFrame(scenario_results)

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Tariff revenue curve
    axes[0, 0].bar(scenario_df['tariff_rate'], scenario_df['tariff_revenue'] / 1e9,
                  color='steelblue')
    axes[0, 0].set_title('Projected Tariff Revenue', fontweight='bold')
    axes[0, 0].set_xlabel('Tariff Rate (%)')
    axes[0, 0].set_ylabel('Revenue (Billions $)')
    axes[0, 0].grid(True, alpha=0.3)

    # Import volume impact
    axes[0, 1].plot(scenario_df['tariff_rate'], scenario_df['import_change_pct'],
                   'ro-', linewidth=2, markersize=8)
    axes[0, 1].axhline(y=0, color='black', linestyle='-')
    axes[0, 1].set_title('Import Volume Change by Tariff Rate', fontweight='bold')
    axes[0, 1].set_xlabel('Tariff Rate (%)')
    axes[0, 1].set_ylabel('Volume Change (%)')
    axes[0, 1].grid(True, alpha=0.3)

    # Impact by commodity section (25% tariff scenario)
    if len(imports) > 0:
        imports_25 = imports.copy()
        imports_25['new_value'] = imports_25['trade_value'] * (1 + elasticity * 0.25) * 1.25
        imports_25['impact'] = imports_25['new_value'] - imports_25['trade_value']

        commodity_impact = imports_25.groupby('commodity_section')['impact'].sum().sort_values()
        colors_imp = ['red' if i > 0 else 'green' for i in commodity_impact.values]
        axes[1, 0].barh(commodity_impact.index, commodity_impact.values / 1e6, color=colors_imp)
        axes[1, 0].set_title('25% Tariff Impact by Commodity (Millions $)', fontweight='bold')
        axes[1, 0].set_xlabel('Cost Impact (Millions $)')
        axes[1, 0].grid(True, alpha=0.3)

    # Country-level tariff burden
    country_imports = imports.groupby('partner_country_name')['trade_value'].sum().sort_values(ascending=False)
    top_importers = country_imports.head(10)
    tariff_burden = top_importers * 0.25 * (1 + elasticity * 0.25)  # Effective revenue
    axes[1, 1].barh(tariff_burden.index, tariff_burden.values / 1e9, color='coral')
    axes[1, 1].set_title('Tariff Revenue by Country (25% rate)', fontweight='bold')
    axes[1, 1].set_xlabel('Revenue (Billions $)')
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/tariff_simulation.png', dpi=300, bbox_inches='tight')
    plt.show()

    print("\nTariff Impact Scenarios:")
    print(scenario_df.to_string(index=False))

    return scenario_df

tariff_scenarios = simulate_tariff_impact(df_trade)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Extended Predictions

# COMMAND ----------

# Save partner clusters
cluster_save = partner_clusters[['partner_country_name', 'cluster', 'total_trade',
                                  'n_commodities', 'export_share']].copy()
cluster_spark = spark.createDataFrame(cluster_save)
cluster_spark = cluster_spark.withColumn("scoring_date", current_date())

(cluster_spark.write
 .mode("overwrite")
 .option("mergeSchema", "true")
 .saveAsTable("gold.gld_partner_clusters"))

# Save tariff scenarios
tariff_spark = spark.createDataFrame(tariff_scenarios)
tariff_spark = tariff_spark.withColumn("analysis_date", current_date())

(tariff_spark.write
 .mode("overwrite")
 .option("mergeSchema", "true")
 .saveAsTable("gold.gld_tariff_impact_scenarios"))

print("Saved to:")
print("  gold.gld_partner_clusters")
print("  gold.gld_tariff_impact_scenarios")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print("=" * 65)
print("TRADE PATTERN PREDICTION - COMPREHENSIVE SUMMARY")
print("=" * 65)

best_model = min(results.keys(), key=lambda k: results[k]['test_mae'])
print(f"\nBest trade model: {best_model}")
print(f"  Test MAE: {results[best_model]['test_mae']:.4f}")
print(f"  Test R2: {results[best_model]['test_r2']:.4f}")

print("\nGDP Growth Prediction trained successfully")
print(f"Partner risk scores computed for {len(risk_scores)} countries")
print(f"Partner clusters identified: {partner_clusters['cluster'].nunique()}")
print(f"Tariff scenarios analyzed: {len(tariff_scenarios)}")

print("\nOutputs:")
print("  gold.gld_partner_risk_scores")
print("  gold.gld_partner_clusters")
print("  gold.gld_tariff_impact_scenarios")
print("  MLflow: /Commerce/trade_pattern_prediction")
print("=" * 65)
