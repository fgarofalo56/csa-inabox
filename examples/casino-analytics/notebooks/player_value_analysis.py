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
print("PLAYER VALUE ANALYSIS - SUMMARY")
print("=" * 65)
print(f"\nPlayers analyzed: {len(player_rfm):,}")
for seg in player_rfm['segment'].value_counts().items():
    print(f"  {seg[0]}: {seg[1]} ({seg[1]/len(player_rfm)*100:.1f}%)")
print("\nOutput: gold.gld_player_rfm_segments")
print("=" * 65)
