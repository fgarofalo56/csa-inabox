# Databricks notebook source
# MAGIC %md
# MAGIC # Player Value Analysis
# MAGIC
# MAGIC Comprehensive player analytics for casino operations:
# MAGIC - Player segmentation and lifetime value (LTV) estimation
# MAGIC - Behavioral pattern analysis (session duration, game preferences)
# MAGIC - Cross-property spend analysis (gaming + F&B)
# MAGIC - RFM (Recency-Frequency-Monetary) scoring
# MAGIC - Churn risk identification
# MAGIC
# MAGIC **All data is ENTIRELY SYNTHETIC.**

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup

# COMMAND ----------

import warnings
from datetime import timedelta

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

warnings.filterwarnings('ignore')


from pyspark.sql.functions import *

plt.style.use('seaborn-v0_8')
sns.set_palette("husl")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading

# COMMAND ----------

def load_casino_data():
    """Load all casino datasets."""
    sessions = spark.table("silver.slv_player_sessions").toPandas()
    slots = spark.table("silver.slv_slot_events").toPandas()
    fnb = spark.table("silver.slv_fnb_transactions").toPandas()

    sessions['session_date'] = pd.to_datetime(sessions['session_date'])
    fnb['transaction_date'] = pd.to_datetime(fnb['transaction_date'])

    print(f"Sessions: {len(sessions):,}")
    print(f"Slot events: {len(slots):,}")
    print(f"F&B transactions: {len(fnb):,}")
    print(f"Unique players: {sessions['player_id'].nunique()}")
    return sessions, slots, fnb

df_sessions, df_slots, df_fnb = load_casino_data()

# COMMAND ----------

# MAGIC %md
# MAGIC ## RFM Analysis

# COMMAND ----------

def compute_rfm(sessions, fnb):
    """Compute RFM scores for player segmentation."""
    ref_date = sessions['session_date'].max() + timedelta(days=1)

    # Gaming RFM
    gaming_rfm = sessions.groupby('player_id').agg(
        recency_days=('session_date', lambda x: (ref_date - x.max()).days),
        frequency=('session_id', 'count'),
        monetary_coin_in=('coin_in', 'sum'),
        monetary_theo_win=('theoretical_win', 'sum'),
        avg_duration=('duration_minutes', 'mean'),
        total_actual_win=('actual_win', 'sum')
    ).reset_index()

    # F&B spend
    fnb_spend = fnb.groupby('player_id').agg(
        fnb_total=('total', 'sum'),
        fnb_visits=('transaction_id', 'count'),
        comp_total=('comp_value', 'sum')
    ).reset_index()

    # Merge
    player_rfm = gaming_rfm.merge(fnb_spend, on='player_id', how='left').fillna(0)

    # Score each dimension 1-5
    for col in ['recency_days', 'frequency', 'monetary_coin_in']:
        if col == 'recency_days':
            player_rfm[f'{col}_score'] = pd.qcut(player_rfm[col], 5, labels=[5,4,3,2,1], duplicates='drop').astype(int)
        else:
            player_rfm[f'{col}_score'] = pd.qcut(player_rfm[col].rank(method='first'), 5, labels=[1,2,3,4,5], duplicates='drop').astype(int)

    player_rfm['rfm_score'] = (
        player_rfm['recency_days_score'] * 100 +
        player_rfm['frequency_score'] * 10 +
        player_rfm['monetary_coin_in_score']
    )

    # Segment labels
    def segment(row):
        r, f, m = row['recency_days_score'], row['frequency_score'], row['monetary_coin_in_score']
        if r >= 4 and f >= 4 and m >= 4: return 'VIP'
        if r >= 3 and f >= 3: return 'Loyal'
        if r >= 4 and f <= 2: return 'New'
        if r <= 2 and f >= 3: return 'At Risk'
        if r <= 2 and f <= 2: return 'Lost'
        return 'Regular'

    player_rfm['segment'] = player_rfm.apply(segment, axis=1)

    # Visualization
    fig, axes = plt.subplots(2, 2, figsize=(16, 12))

    # Segment distribution
    seg_counts = player_rfm['segment'].value_counts()
    seg_colors = {'VIP': 'gold', 'Loyal': 'green', 'Regular': 'steelblue',
                  'New': 'skyblue', 'At Risk': 'orange', 'Lost': 'red'}
    axes[0, 0].pie(seg_counts.values, labels=seg_counts.index, autopct='%1.1f%%',
                   colors=[seg_colors.get(s, 'gray') for s in seg_counts.index])
    axes[0, 0].set_title('Player Segments', fontweight='bold')

    # Revenue by segment
    seg_revenue = player_rfm.groupby('segment')['monetary_theo_win'].sum().sort_values()
    seg_revenue.plot(kind='barh', ax=axes[0, 1],
                    color=[seg_colors.get(s, 'gray') for s in seg_revenue.index])
    axes[0, 1].set_title('Theoretical Win by Segment', fontweight='bold')
    axes[0, 1].set_xlabel('Theoretical Win ($)')
    axes[0, 1].grid(True, alpha=0.3)

    # Coin-in distribution
    axes[1, 0].hist(np.log10(player_rfm['monetary_coin_in'].clip(lower=1)), bins=30,
                   edgecolor='black', alpha=0.7, color='steelblue')
    axes[1, 0].set_title('Coin-In Distribution (log10)', fontweight='bold')
    axes[1, 0].set_xlabel('log10(Coin-In)')
    axes[1, 0].set_ylabel('Count')
    axes[1, 0].grid(True, alpha=0.3)

    # Cross-property spend
    axes[1, 1].scatter(player_rfm['monetary_coin_in'], player_rfm['fnb_total'],
                      alpha=0.5, s=30, c=player_rfm['frequency'], cmap='viridis')
    axes[1, 1].set_title('Gaming vs F&B Spend', fontweight='bold')
    axes[1, 1].set_xlabel('Coin-In ($)')
    axes[1, 1].set_ylabel('F&B Total ($)')
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/player_rfm.png', dpi=300, bbox_inches='tight')
    plt.show()

    return player_rfm

