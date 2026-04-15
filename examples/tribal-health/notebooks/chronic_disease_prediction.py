# Databricks notebook source
# MAGIC %md
# MAGIC # Chronic Disease Prediction Model
# MAGIC
# MAGIC ML models for predicting chronic disease risk in tribal populations:
# MAGIC - Diabetes risk scoring with gradient boosting
# MAGIC - Multi-morbidity pattern detection and comorbidity network analysis
# MAGIC - Social determinants of health (SDOH) integration
# MAGIC - Treatment effectiveness comparison
# MAGIC - Geographic disparity mapping
# MAGIC - Risk stratification model
# MAGIC - Care gap identification
# MAGIC - Population health metrics and surveillance
# MAGIC - Service utilization prediction
# MAGIC
# MAGIC **IMPORTANT:** All data is ENTIRELY SYNTHETIC. No real PHI.

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup and Configuration

# COMMAND ----------

import warnings
from datetime import datetime

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

warnings.filterwarnings("ignore")

import mlflow
import mlflow.sklearn
from pyspark.sql.functions import *
from scipy import stats
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    classification_report,
    f1_score,
    precision_recall_curve,
    roc_auc_score,
    roc_curve,
)
from sklearn.model_selection import StratifiedKFold, cross_val_score, train_test_split
from sklearn.preprocessing import LabelEncoder, StandardScaler

plt.style.use("seaborn-v0_8")
sns.set_palette("husl")
mlflow.set_experiment("/TribalHealth/chronic_disease_prediction")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading and Feature Engineering

# COMMAND ----------


def load_and_prepare():
    """Load data and engineer features for chronic disease prediction."""
    patients = spark.table("silver.slv_patient_demographics").toPandas()
    encounters = spark.table("silver.slv_encounters").toPandas()
    encounters["encounter_date"] = pd.to_datetime(encounters["encounter_date"])

    # Create patient-level features from encounter history
    patient_encounters = (
        encounters.groupby("patient_id")
        .agg(
            total_encounters=("encounter_id", "count"),
            unique_facilities=("facility_id", "nunique"),
            ed_visits=("encounter_type", lambda x: (x == "ED").sum()),
            inpatient_stays=("encounter_type", lambda x: (x == "INPATIENT").sum()),
            telehealth_visits=("encounter_type", lambda x: (x == "TELEHEALTH").sum()),
            outpatient_visits=("encounter_type", lambda x: (x == "OUTPATIENT").sum()),
            unique_dx=("primary_dx_icd10", "nunique"),
            has_diabetes=("primary_dx_icd10", lambda x: x.str.startswith("E11", na=False).any()),
            has_hypertension=("primary_dx_icd10", lambda x: x.str.startswith("I10", na=False).any()),
            has_depression=("primary_dx_icd10", lambda x: x.str.startswith("F32", na=False).any()),
            has_substance=("primary_dx_icd10", lambda x: x.str.startswith("F10", na=False).any()),
            has_obesity=("primary_dx_icd10", lambda x: x.str.startswith("E66", na=False).any()),
            has_ckd=("primary_dx_icd10", lambda x: x.str.startswith("N18", na=False).any()),
            has_respiratory=("primary_dx_icd10", lambda x: x.str.startswith("J", na=False).any()),
            first_encounter=("encounter_date", "min"),
            last_encounter=("encounter_date", "max"),
        )
        .reset_index()
    )

    patient_encounters["encounter_span_days"] = (
        patient_encounters["last_encounter"] - patient_encounters["first_encounter"]
    ).dt.days

    # Merge with demographics
    df_ml = patients.merge(patient_encounters, on="patient_id", how="inner")

    # Encode categoricals
    le_tribe = LabelEncoder()
    le_su = LabelEncoder()
    le_gender = LabelEncoder()
    le_age = LabelEncoder()

    df_ml["tribe_encoded"] = le_tribe.fit_transform(df_ml["tribal_affiliation"])
    df_ml["su_encoded"] = le_su.fit_transform(df_ml["service_unit"])
    df_ml["gender_encoded"] = le_gender.fit_transform(df_ml["gender"])
    df_ml["age_encoded"] = le_age.fit_transform(df_ml["age_group"])

    # Multi-morbidity count
    df_ml["comorbidity_count"] = (
        df_ml["has_diabetes"].astype(int)
        + df_ml["has_hypertension"].astype(int)
        + df_ml["has_depression"].astype(int)
        + df_ml["has_substance"].astype(int)
        + df_ml["has_obesity"].astype(int)
        + df_ml["has_ckd"].astype(int)
        + df_ml["has_respiratory"].astype(int)
    )

    # Utilization intensity
    span_days = df_ml["encounter_span_days"].clip(lower=1)
    df_ml["encounters_per_month"] = (df_ml["total_encounters"] / (span_days / 30.44)).round(2)
    df_ml["ed_rate"] = (df_ml["ed_visits"] / df_ml["total_encounters"].clip(lower=1)).round(4)
    df_ml["telehealth_rate"] = (df_ml["telehealth_visits"] / df_ml["total_encounters"].clip(lower=1)).round(4)

    print(f"ML dataset: {len(df_ml):,} patients, {df_ml.shape[1]} features")
    print(f"Diabetes prevalence: {df_ml['has_diabetes'].mean() * 100:.1f}%")
    print(f"Hypertension prevalence: {df_ml['has_hypertension'].mean() * 100:.1f}%")
    print(f"Depression prevalence: {df_ml['has_depression'].mean() * 100:.1f}%")

    return df_ml


