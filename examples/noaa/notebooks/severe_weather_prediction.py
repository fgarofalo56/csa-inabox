# Databricks notebook source
# MAGIC %md
# MAGIC # Severe Weather Prediction Model
# MAGIC
# MAGIC This notebook builds predictive models for severe weather events, including:
# MAGIC - Feature engineering from weather observations and storm event history
# MAGIC - Classification models for storm severity and type prediction
# MAGIC - Regression models for damage estimation
# MAGIC - MLflow experiment tracking and model registry
# MAGIC - Storm risk scoring for geographic regions
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
    accuracy_score,
    confusion_matrix,
    f1_score,
    mean_absolute_error,
    mean_squared_error,
    precision_score,
    r2_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)
from sklearn.model_selection import cross_val_score, train_test_split
from sklearn.preprocessing import LabelEncoder, StandardScaler

# Configuration
plt.style.use('seaborn-v0_8')
sns.set_palette("husl")
FIGURE_DPI = 300

mlflow.set_experiment("/NOAA/severe_weather_prediction")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading

# COMMAND ----------

# Load storm events
def load_storm_data():
    """Load storm event data from silver layer."""

    storm_df = spark.table("silver.slv_storm_events").toPandas()

    storm_df = storm_df[
        (storm_df['event_id'].notna()) &
        (storm_df['begin_date'].notna()) &
        (storm_df['event_type'].notna()) &
        (storm_df['is_valid_record'] == True)
    ].copy()

    storm_df['begin_date'] = pd.to_datetime(storm_df['begin_date'], errors='coerce')

    print(f"Loaded {len(storm_df):,} storm events")
    print(f"Event types: {storm_df['event_type'].nunique()}")

    return storm_df

df_storms = load_storm_data()

# COMMAND ----------

# Load weather data for environmental context
def load_weather_data():
    """Load weather observations for feature enrichment."""

    weather_df = spark.table("silver.slv_weather_stations").toPandas()

    weather_df = weather_df[
        (weather_df['station_id'].notna()) &
        (weather_df['is_valid_record'] == True)
    ].copy()

    weather_df['observation_date'] = pd.to_datetime(weather_df['observation_date'], errors='coerce')

    # Pivot elements
    pivot = weather_df.pivot_table(
        index=['station_id', 'observation_date', 'state_code', 'latitude', 'longitude'],
        columns='element',
        values='value',
        aggfunc='first'
    ).reset_index()
    pivot.columns.name = None

    for col in ['TMAX', 'TMIN']:
        if col in pivot.columns:
            pivot[col] = pivot[col] / 10.0
    if 'PRCP' in pivot.columns:
        pivot['PRCP'] = pivot['PRCP'] / 10.0

    if 'TMAX' in pivot.columns and 'TMIN' in pivot.columns:
        pivot['TAVG'] = (pivot['TMAX'] + pivot['TMIN']) / 2.0

    print(f"Loaded {len(pivot):,} weather observations")
    return pivot

df_weather = load_weather_data()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Feature Engineering

# COMMAND ----------

