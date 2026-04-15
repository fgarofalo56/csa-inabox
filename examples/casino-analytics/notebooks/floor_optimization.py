# Databricks notebook source
# MAGIC %md
# MAGIC # Casino Floor Optimization
# MAGIC
# MAGIC ML-driven floor optimization and slot performance analytics:
# MAGIC - Machine performance ranking (RTP, occupancy, revenue)
# MAGIC - Floor zone revenue density analysis
# MAGIC - Denomination mix optimization
# MAGIC - Jackpot and bonus frequency analysis
# MAGIC - Predictive maintenance indicators
# MAGIC
# MAGIC **All data is ENTIRELY SYNTHETIC.**

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

from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.preprocessing import StandardScaler, LabelEncoder

from pyspark.sql import SparkSession
from pyspark.sql.functions import *
import mlflow
import mlflow.sklearn

plt.style.use('seaborn-v0_8')
mlflow.set_experiment("/Casino/floor_optimization")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading

# COMMAND ----------

def load_floor_data():
    """Load slot events and sessions."""
    slots = spark.table("silver.slv_slot_events").toPandas()
    sessions = spark.table("silver.slv_player_sessions").toPandas()
    slots['event_timestamp'] = pd.to_datetime(slots['event_timestamp'])
    sessions['session_date'] = pd.to_datetime(sessions['session_date'])
    print(f"Slot events: {len(slots):,}")
    print(f"Sessions: {len(sessions):,}")
    return slots, sessions

df_slots, df_sessions = load_floor_data()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Machine Performance Analysis

# COMMAND ----------

def analyze_machine_performance(slots):
    """Rank machines by key performance metrics."""
    spins = slots[slots['event_type'] == 'SPIN'].copy()

    machine_perf = spins.groupby('machine_id').agg(
        total_spins=('event_id', 'count'),
        total_wagered=('credits_wagered', 'sum'),
        total_won=('credits_won', 'sum'),
        avg_denomination=('denomination', 'mean'),
        floor_zone=('floor_zone', lambda x: x.mode().iloc[0] if len(x.mode()) > 0 else 'UNKNOWN'),
        jackpot_count=('credits_won', lambda x: (x > 1000).sum()),
        error_events=('event_type', lambda x: 0)  # placeholder
    ).reset_index()

    machine_perf['actual_rtp'] = (machine_perf['total_won'] / machine_perf['total_wagered'].clip(lower=1) * 100).round(2)
    machine_perf['revenue'] = machine_perf['total_wagered'] - machine_perf['total_won']

    # Also count errors
    errors = slots[slots['event_type'] == 'ERROR'].groupby('machine_id').size().reset_index(name='error_events')
    machine_perf = machine_perf.drop(columns=['error_events']).merge(errors, on='machine_id', how='left').fillna(0)

    fig, axes = plt.subplots(2, 2, figsize=(18, 12))

    # RTP distribution
    axes[0, 0].hist(machine_perf['actual_rtp'], bins=30, edgecolor='black', alpha=0.7, color='steelblue')
    axes[0, 0].axvline(x=machine_perf['actual_rtp'].median(), color='red', linestyle='--',
                       label=f"Median: {machine_perf['actual_rtp'].median():.1f}%")
    axes[0, 0].set_title('Machine RTP Distribution', fontweight='bold')
    axes[0, 0].set_xlabel('Actual RTP (%)')
    axes[0, 0].set_ylabel('Count')
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)

    # Revenue by floor zone
    zone_rev = machine_perf.groupby('floor_zone')['revenue'].sum().sort_values()
    zone_rev.plot(kind='barh', ax=axes[0, 1], color=sns.color_palette('viridis', len(zone_rev)))
    axes[0, 1].set_title('Revenue by Floor Zone', fontweight='bold')
    axes[0, 1].set_xlabel('Net Revenue (credits)')
    axes[0, 1].grid(True, alpha=0.3)

    # Top 15 machines by revenue
    top_machines = machine_perf.nlargest(15, 'revenue')
    axes[1, 0].barh(top_machines['machine_id'], top_machines['revenue'], color='green', alpha=0.7)
    axes[1, 0].set_title('Top 15 Machines by Revenue', fontweight='bold')
    axes[1, 0].set_xlabel('Net Revenue')
    axes[1, 0].grid(True, alpha=0.3)

    # Denomination mix
    denom_rev = machine_perf.groupby('avg_denomination')['revenue'].sum().sort_index()
    axes[1, 1].bar([f"${d:.2f}" for d in denom_rev.index], denom_rev.values,
                  color=sns.color_palette('coolwarm', len(denom_rev)))
    axes[1, 1].set_title('Revenue by Denomination', fontweight='bold')
    axes[1, 1].set_ylabel('Net Revenue')
    axes[1, 1].tick_params(axis='x', rotation=45)
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/machine_performance.png', dpi=300, bbox_inches='tight')
    plt.show()

    return machine_perf

machine_perf = analyze_machine_performance(df_slots)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Floor Zone Revenue Density

# COMMAND ----------