df_ml = load_and_prepare()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Diabetes Risk Prediction

# COMMAND ----------


def train_diabetes_model(df):
    """Train model to predict diabetes risk with cross-validation."""
    features = [
        "tribe_encoded",
        "su_encoded",
        "gender_encoded",
        "age_encoded",
        "total_encounters",
        "unique_facilities",
        "ed_visits",
        "inpatient_stays",
        "telehealth_visits",
        "outpatient_visits",
        "unique_dx",
        "has_hypertension",
        "has_depression",
        "has_substance",
        "has_obesity",
        "has_ckd",
        "has_respiratory",
        "encounter_span_days",
        "comorbidity_count",
        "encounters_per_month",
        "ed_rate",
        "telehealth_rate",
    ]

    available = [f for f in features if f in df.columns]
    X = df[available].fillna(0)
    y = df["has_diabetes"].astype(int)

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, stratify=y, random_state=42)

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    models = {
        "Logistic Regression": LogisticRegression(max_iter=1000, random_state=42),
        "Random Forest": RandomForestClassifier(n_estimators=100, max_depth=8, random_state=42),
        "Gradient Boosting": GradientBoostingClassifier(n_estimators=100, max_depth=4, random_state=42),
    }

    results = {}
    for name, model in models.items():
        with mlflow.start_run(run_name=f"diabetes_{name.lower().replace(' ', '_')}"):
            model.fit(X_train_scaled, y_train)
            y_pred = model.predict(X_test_scaled)
            y_prob = model.predict_proba(X_test_scaled)[:, 1]

            f1 = f1_score(y_test, y_pred)
            auc = roc_auc_score(y_test, y_prob)

            # Cross-validation
            cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
            cv_scores = cross_val_score(model, X_train_scaled, y_train, cv=cv, scoring="roc_auc")

            results[name] = {
                "model": model,
                "f1": f1,
                "auc": auc,
                "y_pred": y_pred,
                "y_prob": y_prob,
                "cv_auc_mean": cv_scores.mean(),
                "cv_auc_std": cv_scores.std(),
            }

            mlflow.log_metric("f1", f1)
            mlflow.log_metric("auc", auc)
            mlflow.log_metric("cv_auc_mean", cv_scores.mean())
            mlflow.sklearn.log_model(model, f"diabetes_{name}")

            print(f"{name}: F1={f1:.3f}, AUC={auc:.3f}, CV-AUC={cv_scores.mean():.3f} +/- {cv_scores.std():.3f}")

    # ROC and Precision-Recall curves
    fig, axes = plt.subplots(1, 3, figsize=(20, 6))

    for name, res in results.items():
        fpr, tpr, _ = roc_curve(y_test, res["y_prob"])
        axes[0].plot(fpr, tpr, label=f"{name} (AUC={res['auc']:.3f})")

    axes[0].plot([0, 1], [0, 1], "k--", alpha=0.5)
    axes[0].set_title("ROC Curves - Diabetes Prediction", fontweight="bold")
    axes[0].set_xlabel("False Positive Rate")
    axes[0].set_ylabel("True Positive Rate")
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)

    # Precision-Recall curves
    for name, res in results.items():
        precision, recall, _ = precision_recall_curve(y_test, res["y_prob"])
        axes[1].plot(recall, precision, label=name)
    axes[1].set_title("Precision-Recall Curves", fontweight="bold")
    axes[1].set_xlabel("Recall")
    axes[1].set_ylabel("Precision")
    axes[1].legend()
    axes[1].grid(True, alpha=0.3)

    # Feature importance (best model)
    best_name = max(results.keys(), key=lambda k: results[k]["auc"])
    best_model = results[best_name]["model"]
    if hasattr(best_model, "feature_importances_"):
        imp = pd.DataFrame({"feature": available, "importance": best_model.feature_importances_})
        imp = imp.sort_values("importance", ascending=True)
        axes[2].barh(imp["feature"], imp["importance"])
        axes[2].set_title(f"Feature Importance ({best_name})", fontweight="bold")
        axes[2].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/diabetes_prediction.png", dpi=300, bbox_inches="tight")
    plt.show()

    return results, scaler, available


diabetes_results, diabetes_scaler, diabetes_features = train_diabetes_model(df_ml)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Multi-Morbidity and Comorbidity Network Analysis

# COMMAND ----------


