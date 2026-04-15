# Databricks notebook source
# MAGIC %md
# MAGIC # Highway Safety Prediction Model
# MAGIC
# MAGIC This notebook builds predictive models for traffic crash severity using FARS data, including:
# MAGIC - Feature engineering from crash, highway, and transit data
# MAGIC - Multi-model training (Linear, Ridge, Random Forest, Gradient Boosted Trees)
# MAGIC - Cross-validation and hyperparameter evaluation
# MAGIC - MLflow experiment tracking and model registry
# MAGIC - Feature importance and SHAP-based interpretability
# MAGIC - Fatality risk scoring for highway segments
# MAGIC
# MAGIC **Data Sources:**
# MAGIC - NHTSA FARS crash data (silver layer)
# MAGIC - FHWA National Bridge Inventory / Highway conditions (silver layer)
# MAGIC - NTD transit performance (silver layer)

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

warnings.filterwarnings("ignore")

# Statistical and ML libraries
import mlflow
import mlflow.sklearn

# Spark and Delta libraries
from pyspark.sql.functions import *
from pyspark.sql.types import *
from sklearn.ensemble import (
    GradientBoostingClassifier,
    GradientBoostingRegressor,
    RandomForestClassifier,
    RandomForestRegressor,
)
from sklearn.linear_model import LinearRegression, LogisticRegression, Ridge
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
from sklearn.model_selection import cross_val_score
from sklearn.preprocessing import StandardScaler

# Configuration
plt.style.use("seaborn-v0_8")
sns.set_palette("husl")
FIGURE_DPI = 300

# MLflow setup
mlflow.set_experiment("/DOT/highway_safety_prediction")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading and Preparation

# COMMAND ----------


# Load crash data from silver layer
def load_crash_data():
    """Load fatal crash data from silver layer Delta tables."""

    crash_df = spark.table("silver.slv_crash_data").toPandas()

    # Filter for valid records
    crash_df = crash_df[
        (crash_df["crash_year"].between(2015, datetime.now().year))
        & (crash_df["fatality_count"].notna())
        & (crash_df["state_code"].notna())
        & (crash_df["is_valid_record"] == True)
    ].copy()

    print(f"Loaded {len(crash_df):,} crash records")
    print(f"States: {crash_df['state_fips'].nunique()}")
    print(f"Years: {crash_df['crash_year'].min()} - {crash_df['crash_year'].max()}")

    return crash_df


df_crashes = load_crash_data()

# COMMAND ----------


# Load highway condition data
def load_highway_data():
    """Load highway/bridge condition data from silver layer."""

    highway_df = spark.table("silver.slv_highway_conditions").toPandas()

    highway_df = highway_df[
        (highway_df["inspection_year"].notna())
        & (highway_df["sufficiency_rating"].notna())
        & (highway_df["is_valid_record"] == True)
    ].copy()

    print(f"Loaded {len(highway_df):,} highway condition records")
    return highway_df


df_highway = load_highway_data()

# COMMAND ----------


