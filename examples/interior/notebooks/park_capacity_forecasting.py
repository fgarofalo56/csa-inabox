# Databricks notebook source
# MAGIC %md
# MAGIC # National Park Capacity Forecasting
# MAGIC
# MAGIC ML-based forecasting for national park visitation and capacity management:
# MAGIC - Visitor trend analysis and seasonality decomposition
# MAGIC - Capacity utilization modeling
# MAGIC - Holiday effect modeling
# MAGIC - Weather-adjusted capacity models
# MAGIC - Trail congestion prediction
# MAGIC - Carrying capacity analysis
# MAGIC - Revenue optimization
# MAGIC - Visitor satisfaction correlation
# MAGIC - COVID-19 impact assessment and recovery tracking
# MAGIC
# MAGIC **Data Sources:**
# MAGIC - NPS visitor statistics (silver layer)

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
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import cross_val_score, train_test_split
from sklearn.preprocessing import LabelEncoder, StandardScaler

plt.style.use("seaborn-v0_8")
sns.set_palette("husl")
mlflow.set_experiment("/Interior/park_capacity_forecasting")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Loading

# COMMAND ----------


def load_park_data():
    """Load NPS visitor data from silver layer."""
    df = spark.table("silver.slv_park_visitors").toPandas()
    print(f"Loaded {len(df):,} park visitor records")
    print(f"Parks: {df['park_code'].nunique()}")
    print(f"Years: {df['year'].min()} - {df['year'].max()}")
    print(f"Columns: {', '.join(df.columns)}")
    return df


df_parks = load_park_data()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Visitor Trend Analysis

# COMMAND ----------


def analyze_visitor_trends(df):
    """Analyze visitor trends across parks with detailed breakdowns."""
    fig, axes = plt.subplots(2, 2, figsize=(18, 12))

    # Top parks by total visits
    park_totals = df.groupby("park_name")["recreation_visits"].sum().sort_values(ascending=False)
    top_parks = park_totals.head(10)

    top_parks.plot(kind="barh", ax=axes[0, 0], color=sns.color_palette("viridis", len(top_parks)))
    axes[0, 0].set_title("Top 10 Parks by Total Recreation Visits", fontweight="bold")
    axes[0, 0].set_xlabel("Total Visits")
    axes[0, 0].grid(True, alpha=0.3)

    # Annual trends for top 5 parks
    top5 = park_totals.head(5).index.tolist()
    annual = df[df["park_name"].isin(top5)].groupby(["park_name", "year"])["recreation_visits"].sum().reset_index()
    for park in top5:
        park_data = annual[annual["park_name"] == park]
        axes[0, 1].plot(park_data["year"], park_data["recreation_visits"] / 1e6, marker="o", label=park, linewidth=2)

    axes[0, 1].set_title("Annual Visitor Trends (Top 5)", fontweight="bold")
    axes[0, 1].set_xlabel("Year")
    axes[0, 1].set_ylabel("Visitors (Millions)")
    axes[0, 1].legend(fontsize=8)
    axes[0, 1].grid(True, alpha=0.3)

    # Monthly seasonality
    monthly = df.groupby("month")["recreation_visits"].mean().reset_index()
    axes[1, 0].bar(monthly["month"], monthly["recreation_visits"] / 1e3, color=sns.color_palette("coolwarm", 12))
    axes[1, 0].set_title("Average Monthly Visitation Pattern", fontweight="bold")
    axes[1, 0].set_xlabel("Month")
    axes[1, 0].set_ylabel("Average Visits (Thousands)")
    axes[1, 0].set_xticks(range(1, 13))
    axes[1, 0].grid(True, alpha=0.3)

    # COVID impact: 2019 vs 2020
    pre_covid = df[df["year"] == 2019].groupby("park_name")["recreation_visits"].sum()
    covid = df[df["year"] == 2020].groupby("park_name")["recreation_visits"].sum()
    impact = ((covid - pre_covid) / pre_covid * 100).dropna().sort_values()

    if len(impact) > 0:
        colors = ["red" if x < 0 else "green" for x in impact]
        axes[1, 1].barh(impact.index[-10:], impact.values[-10:], color=colors[-10:])
        axes[1, 1].set_title("COVID-19 Impact (2020 vs 2019)", fontweight="bold")
        axes[1, 1].set_xlabel("Change (%)")
        axes[1, 1].axvline(x=0, color="black", linestyle="-")
        axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/park_visitor_trends.png", dpi=300, bbox_inches="tight")
    plt.show()

    return park_totals