# Prepare storm prediction features
def prepare_storm_features(storms, weather):
    """Engineer features for storm severity prediction."""

    df = storms.copy()

    # --- Parse damage values ---
    def parse_damage(val):
        if pd.isna(val) or val == '' or val == '0':
            return 0.0
        val = str(val).upper().strip()
        try:
            if val.endswith('K'):
                return float(val[:-1]) * 1000
            if val.endswith('M'):
                return float(val[:-1]) * 1000000
            if val.endswith('B'):
                return float(val[:-1]) * 1000000000
            return float(val)
        except (ValueError, IndexError):
            return 0.0

    df['property_damage_val'] = df['damage_property'].apply(parse_damage)
    df['crop_damage_val'] = df['damage_crops'].apply(parse_damage)
    df['total_damage'] = df['property_damage_val'] + df['crop_damage_val']

    df['total_injuries'] = df['injuries_direct'].fillna(0) + df['injuries_indirect'].fillna(0)
    df['total_deaths'] = df['deaths_direct'].fillna(0) + df['deaths_indirect'].fillna(0)
    df['total_casualties'] = df['total_injuries'] + df['total_deaths']

    # --- Target: severity classification ---
    def classify_severity(row):
        if row['total_deaths'] > 0:
            return 3  # Fatal
        if row['total_injuries'] > 0:
            return 2  # Injury
        if row['total_damage'] > 100000:
            return 2  # Major damage
        if row['total_damage'] > 10000:
            return 1  # Moderate
        return 0  # Minor

    df['severity_class'] = df.apply(classify_severity, axis=1)

    # Binary: significant event (severity >= 2)
    df['is_significant'] = (df['severity_class'] >= 2).astype(int)

    # --- Calendar features ---
    df['month'] = df['begin_date'].dt.month
    df['day_of_year'] = df['begin_date'].dt.dayofyear
    df['month_sin'] = np.sin(2 * np.pi * df['month'] / 12)
    df['month_cos'] = np.cos(2 * np.pi * df['month'] / 12)
    df['doy_sin'] = np.sin(2 * np.pi * df['day_of_year'] / 365)
    df['doy_cos'] = np.cos(2 * np.pi * df['day_of_year'] / 365)

    # --- Magnitude features ---
    df['magnitude_filled'] = df['magnitude'].fillna(0)
    df['has_magnitude'] = df['magnitude'].notna().astype(int)

    # Tornado F-scale encoding
    fscale_map = {'EF0': 0, 'EF1': 1, 'EF2': 2, 'EF3': 3, 'EF4': 4, 'EF5': 5,
                  'F0': 0, 'F1': 1, 'F2': 2, 'F3': 3, 'F4': 4, 'F5': 5}
    df['fscale_num'] = df['tor_f_scale'].map(fscale_map).fillna(-1)

    # Tornado path features
    df['tor_length_filled'] = df['tor_length'].fillna(0)
    df['tor_width_filled'] = df['tor_width'].fillna(0)
    df['is_tornado'] = (df['event_type'].str.upper() == 'TORNADO').astype(int)

    # --- Location features ---
    df['begin_lat_filled'] = df['begin_lat'].fillna(df['begin_lat'].median())
    df['begin_lon_filled'] = df['begin_lon'].fillna(df['begin_lon'].median())

    # State encoding
    le_state = LabelEncoder()
    df['state_encoded'] = le_state.fit_transform(df['state'].fillna('UNKNOWN'))

    # CZ type encoding
    cz_map = {'C': 0, 'Z': 1, 'M': 2}
    df['cz_type_encoded'] = df['cz_type'].map(cz_map).fillna(0)

    # --- Event type encoding ---
    le_event = LabelEncoder()
    df['event_type_encoded'] = le_event.fit_transform(df['event_type'].fillna('UNKNOWN'))

    # Event type risk grouping
    high_risk_events = ['TORNADO', 'HURRICANE', 'TROPICAL STORM', 'ICE STORM',
                        'BLIZZARD', 'FLASH FLOOD', 'WILDFIRE']
    medium_risk_events = ['THUNDERSTORM WIND', 'HAIL', 'WINTER STORM', 'FLOOD',
                          'HIGH WIND', 'HEAVY RAIN']
    df['event_risk_group'] = df['event_type'].apply(
        lambda x: 2 if x in high_risk_events else 1 if x in medium_risk_events else 0
    )

    # --- Weather context (aggregate monthly state-level averages) ---
    if len(weather) > 0:
        weather['month'] = weather['observation_date'].dt.month
        state_monthly_wx = weather.groupby(['state_code', 'month']).agg(
            wx_avg_tmax=('TMAX', 'mean'),
            wx_avg_prcp=('PRCP', 'mean')
        ).reset_index()
        state_monthly_wx.columns = ['state', 'month', 'wx_avg_tmax', 'wx_avg_prcp']
        df = df.merge(state_monthly_wx, on=['state', 'month'], how='left')
        df['wx_avg_tmax'] = df['wx_avg_tmax'].fillna(df['wx_avg_tmax'].median())
        df['wx_avg_prcp'] = df['wx_avg_prcp'].fillna(df['wx_avg_prcp'].median())

    # --- Historical state-level storm frequency ---
    state_freq = df.groupby('state').agg(
        state_storm_count=('event_id', 'count'),
        state_avg_damage=('total_damage', 'mean'),
        state_casualty_rate=('is_significant', 'mean')
    ).reset_index()
    df = df.merge(state_freq, on='state', how='left')

    df = df.dropna(subset=['month', 'begin_lat_filled'])

    print(f"Prepared {len(df):,} storm records with {df.shape[1]} features")
    print(f"Severity distribution: {dict(df['severity_class'].value_counts())}")

    return df, le_state, le_event