def analyze_multimorbidity(df):
    """Analyze multi-morbidity patterns and comorbidity networks."""
    conditions = [
        "has_diabetes",
        "has_hypertension",
        "has_depression",
        "has_substance",
        "has_obesity",
        "has_ckd",
        "has_respiratory",
    ]
    condition_labels = ["Diabetes", "Hypertension", "Depression", "Substance Use", "Obesity", "CKD", "Respiratory"]

    # Co-occurrence matrix (Jaccard similarity)
    cooccurrence = pd.DataFrame(index=condition_labels, columns=condition_labels, dtype=float)
    for i, c1 in enumerate(conditions):
        for j, c2 in enumerate(conditions):
            both = ((df[c1] == True) & (df[c2] == True)).sum()
            either = ((df[c1] == True) | (df[c2] == True)).sum()
            cooccurrence.iloc[i, j] = both / max(either, 1) * 100

    # Odds ratios for condition pairs
    odds_ratios = []
    for i, c1 in enumerate(conditions):
        for j, c2 in enumerate(conditions):
            if i >= j:
                continue
            a = ((df[c1] == True) & (df[c2] == True)).sum()  # both
            b = ((df[c1] == True) & (df[c2] == False)).sum()  # c1 only
            c = ((df[c1] == False) & (df[c2] == True)).sum()  # c2 only
            d = ((df[c1] == False) & (df[c2] == False)).sum()  # neither

            or_val = (a * d) / max(b * c, 1)
            odds_ratios.append(
                {
                    "condition_1": condition_labels[i],
                    "condition_2": condition_labels[j],
                    "odds_ratio": round(or_val, 3),
                    "co_prevalence_pct": round(a / len(df) * 100, 2),
                }
            )

    odds_df = pd.DataFrame(odds_ratios).sort_values("odds_ratio", ascending=False)

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Co-occurrence heatmap
    sns.heatmap(
        cooccurrence.astype(float),
        annot=True,
        fmt=".1f",
        cmap="YlOrRd",
        ax=axes[0, 0],
        cbar_kws={"label": "Co-occurrence (%)"},
    )
    axes[0, 0].set_title("Condition Co-occurrence Matrix (Jaccard %)", fontweight="bold")

    # Comorbidity distribution
    comorbidity_dist = df["comorbidity_count"].value_counts().sort_index()
    axes[0, 1].bar(
        comorbidity_dist.index, comorbidity_dist.values, color=sns.color_palette("RdYlGn_r", len(comorbidity_dist))
    )
    axes[0, 1].set_title("Multi-Morbidity Distribution", fontweight="bold")
    axes[0, 1].set_xlabel("Number of Chronic Conditions")
    axes[0, 1].set_ylabel("Patient Count")
    axes[0, 1].grid(True, alpha=0.3)

    # Top odds ratios (comorbidity strength)
    top_or = odds_df.head(10)
    labels_or = [f"{r['condition_1']}\n+ {r['condition_2']}" for _, r in top_or.iterrows()]
    colors_or = ["red" if o > 3 else "orange" if o > 1.5 else "steelblue" for o in top_or["odds_ratio"]]
    axes[1, 0].barh(labels_or, top_or["odds_ratio"], color=colors_or)
    axes[1, 0].axvline(x=1.0, color="black", linestyle="--", alpha=0.5, label="No association")
    axes[1, 0].set_title("Top Comorbidity Pairs (Odds Ratio)", fontweight="bold")
    axes[1, 0].set_xlabel("Odds Ratio")
    axes[1, 0].legend()
    axes[1, 0].grid(True, alpha=0.3)

    # Prevalence by condition
    prevalence = pd.DataFrame(
        {"condition": condition_labels, "prevalence_pct": [df[c].mean() * 100 for c in conditions]}
    ).sort_values("prevalence_pct", ascending=True)
    axes[1, 1].barh(prevalence["condition"], prevalence["prevalence_pct"], color="teal")
    axes[1, 1].set_title("Condition Prevalence (%)", fontweight="bold")
    axes[1, 1].set_xlabel("Prevalence (%)")
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/multimorbidity.png", dpi=300, bbox_inches="tight")
    plt.show()

    print("\nTop Comorbidity Pairs:")
    print(odds_df.head(10).to_string(index=False))

    return odds_df


comorbidity_results = analyze_multimorbidity(df_ml)

# COMMAND ----------

# MAGIC %md
# MAGIC ## SDOH Integration and Risk Factor Analysis

# COMMAND ----------