park_totals = analyze_visitor_trends(df_parks)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Seasonality Decomposition and Holiday Effect Modeling

# COMMAND ----------


def analyze_seasonality_and_holidays(df):
    """Decompose visitation into trend, seasonal, and holiday components."""

    # Aggregate monthly visitation across all parks
    monthly_total = (
        df.groupby(["year", "month"])
        .agg(
            total_visits=("recreation_visits", "sum"),
            avg_visits=("recreation_visits", "mean"),
            n_parks_reporting=("park_code", "nunique"),
        )
        .reset_index()
    )

    monthly_total["date"] = pd.to_datetime(
        monthly_total["year"].astype(str) + "-" + monthly_total["month"].astype(str) + "-01"
    )
    monthly_total = monthly_total.sort_values("date")

    # Simple moving average trend (12-month centered)
    monthly_total["trend"] = monthly_total["total_visits"].rolling(window=12, center=True, min_periods=6).mean()

    # Seasonal component: deviation from trend
    monthly_total["seasonal_ratio"] = monthly_total["total_visits"] / monthly_total["trend"].clip(lower=1)

    # Average seasonal index by month
    seasonal_index = monthly_total.groupby("month")["seasonal_ratio"].mean().reset_index()
    seasonal_index.columns = ["month", "seasonal_index"]

    # Holiday months identification (June-August = peak summer)
    holiday_months = {
        1: "New Year",
        5: "Memorial Day",
        6: "Summer Start",
        7: "Summer Peak",
        8: "Summer End",
        9: "Labor Day",
        11: "Thanksgiving",
        12: "Christmas",
    }

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Time series with trend overlay
    axes[0, 0].plot(monthly_total["date"], monthly_total["total_visits"] / 1e6, alpha=0.6, linewidth=1, label="Actual")
    axes[0, 0].plot(
        monthly_total["date"], monthly_total["trend"] / 1e6, color="red", linewidth=2, label="12-month Trend"
    )
    axes[0, 0].set_title("Monthly Visitation with Trend", fontweight="bold")
    axes[0, 0].set_xlabel("Date")
    axes[0, 0].set_ylabel("Total Visits (Millions)")
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)

    # Seasonal index by month
    month_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    colors_seasonal = ["gold" if m in holiday_months else "steelblue" for m in range(1, 13)]
    axes[0, 1].bar(range(1, 13), seasonal_index["seasonal_index"], color=colors_seasonal)
    axes[0, 1].axhline(y=1.0, color="red", linestyle="--", alpha=0.5, label="Average")
    axes[0, 1].set_xticks(range(1, 13))
    axes[0, 1].set_xticklabels(month_names)
    axes[0, 1].set_title("Seasonal Index (gold = holiday months)", fontweight="bold")
    axes[0, 1].set_ylabel("Seasonal Index")
    axes[0, 1].legend()
    axes[0, 1].grid(True, alpha=0.3)

    # Year-over-year growth rates
    annual_totals = df.groupby("year")["recreation_visits"].sum().reset_index()
    annual_totals["yoy_growth"] = annual_totals["recreation_visits"].pct_change() * 100
    growth_colors = ["green" if g > 0 else "red" for g in annual_totals["yoy_growth"].fillna(0)]
    axes[1, 0].bar(annual_totals["year"], annual_totals["yoy_growth"].fillna(0), color=growth_colors, alpha=0.7)
    axes[1, 0].axhline(y=0, color="black", linestyle="-")
    axes[1, 0].set_title("Year-over-Year Growth Rate", fontweight="bold")
    axes[1, 0].set_xlabel("Year")
    axes[1, 0].set_ylabel("Growth (%)")
    axes[1, 0].grid(True, alpha=0.3)

    # Residual analysis (deseasonalized)
    monthly_total = monthly_total.merge(seasonal_index, on="month", how="left")
    monthly_total["deseasonalized"] = monthly_total["total_visits"] / monthly_total["seasonal_index"].clip(lower=0.1)
    monthly_total["residual"] = monthly_total["total_visits"] - monthly_total["trend"] * monthly_total["seasonal_index"]
    axes[1, 1].plot(monthly_total["date"], monthly_total["residual"] / 1e6, linewidth=1, color="purple", alpha=0.7)
    axes[1, 1].axhline(y=0, color="red", linestyle="--")
    axes[1, 1].set_title("Residual Component (after trend + seasonality)", fontweight="bold")
    axes[1, 1].set_xlabel("Date")
    axes[1, 1].set_ylabel("Residual (Millions)")
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/seasonality_decomposition.png", dpi=300, bbox_inches="tight")
    plt.show()

    print("\nSeasonal Index:")
    for _, row in seasonal_index.iterrows():
        m = int(row["month"])
        holiday_note = f" ({holiday_months[m]})" if m in holiday_months else ""
        print(f"  {month_names[m - 1]}: {row['seasonal_index']:.3f}{holiday_note}")

    return seasonal_index, monthly_total


