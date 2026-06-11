# Databricks notebook source
# MAGIC %md
# MAGIC # MLOps: Model Registry + Champion/Challenger Promotion
# MAGIC
# MAGIC **Layer:** ML | **Domain:** Casino | **Phase:** 14 Wave 2 (Feature 2.9)
# MAGIC
# MAGIC Anchor notebook for the MLOps story. Demonstrates the full production lifecycle
# MAGIC of a model in Fabric MLflow: register, version, validate, stage, evaluate, and
# MAGIC promote — with all five validation gates from the MLOps anchor doc.
# MAGIC
# MAGIC ## What this notebook proves
# MAGIC - **Reproducibility:** every run captures data version, code SHA, env, params
# MAGIC - **Versioning:** baseline + challenger registered in MLflow registry
# MAGIC - **Validation gates:** performance threshold, holdout stability, calibration
# MAGIC - **Promotion discipline:** stage transitions via `MlflowClient`, never UI-driven
# MAGIC - **Champion/challenger:** continuous evaluation pattern with audit trail
# MAGIC - **Audit log:** every promotion event written to `lh_gold.ml_promotion_audit`
# MAGIC
# MAGIC ## Anchor doc
# MAGIC See `docs/best-practices/mlops-fabric-production.md` — sections "Model Registry",
# MAGIC "Validation Gates", and "Champion-Challenger".

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup
# MAGIC
# MAGIC We import sklearn (lightweight, stable in Fabric runtimes) for the two algorithms.
# MAGIC sklearn keeps this notebook self-contained — no exotic dependencies — while still
# MAGIC demonstrating the full MLflow lifecycle. The same pattern works with
# MAGIC `pyspark.ml`, XGBoost, LightGBM, or Prophet.

# COMMAND ----------

import os
from datetime import datetime, timedelta

import mlflow
import mlflow.sklearn
import numpy as np
import pandas as pd
from mlflow.models.signature import infer_signature
from mlflow.tracking import MlflowClient
from pyspark.sql import Row
from pyspark.sql.functions import col, current_timestamp, lit, to_date
from pyspark.sql.types import (
    DateType,
    DoubleType,
    LongType,
    StringType,
    StructField,
    StructType,
)

# sklearn — chosen for stability and small artifact size; the registry pattern is
# identical for any ML library MLflow supports.
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.preprocessing import StandardScaler

# --- Source / target tables (lh_gold namespace per repo conventions) ---
SOURCE_TABLE = "lh_gold.fact_daily_slot_revenue"
CHAMPION_CHALLENGER_TABLE = "lh_gold.ml_champion_challenger"
PROMOTION_AUDIT_TABLE = "lh_gold.ml_promotion_audit"

# --- Model identity ---
MODEL_BASELINE = "casino-slot-revenue-forecast-baseline"
MODEL_CHALLENGER = "casino-slot-revenue-forecast-challenger"
EXPERIMENT_NAME = "/Shared/casino-slot-revenue-forecast"

# --- Validation gate thresholds (mirrors anchor doc) ---
RELATIVE_AUC_LIFT_REQUIRED = 0.01  # challenger must beat baseline by >= 1% R2
HOLDOUT_DRIFT_TOLERANCE_PCT = 5.0  # mean prediction drift on holdout
CALIBRATION_ECE_MAX = 0.10  # expected calibration error ceiling
CONSECUTIVE_WINS_REQUIRED = 7  # challenger must win 7 windows to promote

# --- Reproducibility metadata ---
# In CI these come from GH Actions; locally we fall back to "unknown" / "manual"
GIT_SHA = os.environ.get("GIT_SHA", "unknown")
GIT_BRANCH = os.environ.get("GIT_BRANCH", "main")
ACTOR = os.environ.get("GITHUB_ACTOR", "manual-run")
RUN_INTENT = os.environ.get("MLFLOW_RUN_INTENT", "production-candidate")