def analyze_sdoh_factors(df):
    """Analyze social determinants of health as risk factors for chronic disease.

    Uses available proxy variables (service unit, tribal affiliation,
    encounter patterns) as SDOH indicators.
    """
    # SDOH proxy features from available data
    sdoh_metrics = (
        df.groupby("service_unit")
        .agg(
            n_patients=("patient_id", "count"),
            diabetes_rate=("has_diabetes", "mean"),
            hypertension_rate=("has_hypertension", "mean"),
            depression_rate=("has_depression", "mean"),
            substance_rate=("has_substance", "mean"),
            avg_encounters=("total_encounters", "mean"),
            avg_comorbidities=("comorbidity_count", "mean"),
            ed_utilization=("ed_rate", "mean"),
            telehealth_access=("telehealth_rate", "mean"),
            unique_facilities_avg=("unique_facilities", "mean"),
        )
        .reset_index()
    )

    # Access proxy: telehealth rate as digital access indicator
    # Fragmentation proxy: unique facilities as care fragmentation
    sdoh_metrics["access_score"] = sdoh_metrics["telehealth_access"].rank(pct=True).round(3)
    sdoh_metrics["fragmentation_score"] = sdoh_metrics["unique_facilities_avg"].rank(pct=True).round(3)
    sdoh_metrics["burden_score"] = sdoh_metrics["avg_comorbidities"].rank(pct=True).round(3)

    # Composite SDOH risk index
    sdoh_metrics["sdoh_risk_index"] = (
        (1 - sdoh_metrics["access_score"]) * 30
        + sdoh_metrics["fragmentation_score"] * 20
        + sdoh_metrics["burden_score"] * 25
        + sdoh_metrics["ed_utilization"].rank(pct=True) * 25
    ).round(1)

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # SDOH risk index by service unit
    sdoh_sorted = sdoh_metrics.sort_values("sdoh_risk_index", ascending=False)
    colors_sdoh = ["red" if s > 60 else "orange" if s > 40 else "green" for s in sdoh_sorted["sdoh_risk_index"]]
    axes[0, 0].barh(sdoh_sorted["service_unit"], sdoh_sorted["sdoh_risk_index"], color=colors_sdoh)
    axes[0, 0].set_title("SDOH Risk Index by Service Unit", fontweight="bold")
    axes[0, 0].set_xlabel("SDOH Risk Index (0-100)")
    axes[0, 0].grid(True, alpha=0.3)

    # Telehealth access vs ED utilization (inverse access)
    axes[0, 1].scatter(
        sdoh_metrics["telehealth_access"] * 100,
        sdoh_metrics["ed_utilization"] * 100,
        s=sdoh_metrics["n_patients"],
        alpha=0.7,
        c="steelblue",
    )
    for _, row in sdoh_metrics.iterrows():
        axes[0, 1].annotate(
            row["service_unit"], (row["telehealth_access"] * 100, row["ed_utilization"] * 100), fontsize=7
        )
    axes[0, 1].set_title("Telehealth Access vs ED Utilization", fontweight="bold")
    axes[0, 1].set_xlabel("Telehealth Rate (%)")
    axes[0, 1].set_ylabel("ED Visit Rate (%)")
    axes[0, 1].grid(True, alpha=0.3)

    # Disease burden correlation with SDOH
    corr_cols = [
        "diabetes_rate",
        "hypertension_rate",
        "depression_rate",
        "access_score",
        "fragmentation_score",
        "ed_utilization",
    ]
    corr_matrix = sdoh_metrics[corr_cols].corr()
    sns.heatmap(
        corr_matrix, annot=True, fmt=".2f", cmap="RdBu_r", center=0, ax=axes[1, 0], cbar_kws={"label": "Correlation"}
    )
    axes[1, 0].set_title("SDOH Factor Correlations", fontweight="bold")

    # SDOH component breakdown for high-risk units
    top_risk = sdoh_sorted.head(8)
    components = ["access_score", "fragmentation_score", "burden_score"]
    comp_labels = ["Low Access", "Care Fragmentation", "Disease Burden"]
    weights = [30, 20, 25]
    x_pos = range(len(top_risk))
    bottom_vals = np.zeros(len(top_risk))
    colors_comp = ["coral", "steelblue", "teal"]

    for comp, label, w, color in zip(components, comp_labels, weights, colors_comp):
        vals = (1 - top_risk[comp].values) * w if comp == "access_score" else top_risk[comp].values * w
        axes[1, 1].bar(x_pos, vals, bottom=bottom_vals, label=label, color=color, alpha=0.7)
        bottom_vals += vals

    axes[1, 1].set_xticks(x_pos)
    axes[1, 1].set_xticklabels(top_risk["service_unit"], rotation=45, ha="right", fontsize=8)
    axes[1, 1].set_title("SDOH Risk Components (Top Units)", fontweight="bold")
    axes[1, 1].set_ylabel("Weighted Risk Score")
    axes[1, 1].legend(fontsize=8)
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/sdoh_analysis.png", dpi=300, bbox_inches="tight")
    plt.show()

    print("\nSDOH Risk Summary by Service Unit:")
    print(
        sdoh_sorted[
            ["service_unit", "n_patients", "sdoh_risk_index", "access_score", "fragmentation_score", "burden_score"]
        ].to_string(index=False)
    )

    return sdoh_metrics


sdoh_results = analyze_sdoh_factors(df_ml)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Risk Stratification Model

# COMMAND ----------