seasonal_index, monthly_totals = analyze_seasonality_and_holidays(df_parks)

# COMMAND ----------

# MAGIC %md
# MAGIC ## ML Capacity Forecasting Model

# COMMAND ----------


def build_forecasting_model(df):
    """Build ML model for visitor forecasting with enhanced features."""
    df_ml = df.copy()

    # Feature engineering
    le_park = LabelEncoder()
    df_ml["park_encoded"] = le_park.fit_transform(df_ml["park_code"])
    df_ml["month_sin"] = np.sin(2 * np.pi * df_ml["month"] / 12)
    df_ml["month_cos"] = np.cos(2 * np.pi * df_ml["month"] / 12)
    df_ml["is_summer"] = df_ml["month"].isin([6, 7, 8]).astype(int)
    df_ml["is_shoulder"] = df_ml["month"].isin([4, 5, 9, 10]).astype(int)
    df_ml["is_winter"] = df_ml["month"].isin([12, 1, 2]).astype(int)
    df_ml["is_covid"] = df_ml["year"].isin([2020, 2021]).astype(int)
    df_ml["is_holiday_month"] = df_ml["month"].isin([6, 7, 8, 11, 12]).astype(int)

    # Lag features
    df_ml = df_ml.sort_values(["park_code", "year", "month"])
    for lag in [1, 3, 6, 12]:
        df_ml[f"visits_lag_{lag}"] = df_ml.groupby("park_code")["recreation_visits"].shift(lag)

    # Rolling statistics
    df_ml["visits_rolling_3"] = (
        df_ml.groupby("park_code")["recreation_visits"].rolling(window=3, min_periods=2).mean().reset_index(drop=True)
    )
    df_ml["visits_rolling_6"] = (
        df_ml.groupby("park_code")["recreation_visits"].rolling(window=6, min_periods=3).mean().reset_index(drop=True)
    )
    df_ml["visits_rolling_12_std"] = (
        df_ml.groupby("park_code")["recreation_visits"].rolling(window=12, min_periods=6).std().reset_index(drop=True)
    )

    # Year-over-year same-month change
    df_ml["visits_yoy"] = df_ml.groupby(["park_code", "month"])["recreation_visits"].pct_change()

    df_ml = df_ml.dropna()

    features = [
        "park_encoded",
        "year",
        "month",
        "month_sin",
        "month_cos",
        "is_summer",
        "is_shoulder",
        "is_winter",
        "is_covid",
        "is_holiday_month",
        "park_acres",
        "campground_capacity",
        "visits_lag_1",
        "visits_lag_3",
        "visits_lag_6",
        "visits_lag_12",
        "visits_rolling_3",
        "visits_rolling_6",
        "visits_rolling_12_std",
        "visits_yoy",
    ]

    available_features = [f for f in features if f in df_ml.columns]

    X = df_ml[available_features].fillna(0)
    y = np.log1p(df_ml["recreation_visits"])

    # Time-based split
    split_idx = int(len(X) * 0.8)
    X_train, X_test = X.iloc[:split_idx], X.iloc[split_idx:]
    y_train, y_test = y.iloc[:split_idx], y.iloc[split_idx:]

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    models = {
        "Ridge": Ridge(alpha=1.0),
        "Random Forest": RandomForestRegressor(n_estimators=150, max_depth=12, random_state=42),
        "Gradient Boosting": GradientBoostingRegressor(n_estimators=150, max_depth=6, random_state=42),
    }

    best_model_obj = None
    best_model_name = None
    best_r2 = -np.inf
    all_results = {}

    for name, model in models.items():
        with mlflow.start_run(run_name=f"park_{name.lower().replace(' ', '_')}"):
            model.fit(X_train_scaled, y_train)
            y_pred = model.predict(X_test_scaled)

            mae = mean_absolute_error(y_test, y_pred)
            r2 = r2_score(y_test, y_pred)
            rmse = np.sqrt(mean_squared_error(y_test, y_pred))

            # Cross-validation
            cv_scores = cross_val_score(model, X_train_scaled, y_train, cv=5, scoring="neg_mean_absolute_error")
            cv_mae = -cv_scores.mean()

            all_results[name] = {"mae": mae, "r2": r2, "rmse": rmse, "cv_mae": cv_mae, "predictions": y_pred}
            print(f"{name}: MAE={mae:.4f}, R2={r2:.4f}, RMSE={rmse:.4f}, CV-MAE={cv_mae:.4f}")

            mlflow.log_metric("mae", mae)
            mlflow.log_metric("r2", r2)
            mlflow.log_metric("rmse", rmse)
            mlflow.log_metric("cv_mae", cv_mae)
            mlflow.sklearn.log_model(model, f"park_{name}")

            if r2 > best_r2:
                best_r2 = r2
                best_model_name = name
                best_model_obj = model

    # Visualization
    fig, axes = plt.subplots(2, 2, figsize=(18, 12))
    for i, (name, res) in enumerate(all_results.items()):
        if i < 3:
            axes.flatten()[i].scatter(y_test, res["predictions"], alpha=0.4, s=20)
            axes.flatten()[i].plot([y_test.min(), y_test.max()], [y_test.min(), y_test.max()], "r--")
            axes.flatten()[i].set_title(f"{name} (R2={res['r2']:.3f})", fontweight="bold")
            axes.flatten()[i].set_xlabel("Actual (log)")
            axes.flatten()[i].set_ylabel("Predicted (log)")
            axes.flatten()[i].grid(True, alpha=0.3)

    # Feature importance from best model
    if hasattr(best_model_obj, "feature_importances_"):
        imp = pd.DataFrame(
            {"feature": available_features, "importance": best_model_obj.feature_importances_}
        ).sort_values("importance", ascending=True)
        axes[1, 1].barh(imp["feature"], imp["importance"], color="teal")
        axes[1, 1].set_title(f"Feature Importance ({best_model_name})", fontweight="bold")
        axes[1, 1].set_xlabel("Importance")
        axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/park_forecast_models.png", dpi=300, bbox_inches="tight")
    plt.show()

    print(f"\nBest model: {best_model_name} (R2={best_r2:.4f})")
    return all_results, best_model_obj, scaler, available_features