player_rfm = compute_rfm(df_sessions, df_fnb)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Game Preference Analysis

# COMMAND ----------

def analyze_game_preferences(sessions):
    """Analyze game type preferences and performance."""
    fig, axes = plt.subplots(1, 2, figsize=(16, 6))

    # Coin-in by game type
    game_revenue = sessions.groupby('game_type').agg(
        total_coin_in=('coin_in', 'sum'),
        avg_duration=('duration_minutes', 'mean'),
        session_count=('session_id', 'count'),
        avg_theo_win=('theoretical_win', 'mean')
    ).sort_values('total_coin_in', ascending=True).reset_index()

    axes[0].barh(game_revenue['game_type'], game_revenue['total_coin_in'],
                color=sns.color_palette('viridis', len(game_revenue)))
    axes[0].set_title('Total Coin-In by Game Type', fontweight='bold')
    axes[0].set_xlabel('Coin-In ($)')
    axes[0].grid(True, alpha=0.3)

    # Average session duration by game type
    axes[1].barh(game_revenue['game_type'], game_revenue['avg_duration'],
                color=sns.color_palette('mako', len(game_revenue)))
    axes[1].set_title('Average Session Duration by Game Type', fontweight='bold')
    axes[1].set_xlabel('Duration (minutes)')
    axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/game_preferences.png', dpi=300, bbox_inches='tight')
    plt.show()

analyze_game_preferences(df_sessions)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results

# COMMAND ----------

rfm_spark = spark.createDataFrame(player_rfm[[
    'player_id', 'recency_days', 'frequency', 'monetary_coin_in',
    'monetary_theo_win', 'total_actual_win', 'fnb_total', 'fnb_visits',
    'comp_total', 'avg_duration', 'segment', 'rfm_score'
]])
rfm_spark = rfm_spark.withColumn("analysis_date", current_date())

(rfm_spark.write
 .mode("overwrite")
 .option("mergeSchema", "true")
 .saveAsTable("gold.gld_player_rfm_segments"))

print("Saved to gold.gld_player_rfm_segments")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print("=" * 65)
print("PLAYER VALUE ANALYSIS - INITIAL RESULTS")
print("=" * 65)
print(f"\nPlayers analyzed: {len(player_rfm):,}")
for seg in player_rfm['segment'].value_counts().items():
    print(f"  {seg[0]}: {seg[1]} ({seg[1]/len(player_rfm)*100:.1f}%)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Churn Prediction Model

# COMMAND ----------

import mlflow
import mlflow.sklearn
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    classification_report,
    f1_score,
    roc_auc_score,
    roc_curve,
)
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler

