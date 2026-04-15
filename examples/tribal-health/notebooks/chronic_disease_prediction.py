# Databricks notebook source
# MAGIC %md
# MAGIC # Chronic Disease Prediction Model
# MAGIC
# MAGIC ML models for predicting chronic disease risk in tribal populations:
# MAGIC - Diabetes risk scoring
# MAGIC - Multi-morbidity pattern detection
# MAGIC - Service utilization prediction
# MAGIC - Health disparity quantification
# MAGIC
# MAGIC **IMPORTANT:** All data is ENTIRELY SYNTHETIC. No real PHI.

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

from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split, cross_val_score, StratifiedKFold
from sklearn.metrics import (classification_report, confusion_matrix, roc_auc_score,
                             roc_curve, precision_recall_curve, f1_score)
from sklearn.preprocessing import StandardScaler, LabelEncoder

from pyspark.sql import SparkSession
from pyspark.sql.functions import *
import mlflow
import mlflow.sklearn

plt.style.use('seaborn-v0_8')
mlflow.set_experiment("/TribalHealth/chronic_disease_prediction")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading and Feature Engineering

# COMMAND ----------

def load_and_prepare():
    """Load data and engineer features for chronic disease prediction."""
    patients = spark.table("silver.slv_patient_demographics").toPandas()
    encounters = spark.table("silver.slv_encounters").toPandas()
    encounters['encounter_date'] = pd.to_datetime(encounters['encounter_date'])

    # Create patient-level features
    patient_encounters = encounters.groupby('patient_id').agg(
        total_encounters=('encounter_id', 'count'),
        unique_facilities=('facility_id', 'nunique'),
        ed_visits=('encounter_type', lambda x: (x == 'ED').sum()),
        inpatient_stays=('encounter_type', lambda x: (x == 'INPATIENT').sum()),
        telehealth_visits=('encounter_type', lambda x: (x == 'TELEHEALTH').sum()),
        unique_dx=('primary_dx_icd10', 'nunique'),
        has_diabetes=('primary_dx_icd10', lambda x: x.str.startswith('E11', na=False).any()),
        has_hypertension=('primary_dx_icd10', lambda x: x.str.startswith('I10', na=False).any()),
        has_depression=('primary_dx_icd10', lambda x: x.str.startswith('F32', na=False).any()),
        has_substance=('primary_dx_icd10', lambda x: x.str.startswith('F10', na=False).any()),
        has_obesity=('primary_dx_icd10', lambda x: x.str.startswith('E66', na=False).any()),
        first_encounter=('encounter_date', 'min'),
        last_encounter=('encounter_date', 'max')
    ).reset_index()

    patient_encounters['encounter_span_days'] = (
        patient_encounters['last_encounter'] - patient_encounters['first_encounter']
    ).dt.days

    # Merge with demographics
    df_ml = patients.merge(patient_encounters, on='patient_id', how='inner')

    # Encode categoricals
    le_tribe = LabelEncoder()
    le_su = LabelEncoder()
    le_gender = LabelEncoder()
    le_age = LabelEncoder()

    df_ml['tribe_encoded'] = le_tribe.fit_transform(df_ml['tribal_affiliation'])
    df_ml['su_encoded'] = le_su.fit_transform(df_ml['service_unit'])
    df_ml['gender_encoded'] = le_gender.fit_transform(df_ml['gender'])
    df_ml['age_encoded'] = le_age.fit_transform(df_ml['age_group'])

    # Multi-morbidity count
    df_ml['comorbidity_count'] = (
        df_ml['has_diabetes'].astype(int) +
        df_ml['has_hypertension'].astype(int) +
        df_ml['has_depression'].astype(int) +
        df_ml['has_substance'].astype(int) +
        df_ml['has_obesity'].astype(int)
    )

    print(f"ML dataset: {len(df_ml):,} patients, {df_ml.shape[1]} features")
    print(f"Diabetes prevalence: {df_ml['has_diabetes'].mean()*100:.1f}%")
    print(f"Hypertension prevalence: {df_ml['has_hypertension'].mean()*100:.1f}%")

    return df_ml

df_ml = load_and_prepare()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Diabetes Risk Prediction