model_results, best_model, scaler, feature_names = build_forecasting_model(df_parks)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Carrying Capacity Analysis

# COMMAND ----------


def analyze_carrying_capacity(df):
    """Analyze park carrying capacity using visitor density metrics and
    identify parks approaching or exceeding sustainable limits."""

    park_capacity = (
        df.groupby("park_name")
        .agg(
            total_visits=("recreation_visits", "sum"),
            avg_monthly=("recreation_visits", "mean"),
            peak_monthly=("recreation_visits", "max"),
            min_monthly=("recreation_visits", "min"),
            std_monthly=("recreation_visits", "std"),
            camping_capacity=("campground_capacity", "first"),
            acres=("park_acres", "first"),
            n_months=("recreation_visits", "count"),
        )
        .reset_index()
    )

    # Derived metrics
    park_capacity["visits_per_acre"] = (park_capacity["total_visits"] / park_capacity["acres"].clip(lower=1)).round(2)

    park_capacity["peak_visits_per_acre"] = (
        park_capacity["peak_monthly"] / park_capacity["acres"].clip(lower=1)
    ).round(4)

    park_capacity["peaking_factor"] = (
        park_capacity["peak_monthly"] / park_capacity["avg_monthly"].clip(lower=1)
    ).round(2)

    park_capacity["visit_volatility"] = (
        park_capacity["std_monthly"] / park_capacity["avg_monthly"].clip(lower=1)
    ).round(3)

    # Carrying capacity threshold (heuristic: parks with high density and peaking)
    park_capacity["density_percentile"] = park_capacity["visits_per_acre"].rank(pct=True)
    park_capacity["peaking_percentile"] = park_capacity["peaking_factor"].rank(pct=True)

    park_capacity["capacity_stress"] = (
        park_capacity["density_percentile"] * 50
        + park_capacity["peaking_percentile"] * 30
        + park_capacity["visit_volatility"].rank(pct=True) * 20
    ).round(1)

    park_capacity["capacity_status"] = pd.cut(
        park_capacity["capacity_stress"],
        bins=[0, 30, 60, 80, 100],
        labels=["Under Capacity", "Moderate Use", "Near Capacity", "Over Capacity"],
    )

    park_capacity = park_capacity.sort_values("capacity_stress", ascending=False)

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Visitor density - top 15
    top_density = park_capacity.head(15)
    density_colors = {
        "Under Capacity": "green",
        "Moderate Use": "yellow",
        "Near Capacity": "orange",
        "Over Capacity": "red",
    }
    bar_colors = [density_colors.get(str(s), "gray") for s in top_density["capacity_status"]]

    axes[0, 0].barh(top_density["park_name"], top_density["visits_per_acre"], color=bar_colors)
    axes[0, 0].set_title("Visitor Density (Visits per Acre) - Top 15", fontweight="bold")
    axes[0, 0].set_xlabel("Visits / Acre")
    axes[0, 0].grid(True, alpha=0.3)

    # Capacity stress scores
    axes[0, 1].barh(top_density["park_name"], top_density["capacity_stress"], color=bar_colors)
    axes[0, 1].set_title("Capacity Stress Score (0-100)", fontweight="bold")
    axes[0, 1].set_xlabel("Stress Score")
    axes[0, 1].grid(True, alpha=0.3)

    # Peaking factor vs density scatter
    axes[1, 0].scatter(
        park_capacity["visits_per_acre"],
        park_capacity["peaking_factor"],
        s=park_capacity["avg_monthly"] / 1000,
        alpha=0.6,
        c="steelblue",
    )
    axes[1, 0].set_title("Density vs Peaking Factor (size = avg visits)", fontweight="bold")
    axes[1, 0].set_xlabel("Total Visits per Acre")
    axes[1, 0].set_ylabel("Peaking Factor")
    axes[1, 0].grid(True, alpha=0.3)

    # Capacity status distribution
    status_counts = park_capacity["capacity_status"].value_counts()
    status_colors = [density_colors.get(str(s), "gray") for s in status_counts.index]
    axes[1, 1].pie(status_counts.values, labels=status_counts.index, autopct="%1.1f%%", colors=status_colors)
    axes[1, 1].set_title("Park Capacity Status Distribution", fontweight="bold")

    plt.tight_layout()
    plt.savefig("/tmp/carrying_capacity_analysis.png", dpi=300, bbox_inches="tight")
    plt.show()

    print("\nCapacity Status Summary:")
    for status in ["Over Capacity", "Near Capacity", "Moderate Use", "Under Capacity"]:
        count = (park_capacity["capacity_status"] == status).sum()
        print(f"  {status}: {count} parks")

    return park_capacity