mlflow.set_experiment("/Casino/player_value_analysis")

def build_churn_model(player_rfm, sessions):
    """Predict player churn using RFM features and behavioral data."""
    df_churn = player_rfm.copy()

    # Define churn: no visit in last 30 days (recency > 30)
    churn_threshold = 30
    df_churn['is_churned'] = (df_churn['recency_days'] > churn_threshold).astype(int)
    churn_rate = df_churn['is_churned'].mean()
    print(f"Churn rate (>{churn_threshold} days): {churn_rate*100:.1f}%")

    # Behavioral features
    session_stats = sessions.groupby('player_id').agg(
        session_count=('session_id', 'count'),
        avg_session_duration=('duration_minutes', 'mean'),
        std_session_duration=('duration_minutes', 'std'),
        game_variety=('game_type', 'nunique'),
        zones_visited=('floor_zone', 'nunique'),
        avg_coin_in=('coin_in', 'mean'),
        max_actual_win=('actual_win', 'max'),
        total_actual_win=('actual_win', 'sum')
    ).reset_index()

    df_churn = df_churn.merge(session_stats, on='player_id', how='left').fillna(0)

    # Win rate proxy
    df_churn['win_rate'] = (
        df_churn['total_actual_win'] / df_churn['monetary_coin_in'].clip(lower=1)
    ).round(4)

    features = ['frequency', 'monetary_coin_in', 'monetary_theo_win', 'fnb_total',
                'avg_duration', 'session_count', 'avg_session_duration', 'std_session_duration',
                'game_variety', 'zones_visited', 'avg_coin_in', 'win_rate', 'comp_total']
    available = [f for f in features if f in df_churn.columns]

    X = df_churn[available].fillna(0)
    y = df_churn['is_churned']

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2,
                                                         stratify=y, random_state=42)
    scaler = StandardScaler()
    X_train_s = scaler.fit_transform(X_train)
    X_test_s = scaler.transform(X_test)

    models = {
        'Logistic Regression': LogisticRegression(max_iter=1000, random_state=42),
        'Random Forest': RandomForestClassifier(n_estimators=100, max_depth=8, random_state=42),
        'Gradient Boosting': GradientBoostingClassifier(n_estimators=100, max_depth=4, random_state=42)
    }

    churn_results = {}
    for name, model in models.items():
        with mlflow.start_run(run_name=f"churn_{name.lower().replace(' ', '_')}"):
            model.fit(X_train_s, y_train)
            y_pred = model.predict(X_test_s)
            y_prob = model.predict_proba(X_test_s)[:, 1]

            f1 = f1_score(y_test, y_pred)
            auc = roc_auc_score(y_test, y_prob)

            churn_results[name] = {'model': model, 'f1': f1, 'auc': auc,
                                    'y_pred': y_pred, 'y_prob': y_prob}
            mlflow.log_metric("f1", f1)
            mlflow.log_metric("auc", auc)
            mlflow.sklearn.log_model(model, f"churn_{name}")
            print(f"{name}: F1={f1:.3f}, AUC={auc:.3f}")

    # ROC curves
    fig, axes = plt.subplots(1, 2, figsize=(16, 6))
    for name, res in churn_results.items():
        fpr, tpr, _ = roc_curve(y_test, res['y_prob'])
        axes[0].plot(fpr, tpr, label=f"{name} (AUC={res['auc']:.3f})")
    axes[0].plot([0, 1], [0, 1], 'k--', alpha=0.5)
    axes[0].set_title('Churn Prediction ROC Curves', fontweight='bold')
    axes[0].set_xlabel('False Positive Rate')
    axes[0].set_ylabel('True Positive Rate')
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)

    # Feature importance (best model)
    best_name = max(churn_results.keys(), key=lambda k: churn_results[k]['auc'])
    best = churn_results[best_name]['model']
    if hasattr(best, 'feature_importances_'):
        imp = pd.DataFrame({'feature': available, 'importance': best.feature_importances_})
        imp = imp.sort_values('importance', ascending=True)
        axes[1].barh(imp['feature'], imp['importance'], color='steelblue')
        axes[1].set_title(f'Feature Importance ({best_name})', fontweight='bold')
        axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/churn_prediction.png', dpi=300, bbox_inches='tight')
    plt.show()

    # Add churn probability to player data
    X_all_s = scaler.transform(X)
    df_churn['churn_probability'] = best.predict_proba(X_all_s)[:, 1]

    return df_churn, churn_results

