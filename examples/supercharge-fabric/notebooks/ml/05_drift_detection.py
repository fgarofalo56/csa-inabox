# Databricks notebook source
# MAGIC %md
# MAGIC # ML: Drift Detection — Casino Slot Revenue Model
# MAGIC
# MAGIC Production-grade drift detection notebook for the slot-revenue forecasting model.
# MAGIC Implements the patterns documented in
# MAGIC `docs/best-practices/model-monitoring-drift-detection.md` (Phase 14 Wave 2 feature 2.10).
# MAGIC
# MAGIC ## Drift Types Covered
# MAGIC - **Data drift** (covariate shift): PSI, KS, Chi-square, Wasserstein per feature
# MAGIC - **Prediction drift**: PSI on prediction-score buckets vs training-time distribution
# MAGIC - **Performance drift**: Realized RMSE/MAPE on lagged ground-truth vs training-time baseline
# MAGIC - **Concept drift**: Tree-based feature-importance shift via shadow model + Spearman ρ
# MAGIC
# MAGIC ## Outputs
# MAGIC - `lh_gold.ml_drift_metrics` — append-only Delta table for every metric/feature/window
# MAGIC - `lh_gold.ml_retrain_triggers` — append-only retrain decisions with reason codes
# MAGIC
# MAGIC ## Related
# MAGIC - Anchor doc: `docs/best-practices/model-monitoring-drift-detection.md`
# MAGIC - MLOps anchor: `docs/best-practices/mlops-fabric-production.md`
# MAGIC - Alert wiring: `docs/best-practices/operations/slo-sli-fabric.md`,
# MAGIC   `docs/best-practices/operations/observability-stack.md`

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup

# COMMAND ----------

import math
import uuid
from datetime import datetime, timedelta

import mlflow
import numpy as np
import pandas as pd
from pyspark.sql import Row
from pyspark.sql.functions import (
    col,
    current_timestamp,
    lit,
    to_date,
)
from pyspark.sql.types import (
    DoubleType,
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)
from scipy import stats

# Configuration — model under monitoring
MODEL_NAME = "casino-slot-revenue-gbt"
MODEL_VERSION = "v3"
SOURCE_TABLE = "lh_gold.fact_daily_slot_revenue"
DRIFT_TABLE = "lh_gold.ml_drift_metrics"
RETRAIN_TABLE = "lh_gold.ml_retrain_triggers"

# Window configuration
REFERENCE_DAYS = 90  # historical baseline window
CURRENT_DAYS = 7     # current production window

# Drift thresholds (industry-standard, see drift doc § Statistical Methods)
PSI_NO_DRIFT = 0.10
PSI_MODERATE = 0.20
PSI_SEVERE = 0.25
KS_PVALUE = 0.01
CHI_PVALUE = 0.01
WASS_SIGMA_FACTOR = 2.0  # > 2σ baseline = drift candidate
PERF_RMSE_DELTA_PCT = 0.10  # 10% RMSE degradation
PERF_MAPE_DELTA_PCT = 0.05  # 5% MAPE degradation
IMPORTANCE_SPEARMAN_FLOOR = 0.70  # below = concept drift suspected

# Run id for traceability — every metric written this run shares it
RUN_ID = str(uuid.uuid4())
RUN_TIMESTAMP = datetime.utcnow()

print(f"Model: {MODEL_NAME} {MODEL_VERSION}")
print(f"Run ID: {RUN_ID}")
print(f"Reference window: last {REFERENCE_DAYS} days BEFORE current window")
print(f"Current window: last {CURRENT_DAYS} days")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Load Reference & Current Distributions
# MAGIC
# MAGIC Reference = the historical baseline window the production model was trained on.
# MAGIC Current = the last `CURRENT_DAYS` of features fed into the production model.
# MAGIC
# MAGIC If the upstream Gold fact does not exist (POC env), generate synthetic data with
# MAGIC a deliberately-shifted current window so every drift signal can be exercised.

# COMMAND ----------

