# Databricks notebook source
# MAGIC %md
# MAGIC # AutoML Weather Forecasting & Casino Demand Prediction
# MAGIC
# MAGIC **Notebook:** `03_ml_automl_weather_forecasting`
# MAGIC **Layer:** ML / Gold (Analytics)
# MAGIC **Source:** Gold NOAA weather observations + Gold slot performance
# MAGIC **Target:** MLflow registered models for weather & demand forecasting
# MAGIC
# MAGIC ## Overview
# MAGIC This notebook demonstrates Microsoft Fabric AutoML (GA) capabilities using FLAML
# MAGIC for two complementary forecasting tasks:
# MAGIC
# MAGIC 1. **NOAA Weather Forecasting** — predict temperature from historical observations
# MAGIC    with lag features, rolling averages, and seasonal decomposition.
# MAGIC 2. **Casino Slot Demand Prediction** — predict daily games played by joining
# MAGIC    weather data with slot performance, capturing weather-driven demand shifts.

# COMMAND ----------

# ---------------------------------------------------------------------------
# Fabric/local compatibility shim
# ---------------------------------------------------------------------------
import os

try:
    import notebookutils  # Fabric runtime
    def _get_arg(name, default=None):
        try:
            return notebookutils.notebook.getArgument(name, default)
        except Exception:
            return os.environ.get(name.upper(), default)
    def _notebook_exit(status: str) -> None:
        notebookutils.notebook.exit(status)
except ImportError:
    try:
        import mssparkutils  # legacy Synapse/Fabric runtime
        def _get_arg(name, default=None):
            try:
                return mssparkutils.notebook.getArgument(name, default)
            except Exception:
                return os.environ.get(name.upper(), default)
        def _notebook_exit(status: str) -> None:
            mssparkutils.notebook.exit(status)
    except ImportError:
        def _get_arg(name, default=None):
            return os.environ.get(name.upper(), default)
        def _notebook_exit(status: str) -> None:
            raise SystemExit(status)


# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from datetime import datetime, timedelta

import mlflow
import mlflow.sklearn
import numpy as np
import pandas as pd
from flaml import AutoML
from pyspark.sql.functions import (
    avg,
    col,
    count,
    current_timestamp,
    dayofmonth,
    dayofweek,
    lag,
    lit,
    max,
    min,
    month,
    round,
    sum,
    when,
)
from pyspark.sql.types import DoubleType
from pyspark.sql.window import Window
from sklearn.metrics import mean_absolute_error, mean_squared_error

# Parameters
batch_id = (
    _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))
)

EXPERIMENT_NAME = "/Shared/automl_weather_demand_forecast"
TARGET_COLUMN_WEATHER = "avg_temperature_f"
TARGET_COLUMN_DEMAND = "total_games_played"
TIME_COLUMN = "observation_date"
FORECAST_HORIZON = 7  # days

SOURCE_NOAA_WEATHER = "lh_gold.gold_noaa_weather_summary"
SOURCE_SLOT_PERFORMANCE = "lh_gold.gold_slot_performance"
TARGET_WEATHER_PREDICTIONS = "lh_gold.ml_weather_forecast_results"
TARGET_DEMAND_PREDICTIONS = "lh_gold.ml_demand_forecast_results"