# COMMAND ----------

def train_diabetes_model(df):
    """Train model to predict diabetes risk."""
    features = ['tribe_encoded', 'su_encoded', 'gender_encoded', 'age_encoded',
                'total_encounters', 'unique_facilities', 'ed_visits', 'inpatient_stays',
                'telehealth_visits', 'unique_dx', 'has_hypertension', 'has_depression',
                'has_substance', 'has_obesity', 'encounter_span_days', 'comorbidity_count']

    available = [f for f in features if f in df.columns]
    X = df[available].fillna(0)
    y = df['has_diabetes'].astype(int)

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2,
                                                         stratify=y, random_state=42)

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    models = {
        'Logistic Regression': LogisticRegression(max_iter=1000, random_state=42),
        'Random Forest': RandomForestClassifier(n_estimators=100, max_depth=8, random_state=42),
        'Gradient Boosting': GradientBoostingClassifier(n_estimators=100, max_depth=4, random_state=42)
    }

    results = {}
    for name, model in models.items():
        with mlflow.start_run(run_name=f"diabetes_{name.lower().replace(' ', '_')}"):
            model.fit(X_train_scaled, y_train)
            y_pred = model.predict(X_test_scaled)
            y_prob = model.predict_proba(X_test_scaled)[:, 1]

            f1 = f1_score(y_test, y_pred)
            auc = roc_auc_score(y_test, y_prob)

            results[name] = {
                'model': model, 'f1': f1, 'auc': auc,
                'y_pred': y_pred, 'y_prob': y_prob
            }

            mlflow.log_metric("f1", f1)
            mlflow.log_metric("auc", auc)
            mlflow.sklearn.log_model(model, f"diabetes_{name}")

            print(f"{name}: F1={f1:.3f}, AUC={auc:.3f}")

    # ROC curves
    fig, axes = plt.subplots(1, 2, figsize=(14, 6))
    for name, res in results.items():
        fpr, tpr, _ = roc_curve(y_test, res['y_prob'])
        axes[0].plot(fpr, tpr, label=f"{name} (AUC={res['auc']:.3f})")

    axes[0].plot([0, 1], [0, 1], 'k--', alpha=0.5)
    axes[0].set_title('ROC Curves - Diabetes Prediction', fontweight='bold')
    axes[0].set_xlabel('False Positive Rate')
    axes[0].set_ylabel('True Positive Rate')
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)

    # Feature importance (best model)
    best_name = max(results.keys(), key=lambda k: results[k]['auc'])
    best_model = results[best_name]['model']
    if hasattr(best_model, 'feature_importances_'):
        imp = pd.DataFrame({'feature': available, 'importance': best_model.feature_importances_})
        imp = imp.sort_values('importance', ascending=True)
        axes[1].barh(imp['feature'], imp['importance'])
        axes[1].set_title(f'Feature Importance ({best_name})', fontweight='bold')
        axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/diabetes_prediction.png', dpi=300, bbox_inches='tight')
    plt.show()

    return results

diabetes_results = train_diabetes_model(df_ml)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Multi-Morbidity Analysis

# COMMAND ----------

def analyze_multimorbidity(df):
    """Analyze multi-morbidity patterns."""
    conditions = ['has_diabetes', 'has_hypertension', 'has_depression', 'has_substance', 'has_obesity']
    condition_labels = ['Diabetes', 'Hypertension', 'Depression', 'Substance Use', 'Obesity']

    # Co-occurrence matrix
    cooccurrence = pd.DataFrame(index=condition_labels, columns=condition_labels, dtype=float)
    for i, c1 in enumerate(conditions):
        for j, c2 in enumerate(conditions):
            both = ((df[c1] == True) & (df[c2] == True)).sum()
            either = ((df[c1] == True) | (df[c2] == True)).sum()
            cooccurrence.iloc[i, j] = both / max(either, 1) * 100

    fig, axes = plt.subplots(1, 2, figsize=(16, 6))

    sns.heatmap(cooccurrence.astype(float), annot=True, fmt='.1f', cmap='YlOrRd',
                ax=axes[0], cbar_kws={'label': 'Co-occurrence (%)'})
    axes[0].set_title('Condition Co-occurrence Matrix', fontweight='bold')

    # Comorbidity distribution
    comorbidity_dist = df['comorbidity_count'].value_counts().sort_index()
    axes[1].bar(comorbidity_dist.index, comorbidity_dist.values, color=sns.color_palette('RdYlGn_r', len(comorbidity_dist)))
    axes[1].set_title('Multi-Morbidity Distribution', fontweight='bold')
    axes[1].set_xlabel('Number of Chronic Conditions')
    axes[1].set_ylabel('Patient Count')
    axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/multimorbidity.png', dpi=300, bbox_inches='tight')
    plt.show()