# Prepare combined dataset
def prepare_modeling_data(crashes, highway):
    """Combine and prepare data for modeling."""

    df = crashes.copy()

    # --- Target variable ---
    # Binary classification: severe crash (2+ fatalities) vs single fatality
    df["is_severe"] = (df["fatality_count"] >= 2).astype(int)

    # Regression target: fatality count
    df["log_fatalities"] = np.log1p(df["fatality_count"])

    # --- Feature engineering ---

    # Time features
    df["crash_hour_sin"] = np.sin(2 * np.pi * df["crash_hour"] / 24)
    df["crash_hour_cos"] = np.cos(2 * np.pi * df["crash_hour"] / 24)
    df["crash_month_sin"] = np.sin(2 * np.pi * df["crash_month"] / 12)
    df["crash_month_cos"] = np.cos(2 * np.pi * df["crash_month"] / 12)
    df["is_weekend"] = df["day_of_week"].isin([1, 7]).astype(int)
    df["is_night"] = ((df["crash_hour"] >= 21) | (df["crash_hour"] <= 5)).astype(int)

    # Holiday flag (major US holidays approximate)
    holiday_months_days = [(1, 1), (7, 4), (12, 25), (11, 24), (11, 25), (9, 1)]
    df["is_holiday_period"] = df.apply(
        lambda r: int(any(r["crash_month"] == m and abs(r["crash_day"] - d) <= 2 for m, d in holiday_months_days)),
        axis=1,
    )

    # Speed risk
    df["high_speed"] = (df["posted_speed_limit"] >= 55).astype(int)
    df["speed_limit_sq"] = df["posted_speed_limit"] ** 2

    # DUI flag
    df["has_dui"] = (df["drunk_driver_count"] > 0).astype(int)

    # Pedestrian flag
    df["has_pedestrian"] = (df["pedestrians_involved"] > 0).astype(int)

    # Vehicle counts
    df["multi_vehicle"] = (df["total_vehicles"] >= 2).astype(int)
    df["vehicles_capped"] = df["total_vehicles"].clip(upper=10)

    # Rural/Urban
    df["is_rural"] = (df["rural_urban_code"] == 1).astype(int)

    # Weather encoding
    weather_risk = {1: 0, 10: 0, 2: 1, 6: 1, 3: 2, 4: 2, 5: 2, 12: 2, 11: 2, 7: 1}
    df["weather_risk"] = df["weather_condition_code"].map(weather_risk).fillna(1)

    # Light condition encoding
    light_risk = {1: 0, 4: 1, 5: 1, 3: 1, 2: 2, 6: 2}
    df["light_risk"] = df["light_condition_code"].map(light_risk).fillna(1)

    # Road function class risk
    func_risk = {1: 3, 2: 2, 3: 2, 4: 1, 5: 1, 6: 0, 7: 0}
    df["functional_class_risk"] = df["functional_system_code"].map(func_risk).fillna(1)

    # Manner of collision encoding
    collision_severity = {0: 0, 1: 1, 2: 3, 5: 2, 6: 1, 7: 2, 8: 1, 9: 1}
    df["collision_severity_score"] = df["manner_of_collision_code"].map(collision_severity).fillna(1)

    # State-level aggregated features (lag features based on prior year)
    state_prior = (
        df.groupby(["state_fips", "crash_year"])
        .agg(
            state_crash_count=("case_id", "count"),
            state_avg_fatalities=("fatality_count", "mean"),
            state_dui_rate=("has_dui", "mean"),
        )
        .reset_index()
    )
    state_prior["crash_year"] = state_prior["crash_year"] + 1  # Shift to create lag
    state_prior.columns = [
        "state_fips",
        "crash_year",
        "prior_state_crashes",
        "prior_state_avg_fatals",
        "prior_state_dui_rate",
    ]

    df = df.merge(state_prior, on=["state_fips", "crash_year"], how="left")
    df["prior_state_crashes"] = df["prior_state_crashes"].fillna(df["prior_state_crashes"].median())
    df["prior_state_avg_fatals"] = df["prior_state_avg_fatals"].fillna(df["prior_state_avg_fatals"].median())
    df["prior_state_dui_rate"] = df["prior_state_dui_rate"].fillna(df["prior_state_dui_rate"].median())

    # Aggregate highway condition by state for merge
    if len(highway) > 0:
        hwy_state = (
            highway.groupby("state_code")
            .agg(
                avg_sufficiency=("sufficiency_rating", "mean"),
                avg_deck_cond=("deck_condition_rating", "mean"),
                pct_deficient=("is_structurally_deficient", "mean"),
            )
            .reset_index()
        )
        hwy_state.columns = ["state_fips", "state_avg_sufficiency", "state_avg_deck_cond", "state_pct_deficient"]
        df = df.merge(hwy_state, on="state_fips", how="left")
        for col in ["state_avg_sufficiency", "state_avg_deck_cond", "state_pct_deficient"]:
            df[col] = df[col].fillna(df[col].median())

    # Drop rows with NaN in critical features
    df = df.dropna(subset=["posted_speed_limit", "total_vehicles", "crash_hour"])

    print(f"Prepared {len(df):,} records with {df.shape[1]} features")
    print(f"Severe crashes (2+ fatalities): {df['is_severe'].sum():,} ({df['is_severe'].mean() * 100:.1f}%)")

    return df


df_model = prepare_modeling_data(df_crashes, df_highway)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Exploratory Feature Analysis

# COMMAND ----------


