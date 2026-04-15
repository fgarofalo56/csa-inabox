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

import warnings

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns

warnings.filterwarnings('ignore')

import mlflow
import mlflow.sklearn
from pyspark.sql.functions import *
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder, StandardScaler

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
print("FLOOR OPTIMIZATION - INITIAL RESULTS")
print("=" * 65)
print(f"\nMachines analyzed: {len(machine_perf):,}")
print(f"Floor zones: {machine_perf['floor_zone'].nunique()}")
print(f"Revenue prediction R2: {rev_r2:.4f}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Slot Machine Clustering Analysis

# COMMAND ----------

from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score


def cluster_slot_machines(machine_perf):
    """Cluster slot machines by performance characteristics to identify optimization groups."""
    cluster_features = ['total_spins', 'actual_rtp', 'revenue', 'avg_denomination',
                        'jackpot_count', 'error_events']
    X_cluster = machine_perf[cluster_features].fillna(0)

    scaler_c = StandardScaler()
    X_scaled = scaler_c.fit_transform(X_cluster)

    # Determine optimal k using silhouette scores
    sil_scores = []
    k_range = range(2, 9)
    for k in k_range:
        km = KMeans(n_clusters=k, random_state=42, n_init=10)
        labels = km.fit_predict(X_scaled)
        sil_scores.append(silhouette_score(X_scaled, labels))

    optimal_k = list(k_range)[np.argmax(sil_scores)]
    print(f"Optimal clusters (silhouette): k={optimal_k}")

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Silhouette score by k
    axes[0, 0].plot(list(k_range), sil_scores, 'bo-', linewidth=2)
    axes[0, 0].axvline(x=optimal_k, color='red', linestyle='--', label=f'Optimal k={optimal_k}')
    axes[0, 0].set_title('Silhouette Score by Cluster Count', fontweight='bold')
    axes[0, 0].set_xlabel('Number of Clusters')
    axes[0, 0].set_ylabel('Silhouette Score')
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)

    # Fit optimal model
    km_final = KMeans(n_clusters=optimal_k, random_state=42, n_init=10)
    machine_perf['cluster'] = km_final.fit_predict(X_scaled)

    # Cluster scatter: RTP vs Revenue
    for c in range(optimal_k):
        mask = machine_perf['cluster'] == c
        axes[0, 1].scatter(machine_perf.loc[mask, 'actual_rtp'],
                          machine_perf.loc[mask, 'revenue'],
                          label=f'Cluster {c}', alpha=0.6, s=40)
    axes[0, 1].set_title('Machine Clusters: RTP vs Revenue', fontweight='bold')
    axes[0, 1].set_xlabel('Actual RTP (%)')
    axes[0, 1].set_ylabel('Net Revenue (credits)')
    axes[0, 1].legend()
    axes[0, 1].grid(True, alpha=0.3)

    # Cluster profiles - box plots
    cluster_summary = machine_perf.groupby('cluster').agg(
        n_machines=('machine_id', 'count'),
        avg_rtp=('actual_rtp', 'mean'),
        avg_revenue=('revenue', 'mean'),
        avg_spins=('total_spins', 'mean'),
        avg_denomination=('avg_denomination', 'mean'),
        total_revenue=('revenue', 'sum')
    ).round(2)

    cluster_summary['total_revenue'].plot(kind='bar', ax=axes[1, 0],
        color=sns.color_palette('Set2', optimal_k))
    axes[1, 0].set_title('Total Revenue by Cluster', fontweight='bold')
    axes[1, 0].set_ylabel('Total Revenue (credits)')
    axes[1, 0].set_xlabel('Cluster')
    axes[1, 0].grid(True, alpha=0.3)

    # Cluster heatmap of centroids
    centroid_df = pd.DataFrame(km_final.cluster_centers_, columns=cluster_features)
    sns.heatmap(centroid_df.T, annot=True, fmt='.2f', cmap='RdYlGn',
                ax=axes[1, 1], cbar_kws={'label': 'Standardized Value'})
    axes[1, 1].set_title('Cluster Centroids (Standardized)', fontweight='bold')
    axes[1, 1].set_xlabel('Cluster')

    plt.tight_layout()
    plt.savefig('/tmp/slot_clustering.png', dpi=300, bbox_inches='tight')
    plt.show()

    print("\nCluster Summary:")
    print(cluster_summary.to_string())
    return machine_perf, cluster_summary