capacity_results = analyze_carrying_capacity(df_parks)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Trail Congestion Prediction

# COMMAND ----------


def predict_trail_congestion(df, capacity_results):
    """Predict trail congestion levels based on visitation patterns and
    park characteristics. Uses a proxy model since trail-level data
    may not be available."""

    # Create monthly congestion proxy: ratio of monthly visits to park capacity
    df_congestion = df.copy()
    df_congestion = df_congestion.merge(
        capacity_results[["park_name", "avg_monthly", "peak_monthly", "capacity_stress"]], on="park_name", how="left"
    )

    # Congestion index: current month vs park average
    df_congestion["congestion_index"] = (
        df_congestion["recreation_visits"] / df_congestion["avg_monthly"].clip(lower=1)
    ).round(3)

    # Congestion level classification
    df_congestion["congestion_level"] = pd.cut(
        df_congestion["congestion_index"],
        bins=[0, 0.5, 0.8, 1.2, 2.0, np.inf],
        labels=["Very Low", "Low", "Normal", "High", "Very High"],
    )

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Congestion by month across all parks
    monthly_congestion = df_congestion.groupby("month")["congestion_index"].agg(["mean", "std", "median"]).reset_index()

    axes[0, 0].errorbar(
        monthly_congestion["month"],
        monthly_congestion["mean"],
        yerr=monthly_congestion["std"],
        fmt="o-",
        capsize=5,
        color="steelblue",
        linewidth=2,
    )
    axes[0, 0].axhline(y=1.0, color="red", linestyle="--", alpha=0.5, label="Average Level")
    month_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    axes[0, 0].set_xticks(range(1, 13))
    axes[0, 0].set_xticklabels(month_names)
    axes[0, 0].set_title("Average Congestion Index by Month", fontweight="bold")
    axes[0, 0].set_ylabel("Congestion Index")
    axes[0, 0].legend()
    axes[0, 0].grid(True, alpha=0.3)

    # Congestion level distribution
    cong_dist = df_congestion["congestion_level"].value_counts()
    cong_colors = {"Very Low": "darkgreen", "Low": "green", "Normal": "steelblue", "High": "orange", "Very High": "red"}
    bar_colors_cong = [cong_colors.get(str(c), "gray") for c in cong_dist.index]
    axes[0, 1].bar(cong_dist.index.astype(str), cong_dist.values, color=bar_colors_cong)
    axes[0, 1].set_title("Congestion Level Distribution", fontweight="bold")
    axes[0, 1].set_ylabel("Record Count")
    axes[0, 1].tick_params(axis="x", rotation=45)
    axes[0, 1].grid(True, alpha=0.3)

    # Top parks by high-congestion months
    high_congestion = df_congestion[df_congestion["congestion_index"] > 1.5]
    park_high_cong = high_congestion.groupby("park_name").size().sort_values(ascending=False).head(15)
    if len(park_high_cong) > 0:
        axes[1, 0].barh(park_high_cong.index, park_high_cong.values, color="coral")
        axes[1, 0].set_title("Parks with Most High-Congestion Months", fontweight="bold")
        axes[1, 0].set_xlabel("Number of High-Congestion Months")
        axes[1, 0].grid(True, alpha=0.3)

    # Congestion vs capacity stress
    park_avg_cong = (
        df_congestion.groupby("park_name")
        .agg(
            avg_congestion=("congestion_index", "mean"),
            max_congestion=("congestion_index", "max"),
            cap_stress=("capacity_stress", "first"),
        )
        .reset_index()
    )
    axes[1, 1].scatter(park_avg_cong["cap_stress"], park_avg_cong["max_congestion"], s=60, alpha=0.6, c="teal")
    axes[1, 1].set_title("Capacity Stress vs Peak Congestion", fontweight="bold")
    axes[1, 1].set_xlabel("Capacity Stress Score")
    axes[1, 1].set_ylabel("Peak Congestion Index")
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/trail_congestion.png", dpi=300, bbox_inches="tight")
    plt.show()

    return df_congestion