NUMERIC_FEATURES = [
    "coin_in",
    "coin_out",
    "handle_pulls",
    "avg_bet",
    "session_minutes",
    "payout_ratio",
    "unique_players",
]
CATEGORICAL_FEATURES = ["game_theme", "denomination_tier", "floor_zone"]
TARGET_COLUMN = "daily_revenue"
PREDICTION_COLUMN = "predicted_revenue"


def _generate_synthetic(days: int, drift: bool, seed: int) -> "pd.DataFrame":
    """Synthesize a slot-revenue feature snapshot. When `drift=True` we shift
    the means and class proportions so PSI/KS/Chi-square/Wasserstein all fire."""
    rng = np.random.default_rng(seed)
    n = days * 200  # 200 machines/day-equivalents
    end = RUN_TIMESTAMP if drift else RUN_TIMESTAMP - timedelta(days=CURRENT_DAYS)
    start = end - timedelta(days=days)
    timestamps = [start + (end - start) * rng.random() for _ in range(n)]

    coin_in_mean = 1300 if drift else 1000
    handle_mean = 950 if drift else 800
    session_mean = 28 if drift else 35
    payout_mean = 0.93 if drift else 0.90

    df = pd.DataFrame({
        "machine_id": [f"SLOT-{rng.integers(1, 1500):04d}" for _ in range(n)],
        "txn_date": [t.date() for t in timestamps],
        "txn_timestamp": timestamps,
        "coin_in": rng.normal(coin_in_mean, 250, n).clip(50, None),
        "coin_out": rng.normal(coin_in_mean * payout_mean, 200, n).clip(0, None),
        "handle_pulls": rng.poisson(handle_mean, n),
        "avg_bet": rng.gamma(2.0, 1.5 if drift else 1.2, n).clip(0.25, None),
        "session_minutes": rng.normal(session_mean, 8, n).clip(1, None),
        "payout_ratio": rng.normal(payout_mean, 0.03, n).clip(0.7, 1.0),
        "unique_players": rng.poisson(12 if drift else 10, n),
        "game_theme": rng.choice(
            ["classic", "video", "progressive", "skill"],
            n,
            p=[0.20, 0.55, 0.15, 0.10] if drift else [0.30, 0.45, 0.15, 0.10],
        ),
        "denomination_tier": rng.choice(
            ["penny", "nickel", "quarter", "dollar", "high_limit"],
            n,
            p=[0.30, 0.15, 0.20, 0.20, 0.15] if drift else [0.45, 0.20, 0.20, 0.10, 0.05],
        ),
        "floor_zone": rng.choice(
            ["main", "high_limit", "non_smoking", "vip"],
            n,
            p=[0.55, 0.15, 0.20, 0.10],
        ),
    })
    # Realized + predicted revenue — predictions are noisier in current window when drift=True
    df[TARGET_COLUMN] = (
        df["coin_in"] * (1 - df["payout_ratio"]) + rng.normal(0, 30, n)
    ).clip(0, None)
    pred_noise = rng.normal(0, 65 if drift else 25, n)
    df[PREDICTION_COLUMN] = (df[TARGET_COLUMN] + pred_noise).clip(0, None)
    return df


def _load_window(days: int, end_offset_days: int, drift: bool, seed: int):
    if spark.catalog.tableExists(SOURCE_TABLE):
        end_dt = (RUN_TIMESTAMP - timedelta(days=end_offset_days)).date()
        start_dt = end_dt - timedelta(days=days)
        return (
            spark.table(SOURCE_TABLE)
            .where(col("txn_date").between(lit(start_dt), lit(end_dt)))
        )
    print(f"  -> {SOURCE_TABLE} not found; generating synthetic (drift={drift}).")
    return spark.createDataFrame(_generate_synthetic(days, drift=drift, seed=seed))


print("Loading reference window...")
df_reference = _load_window(REFERENCE_DAYS, end_offset_days=CURRENT_DAYS, drift=False, seed=11)
print(f"  Reference rows: {df_reference.count():,}")