machine_perf, cluster_summary = cluster_slot_machines(machine_perf)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Revenue Heatmaps by Floor Section and Time

# COMMAND ----------

def revenue_heatmaps(sessions, slots):
    """Generate revenue heatmaps by floor zone and time dimensions."""
    sessions_copy = sessions.copy()
    sessions_copy['hour'] = pd.to_datetime(sessions_copy['session_date']).dt.hour
    sessions_copy['day_of_week'] = pd.to_datetime(sessions_copy['session_date']).dt.dayofweek
    sessions_copy['day_name'] = pd.to_datetime(sessions_copy['session_date']).dt.day_name()

    fig, axes = plt.subplots(2, 2, figsize=(20, 14))

    # Heatmap: Floor Zone x Day of Week
    zone_dow = sessions_copy.groupby(['floor_zone', 'day_of_week'])['theoretical_win'].sum().unstack(fill_value=0)
    day_labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    zone_dow.columns = [day_labels[i] if i < len(day_labels) else str(i) for i in zone_dow.columns]
    sns.heatmap(zone_dow, annot=True, fmt='.0f', cmap='YlOrRd', ax=axes[0, 0],
                cbar_kws={'label': 'Theoretical Win ($)'})
    axes[0, 0].set_title('Revenue Heatmap: Zone x Day of Week', fontweight='bold')
    axes[0, 0].set_ylabel('Floor Zone')

    # Heatmap: Floor Zone x Game Type
    zone_game = sessions_copy.groupby(['floor_zone', 'game_type'])['coin_in'].sum().unstack(fill_value=0)
    sns.heatmap(zone_game, annot=True, fmt='.0f', cmap='Blues', ax=axes[0, 1],
                cbar_kws={'label': 'Coin-In ($)'})
    axes[0, 1].set_title('Coin-In Heatmap: Zone x Game Type', fontweight='bold')
    axes[0, 1].set_ylabel('Floor Zone')

    # Average session duration by zone and day
    zone_dur = sessions_copy.groupby(['floor_zone', 'day_of_week'])['duration_minutes'].mean().unstack(fill_value=0)
    zone_dur.columns = [day_labels[i] if i < len(day_labels) else str(i) for i in zone_dur.columns]
    sns.heatmap(zone_dur, annot=True, fmt='.0f', cmap='Greens', ax=axes[1, 0],
                cbar_kws={'label': 'Avg Duration (min)'})
    axes[1, 0].set_title('Avg Session Duration: Zone x Day', fontweight='bold')
    axes[1, 0].set_ylabel('Floor Zone')

    # Occupancy rate proxy: session count by zone and day
    zone_occ = sessions_copy.groupby(['floor_zone', 'day_of_week'])['session_id'].count().unstack(fill_value=0)
    zone_occ.columns = [day_labels[i] if i < len(day_labels) else str(i) for i in zone_occ.columns]
    sns.heatmap(zone_occ, annot=True, fmt='.0f', cmap='Purples', ax=axes[1, 1],
                cbar_kws={'label': 'Session Count'})
    axes[1, 1].set_title('Session Volume: Zone x Day', fontweight='bold')
    axes[1, 1].set_ylabel('Floor Zone')

    plt.tight_layout()
    plt.savefig('/tmp/revenue_heatmaps.png', dpi=300, bbox_inches='tight')
    plt.show()

    # Revenue concentration analysis
    zone_total = sessions_copy.groupby('floor_zone')['theoretical_win'].sum().sort_values(ascending=False)
    zone_pct = (zone_total / zone_total.sum() * 100).cumsum()

    fig2, ax2 = plt.subplots(figsize=(12, 6))
    ax2.bar(range(len(zone_total)), zone_total.values, alpha=0.7, color='steelblue', label='Revenue')
    ax2_twin = ax2.twinx()
    ax2_twin.plot(range(len(zone_total)), zone_pct.values, 'ro-', label='Cumulative %')
    ax2_twin.axhline(y=80, color='red', linestyle='--', alpha=0.5, label='80% threshold')
    ax2.set_xticks(range(len(zone_total)))
    ax2.set_xticklabels(zone_total.index, rotation=45, ha='right')
    ax2.set_title('Revenue Pareto Analysis by Floor Zone', fontweight='bold')
    ax2.set_ylabel('Theoretical Win ($)')
    ax2_twin.set_ylabel('Cumulative %')
    ax2.legend(loc='upper left')
    ax2_twin.legend(loc='center right')
    ax2.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/revenue_pareto.png', dpi=300, bbox_inches='tight')
    plt.show()

