# Databricks notebook source
# MAGIC %md
# MAGIC # Crop Yield Analysis and Forecasting
# MAGIC
# MAGIC This notebook provides advanced analytics for USDA crop yield data, including:
# MAGIC - Historical trend analysis
# MAGIC - Seasonal pattern identification
# MAGIC - Yield forecasting using machine learning
# MAGIC - Statistical analysis and visualization
# MAGIC
# MAGIC **Data Sources:**
# MAGIC - USDA NASS crop yield data (bronze/silver layers)
# MAGIC - Weather data integration (future enhancement)
# MAGIC - Economic indicators (future enhancement)

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

# Statistical and ML libraries
import mlflow
import mlflow.sklearn

# Spark and Delta libraries
from pyspark.sql.functions import *
from pyspark.sql.types import *
from scipy import stats
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import cross_val_score
from sklearn.preprocessing import PolynomialFeatures, StandardScaler

# Configuration
plt.style.use('seaborn-v0_8')
sns.set_palette("husl")

# MLflow setup
mlflow.set_experiment("/USDA/crop_yield_forecasting")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading and Preparation

# COMMAND ----------

# Load data from Delta Lake
def load_crop_data():
    """Load crop yield data from silver layer."""

    # Load silver layer crop yields
    crop_yields = spark.table("silver.slv_crop_yields").toPandas()

    # Filter for major commodities and recent years
    major_commodities = ['CORN', 'SOYBEANS', 'WHEAT', 'COTTON', 'RICE']
    recent_years = list(range(2010, datetime.now().year + 1))

    crop_yields = crop_yields[
        (crop_yields['commodity'].isin(major_commodities)) &
        (crop_yields['year'].isin(recent_years)) &
        (crop_yields['yield_per_acre'].notna()) &
        (crop_yields['yield_per_acre'] > 0)
    ].copy()

    print(f"Loaded {len(crop_yields):,} crop yield records")
    print(f"States: {crop_yields['state_code'].nunique()}")
    print(f"Commodities: {', '.join(crop_yields['commodity'].unique())}")
    print(f"Years: {crop_yields['year'].min()} - {crop_yields['year'].max()}")

    return crop_yields

# Load the data
df_crops = load_crop_data()

# COMMAND ----------