print("Loading current window...")
df_current = _load_window(CURRENT_DAYS, end_offset_days=0, drift=True, seed=42)
print(f"  Current rows:   {df_current.count():,}")

# Pull both into pandas for scipy / numpy work — drift detection is per-feature
# arithmetic on aggregate distributions, not row-level Spark.
pdf_reference = df_reference.toPandas()
pdf_current = df_current.toPandas()

# COMMAND ----------

# MAGIC %md
# MAGIC ## PSI — Population Stability Index
# MAGIC
# MAGIC Quantile-bin the reference, project both samples onto the bins, then
# MAGIC `Σ (actual − expected) × ln(actual / expected)`. Classify against the
# MAGIC industry-standard bands (no / moderate / significant / severe).

# COMMAND ----------

def compute_psi(reference: pd.Series, current: pd.Series, n_bins: int = 10) -> float:
    """PSI between two numeric samples. Reference defines the bin edges so the
    metric is anchored to the training-time distribution."""
    eps = 1e-4
    ref = reference.dropna().to_numpy()
    cur = current.dropna().to_numpy()
    if ref.size == 0 or cur.size == 0:
        return float("nan")

    quantiles = np.unique(np.quantile(ref, np.linspace(0, 1, n_bins + 1)))
    if quantiles.size < 3:
        return 0.0  # constant feature — no PSI signal possible
    quantiles[0], quantiles[-1] = -np.inf, np.inf

    expected, _ = np.histogram(ref, bins=quantiles)
    observed, _ = np.histogram(cur, bins=quantiles)
    expected_pct = np.maximum(expected / max(expected.sum(), 1), eps)
    observed_pct = np.maximum(observed / max(observed.sum(), 1), eps)
    return float(np.sum((observed_pct - expected_pct) * np.log(observed_pct / expected_pct)))


def classify_psi(value: float) -> str:
    if math.isnan(value):
        return "UNKNOWN"
    if value < PSI_NO_DRIFT:
        return "NO_DRIFT"
    if value < PSI_MODERATE:
        return "MODERATE"
    if value < PSI_SEVERE:
        return "SIGNIFICANT"
    return "SEVERE"