revenue_heatmaps(df_sessions, df_slots)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Peak Hour Analysis and Traffic Patterns

# COMMAND ----------

def analyze_peak_hours(sessions, slots):
    """Identify peak traffic hours and revenue concentration patterns."""
    sessions_copy = sessions.copy()
    sessions_copy['session_date'] = pd.to_datetime(sessions_copy['session_date'])
    sessions_copy['hour'] = sessions_copy['session_date'].dt.hour
    sessions_copy['is_weekend'] = sessions_copy['session_date'].dt.dayofweek >= 5

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Hourly session distribution: weekday vs weekend
    for label, mask in [('Weekday', ~sessions_copy['is_weekend']), ('Weekend', sessions_copy['is_weekend'])]:
        hourly = sessions_copy[mask].groupby('hour')['session_id'].count()
        axes[0, 0].plot(hourly.index, hourly.values, marker='o', label=label, linewidth=2)
    axes[0, 0].set_title('Hourly Session Volume: Weekday vs Weekend', fontweight='bold')
    axes[0, 0].set_xlabel('Hour of Day')
    axes[0, 0].set_ylabel('Session Count')
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)
    axes[0, 0].set_xticks(range(24))

    # Revenue by hour
    hourly_rev = sessions_copy.groupby('hour')['theoretical_win'].sum()
    colors_h = ['darkred' if v > hourly_rev.quantile(0.75) else 'steelblue' for v in hourly_rev.values]
    axes[0, 1].bar(hourly_rev.index, hourly_rev.values, color=colors_h)
    axes[0, 1].set_title('Total Revenue by Hour (red = peak)', fontweight='bold')
    axes[0, 1].set_xlabel('Hour of Day')
    axes[0, 1].set_ylabel('Theoretical Win ($)')
    axes[0, 1].grid(True, alpha=0.3)
    axes[0, 1].set_xticks(range(24))

    # Average coin-in per session by hour and zone
    hourly_zone = sessions_copy.groupby(['hour', 'floor_zone'])['coin_in'].mean().unstack(fill_value=0)
    hourly_zone.plot(ax=axes[1, 0], linewidth=1.5)
    axes[1, 0].set_title('Avg Coin-In per Session by Hour and Zone', fontweight='bold')
    axes[1, 0].set_xlabel('Hour of Day')
    axes[1, 0].set_ylabel('Avg Coin-In ($)')
    axes[1, 0].legend(fontsize=7, bbox_to_anchor=(1.05, 1))
    axes[1, 0].grid(True, alpha=0.3)

    # Peak hour identification per zone
    peak_hours = sessions_copy.groupby(['floor_zone', 'hour'])['theoretical_win'].sum().reset_index()
    peak_by_zone = peak_hours.loc[peak_hours.groupby('floor_zone')['theoretical_win'].idxmax()]
    axes[1, 1].barh(peak_by_zone['floor_zone'], peak_by_zone['hour'], color='teal')
    axes[1, 1].set_title('Peak Revenue Hour by Floor Zone', fontweight='bold')
    axes[1, 1].set_xlabel('Hour of Day')
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/peak_hour_analysis.png', dpi=300, bbox_inches='tight')
    plt.show()

    # Weekly trend decomposition
    sessions_copy['week'] = sessions_copy['session_date'].dt.isocalendar().week.astype(int)
    weekly = sessions_copy.groupby('week').agg(
        total_coin_in=('coin_in', 'sum'),
        total_theo_win=('theoretical_win', 'sum'),
        n_sessions=('session_id', 'count'),
        unique_players=('player_id', 'nunique')
    ).reset_index()

    fig2, axes2 = plt.subplots(1, 2, figsize=(16, 6))
    axes2[0].plot(weekly['week'], weekly['total_theo_win'], 'b-o', linewidth=1.5)
    axes2[0].fill_between(weekly['week'], weekly['total_theo_win'], alpha=0.2)
    axes2[0].set_title('Weekly Theoretical Win Trend', fontweight='bold')
    axes2[0].set_xlabel('Week Number')
    axes2[0].set_ylabel('Theoretical Win ($)')
    axes2[0].grid(True, alpha=0.3)

    axes2[1].scatter(weekly['unique_players'], weekly['total_coin_in'],
                    s=weekly['n_sessions'] / 10, alpha=0.6, c='teal')
    axes2[1].set_title('Unique Players vs Coin-In (size = sessions)', fontweight='bold')
    axes2[1].set_xlabel('Unique Players')
    axes2[1].set_ylabel('Total Coin-In ($)')
    axes2[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/weekly_trends.png', dpi=300, bbox_inches='tight')
    plt.show()

    return weekly

weekly_trends = analyze_peak_hours(df_sessions, df_slots)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Staffing Optimization Model

# COMMAND ----------

from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import cross_val_score


def build_staffing_model(sessions):
    """Build a model to predict staffing needs based on expected traffic."""
    sessions_copy = sessions.copy()
    sessions_copy['session_date'] = pd.to_datetime(sessions_copy['session_date'])
    sessions_copy['hour'] = sessions_copy['session_date'].dt.hour
    sessions_copy['day_of_week'] = sessions_copy['session_date'].dt.dayofweek
    sessions_copy['is_weekend'] = (sessions_copy['day_of_week'] >= 5).astype(int)
    sessions_copy['month'] = sessions_copy['session_date'].dt.month
    sessions_copy['week'] = sessions_copy['session_date'].dt.isocalendar().week.astype(int)

    # Aggregate to hourly slot-level demand per zone
    hourly_demand = sessions_copy.groupby(
        ['floor_zone', 'session_date', 'day_of_week', 'is_weekend', 'month']
    ).agg(
        active_sessions=('session_id', 'count'),
        unique_players=('player_id', 'nunique'),
        total_coin_in=('coin_in', 'sum'),
        avg_duration=('duration_minutes', 'mean')
    ).reset_index()

    le_zone_staff = LabelEncoder()
    hourly_demand['zone_encoded'] = le_zone_staff.fit_transform(hourly_demand['floor_zone'])
    hourly_demand['month_sin'] = np.sin(2 * np.pi * hourly_demand['month'] / 12)
    hourly_demand['month_cos'] = np.cos(2 * np.pi * hourly_demand['month'] / 12)
    hourly_demand['dow_sin'] = np.sin(2 * np.pi * hourly_demand['day_of_week'] / 7)
    hourly_demand['dow_cos'] = np.cos(2 * np.pi * hourly_demand['day_of_week'] / 7)

    features = ['zone_encoded', 'day_of_week', 'is_weekend', 'month',
                'month_sin', 'month_cos', 'dow_sin', 'dow_cos']
    X_staff = hourly_demand[features]
    y_staff = hourly_demand['active_sessions']

    X_train_s, X_test_s, y_train_s, y_test_s = train_test_split(X_staff, y_staff,
                                                                   test_size=0.2, random_state=42)

    scaler_staff = StandardScaler()
    X_train_sc = scaler_staff.fit_transform(X_train_s)
    X_test_sc = scaler_staff.transform(X_test_s)

    # Random Forest for staffing prediction
    rf_staff = RandomForestRegressor(n_estimators=150, max_depth=8, random_state=42)

    with mlflow.start_run(run_name="staffing_optimization"):
        rf_staff.fit(X_train_sc, y_train_s)
        y_pred_staff = rf_staff.predict(X_test_sc)

        staff_mae = mean_absolute_error(y_test_s, y_pred_staff)
        staff_r2 = r2_score(y_test_s, y_pred_staff)

        # Cross-validation
        cv_scores = cross_val_score(rf_staff, X_train_sc, y_train_s, cv=5,
                                    scoring='neg_mean_absolute_error')

        mlflow.log_metric("mae", staff_mae)
        mlflow.log_metric("r2", staff_r2)
        mlflow.log_metric("cv_mae_mean", -cv_scores.mean())
        mlflow.sklearn.log_model(rf_staff, "staffing_model")

        print(f"Staffing Model - MAE: {staff_mae:.2f}, R2: {staff_r2:.4f}")
        print(f"Cross-validation MAE: {-cv_scores.mean():.2f} (±{cv_scores.std():.2f})")

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Actual vs predicted
    axes[0, 0].scatter(y_test_s, y_pred_staff, alpha=0.5, s=30)
    axes[0, 0].plot([y_test_s.min(), y_test_s.max()],
                   [y_test_s.min(), y_test_s.max()], 'r--')
    axes[0, 0].set_title(f'Staffing Demand Prediction (R2={staff_r2:.3f})', fontweight='bold')
    axes[0, 0].set_xlabel('Actual Sessions')
    axes[0, 0].set_ylabel('Predicted Sessions')
    axes[0, 0].grid(True, alpha=0.3)

    # Feature importance
    feat_imp = pd.DataFrame({
        'feature': features,
        'importance': rf_staff.feature_importances_
    }).sort_values('importance', ascending=True)
    axes[0, 1].barh(feat_imp['feature'], feat_imp['importance'], color='teal')
    axes[0, 1].set_title('Feature Importance (Staffing Model)', fontweight='bold')
    axes[0, 1].set_xlabel('Importance')
    axes[0, 1].grid(True, alpha=0.3)

    # Residual distribution
    residuals = y_test_s.values - y_pred_staff
    axes[1, 0].hist(residuals, bins=30, edgecolor='black', alpha=0.7, color='coral')
    axes[1, 0].axvline(x=0, color='red', linestyle='--')
    axes[1, 0].set_title('Residual Distribution', fontweight='bold')
    axes[1, 0].set_xlabel('Residual (Actual - Predicted)')
    axes[1, 0].set_ylabel('Count')
    axes[1, 0].grid(True, alpha=0.3)

    # Staffing recommendation by zone
    zone_staffing = hourly_demand.groupby('floor_zone').agg(
        avg_sessions=('active_sessions', 'mean'),
        peak_sessions=('active_sessions', lambda x: x.quantile(0.95)),
        std_sessions=('active_sessions', 'std')
    ).reset_index()
    zone_staffing['recommended_staff'] = np.ceil(zone_staffing['peak_sessions'] / 15)  # 1 staff per 15 sessions
    zone_staffing['min_staff'] = np.ceil(zone_staffing['avg_sessions'] / 20)  # 1 staff per 20 sessions

    x_pos = range(len(zone_staffing))
    axes[1, 1].bar(x_pos, zone_staffing['recommended_staff'], width=0.4,
                  label='Recommended (peak)', color='steelblue', align='center')
    axes[1, 1].bar([x + 0.4 for x in x_pos], zone_staffing['min_staff'], width=0.4,
                  label='Minimum (avg)', color='lightblue', align='center')
    axes[1, 1].set_xticks([x + 0.2 for x in x_pos])
    axes[1, 1].set_xticklabels(zone_staffing['floor_zone'], rotation=45, ha='right')
    axes[1, 1].set_title('Recommended Staffing by Zone', fontweight='bold')
    axes[1, 1].set_ylabel('Staff Count')
    axes[1, 1].legend()
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/staffing_optimization.png', dpi=300, bbox_inches='tight')
    plt.show()

    return rf_staff, zone_staffing

staffing_model, zone_staffing = build_staffing_model(df_sessions)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Denomination Mix Optimization

# COMMAND ----------

def optimize_denomination_mix(machine_perf, sessions):
    """Analyze denomination-level performance and optimize machine mix."""
    # Revenue efficiency by denomination
    denom_analysis = machine_perf.groupby('avg_denomination').agg(
        n_machines=('machine_id', 'count'),
        avg_revenue=('revenue', 'mean'),
        total_revenue=('revenue', 'sum'),
        avg_rtp=('actual_rtp', 'mean'),
        avg_spins=('total_spins', 'mean'),
        avg_errors=('error_events', 'mean')
    ).reset_index()

    denom_analysis['revenue_per_spin'] = (
        denom_analysis['avg_revenue'] / denom_analysis['avg_spins'].clip(lower=1)
    ).round(4)
    denom_analysis['efficiency_score'] = (
        denom_analysis['revenue_per_spin'].rank(pct=True) * 50 +
        (1 - denom_analysis['avg_errors'].rank(pct=True)) * 30 +
        denom_analysis['avg_spins'].rank(pct=True) * 20
    ).round(1)

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Revenue per spin by denomination
    denom_sorted = denom_analysis.sort_values('revenue_per_spin', ascending=True)
    axes[0, 0].barh([f"${d:.2f}" for d in denom_sorted['avg_denomination']],
                   denom_sorted['revenue_per_spin'], color='teal')
    axes[0, 0].set_title('Revenue per Spin by Denomination', fontweight='bold')
    axes[0, 0].set_xlabel('Revenue per Spin ($)')
    axes[0, 0].grid(True, alpha=0.3)

    # Machine count vs total revenue by denomination
    axes[0, 1].scatter(denom_analysis['n_machines'], denom_analysis['total_revenue'],
                      s=denom_analysis['avg_spins'] / 50, alpha=0.7, c='steelblue')
    for _, row in denom_analysis.iterrows():
        axes[0, 1].annotate(f"${row['avg_denomination']:.2f}",
                           (row['n_machines'], row['total_revenue']), fontsize=9)
    axes[0, 1].set_title('Machine Count vs Revenue (size = avg spins)', fontweight='bold')
    axes[0, 1].set_xlabel('Number of Machines')
    axes[0, 1].set_ylabel('Total Revenue ($)')
    axes[0, 1].grid(True, alpha=0.3)

    # Efficiency score
    denom_sorted_eff = denom_analysis.sort_values('efficiency_score', ascending=True)
    colors_eff = ['green' if s > 60 else 'orange' if s > 40 else 'red'
                  for s in denom_sorted_eff['efficiency_score']]
    axes[1, 0].barh([f"${d:.2f}" for d in denom_sorted_eff['avg_denomination']],
                   denom_sorted_eff['efficiency_score'], color=colors_eff)
    axes[1, 0].set_title('Denomination Efficiency Score', fontweight='bold')
    axes[1, 0].set_xlabel('Efficiency Score (0-100)')
    axes[1, 0].grid(True, alpha=0.3)

    # RTP distribution by denomination
    for denom in machine_perf['avg_denomination'].unique():
        subset = machine_perf[machine_perf['avg_denomination'] == denom]['actual_rtp']
        if len(subset) > 5:
            axes[1, 1].hist(subset, bins=15, alpha=0.4, label=f'${denom:.2f}')
    axes[1, 1].set_title('RTP Distribution by Denomination', fontweight='bold')
    axes[1, 1].set_xlabel('Actual RTP (%)')
    axes[1, 1].set_ylabel('Count')
    axes[1, 1].legend(fontsize=8)
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/denomination_optimization.png', dpi=300, bbox_inches='tight')
    plt.show()

    print("\nDenomination Performance:")
    print(denom_analysis.sort_values('efficiency_score', ascending=False).to_string(index=False))

    return denom_analysis

denom_results = optimize_denomination_mix(machine_perf, df_sessions)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Predictive Maintenance Indicators

# COMMAND ----------

def analyze_maintenance(machine_perf, slots):
    """Identify machines needing maintenance based on error patterns and performance degradation."""
    # Error pattern analysis
    errors = slots[slots['event_type'] == 'ERROR'].copy()
    if len(errors) == 0:
        print("No error events found — generating synthetic maintenance indicators from performance data.")

    # Performance degradation detection
    machine_health = machine_perf.copy()
    machine_health['error_rate'] = (
        machine_health['error_events'] / machine_health['total_spins'].clip(lower=1) * 10000
    ).round(2)  # errors per 10,000 spins

    # Maintenance risk score
    machine_health['rtp_deviation'] = abs(machine_health['actual_rtp'] - machine_health['actual_rtp'].median())
    machine_health['error_score'] = machine_health['error_rate'].rank(pct=True) * 40
    machine_health['rtp_score'] = machine_health['rtp_deviation'].rank(pct=True) * 35
    machine_health['age_score'] = (1 - machine_health['total_spins'].rank(pct=True)) * 25
    machine_health['maintenance_risk'] = (
        machine_health['error_score'] + machine_health['rtp_score'] + machine_health['age_score']
    ).round(1)

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Error rate distribution
    axes[0, 0].hist(machine_health['error_rate'], bins=30, edgecolor='black', alpha=0.7, color='coral')
    axes[0, 0].axvline(x=machine_health['error_rate'].quantile(0.90), color='red', linestyle='--',
                       label=f'90th pct: {machine_health["error_rate"].quantile(0.90):.1f}')
    axes[0, 0].set_title('Error Rate Distribution (per 10K spins)', fontweight='bold')
    axes[0, 0].set_xlabel('Errors per 10,000 Spins')
    axes[0, 0].set_ylabel('Count')
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)

    # Maintenance risk by zone
    zone_risk = machine_health.groupby('floor_zone')['maintenance_risk'].mean().sort_values(ascending=True)
    colors_risk = ['red' if v > 60 else 'orange' if v > 40 else 'green' for v in zone_risk.values]
    axes[0, 1].barh(zone_risk.index, zone_risk.values, color=colors_risk)
    axes[0, 1].set_title('Average Maintenance Risk by Zone', fontweight='bold')
    axes[0, 1].set_xlabel('Maintenance Risk Score')
    axes[0, 1].grid(True, alpha=0.3)

    # Top 20 machines at risk
    top_risk = machine_health.nlargest(20, 'maintenance_risk')
    axes[1, 0].barh(top_risk['machine_id'], top_risk['maintenance_risk'], color='darkred', alpha=0.7)
    axes[1, 0].set_title('Top 20 Machines by Maintenance Risk', fontweight='bold')
    axes[1, 0].set_xlabel('Risk Score')
    axes[1, 0].grid(True, alpha=0.3)

    # Error rate vs RTP deviation scatter
    axes[1, 1].scatter(machine_health['error_rate'], machine_health['rtp_deviation'],
                      c=machine_health['maintenance_risk'], cmap='RdYlGn_r', alpha=0.6, s=30)
    axes[1, 1].set_title('Error Rate vs RTP Deviation', fontweight='bold')
    axes[1, 1].set_xlabel('Error Rate (per 10K spins)')
    axes[1, 1].set_ylabel('RTP Deviation (%)')
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/predictive_maintenance.png', dpi=300, bbox_inches='tight')
    plt.show()

    # Priority list
    high_risk = machine_health[machine_health['maintenance_risk'] > 60]
    print(f"\nHigh-risk machines (score > 60): {len(high_risk)}")
    if len(high_risk) > 0:
        print(high_risk[['machine_id', 'floor_zone', 'error_rate', 'rtp_deviation',
                         'maintenance_risk']].sort_values('maintenance_risk', ascending=False).head(10).to_string(index=False))

    return machine_health