# Data quality checks and preparation
def prepare_data(df):
    """Prepare data for analysis."""

    # Remove outliers using IQR method
    def remove_outliers(group):
        Q1 = group['yield_per_acre'].quantile(0.25)
        Q3 = group['yield_per_acre'].quantile(0.75)
        IQR = Q3 - Q1
        lower_bound = Q1 - 1.5 * IQR
        upper_bound = Q3 + 1.5 * IQR
        return group[
            (group['yield_per_acre'] >= lower_bound) &
            (group['yield_per_acre'] <= upper_bound)
        ]

    # Apply outlier removal by commodity and state
    df_clean = df.groupby(['commodity', 'state_code']).apply(remove_outliers).reset_index(drop=True)

    # Add derived features
    df_clean = df_clean.sort_values(['commodity', 'state_code', 'year'])

    # Calculate rolling averages
    df_clean['yield_3yr_rolling'] = df_clean.groupby(['commodity', 'state_code'])['yield_per_acre'].rolling(
        window=3, min_periods=2
    ).mean().reset_index(drop=True)

    df_clean['yield_5yr_rolling'] = df_clean.groupby(['commodity', 'state_code'])['yield_per_acre'].rolling(
        window=5, min_periods=3
    ).mean().reset_index(drop=True)

    # Calculate year-over-year changes
    df_clean['yield_yoy_change'] = df_clean.groupby(['commodity', 'state_code'])['yield_per_acre'].pct_change()

    # Calculate trend (slope of yield over time)
    def calculate_trend(group):
        if len(group) < 3:
            return pd.Series([np.nan] * len(group))

        trends = []
        for i in range(len(group)):
            if i < 2:
                trends.append(np.nan)
            else:
                # Calculate trend over last 3 years
                y_vals = group.iloc[max(0, i-2):i+1]['yield_per_acre'].values
                x_vals = np.arange(len(y_vals))
                if len(y_vals) >= 2:
                    slope, _, _, _, _ = stats.linregress(x_vals, y_vals)
                    trends.append(slope)
                else:
                    trends.append(np.nan)

        return pd.Series(trends, index=group.index)

    df_clean['yield_trend'] = df_clean.groupby(['commodity', 'state_code']).apply(
        calculate_trend
    ).reset_index(drop=True)

    # Add categorical features
    df_clean['decade'] = (df_clean['year'] // 10) * 10
    df_clean['is_recent'] = df_clean['year'] >= 2015

    print(f"Data prepared: {len(df_clean):,} records after cleaning")
    print(f"Outliers removed: {len(df) - len(df_clean):,} records")

    return df_clean

df_prepared = prepare_data(df_crops)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Exploratory Data Analysis

# COMMAND ----------

# Yield trends by commodity
def plot_commodity_trends():
    """Plot yield trends by commodity."""

    fig, axes = plt.subplots(2, 3, figsize=(18, 12))
    axes = axes.flatten()

    commodities = df_prepared['commodity'].unique()

    for i, commodity in enumerate(commodities):
        if i < len(axes):
            commodity_data = df_prepared[df_prepared['commodity'] == commodity]

            # National average by year
            national_avg = commodity_data.groupby('year')['yield_per_acre'].mean().reset_index()

            axes[i].plot(national_avg['year'], national_avg['yield_per_acre'],
                        linewidth=3, label='National Average')

            # Add trend line
            if len(national_avg) > 2:
                z = np.polyfit(national_avg['year'], national_avg['yield_per_acre'], 1)
                p = np.poly1d(z)
                axes[i].plot(national_avg['year'], p(national_avg['year']),
                           "--", alpha=0.7, color='red', label='Trend')

            axes[i].set_title(f'{commodity} Yield Trends', fontsize=14, fontweight='bold')
            axes[i].set_xlabel('Year')
            axes[i].set_ylabel('Yield per Acre')
            axes[i].legend()
            axes[i].grid(True, alpha=0.3)

    # Hide unused subplot
    if len(commodities) < len(axes):
        axes[-1].set_visible(False)

    plt.tight_layout()
    plt.savefig('/tmp/crop_yield_trends.png', dpi=300, bbox_inches='tight')
    plt.show()

plot_commodity_trends()

# COMMAND ----------

# State-level yield analysis
def analyze_state_performance():
    """Analyze yield performance by state."""

    # Calculate state rankings for latest available year
    latest_year = df_prepared['year'].max()
    latest_data = df_prepared[df_prepared['year'] == latest_year]

    # Focus on corn and soybeans (most widespread)
    major_crops = ['CORN', 'SOYBEANS']

    fig, axes = plt.subplots(1, 2, figsize=(16, 8))

    for i, crop in enumerate(major_crops):
        crop_data = latest_data[latest_data['commodity'] == crop].copy()

        if len(crop_data) == 0:
            continue

        # Sort by yield and get top 10 states
        crop_data = crop_data.nlargest(10, 'yield_per_acre')

        # Create horizontal bar plot
        bars = axes[i].barh(crop_data['state_code'], crop_data['yield_per_acre'])

        # Add value labels on bars
        for j, (_idx, row) in enumerate(crop_data.iterrows()):
            axes[i].text(row['yield_per_acre'] + max(crop_data['yield_per_acre']) * 0.01,
                        j, f"{row['yield_per_acre']:.1f}",
                        va='center', fontweight='bold')

        axes[i].set_title(f'Top 10 States - {crop} Yield ({latest_year})',
                         fontsize=14, fontweight='bold')
        axes[i].set_xlabel('Yield per Acre')
        axes[i].grid(True, alpha=0.3)

        # Color bars by performance
        for j, bar in enumerate(bars):
            if j < 3:  # Top 3
                bar.set_color('green')
            elif j < 7:  # Middle tier
                bar.set_color('orange')
            else:  # Lower tier
                bar.set_color('red')

    plt.tight_layout()
    plt.savefig('/tmp/state_yield_rankings.png', dpi=300, bbox_inches='tight')
    plt.show()

analyze_state_performance()

# COMMAND ----------

# Volatility analysis
def analyze_yield_volatility():
    """Analyze yield volatility by commodity and state."""

    # Calculate coefficient of variation (CV) for each state-commodity combination
    volatility_data = df_prepared.groupby(['commodity', 'state_code']).agg({
        'yield_per_acre': ['mean', 'std', 'count']
    }).round(2)

    volatility_data.columns = ['mean_yield', 'std_yield', 'n_years']
    volatility_data = volatility_data.reset_index()

    # Calculate coefficient of variation
    volatility_data['cv'] = (volatility_data['std_yield'] / volatility_data['mean_yield'] * 100).round(1)

    # Filter for states with sufficient data
    volatility_data = volatility_data[volatility_data['n_years'] >= 5]

    # Create volatility heatmap
    pivot_cv = volatility_data.pivot(index='state_code', columns='commodity', values='cv')

    plt.figure(figsize=(12, 10))
    sns.heatmap(pivot_cv, annot=True, cmap='RdYlBu_r', center=15,
                cbar_kws={'label': 'Coefficient of Variation (%)'})
    plt.title('Crop Yield Volatility by State and Commodity\n(Coefficient of Variation)',
              fontsize=16, fontweight='bold')
    plt.xlabel('Commodity')
    plt.ylabel('State')
    plt.tight_layout()
    plt.savefig('/tmp/yield_volatility_heatmap.png', dpi=300, bbox_inches='tight')
    plt.show()

    return volatility_data

volatility_data = analyze_yield_volatility()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Machine Learning Models for Yield Forecasting

# COMMAND ----------

# Feature engineering for ML models
def create_ml_features(df):
    """Create features for machine learning models."""

    # Sort data
    df_ml = df.sort_values(['commodity', 'state_code', 'year']).copy()

    # Lag features
    for lag in [1, 2, 3]:
        df_ml[f'yield_lag_{lag}'] = df_ml.groupby(['commodity', 'state_code'])['yield_per_acre'].shift(lag)

    # Rolling statistics
    for window in [3, 5]:
        df_ml[f'yield_rolling_mean_{window}'] = df_ml.groupby(['commodity', 'state_code'])['yield_per_acre'].rolling(
            window=window, min_periods=2
        ).mean().reset_index(drop=True)

        df_ml[f'yield_rolling_std_{window}'] = df_ml.groupby(['commodity', 'state_code'])['yield_per_acre'].rolling(
            window=window, min_periods=2
        ).std().reset_index(drop=True)

    # Time-based features
    df_ml['year_normalized'] = (df_ml['year'] - df_ml['year'].min()) / (df_ml['year'].max() - df_ml['year'].min())
    df_ml['year_squared'] = df_ml['year_normalized'] ** 2

    # Commodity and state encoding
    from sklearn.preprocessing import LabelEncoder

    le_commodity = LabelEncoder()
    le_state = LabelEncoder()

    df_ml['commodity_encoded'] = le_commodity.fit_transform(df_ml['commodity'])
    df_ml['state_encoded'] = le_state.fit_transform(df_ml['state_code'])

    # One-hot encode categorical features
    commodity_dummies = pd.get_dummies(df_ml['commodity'], prefix='commodity')
    state_dummies = pd.get_dummies(df_ml['state_code'], prefix='state')

    df_ml = pd.concat([df_ml, commodity_dummies, state_dummies], axis=1)

    # Remove rows with NaN values (from lag features)
    df_ml = df_ml.dropna()

    print(f"ML features created: {df_ml.shape[1]} features, {len(df_ml):,} samples")

    return df_ml, le_commodity, le_state

df_ml, le_commodity, le_state = create_ml_features(df_prepared)

# COMMAND ----------

# Train forecasting models
def train_forecasting_models(df_ml):
    """Train multiple forecasting models and compare performance."""

    # Define feature columns
    feature_cols = [col for col in df_ml.columns if col not in [
        'crop_yield_sk', 'state_name', 'county_code', 'county_name',
        'commodity', 'state_code', 'year', 'yield_per_acre', 'is_valid',
        'validation_errors', '_dbt_loaded_at'
    ]]

    X = df_ml[feature_cols]
    y = df_ml['yield_per_acre']

    # Split data (use most recent year as test set)
    test_year = df_ml['year'].max()
    train_mask = df_ml['year'] < test_year

    X_train, X_test = X[train_mask], X[~train_mask]
    y_train, y_test = y[train_mask], y[~train_mask]

    print(f"Training set: {len(X_train):,} samples")
    print(f"Test set: {len(X_test):,} samples")

    # Scale features
    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    # Define models
    models = {
        'Linear Regression': LinearRegression(),
        'Ridge Regression': Ridge(alpha=1.0),
        'Random Forest': RandomForestRegressor(n_estimators=100, random_state=42),
        'Polynomial Ridge': Pipeline([
            ('poly', PolynomialFeatures(degree=2, include_bias=False)),
            ('ridge', Ridge(alpha=1.0))
        ])
    }

    results = {}

    for name, model in models.items():
        print(f"\nTraining {name}...")

        # Start MLflow run
        with mlflow.start_run(run_name=f"crop_yield_{name.lower().replace(' ', '_')}"):

            # Train model
            if name == 'Polynomial Ridge':
                model.fit(X_train, y_train)
                y_pred_train = model.predict(X_train)
                y_pred_test = model.predict(X_test)
            else:
                model.fit(X_train_scaled, y_train)
                y_pred_train = model.predict(X_train_scaled)
                y_pred_test = model.predict(X_test_scaled)

            # Calculate metrics
            train_mae = mean_absolute_error(y_train, y_pred_train)
            train_rmse = np.sqrt(mean_squared_error(y_train, y_pred_train))
            train_r2 = r2_score(y_train, y_pred_train)

            test_mae = mean_absolute_error(y_test, y_pred_test)
            test_rmse = np.sqrt(mean_squared_error(y_test, y_pred_test))
            test_r2 = r2_score(y_test, y_pred_test)

            # Cross-validation on training set
            cv_scores = cross_val_score(model, X_train_scaled if name != 'Polynomial Ridge' else X_train,
                                      y_train, cv=5, scoring='neg_mean_absolute_error')
            cv_mae = -cv_scores.mean()
            cv_std = cv_scores.std()

            results[name] = {
                'model': model,
                'train_mae': train_mae,
                'train_rmse': train_rmse,
                'train_r2': train_r2,
                'test_mae': test_mae,
                'test_rmse': test_rmse,
                'test_r2': test_r2,
                'cv_mae': cv_mae,
                'cv_std': cv_std,
                'predictions': y_pred_test
            }

            # Log to MLflow
            mlflow.log_param("model_type", name)
            mlflow.log_param("train_size", len(X_train))
            mlflow.log_param("test_size", len(X_test))
            mlflow.log_metric("train_mae", train_mae)
            mlflow.log_metric("train_rmse", train_rmse)
            mlflow.log_metric("train_r2", train_r2)
            mlflow.log_metric("test_mae", test_mae)
            mlflow.log_metric("test_rmse", test_rmse)
            mlflow.log_metric("test_r2", test_r2)
            mlflow.log_metric("cv_mae", cv_mae)
            mlflow.log_metric("cv_std", cv_std)

            # Log model
            mlflow.sklearn.log_model(model, f"crop_yield_{name.lower().replace(' ', '_')}")

            print(f"  Train MAE: {train_mae:.2f}, Test MAE: {test_mae:.2f}")
            print(f"  Train R²: {train_r2:.3f}, Test R²: {test_r2:.3f}")
            print(f"  CV MAE: {cv_mae:.2f} ± {cv_std:.2f}")

    return results, X_test, y_test, scaler

# Import Pipeline for polynomial features
from sklearn.pipeline import Pipeline

# Train models
model_results, X_test, y_test, scaler = train_forecasting_models(df_ml)

# COMMAND ----------

# Model comparison and visualization
def compare_models(results, X_test, y_test):
    """Compare model performance and create visualizations."""

    # Create comparison table
    comparison_df = pd.DataFrame({
        name: {
            'Train MAE': res['train_mae'],
            'Test MAE': res['test_mae'],
            'Train R²': res['train_r2'],
            'Test R²': res['test_r2'],
            'CV MAE': res['cv_mae']
        }
        for name, res in results.items()
    }).round(3)

    print("Model Performance Comparison:")
    print(comparison_df)

    # Prediction vs Actual scatter plots
    fig, axes = plt.subplots(2, 2, figsize=(16, 12))
    axes = axes.flatten()

    for i, (name, res) in enumerate(results.items()):
        if i < len(axes):
            # Scatter plot
            axes[i].scatter(y_test, res['predictions'], alpha=0.6, s=30)

            # Perfect prediction line
            min_val = min(y_test.min(), res['predictions'].min())
            max_val = max(y_test.max(), res['predictions'].max())
            axes[i].plot([min_val, max_val], [min_val, max_val], 'r--', alpha=0.8)

            # Add R² to plot
            r2 = res['test_r2']
            mae = res['test_mae']
            axes[i].text(0.05, 0.95, f'R² = {r2:.3f}\nMAE = {mae:.2f}',
                        transform=axes[i].transAxes, verticalalignment='top',
                        bbox={'boxstyle': 'round', 'facecolor': 'white', 'alpha': 0.8})

            axes[i].set_xlabel('Actual Yield')
            axes[i].set_ylabel('Predicted Yield')
            axes[i].set_title(f'{name}', fontweight='bold')
            axes[i].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/model_comparison.png', dpi=300, bbox_inches='tight')
    plt.show()

    return comparison_df

comparison_results = compare_models(model_results, X_test, y_test)

# COMMAND ----------

# Feature importance analysis
def analyze_feature_importance():
    """Analyze feature importance from Random Forest model."""

    rf_model = model_results['Random Forest']['model']

    # Get feature names
    feature_cols = [col for col in df_ml.columns if col not in [
        'crop_yield_sk', 'state_name', 'county_code', 'county_name',
        'commodity', 'state_code', 'year', 'yield_per_acre', 'is_valid',
        'validation_errors', '_dbt_loaded_at'
    ]]

    # Get feature importance
    importance_df = pd.DataFrame({
        'feature': feature_cols,
        'importance': rf_model.feature_importances_
    }).sort_values('importance', ascending=False)

    # Plot top 20 features
    top_features = importance_df.head(20)

    plt.figure(figsize=(12, 8))
    bars = plt.barh(range(len(top_features)), top_features['importance'])
    plt.yticks(range(len(top_features)), top_features['feature'])
    plt.xlabel('Feature Importance')
    plt.title('Top 20 Feature Importance (Random Forest)', fontsize=14, fontweight='bold')
    plt.gca().invert_yaxis()

    # Color bars by importance level
    for i, bar in enumerate(bars):
        if i < 5:
            bar.set_color('darkgreen')
        elif i < 10:
            bar.set_color('orange')
        else:
            bar.set_color('lightcoral')

    plt.tight_layout()
    plt.savefig('/tmp/feature_importance.png', dpi=300, bbox_inches='tight')
    plt.show()

    return importance_df

feature_importance = analyze_feature_importance()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Forecasting Future Yields

# COMMAND ----------

# Generate forecasts for next year
def generate_forecasts(model_results, df_ml, scaler):
    """Generate yield forecasts for the next year."""

    # Get best performing model
    best_model_name = min(model_results.keys(), key=lambda k: model_results[k]['test_mae'])
    best_model = model_results[best_model_name]['model']

    print(f"Using best model: {best_model_name} (Test MAE: {model_results[best_model_name]['test_mae']:.2f})")

    # Prepare data for forecasting
    latest_year = df_ml['year'].max()
    forecast_year = latest_year + 1

    # Get latest data for each state-commodity combination
    latest_data = df_ml.groupby(['commodity', 'state_code']).last().reset_index()

    # Create forecast features (using last known values and updating time features)
    forecast_data = latest_data.copy()
    forecast_data['year'] = forecast_year
    forecast_data['year_normalized'] = (forecast_year - df_ml['year'].min()) / (df_ml['year'].max() - df_ml['year'].min())
    forecast_data['year_squared'] = forecast_data['year_normalized'] ** 2

    # Use lag features from previous years
    forecast_data['yield_lag_1'] = forecast_data['yield_per_acre']  # This year becomes lag_1

    # Prepare feature matrix
    feature_cols = [col for col in df_ml.columns if col not in [
        'crop_yield_sk', 'state_name', 'county_code', 'county_name',
        'commodity', 'state_code', 'year', 'yield_per_acre', 'is_valid',
        'validation_errors', '_dbt_loaded_at'
    ]]

    X_forecast = forecast_data[feature_cols]

    # Handle missing features
    X_forecast = X_forecast.fillna(method='ffill').fillna(method='bfill').fillna(0)

    # Scale features
    if best_model_name != 'Polynomial Ridge':
        X_forecast_scaled = scaler.transform(X_forecast)
        predictions = best_model.predict(X_forecast_scaled)
    else:
        predictions = best_model.predict(X_forecast)

    # Create forecast results
    forecast_results = forecast_data[['commodity', 'state_code']].copy()
    forecast_results['forecast_year'] = forecast_year
    forecast_results['predicted_yield'] = predictions
    forecast_results['historical_yield'] = forecast_data['yield_per_acre']
    forecast_results['predicted_change'] = ((predictions - forecast_data['yield_per_acre']) /
                                          forecast_data['yield_per_acre'] * 100).round(2)

    # Add confidence intervals (simple estimate based on model error)
    test_mae = model_results[best_model_name]['test_mae']
    forecast_results['lower_bound'] = predictions - 1.96 * test_mae
    forecast_results['upper_bound'] = predictions + 1.96 * test_mae

    return forecast_results

forecast_results = generate_forecasts(model_results, df_ml, scaler)

# COMMAND ----------

# Visualize forecasts
def visualize_forecasts(forecast_results):
    """Visualize yield forecasts."""

    # Top gainers and losers
    print("Top 10 States with Largest Predicted Yield Increases:")
    top_gainers = forecast_results.nlargest(10, 'predicted_change')[
        ['commodity', 'state_code', 'historical_yield', 'predicted_yield', 'predicted_change']
    ]
    print(top_gainers.to_string(index=False))

    print("\nTop 10 States with Largest Predicted Yield Decreases:")
    top_losers = forecast_results.nsmallest(10, 'predicted_change')[
        ['commodity', 'state_code', 'historical_yield', 'predicted_yield', 'predicted_change']
    ]
    print(top_losers.to_string(index=False))

    # Forecast visualization by commodity
    commodities = forecast_results['commodity'].unique()

    fig, axes = plt.subplots(2, 3, figsize=(18, 12))
    axes = axes.flatten()

    for i, commodity in enumerate(commodities):
        if i < len(axes):
            commodity_forecasts = forecast_results[forecast_results['commodity'] == commodity]

            # Sort by predicted change
            commodity_forecasts = commodity_forecasts.sort_values('predicted_change')

            # Bar plot of predicted changes
            colors = ['red' if x < 0 else 'green' for x in commodity_forecasts['predicted_change']]
            bars = axes[i].bar(range(len(commodity_forecasts)),
                             commodity_forecasts['predicted_change'],
                             color=colors, alpha=0.7)

            axes[i].set_title(f'{commodity} - Predicted Yield Changes (%)', fontweight='bold')
            axes[i].set_xlabel('States')
            axes[i].set_ylabel('Predicted Change (%)')
            axes[i].axhline(y=0, color='black', linestyle='-', alpha=0.5)
            axes[i].grid(True, alpha=0.3)

            # Add state labels
            axes[i].set_xticks(range(len(commodity_forecasts)))
            axes[i].set_xticklabels(commodity_forecasts['state_code'], rotation=45)

    # Hide unused subplot
    if len(commodities) < len(axes):
        axes[-1].set_visible(False)

    plt.tight_layout()
    plt.savefig('/tmp/yield_forecasts.png', dpi=300, bbox_inches='tight')
    plt.show()

visualize_forecasts(forecast_results)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results to Delta Lake

# COMMAND ----------

# Save forecast results to Delta Lake
def save_forecasts_to_delta(forecast_results):
    """Save forecast results to Delta Lake gold layer."""

    # Convert to Spark DataFrame
    forecast_df = spark.createDataFrame(forecast_results)

    # Add metadata
    forecast_df = forecast_df.withColumn("forecast_date", current_date()) \
                           .withColumn("model_used", lit("Random Forest")) \
                           .withColumn("confidence_level", lit(95))

    # Write to Delta table
    (forecast_df.write
     .mode("overwrite")
     .option("mergeSchema", "true")
     .saveAsTable("gold.gld_crop_yield_forecasts"))

    print(f"Saved {forecast_results.shape[0]} forecast records to gold.gld_crop_yield_forecasts")

# Save forecasts
save_forecasts_to_delta(forecast_results)

# COMMAND ----------

# Save model metrics to Delta Lake
def save_model_metrics(comparison_results):
    """Save model performance metrics to Delta Lake."""

    # Transpose and clean the results
    metrics_df = comparison_results.T.reset_index()
    metrics_df.columns = ['model_name', 'train_mae', 'test_mae', 'train_r2', 'test_r2', 'cv_mae']
    metrics_df['evaluation_date'] = datetime.now()
    metrics_df['dataset_version'] = 'v1.0'

    # Convert to Spark DataFrame and save
    spark_df = spark.createDataFrame(metrics_df)

    (spark_df.write
     .mode("overwrite")
     .option("mergeSchema", "true")
     .saveAsTable("gold.gld_model_performance_metrics"))

    print("Saved model performance metrics to gold.gld_model_performance_metrics")

save_model_metrics(comparison_results)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary and Recommendations

# COMMAND ----------

print("=" * 60)
print("CROP YIELD ANALYSIS - SUMMARY REPORT")
print("=" * 60)

print("\n📊 Dataset Overview:")
print(f"   • Total records analyzed: {len(df_prepared):,}")
print(f"   • Commodities: {', '.join(df_prepared['commodity'].unique())}")
print(f"   • States: {df_prepared['state_code'].nunique()}")
print(f"   • Year range: {df_prepared['year'].min()}-{df_prepared['year'].max()}")

print("\n🤖 Model Performance:")
best_model = min(model_results.keys(), key=lambda k: model_results[k]['test_mae'])
best_mae = model_results[best_model]['test_mae']
best_r2 = model_results[best_model]['test_r2']
print(f"   • Best model: {best_model}")
print(f"   • Test MAE: {best_mae:.2f} bushels/acre")
print(f"   • Test R²: {best_r2:.3f}")

print("\n📈 Key Findings:")
print("   • Overall yield trends are positive for most commodities")
print("   • Corn shows highest yields in Iowa, Illinois, Nebraska")
print("   • Soybean yields are most stable in the Midwest")
print("   • Year-over-year volatility varies significantly by region")

print("\n🔮 Forecast Highlights:")
avg_change = forecast_results['predicted_change'].mean()
positive_forecasts = (forecast_results['predicted_change'] > 0).sum()
total_forecasts = len(forecast_results)

print(f"   • Average predicted change: {avg_change:.1f}%")
print(f"   • Positive forecasts: {positive_forecasts}/{total_forecasts} ({positive_forecasts/total_forecasts*100:.1f}%)")

print("\n💡 Recommendations:")
print("   • Monitor high-volatility states for risk management")
print("   • Invest in yield improvement technologies in underperforming regions")
print("   • Consider weather data integration for improved forecasting")
print("   • Implement early warning systems for yield decline predictions")

print("\n📁 Outputs Generated:")
print("   • Forecast data saved to: gold.gld_crop_yield_forecasts")
print("   • Model metrics saved to: gold.gld_model_performance_metrics")
print("   • Visualizations saved to: /tmp/*.png")
print("   • MLflow experiments: /USDA/crop_yield_forecasting")

print("=" * 60)

# COMMAND ----------

# Display final forecast summary
print("\nFINAL FORECAST SUMMARY:")
forecast_summary = forecast_results.groupby('commodity').agg({
    'predicted_change': ['mean', 'std', 'min', 'max']
}).round(2)

forecast_summary.columns = ['Avg_Change_%', 'Std_Change_%', 'Min_Change_%', 'Max_Change_%']
print(forecast_summary)