df_churn, churn_results = build_churn_model(player_rfm, df_sessions)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Promotional ROI Analysis

# COMMAND ----------

def analyze_promotional_roi(player_rfm, fnb):
    """Analyze the ROI of comps and promotional spending by segment."""
    df_promo = player_rfm.copy()

    # Promotional ROI per segment
    promo_by_segment = df_promo.groupby('segment').agg(
        n_players=('player_id', 'count'),
        total_theo_win=('monetary_theo_win', 'sum'),
        total_comp_value=('comp_total', 'sum'),
        avg_comp_per_player=('comp_total', 'mean'),
        avg_visits=('frequency', 'mean'),
        avg_coin_in=('monetary_coin_in', 'mean'),
        total_fnb=('fnb_total', 'sum')
    ).reset_index()

    promo_by_segment['comp_to_theo_ratio'] = (
        promo_by_segment['total_comp_value'] / promo_by_segment['total_theo_win'].clip(lower=1)
    ).round(4)
    promo_by_segment['roi'] = (
        (promo_by_segment['total_theo_win'] - promo_by_segment['total_comp_value'])
        / promo_by_segment['total_comp_value'].clip(lower=1)
    ).round(2)
    promo_by_segment['revenue_per_comp_dollar'] = (
        promo_by_segment['total_theo_win'] / promo_by_segment['total_comp_value'].clip(lower=1)
    ).round(2)

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Comp-to-Theo ratio by segment
    seg_order = promo_by_segment.sort_values('comp_to_theo_ratio')
    colors_seg = {'VIP': 'gold', 'Loyal': 'green', 'Regular': 'steelblue',
                  'New': 'skyblue', 'At Risk': 'orange', 'Lost': 'red'}
    bar_colors = [colors_seg.get(s, 'gray') for s in seg_order['segment']]
    axes[0, 0].barh(seg_order['segment'], seg_order['comp_to_theo_ratio'], color=bar_colors)
    axes[0, 0].set_title('Comp-to-Theo Win Ratio by Segment', fontweight='bold')
    axes[0, 0].set_xlabel('Comp / Theoretical Win')
    axes[0, 0].grid(True, alpha=0.3)

    # ROI by segment
    roi_sorted = promo_by_segment.sort_values('roi')
    roi_colors = ['red' if r < 0 else 'green' for r in roi_sorted['roi']]
    axes[0, 1].barh(roi_sorted['segment'], roi_sorted['roi'], color=roi_colors)
    axes[0, 1].set_title('Promotional ROI by Segment', fontweight='bold')
    axes[0, 1].set_xlabel('ROI')
    axes[0, 1].axvline(x=0, color='black', linestyle='-')
    axes[0, 1].grid(True, alpha=0.3)

    # Comp spending efficiency: theo win vs comp
    axes[1, 0].scatter(promo_by_segment['total_comp_value'],
                      promo_by_segment['total_theo_win'],
                      s=promo_by_segment['n_players'] * 2, alpha=0.7)
    for _, row in promo_by_segment.iterrows():
        axes[1, 0].annotate(row['segment'],
                           (row['total_comp_value'], row['total_theo_win']), fontsize=10)
    axes[1, 0].set_title('Comp Spend vs Theo Win (size = players)', fontweight='bold')
    axes[1, 0].set_xlabel('Total Comp Value ($)')
    axes[1, 0].set_ylabel('Total Theoretical Win ($)')
    axes[1, 0].grid(True, alpha=0.3)

    # F&B vs Gaming spend per segment
    x_pos = range(len(promo_by_segment))
    w = 0.35
    axes[1, 1].bar(x_pos, promo_by_segment['avg_coin_in'], width=w,
                  label='Avg Gaming (Coin-In)', color='steelblue')
    axes[1, 1].bar([x + w for x in x_pos],
                  promo_by_segment['total_fnb'] / promo_by_segment['n_players'],
                  width=w, label='Avg F&B', color='coral')
    axes[1, 1].set_xticks([x + w/2 for x in x_pos])
    axes[1, 1].set_xticklabels(promo_by_segment['segment'], rotation=45)
    axes[1, 1].set_title('Avg Gaming vs F&B Spend per Player', fontweight='bold')
    axes[1, 1].set_ylabel('Average Spend ($)')
    axes[1, 1].legend()
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/promotional_roi.png', dpi=300, bbox_inches='tight')
    plt.show()

    print("\nPromotional ROI by Segment:")
    print(promo_by_segment[['segment', 'n_players', 'comp_to_theo_ratio', 'roi',
                            'revenue_per_comp_dollar']].to_string(index=False))
    return promo_by_segment

