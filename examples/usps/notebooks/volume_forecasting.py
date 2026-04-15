# Databricks notebook source
# MAGIC %md
# MAGIC # USPS Mail Volume Forecasting
# MAGIC
# MAGIC This notebook builds predictive models for USPS mail volume forecasting, including:
# MAGIC - Feature engineering from volume, facility, and delivery data
# MAGIC - Time-series features (lags, rolling statistics, calendar effects)
# MAGIC - Multi-model training (Linear, Ridge, Random Forest, Gradient Boosting)
# MAGIC - Cross-validation and walk-forward evaluation
# MAGIC - MLflow experiment tracking
# MAGIC - Volume forecasts for staffing and capacity planning
# MAGIC
# MAGIC **Data Sources:**
# MAGIC - USPS mail volume data (silver layer)
# MAGIC - USPS facility operations (silver layer)
# MAGIC - USPS delivery performance (silver layer)

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

# Statistical and ML libraries
from scipy import stats
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
from sklearn.model_selection import train_test_split, cross_val_score, TimeSeriesSplit
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.preprocessing import StandardScaler, LabelEncoder
from sklearn.pipeline import Pipeline

# Spark and Delta libraries
from pyspark.sql import SparkSession
from pyspark.sql.functions import *
from pyspark.sql.types import *
import mlflow
import mlflow.sklearn

# Configuration
plt.style.use('seaborn-v0_8')
sns.set_palette("husl")
FIGURE_DPI = 300

# MLflow setup
mlflow.set_experiment("/USPS/mail_volume_forecasting")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading

# COMMAND ----------

# Load mail volume data
def load_volume_data():
    """Load mail volume data from silver layer."""

    vol_df = spark.table("silver.slv_mail_volume").toPandas()

    vol_df = vol_df[
        (vol_df['facility_id'].notna()) &
        (vol_df['volume_date'].notna()) &
        (vol_df['total_pieces'] > 0) &
        (vol_df['is_valid_record'] == True)
    ].copy()

    vol_df['volume_date'] = pd.to_datetime(vol_df['volume_date'], errors='coerce')
    vol_df = vol_df.sort_values(['facility_id', 'product_class', 'volume_date'])

    print(f"Loaded {len(vol_df):,} volume records")
    print(f"Facilities: {vol_df['facility_id'].nunique()}")
    print(f"Product classes: {', '.join(vol_df['product_class'].unique())}")
    print(f"Date range: {vol_df['volume_date'].min()} to {vol_df['volume_date'].max()}")

    return vol_df

df_volume = load_volume_data()

# COMMAND ----------

# Load facility data for enrichment
def load_facility_data():
    """Load facility data for capacity features."""

    fac_df = spark.table("silver.slv_facility_operations").toPandas()
    fac_df = fac_df[fac_df['is_valid_record'] == True].copy()

    # Aggregate facility-level averages
    fac_summary = fac_df.groupby('facility_id').agg(
        avg_throughput=('actual_throughput_daily', 'mean'),
        max_throughput=('max_throughput_daily', 'max'),
        avg_employees=('total_employees', 'mean'),
        avg_machines=('sorting_machines', 'mean'),
        avg_overtime=('overtime_hours', 'mean'),
        facility_type=('facility_type', 'first'),
        region=('region', 'first')
    ).reset_index()

    print(f"Loaded facility summaries for {len(fac_summary)} facilities")
    return fac_summary

df_facility = load_facility_data()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Feature Engineering

# COMMAND ----------