print(f"MLflow tracking URI: {mlflow.get_tracking_uri()}")
print(f"Experiment: {EXPERIMENT_NAME}")
print(f"Code SHA: {GIT_SHA} | Branch: {GIT_BRANCH} | Actor: {ACTOR}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Load Training Data (with defensive synthesis)
# MAGIC
# MAGIC Real Fabric workspaces will already have `lh_gold.fact_daily_slot_revenue` populated
# MAGIC by the medallion pipeline. For demo / test environments we synthesize a plausible
# MAGIC year of slot-revenue data so the notebook runs end-to-end without prerequisites.
# MAGIC The synthesis is deterministic (fixed seed) so champion/challenger comparisons
# MAGIC are reproducible across notebook runs.

# COMMAND ----------

if not spark.catalog.tableExists(SOURCE_TABLE):
    # Defensive synthesis — same seed gives same data, so the gates behave deterministically.
    print(f"Table {SOURCE_TABLE} not found. Synthesizing demo data...")
    rng = np.random.default_rng(seed=42)

    n_days = 365
    n_machines = 50
    base_date = datetime.now().date() - timedelta(days=n_days)

    rows = []
    for d in range(n_days):
        rev_date = base_date + timedelta(days=d)
        # Weekly seasonality: weekends earn ~30% more
        weekday_factor = 1.3 if rev_date.weekday() >= 5 else 1.0
        # Monthly seasonality: revenue dips early month, peaks mid-month
        month_factor = 1.0 + 0.15 * np.sin((rev_date.day / 31.0) * np.pi)
        for m in range(n_machines):
            machine_id = f"SLOT-{m:04d}"
            denom = float(rng.choice([0.01, 0.05, 0.25, 1.00, 5.00]))
            handle = float(rng.normal(8000, 2000)) * weekday_factor * month_factor
            handle = max(handle, 100.0)
            hold_pct = float(rng.uniform(0.05, 0.12))
            revenue = handle * hold_pct + float(rng.normal(0, 50))
            rows.append(Row(
                revenue_date=rev_date,
                machine_id=machine_id,
                denomination=denom,
                handle=round(handle, 2),
                hold_pct=round(hold_pct, 4),
                games_played=int(handle / max(denom, 0.01) / 3),
                unique_players=int(rng.integers(5, 80)),
                avg_session_minutes=float(rng.uniform(15, 90)),
                revenue=round(revenue, 2),
            ))

    schema = StructType([
        StructField("revenue_date", DateType(), False),
        StructField("machine_id", StringType(), False),
        StructField("denomination", DoubleType(), False),
        StructField("handle", DoubleType(), False),
        StructField("hold_pct", DoubleType(), False),
        StructField("games_played", LongType(), False),
        StructField("unique_players", LongType(), False),
        StructField("avg_session_minutes", DoubleType(), False),
        StructField("revenue", DoubleType(), False),
    ])
    df_source = spark.createDataFrame(rows, schema=schema)
    df_source.write.format("delta").mode("overwrite").saveAsTable(SOURCE_TABLE)
    print(f"Synthesized {df_source.count():,} rows into {SOURCE_TABLE}")

df = spark.table(SOURCE_TABLE)
print(f"Loaded {df.count():,} rows from {SOURCE_TABLE}")
df.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Capture Data Version (Reproducibility Anchor)
# MAGIC
# MAGIC Logging the Delta version with every MLflow run makes any model fully
# MAGIC reproducible — we can `RESTORE` the table to that version and retrain bit-exact.
# MAGIC This is the single most important reproducibility primitive in Fabric MLOps.

# COMMAND ----------

try:
    history = spark.sql(f"DESCRIBE HISTORY {SOURCE_TABLE} LIMIT 1").collect()
    data_version = int(history[0]["version"])
except Exception as e:
    # Synthesized tables on first run may not have history yet
    print(f"No Delta history available ({e}); defaulting to version 0")
    data_version = 0
print(f"Training data Delta version: {data_version}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Feature Engineering
# MAGIC
# MAGIC We forecast next-day revenue per machine. Features are simple, leak-free
# MAGIC aggregates of prior-day activity. The point of this notebook is the *registry*
# MAGIC and *promotion* lifecycle, not state-of-the-art forecasting — so we keep
# MAGIC features intentionally readable.

# COMMAND ----------

pdf = df.toPandas().sort_values(["machine_id", "revenue_date"])
pdf["revenue_date"] = pd.to_datetime(pdf["revenue_date"])

# Lag features per machine (no leakage — strict prior-day shift)
pdf["lag1_revenue"] = pdf.groupby("machine_id")["revenue"].shift(1)
pdf["lag1_handle"] = pdf.groupby("machine_id")["handle"].shift(1)
pdf["lag7_revenue"] = pdf.groupby("machine_id")["revenue"].shift(7)
pdf["rolling7_revenue"] = (
    pdf.groupby("machine_id")["revenue"].shift(1).rolling(7).mean().reset_index(0, drop=True)
)
pdf["dow"] = pdf["revenue_date"].dt.dayofweek
pdf["dom"] = pdf["revenue_date"].dt.day

feature_cols = [
    "lag1_revenue", "lag1_handle", "lag7_revenue", "rolling7_revenue",
    "denomination", "unique_players", "avg_session_minutes", "dow", "dom",
]
target_col = "revenue"

pdf_clean = pdf.dropna(subset=feature_cols + [target_col]).reset_index(drop=True)
print(f"Modeling rows after lag drop: {len(pdf_clean):,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Train / Validation / Holdout Split
# MAGIC
# MAGIC Three-way time-based split. The **holdout is permanent and never touched during
# MAGIC training or hyperparameter selection** — anchor doc anti-pattern: "no holdout set".
# MAGIC In production this holdout lives in OneLake at a stable path with read-only ACL.

# COMMAND ----------

# Time-ordered split: oldest 70% train, next 15% validation, most recent 15% holdout
pdf_sorted = pdf_clean.sort_values("revenue_date").reset_index(drop=True)
n = len(pdf_sorted)
train_end = int(n * 0.70)
val_end = int(n * 0.85)

train_df = pdf_sorted.iloc[:train_end]
val_df = pdf_sorted.iloc[train_end:val_end]
holdout_df = pdf_sorted.iloc[val_end:]

X_train, y_train = train_df[feature_cols], train_df[target_col]
X_val, y_val = val_df[feature_cols], val_df[target_col]
X_holdout, y_holdout = holdout_df[feature_cols], holdout_df[target_col]

# Scale once on train; reuse for val + holdout (scaler logged with each model)
scaler = StandardScaler().fit(X_train)
X_train_s = scaler.transform(X_train)
X_val_s = scaler.transform(X_val)
X_holdout_s = scaler.transform(X_holdout)

print(f"Train: {len(train_df):,} | Validation: {len(val_df):,} | Holdout: {len(holdout_df):,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Set MLflow Experiment

# COMMAND ----------

mlflow.set_experiment(EXPERIMENT_NAME)


def _common_tags(intent: str) -> dict:
    """Tags applied to every run. The anchor doc requires branch, PR, author, intent."""
    return {
        "branch": GIT_BRANCH,
        "author": ACTOR,
        "intent": intent,
        "domain": "casino",
        "task": "slot-revenue-forecast",
    }


def _evaluate_regressor(model, X, y) -> dict:
    """Compute the regression metrics we gate on. R2 is the headline metric."""
    preds = model.predict(X)
    return {
        "r2": float(r2_score(y, preds)),
        "rmse": float(np.sqrt(mean_squared_error(y, preds))),
        "mae": float(mean_absolute_error(y, preds)),
    }


# COMMAND ----------

# MAGIC %md
# MAGIC ## Train Baseline Model — Ridge Regression
# MAGIC
# MAGIC Ridge plays the "current production" role. It's linear, fast, and has well-
# MAGIC understood failure modes. Many real-world casino-revenue baselines look like this.

# COMMAND ----------

with mlflow.start_run(run_name="baseline_ridge") as baseline_run:
    mlflow.set_tags(_common_tags("baseline"))

    # Hyperparameters
    baseline_params = {"alpha": 1.0, "solver": "auto", "random_state": 42}
    mlflow.log_params(baseline_params)
    mlflow.log_param("algo", "ridge")
    mlflow.log_param("features", feature_cols)

    # Reproducibility metadata — anchor doc requires these on every run
    mlflow.log_param("training_data_table", SOURCE_TABLE)
    mlflow.log_param("training_data_version", data_version)
    mlflow.log_param("git_sha", GIT_SHA)
    mlflow.log_param("training_rows", len(train_df))

    baseline_model = Ridge(**baseline_params).fit(X_train_s, y_train)

    # Validation metrics (val set, not holdout)
    val_metrics = _evaluate_regressor(baseline_model, X_val_s, y_val)
    mlflow.log_metrics({f"val_{k}": v for k, v in val_metrics.items()})

    # Signature lets MLflow validate inputs at inference time
    signature = infer_signature(X_train, baseline_model.predict(X_train_s))
    mlflow.sklearn.log_model(
        baseline_model, "model", signature=signature,
        registered_model_name=MODEL_BASELINE,
    )
    mlflow.sklearn.log_model(scaler, "scaler")

    baseline_run_id = baseline_run.info.run_id
    baseline_val_r2 = val_metrics["r2"]

print(f"Baseline run: {baseline_run_id}")
print(f"Baseline validation R2: {baseline_val_r2:.4f}, RMSE: {val_metrics['rmse']:.2f}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Train Challenger Model — Random Forest
# MAGIC
# MAGIC The challenger uses a non-linear ensemble. Same features, same data, same target.
# MAGIC Different inductive bias — and that's exactly what we want to test.

# COMMAND ----------

with mlflow.start_run(run_name="challenger_random_forest") as challenger_run:
    mlflow.set_tags(_common_tags(RUN_INTENT))

    challenger_params = {
        "n_estimators": 200, "max_depth": 12, "min_samples_leaf": 5,
        "n_jobs": -1, "random_state": 42,
    }
    mlflow.log_params(challenger_params)
    mlflow.log_param("algo", "random_forest")
    mlflow.log_param("features", feature_cols)
    mlflow.log_param("training_data_table", SOURCE_TABLE)
    mlflow.log_param("training_data_version", data_version)
    mlflow.log_param("git_sha", GIT_SHA)
    mlflow.log_param("training_rows", len(train_df))

    challenger_model = RandomForestRegressor(**challenger_params).fit(X_train_s, y_train)

    val_metrics_c = _evaluate_regressor(challenger_model, X_val_s, y_val)
    mlflow.log_metrics({f"val_{k}": v for k, v in val_metrics_c.items()})

    signature = infer_signature(X_train, challenger_model.predict(X_train_s))
    mlflow.sklearn.log_model(
        challenger_model, "model", signature=signature,
        registered_model_name=MODEL_CHALLENGER,
    )
    mlflow.sklearn.log_model(scaler, "scaler")

    challenger_run_id = challenger_run.info.run_id
    challenger_val_r2 = val_metrics_c["r2"]

print(f"Challenger run: {challenger_run_id}")
print(f"Challenger validation R2: {challenger_val_r2:.4f}, RMSE: {val_metrics_c['rmse']:.2f}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation Gate 1 — Performance Threshold
# MAGIC
# MAGIC Anchor doc: challenger must beat baseline by a meaningful margin. We require
# MAGIC at least 1% absolute R2 lift. Without this gate, harmless-looking ties would
# MAGIC flip champions on noise.

# COMMAND ----------

gate1_lift = challenger_val_r2 - baseline_val_r2
gate1_passed = gate1_lift >= RELATIVE_AUC_LIFT_REQUIRED

print(f"Gate 1 — Performance Threshold")
print(f"  Baseline R2:   {baseline_val_r2:.4f}")
print(f"  Challenger R2: {challenger_val_r2:.4f}")
print(f"  Required lift: {RELATIVE_AUC_LIFT_REQUIRED:+.4f}")
print(f"  Actual lift:   {gate1_lift:+.4f}")
print(f"  Result:        {'PASS' if gate1_passed else 'FAIL'}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation Gate 2 — Holdout Stability
# MAGIC
# MAGIC Run inference on the never-touched holdout. Compare the *distribution* of
# MAGIC predictions against the actuals. A model that overfit the validation set
# MAGIC tends to produce wildly different prediction distributions on holdout vs val.

# COMMAND ----------

holdout_preds = challenger_model.predict(X_holdout_s)
mean_pred = float(np.mean(holdout_preds))
mean_actual = float(np.mean(y_holdout))
gate2_drift_pct = abs(mean_pred - mean_actual) / max(mean_actual, 1e-9) * 100.0
gate2_passed = gate2_drift_pct < HOLDOUT_DRIFT_TOLERANCE_PCT

print(f"Gate 2 — Holdout Stability")
print(f"  Mean actual:     {mean_actual:.2f}")
print(f"  Mean prediction: {mean_pred:.2f}")
print(f"  Drift:           {gate2_drift_pct:.2f}% (tolerance {HOLDOUT_DRIFT_TOLERANCE_PCT}%)")
print(f"  Result:          {'PASS' if gate2_passed else 'FAIL'}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation Gate 3 — Calibration (ECE)
# MAGIC
# MAGIC Calibration matters even for regression: when we forecast revenue per bucket
# MAGIC we want predictions in bucket B to average close to actuals in bucket B.
# MAGIC We compute a binned **Expected Calibration Error** (ECE) by quantile bin —
# MAGIC the regression analogue of probability calibration.

# COMMAND ----------

def regression_ece(y_true: np.ndarray, y_pred: np.ndarray, n_bins: int = 10) -> float:
    """Bin predictions by quantile; ECE = weighted mean abs(bin_pred - bin_actual) / scale.

    Why quantile bins, not equal-width: equal-width bins get sparse in the tails and
    over-report calibration error there. Quantile bins give equal mass per bin.
    """
    if len(y_true) < n_bins:
        return 1.0
    quantiles = np.quantile(y_pred, np.linspace(0, 1, n_bins + 1))
    quantiles = np.unique(quantiles)
    if len(quantiles) < 2:
        return 1.0
    bins = np.digitize(y_pred, quantiles[1:-1])
    scale = np.mean(np.abs(y_true)) + 1e-9
    weighted_err = 0.0
    total = len(y_true)
    for b in np.unique(bins):
        mask = bins == b
        if mask.sum() == 0:
            continue
        weighted_err += (mask.sum() / total) * abs(y_true[mask].mean() - y_pred[mask].mean())
    return float(weighted_err / scale)


ece = regression_ece(y_holdout.to_numpy(), holdout_preds, n_bins=10)
gate3_passed = ece < CALIBRATION_ECE_MAX

print(f"Gate 3 — Calibration (ECE)")
print(f"  ECE:        {ece:.4f}")
print(f"  Max ECE:    {CALIBRATION_ECE_MAX}")
print(f"  Result:     {'PASS' if gate3_passed else 'FAIL'}")

# Log gate outcomes back to the challenger run for audit
with mlflow.start_run(run_id=challenger_run_id):
    mlflow.log_metrics({
        "gate1_lift": gate1_lift,
        "gate2_holdout_drift_pct": gate2_drift_pct,
        "gate3_ece": ece,
    })
    mlflow.set_tag("gate1_passed", str(gate1_passed))
    mlflow.set_tag("gate2_passed", str(gate2_passed))
    mlflow.set_tag("gate3_passed", str(gate3_passed))

all_gates_passed = gate1_passed and gate2_passed and gate3_passed
print(f"\nAll gates passed: {all_gates_passed}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Stage Transition: Challenger → Staging
# MAGIC
# MAGIC When the gates pass we move the new challenger version into Staging.
# MAGIC Staging is where the champion/challenger evaluation runs. Production stays
# MAGIC untouched. Per anchor doc: never click-promote in the UI for production models.

# COMMAND ----------

client = MlflowClient()


def _latest_version(model_name: str) -> str:
    """Get the most recent version for a registered model (any stage)."""
    versions = client.search_model_versions(f"name='{model_name}'")
    if not versions:
        raise RuntimeError(f"No versions found for {model_name}")
    return max(versions, key=lambda v: int(v.version)).version


challenger_version = _latest_version(MODEL_CHALLENGER)
baseline_version = _latest_version(MODEL_BASELINE)

if all_gates_passed:
    client.transition_model_version_stage(
        name=MODEL_CHALLENGER,
        version=challenger_version,
        stage="Staging",
        archive_existing_versions=False,  # keep prior staging for comparison
    )
    print(f"{MODEL_CHALLENGER} v{challenger_version} -> Staging")
else:
    print(f"{MODEL_CHALLENGER} v{challenger_version} held at None (gates failed)")

# Baseline is treated as the current Production (champion) for this demo.
# In real ops, the existing production model already lives at this stage.
try:
    current_prod = client.get_latest_versions(MODEL_BASELINE, stages=["Production"])
except Exception:
    current_prod = []

if not current_prod:
    client.transition_model_version_stage(
        name=MODEL_BASELINE,
        version=baseline_version,
        stage="Production",
        archive_existing_versions=True,
    )
    print(f"{MODEL_BASELINE} v{baseline_version} -> Production (initial champion)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Champion/Challenger Evaluation
# MAGIC
# MAGIC Both models score the same data. We log per-window metrics and a binary
# MAGIC `challenger_won` flag to `lh_gold.ml_champion_challenger`. The promotion
# MAGIC trigger reads this table — we never trust a single evaluation window.

# COMMAND ----------

# Load both as registered model URIs (stage references — never pin a version in client code)
champion_uri = f"models:/{MODEL_BASELINE}/Production"
challenger_uri = (
    f"models:/{MODEL_CHALLENGER}/Staging" if all_gates_passed
    else f"runs:/{challenger_run_id}/model"
)
champion = mlflow.sklearn.load_model(champion_uri)
challenger = mlflow.sklearn.load_model(challenger_uri)

# Score the holdout set as today's evaluation window. In real ops this is a
# rolling daily pipeline; here we simulate 8 windows by chunking the holdout.
n_windows = 8
chunks = np.array_split(holdout_df.reset_index(drop=True), n_windows)

evaluation_rows = []
eval_ts = datetime.utcnow()
for i, chunk in enumerate(chunks):
    if len(chunk) == 0:
        continue
    Xc = scaler.transform(chunk[feature_cols])
    yc = chunk[target_col].to_numpy()
    champ_pred = champion.predict(Xc)
    chall_pred = challenger.predict(Xc)
    champ_r2 = float(r2_score(yc, champ_pred)) if len(yc) > 1 else 0.0
    chall_r2 = float(r2_score(yc, chall_pred)) if len(yc) > 1 else 0.0
    evaluation_rows.append(Row(
        evaluation_window=eval_ts - timedelta(days=n_windows - i),
        model_family="casino-slot-revenue-forecast",
        champion_name=MODEL_BASELINE,
        champion_version=str(baseline_version),
        champion_r2=champ_r2,
        champion_rmse=float(np.sqrt(mean_squared_error(yc, champ_pred))),
        challenger_name=MODEL_CHALLENGER,
        challenger_version=str(challenger_version),
        challenger_r2=chall_r2,
        challenger_rmse=float(np.sqrt(mean_squared_error(yc, chall_pred))),
        challenger_won=bool(chall_r2 > champ_r2),
        rows_scored=int(len(chunk)),
        data_version=int(data_version),
        git_sha=str(GIT_SHA),
    ))

cc_df = spark.createDataFrame(evaluation_rows)
cc_df.write.format("delta").mode("append").option(
    "mergeSchema", "true"
).saveAsTable(CHAMPION_CHALLENGER_TABLE)

cc_df.orderBy("evaluation_window").show(truncate=False)
print(f"Logged {len(evaluation_rows)} evaluation windows to {CHAMPION_CHALLENGER_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Promote-to-Production Gate
# MAGIC
# MAGIC Anchor doc: "When challenger beats champion on agreed metrics for N consecutive
# MAGIC evaluation windows, promote." We require 7 consecutive wins. This is deliberately
# MAGIC strict — flipping a production model is far more expensive than waiting a week.

# COMMAND ----------

recent = (
    spark.table(CHAMPION_CHALLENGER_TABLE)
    .filter(col("model_family") == "casino-slot-revenue-forecast")
    .orderBy(col("evaluation_window").desc())
    .limit(CONSECUTIVE_WINS_REQUIRED)
    .collect()
)

consecutive_wins = sum(1 for r in recent if r["challenger_won"])
should_promote = (
    len(recent) >= CONSECUTIVE_WINS_REQUIRED
    and consecutive_wins == CONSECUTIVE_WINS_REQUIRED
    and all_gates_passed
)

print(f"Recent windows examined: {len(recent)}")
print(f"Challenger wins:         {consecutive_wins} / {CONSECUTIVE_WINS_REQUIRED}")
print(f"Promote to Production:   {should_promote}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Production Promotion (with archive of prior champion)
# MAGIC
# MAGIC `archive_existing_versions=True` archives the old Production version atomically.
# MAGIC This guarantees we never have two Production versions of the same model.

# COMMAND ----------

promotion_event = {
    "promoted": False,
    "from_stage": None,
    "to_stage": None,
    "reason": None,
}

if should_promote:
    client.transition_model_version_stage(
        name=MODEL_CHALLENGER,
        version=challenger_version,
        stage="Production",
        archive_existing_versions=True,
    )
    promotion_event.update(
        promoted=True, from_stage="Staging", to_stage="Production",
        reason=f"Challenger won {CONSECUTIVE_WINS_REQUIRED} consecutive windows",
    )
    print(f"PROMOTED: {MODEL_CHALLENGER} v{challenger_version} -> Production")
else:
    promotion_event["reason"] = (
        "Insufficient consecutive wins" if all_gates_passed
        else "Validation gates failed"
    )
    print(f"No promotion — {promotion_event['reason']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Audit Log — Every Promotion Event Captured
# MAGIC
# MAGIC Promotions are regulatory events (NIGC MICS, audit trails). We write a row to
# MAGIC `lh_gold.ml_promotion_audit` for every attempted promotion — promoted or not —
# MAGIC with the full context needed for later forensics: who, when, which version,
# MAGIC which gates, which metrics.

# COMMAND ----------

audit_row = Row(
    event_timestamp=datetime.utcnow(),
    model_name=MODEL_CHALLENGER,
    model_version=str(challenger_version),
    promoted=bool(promotion_event["promoted"]),
    from_stage=promotion_event["from_stage"] or "None",
    to_stage=promotion_event["to_stage"] or "None",
    reason=str(promotion_event["reason"]),
    approver=ACTOR,
    git_sha=str(GIT_SHA),
    git_branch=str(GIT_BRANCH),
    data_version=int(data_version),
    baseline_r2=float(baseline_val_r2),
    challenger_r2=float(challenger_val_r2),
    gate1_passed=bool(gate1_passed),
    gate2_passed=bool(gate2_passed),
    gate3_passed=bool(gate3_passed),
    consecutive_wins=int(consecutive_wins),
    consecutive_wins_required=int(CONSECUTIVE_WINS_REQUIRED),
)
audit_df = spark.createDataFrame([audit_row]).withColumn(
    "_audit_inserted_at", current_timestamp()
)
audit_df.write.format("delta").mode("append").option(
    "mergeSchema", "true"
).saveAsTable(PROMOTION_AUDIT_TABLE)

print(f"Audit row written to {PROMOTION_AUDIT_TABLE}")
spark.table(PROMOTION_AUDIT_TABLE).orderBy(col("event_timestamp").desc()).show(5, truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cleanup & Maintenance
# MAGIC
# MAGIC Vacuum old Delta files to keep storage costs sane. The 168-hour (7-day)
# MAGIC retention is the Fabric default — long enough for time-travel debugging,
# MAGIC short enough to avoid storage bloat. Use `RETAIN 0 HOURS` only with extreme
# MAGIC care; you lose all time-travel history.

# COMMAND ----------

for tbl in [CHAMPION_CHALLENGER_TABLE, PROMOTION_AUDIT_TABLE]:
    try:
        spark.sql(f"VACUUM {tbl} RETAIN 168 HOURS")
        print(f"Vacuumed {tbl}")
    except Exception as e:
        print(f"Vacuum skipped for {tbl}: {e}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Run Summary
# MAGIC
# MAGIC The full lifecycle for one promotion cycle:
# MAGIC
# MAGIC 1. Loaded training data + captured Delta version for reproducibility
# MAGIC 2. Trained baseline (Ridge) and challenger (RandomForest), both registered in MLflow
# MAGIC 3. Ran 3 validation gates: performance threshold, holdout stability, calibration
# MAGIC 4. Transitioned challenger to Staging if gates passed
# MAGIC 5. Ran 8-window champion/challenger evaluation, logged to Gold
# MAGIC 6. Checked 7-consecutive-wins promotion criterion
# MAGIC 7. Promoted to Production (or held) with archive of prior version
# MAGIC 8. Wrote audit row capturing the full event context
# MAGIC
# MAGIC ## Next Steps for Production
# MAGIC
# MAGIC - Schedule this notebook daily via Fabric Pipeline (one window per run)
# MAGIC - Wire `lh_gold.ml_promotion_audit` to a Power BI dashboard for ML governance
# MAGIC - Add Gate 4 (latency) when this model is exposed via ML Model Endpoint
# MAGIC - Add Gate 5 (fairness) only if features ever include protected attributes
# MAGIC - Set up drift alerts via Workspace Monitoring + Action Groups
# MAGIC
# MAGIC ## References
# MAGIC - `docs/best-practices/mlops-fabric-production.md` — Wave 2 anchor doc
# MAGIC - `notebooks/ml/01_ml_player_churn_prediction.py` — registry pattern reference
# MAGIC - `notebooks/ml/02_ml_fraud_detection.py` — MLflow run pattern reference

# COMMAND ----------

print("=" * 60)
print("MLOps Lifecycle Run — Summary")
print("=" * 60)
print(f"Baseline:       {MODEL_BASELINE} v{baseline_version}")
print(f"Challenger:     {MODEL_CHALLENGER} v{challenger_version}")
print(f"Gates passed:   {all_gates_passed}")
print(f"Consec. wins:   {consecutive_wins}/{CONSECUTIVE_WINS_REQUIRED}")
print(f"Promoted:       {promotion_event['promoted']}")
print(f"Reason:         {promotion_event['reason']}")
print("=" * 60)