promo_roi = analyze_promotional_roi(player_rfm, df_fnb)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Player Lifetime Value (LTV) Forecasting

# COMMAND ----------

from sklearn.ensemble import GradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, r2_score


def forecast_player_ltv(player_rfm, sessions):
    """Forecast player lifetime value using historical behavioral data."""
    df_ltv = player_rfm.copy()

    # Session-level features
    session_feats = sessions.groupby('player_id').agg(
        first_visit=('session_date', 'min'),
        last_visit=('session_date', 'max'),
        total_sessions=('session_id', 'count'),
        game_types_played=('game_type', 'nunique'),
        zones_visited=('floor_zone', 'nunique'),
        avg_coin_in_session=('coin_in', 'mean'),
        std_coin_in_session=('coin_in', 'std'),
        max_session_duration=('duration_minutes', 'max'),
        avg_actual_win=('actual_win', 'mean')
    ).reset_index()

    df_ltv = df_ltv.merge(session_feats, on='player_id', how='left').fillna(0)

    # Tenure in days
    df_ltv['tenure_days'] = (
        pd.to_datetime(df_ltv['last_visit']) - pd.to_datetime(df_ltv['first_visit'])
    ).dt.days.clip(lower=1)

    # Daily revenue rate
    df_ltv['daily_revenue_rate'] = (df_ltv['monetary_theo_win'] / df_ltv['tenure_days']).round(2)

    # Projected annual LTV (simple extrapolation)
    df_ltv['projected_annual_ltv'] = (df_ltv['daily_revenue_rate'] * 365).round(2)

    # ML-based LTV prediction
    features = ['frequency', 'monetary_coin_in', 'fnb_total', 'avg_duration',
                'total_sessions', 'game_types_played', 'zones_visited',
                'avg_coin_in_session', 'std_coin_in_session', 'max_session_duration',
                'avg_actual_win', 'tenure_days', 'comp_total']
    available = [f for f in features if f in df_ltv.columns]

    X = df_ltv[available].fillna(0)
    y = np.log1p(df_ltv['projected_annual_ltv'].clip(lower=0))

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    scaler_ltv = StandardScaler()
    X_train_s = scaler_ltv.fit_transform(X_train)
    X_test_s = scaler_ltv.transform(X_test)

    gb_ltv = GradientBoostingRegressor(n_estimators=150, max_depth=5, random_state=42)
    with mlflow.start_run(run_name="player_ltv_forecast"):
        gb_ltv.fit(X_train_s, y_train)
        y_pred = gb_ltv.predict(X_test_s)

        ltv_mae = mean_absolute_error(y_test, y_pred)
        ltv_r2 = r2_score(y_test, y_pred)

        mlflow.log_metric("mae", ltv_mae)
        mlflow.log_metric("r2", ltv_r2)
        mlflow.sklearn.log_model(gb_ltv, "player_ltv_model")
        print(f"LTV Model - MAE: {ltv_mae:.4f}, R2: {ltv_r2:.4f}")

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Actual vs predicted LTV
    axes[0, 0].scatter(y_test, y_pred, alpha=0.5, s=30)
    axes[0, 0].plot([y_test.min(), y_test.max()], [y_test.min(), y_test.max()], 'r--')
    axes[0, 0].set_title(f'LTV Prediction (R2={ltv_r2:.3f})', fontweight='bold')
    axes[0, 0].set_xlabel('Actual log(LTV)')
    axes[0, 0].set_ylabel('Predicted log(LTV)')
    axes[0, 0].grid(True, alpha=0.3)

    # Feature importance
    imp = pd.DataFrame({'feature': available, 'importance': gb_ltv.feature_importances_})
    imp = imp.sort_values('importance', ascending=True)
    axes[0, 1].barh(imp['feature'], imp['importance'], color='teal')
    axes[0, 1].set_title('LTV Feature Importance', fontweight='bold')
    axes[0, 1].grid(True, alpha=0.3)

    # LTV distribution by segment
    for seg in df_ltv['segment'].unique():
        subset = df_ltv[df_ltv['segment'] == seg]['projected_annual_ltv']
        if len(subset) > 0:
            axes[1, 0].hist(np.log1p(subset.clip(lower=0)), bins=20, alpha=0.5, label=seg)
    axes[1, 0].set_title('Annual LTV Distribution by Segment (log)', fontweight='bold')
    axes[1, 0].set_xlabel('log(Projected Annual LTV)')
    axes[1, 0].set_ylabel('Count')
    axes[1, 0].legend(fontsize=8)
    axes[1, 0].grid(True, alpha=0.3)

    # Segment LTV summary
    ltv_by_seg = df_ltv.groupby('segment').agg(
        n_players=('player_id', 'count'),
        avg_ltv=('projected_annual_ltv', 'mean'),
        median_ltv=('projected_annual_ltv', 'median'),
        total_ltv=('projected_annual_ltv', 'sum')
    ).sort_values('avg_ltv', ascending=True).reset_index()

    axes[1, 1].barh(ltv_by_seg['segment'], ltv_by_seg['avg_ltv'],
                   color=[colors_seg.get(s, 'gray') for s in ltv_by_seg['segment']])
    axes[1, 1].set_title('Average Projected Annual LTV by Segment', fontweight='bold')
    axes[1, 1].set_xlabel('Average Annual LTV ($)')
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/player_ltv.png', dpi=300, bbox_inches='tight')
    plt.show()

    print("\nLTV Summary by Segment:")
    print(ltv_by_seg.to_string(index=False))

    # Add LTV to main dataframe
    X_all_s = scaler_ltv.transform(X)
    df_ltv['predicted_ltv'] = np.expm1(gb_ltv.predict(X_all_s))

    return df_ltv, gb_ltv

