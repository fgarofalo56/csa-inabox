# Databricks notebook source
# MAGIC %md
# MAGIC # Air Quality Forecasting Model
# MAGIC
# MAGIC This notebook builds predictive models for EPA air quality forecasting, including:
# MAGIC - Feature engineering from AQS monitoring data
# MAGIC - Multi-pollutant AQI prediction models
# MAGIC - Exceedance probability classification
# MAGIC - MLflow experiment tracking and model registry
# MAGIC - Site-level AQI forecasts for public health advisories
# MAGIC
# MAGIC **Data Sources:**
# MAGIC - EPA AQS air quality monitoring data (silver layer)
# MAGIC - EPA TRI toxic release inventory (silver layer)
# MAGIC - NOAA weather observations (silver layer, optional)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup and Configuration

# COMMAND ----------

# Import required libraries
import warnings
from datetime import datetime

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

warnings.filterwarnings('ignore')

# ML libraries
import mlflow
import mlflow.sklearn

# Spark and Delta
from pyspark.sql.functions import *
from pyspark.sql.types import *
from sklearn.ensemble import (
    GradientBoostingClassifier,
    GradientBoostingRegressor,
    RandomForestClassifier,
    RandomForestRegressor,
)
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import (
    confusion_matrix,
    f1_score,
    mean_absolute_error,
    mean_squared_error,
    r2_score,
    roc_auc_score,
    roc_curve,
)
from sklearn.model_selection import TimeSeriesSplit, cross_val_score
from sklearn.preprocessing import LabelEncoder, StandardScaler

# Configuration
plt.style.use('seaborn-v0_8')
sns.set_palette("husl")
FIGURE_DPI = 300

mlflow.set_experiment("/EPA/air_quality_forecasting")

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
        (aq_df['arithmetic_mean'].notna()) &
        (aq_df['is_valid_record'] == True)
    ].copy()

    aq_df['date_local'] = pd.to_datetime(aq_df['date_local'], errors='coerce')

    print(f"Loaded {len(aq_df):,} air quality records")
    print(f"Parameters: {', '.join(aq_df['parameter_name'].unique())}")
    print(f"Sites: {aq_df['site_id'].nunique()}")
    print(f"Date range: {aq_df['date_local'].min()} to {aq_df['date_local'].max()}")

    return aq_df

df_air = load_air_quality()

# COMMAND ----------

# Load TRI data for industrial context
def load_tri_context():
    """Load TRI facility data for environmental context features."""

    tri_df = spark.table("silver.slv_toxic_releases").toPandas()
    tri_df = tri_df[tri_df['is_valid_record'] == True].copy()

    # Aggregate by state for context
    state_tri = tri_df.groupby('state').agg(
        tri_facilities=('trifid', 'nunique'),
        tri_total_releases=('total_releases', 'sum'),
        tri_air_releases=('fugitive_air', 'sum')
    ).reset_index()

    print(f"Loaded TRI context for {len(state_tri)} states")
    return state_tri

df_tri_context = load_tri_context()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Feature Engineering

# COMMAND ----------