# Create ML features for volume prediction
def create_volume_features(df, facility_info):
    """Create comprehensive features for volume forecasting."""

    df_ml = df.copy()

    # --- Calendar features ---
    df_ml['day_of_week'] = df_ml['volume_date'].dt.dayofweek
    df_ml['day_of_month'] = df_ml['volume_date'].dt.day
    df_ml['week_of_year'] = df_ml['volume_date'].dt.isocalendar().week.astype(int)
    df_ml['month'] = df_ml['volume_date'].dt.month

    # Cyclical encoding
    df_ml['dow_sin'] = np.sin(2 * np.pi * df_ml['day_of_week'] / 7)
    df_ml['dow_cos'] = np.cos(2 * np.pi * df_ml['day_of_week'] / 7)
    df_ml['month_sin'] = np.sin(2 * np.pi * df_ml['month'] / 12)
    df_ml['month_cos'] = np.cos(2 * np.pi * df_ml['month'] / 12)

    # Business day features
    df_ml['is_weekend'] = (df_ml['day_of_week'] >= 5).astype(int)
    df_ml['is_monday'] = (df_ml['day_of_week'] == 0).astype(int)
    df_ml['is_friday'] = (df_ml['day_of_week'] == 4).astype(int)

    # Holiday proximity (approximate major holidays)
    holidays_2023 = pd.to_datetime([
        '2023-01-01', '2023-01-16', '2023-02-20', '2023-05-29',
        '2023-07-04', '2023-09-04', '2023-10-09', '2023-11-23', '2023-12-25'
    ])
    df_ml['days_to_holiday'] = df_ml['volume_date'].apply(
        lambda d: min(abs((d - h).days) for h in holidays_2023) if pd.notna(d) else 30
    ).clip(upper=30)
    df_ml['near_holiday'] = (df_ml['days_to_holiday'] <= 3).astype(int)

    # Month-end / beginning effects
    df_ml['is_month_start'] = (df_ml['day_of_month'] <= 3).astype(int)
    df_ml['is_month_end'] = (df_ml['day_of_month'] >= 28).astype(int)

    # --- Lag features (per facility-product combination) ---
    group_cols = ['facility_id', 'product_class']

    for lag in [1, 2, 3, 5, 7]:
        df_ml[f'volume_lag_{lag}'] = df_ml.groupby(group_cols)['total_pieces'].shift(lag)

    # Rolling statistics
    for window in [3, 7, 14]:
        df_ml[f'volume_rolling_mean_{window}'] = df_ml.groupby(group_cols)['total_pieces'].transform(
            lambda x: x.rolling(window=window, min_periods=2).mean()
        )
        df_ml[f'volume_rolling_std_{window}'] = df_ml.groupby(group_cols)['total_pieces'].transform(
            lambda x: x.rolling(window=window, min_periods=2).std()
        )

    # Rolling max/min
    df_ml['volume_rolling_max_7'] = df_ml.groupby(group_cols)['total_pieces'].transform(
        lambda x: x.rolling(window=7, min_periods=2).max()
    )
    df_ml['volume_rolling_min_7'] = df_ml.groupby(group_cols)['total_pieces'].transform(
        lambda x: x.rolling(window=7, min_periods=2).min()
    )

    # Exponential weighted mean
    df_ml['volume_ewm_7'] = df_ml.groupby(group_cols)['total_pieces'].transform(
        lambda x: x.ewm(span=7, min_periods=2).mean()
    )

    # Year-over-year comparison (using prior_year column if available)
    if 'volume_prior_year_same_day' in df_ml.columns:
        df_ml['yoy_change_pct'] = (
            (df_ml['total_pieces'] - df_ml['volume_prior_year_same_day']) /
            df_ml['volume_prior_year_same_day'].replace(0, np.nan) * 100
        ).fillna(0).clip(-200, 200)

    # Week-over-week
    if 'volume_prior_week' in df_ml.columns:
        df_ml['wow_change_pct'] = (
            (df_ml['total_pieces'] - df_ml['volume_prior_week']) /
            df_ml['volume_prior_week'].replace(0, np.nan) * 100
        ).fillna(0).clip(-200, 200)

    # --- Product class encoding ---
    le_product = LabelEncoder()
    df_ml['product_encoded'] = le_product.fit_transform(df_ml['product_class'])

    product_dummies = pd.get_dummies(df_ml['product_class'], prefix='pc')
    df_ml = pd.concat([df_ml, product_dummies], axis=1)

    # --- Facility features ---
    df_ml = df_ml.merge(facility_info, on='facility_id', how='left')

    # Encode facility type
    if 'facility_type' in df_ml.columns:
        ftype_dummies = pd.get_dummies(df_ml['facility_type'], prefix='ftype')
        df_ml = pd.concat([df_ml, ftype_dummies], axis=1)

    # Fill NaN from lag features
    df_ml = df_ml.dropna(subset=['volume_lag_1', 'volume_rolling_mean_3'])

    print(f"Feature engineering complete: {df_ml.shape[1]} columns, {len(df_ml):,} rows")

    return df_ml, le_product