congestion_results = predict_trail_congestion(df_parks, capacity_results)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Revenue Optimization Model

# COMMAND ----------


def optimize_revenue(df, capacity_results):
    """Model the relationship between visitation levels and potential revenue
    to identify optimal visitor throughput targets."""

    # Revenue proxy: visits * fee multiplier (seasonal adjustment)
    df_rev = df.copy()
    seasonal_multiplier = {
        1: 0.7,
        2: 0.7,
        3: 0.9,
        4: 1.0,
        5: 1.1,
        6: 1.3,
        7: 1.4,
        8: 1.4,
        9: 1.2,
        10: 1.0,
        11: 0.8,
        12: 0.7,
    }
    df_rev["season_mult"] = df_rev["month"].map(seasonal_multiplier)
    df_rev["estimated_revenue"] = (df_rev["recreation_visits"] * df_rev["season_mult"] * 0.035).round(2)

    # Revenue analysis by park
    park_revenue = (
        df_rev.groupby("park_name")
        .agg(
            total_revenue=("estimated_revenue", "sum"),
            avg_monthly_revenue=("estimated_revenue", "mean"),
            peak_revenue=("estimated_revenue", "max"),
            total_visits=("recreation_visits", "sum"),
        )
        .reset_index()
    )

    park_revenue["revenue_per_visit"] = (
        park_revenue["total_revenue"] / park_revenue["total_visits"].clip(lower=1)
    ).round(4)

    # Merge with capacity data
    park_revenue = park_revenue.merge(
        capacity_results[["park_name", "capacity_stress", "capacity_status"]], on="park_name", how="left"
    )

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Revenue by park (top 15)
    top_rev = park_revenue.nlargest(15, "total_revenue")
    axes[0, 0].barh(top_rev["park_name"], top_rev["total_revenue"], color="steelblue", alpha=0.7)
    axes[0, 0].set_title("Top 15 Parks by Estimated Revenue", fontweight="bold")
    axes[0, 0].set_xlabel("Total Revenue ($)")
    axes[0, 0].grid(True, alpha=0.3)

    # Revenue vs visits (diminishing returns)
    axes[0, 1].scatter(park_revenue["total_visits"] / 1e6, park_revenue["total_revenue"], s=60, alpha=0.6, c="teal")
    # Fit polynomial for diminishing returns
    if len(park_revenue) > 3:
        x_fit = park_revenue["total_visits"].values / 1e6
        y_fit = park_revenue["total_revenue"].values
        valid_mask = np.isfinite(x_fit) & np.isfinite(y_fit)
        if valid_mask.sum() > 3:
            z = np.polyfit(x_fit[valid_mask], y_fit[valid_mask], 2)
            x_line = np.linspace(x_fit[valid_mask].min(), x_fit[valid_mask].max(), 100)
            axes[0, 1].plot(x_line, np.polyval(z, x_line), "r--", linewidth=2, label="Polynomial fit")
    axes[0, 1].set_title("Revenue vs Visitation Volume", fontweight="bold")
    axes[0, 1].set_xlabel("Total Visits (Millions)")
    axes[0, 1].set_ylabel("Revenue ($)")
    axes[0, 1].legend()
    axes[0, 1].grid(True, alpha=0.3)

    # Monthly revenue pattern
    monthly_rev = df_rev.groupby("month")["estimated_revenue"].sum()
    axes[1, 0].bar(range(1, 13), monthly_rev.values, color=sns.color_palette("coolwarm", 12))
    axes[1, 0].set_title("Monthly Revenue Pattern", fontweight="bold")
    axes[1, 0].set_xlabel("Month")
    axes[1, 0].set_ylabel("Total Revenue ($)")
    axes[1, 0].set_xticks(range(1, 13))
    axes[1, 0].grid(True, alpha=0.3)

    # Revenue efficiency by capacity status
    rev_by_status = (
        park_revenue.groupby("capacity_status")
        .agg(
            avg_revenue=("avg_monthly_revenue", "mean"),
            avg_rev_per_visit=("revenue_per_visit", "mean"),
            n_parks=("park_name", "count"),
        )
        .reset_index()
    )

    x_pos = range(len(rev_by_status))
    axes[1, 1].bar(x_pos, rev_by_status["avg_revenue"], color="steelblue", alpha=0.7)
    axes[1, 1].set_xticks(x_pos)
    axes[1, 1].set_xticklabels(rev_by_status["capacity_status"].astype(str), rotation=30)
    axes[1, 1].set_title("Avg Monthly Revenue by Capacity Status", fontweight="bold")
    axes[1, 1].set_ylabel("Avg Monthly Revenue ($)")
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/revenue_optimization.png", dpi=300, bbox_inches="tight")
    plt.show()

    return park_revenue