# Create ML features for AQI prediction
def create_aqi_features(df, tri_context):
    """Create features for AQI forecasting."""

    df_ml = df.copy()

    # --- Target: AQI ---
    # Filter for records with valid AQI
    df_ml = df_ml[df_ml['aqi'].notna() & (df_ml['aqi'] >= 0)].copy()

    # Binary target: unhealthy air day (AQI > 100)
    df_ml['is_unhealthy'] = (df_ml['aqi'] > 100).astype(int)

    # --- Calendar features ---
    df_ml['month'] = df_ml['date_local'].dt.month
    df_ml['day_of_year'] = df_ml['date_local'].dt.dayofyear
    df_ml['day_of_week'] = df_ml['date_local'].dt.dayofweek

    df_ml['month_sin'] = np.sin(2 * np.pi * df_ml['month'] / 12)
    df_ml['month_cos'] = np.cos(2 * np.pi * df_ml['month'] / 12)
    df_ml['doy_sin'] = np.sin(2 * np.pi * df_ml['day_of_year'] / 365)
    df_ml['doy_cos'] = np.cos(2 * np.pi * df_ml['day_of_year'] / 365)

    df_ml['is_summer'] = df_ml['month'].isin([6, 7, 8]).astype(int)
    df_ml['is_winter'] = df_ml['month'].isin([12, 1, 2]).astype(int)
    df_ml['is_weekend'] = (df_ml['day_of_week'] >= 5).astype(int)

    # --- Pollutant features ---
    le_param = LabelEncoder()
    df_ml['parameter_encoded'] = le_param.fit_transform(df_ml['parameter_name'])

    # One-hot encode pollutants
    param_dummies = pd.get_dummies(df_ml['parameter_name'], prefix='pollutant')
    df_ml = pd.concat([df_ml, param_dummies], axis=1)

    # Concentration features
    df_ml['log_concentration'] = np.log1p(df_ml['arithmetic_mean'].clip(lower=0))
    df_ml['max_to_mean_ratio'] = (
        df_ml['first_max_value'] / df_ml['arithmetic_mean'].replace(0, np.nan)
    ).fillna(1).clip(0, 10)

    # Observation completeness
    df_ml['obs_completeness'] = df_ml['observation_percent'].fillna(75) / 100

    # --- Location features ---
    df_ml['latitude_filled'] = df_ml['latitude'].fillna(df_ml['latitude'].median())
    df_ml['longitude_filled'] = df_ml['longitude'].fillna(df_ml['longitude'].median())

    # State encoding
    le_state = LabelEncoder()
    df_ml['state_encoded'] = le_state.fit_transform(df_ml['state_name'].fillna('UNKNOWN'))

    # --- Lag features (per site-parameter) ---
    group_cols = ['site_id', 'parameter_name']
    df_ml = df_ml.sort_values(['site_id', 'parameter_name', 'date_local'])

    for lag in [1, 2, 3, 7]:
        df_ml[f'aqi_lag_{lag}'] = df_ml.groupby(group_cols)['aqi'].shift(lag)
        df_ml[f'conc_lag_{lag}'] = df_ml.groupby(group_cols)['arithmetic_mean'].shift(lag)

    # Rolling statistics
    for window in [3, 7, 14]:
        df_ml[f'aqi_rolling_mean_{window}'] = df_ml.groupby(group_cols)['aqi'].transform(
            lambda x: x.rolling(window=window, min_periods=2).mean()
        )
        df_ml[f'aqi_rolling_max_{window}'] = df_ml.groupby(group_cols)['aqi'].transform(
            lambda x: x.rolling(window=window, min_periods=2).max()
        )
        df_ml[f'aqi_rolling_std_{window}'] = df_ml.groupby(group_cols)['aqi'].transform(
            lambda x: x.rolling(window=window, min_periods=2).std()
        )

    # EWM
    df_ml['aqi_ewm_7'] = df_ml.groupby(group_cols)['aqi'].transform(
        lambda x: x.ewm(span=7, min_periods=2).mean()
    )

    # --- Industrial context ---
    df_ml = df_ml.merge(tri_context, left_on='state_name',
                         right_on='state', how='left', suffixes=('', '_tri'))
    for col in ['tri_facilities', 'tri_total_releases', 'tri_air_releases']:
        df_ml[col] = df_ml[col].fillna(0)

    # --- Site-level historical statistics ---
    site_stats = df_ml.groupby('site_id').agg(
        site_avg_aqi=('aqi', 'mean'),
        site_max_aqi=('aqi', 'max'),
        site_std_aqi=('aqi', 'std'),
        site_unhealthy_rate=('is_unhealthy', 'mean')
    ).reset_index()
    df_ml = df_ml.merge(site_stats, on='site_id', how='left')

    # Drop rows with NaN from lag features
    df_ml = df_ml.dropna(subset=['aqi_lag_1', 'aqi_rolling_mean_3'])

    print(f"Feature engineering complete: {df_ml.shape[1]} columns, {len(df_ml):,} rows")
    print(f"Unhealthy days: {df_ml['is_unhealthy'].sum():,} ({df_ml['is_unhealthy'].mean()*100:.1f}%)")

    return df_ml, le_param, le_state

df_ml, le_param, le_state = create_aqi_features(df_air, df_tri_context)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Model Training - AQI Regression

# COMMAND ----------