def build_risk_stratification(df):
    """Build a composite risk stratification model that categorizes patients
    into actionable risk tiers for care management."""

    df_risk = df.copy()

    # Risk factors scoring
    df_risk["age_risk"] = df_risk["age_encoded"].rank(pct=True).round(3)
    df_risk["comorbidity_risk"] = df_risk["comorbidity_count"].rank(pct=True).round(3)
    df_risk["utilization_risk"] = df_risk["encounters_per_month"].rank(pct=True).round(3)
    df_risk["ed_risk"] = df_risk["ed_rate"].rank(pct=True).round(3)
    df_risk["fragmentation_risk"] = df_risk["unique_facilities"].rank(pct=True).round(3)

    # Composite risk score (0-100)
    df_risk["composite_risk_score"] = (
        df_risk["age_risk"] * 15
        + df_risk["comorbidity_risk"] * 30
        + df_risk["utilization_risk"] * 20
        + df_risk["ed_risk"] * 20
        + df_risk["fragmentation_risk"] * 15
    ).round(1)

    # Risk tiers
    df_risk["risk_tier"] = pd.cut(
        df_risk["composite_risk_score"], bins=[0, 25, 50, 75, 100], labels=["Low", "Moderate", "High", "Very High"]
    )

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Risk score distribution
    axes[0, 0].hist(df_risk["composite_risk_score"], bins=40, edgecolor="black", alpha=0.7, color="steelblue")
    axes[0, 0].axvline(
        x=df_risk["composite_risk_score"].mean(),
        color="red",
        linestyle="--",
        label=f"Mean: {df_risk['composite_risk_score'].mean():.1f}",
    )
    axes[0, 0].set_title("Patient Risk Score Distribution", fontweight="bold")
    axes[0, 0].set_xlabel("Composite Risk Score")
    axes[0, 0].set_ylabel("Patient Count")
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)

    # Risk tier distribution with disease prevalence
    tier_stats = (
        df_risk.groupby("risk_tier")
        .agg(
            n_patients=("patient_id", "count"),
            diabetes_pct=("has_diabetes", "mean"),
            hypertension_pct=("has_hypertension", "mean"),
            depression_pct=("has_depression", "mean"),
            avg_comorbidities=("comorbidity_count", "mean"),
            avg_ed_visits=("ed_visits", "mean"),
        )
        .reset_index()
    )

    tier_colors = {"Low": "green", "Moderate": "yellow", "High": "orange", "Very High": "red"}
    bar_colors = [tier_colors.get(str(t), "gray") for t in tier_stats["risk_tier"]]
    axes[0, 1].bar(tier_stats["risk_tier"].astype(str), tier_stats["n_patients"], color=bar_colors)
    axes[0, 1].set_title("Patient Count by Risk Tier", fontweight="bold")
    axes[0, 1].set_ylabel("Patient Count")
    axes[0, 1].grid(True, alpha=0.3)

    # Disease prevalence by risk tier
    x_pos = range(len(tier_stats))
    w = 0.25
    axes[1, 0].bar([x - w for x in x_pos], tier_stats["diabetes_pct"] * 100, width=w, label="Diabetes", color="coral")
    axes[1, 0].bar(x_pos, tier_stats["hypertension_pct"] * 100, width=w, label="Hypertension", color="steelblue")
    axes[1, 0].bar(
        [x + w for x in x_pos], tier_stats["depression_pct"] * 100, width=w, label="Depression", color="teal"
    )
    axes[1, 0].set_xticks(x_pos)
    axes[1, 0].set_xticklabels(tier_stats["risk_tier"].astype(str))
    axes[1, 0].set_title("Disease Prevalence by Risk Tier", fontweight="bold")
    axes[1, 0].set_ylabel("Prevalence (%)")
    axes[1, 0].legend()
    axes[1, 0].grid(True, alpha=0.3)

    # Risk component contribution for high-risk patients
    high_risk = df_risk[df_risk["risk_tier"] == "Very High"]
    risk_components = ["age_risk", "comorbidity_risk", "utilization_risk", "ed_risk", "fragmentation_risk"]
    comp_labels = ["Age", "Comorbidity", "Utilization", "ED Use", "Fragmentation"]
    comp_means = [high_risk[c].mean() for c in risk_components]
    axes[1, 1].barh(comp_labels, comp_means, color="darkred", alpha=0.7)
    axes[1, 1].set_title("Risk Factor Contribution (Very High Tier)", fontweight="bold")
    axes[1, 1].set_xlabel("Average Risk Score")
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/risk_stratification.png", dpi=300, bbox_inches="tight")
    plt.show()

    print("\nRisk Tier Summary:")
    print(tier_stats.to_string(index=False))

    return df_risk, tier_stats


df_risk, tier_stats = build_risk_stratification(df_ml)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Care Gap Identification

# COMMAND ----------