psi_results = []
for feat in NUMERIC_FEATURES:
    psi_value = compute_psi(pdf_reference[feat], pdf_current[feat])
    status = classify_psi(psi_value)
    psi_results.append({
        "feature": feat,
        "metric_type": "PSI",
        "value": psi_value,
        "threshold": PSI_MODERATE,
        "status": status,
    })
    print(f"  PSI[{feat:>17}] = {psi_value:7.4f}  -> {status}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## KS Test — Kolmogorov–Smirnov (continuous features)
# MAGIC
# MAGIC Two-sample KS via `scipy.stats.ks_2samp`. Reject null at p < 0.01 with
# MAGIC effect size > 0.1 (D-statistic). Bonferroni-correct across the feature set.

# COMMAND ----------

ks_results = []
n_continuous = len(NUMERIC_FEATURES)
bonferroni_alpha = KS_PVALUE / max(n_continuous, 1)

for feat in NUMERIC_FEATURES:
    ref = pdf_reference[feat].dropna().to_numpy()
    cur = pdf_current[feat].dropna().to_numpy()
    if ref.size == 0 or cur.size == 0:
        continue
    ks_stat, ks_p = stats.ks_2samp(ref, cur)
    drift = bool(ks_p < bonferroni_alpha and ks_stat > 0.1)
    status = "DRIFT" if drift else "STABLE"
    ks_results.append({
        "feature": feat,
        "metric_type": "KS",
        "value": float(ks_stat),
        "threshold": bonferroni_alpha,
        "status": status,
        "p_value": float(ks_p),
    })
    print(f"  KS[{feat:>17}]  D={ks_stat:6.4f}  p={ks_p:.2e}  -> {status}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Chi-Square — Categorical Drift
# MAGIC
# MAGIC Categorical drift via `scipy.stats.chi2_contingency`. Categories absent in
# MAGIC either window are filled with a Laplace count of 1 to avoid zero cells.

# COMMAND ----------

chi_results = []
for feat in CATEGORICAL_FEATURES:
    ref_counts = pdf_reference[feat].value_counts()
    cur_counts = pdf_current[feat].value_counts()
    categories = sorted(set(ref_counts.index) | set(cur_counts.index))
    contingency = np.array([
        [ref_counts.get(c, 0) + 1 for c in categories],
        [cur_counts.get(c, 0) + 1 for c in categories],
    ])
    chi2, p_val, dof, _ = stats.chi2_contingency(contingency)
    n = contingency.sum()
    cramers_v = math.sqrt(chi2 / (n * max(min(contingency.shape) - 1, 1)))
    drift = bool(p_val < CHI_PVALUE and cramers_v > 0.1)
    status = "DRIFT" if drift else "STABLE"
    chi_results.append({
        "feature": feat,
        "metric_type": "CHI_SQUARE",
        "value": float(chi2),
        "threshold": CHI_PVALUE,
        "status": status,
        "p_value": float(p_val),
        "cramers_v": float(cramers_v),
    })
    print(f"  Chi2[{feat:>17}] chi2={chi2:7.2f} p={p_val:.2e} V={cramers_v:.3f} -> {status}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Wasserstein Distance — Earth Mover's Distance
# MAGIC
# MAGIC Single, scale-invariant number. We calibrate the threshold against a
# MAGIC bootstrap of the reference window — drift = `> WASS_SIGMA_FACTOR × σ_baseline`.

# COMMAND ----------

def wasserstein_baseline_sigma(reference: pd.Series, n_iter: int = 30, sample_frac: float = 0.5) -> float:
    """Estimate intrinsic Wasserstein noise by bootstrapping two halves of the
    reference window and recording the distribution of distances."""
    rng = np.random.default_rng(0)
    arr = reference.dropna().to_numpy()
    if arr.size < 100:
        return 0.0
    distances = []
    for _ in range(n_iter):
        idx = rng.permutation(arr.size)
        cut = int(arr.size * sample_frac)
        distances.append(stats.wasserstein_distance(arr[idx[:cut]], arr[idx[cut:]]))
    return float(np.std(distances))


wass_results = []
for feat in NUMERIC_FEATURES:
    ref = pdf_reference[feat].dropna().to_numpy()
    cur = pdf_current[feat].dropna().to_numpy()
    if ref.size == 0 or cur.size == 0:
        continue
    wd = float(stats.wasserstein_distance(ref, cur))
    sigma = wasserstein_baseline_sigma(pdf_reference[feat])
    threshold = max(WASS_SIGMA_FACTOR * sigma, 1e-6)
    status = "DRIFT" if wd > threshold else "STABLE"
    wass_results.append({
        "feature": feat,
        "metric_type": "WASSERSTEIN",
        "value": wd,
        "threshold": threshold,
        "status": status,
    })
    print(f"  Wass[{feat:>17}] = {wd:9.4f}  threshold={threshold:9.4f}  -> {status}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Prediction Drift
# MAGIC
# MAGIC Compare the *output* score distribution between training-time and current
# MAGIC production. PSI on the prediction column with the same quantile-bin recipe.

# COMMAND ----------

prediction_psi = compute_psi(
    pdf_reference[PREDICTION_COLUMN], pdf_current[PREDICTION_COLUMN], n_bins=10
)
prediction_status = classify_psi(prediction_psi)
prediction_results = [{
    "feature": "__prediction__",
    "metric_type": "PREDICTION_PSI",
    "value": prediction_psi,
    "threshold": PSI_MODERATE,
    "status": prediction_status,
}]
print(f"  Prediction PSI = {prediction_psi:.4f}  -> {prediction_status}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Performance Drift
# MAGIC
# MAGIC When ground truth is available (revenue actuals reconciled N days later),
# MAGIC compute realized RMSE / MAPE on the current window and compare to the
# MAGIC training-time baseline. Threshold is relative degradation, not absolute.

# COMMAND ----------

def rmse(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float(np.sqrt(np.mean((y_true - y_pred) ** 2)))


def mape(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    mask = y_true > 0
    if mask.sum() == 0:
        return float("nan")
    return float(np.mean(np.abs((y_true[mask] - y_pred[mask]) / y_true[mask])))


ref_y = pdf_reference[TARGET_COLUMN].to_numpy()
ref_p = pdf_reference[PREDICTION_COLUMN].to_numpy()
cur_y = pdf_current[TARGET_COLUMN].to_numpy()
cur_p = pdf_current[PREDICTION_COLUMN].to_numpy()

baseline_rmse = rmse(ref_y, ref_p)
baseline_mape = mape(ref_y, ref_p)
current_rmse = rmse(cur_y, cur_p)
current_mape = mape(cur_y, cur_p)

rmse_delta_pct = (current_rmse - baseline_rmse) / max(baseline_rmse, 1e-9)
mape_delta_pct = (current_mape - baseline_mape) if not math.isnan(baseline_mape) else 0.0

rmse_status = "DRIFT" if rmse_delta_pct > PERF_RMSE_DELTA_PCT else "STABLE"
mape_status = "DRIFT" if mape_delta_pct > PERF_MAPE_DELTA_PCT else "STABLE"

performance_results = [
    {
        "feature": "__model_performance__",
        "metric_type": "RMSE_DELTA_PCT",
        "value": float(rmse_delta_pct),
        "threshold": PERF_RMSE_DELTA_PCT,
        "status": rmse_status,
    },
    {
        "feature": "__model_performance__",
        "metric_type": "MAPE_DELTA_PCT",
        "value": float(mape_delta_pct),
        "threshold": PERF_MAPE_DELTA_PCT,
        "status": mape_status,
    },
]
print(f"  Baseline RMSE = {baseline_rmse:.2f}   Current RMSE = {current_rmse:.2f}   Δ = {rmse_delta_pct*100:+.2f}%   -> {rmse_status}")
print(f"  Baseline MAPE = {baseline_mape:.4f}  Current MAPE = {current_mape:.4f}  Δ = {mape_delta_pct*100:+.2f}pp -> {mape_status}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Concept Drift Signals — Feature Importance Shift
# MAGIC
# MAGIC Train a tree-based proxy on each window and Spearman-correlate the
# MAGIC importance vectors. ρ < 0.7 is the documented "concept drift suspected"
# MAGIC trigger (relationship between X and y has changed even when X looks similar).

# COMMAND ----------

try:
    from sklearn.ensemble import GradientBoostingRegressor

    feature_cols = NUMERIC_FEATURES  # numeric-only proxy keeps the comparison apples-to-apples

    def fit_importance(pdf: pd.DataFrame) -> dict:
        model = GradientBoostingRegressor(n_estimators=80, max_depth=4, random_state=0)
        # Cap rows for speed — concept-drift signal is robust to subsampling
        subsample = pdf.sample(min(len(pdf), 5000), random_state=0)
        model.fit(subsample[feature_cols].fillna(0.0), subsample[TARGET_COLUMN])
        return dict(zip(feature_cols, model.feature_importances_))

    ref_importance = fit_importance(pdf_reference)
    cur_importance = fit_importance(pdf_current)

    ref_vec = np.array([ref_importance[f] for f in feature_cols])
    cur_vec = np.array([cur_importance[f] for f in feature_cols])
    spearman_rho, spearman_p = stats.spearmanr(ref_vec, cur_vec)
    concept_status = "CONCEPT_DRIFT" if spearman_rho < IMPORTANCE_SPEARMAN_FLOOR else "STABLE"

    print(f"  Reference importance: {ref_importance}")
    print(f"  Current importance:   {cur_importance}")
    print(f"  Spearman ρ = {spearman_rho:.4f}  p={spearman_p:.2e}  -> {concept_status}")
except ImportError:
    print("  scikit-learn not available; skipping concept-drift importance comparison.")
    spearman_rho = float("nan")
    concept_status = "UNKNOWN"

concept_results = [{
    "feature": "__feature_importance__",
    "metric_type": "IMPORTANCE_SPEARMAN",
    "value": float(spearman_rho) if not math.isnan(spearman_rho) else 0.0,
    "threshold": IMPORTANCE_SPEARMAN_FLOOR,
    "status": concept_status,
}]

# COMMAND ----------

# MAGIC %md
# MAGIC ## Aggregate Drift Severity
# MAGIC
# MAGIC Combine the strongest signals across the four drift categories into a
# MAGIC single severity tag. The on-call runbook keys off this — `P1` pages, `P2`
# MAGIC tickets, `P3` dashboards-only.

# COMMAND ----------

all_results = (
    psi_results + ks_results + chi_results + wass_results
    + prediction_results + performance_results + concept_results
)

# Sort PSI descending and grab top 3
top3_psi = sorted(
    [r for r in psi_results if not math.isnan(r["value"])],
    key=lambda r: r["value"],
    reverse=True,
)[:3]

severe_features = [r for r in psi_results if r["status"] == "SEVERE"]
significant_features = [r for r in psi_results if r["status"] == "SIGNIFICANT"]

prediction_drift_fired = prediction_status in ("SIGNIFICANT", "SEVERE")
performance_drift_fired = rmse_status == "DRIFT" or mape_status == "DRIFT"
concept_drift_fired = concept_status == "CONCEPT_DRIFT"

if severe_features or (performance_drift_fired and concept_drift_fired):
    severity = "P1"
elif significant_features or prediction_drift_fired or performance_drift_fired:
    severity = "P2"
elif any(r["status"] in ("MODERATE", "DRIFT") for r in all_results):
    severity = "P3"
else:
    severity = "HEALTHY"

print(f"  Severity:                  {severity}")
print(f"  Top-3 PSI features:        {[(r['feature'], round(r['value'], 3)) for r in top3_psi]}")
print(f"  Severe-drift features:     {[r['feature'] for r in severe_features]}")
print(f"  Prediction drift fired:    {prediction_drift_fired}")
print(f"  Performance drift fired:   {performance_drift_fired}")
print(f"  Concept drift fired:       {concept_drift_fired}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Persist Drift Metrics to `lh_gold.ml_drift_metrics`
# MAGIC
# MAGIC Append-only Delta table — one row per metric per run. This table is the
# MAGIC source of truth that feeds the Eventhouse `DriftMetrics` table (via
# MAGIC OneLake Shortcut) and the Real-Time Dashboard described in the drift doc.

# COMMAND ----------

drift_schema = StructType([
    StructField("run_id", StringType(), False),
    StructField("run_timestamp", TimestampType(), False),
    StructField("model_name", StringType(), False),
    StructField("model_version", StringType(), False),
    StructField("feature_name", StringType(), False),
    StructField("metric_type", StringType(), False),
    StructField("value", DoubleType(), True),
    StructField("threshold", DoubleType(), True),
    StructField("status", StringType(), False),
    StructField("severity", StringType(), False),
    StructField("reference_days", LongType(), False),
    StructField("current_days", LongType(), False),
])

drift_rows = [
    Row(
        run_id=RUN_ID,
        run_timestamp=RUN_TIMESTAMP,
        model_name=MODEL_NAME,
        model_version=MODEL_VERSION,
        feature_name=str(r["feature"]),
        metric_type=str(r["metric_type"]),
        value=float(r["value"]) if not math.isnan(float(r.get("value", float("nan")))) else None,
        threshold=float(r["threshold"]) if r.get("threshold") is not None else None,
        status=str(r["status"]),
        severity=severity,
        reference_days=REFERENCE_DAYS,
        current_days=CURRENT_DAYS,
    )
    for r in all_results
]

df_drift = spark.createDataFrame(drift_rows, schema=drift_schema)
(
    df_drift.write
    .format("delta")
    .mode("append")
    .option("mergeSchema", "true")
    .saveAsTable(DRIFT_TABLE)
)
print(f"  Wrote {df_drift.count()} drift metric rows to {DRIFT_TABLE}")

# Log run-level summary metrics to MLflow for trend tracking
try:
    mlflow.set_experiment(f"/Shared/{MODEL_NAME}_drift")
    with mlflow.start_run(run_name=f"drift-{RUN_TIMESTAMP:%Y%m%d-%H%M}"):
        mlflow.log_param("model_name", MODEL_NAME)
        mlflow.log_param("model_version", MODEL_VERSION)
        mlflow.log_param("severity", severity)
        for r in psi_results:
            mlflow.log_metric(f"psi_{r['feature']}", r["value"])
        mlflow.log_metric("prediction_psi", prediction_psi)
        mlflow.log_metric("rmse_delta_pct", rmse_delta_pct)
        mlflow.log_metric("mape_delta_pct", mape_delta_pct)
        if not math.isnan(spearman_rho):
            mlflow.log_metric("importance_spearman", spearman_rho)
except Exception as exc:  # noqa: BLE001 — MLflow is best-effort here
    print(f"  MLflow logging skipped: {exc}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Alert Wiring — KQL Reference
# MAGIC
# MAGIC The drift table is the contract. The matching KQL alert lives in the
# MAGIC Workspace-Monitoring Eventhouse and runs every hour. The full alert + the
# MAGIC severity matrix are documented in the drift best-practice doc; the cool-down
# MAGIC pattern is in the MLOps anchor (`§ Retraining Triggers`). The KQL below is
# MAGIC for reference only — paste into the `ml_monitoring` Eventhouse to enable.
# MAGIC
# MAGIC ```kql
# MAGIC // P1 alert — severe PSI sustained on the slot-revenue model
# MAGIC ml_drift_metrics
# MAGIC | where model_name == "casino-slot-revenue-gbt"
# MAGIC | where metric_type == "PSI"
# MAGIC | where run_timestamp > ago(72h)
# MAGIC | summarize WindowsOver = countif(value > 0.25) by feature_name
# MAGIC | where WindowsOver >= 3
# MAGIC ```
# MAGIC
# MAGIC See `docs/best-practices/operations/slo-sli-fabric.md` (SLO definitions)
# MAGIC and `docs/best-practices/operations/observability-stack.md` (Action Group
# MAGIC routing) for the full wiring.

# COMMAND ----------

# MAGIC %md
# MAGIC ## Retraining Decision
# MAGIC
# MAGIC If any drift category exceeds its retraining threshold AND the cool-down
# MAGIC window has elapsed, append a row to `lh_gold.ml_retrain_triggers`. The
# MAGIC consumer is the retraining Logic App / Fabric Pipeline.

# COMMAND ----------

retrain_reasons = []
if severe_features:
    retrain_reasons.append(
        f"SEVERE_INPUT_DRIFT: {[r['feature'] for r in severe_features]} > PSI {PSI_SEVERE}"
    )
if len(significant_features) >= 3:
    retrain_reasons.append(
        f"MULTI_FEATURE_DRIFT: {len(significant_features)} features > PSI {PSI_MODERATE}"
    )
if prediction_drift_fired:
    retrain_reasons.append(f"PREDICTION_DRIFT: PSI {prediction_psi:.3f}")
if rmse_status == "DRIFT":
    retrain_reasons.append(f"PERF_RMSE_DEGRADATION: {rmse_delta_pct*100:+.1f}%")
if mape_status == "DRIFT":
    retrain_reasons.append(f"PERF_MAPE_DEGRADATION: {mape_delta_pct*100:+.1f}pp")
if concept_drift_fired:
    retrain_reasons.append(f"CONCEPT_DRIFT: importance_rho={spearman_rho:.3f}")

cool_down_days = 7  # see drift doc § Retraining Trigger Patterns
should_retrain = bool(retrain_reasons)

if should_retrain:
    # Honor cool-down: skip if last retrain trigger fired within the window
    if spark.catalog.tableExists(RETRAIN_TABLE):
        last_trigger = (
            spark.table(RETRAIN_TABLE)
            .where(col("model_name") == MODEL_NAME)
            .orderBy(col("triggered_at").desc())
            .limit(1)
            .collect()
        )
        if last_trigger:
            since_last = RUN_TIMESTAMP - last_trigger[0]["triggered_at"]
            if since_last < timedelta(days=cool_down_days):
                print(
                    f"  Cool-down active ({since_last.days}d < {cool_down_days}d). "
                    "Drift signals detected but suppressing retrain trigger."
                )
                should_retrain = False

if should_retrain:
    retrain_schema = StructType([
        StructField("trigger_id", StringType(), False),
        StructField("triggered_at", TimestampType(), False),
        StructField("model_name", StringType(), False),
        StructField("model_version", StringType(), False),
        StructField("severity", StringType(), False),
        StructField("reasons", StringType(), False),
        StructField("drift_run_id", StringType(), False),
        StructField("status", StringType(), False),
    ])
    retrain_row = Row(
        trigger_id=str(uuid.uuid4()),
        triggered_at=RUN_TIMESTAMP,
        model_name=MODEL_NAME,
        model_version=MODEL_VERSION,
        severity=severity,
        reasons=" | ".join(retrain_reasons),
        drift_run_id=RUN_ID,
        status="PENDING",
    )
    df_retrain = spark.createDataFrame([retrain_row], schema=retrain_schema)
    (
        df_retrain.write
        .format("delta")
        .mode("append")
        .option("mergeSchema", "true")
        .saveAsTable(RETRAIN_TABLE)
    )
    print(f"  Retrain trigger written to {RETRAIN_TABLE}")
    for reason in retrain_reasons:
        print(f"    - {reason}")
else:
    if not retrain_reasons:
        print("  No retrain trigger — all drift categories within thresholds.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Run Summary

# COMMAND ----------

print("=" * 72)
print(f"Drift Detection Run Summary — {RUN_TIMESTAMP:%Y-%m-%d %H:%M UTC}")
print("=" * 72)
print(f"Model:                       {MODEL_NAME} {MODEL_VERSION}")
print(f"Run ID:                      {RUN_ID}")
print(f"Severity:                    {severity}")
print(f"Total metrics computed:      {len(all_results)}")
print(f"Features w/ PSI > 0.20:      {len(significant_features) + len(severe_features)}")
print(f"Prediction drift fired:      {prediction_drift_fired}")
print(f"Performance drift fired:     {performance_drift_fired}")
print(f"Concept drift fired:         {concept_drift_fired}")
print(f"Retrain triggered:           {should_retrain}")
print(f"Drift metrics table:         {DRIFT_TABLE}")
print(f"Retrain triggers table:      {RETRAIN_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cleanup

# COMMAND ----------

# Release pandas frames so the executor can reclaim memory between runs
del pdf_reference, pdf_current
df_reference.unpersist()
df_current.unpersist()

print("Drift detection notebook complete.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Production Deployment Notes
# MAGIC
# MAGIC 1. **Schedule:** Daily (batch) at 04:00 UTC via Fabric Pipeline; hourly for
# MAGIC    streaming models. Match window length to inference cadence.
# MAGIC 2. **Reference refresh:** Rebuild `lh_gold.reference_distribution` on every
# MAGIC    model retrain. Pin the version to the MLflow run id.
# MAGIC 3. **Eventhouse:** Mirror `ml_drift_metrics` and `ml_retrain_triggers` into
# MAGIC    the `ml_monitoring` Eventhouse via OneLake Shortcut for KQL alerts.
# MAGIC 4. **Cool-down:** 7 days for drift-only triggers, 14 days for performance,
# MAGIC    30 days (with human review) for concept drift.
# MAGIC 5. **Seasonality:** Join `lh_gold.special_event_calendar` in the alert KQL
# MAGIC    to suppress holiday / event-driven false positives.
# MAGIC 6. **Compliance:** Drift on AML/fraud models is a SAR-reporting concern —
# MAGIC    fraud-model drift is P0 and pages the AML team.
# MAGIC 7. **Runbook:** `docs/runbooks/incident-response-template.md` — "what to do
# MAGIC    when drift fires" must be linked from every P1 alert.