analyze_multimorbidity(df_ml)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Health Disparity Index

# COMMAND ----------

def compute_disparity_index(df):
    """Compute health disparity index by tribe."""
    tribe_metrics = df.groupby('tribal_affiliation').agg(
        n_patients=('patient_id', 'count'),
        diabetes_rate=('has_diabetes', 'mean'),
        hypertension_rate=('has_hypertension', 'mean'),
        depression_rate=('has_depression', 'mean'),
        avg_encounters=('total_encounters', 'mean'),
        avg_comorbidities=('comorbidity_count', 'mean'),
        ed_rate=('ed_visits', lambda x: (x > 0).mean())
    ).reset_index()

    # Composite disparity score (normalized 0-100)
    for col in ['diabetes_rate', 'hypertension_rate', 'depression_rate', 'avg_comorbidities', 'ed_rate']:
        tribe_metrics[f'{col}_norm'] = (
            tribe_metrics[col].rank(pct=True) * 20
        )

    tribe_metrics['disparity_index'] = (
        tribe_metrics['diabetes_rate_norm'] +
        tribe_metrics['hypertension_rate_norm'] +
        tribe_metrics['depression_rate_norm'] +
        tribe_metrics['avg_comorbidities_norm'] +
        tribe_metrics['ed_rate_norm']
    ).round(1)

    tribe_metrics = tribe_metrics.sort_values('disparity_index', ascending=False)

    fig, ax = plt.subplots(figsize=(12, 6))
    colors = ['red' if s > 60 else 'orange' if s > 40 else 'green' for s in tribe_metrics['disparity_index']]
    ax.barh(tribe_metrics['tribal_affiliation'], tribe_metrics['disparity_index'], color=colors)
    ax.set_title('Health Disparity Index by Tribe', fontweight='bold')
    ax.set_xlabel('Disparity Index (0-100, higher = greater disparity)')
    ax.axvline(x=60, color='red', linestyle='--', alpha=0.5, label='High')
    ax.axvline(x=40, color='orange', linestyle='--', alpha=0.5, label='Moderate')
    ax.legend()
    ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('/tmp/health_disparity.png', dpi=300, bbox_inches='tight')
    plt.show()

    return tribe_metrics

disparity_scores = compute_disparity_index(df_ml)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results

# COMMAND ----------

disparity_spark = spark.createDataFrame(disparity_scores[
    ['tribal_affiliation', 'n_patients', 'diabetes_rate', 'hypertension_rate',
     'depression_rate', 'avg_encounters', 'avg_comorbidities', 'ed_rate', 'disparity_index']
])
disparity_spark = disparity_spark.withColumn("analysis_date", current_date())

(disparity_spark.write
 .mode("overwrite")
 .option("mergeSchema", "true")
 .saveAsTable("gold.gld_health_disparity_index"))

print("Saved to gold.gld_health_disparity_index")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print("=" * 65)
print("CHRONIC DISEASE PREDICTION - SUMMARY")
print("=" * 65)
best = max(diabetes_results.keys(), key=lambda k: diabetes_results[k]['auc'])
print(f"\nBest diabetes model: {best}")
print(f"  AUC: {diabetes_results[best]['auc']:.3f}")
print(f"  F1: {diabetes_results[best]['f1']:.3f}")
print(f"\nAll data is SYNTHETIC")
print(f"Output: gold.gld_health_disparity_index")
print(f"MLflow: /TribalHealth/chronic_disease_prediction")
print("=" * 65)