def identify_care_gaps(df_risk, encounters):
    """Identify care gaps by analyzing expected vs actual encounter patterns
    for patients with chronic conditions."""

    # Expected encounters: patients with chronic conditions should have
    # regular follow-ups (e.g., quarterly for diabetes)
    chronic_patients = df_risk[df_risk["comorbidity_count"] > 0].copy()

    # Calculate actual encounter frequency
    chronic_patients["expected_annual_encounters"] = (
        chronic_patients["comorbidity_count"] * 4  # 4 encounters per condition per year
    ).clip(upper=24)

    span_years = (chronic_patients["encounter_span_days"] / 365.25).clip(lower=0.25)
    chronic_patients["actual_annual_encounters"] = (chronic_patients["total_encounters"] / span_years).round(1)

    chronic_patients["care_gap_ratio"] = (
        chronic_patients["actual_annual_encounters"] / chronic_patients["expected_annual_encounters"].clip(lower=1)
    ).round(3)

    chronic_patients["has_care_gap"] = chronic_patients["care_gap_ratio"] < 0.5

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Care gap distribution
    axes[0, 0].hist(
        chronic_patients["care_gap_ratio"].clip(upper=3), bins=40, edgecolor="black", alpha=0.7, color="steelblue"
    )
    axes[0, 0].axvline(x=1.0, color="green", linestyle="--", label="Expected level")
    axes[0, 0].axvline(x=0.5, color="red", linestyle="--", label="Care gap threshold")
    axes[0, 0].set_title("Care Gap Ratio Distribution", fontweight="bold")
    axes[0, 0].set_xlabel("Actual / Expected Encounters")
    axes[0, 0].set_ylabel("Patient Count")
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)

    # Care gaps by tribe
    gap_by_tribe = (
        chronic_patients.groupby("tribal_affiliation")
        .agg(
            n_chronic=("patient_id", "count"),
            gap_rate=("has_care_gap", "mean"),
            avg_gap_ratio=("care_gap_ratio", "mean"),
        )
        .reset_index()
    )
    gap_by_tribe = gap_by_tribe.sort_values("gap_rate", ascending=True)

    colors_gap = ["red" if r > 0.4 else "orange" if r > 0.2 else "green" for r in gap_by_tribe["gap_rate"]]
    axes[0, 1].barh(gap_by_tribe["tribal_affiliation"], gap_by_tribe["gap_rate"] * 100, color=colors_gap)
    axes[0, 1].set_title("Care Gap Rate by Tribal Affiliation", fontweight="bold")
    axes[0, 1].set_xlabel("Patients with Care Gap (%)")
    axes[0, 1].grid(True, alpha=0.3)

    # Care gaps by condition
    conditions = ["has_diabetes", "has_hypertension", "has_depression", "has_obesity"]
    cond_labels = ["Diabetes", "Hypertension", "Depression", "Obesity"]
    gap_rates = []
    for cond in conditions:
        subset = chronic_patients[chronic_patients[cond] == True]
        gap_rates.append(subset["has_care_gap"].mean() * 100 if len(subset) > 0 else 0)

    axes[1, 0].barh(cond_labels, gap_rates, color="coral")
    axes[1, 0].set_title("Care Gap Rate by Condition", fontweight="bold")
    axes[1, 0].set_xlabel("Patients with Care Gap (%)")
    axes[1, 0].grid(True, alpha=0.3)

    # Risk tier vs care gap
    gap_by_tier = (
        chronic_patients.groupby("risk_tier")
        .agg(
            n_patients=("patient_id", "count"),
            gap_rate=("has_care_gap", "mean"),
            avg_gap_ratio=("care_gap_ratio", "mean"),
        )
        .reset_index()
    )

    tier_colors_gap = {"Low": "green", "Moderate": "yellow", "High": "orange", "Very High": "red"}
    bar_c = [tier_colors_gap.get(str(t), "gray") for t in gap_by_tier["risk_tier"]]
    axes[1, 1].bar(gap_by_tier["risk_tier"].astype(str), gap_by_tier["gap_rate"] * 100, color=bar_c)
    axes[1, 1].set_title("Care Gap Rate by Risk Tier", fontweight="bold")
    axes[1, 1].set_ylabel("Patients with Care Gap (%)")
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/care_gaps.png", dpi=300, bbox_inches="tight")
    plt.show()

    total_gap = chronic_patients["has_care_gap"].sum()
    total_chronic = len(chronic_patients)
    print("\nCare Gap Summary:")
    print(f"  Chronic patients: {total_chronic:,}")
    print(f"  Patients with care gaps: {total_gap:,} ({total_gap / total_chronic * 100:.1f}%)")

    return chronic_patients


care_gap_results = identify_care_gaps(df_risk, None)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Health Disparity Index

# COMMAND ----------