df_model, le_state, le_event = prepare_storm_features(df_storms, df_weather)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Model Training - Severity Classification

# COMMAND ----------

# Build feature matrix
def build_feature_matrix(df):
    """Build feature matrix for storm severity prediction."""

    feature_cols = [
        'month_sin', 'month_cos', 'doy_sin', 'doy_cos',
        'magnitude_filled', 'has_magnitude', 'fscale_num',
        'tor_length_filled', 'tor_width_filled', 'is_tornado',
        'begin_lat_filled', 'begin_lon_filled',
        'state_encoded', 'cz_type_encoded',
        'event_type_encoded', 'event_risk_group',
        'state_storm_count', 'state_avg_damage', 'state_casualty_rate'
    ]

    # Add weather context if available
    for col in ['wx_avg_tmax', 'wx_avg_prcp']:
        if col in df.columns:
            feature_cols.append(col)

    available = [c for c in feature_cols if c in df.columns]

    X = df[available].copy()
    y_class = df['is_significant'].copy()
    y_reg = np.log1p(df['total_damage'].copy())

    mask = X.notna().all(axis=1)
    X, y_class, y_reg = X[mask], y_class[mask], y_reg[mask]

    print(f"Feature matrix: {X.shape[0]:,} x {X.shape[1]}")

    return X, y_class, y_reg, available

X, y_class, y_reg, feature_names = build_feature_matrix(df_model)

# COMMAND ----------

# Train classification models
def train_severity_models(X, y):
    """Train severity classification models."""

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

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
        print(f"\nTraining {name}...")

        with mlflow.start_run(run_name=f"severity_{name.lower().replace(' ', '_')}"):

            use_scaled = name == 'Logistic Regression'
            X_tr = X_train_scaled if use_scaled else X_train
            X_te = X_test_scaled if use_scaled else X_test

            model.fit(X_tr, y_train)
            y_pred = model.predict(X_te)
            y_prob = model.predict_proba(X_te)[:, 1]

            acc = accuracy_score(y_test, y_pred)
            prec = precision_score(y_test, y_pred, zero_division=0)
            rec = recall_score(y_test, y_pred, zero_division=0)
            f1 = f1_score(y_test, y_pred, zero_division=0)
            auc = roc_auc_score(y_test, y_prob) if len(np.unique(y_test)) > 1 else 0

            cv_scores = cross_val_score(model, X_tr, y_train, cv=5, scoring='f1')

            results[name] = {
                'model': model, 'accuracy': acc, 'precision': prec,
                'recall': rec, 'f1': f1, 'auc': auc,
                'cv_f1': cv_scores.mean(), 'cv_std': cv_scores.std(),
                'y_prob': y_prob, 'y_pred': y_pred
            }

            mlflow.log_param("model_type", name)
            mlflow.log_metric("accuracy", acc)
            mlflow.log_metric("f1", f1)
            mlflow.log_metric("auc", auc)
            mlflow.log_metric("cv_f1", cv_scores.mean())
            mlflow.sklearn.log_model(model, f"severity_{name.lower().replace(' ', '_')}")

            print(f"  Acc: {acc:.3f}  F1: {f1:.3f}  AUC: {auc:.3f}  CV-F1: {cv_scores.mean():.3f}")

    return results, X_test, y_test, scaler

clf_results, X_test_clf, y_test_clf, scaler = train_severity_models(X, y_class)

# COMMAND ----------