df_ltv, ltv_model = forecast_player_ltv(player_rfm, df_sessions)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Player Behavior Patterns and Session Analysis

# COMMAND ----------

def analyze_player_behavior(sessions, player_rfm):
    """Deep dive into player behavioral patterns across sessions."""
    sessions_copy = sessions.copy()
    sessions_copy['session_date'] = pd.to_datetime(sessions_copy['session_date'])
    sessions_copy['day_of_week'] = sessions_copy['session_date'].dt.dayofweek
    sessions_copy['is_weekend'] = sessions_copy['day_of_week'] >= 5

    # Merge segment info
    sessions_copy = sessions_copy.merge(
        player_rfm[['player_id', 'segment']], on='player_id', how='left'
    )

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Session duration distribution by segment
    for seg in ['VIP', 'Loyal', 'Regular', 'At Risk']:
        subset = sessions_copy[sessions_copy['segment'] == seg]['duration_minutes']
        if len(subset) > 10:
            axes[0, 0].hist(subset, bins=30, alpha=0.4, label=seg)
    axes[0, 0].set_title('Session Duration by Segment', fontweight='bold')
    axes[0, 0].set_xlabel('Duration (minutes)')
    axes[0, 0].set_ylabel('Count')
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)

    # Weekend vs weekday behavior by segment
    wk_behavior = sessions_copy.groupby(['segment', 'is_weekend']).agg(
        avg_coin_in=('coin_in', 'mean'),
        avg_duration=('duration_minutes', 'mean')
    ).reset_index()

    wk_pivot = wk_behavior.pivot(index='segment', columns='is_weekend', values='avg_coin_in')
    wk_pivot.columns = ['Weekday', 'Weekend']
    wk_pivot.plot(kind='bar', ax=axes[0, 1])
    axes[0, 1].set_title('Avg Coin-In: Weekday vs Weekend', fontweight='bold')
    axes[0, 1].set_ylabel('Avg Coin-In ($)')
    axes[0, 1].tick_params(axis='x', rotation=45)
    axes[0, 1].legend()
    axes[0, 1].grid(True, alpha=0.3)

    # Game type preference by segment
    game_seg = sessions_copy.groupby(['segment', 'game_type'])['session_id'].count().reset_index()
    game_seg_pivot = game_seg.pivot(index='segment', columns='game_type', values='session_id').fillna(0)
    game_seg_pct = game_seg_pivot.div(game_seg_pivot.sum(axis=1), axis=0) * 100
    game_seg_pct.plot(kind='bar', stacked=True, ax=axes[1, 0])
    axes[1, 0].set_title('Game Type Preference by Segment (%)', fontweight='bold')
    axes[1, 0].set_ylabel('Percentage')
    axes[1, 0].tick_params(axis='x', rotation=45)
    axes[1, 0].legend(fontsize=7, bbox_to_anchor=(1.05, 1))
    axes[1, 0].grid(True, alpha=0.3)

    # Visit frequency over time (cohort view)
    sessions_copy['month'] = sessions_copy['session_date'].dt.to_period('M')
    monthly_visits = sessions_copy.groupby(['segment', 'month']).agg(
        unique_players=('player_id', 'nunique')
    ).reset_index()
    monthly_visits['month'] = monthly_visits['month'].dt.to_timestamp()

    for seg in ['VIP', 'Loyal', 'Regular', 'At Risk']:
        seg_data = monthly_visits[monthly_visits['segment'] == seg]
        if len(seg_data) > 0:
            axes[1, 1].plot(seg_data['month'], seg_data['unique_players'],
                           marker='o', label=seg, linewidth=1.5)
    axes[1, 1].set_title('Active Players by Segment Over Time', fontweight='bold')
    axes[1, 1].set_xlabel('Month')
    axes[1, 1].set_ylabel('Unique Players')
    axes[1, 1].legend()
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/player_behavior_patterns.png', dpi=300, bbox_inches='tight')
    plt.show()