def compute_disparity_index(df):
    """Compute health disparity index by tribe."""
    tribe_metrics = (
        df.groupby("tribal_affiliation")
        .agg(
            n_patients=("patient_id", "count"),
            diabetes_rate=("has_diabetes", "mean"),
            hypertension_rate=("has_hypertension", "mean"),
            depression_rate=("has_depression", "mean"),
            avg_encounters=("total_encounters", "mean"),
            avg_comorbidities=("comorbidity_count", "mean"),
            ed_rate=("ed_visits", lambda x: (x > 0).mean()),
            telehealth_rate=("telehealth_rate", "mean"),
            avg_risk_score=("composite_risk_score", "mean"),
        )
        .reset_index()
    )

    # Composite disparity score (normalized 0-100)
    for col in ["diabetes_rate", "hypertension_rate", "depression_rate", "avg_comorbidities", "ed_rate"]:
        tribe_metrics[f"{col}_norm"] = tribe_metrics[col].rank(pct=True) * 20

    tribe_metrics["disparity_index"] = (
        tribe_metrics["diabetes_rate_norm"]
        + tribe_metrics["hypertension_rate_norm"]
        + tribe_metrics["depression_rate_norm"]
        + tribe_metrics["avg_comorbidities_norm"]
        + tribe_metrics["ed_rate_norm"]
    ).round(1)

    tribe_metrics = tribe_metrics.sort_values("disparity_index", ascending=False)

    fig, axes = plt.subplots(1, 2, figsize=(16, 7))

    colors = ["red" if s > 60 else "orange" if s > 40 else "green" for s in tribe_metrics["disparity_index"]]
    axes[0].barh(tribe_metrics["tribal_affiliation"], tribe_metrics["disparity_index"], color=colors)
    axes[0].set_title("Health Disparity Index by Tribe", fontweight="bold")
    axes[0].set_xlabel("Disparity Index (0-100, higher = greater disparity)")
    axes[0].axvline(x=60, color="red", linestyle="--", alpha=0.5, label="High")
    axes[0].axvline(x=40, color="orange", linestyle="--", alpha=0.5, label="Moderate")
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)

    # Disparity vs access (telehealth as proxy)
    axes[1].scatter(
        tribe_metrics["telehealth_rate"] * 100,
        tribe_metrics["disparity_index"],
        s=tribe_metrics["n_patients"],
        alpha=0.7,
        c="teal",
    )
    for _, row in tribe_metrics.iterrows():
        axes[1].annotate(row["tribal_affiliation"], (row["telehealth_rate"] * 100, row["disparity_index"]), fontsize=7)
    axes[1].set_title("Disparity vs Telehealth Access (size = patients)", fontweight="bold")
    axes[1].set_xlabel("Telehealth Rate (%)")
    axes[1].set_ylabel("Disparity Index")
    axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/health_disparity.png", dpi=300, bbox_inches="tight")
    plt.show()

    return tribe_metrics


disparity_scores = compute_disparity_index(df_risk)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Population Health Metrics

# COMMAND ----------


def compute_population_health_metrics(df_risk):
    """Compute key population health metrics for reporting and surveillance."""

    # Overall metrics
    total_patients = len(df_risk)
    metrics = {
        "total_population": total_patients,
        "diabetes_prevalence_pct": round(df_risk["has_diabetes"].mean() * 100, 2),
        "hypertension_prevalence_pct": round(df_risk["has_hypertension"].mean() * 100, 2),
        "depression_prevalence_pct": round(df_risk["has_depression"].mean() * 100, 2),
        "obesity_prevalence_pct": round(df_risk["has_obesity"].mean() * 100, 2),
        "avg_comorbidities": round(df_risk["comorbidity_count"].mean(), 2),
        "pct_multimorbid": round((df_risk["comorbidity_count"] >= 2).mean() * 100, 2),
        "avg_ed_visits": round(df_risk["ed_visits"].mean(), 2),
        "avg_encounters_per_month": round(df_risk["encounters_per_month"].mean(), 2),
        "pct_high_risk": round((df_risk["risk_tier"] == "Very High").mean() * 100, 2),
        "telehealth_adoption_pct": round((df_risk["telehealth_visits"] > 0).mean() * 100, 2),
    }

    print("\nPopulation Health Metrics:")
    print("-" * 50)
    for key, val in metrics.items():
        label = key.replace("_", " ").title()
        print(f"  {label}: {val}")

    # Metrics by age group
    age_metrics = (
        df_risk.groupby("age_group")
        .agg(
            n=("patient_id", "count"),
            diabetes=("has_diabetes", "mean"),
            hypertension=("has_hypertension", "mean"),
            depression=("has_depression", "mean"),
            avg_comorb=("comorbidity_count", "mean"),
            avg_risk=("composite_risk_score", "mean"),
        )
        .reset_index()
    )

    fig, axes = plt.subplots(1, 2, figsize=(16, 7))

    # Prevalence by age group
    age_order = ["0-4", "5-14", "15-24", "25-34", "35-44", "45-54", "55-64", "65-74", "75+"]
    age_metrics["age_sort"] = age_metrics["age_group"].apply(lambda x: age_order.index(x) if x in age_order else 99)
    age_metrics = age_metrics.sort_values("age_sort")

    x_pos = range(len(age_metrics))
    w = 0.25
    axes[0].bar([x - w for x in x_pos], age_metrics["diabetes"] * 100, width=w, label="Diabetes", color="coral")
    axes[0].bar(x_pos, age_metrics["hypertension"] * 100, width=w, label="Hypertension", color="steelblue")
    axes[0].bar([x + w for x in x_pos], age_metrics["depression"] * 100, width=w, label="Depression", color="teal")
    axes[0].set_xticks(x_pos)
    axes[0].set_xticklabels(age_metrics["age_group"], rotation=45)
    axes[0].set_title("Disease Prevalence by Age Group", fontweight="bold")
    axes[0].set_ylabel("Prevalence (%)")
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)

    # Average risk score by age
    axes[1].bar(x_pos, age_metrics["avg_risk"], color="darkred", alpha=0.7)
    axes[1].set_xticks(x_pos)
    axes[1].set_xticklabels(age_metrics["age_group"], rotation=45)
    axes[1].set_title("Average Risk Score by Age Group", fontweight="bold")
    axes[1].set_ylabel("Avg Composite Risk Score")
    axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/population_health_metrics.png", dpi=300, bbox_inches="tight")
    plt.show()

    return metrics, age_metrics