revenue_results = optimize_revenue(df_parks, capacity_results)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Visitor Satisfaction Correlation Analysis

# COMMAND ----------


def analyze_satisfaction_correlations(df, capacity_results):
    """Analyze correlations between visitation patterns, capacity stress,
    and proxy indicators for visitor satisfaction."""

    # Build park-level analysis dataframe
    park_analysis = (
        df.groupby("park_name")
        .agg(
            total_visits=("recreation_visits", "sum"),
            avg_monthly_visits=("recreation_visits", "mean"),
            peak_monthly=("recreation_visits", "max"),
            visit_std=("recreation_visits", "std"),
            acres=("park_acres", "first"),
            camping_cap=("campground_capacity", "first"),
            n_years=("year", "nunique"),
        )
        .reset_index()
    )

    park_analysis = park_analysis.merge(
        capacity_results[["park_name", "capacity_stress", "peaking_factor", "visit_volatility", "visits_per_acre"]],
        on="park_name",
        how="left",
    )

    # Return visit proxy: coefficient of variation (lower = more consistent = happier)
    park_analysis["return_visit_proxy"] = (1 - park_analysis["visit_volatility"].rank(pct=True)).round(3)

    # Crowding index
    park_analysis["crowding_index"] = (park_analysis["peak_monthly"] / park_analysis["acres"].clip(lower=1)).round(4)

    fig, axes = plt.subplots(2, 2, figsize=(18, 14))

    # Correlation matrix
    corr_cols = [
        "total_visits",
        "capacity_stress",
        "peaking_factor",
        "visit_volatility",
        "visits_per_acre",
        "return_visit_proxy",
        "crowding_index",
    ]
    available_corr = [c for c in corr_cols if c in park_analysis.columns]
    corr_matrix = park_analysis[available_corr].corr()

    sns.heatmap(
        corr_matrix, annot=True, fmt=".2f", cmap="RdBu_r", center=0, ax=axes[0, 0], cbar_kws={"label": "Correlation"}
    )
    axes[0, 0].set_title("Park Metrics Correlation Matrix", fontweight="bold")

    # Capacity stress vs return visit proxy
    axes[0, 1].scatter(
        park_analysis["capacity_stress"],
        park_analysis["return_visit_proxy"],
        s=park_analysis["total_visits"] / 1e5,
        alpha=0.6,
        c="steelblue",
    )
    axes[0, 1].set_title("Capacity Stress vs Return Visit Proxy", fontweight="bold")
    axes[0, 1].set_xlabel("Capacity Stress")
    axes[0, 1].set_ylabel("Return Visit Proxy (higher = better)")
    axes[0, 1].grid(True, alpha=0.3)

    # Crowding index distribution
    axes[1, 0].hist(park_analysis["crowding_index"], bins=30, edgecolor="black", alpha=0.7, color="coral")
    axes[1, 0].set_title("Crowding Index Distribution", fontweight="bold")
    axes[1, 0].set_xlabel("Peak Visitors per Acre")
    axes[1, 0].set_ylabel("Count")
    axes[1, 0].grid(True, alpha=0.3)

    # Park size vs peaking factor
    axes[1, 1].scatter(
        np.log10(park_analysis["acres"].clip(lower=1)), park_analysis["peaking_factor"], s=60, alpha=0.5, c="teal"
    )
    axes[1, 1].set_title("Park Size (log) vs Peaking Factor", fontweight="bold")
    axes[1, 1].set_xlabel("log10(Acres)")
    axes[1, 1].set_ylabel("Peaking Factor")
    axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig("/tmp/satisfaction_correlations.png", dpi=300, bbox_inches="tight")
    plt.show()

    print("\nKey Correlations with Return Visit Proxy:")
    proxy_corr = corr_matrix.get("return_visit_proxy", pd.Series(dtype=float))
    if len(proxy_corr) > 0:
        for col, val in proxy_corr.sort_values(ascending=False).items():
            if col != "return_visit_proxy":
                print(f"  {col}: {val:.3f}")

    return park_analysis