machine_health = analyze_maintenance(machine_perf, df_slots)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Extended Results

# COMMAND ----------

# Save cluster assignments
cluster_spark = spark.createDataFrame(machine_perf[[
    'machine_id', 'floor_zone', 'cluster', 'total_spins', 'actual_rtp',
    'revenue', 'avg_denomination'
]])
cluster_spark = cluster_spark.withColumn("analysis_date", current_date())

(cluster_spark.write
 .mode("overwrite")
 .option("mergeSchema", "true")
 .saveAsTable("gold.gld_machine_clusters"))

# Save staffing recommendations
staffing_spark = spark.createDataFrame(zone_staffing)
staffing_spark = staffing_spark.withColumn("analysis_date", current_date())

(staffing_spark.write
 .mode("overwrite")
 .option("mergeSchema", "true")
 .saveAsTable("gold.gld_staffing_recommendations"))

# Save maintenance risk
health_cols = ['machine_id', 'floor_zone', 'error_rate', 'rtp_deviation', 'maintenance_risk']
health_spark = spark.createDataFrame(machine_health[health_cols])
health_spark = health_spark.withColumn("analysis_date", current_date())

(health_spark.write
 .mode("overwrite")
 .option("mergeSchema", "true")
 .saveAsTable("gold.gld_machine_maintenance_risk"))

print("Saved to:")
print("  gold.gld_machine_clusters")
print("  gold.gld_staffing_recommendations")
print("  gold.gld_machine_maintenance_risk")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print("=" * 65)
print("FLOOR OPTIMIZATION - COMPREHENSIVE SUMMARY")
print("=" * 65)
print(f"\nMachines analyzed: {len(machine_perf):,}")
print(f"Floor zones: {machine_perf['floor_zone'].nunique()}")
print(f"Revenue prediction R2: {rev_r2:.4f}")
print(f"Machine clusters identified: {machine_perf['cluster'].nunique()}")
print(f"High-risk machines (maintenance): {len(machine_health[machine_health['maintenance_risk'] > 60])}")
print("\nOutputs:")
print("  gold.gld_machine_performance")
print("  gold.gld_zone_revenue_density")
print("  gold.gld_machine_clusters")
print("  gold.gld_staffing_recommendations")
print("  gold.gld_machine_maintenance_risk")
print("  MLflow: /Casino/floor_optimization")
print("=" * 65)