analyze_player_behavior(df_sessions, player_rfm)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Extended Results

# COMMAND ----------

# Save churn predictions
churn_spark = spark.createDataFrame(df_churn[[
    'player_id', 'segment', 'rfm_score', 'is_churned', 'churn_probability'
]])
churn_spark = churn_spark.withColumn("analysis_date", current_date())

(churn_spark.write
 .mode("overwrite")
 .option("mergeSchema", "true")
 .saveAsTable("gold.gld_player_churn_predictions"))

# Save LTV forecasts
ltv_spark = spark.createDataFrame(df_ltv[[
    'player_id', 'segment', 'projected_annual_ltv', 'predicted_ltv',
    'daily_revenue_rate', 'tenure_days'
]])
ltv_spark = ltv_spark.withColumn("analysis_date", current_date())

(ltv_spark.write
 .mode("overwrite")
 .option("mergeSchema", "true")
 .saveAsTable("gold.gld_player_ltv_forecast"))

# Save promotional ROI
promo_spark = spark.createDataFrame(promo_roi)
promo_spark = promo_spark.withColumn("analysis_date", current_date())

(promo_spark.write
 .mode("overwrite")
 .option("mergeSchema", "true")
 .saveAsTable("gold.gld_promotional_roi"))

print("Saved to:")
print("  gold.gld_player_churn_predictions")
print("  gold.gld_player_ltv_forecast")
print("  gold.gld_promotional_roi")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

colors_seg = {'VIP': 'gold', 'Loyal': 'green', 'Regular': 'steelblue',
              'New': 'skyblue', 'At Risk': 'orange', 'Lost': 'red'}

print("=" * 65)
print("PLAYER VALUE ANALYSIS - COMPREHENSIVE SUMMARY")
print("=" * 65)
print(f"\nPlayers analyzed: {len(player_rfm):,}")
for seg in player_rfm['segment'].value_counts().items():
    print(f"  {seg[0]}: {seg[1]} ({seg[1]/len(player_rfm)*100:.1f}%)")
best_churn = max(churn_results.keys(), key=lambda k: churn_results[k]['auc'])
print(f"\nBest churn model: {best_churn} (AUC={churn_results[best_churn]['auc']:.3f})")
print(f"Churn rate: {df_churn['is_churned'].mean()*100:.1f}%")
print(f"LTV model R2: {r2_score(np.log1p(df_ltv['projected_annual_ltv'].clip(lower=0)), np.log1p(df_ltv['predicted_ltv'].clip(lower=0))):.4f}")
print("\nOutputs:")
print("  gold.gld_player_rfm_segments")
print("  gold.gld_player_churn_predictions")
print("  gold.gld_player_ltv_forecast")
print("  gold.gld_promotional_roi")
print("  MLflow: /Casino/player_value_analysis")
print("=" * 65)