satisfaction_results = analyze_satisfaction_correlations(df_parks, capacity_results)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Save Results to Delta Lake

# COMMAND ----------

# Save capacity analysis
capacity_save = capacity_results[
    [
        "park_name",
        "total_visits",
        "avg_monthly",
        "peak_monthly",
        "visits_per_acre",
        "peaking_factor",
        "capacity_stress",
        "capacity_status",
    ]
].copy()
capacity_save["capacity_status"] = capacity_save["capacity_status"].astype(str)
capacity_spark = spark.createDataFrame(capacity_save)
capacity_spark = capacity_spark.withColumn("analysis_date", current_date())

(capacity_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_park_capacity_analysis"))

# Save revenue analysis
revenue_save = revenue_results[
    ["park_name", "total_revenue", "avg_monthly_revenue", "revenue_per_visit", "total_visits"]
].copy()
revenue_spark = spark.createDataFrame(revenue_save)
revenue_spark = revenue_spark.withColumn("analysis_date", current_date())

(revenue_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_park_revenue_analysis"))

# Save congestion data (aggregated by park)
congestion_save = (
    congestion_results.groupby("park_name")
    .agg(
        avg_congestion=("congestion_index", "mean"),
        max_congestion=("congestion_index", "max"),
        high_congestion_months=("congestion_index", lambda x: (x > 1.5).sum()),
    )
    .reset_index()
)
congestion_spark = spark.createDataFrame(congestion_save)
congestion_spark = congestion_spark.withColumn("analysis_date", current_date())

(congestion_spark.write.mode("overwrite").option("mergeSchema", "true").saveAsTable("gold.gld_park_congestion"))

print("Saved to:")
print("  gold.gld_park_capacity_analysis")
print("  gold.gld_park_revenue_analysis")
print("  gold.gld_park_congestion")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print("=" * 70)
print("PARK CAPACITY FORECASTING - COMPREHENSIVE SUMMARY")
print("=" * 70)

print(f"\nParks analyzed: {df_parks['park_code'].nunique()}")
print(f"Total records: {len(df_parks):,}")
print(f"Year range: {df_parks['year'].min()} - {df_parks['year'].max()}")

best = min(model_results.keys(), key=lambda k: model_results[k]["mae"])
print("\nForecasting Model Performance:")
for name, res in model_results.items():
    marker = " <-- BEST" if name == best else ""
    print(f"  {name}: R2={res['r2']:.4f}, MAE={res['mae']:.4f}{marker}")

print("\nCapacity Status:")
for status in ["Over Capacity", "Near Capacity", "Moderate Use", "Under Capacity"]:
    count = (capacity_results["capacity_status"] == status).sum()
    print(f"  {status}: {count} parks")

print("\nSeasonal Peaks:")
peak_month = seasonal_index.loc[seasonal_index["seasonal_index"].idxmax()]
print(f"  Peak month: {int(peak_month['month'])} (index: {peak_month['seasonal_index']:.3f})")

print("\nOutputs:")
print("  gold.gld_park_capacity_analysis")
print("  gold.gld_park_revenue_analysis")
print("  gold.gld_park_congestion")
print("  MLflow: /Interior/park_capacity_forecasting")
print("  Visualizations: /tmp/*.png")
print("=" * 70)