def analyze_zone_density(sessions):
    """Analyze revenue density by floor zone."""
    zone_metrics = sessions.groupby('floor_zone').agg(
        total_coin_in=('coin_in', 'sum'),
        total_theo_win=('theoretical_win', 'sum'),
        total_actual_win=('actual_win', 'sum'),
        session_count=('session_id', 'count'),
        unique_players=('player_id', 'nunique'),
        avg_duration=('duration_minutes', 'mean'),
        machine_count=('machine_id', 'nunique')
    ).reset_index()

    zone_metrics['revenue_per_machine'] = (zone_metrics['total_theo_win'] / zone_metrics['machine_count'].clip(lower=1)).round(2)
    zone_metrics['players_per_machine'] = (zone_metrics['unique_players'] / zone_metrics['machine_count'].clip(lower=1)).round(2)

    fig, axes = plt.subplots(1, 2, figsize=(16, 6))

    zone_metrics_sorted = zone_metrics.sort_values('revenue_per_machine', ascending=True)
    axes[0].barh(zone_metrics_sorted['floor_zone'], zone_metrics_sorted['revenue_per_machine'], color='teal')
    axes[0].set_title('Revenue per Machine by Zone', fontweight='bold')
    axes[0].set_xlabel('Theoretical Win / Machine ($)')
    axes[0].grid(True, alpha=0.3)

    axes[1].scatter(zone_metrics['machine_count'], zone_metrics['total_theo_win'],
                   s=zone_metrics['unique_players'] * 2, alpha=0.7, c='steelblue')
    for _, row in zone_metrics.iterrows():
        axes[1].annotate(row['floor_zone'], (row['machine_count'], row['total_theo_win']), fontsize=8)
    axes[1].set_title('Zone Efficiency (size = unique players)', fontweight='bold')
    axes[1].set_xlabel('Machine Count')
    axes[1].set_ylabel('Total Theoretical Win ($)')
    axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/zone_density.png', dpi=300, bbox_inches='tight')
    plt.show()

    return zone_metrics

zone_metrics = analyze_zone_density(df_sessions)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Revenue Prediction Model

# COMMAND ----------

def predict_machine_revenue(machine_perf):
    """Predict machine revenue for optimization."""
    le_zone = LabelEncoder()
    machine_perf['zone_encoded'] = le_zone.fit_transform(machine_perf['floor_zone'])

    features = ['total_spins', 'total_wagered', 'avg_denomination', 'zone_encoded', 'jackpot_count']
    X = machine_perf[features].fillna(0)
    y = machine_perf['revenue']

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train)
    X_test_s = scaler.transform(X_test)

    model = GradientBoostingRegressor(n_estimators=100, max_depth=4, random_state=42)

    with mlflow.start_run(run_name="floor_revenue_prediction"):
        model.fit(X_train_s, y_train)
        y_pred = model.predict(X_test_s)

        mae = mean_absolute_error(y_test, y_pred)
        r2 = r2_score(y_test, y_pred)

        mlflow.log_metric("mae", mae)
        mlflow.log_metric("r2", r2)
        mlflow.sklearn.log_model(model, "floor_revenue_model")

        print(f"Revenue Prediction: MAE={mae:.2f}, R2={r2:.4f}")

    fig, ax = plt.subplots(figsize=(8, 6))
    ax.scatter(y_test, y_pred, alpha=0.6)
    ax.plot([y_test.min(), y_test.max()], [y_test.min(), y_test.max()], 'r--')
    ax.set_title(f'Revenue Prediction (R2={r2:.3f})', fontweight='bold')
    ax.set_xlabel('Actual Revenue')
    ax.set_ylabel('Predicted Revenue')
    ax.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.savefig('/tmp/revenue_prediction.png', dpi=300, bbox_inches='tight')
    plt.show()

    return model, r2

rev_model, rev_r2 = predict_machine_revenue(machine_perf)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results

# COMMAND ----------

machine_spark = spark.createDataFrame(machine_perf[[
    'machine_id', 'total_spins', 'total_wagered', 'total_won', 'actual_rtp',
    'revenue', 'floor_zone', 'avg_denomination', 'jackpot_count', 'error_events'
]])
machine_spark = machine_spark.withColumn("analysis_date", current_date())

(machine_spark.write
 .mode("overwrite")
 .option("mergeSchema", "true")
 .saveAsTable("gold.gld_machine_performance"))

zone_spark = spark.createDataFrame(zone_metrics)
zone_spark = zone_spark.withColumn("analysis_date", current_date())

(zone_spark.write
 .mode("overwrite")
 .option("mergeSchema", "true")
 .saveAsTable("gold.gld_zone_revenue_density"))

print("Saved to gold.gld_machine_performance and gold.gld_zone_revenue_density")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print("=" * 65)
print("FLOOR OPTIMIZATION - SUMMARY")
print("=" * 65)
print(f"\nMachines analyzed: {len(machine_perf):,}")
print(f"Floor zones: {machine_perf['floor_zone'].nunique()}")
print(f"Revenue prediction R2: {rev_r2:.4f}")
print(f"\nOutputs:")
print(f"  gold.gld_machine_performance")
print(f"  gold.gld_zone_revenue_density")
print(f"  MLflow: /Casino/floor_optimization")
print("=" * 65)