# Build feature matrix
def build_feature_matrix(df):
    """Build feature matrix for AQI prediction."""

    exclude_cols = [
        'site_id', 'state_code', 'county_code', 'site_number',
        'state_name', 'county_name', 'cbsa_name', 'latitude', 'longitude',
        'datum', 'parameter_code', 'parameter_name', 'poc',
        'sample_duration', 'pollutant_standard', 'units_of_measure',
        'method_code', 'method_name', 'date_local',
        'observation_count', 'observation_percent',
        'arithmetic_mean', 'first_max_value', 'first_max_hour',
        'aqi', 'is_unhealthy', 'load_time',
        'is_valid_record', 'validation_errors', '_dbt_loaded_at',
        'state', 'day_of_year', 'day_of_week', 'month'
    ]

    feature_cols = [c for c in df.columns
                    if c not in exclude_cols
                    and df[c].dtype in ['int64', 'float64', 'uint8', 'bool']]

    X = df[feature_cols].copy()
    y_reg = df['aqi'].copy()
    y_cls = df['is_unhealthy'].copy()

    mask = X.notna().all(axis=1)
    X, y_reg, y_cls = X[mask], y_reg[mask], y_cls[mask]

    print(f"Feature matrix: {X.shape[0]:,} x {X.shape[1]}")
    return X, y_reg, y_cls, feature_cols

X, y_reg, y_cls, feature_names = build_feature_matrix(df_ml)

# COMMAND ----------