# Model comparison
def compare_models(results, y_test):
    """Compare classification model performance."""

    fig, axes = plt.subplots(1, 3, figsize=(18, 5))

    # Metrics comparison
    ax1 = axes[0]
    metrics = ['accuracy', 'precision', 'recall', 'f1', 'auc']
    x = np.arange(len(metrics))
    width = 0.25
    for i, (name, r) in enumerate(results.items()):
        vals = [r[m] for m in metrics]
        ax1.bar(x + i * width, vals, width, label=name, alpha=0.85)
    ax1.set_xticks(x + width)
    ax1.set_xticklabels([m.upper() for m in metrics])
    ax1.set_title('Model Metrics Comparison', fontsize=14, fontweight='bold')
    ax1.legend(fontsize=8)
    ax1.set_ylim(0, 1.05)
    ax1.grid(True, alpha=0.3, axis='y')

    # ROC curves
    ax2 = axes[1]
    for name, r in results.items():
        fpr, tpr, _ = roc_curve(y_test, r['y_prob'])
        ax2.plot(fpr, tpr, linewidth=2, label=f"{name} (AUC={r['auc']:.3f})")
    ax2.plot([0, 1], [0, 1], 'k--', alpha=0.5)
    ax2.set_title('ROC Curves', fontsize=14, fontweight='bold')
    ax2.set_xlabel('FPR')
    ax2.set_ylabel('TPR')
    ax2.legend(fontsize=8)
    ax2.grid(True, alpha=0.3)

    # Confusion matrix
    ax3 = axes[2]
    best = max(results.keys(), key=lambda k: results[k]['f1'])
    cm = confusion_matrix(y_test, results[best]['y_pred'])
    sns.heatmap(cm, annot=True, fmt='d', cmap='Blues', ax=ax3,
                xticklabels=['Minor', 'Significant'],
                yticklabels=['Minor', 'Significant'])
    ax3.set_title(f'Confusion Matrix ({best})', fontsize=14, fontweight='bold')
    ax3.set_xlabel('Predicted')
    ax3.set_ylabel('Actual')

    plt.tight_layout()
    plt.savefig('/tmp/noaa_severity_models.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

compare_models(clf_results, y_test_clf)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Feature Importance

# COMMAND ----------

def analyze_feature_importance(results, feature_names):
    """Analyze feature importance from best model."""

    best = 'Gradient Boosting' if 'Gradient Boosting' in results else \
           max(results.keys(), key=lambda k: results[k]['f1'])
    model = results[best]['model']

    if not hasattr(model, 'feature_importances_'):
        print("No feature importances available")
        return None

    imp_df = pd.DataFrame({
        'feature': feature_names,
        'importance': model.feature_importances_
    }).sort_values('importance', ascending=False)

    top = imp_df.head(15)

    plt.figure(figsize=(12, 7))
    bars = plt.barh(range(len(top)), top['importance'])
    plt.yticks(range(len(top)), top['feature'])
    plt.xlabel('Importance')
    plt.title(f'Top 15 Features ({best})', fontsize=14, fontweight='bold')
    plt.gca().invert_yaxis()
    for i, bar in enumerate(bars):
        bar.set_color('#c0392b' if i < 3 else '#e67e22' if i < 8 else '#3498db')
    plt.tight_layout()
    plt.savefig('/tmp/noaa_feature_importance.png', dpi=FIGURE_DPI, bbox_inches='tight')
    plt.show()

    return imp_df

feature_importance = analyze_feature_importance(clf_results, feature_names)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Damage Regression Model

# COMMAND ----------

# Train damage estimation model
def train_damage_model(X, y):
    """Train regression model for storm damage estimation."""

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    models = {
        'Ridge Regression': Ridge(alpha=10.0),
        'Random Forest': RandomForestRegressor(
            n_estimators=200, max_depth=10, min_samples_leaf=10, random_state=42
        ),
        'Gradient Boosting': GradientBoostingRegressor(
            n_estimators=200, max_depth=5, learning_rate=0.1, random_state=42
        )
    }

    results = {}

    for name, model in models.items():
        print(f"\nTraining {name} for damage regression...")

        with mlflow.start_run(run_name=f"damage_{name.lower().replace(' ', '_')}"):
            model.fit(X_train, y_train)
            y_pred = model.predict(X_test)

            mae = mean_absolute_error(y_test, y_pred)
            rmse = np.sqrt(mean_squared_error(y_test, y_pred))
            r2 = r2_score(y_test, y_pred)

            results[name] = {
                'model': model, 'test_mae': mae, 'test_rmse': rmse, 'test_r2': r2,
                'predictions': y_pred
            }

            mlflow.log_param("model_type", name)
            mlflow.log_param("task", "damage_regression")
            mlflow.log_metric("test_mae", mae)
            mlflow.log_metric("test_rmse", rmse)
            mlflow.log_metric("test_r2", r2)
            mlflow.sklearn.log_model(model, f"damage_{name.lower().replace(' ', '_')}")

            print(f"  MAE: {mae:.3f}  RMSE: {rmse:.3f}  R2: {r2:.3f}")

    return results, X_test, y_test

reg_results, X_test_reg, y_test_reg = train_damage_model(X, y_reg)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results to Delta Lake

# COMMAND ----------

def save_results_to_delta(clf_results, reg_results, feature_importance):
    """Save model results to gold layer."""

    # Classification metrics
    clf_data = [{
        'model_name': name,
        'accuracy': float(r['accuracy']),
        'precision': float(r['precision']),
        'recall': float(r['recall']),
        'f1': float(r['f1']),
        'auc': float(r['auc']),
        'cv_f1': float(r['cv_f1']),
        'task': 'severity_classification',
        'evaluation_date': datetime.now()
    } for name, r in clf_results.items()]

    clf_spark = spark.createDataFrame(pd.DataFrame(clf_data))
    (clf_spark.write.mode("overwrite").option("mergeSchema", "true")
     .saveAsTable("gold.gld_weather_severity_metrics"))

    # Regression metrics
    reg_data = [{
        'model_name': name,
        'test_mae': float(r['test_mae']),
        'test_rmse': float(r['test_rmse']),
        'test_r2': float(r['test_r2']),
        'task': 'damage_regression',
        'evaluation_date': datetime.now()
    } for name, r in reg_results.items()]

    reg_spark = spark.createDataFrame(pd.DataFrame(reg_data))
    (reg_spark.write.mode("overwrite").option("mergeSchema", "true")
     .saveAsTable("gold.gld_weather_damage_metrics"))

    # Feature importance
    if feature_importance is not None:
        fi_spark = spark.createDataFrame(feature_importance)
        fi_spark = fi_spark.withColumn("evaluation_date", current_date())
        (fi_spark.write.mode("overwrite").option("mergeSchema", "true")
         .saveAsTable("gold.gld_weather_feature_importance"))

    print("Results saved to gold layer:")
    print("  - gold.gld_weather_severity_metrics")
    print("  - gold.gld_weather_damage_metrics")
    print("  - gold.gld_weather_feature_importance")

save_results_to_delta(clf_results, reg_results, feature_importance)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary Report

# COMMAND ----------

print("=" * 60)
print("SEVERE WEATHER PREDICTION - SUMMARY REPORT")
print("=" * 60)

print("\nDataset Overview:")
print(f"  Storm events: {len(df_model):,}")
print(f"  Event types: {df_model['event_type'].nunique()}")
print(f"  Features: {len(feature_names)}")
print(f"  Significant events: {df_model['is_significant'].sum():,} "
      f"({df_model['is_significant'].mean()*100:.1f}%)")

best_clf = max(clf_results.keys(), key=lambda k: clf_results[k]['f1'])
print(f"\nSeverity Classification (Best: {best_clf}):")
print(f"  F1: {clf_results[best_clf]['f1']:.3f}")
print(f"  AUC: {clf_results[best_clf]['auc']:.3f}")
print(f"  CV-F1: {clf_results[best_clf]['cv_f1']:.3f}")

best_reg = min(reg_results.keys(), key=lambda k: reg_results[k]['test_mae'])
print(f"\nDamage Regression (Best: {best_reg}):")
print(f"  MAE (log): {reg_results[best_reg]['test_mae']:.3f}")
print(f"  R2: {reg_results[best_reg]['test_r2']:.3f}")

print("\nTop Predictive Features:")
if feature_importance is not None:
    for _, row in feature_importance.head(5).iterrows():
        print(f"  - {row['feature']}: {row['importance']:.4f}")

print("\nOutputs:")
print("  - gold.gld_weather_severity_metrics")
print("  - gold.gld_weather_damage_metrics")
print("  - gold.gld_weather_feature_importance")
print("  - Visualizations: /tmp/noaa_*.png")
print("  - MLflow: /NOAA/severe_weather_prediction")

print("=" * 60)