# Feature correlation heatmap
def plot_feature_correlations():
    """Visualize correlations between engineered features and target."""

    numeric_features = [
        "fatality_count",
        "is_severe",
        "posted_speed_limit",
        "total_vehicles",
        "crash_hour",
        "is_weekend",
        "is_night",
        "has_dui",
        "has_pedestrian",
        "is_rural",
        "weather_risk",
        "light_risk",
        "collision_severity_score",
        "high_speed",
        "multi_vehicle",
        "prior_state_avg_fatals",
    ]

    available = [f for f in numeric_features if f in df_model.columns]
    corr_matrix = df_model[available].corr()

    plt.figure(figsize=(14, 11))
    mask = np.triu(np.ones_like(corr_matrix, dtype=bool))
    sns.heatmap(
        corr_matrix,
        mask=mask,
        annot=True,
        cmap="RdBu_r",
        center=0,
        fmt=".2f",
        square=True,
        cbar_kws={"label": "Pearson Correlation"},
    )
    plt.title("Feature Correlation Matrix", fontsize=16, fontweight="bold")
    plt.tight_layout()
    plt.savefig("/tmp/dot_feature_correlations.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()


plot_feature_correlations()

# COMMAND ----------


# Feature distributions by severity class
def plot_feature_distributions():
    """Compare feature distributions between severe and non-severe crashes."""

    fig, axes = plt.subplots(2, 3, figsize=(18, 10))

    features = [
        ("posted_speed_limit", "Posted Speed Limit (mph)"),
        ("total_vehicles", "Vehicle Count"),
        ("crash_hour", "Hour of Day"),
        ("weather_risk", "Weather Risk Score"),
        ("light_risk", "Light Risk Score"),
        ("collision_severity_score", "Collision Severity Score"),
    ]

    for i, (feat, label) in enumerate(features):
        ax = axes[i // 3, i % 3]
        for severity, color, lbl in [(0, "#3498db", "Non-Severe"), (1, "#e74c3c", "Severe")]:
            subset = df_model[df_model["is_severe"] == severity][feat].dropna()
            ax.hist(subset, bins=25, alpha=0.5, color=color, label=lbl, density=True)
        ax.set_title(label, fontsize=12, fontweight="bold")
        ax.set_xlabel(label)
        ax.set_ylabel("Density")
        ax.legend()
        ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/dot_feature_distributions.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()


plot_feature_distributions()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Model Training - Severity Classification

# COMMAND ----------


# Prepare feature matrix
def build_feature_matrix(df):
    """Build feature matrix for model training."""

    feature_cols = [
        "posted_speed_limit",
        "speed_limit_sq",
        "vehicles_capped",
        "multi_vehicle",
        "crash_hour_sin",
        "crash_hour_cos",
        "crash_month_sin",
        "crash_month_cos",
        "is_weekend",
        "is_night",
        "is_holiday_period",
        "has_dui",
        "has_pedestrian",
        "is_rural",
        "high_speed",
        "weather_risk",
        "light_risk",
        "functional_class_risk",
        "collision_severity_score",
        "prior_state_crashes",
        "prior_state_avg_fatals",
        "prior_state_dui_rate",
    ]

    # Add highway features if available
    hwy_cols = ["state_avg_sufficiency", "state_avg_deck_cond", "state_pct_deficient"]
    for col in hwy_cols:
        if col in df.columns:
            feature_cols.append(col)

    available_cols = [c for c in feature_cols if c in df.columns]

    X = df[available_cols].copy()
    y_class = df["is_severe"].copy()
    y_reg = df["fatality_count"].copy()

    # Drop any remaining NaN rows
    mask = X.notna().all(axis=1)
    X = X[mask]
    y_class = y_class[mask]
    y_reg = y_reg[mask]

    print(f"Feature matrix: {X.shape[0]:,} samples, {X.shape[1]} features")
    print(f"Features: {', '.join(available_cols)}")

    return X, y_class, y_reg, available_cols


X, y_class, y_reg, feature_names = build_feature_matrix(df_model)

# COMMAND ----------


# Train classification models
def train_classification_models(X, y):
    """Train multiple classification models for crash severity prediction."""

    # Temporal split: last year as test
    years = df_model.loc[X.index, "crash_year"]
    test_year = years.max()
    train_mask = years < test_year

    X_train, X_test = X[train_mask], X[~train_mask]
    y_train, y_test = y[train_mask], y[~train_mask]

    print(f"Training set: {len(X_train):,} samples ({y_train.mean() * 100:.1f}% severe)")
    print(f"Test set: {len(X_test):,} samples ({y_test.mean() * 100:.1f}% severe)")

    # Scale features
    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    # Define models
    models = {
        "Logistic Regression": LogisticRegression(max_iter=1000, random_state=42),
        "Random Forest": RandomForestClassifier(n_estimators=200, max_depth=12, min_samples_leaf=20, random_state=42),
        "Gradient Boosting": GradientBoostingClassifier(
            n_estimators=200, max_depth=6, learning_rate=0.1, random_state=42
        ),
    }

    results = {}

    for name, model in models.items():
        print(f"\nTraining {name}...")

        with mlflow.start_run(run_name=f"severity_{name.lower().replace(' ', '_')}"):
            # Train
            if name == "Logistic Regression":
                model.fit(X_train_scaled, y_train)
                y_pred = model.predict(X_test_scaled)
                y_prob = model.predict_proba(X_test_scaled)[:, 1]
                y_pred_train = model.predict(X_train_scaled)
            else:
                model.fit(X_train, y_train)
                y_pred = model.predict(X_test)
                y_prob = model.predict_proba(X_test)[:, 1]
                y_pred_train = model.predict(X_train)

            # Metrics
            accuracy = accuracy_score(y_test, y_pred)
            precision = precision_score(y_test, y_pred, zero_division=0)
            recall = recall_score(y_test, y_pred, zero_division=0)
            f1 = f1_score(y_test, y_pred, zero_division=0)
            auc = roc_auc_score(y_test, y_prob)
            train_acc = accuracy_score(y_train, y_pred_train)

            # Cross-validation
            cv_data = X_train_scaled if name == "Logistic Regression" else X_train
            cv_scores = cross_val_score(model, cv_data, y_train, cv=5, scoring="f1")
            cv_f1 = cv_scores.mean()
            cv_std = cv_scores.std()

            results[name] = {
                "model": model,
                "accuracy": accuracy,
                "precision": precision,
                "recall": recall,
                "f1": f1,
                "auc": auc,
                "train_accuracy": train_acc,
                "cv_f1": cv_f1,
                "cv_std": cv_std,
                "y_prob": y_prob,
                "y_pred": y_pred,
            }

            # Log to MLflow
            mlflow.log_param("model_type", name)
            mlflow.log_param("train_size", len(X_train))
            mlflow.log_param("test_size", len(X_test))
            mlflow.log_param("n_features", X_train.shape[1])
            mlflow.log_metric("accuracy", accuracy)
            mlflow.log_metric("precision", precision)
            mlflow.log_metric("recall", recall)
            mlflow.log_metric("f1", f1)
            mlflow.log_metric("auc", auc)
            mlflow.log_metric("train_accuracy", train_acc)
            mlflow.log_metric("cv_f1", cv_f1)
            mlflow.sklearn.log_model(model, f"severity_{name.lower().replace(' ', '_')}")

            print(
                f"  Accuracy: {accuracy:.3f}  Precision: {precision:.3f}  "
                f"Recall: {recall:.3f}  F1: {f1:.3f}  AUC: {auc:.3f}"
            )
            print(f"  CV F1: {cv_f1:.3f} +/- {cv_std:.3f}")

    return results, X_test, y_test, scaler


clf_results, X_test, y_test, scaler = train_classification_models(X, y_class)

# COMMAND ----------


# Model comparison visualization
def compare_classification_models(results, y_test):
    """Compare classification model performance."""

    # Performance table
    perf_df = pd.DataFrame(
        {
            name: {
                "Accuracy": r["accuracy"],
                "Precision": r["precision"],
                "Recall": r["recall"],
                "F1": r["f1"],
                "AUC": r["auc"],
                "CV F1": r["cv_f1"],
            }
            for name, r in results.items()
        }
    ).round(3)
    print("Classification Model Comparison:")
    print(perf_df)

    fig, axes = plt.subplots(1, 3, figsize=(18, 5))

    # Bar chart of metrics
    ax1 = axes[0]
    metrics = ["Accuracy", "Precision", "Recall", "F1", "AUC"]
    x = np.arange(len(metrics))
    width = 0.25
    for i, (name, r) in enumerate(results.items()):
        vals = [r["accuracy"], r["precision"], r["recall"], r["f1"], r["auc"]]
        ax1.bar(x + i * width, vals, width, label=name, alpha=0.85)
    ax1.set_xticks(x + width)
    ax1.set_xticklabels(metrics, rotation=30, ha="right")
    ax1.set_ylabel("Score")
    ax1.set_title("Model Metrics Comparison", fontsize=14, fontweight="bold")
    ax1.legend(fontsize=8)
    ax1.set_ylim(0, 1.05)
    ax1.grid(True, alpha=0.3, axis="y")

    # ROC curves
    ax2 = axes[1]
    for name, r in results.items():
        fpr, tpr, _ = roc_curve(y_test, r["y_prob"])
        ax2.plot(fpr, tpr, linewidth=2, label=f"{name} (AUC={r['auc']:.3f})")
    ax2.plot([0, 1], [0, 1], "k--", alpha=0.5)
    ax2.set_xlabel("False Positive Rate")
    ax2.set_ylabel("True Positive Rate")
    ax2.set_title("ROC Curves", fontsize=14, fontweight="bold")
    ax2.legend(fontsize=8)
    ax2.grid(True, alpha=0.3)

    # Confusion matrix for best model
    ax3 = axes[2]
    best_name = max(results.keys(), key=lambda k: results[k]["f1"])
    cm = confusion_matrix(y_test, results[best_name]["y_pred"])
    sns.heatmap(
        cm,
        annot=True,
        fmt="d",
        cmap="Blues",
        ax=ax3,
        xticklabels=["Non-Severe", "Severe"],
        yticklabels=["Non-Severe", "Severe"],
    )
    ax3.set_title(f"Confusion Matrix ({best_name})", fontsize=14, fontweight="bold")
    ax3.set_xlabel("Predicted")
    ax3.set_ylabel("Actual")

    plt.tight_layout()
    plt.savefig("/tmp/dot_classification_comparison.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()

    return perf_df


clf_comparison = compare_classification_models(clf_results, y_test)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Model Training - Fatality Count Regression

# COMMAND ----------


# Train regression models
def train_regression_models(X, y):
    """Train regression models for fatality count prediction."""

    years = df_model.loc[X.index, "crash_year"]
    test_year = years.max()
    train_mask = years < test_year

    X_train, X_test = X[train_mask], X[~train_mask]
    y_train, y_test = y[train_mask], y[~train_mask]

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    models = {
        "Linear Regression": LinearRegression(),
        "Ridge Regression": Ridge(alpha=10.0),
        "Random Forest": RandomForestRegressor(n_estimators=200, max_depth=10, min_samples_leaf=20, random_state=42),
        "Gradient Boosting": GradientBoostingRegressor(
            n_estimators=200, max_depth=5, learning_rate=0.1, random_state=42
        ),
    }

    results = {}

    for name, model in models.items():
        print(f"\nTraining {name}...")

        with mlflow.start_run(run_name=f"fatality_reg_{name.lower().replace(' ', '_')}"):
            if name in ("Linear Regression", "Ridge Regression"):
                model.fit(X_train_scaled, y_train)
                y_pred_train = model.predict(X_train_scaled)
                y_pred_test = model.predict(X_test_scaled)
            else:
                model.fit(X_train, y_train)
                y_pred_train = model.predict(X_train)
                y_pred_test = model.predict(X_test)

            # Clip predictions to valid range
            y_pred_test = np.clip(y_pred_test, 0, None)

            train_mae = mean_absolute_error(y_train, y_pred_train)
            train_rmse = np.sqrt(mean_squared_error(y_train, y_pred_train))
            train_r2 = r2_score(y_train, y_pred_train)

            test_mae = mean_absolute_error(y_test, y_pred_test)
            test_rmse = np.sqrt(mean_squared_error(y_test, y_pred_test))
            test_r2 = r2_score(y_test, y_pred_test)

            cv_data = X_train_scaled if name in ("Linear Regression", "Ridge Regression") else X_train
            cv_scores = cross_val_score(model, cv_data, y_train, cv=5, scoring="neg_mean_absolute_error")
            cv_mae = -cv_scores.mean()
            cv_std = cv_scores.std()

            results[name] = {
                "model": model,
                "train_mae": train_mae,
                "train_rmse": train_rmse,
                "train_r2": train_r2,
                "test_mae": test_mae,
                "test_rmse": test_rmse,
                "test_r2": test_r2,
                "cv_mae": cv_mae,
                "cv_std": cv_std,
                "predictions": y_pred_test,
            }

            mlflow.log_param("model_type", name)
            mlflow.log_param("task", "fatality_regression")
            mlflow.log_metric("train_mae", train_mae)
            mlflow.log_metric("train_rmse", train_rmse)
            mlflow.log_metric("train_r2", train_r2)
            mlflow.log_metric("test_mae", test_mae)
            mlflow.log_metric("test_rmse", test_rmse)
            mlflow.log_metric("test_r2", test_r2)
            mlflow.log_metric("cv_mae", cv_mae)
            mlflow.sklearn.log_model(model, f"fatality_reg_{name.lower().replace(' ', '_')}")

            print(f"  Train MAE: {train_mae:.3f}  Test MAE: {test_mae:.3f}")
            print(f"  Train R2: {train_r2:.3f}   Test R2: {test_r2:.3f}")
            print(f"  CV MAE: {cv_mae:.3f} +/- {cv_std:.3f}")

    return results, X_test, y_test, scaler


reg_results, X_test_reg, y_test_reg, reg_scaler = train_regression_models(X, y_reg)

# COMMAND ----------


# Regression model comparison
def compare_regression_models(results, y_test):
    """Compare regression model performance."""

    comparison = pd.DataFrame(
        {
            name: {
                "Train MAE": r["train_mae"],
                "Test MAE": r["test_mae"],
                "Train R2": r["train_r2"],
                "Test R2": r["test_r2"],
                "CV MAE": r["cv_mae"],
            }
            for name, r in results.items()
        }
    ).round(3)
    print("\nRegression Model Comparison:")
    print(comparison)

    fig, axes = plt.subplots(2, 2, figsize=(14, 12))
    axes = axes.flatten()

    for i, (name, r) in enumerate(results.items()):
        if i >= 4:
            break
        ax = axes[i]
        ax.scatter(y_test, r["predictions"], alpha=0.4, s=20, color="steelblue")
        min_val = min(y_test.min(), r["predictions"].min())
        max_val = max(y_test.max(), r["predictions"].max())
        ax.plot([min_val, max_val], [min_val, max_val], "r--", alpha=0.8)
        ax.text(
            0.05,
            0.95,
            f"R2={r['test_r2']:.3f}\nMAE={r['test_mae']:.3f}",
            transform=ax.transAxes,
            va="top",
            bbox={"boxstyle": "round", "facecolor": "white", "alpha": 0.8},
        )
        ax.set_xlabel("Actual Fatalities")
        ax.set_ylabel("Predicted Fatalities")
        ax.set_title(name, fontweight="bold")
        ax.grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/dot_regression_comparison.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()

    return comparison


reg_comparison = compare_regression_models(reg_results, y_test_reg)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Feature Importance Analysis

# COMMAND ----------


# Feature importance from best model
def analyze_feature_importance(clf_results, feature_names):
    """Analyze and visualize feature importance."""

    # Use Gradient Boosting for importance (generally best for tabular data)
    best_name = (
        "Gradient Boosting"
        if "Gradient Boosting" in clf_results
        else max(clf_results.keys(), key=lambda k: clf_results[k]["f1"])
    )
    model = clf_results[best_name]["model"]

    if hasattr(model, "feature_importances_"):
        importance_df = pd.DataFrame({"feature": feature_names, "importance": model.feature_importances_}).sort_values(
            "importance", ascending=False
        )

        # Top 15 features
        top_features = importance_df.head(15)

        fig, axes = plt.subplots(1, 2, figsize=(16, 7))

        # Bar chart
        ax1 = axes[0]
        bars = ax1.barh(range(len(top_features)), top_features["importance"])
        ax1.set_yticks(range(len(top_features)))
        ax1.set_yticklabels(top_features["feature"])
        ax1.set_xlabel("Feature Importance")
        ax1.set_title(f"Top 15 Features ({best_name})", fontsize=14, fontweight="bold")
        ax1.invert_yaxis()
        for i, bar in enumerate(bars):
            if i < 3:
                bar.set_color("#c0392b")
            elif i < 8:
                bar.set_color("#e67e22")
            else:
                bar.set_color("#3498db")
        ax1.grid(True, alpha=0.3, axis="x")

        # Cumulative importance
        ax2 = axes[1]
        cumulative = importance_df["importance"].cumsum() / importance_df["importance"].sum() * 100
        ax2.plot(range(len(cumulative)), cumulative.values, marker="o", markersize=4)
        ax2.axhline(y=80, color="red", linestyle="--", alpha=0.5, label="80% threshold")
        n_80 = (cumulative <= 80).sum()
        ax2.axvline(x=n_80, color="red", linestyle="--", alpha=0.5)
        ax2.set_xlabel("Feature Rank")
        ax2.set_ylabel("Cumulative Importance (%)")
        ax2.set_title("Cumulative Feature Importance", fontsize=14, fontweight="bold")
        ax2.legend()
        ax2.grid(True, alpha=0.3)

        plt.tight_layout()
        plt.savefig("/tmp/dot_feature_importance.png", dpi=FIGURE_DPI, bbox_inches="tight")
        plt.show()

        return importance_df
    print(f"Model {best_name} does not support feature_importances_")
    return None


feature_importance = analyze_feature_importance(clf_results, feature_names)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Risk Scoring for Highway Segments

# COMMAND ----------


# Generate risk scores
def generate_risk_scores(clf_results, df_model, feature_names):
    """Generate crash severity risk scores for state-highway segment combinations."""

    best_name = max(clf_results.keys(), key=lambda k: clf_results[k]["auc"])
    model = clf_results[best_name]["model"]

    # Create state-level risk profiles
    state_features = df_model.groupby("state_fips")[feature_names].mean().reset_index()

    # Predict risk probability for each state
    if best_name == "Logistic Regression":
        scaler_temp = StandardScaler()
        X_scaled = scaler_temp.fit_transform(state_features[feature_names])
        risk_probs = model.predict_proba(X_scaled)[:, 1]
    else:
        risk_probs = model.predict_proba(state_features[feature_names].values)[:, 1]

    state_features["risk_score"] = risk_probs
    state_features["risk_category"] = pd.cut(
        risk_probs, bins=[0, 0.15, 0.25, 0.4, 1.0], labels=["Low", "Moderate", "High", "Critical"]
    )

    # Risk score distribution
    fig, axes = plt.subplots(1, 2, figsize=(14, 6))

    ax1 = axes[0]
    ax1.hist(state_features["risk_score"], bins=20, color="#e74c3c", alpha=0.8, edgecolor="black")
    ax1.set_title("Risk Score Distribution by State", fontsize=14, fontweight="bold")
    ax1.set_xlabel("Severity Risk Score")
    ax1.set_ylabel("Number of States")
    ax1.grid(True, alpha=0.3, axis="y")

    ax2 = axes[1]
    risk_counts = state_features["risk_category"].value_counts()
    colors = {"Low": "#27ae60", "Moderate": "#f1c40f", "High": "#e67e22", "Critical": "#e74c3c"}
    ax2.bar(
        risk_counts.index, risk_counts.values, color=[colors.get(c, "#95a5a6") for c in risk_counts.index], alpha=0.85
    )
    ax2.set_title("States by Risk Category", fontsize=14, fontweight="bold")
    ax2.set_xlabel("Risk Category")
    ax2.set_ylabel("Number of States")
    ax2.grid(True, alpha=0.3, axis="y")

    plt.tight_layout()
    plt.savefig("/tmp/dot_risk_scores.png", dpi=FIGURE_DPI, bbox_inches="tight")
    plt.show()

    # Top 10 highest risk states
    top_risk = state_features.nlargest(10, "risk_score")[["state_fips", "risk_score", "risk_category"]]
    print("\nTop 10 Highest Risk States:")
    print(top_risk.to_string(index=False))

    return state_features


risk_scores = generate_risk_scores(clf_results, df_model, feature_names)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results to Delta Lake

# COMMAND ----------


# Save model outputs to gold layer
def save_results_to_delta(clf_comparison, reg_comparison, risk_scores, feature_importance):
    """Save prediction results and model metrics to Delta Lake gold layer."""

    # Save classification metrics
    clf_metrics = clf_comparison.T.reset_index()
    clf_metrics.columns = ["model_name"] + list(clf_comparison.index)
    clf_metrics["task"] = "severity_classification"
    clf_metrics["evaluation_date"] = datetime.now()
    clf_spark = spark.createDataFrame(clf_metrics)
    (clf_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_highway_safety_clf_metrics"))

    # Save regression metrics
    reg_metrics = reg_comparison.T.reset_index()
    reg_metrics.columns = ["model_name"] + list(reg_comparison.index)
    reg_metrics["task"] = "fatality_regression"
    reg_metrics["evaluation_date"] = datetime.now()
    reg_spark = spark.createDataFrame(reg_metrics)
    (reg_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_highway_safety_reg_metrics"))

    # Save state risk scores
    risk_spark = spark.createDataFrame(risk_scores)
    risk_spark = risk_spark.withColumn("scoring_date", current_date())
    (risk_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_highway_risk_scores"))

    # Save feature importance
    if feature_importance is not None:
        fi_spark = spark.createDataFrame(feature_importance)
        fi_spark = fi_spark.withColumn("evaluation_date", current_date())
        (
            fi_spark.write.mode("overwrite")
            .option("mergeSchema", "true")
            .saveAsTable("gold.gld_highway_safety_feature_importance")
        )

    print("Results saved to gold layer:")
    print("  - gold.gld_highway_safety_clf_metrics")
    print("  - gold.gld_highway_safety_reg_metrics")
    print("  - gold.gld_highway_risk_scores")
    print("  - gold.gld_highway_safety_feature_importance")


save_results_to_delta(clf_comparison, reg_comparison, risk_scores, feature_importance)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary Report

# COMMAND ----------

print("=" * 60)
print("HIGHWAY SAFETY PREDICTION - SUMMARY REPORT")
print("=" * 60)

print("\nDataset Overview:")
print(f"  Total records: {len(df_model):,}")
print(f"  Features: {len(feature_names)}")
print(f"  Severe crashes (2+ fatalities): {df_model['is_severe'].sum():,} ({df_model['is_severe'].mean() * 100:.1f}%)")

print("\nClassification Performance (Severity Prediction):")
best_clf = max(clf_results.keys(), key=lambda k: clf_results[k]["f1"])
print(f"  Best model: {best_clf}")
print(f"  F1 Score: {clf_results[best_clf]['f1']:.3f}")
print(f"  AUC: {clf_results[best_clf]['auc']:.3f}")
print(f"  Precision: {clf_results[best_clf]['precision']:.3f}")
print(f"  Recall: {clf_results[best_clf]['recall']:.3f}")

print("\nRegression Performance (Fatality Count):")
best_reg = min(reg_results.keys(), key=lambda k: reg_results[k]["test_mae"])
print(f"  Best model: {best_reg}")
print(f"  Test MAE: {reg_results[best_reg]['test_mae']:.3f}")
print(f"  Test R2: {reg_results[best_reg]['test_r2']:.3f}")

print("\nTop Risk Factors:")
if feature_importance is not None:
    for _, row in feature_importance.head(5).iterrows():
        print(f"  - {row['feature']}: {row['importance']:.4f}")

print("\nRisk Scoring Summary:")
if "risk_category" in risk_scores.columns:
    for cat in ["Critical", "High", "Moderate", "Low"]:
        count = (risk_scores["risk_category"] == cat).sum()
        if count > 0:
            print(f"  {cat}: {count} states")

print("\nOutputs:")
print("  - Classification metrics: gold.gld_highway_safety_clf_metrics")
print("  - Regression metrics: gold.gld_highway_safety_reg_metrics")
print("  - Risk scores: gold.gld_highway_risk_scores")
print("  - Feature importance: gold.gld_highway_safety_feature_importance")
print("  - Visualizations: /tmp/dot_*.png")
print("  - MLflow experiments: /DOT/highway_safety_prediction")

print("=" * 60)

# COMMAND ----------

# Final risk summary by category
print("\nFINAL RISK ASSESSMENT SUMMARY:")
risk_summary = (
    risk_scores.groupby("risk_category")
    .agg(
        state_count=("state_fips", "count"),
        avg_risk_score=("risk_score", "mean"),
        avg_dui_rate=("has_dui", "mean"),
        avg_speed=("posted_speed_limit", "mean"),
    )
    .round(3)
)
print(risk_summary)