# Train AQI regression models
def train_aqi_models(X, y, df_ml):
    """Train AQI forecasting models."""

    dates = df_ml.loc[X.index, 'date_local']
    cutoff = dates.quantile(0.8)
    train_mask = dates <= cutoff

    X_train, X_test = X[train_mask], X[~train_mask]
    y_train, y_test = y[train_mask], y[~train_mask]

    print(f"Train: {len(X_train):,}  Test: {len(X_test):,}")

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    models = {
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

        with mlflow.start_run(run_name=f"aqi_{name.lower().replace(' ', '_')}"):

            use_scaled = name == 'Ridge Regression'
            X_tr = X_train_scaled if use_scaled else X_train
            X_te = X_test_scaled if use_scaled else X_test

            model.fit(X_tr, y_train)
            y_pred = np.clip(model.predict(X_te), 0, 500)

            mae = mean_absolute_error(y_test, y_pred)
            rmse = np.sqrt(mean_squared_error(y_test, y_pred))
            r2 = r2_score(y_test, y_pred)

            nonzero = y_test > 0
            mape = np.mean(np.abs((y_test[nonzero] - y_pred[nonzero]) / y_test[nonzero])) * 100

            tscv = TimeSeriesSplit(n_splits=5)
            cv = cross_val_score(model, X_tr, y_train, cv=tscv, scoring='neg_mean_absolute_error')
            cv_mae = -cv.mean()

            results[name] = {
                'model': model, 'test_mae': mae, 'test_rmse': rmse,
                'test_r2': r2, 'mape': mape, 'cv_mae': cv_mae,
                'predictions': y_pred
            }

            mlflow.log_param("model_type", name)
            mlflow.log_metric("test_mae", mae)
            mlflow.log_metric("test_rmse", rmse)
            mlflow.log_metric("test_r2", r2)
            mlflow.log_metric("mape", mape)
            mlflow.sklearn.log_model(model, f"aqi_{name.lower().replace(' ', '_')}")

            print(f"  MAE: {mae:.2f}  RMSE: {rmse:.2f}  R2: {r2:.3f}  MAPE: {mape:.1f}%")

    return results, X_test, y_test, scaler

reg_results, X_test_reg, y_test_reg, scaler = train_aqi_models(X, y_reg, df_ml)

# COMMAND ----------

# Model comparison
def compare_regression_models(results, y_test):
    """Compare AQI regression models."""

    fig, axes = plt.subplots(1, 3, figsize=(18, 5))

    for i, (name, r) in enumerate(results.items()):
        if i >= 3:
            break
        ax = axes[i]
        ax.scatter(y_test, r['predictions'], alpha=0.3, s=10, color='steelblue')
        vmin = min(y_test.min(), r['predictions'].min())
        vmax = max(y_test.max(), r['predictions'].max())
        ax.plot([vmin, vmax], [vmin, vmax], 'r--', alpha=0.8)
        ax.text(0.05, 0.95, f"R2={r['test_r2']:.3f}\nMAE={r['test_mae']:.1f}\nMAPE={r['mape']:.1f}%",
                transform=ax.transAxes, va='top',
                bbox={'boxstyle': 'round', 'facecolor': 'white', 'alpha': 0.8})
        ax.set_xlabel('Actual AQI')
        ax.set_ylabel('Predicted AQI')
        ax.set_title(name, fontweight='bold')
        ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/epa_aqi_regression.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

compare_regression_models(reg_results, y_test_reg)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Unhealthy Day Classification

# COMMAND ----------

def train_exceedance_models(X, y, df_ml):
    """Train classification models for unhealthy air day prediction."""

    dates = df_ml.loc[X.index, 'date_local']
    cutoff = dates.quantile(0.8)
    train_mask = dates <= cutoff

    X_train, X_test = X[train_mask], X[~train_mask]
    y_train, y_test = y[train_mask], y[~train_mask]

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    models = {
        'Logistic Regression': LogisticRegression(max_iter=1000, random_state=42),
        'Random Forest': RandomForestClassifier(
            n_estimators=200, max_depth=12, min_samples_leaf=10, random_state=42
        ),
        'Gradient Boosting': GradientBoostingClassifier(
            n_estimators=200, max_depth=6, learning_rate=0.1, random_state=42
        )
    }

    results = {}

    for name, model in models.items():
        print(f"\nTraining {name} for exceedance classification...")

        with mlflow.start_run(run_name=f"exceedance_{name.lower().replace(' ', '_')}"):

            use_scaled = name == 'Logistic Regression'
            X_tr = X_train_scaled if use_scaled else X_train
            X_te = X_test_scaled if use_scaled else X_test

            model.fit(X_tr, y_train)
            y_pred = model.predict(X_te)
            y_prob = model.predict_proba(X_te)[:, 1]

            f1 = f1_score(y_test, y_pred, zero_division=0)
            auc = roc_auc_score(y_test, y_prob) if len(np.unique(y_test)) > 1 else 0

            results[name] = {
                'model': model, 'f1': f1, 'auc': auc,
                'y_pred': y_pred, 'y_prob': y_prob
            }

            mlflow.log_metric("f1", f1)
            mlflow.log_metric("auc", auc)
            mlflow.sklearn.log_model(model, f"exceedance_{name.lower().replace(' ', '_')}")

            print(f"  F1: {f1:.3f}  AUC: {auc:.3f}")

    # Visualization
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))

    ax1 = axes[0]
    for name, r in results.items():
        fpr, tpr, _ = roc_curve(y_test, r['y_prob'])
        ax1.plot(fpr, tpr, linewidth=2, label=f"{name} (AUC={r['auc']:.3f})")
    ax1.plot([0, 1], [0, 1], 'k--', alpha=0.5)
    ax1.set_title('Unhealthy Day Prediction ROC', fontsize=14, fontweight='bold')
    ax1.set_xlabel('FPR')
    ax1.set_ylabel('TPR')
    ax1.legend(fontsize=8)
    ax1.grid(True, alpha=0.3)

    ax2 = axes[1]
    best = max(results.keys(), key=lambda k: results[k]['f1'])
    cm = confusion_matrix(y_test, results[best]['y_pred'])
    sns.heatmap(cm, annot=True, fmt='d', cmap='Blues', ax=ax2,
                xticklabels=['Healthy', 'Unhealthy'],
                yticklabels=['Healthy', 'Unhealthy'])
    ax2.set_title(f'Confusion Matrix ({best})', fontsize=14, fontweight='bold')

    plt.tight_layout()
    plt.savefig('/tmp/epa_exceedance_models.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

    return results, y_test

cls_results, y_test_cls = train_exceedance_models(X, y_cls, df_ml)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Feature Importance

# COMMAND ----------

def analyze_feature_importance(reg_results, feature_names):
    """Feature importance from best regression model."""

    best = min(reg_results.keys(), key=lambda k: reg_results[k]['test_mae'])
    model = reg_results[best]['model']

    if not hasattr(model, 'feature_importances_'):
        print("No feature importances")
        return None

    imp_df = pd.DataFrame({
        'feature': feature_names,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)

    top = imp_df.head(20)

    plt.figure(figsize=(12, 8))
    bars = plt.barh(range(len(top)), top['importance'])
    plt.yticks(range(len(top)), top['feature'])
    plt.xlabel('Importance')
    plt.title(f'Top 20 Features for AQI Prediction ({best})', fontsize=14, fontweight='bold')
    plt.gca().invert_yaxis()
    for i, bar in enumerate(bars):
        bar.set_color('#c0392b' if i < 5 else '#e67e22' if i < 10 else '#3498db')
    plt.tight_layout()
    plt.savefig('/tmp/epa_aqi_feature_importance.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

    return imp_df

feature_importance = analyze_feature_importance(reg_results, feature_names)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results to Delta Lake

# COMMAND ----------

def save_results_to_delta():
    """Save AQI forecasting results to gold layer."""

    # Regression metrics
    reg_data = [{
        'model_name': name,
        'test_mae': float(r['test_mae']),
        'test_rmse': float(r['test_rmse']),
        'test_r2': float(r['test_r2']),
        'mape': float(r['mape']),
        'task': 'aqi_regression',
        'evaluation_date': datetime.now()
    } for name, r in reg_results.items()]

    reg_spark = spark.createDataFrame(pd.DataFrame(reg_data))
    (reg_spark.write.mode("overwrite").option("mergeSchema", "true")
     .saveAsTable("gold.gld_aqi_regression_metrics"))

    # Classification metrics
    cls_data = [{
        'model_name': name,
        'f1': float(r['f1']),
        'auc': float(r['auc']),
        'task': 'exceedance_classification',
        'evaluation_date': datetime.now()
    } for name, r in cls_results.items()]

    cls_spark = spark.createDataFrame(pd.DataFrame(cls_data))
    (cls_spark.write.mode("overwrite").option("mergeSchema", "true")
     .saveAsTable("gold.gld_aqi_exceedance_metrics"))

    # Feature importance
    if feature_importance is not None:
        fi_spark = spark.createDataFrame(feature_importance)
        fi_spark = fi_spark.withColumn("evaluation_date", current_date())
        (fi_spark.write.mode("overwrite").option("mergeSchema", "true")
         .saveAsTable("gold.gld_aqi_feature_importance"))

    print("Results saved to gold layer:")
    print("  - gold.gld_aqi_regression_metrics")
    print("  - gold.gld_aqi_exceedance_metrics")
    print("  - gold.gld_aqi_feature_importance")

save_results_to_delta()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary Report

# COMMAND ----------

print("=" * 60)
print("AIR QUALITY FORECASTING - SUMMARY REPORT")
print("=" * 60)

print("\nDataset Overview:")
print(f"  Total records: {len(df_ml):,}")
print(f"  Sites: {df_ml['site_id'].nunique()}")
print(f"  Pollutants: {df_ml['parameter_name'].nunique()}")
print(f"  Features: {len(feature_names)}")
print(f"  Unhealthy days: {df_ml['is_unhealthy'].sum():,} ({df_ml['is_unhealthy'].mean()*100:.1f}%)")

best_reg = min(reg_results.keys(), key=lambda k: reg_results[k]['test_mae'])
print(f"\nAQI Regression (Best: {best_reg}):")
print(f"  MAE: {reg_results[best_reg]['test_mae']:.2f}")
print(f"  R2: {reg_results[best_reg]['test_r2']:.3f}")
print(f"  MAPE: {reg_results[best_reg]['mape']:.1f}%")

best_cls = max(cls_results.keys(), key=lambda k: cls_results[k]['f1'])
print(f"\nExceedance Classification (Best: {best_cls}):")
print(f"  F1: {cls_results[best_cls]['f1']:.3f}")
print(f"  AUC: {cls_results[best_cls]['auc']:.3f}")

print("\nTop Features:")
if feature_importance is not None:
    for _, row in feature_importance.head(5).iterrows():
        print(f"  - {row['feature']}: {row['importance']:.4f}")

print("\nOutputs:")
print("  - gold.gld_aqi_regression_metrics")
print("  - gold.gld_aqi_exceedance_metrics")
print("  - gold.gld_aqi_feature_importance")
print("  - Visualizations: /tmp/epa_*.png")
print("  - MLflow: /EPA/air_quality_forecasting")

print("=" * 60)