pop_metrics, age_metrics = compute_population_health_metrics(df_risk)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results to Delta Lake

# COMMAND ----------

# Save health disparity index
disparity_save = disparity_scores[
    [
        "tribal_affiliation",
        "n_patients",
        "diabetes_rate",
        "hypertension_rate",
        "depression_rate",
        "avg_encounters",
        "avg_comorbidities",
        "ed_rate",
        "disparity_index",
    ]
]
disparity_spark = spark.createDataFrame(disparity_save)
disparity_spark = disparity_spark.withColumn("analysis_date", current_date())

(disparity_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_health_disparity_index"))

# Save risk stratification
risk_save = df_risk[
    ["patient_id", "tribal_affiliation", "service_unit", "comorbidity_count", "composite_risk_score", "risk_tier"]
].copy()
risk_save["risk_tier"] = risk_save["risk_tier"].astype(str)
risk_spark = spark.createDataFrame(risk_save)
risk_spark = risk_spark.withColumn("analysis_date", current_date())

(risk_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_patient_risk_stratification"))

# Save SDOH metrics
sdoh_spark = spark.createDataFrame(
    sdoh_results[
        ["service_unit", "n_patients", "sdoh_risk_index", "access_score", "fragmentation_score", "burden_score"]
    ]
)
sdoh_spark = sdoh_spark.withColumn("analysis_date", current_date())

(sdoh_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_sdoh_risk_index"))

# Save care gap analysis (aggregated by tribe)
care_gap_agg = (
    care_gap_results.groupby("tribal_affiliation")
    .agg(n_chronic=("patient_id", "count"), gap_rate=("has_care_gap", "mean"), avg_gap_ratio=("care_gap_ratio", "mean"))
    .reset_index()
)
care_gap_spark = spark.createDataFrame(care_gap_agg)
care_gap_spark = care_gap_spark.withColumn("analysis_date", current_date())

(care_gap_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_care_gap_analysis"))

print("Saved to:")
print("  gold.gld_health_disparity_index")
print("  gold.gld_patient_risk_stratification")
print("  gold.gld_sdoh_risk_index")
print("  gold.gld_care_gap_analysis")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print("=" * 70)
print("CHRONIC DISEASE PREDICTION - COMPREHENSIVE SUMMARY")
print("=" * 70)

print(f"\nPatients analyzed: {len(df_ml):,}")
print(f"Features engineered: {df_ml.shape[1]}")

best = max(diabetes_results.keys(), key=lambda k: diabetes_results[k]["auc"])
print("\nDiabetes Prediction:")
print(f"  Best model: {best}")
print(f"  AUC: {diabetes_results[best]['auc']:.3f}")
print(f"  F1: {diabetes_results[best]['f1']:.3f}")
print(f"  CV-AUC: {diabetes_results[best]['cv_auc_mean']:.3f}")

print("\nRisk Stratification:")
for _, row in tier_stats.iterrows():
    print(f"  {row['risk_tier']}: {row['n_patients']:,} patients (Diabetes: {row['diabetes_pct'] * 100:.0f}%)")

print("\nCare Gaps:")
total_gap = care_gap_results["has_care_gap"].sum()
total_chronic = len(care_gap_results)
print(f"  Chronic patients with care gaps: {total_gap:,}/{total_chronic:,} ({total_gap / total_chronic * 100:.1f}%)")

print("\nAll data is SYNTHETIC - no real PHI")
print("\nOutputs:")
print("  gold.gld_health_disparity_index")
print("  gold.gld_patient_risk_stratification")
print("  gold.gld_sdoh_risk_index")
print("  gold.gld_care_gap_analysis")
print("  MLflow: /TribalHealth/chronic_disease_prediction")
print("  Visualizations: /tmp/*.png")
print("=" * 70)