mlflow.set_experiment(EXPERIMENT_NAME)
print(f"Batch: {batch_id} | Horizon: {FORECAST_HORIZON}d | Experiment: {EXPERIMENT_NAME}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Preparation — NOAA Weather
# MAGIC
# MAGIC Read gold-layer NOAA weather observations and engineer temporal features:
# MAGIC lag values, rolling averages, and seasonal components.

# COMMAND ----------

# Load NOAA weather data (synthetic fallback if table missing)
if not spark.catalog.tableExists(SOURCE_NOAA_WEATHER):
    print(f"{SOURCE_NOAA_WEATHER} not found — generating 2-year synthetic weather dataset")
    import random

    from pyspark.sql import Row
    random.seed(42)
    base = datetime(2024, 1, 1)
    rows = []
    for i in range(730):
        d = base + timedelta(days=i)
        temp = 65 + 25 * np.sin(2 * np.pi * (d.timetuple().tm_yday - 80) / 365)
        rows.append(Row(
            observation_date=d.date(), station_id="NOAA-LAS-001",
            avg_temperature_f=round(float(temp + random.gauss(0, 5)), 1),
            max_temperature_f=round(float(temp + random.uniform(5, 15)), 1),
            min_temperature_f=round(float(temp - random.uniform(5, 15)), 1),
            total_precipitation_in=round(max(0.0, random.gauss(0.05, 0.15)), 2),
            avg_wind_speed_mph=round(float(random.uniform(2, 25)), 1),
            avg_humidity_pct=round(float(random.uniform(15, 65)), 1),
        ))
    df_weather_raw = spark.createDataFrame(rows)
else:
    df_weather_raw = spark.table(SOURCE_NOAA_WEATHER)

print(f"NOAA weather records: {df_weather_raw.count():,}")

# Feature engineering: lags, rolling averages, seasonal decomposition
w_date = Window.orderBy("observation_date")
w_7d = Window.orderBy("observation_date").rowsBetween(-6, 0)
w_3d = Window.orderBy("observation_date").rowsBetween(-2, 0)

df_weather = df_weather_raw \
    .withColumn("temp_lag_1d", lag("avg_temperature_f", 1).over(w_date)) \
    .withColumn("temp_lag_7d", lag("avg_temperature_f", 7).over(w_date)) \
    .withColumn("precip_rolling_7d", avg("total_precipitation_in").over(w_7d)) \
    .withColumn("wind_rolling_3d", avg("avg_wind_speed_mph").over(w_3d)) \
    .withColumn("month", month("observation_date")) \
    .withColumn("day_of_week", dayofweek("observation_date")) \
    .withColumn("day_of_month", dayofmonth("observation_date")) \
    .withColumn("is_weekend", when(dayofweek("observation_date").isin(1, 7), 1).otherwise(0)) \
    .na.drop()

print(f"Weather features engineered: {df_weather.count():,} rows")
df_weather.select(
    "observation_date", "avg_temperature_f", "temp_lag_1d",
    "precip_rolling_7d", "month", "is_weekend"
).show(5, truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Preparation — Casino Demand
# MAGIC
# MAGIC Read gold slot performance, join with weather data by date, and create
# MAGIC demand-specific features: weather_impact_score, holiday_flag, event_flag.

# COMMAND ----------

if not spark.catalog.tableExists(SOURCE_SLOT_PERFORMANCE):
    print(f"{SOURCE_SLOT_PERFORMANCE} not found — generating synthetic demand data")
    import random

    from pyspark.sql import Row
    random.seed(99)
    base = datetime(2024, 1, 1)
    rows = []
    for i in range(730):
        d = base + timedelta(days=i)
        mult = 1.4 if d.weekday() >= 5 else 1.0
        games = int(12000 * mult * (1 + 0.15 * np.sin(2 * np.pi * (i - 60) / 365)) + random.gauss(0, 1500))
        rows.append(Row(
            business_date=d.date(), total_games=max(2000, games),
            total_coin_in=round(float(games * random.uniform(0.8, 1.2)), 2),
            total_coin_out=round(float(games * random.uniform(0.7, 1.0)), 2),
            machine_count=random.randint(180, 220),
        ))
    df_demand_raw = spark.createDataFrame(rows)
else:
    df_demand_raw = spark.table(SOURCE_SLOT_PERFORMANCE).groupBy("business_date").agg(
        sum("total_games").alias("total_games"), sum("coin_in").alias("total_coin_in"),
        sum("coin_out").alias("total_coin_out"), count("machine_id").alias("machine_count"),
    )

# Join weather + demand by date and add derived features
df_demand = df_demand_raw.alias("d").join(
    df_weather.alias("w"), col("d.business_date") == col("w.observation_date"), "inner"
).select(
    col("d.business_date").alias("observation_date"),
    col("d.total_games").alias("total_games_played"),
    col("d.total_coin_in"), col("d.total_coin_out"), col("d.machine_count"),
    col("w.avg_temperature_f"), col("w.total_precipitation_in"), col("w.avg_wind_speed_mph"),
    col("w.temp_lag_1d"), col("w.temp_lag_7d"), col("w.precip_rolling_7d"),
    col("w.wind_rolling_3d"), col("w.month"), col("w.day_of_week"), col("w.is_weekend"),
).withColumn("weather_impact_score",
    when(col("avg_temperature_f") > 110, lit(-0.3))
    .when(col("avg_temperature_f") < 32, lit(-0.2))
    .when(col("total_precipitation_in") > 0.5, lit(-0.15))
    .otherwise(lit(0.0))
).withColumn("holiday_flag",
    when(col("month").isin(12, 7, 11), lit(1)).otherwise(lit(0))
).withColumn("event_flag",
    when((col("is_weekend") == 1) & (col("month").isin(1, 3, 10, 11)), lit(1)).otherwise(lit(0))
).withColumn("historical_demand_avg",
    avg("total_games_played").over(Window.orderBy("observation_date").rowsBetween(-30, -1))
).na.drop()

print(f"Casino demand with weather features: {df_demand.count():,} rows")

# COMMAND ----------

# MAGIC %md
# MAGIC ## AutoML Experiment — Weather Forecasting
# MAGIC
# MAGIC FLAML AutoML for temperature forecasting: time_budget=300s, metric=RMSE,
# MAGIC estimator_list=[lgbm, xgboost, rf], log_training_metric=True.

# COMMAND ----------

weather_features = [
    "temp_lag_1d", "temp_lag_7d", "precip_rolling_7d", "wind_rolling_3d",
    "avg_wind_speed_mph", "avg_humidity_pct", "total_precipitation_in",
    "month", "day_of_week", "day_of_month", "is_weekend",
]

pdf_weather = df_weather.orderBy("observation_date") \
    .select(["observation_date", TARGET_COLUMN_WEATHER] + weather_features).toPandas()

split_idx = int(len(pdf_weather) * 0.8)
X_train_w, X_test_w = pdf_weather[weather_features].iloc[:split_idx], pdf_weather[weather_features].iloc[split_idx:]
y_train_w, y_test_w = pdf_weather[TARGET_COLUMN_WEATHER].iloc[:split_idx], pdf_weather[TARGET_COLUMN_WEATHER].iloc[split_idx:]
print(f"Weather — Train: {len(X_train_w):,}, Test: {len(X_test_w):,}")

with mlflow.start_run(run_name="automl_weather_forecast") as weather_run:
    mlflow.log_params({"task": "regression", "target": TARGET_COLUMN_WEATHER,
                       "forecast_horizon": FORECAST_HORIZON, "train_size": len(X_train_w)})

    automl_weather = AutoML()
    automl_weather.fit(
        X_train=X_train_w, y_train=y_train_w, task="regression",
        time_budget=300, metric="rmse",
        estimator_list=["lgbm", "xgboost", "rf"],
        log_training_metric=True, verbose=1, seed=42,
    )
    mlflow.log_param("best_estimator", automl_weather.best_estimator)
    mlflow.log_metric("best_train_rmse", automl_weather.best_loss)
    mlflow.sklearn.log_model(automl_weather.model, "weather_forecast_model")
    weather_run_id = weather_run.info.run_id

print(f"Weather AutoML — best: {automl_weather.best_estimator}")
trial_df = pd.DataFrame(automl_weather.results_).T.sort_values("val_loss").head(10)
display(trial_df[["learner", "val_loss", "train_loss"]].reset_index(drop=True))

# COMMAND ----------

# MAGIC %md
# MAGIC ## AutoML Experiment — Casino Demand Prediction
# MAGIC
# MAGIC Predict daily `total_games_played` using weather + temporal + event features.

# COMMAND ----------

demand_features = [
    "avg_temperature_f", "total_precipitation_in", "avg_wind_speed_mph",
    "temp_lag_1d", "temp_lag_7d", "precip_rolling_7d", "wind_rolling_3d",
    "month", "day_of_week", "is_weekend",
    "weather_impact_score", "holiday_flag", "event_flag",
    "historical_demand_avg", "machine_count",
]

pdf_demand = df_demand.orderBy("observation_date") \
    .select(["observation_date", TARGET_COLUMN_DEMAND] + demand_features).toPandas()

split_idx_d = int(len(pdf_demand) * 0.8)
X_train_d, X_test_d = pdf_demand[demand_features].iloc[:split_idx_d], pdf_demand[demand_features].iloc[split_idx_d:]
y_train_d, y_test_d = pdf_demand[TARGET_COLUMN_DEMAND].iloc[:split_idx_d], pdf_demand[TARGET_COLUMN_DEMAND].iloc[split_idx_d:]
print(f"Demand — Train: {len(X_train_d):,}, Test: {len(X_test_d):,}")

with mlflow.start_run(run_name="automl_demand_forecast") as demand_run:
    mlflow.log_params({"task": "regression", "target": TARGET_COLUMN_DEMAND,
                       "forecast_horizon": FORECAST_HORIZON, "train_size": len(X_train_d)})

    automl_demand = AutoML()
    automl_demand.fit(
        X_train=X_train_d, y_train=y_train_d, task="regression",
        time_budget=300, metric="rmse",
        estimator_list=["lgbm", "xgboost", "rf"],
        log_training_metric=True, verbose=1, seed=42,
    )
    mlflow.log_param("best_estimator", automl_demand.best_estimator)
    mlflow.log_metric("best_train_rmse", automl_demand.best_loss)
    mlflow.sklearn.log_model(automl_demand.model, "demand_forecast_model")
    demand_run_id = demand_run.info.run_id

print(f"Demand AutoML — best: {automl_demand.best_estimator}")
trial_df_d = pd.DataFrame(automl_demand.results_).T.sort_values("val_loss").head(10)
display(trial_df_d[["learner", "val_loss", "train_loss"]].reset_index(drop=True))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Model Evaluation
# MAGIC
# MAGIC RMSE, MAE, MAPE for both models. Feature importance charts.
# MAGIC Cross-validation results. Compare best models.

# COMMAND ----------

def evaluate_model(model, X_test, y_test, model_name):
    """Evaluate regression model — returns metrics dict and predictions."""
    y_pred = model.predict(X_test)
    rmse = float(np.sqrt(mean_squared_error(y_test, y_pred)))
    mae = float(mean_absolute_error(y_test, y_pred))
    mask = y_test != 0
    mape = float(np.mean(np.abs((y_test[mask] - y_pred[mask]) / y_test[mask])) * 100) if mask.sum() > 0 else float("nan")
    print(f"\n  {model_name}:  RMSE={rmse:.4f}  MAE={mae:.4f}  MAPE={mape:.2f}%")
    return {"rmse": rmse, "mae": mae, "mape_pct": mape}, y_pred

print("=" * 60)
print("  Test Set Evaluation")
print("=" * 60)
weather_metrics, weather_preds = evaluate_model(automl_weather.model, X_test_w, y_test_w, "Weather Forecast")
demand_metrics, demand_preds = evaluate_model(automl_demand.model, X_test_d, y_test_d, "Casino Demand")

# Feature importance
for name, model, feats in [("Weather", automl_weather, weather_features),
                           ("Demand", automl_demand, demand_features)]:
    if hasattr(model.model, "feature_importances_"):
        print(f"\n  Feature Importance — {name} Model")
        imp = pd.DataFrame({"feature": feats, "importance": model.model.feature_importances_})
        display(imp.sort_values("importance", ascending=False))

# Model comparison table
comparison = pd.DataFrame({
    "Model": ["Weather Forecast", "Casino Demand"],
    "Best Estimator": [automl_weather.best_estimator, automl_demand.best_estimator],
    "RMSE": [weather_metrics["rmse"], demand_metrics["rmse"]],
    "MAE": [weather_metrics["mae"], demand_metrics["mae"]],
    "MAPE (%)": [weather_metrics["mape_pct"], demand_metrics["mape_pct"]],
})
print("\n  Model Comparison:")
display(comparison)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Model Registration & Deployment
# MAGIC
# MAGIC Register best models to MLflow Model Registry as Fabric ML Model items.
# MAGIC Save prediction results to Gold layer with `_batch_id` and `_gold_timestamp`.

# COMMAND ----------

# Register weather model
weather_model_name = "automl_weather_forecast"
with mlflow.start_run(run_id=weather_run_id):
    for k, v in weather_metrics.items():
        mlflow.log_metric(f"test_{k}", v)
weather_mv = mlflow.register_model(f"runs:/{weather_run_id}/weather_forecast_model", weather_model_name)

# Register demand model
demand_model_name = "automl_demand_forecast"
with mlflow.start_run(run_id=demand_run_id):
    for k, v in demand_metrics.items():
        mlflow.log_metric(f"test_{k}", v)
demand_mv = mlflow.register_model(f"runs:/{demand_run_id}/demand_forecast_model", demand_model_name)

print(f"Registered: {weather_model_name} v{weather_mv.version}, {demand_model_name} v{demand_mv.version}")

# Save weather predictions to Gold
pdf_weather_results = pdf_weather.iloc[split_idx:].copy()
pdf_weather_results["predicted_temperature_f"] = weather_preds
spark.createDataFrame(pdf_weather_results) \
    .withColumn("_batch_id", lit(batch_id)) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .write.format("delta").mode("overwrite").option("overwriteSchema", "true") \
    .saveAsTable(TARGET_WEATHER_PREDICTIONS)

# Save demand predictions to Gold
pdf_demand_results = pdf_demand.iloc[split_idx_d:].copy()
pdf_demand_results["predicted_games_played"] = demand_preds
spark.createDataFrame(pdf_demand_results) \
    .withColumn("_batch_id", lit(batch_id)) \
    .withColumn("_gold_timestamp", current_timestamp()) \
    .write.format("delta").mode("overwrite").option("overwriteSchema", "true") \
    .saveAsTable(TARGET_DEMAND_PREDICTIONS)

# Final summary
print("\n" + "=" * 70)
print("  AUTOML WEATHER & DEMAND FORECASTING — SUMMARY")
print("=" * 70)
print(f"  Weather Model:   {weather_model_name} v{weather_mv.version}  ({automl_weather.best_estimator})")
print(f"    RMSE={weather_metrics['rmse']:.4f}  MAE={weather_metrics['mae']:.4f}  MAPE={weather_metrics['mape_pct']:.2f}%")
print(f"  Demand Model:    {demand_model_name} v{demand_mv.version}  ({automl_demand.best_estimator})")
print(f"    RMSE={demand_metrics['rmse']:.4f}  MAE={demand_metrics['mae']:.4f}  MAPE={demand_metrics['mape_pct']:.2f}%")
print(f"  Predictions:     {TARGET_WEATHER_PREDICTIONS}, {TARGET_DEMAND_PREDICTIONS}")
print(f"  Batch ID:        {batch_id}")
print("=" * 70)
print("\nFabric ML Model endpoint creation:")
print("  1. Navigate to ML Model item in your workspace")
print("  2. Select the registered model version")
print("  3. Click 'Create endpoint' -> configure scaling (min 1, max 4)")
print("  4. Use REST endpoint for inference from Power BI or apps")
print("  5. Monitor drift via Fabric Model Monitoring (preview)")
print("=" * 70)