df_ml, le_product = create_volume_features(df_volume, df_facility)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Exploratory Feature Analysis

# COMMAND ----------

# Visualize key features
def plot_feature_analysis():
    """Visualize relationships between features and volume."""

    fig, axes = plt.subplots(2, 3, figsize=(18, 10))

    # Volume by day of week
    ax1 = axes[0, 0]
    dow_vol = df_ml.groupby('day_of_week')['total_pieces'].mean()
    dow_labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    ax1.bar(range(7), dow_vol.values, color='#3498db', alpha=0.85)
    ax1.set_xticks(range(7))
    ax1.set_xticklabels(dow_labels)
    ax1.set_title('Avg Volume by Day of Week', fontsize=12, fontweight='bold')
    ax1.set_ylabel('Avg Total Pieces')
    ax1.grid(True, alpha=0.3, axis='y')

    # Volume by month
    ax2 = axes[0, 1]
    month_vol = df_ml.groupby('month')['total_pieces'].mean()
    ax2.bar(range(len(month_vol)), month_vol.values, color='#e67e22', alpha=0.85)
    ax2.set_xticks(range(len(month_vol)))
    ax2.set_xticklabels([f"M{m}" for m in month_vol.index])
    ax2.set_title('Avg Volume by Month', fontsize=12, fontweight='bold')
    ax2.set_ylabel('Avg Total Pieces')
    ax2.grid(True, alpha=0.3, axis='y')

    # Lag-1 correlation
    ax3 = axes[0, 2]
    ax3.scatter(df_ml['volume_lag_1'], df_ml['total_pieces'], alpha=0.3, s=10)
    r, _ = stats.pearsonr(df_ml['volume_lag_1'].dropna(), df_ml.loc[df_ml['volume_lag_1'].notna(), 'total_pieces'])
    ax3.set_title(f'Volume vs Lag-1 (r={r:.3f})', fontsize=12, fontweight='bold')
    ax3.set_xlabel('Previous Day Volume')
    ax3.set_ylabel('Current Volume')
    ax3.grid(True, alpha=0.3)

    # Rolling mean correlation
    ax4 = axes[1, 0]
    ax4.scatter(df_ml['volume_rolling_mean_7'], df_ml['total_pieces'], alpha=0.3, s=10, color='green')
    r2, _ = stats.pearsonr(df_ml['volume_rolling_mean_7'].dropna(),
                           df_ml.loc[df_ml['volume_rolling_mean_7'].notna(), 'total_pieces'])
    ax4.set_title(f'Volume vs 7-Day Rolling Mean (r={r2:.3f})', fontsize=12, fontweight='bold')
    ax4.set_xlabel('7-Day Rolling Mean')
    ax4.set_ylabel('Current Volume')
    ax4.grid(True, alpha=0.3)

    # Volume by product class
    ax5 = axes[1, 1]
    pc_vol = df_ml.groupby('product_class')['total_pieces'].mean().sort_values(ascending=False)
    ax5.barh(range(len(pc_vol)), pc_vol.values, color='#9b59b6', alpha=0.85)
    ax5.set_yticks(range(len(pc_vol)))
    ax5.set_yticklabels(pc_vol.index)
    ax5.set_title('Avg Volume by Product Class', fontsize=12, fontweight='bold')
    ax5.set_xlabel('Avg Total Pieces')
    ax5.invert_yaxis()
    ax5.grid(True, alpha=0.3, axis='x')

    # Holiday effect
    ax6 = axes[1, 2]
    holiday_effect = df_ml.groupby('near_holiday')['total_pieces'].mean()
    ax6.bar(['Normal', 'Near Holiday'], holiday_effect.values, color=['#3498db', '#e74c3c'], alpha=0.85)
    ax6.set_title('Volume: Holiday Proximity Effect', fontsize=12, fontweight='bold')
    ax6.set_ylabel('Avg Total Pieces')
    ax6.grid(True, alpha=0.3, axis='y')

    plt.tight_layout()
    plt.savefig('/tmp/usps_volume_features.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

plot_feature_analysis()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Model Training

# COMMAND ----------

# Build feature matrix
def build_feature_matrix(df):
    """Build feature matrix for volume forecasting."""

    exclude_cols = [
        'facility_id', 'facility_name', 'facility_type', 'district', 'region',
        'product_class', 'mail_shape', 'volume_date', 'volume_year', 'volume_month',
        'volume_day_of_week', 'total_pieces', 'inbound_pieces', 'outbound_pieces',
        'revenue_pieces', 'total_weight_lbs', 'avg_weight_per_piece_oz',
        'postage_revenue', 'avg_revenue_per_piece',
        'volume_prior_year_same_day', 'volume_prior_week',
        'is_holiday', 'is_business_day', 'load_time',
        'is_valid_record', 'validation_errors', '_dbt_loaded_at',
        'state', 'day_of_week', 'month'
    ]

    feature_cols = [c for c in df.columns if c not in exclude_cols and df[c].dtype in ['int64', 'float64', 'uint8', 'bool']]

    X = df[feature_cols].copy()
    y = df['total_pieces'].copy()

    # Drop NaN rows
    mask = X.notna().all(axis=1)
    X = X[mask]
    y = y[mask]

    print(f"Feature matrix: {X.shape[0]:,} samples, {X.shape[1]} features")
    return X, y, feature_cols

X, y, feature_names = build_feature_matrix(df_ml)

# COMMAND ----------

# Train regression models
def train_forecasting_models(X, y, df_ml):
    """Train multiple models for mail volume forecasting."""

    # Time-based split: use last 20% of data as test
    dates = df_ml.loc[X.index, 'volume_date']
    cutoff = dates.quantile(0.8)
    train_mask = dates <= cutoff

    X_train, X_test = X[train_mask], X[~train_mask]
    y_train, y_test = y[train_mask], y[~train_mask]

    print(f"Training set: {len(X_train):,} samples")
    print(f"Test set: {len(X_test):,} samples")

    # Scale features
    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    models = {
        'Linear Regression': LinearRegression(),
        'Ridge Regression': Ridge(alpha=10.0),
        'Random Forest': RandomForestRegressor(
            n_estimators=200, max_depth=15, min_samples_leaf=10, random_state=42
        ),
        'Gradient Boosting': GradientBoostingRegressor(
            n_estimators=200, max_depth=6, learning_rate=0.1, random_state=42
        )
    }

    results = {}

    for name, model in models.items():
        print(f"\nTraining {name}...")

        with mlflow.start_run(run_name=f"volume_{name.lower().replace(' ', '_')}"):

            use_scaled = name in ('Linear Regression', 'Ridge Regression')
            X_tr = X_train_scaled if use_scaled else X_train
            X_te = X_test_scaled if use_scaled else X_test

            model.fit(X_tr, y_train)
            y_pred_train = model.predict(X_tr)
            y_pred_test = model.predict(X_te)

            # Clip predictions
            y_pred_test = np.clip(y_pred_test, 0, None)

            train_mae = mean_absolute_error(y_train, y_pred_train)
            train_rmse = np.sqrt(mean_squared_error(y_train, y_pred_train))
            train_r2 = r2_score(y_train, y_pred_train)

            test_mae = mean_absolute_error(y_test, y_pred_test)
            test_rmse = np.sqrt(mean_squared_error(y_test, y_pred_test))
            test_r2 = r2_score(y_test, y_pred_test)

            # MAPE
            nonzero = y_test > 0
            mape = np.mean(np.abs((y_test[nonzero] - y_pred_test[nonzero]) / y_test[nonzero])) * 100

            # Time-series cross-validation
            tscv = TimeSeriesSplit(n_splits=5)
            cv_scores = cross_val_score(model, X_tr, y_train, cv=tscv,
                                         scoring='neg_mean_absolute_error')
            cv_mae = -cv_scores.mean()
            cv_std = cv_scores.std()

            results[name] = {
                'model': model,
                'train_mae': train_mae, 'train_rmse': train_rmse, 'train_r2': train_r2,
                'test_mae': test_mae, 'test_rmse': test_rmse, 'test_r2': test_r2,
                'mape': mape, 'cv_mae': cv_mae, 'cv_std': cv_std,
                'predictions': y_pred_test
            }

            mlflow.log_param("model_type", name)
            mlflow.log_param("train_size", len(X_train))
            mlflow.log_param("test_size", len(X_test))
            mlflow.log_param("n_features", X_train.shape[1])
            mlflow.log_metric("train_mae", train_mae)
            mlflow.log_metric("test_mae", test_mae)
            mlflow.log_metric("test_rmse", test_rmse)
            mlflow.log_metric("test_r2", test_r2)
            mlflow.log_metric("mape", mape)
            mlflow.log_metric("cv_mae", cv_mae)
            mlflow.sklearn.log_model(model, f"volume_{name.lower().replace(' ', '_')}")

            print(f"  Train MAE: {train_mae:,.0f}  Test MAE: {test_mae:,.0f}")
            print(f"  Test R2: {test_r2:.3f}  MAPE: {mape:.1f}%")
            print(f"  CV MAE: {cv_mae:,.0f} +/- {cv_std:,.0f}")

    return results, X_test, y_test, scaler

model_results, X_test, y_test, scaler = train_forecasting_models(X, y, df_ml)

# COMMAND ----------

# Model comparison
def compare_models(results, y_test):
    """Compare model performance."""

    comparison = pd.DataFrame({
        name: {
            'Train MAE': f"{r['train_mae']:,.0f}",
            'Test MAE': f"{r['test_mae']:,.0f}",
            'Test RMSE': f"{r['test_rmse']:,.0f}",
            'Test R2': f"{r['test_r2']:.3f}",
            'MAPE (%)': f"{r['mape']:.1f}",
            'CV MAE': f"{r['cv_mae']:,.0f}"
        }
        for name, r in results.items()
    })
    print("\nModel Performance Comparison:")
    print(comparison)

    fig, axes = plt.subplots(2, 2, figsize=(14, 12))
    axes = axes.flatten()

    for i, (name, r) in enumerate(results.items()):
        if i >= 4:
            break
        ax = axes[i]
        ax.scatter(y_test, r['predictions'], alpha=0.3, s=15, color='steelblue')
        vmin = min(y_test.min(), r['predictions'].min())
        vmax = max(y_test.max(), r['predictions'].max())
        ax.plot([vmin, vmax], [vmin, vmax], 'r--', alpha=0.8)
        ax.text(0.05, 0.95, f"R2={r['test_r2']:.3f}\nMAE={r['test_mae']:,.0f}\nMAPE={r['mape']:.1f}%",
                transform=ax.transAxes, va='top',
                bbox=dict(boxstyle='round', facecolor='white', alpha=0.8))
        ax.set_xlabel('Actual Volume')
        ax.set_ylabel('Predicted Volume')
        ax.set_title(name, fontweight='bold')
        ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/usps_model_comparison.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

    return comparison

comparison_results = compare_models(model_results, y_test)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Feature Importance

# COMMAND ----------

# Feature importance analysis
def analyze_feature_importance():
    """Analyze feature importance from best model."""

    best_name = min(model_results.keys(), key=lambda k: model_results[k]['test_mae'])
    model = model_results[best_name]['model']

    if not hasattr(model, 'feature_importances_'):
        print(f"{best_name} does not support feature importances")
        return None

    importance_df = pd.DataFrame({
        'feature': feature_names,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)

    top_features = importance_df.head(20)

    plt.figure(figsize=(12, 8))
    bars = plt.barh(range(len(top_features)), top_features['importance'])
    plt.yticks(range(len(top_features)), top_features['feature'])
    plt.xlabel('Feature Importance')
    plt.title(f'Top 20 Features ({best_name})', fontsize=14, fontweight='bold')
    plt.gca().invert_yaxis()
    for i, bar in enumerate(bars):
        if i < 5:
            bar.set_color('#c0392b')
        elif i < 10:
            bar.set_color('#e67e22')
        else:
            bar.set_color('#3498db')
    plt.tight_layout()
    plt.savefig('/tmp/usps_feature_importance.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

    return importance_df

feature_importance = analyze_feature_importance()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Generate Forecasts

# COMMAND ----------

# Generate forecasts for capacity planning
def generate_forecasts(model_results, df_ml, scaler):
    """Generate volume forecasts for the next period."""

    best_name = min(model_results.keys(), key=lambda k: model_results[k]['test_mae'])
    best_model = model_results[best_name]['model']

    print(f"Using best model: {best_name}")
    print(f"  Test MAE: {model_results[best_name]['test_mae']:,.0f}")
    print(f"  Test MAPE: {model_results[best_name]['mape']:.1f}%")

    # Get latest data per facility-product
    latest = df_ml.groupby(['facility_id', 'product_class']).last().reset_index()

    # Build forecast features from latest data
    exclude_cols = [
        'facility_id', 'facility_name', 'facility_type', 'district', 'region',
        'product_class', 'mail_shape', 'volume_date', 'volume_year', 'volume_month',
        'volume_day_of_week', 'total_pieces', 'inbound_pieces', 'outbound_pieces',
        'revenue_pieces', 'total_weight_lbs', 'avg_weight_per_piece_oz',
        'postage_revenue', 'avg_revenue_per_piece',
        'volume_prior_year_same_day', 'volume_prior_week',
        'is_holiday', 'is_business_day', 'load_time',
        'is_valid_record', 'validation_errors', '_dbt_loaded_at',
        'state', 'day_of_week', 'month'
    ]

    feature_cols = [c for c in feature_names if c in latest.columns]
    X_forecast = latest[feature_cols].fillna(0)

    use_scaled = best_name in ('Linear Regression', 'Ridge Regression')
    if use_scaled:
        X_forecast_scaled = scaler.transform(X_forecast)
        predictions = best_model.predict(X_forecast_scaled)
    else:
        predictions = best_model.predict(X_forecast)

    predictions = np.clip(predictions, 0, None)

    # Build results
    forecast_results = latest[['facility_id', 'product_class']].copy()
    forecast_results['forecast_date'] = datetime.now().date()
    forecast_results['predicted_volume'] = predictions
    forecast_results['actual_latest_volume'] = latest['total_pieces'].values
    forecast_results['predicted_change_pct'] = (
        (predictions - latest['total_pieces'].values) /
        latest['total_pieces'].values.clip(1) * 100
    ).round(2)

    # Confidence intervals
    test_mae = model_results[best_name]['test_mae']
    forecast_results['lower_bound'] = np.clip(predictions - 1.96 * test_mae, 0, None)
    forecast_results['upper_bound'] = predictions + 1.96 * test_mae

    print(f"\nGenerated forecasts for {len(forecast_results)} facility-product combinations")

    return forecast_results

forecast_results = generate_forecasts(model_results, df_ml, scaler)

# COMMAND ----------

# Visualize forecasts
def visualize_forecasts(forecast_results):
    """Visualize volume forecasts."""

    fig, axes = plt.subplots(1, 2, figsize=(14, 6))

    # Forecasted vs actual by product class
    ax1 = axes[0]
    pc_forecast = forecast_results.groupby('product_class').agg(
        avg_predicted=('predicted_volume', 'mean'),
        avg_actual=('actual_latest_volume', 'mean')
    ).reset_index()

    x = range(len(pc_forecast))
    width = 0.35
    ax1.bar([i - width/2 for i in x], pc_forecast['avg_actual'], width,
            label='Latest Actual', color='#3498db', alpha=0.85)
    ax1.bar([i + width/2 for i in x], pc_forecast['avg_predicted'], width,
            label='Forecast', color='#e67e22', alpha=0.85)
    ax1.set_xticks(x)
    ax1.set_xticklabels(pc_forecast['product_class'], rotation=30, ha='right')
    ax1.set_title('Forecast vs Latest Actual by Product Class', fontsize=13, fontweight='bold')
    ax1.set_ylabel('Average Volume')
    ax1.legend()
    ax1.grid(True, alpha=0.3, axis='y')

    # Change distribution
    ax2 = axes[1]
    ax2.hist(forecast_results['predicted_change_pct'], bins=20, color='#27ae60', alpha=0.8, edgecolor='black')
    ax2.axvline(x=0, color='red', linestyle='--', alpha=0.7)
    ax2.set_title('Distribution of Predicted Volume Changes', fontsize=13, fontweight='bold')
    ax2.set_xlabel('Predicted Change (%)')
    ax2.set_ylabel('Count')
    ax2.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/usps_volume_forecasts.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

visualize_forecasts(forecast_results)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results to Delta Lake

# COMMAND ----------

# Save to gold layer
def save_results_to_delta(forecast_results, comparison_results, feature_importance):
    """Save forecasting results to Delta Lake gold layer."""

    # Save forecasts
    forecast_spark = spark.createDataFrame(forecast_results)
    forecast_spark = forecast_spark.withColumn("model_used", lit("Gradient Boosting"))
    (forecast_spark.write
     .mode("overwrite")
     .option("mergeSchema", "true")
     .saveAsTable("gold.gld_mail_volume_forecasts"))

    # Save model metrics
    metrics_data = []
    for name, r in model_results.items():
        metrics_data.append({
            'model_name': name,
            'test_mae': float(r['test_mae']),
            'test_rmse': float(r['test_rmse']),
            'test_r2': float(r['test_r2']),
            'mape': float(r['mape']),
            'cv_mae': float(r['cv_mae']),
            'evaluation_date': datetime.now()
        })
    metrics_df = pd.DataFrame(metrics_data)
    metrics_spark = spark.createDataFrame(metrics_df)
    (metrics_spark.write
     .mode("overwrite")
     .option("mergeSchema", "true")
     .saveAsTable("gold.gld_volume_model_metrics"))

    # Save feature importance
    if feature_importance is not None:
        fi_spark = spark.createDataFrame(feature_importance)
        fi_spark = fi_spark.withColumn("evaluation_date", current_date())
        (fi_spark.write
         .mode("overwrite")
         .option("mergeSchema", "true")
         .saveAsTable("gold.gld_volume_feature_importance"))

    print("Results saved to gold layer:")
    print("  - gold.gld_mail_volume_forecasts")
    print("  - gold.gld_volume_model_metrics")
    print("  - gold.gld_volume_feature_importance")

save_results_to_delta(forecast_results, comparison_results, feature_importance)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary Report

# COMMAND ----------

print("=" * 60)
print("MAIL VOLUME FORECASTING - SUMMARY REPORT")
print("=" * 60)

print(f"\nDataset Overview:")
print(f"  Total volume records: {len(df_ml):,}")
print(f"  Facilities: {df_ml['facility_id'].nunique()}")
print(f"  Product classes: {df_ml['product_class'].nunique()}")
print(f"  Features engineered: {len(feature_names)}")

best_model_name = min(model_results.keys(), key=lambda k: model_results[k]['test_mae'])
best = model_results[best_model_name]

print(f"\nBest Model: {best_model_name}")
print(f"  Test MAE: {best['test_mae']:,.0f} pieces")
print(f"  Test RMSE: {best['test_rmse']:,.0f} pieces")
print(f"  Test R2: {best['test_r2']:.3f}")
print(f"  MAPE: {best['mape']:.1f}%")
print(f"  CV MAE: {best['cv_mae']:,.0f}")

print(f"\nTop Predictive Features:")
if feature_importance is not None:
    for _, row in feature_importance.head(5).iterrows():
        print(f"  - {row['feature']}: {row['importance']:.4f}")

print(f"\nForecast Summary:")
avg_change = forecast_results['predicted_change_pct'].mean()
positive = (forecast_results['predicted_change_pct'] > 0).sum()
total = len(forecast_results)
print(f"  Average predicted change: {avg_change:.1f}%")
print(f"  Increasing forecasts: {positive}/{total} ({positive/total*100:.1f}%)")

print(f"\nOutputs:")
print(f"  - Volume forecasts: gold.gld_mail_volume_forecasts")
print(f"  - Model metrics: gold.gld_volume_model_metrics")
print(f"  - Feature importance: gold.gld_volume_feature_importance")
print(f"  - Visualizations: /tmp/usps_*.png")
print(f"  - MLflow: /USPS/mail_volume_forecasting")

print("=" * 60)

# COMMAND ----------

# Final forecast summary by product class
print("\nFORECAST SUMMARY BY PRODUCT CLASS:")
fc_summary = forecast_results.groupby('product_class').agg(
    avg_predicted=('predicted_volume', 'mean'),
    avg_actual=('actual_latest_volume', 'mean'),
    avg_change_pct=('predicted_change_pct', 'mean'),
    count=('facility_id', 'count')
).round(1)
print(fc_summary)
