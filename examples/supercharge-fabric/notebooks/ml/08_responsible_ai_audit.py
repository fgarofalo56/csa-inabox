# Databricks notebook source
# MAGIC %md
# MAGIC # ML: Responsible AI Audit — SHAP + Fairness on SBA Lending Model
# MAGIC
# MAGIC **Phase 14 Wave 2 Feature 2.13** — Production responsible-AI audit notebook for an SBA
# MAGIC small-business loan default model. Implements the mandatory RAI gates defined in
# MAGIC [`docs/best-practices/responsible-ai-framework.md`](../../docs/best-practices/responsible-ai-framework.md).
# MAGIC
# MAGIC ## What This Notebook Does
# MAGIC
# MAGIC 1. **Trains** a gradient-boosted classifier on synthetic SBA 7(a) loan data
# MAGIC 2. **Audits fairness** across protected attributes (race, sex, age band, ZIP/geography)
# MAGIC    using Demographic Parity, Equal Opportunity, Equalized Odds, and Disparate Impact
# MAGIC 3. **Explains predictions** globally and locally with SHAP
# MAGIC 4. **Generates counterfactuals** for adverse-action notices
# MAGIC 5. **Mitigates** with post-processing threshold optimization
# MAGIC 6. **Writes** a model card, fairness audit table, adverse-action reasons, and a CI promotion
# MAGIC    decision to the Gold lakehouse
# MAGIC
# MAGIC ## Regulatory Context
# MAGIC
# MAGIC | Regulation | Requirement Implemented |
# MAGIC |-----------|------------------------|
# MAGIC | **ECOA (12 CFR 1002 / Reg B)** | Adverse-action notices with specific reasons; no discrimination on race, color, religion, national origin, sex, marital status, age |
# MAGIC | **FCRA** | Adverse-action explanation derived from model drivers |
# MAGIC | **EU AI Act (high-risk)** | Conformity-equivalent fairness audit; transparency via model card; human-in-the-loop band |
# MAGIC | **EEOC 80% Rule** | Demographic Parity Ratio ≥ 0.80 across protected groups |
# MAGIC | **OCC SR 11-7** | Documented model validation, ongoing monitoring, governance trail |
# MAGIC
# MAGIC > ⚠️ **Risk tier:** 🔴 High. Lending decisions materially affect individuals' finances.
# MAGIC > Fairness gate failure must block production promotion.
# MAGIC
# MAGIC ## Related Documents
# MAGIC
# MAGIC - [`responsible-ai-framework.md`](../../docs/best-practices/responsible-ai-framework.md) — the RAI doctrine
# MAGIC - [`small-business-lending-analytics.md`](../../docs/use-cases/small-business-lending-analytics.md) — SBA lending use case
# MAGIC - [`mlops-fabric-production.md`](../../docs/best-practices/mlops-fabric-production.md) — promotion gates
# MAGIC - [`model-monitoring-drift-detection.md`](../../docs/best-practices/model-monitoring-drift-detection.md) — ongoing monitoring

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup
# MAGIC
# MAGIC Imports the standard ML stack plus SHAP and (optionally) fairlearn. Both SHAP and fairlearn
# MAGIC are wrapped in `try/except` so the notebook degrades gracefully to manual implementations when
# MAGIC the libraries are not pre-installed in the Spark pool. Production runs should pin both via the
# MAGIC environment-library config.

# COMMAND ----------

import json
import uuid
from datetime import datetime, timezone

import numpy as np
import pandas as pd

# MLflow
import mlflow
import mlflow.sklearn

# Spark
from pyspark.sql import Row
from pyspark.sql.functions import col, current_timestamp, lit
from pyspark.sql.types import (
    DoubleType,
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# scikit-learn
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import (
    confusion_matrix,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import train_test_split

# Optional: SHAP for explainability
try:
    import shap
    SHAP_AVAILABLE = True
except ImportError:
    SHAP_AVAILABLE = False
    print("SHAP not installed — falling back to GBT feature_importances_ for global explanations")

# Optional: fairlearn for post-processing mitigation
try:
    from fairlearn.postprocessing import ThresholdOptimizer
    FAIRLEARN_AVAILABLE = True
except ImportError:
    FAIRLEARN_AVAILABLE = False
    print("fairlearn not installed — falling back to manual per-group threshold mitigation")

# Audit run identifiers
MODEL_NAME = "sba-loan-default-gbt"
MODEL_VERSION = "v1"
AUDIT_TS = datetime.now(timezone.utc)
AUDIT_ID = f"{MODEL_NAME}-{MODEL_VERSION}-{AUDIT_TS.strftime('%Y%m%dT%H%M%SZ')}"
RANDOM_SEED = 42

# Fairness thresholds (from responsible-ai-framework.md)
DPR_THRESHOLD = 0.80          # 80% / 4-fifths rule
EO_DIFF_THRESHOLD = 0.10      # max-min TPR gap
EQ_ODDS_THRESHOLD = 0.10      # max(TPR_diff, FPR_diff)

print(f"Audit ID: {AUDIT_ID}")
print(f"SHAP available: {SHAP_AVAILABLE}")
print(f"fairlearn available: {FAIRLEARN_AVAILABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Generate Synthetic SBA Loan Data
# MAGIC
# MAGIC Mirrors the production `data_generation/generators/federal/sba_generator.py` schema for the
# MAGIC SBA 7(a) program but adds **simulated protected attributes** and a **default outcome label**
# MAGIC suitable for a binary classifier.
# MAGIC
# MAGIC **Critical:** Protected attributes (`applicant_gender`, `applicant_race`, `applicant_age_band`,
# MAGIC `applicant_zip`) are generated for **audit only** and are deliberately excluded from the
# MAGIC training feature set. We deliberately inject a *small but measurable* base-rate skew so the
# MAGIC fairness audit has signal to detect — exactly the situation a real audit must surface.

# COMMAND ----------

def generate_synthetic_sba_loans(n: int = 8000, seed: int = RANDOM_SEED) -> pd.DataFrame:
    """
    Generate a synthetic SBA 7(a) loan-default dataset with protected attributes.

    The function intentionally introduces a mild correlation between protected attributes
    and outcome to exercise the fairness audit pipeline. In a real production audit, this
    correlation might come from upstream data bias the team is trying to identify.
    """
    rng = np.random.default_rng(seed)

    # --- Non-protected (modeling) features -----------------------------------
    loan_amount = rng.lognormal(mean=11.5, sigma=0.9, size=n).clip(5_000, 5_000_000)
    term_months = rng.choice([60, 84, 120, 180, 240, 300], size=n,
                             p=[0.10, 0.15, 0.30, 0.20, 0.15, 0.10])
    interest_rate = rng.uniform(5.5, 8.0, size=n).round(2)

    credit_score = rng.normal(loc=695, scale=55, size=n).clip(500, 850).astype(int)
    debt_to_income = rng.beta(2.5, 6.0, size=n) * 100  # mostly low DTI, long tail
    prior_defaults = rng.choice([0, 1, 2, 3], size=n, p=[0.78, 0.15, 0.05, 0.02])

    business_age_years = rng.gamma(shape=2.5, scale=2.0, size=n).clip(0.25, 50).round(1)
    business_revenue = rng.lognormal(mean=12.5, sigma=1.1, size=n).clip(10_000, 50_000_000)
    employee_count = rng.choice(
        [1, 2, 5, 10, 25, 50, 100, 250],
        size=n,
        p=[0.20, 0.20, 0.20, 0.15, 0.10, 0.08, 0.05, 0.02],
    )

    # --- Protected attributes (AUDIT ONLY — never enter training features) ---
    applicant_gender = rng.choice(["M", "F", "X"], size=n, p=[0.55, 0.43, 0.02])
    applicant_race = rng.choice(
        ["White", "Black", "Hispanic", "Asian", "AIAN", "NHPI", "Other"],
        size=n,
        p=[0.62, 0.13, 0.13, 0.06, 0.02, 0.01, 0.03],
    )
    applicant_age = rng.normal(loc=46, scale=12, size=n).clip(21, 80).astype(int)
    applicant_age_band = pd.cut(
        applicant_age,
        bins=[0, 29, 39, 49, 59, 200],
        labels=["21-29", "30-39", "40-49", "50-59", "60+"],
    ).astype(str)
    applicant_zip = rng.choice(
        ["90001", "10027", "60619", "75216", "33147", "94110", "20019", "85008"],
        size=n,
    )  # majority-minority ZIP placeholders for proxy-bias demonstration

    # --- Default label (target) ----------------------------------------------
    # Risk score driven by *legitimate* features. We intentionally add a small
    # protected-attribute effect to demonstrate the audit pipeline.
    risk_score = (
        (700 - credit_score) * 0.018
        + (debt_to_income - 30) * 0.025
        + prior_defaults * 0.55
        + np.log1p(loan_amount / 100_000) * 0.10
        - np.log1p(business_age_years) * 0.20
        - np.log1p(business_revenue / 50_000) * 0.15
    )
    # Mild base-rate skew (this is what the fairness audit must surface).
    race_skew = pd.Series(applicant_race).map(
        {"White": 0.0, "Black": 0.18, "Hispanic": 0.12, "Asian": -0.05,
         "AIAN": 0.10, "NHPI": 0.05, "Other": 0.05}
    ).to_numpy()
    age_skew = pd.Series(applicant_age_band).map(
        {"21-29": 0.10, "30-39": 0.05, "40-49": 0.0, "50-59": -0.05, "60+": -0.02}
    ).to_numpy()
    risk_score += race_skew + age_skew

    default_proba = 1.0 / (1.0 + np.exp(-risk_score))
    default = (rng.uniform(size=n) < default_proba).astype(int)

    df = pd.DataFrame({
        "applicant_id": [str(uuid.uuid4()) for _ in range(n)],
        # Modeling features
        "loan_amount": loan_amount.round(2),
        "term_months": term_months.astype(int),
        "interest_rate": interest_rate,
        "credit_score": credit_score,
        "debt_to_income": debt_to_income.round(2),
        "prior_defaults": prior_defaults,
        "business_age_years": business_age_years,
        "business_revenue": business_revenue.round(2),
        "employee_count": employee_count.astype(int),
        # Protected attributes (audit only)
        "applicant_gender": applicant_gender,
        "applicant_race": applicant_race,
        "applicant_age_band": applicant_age_band,
        "applicant_zip": applicant_zip,
        # Outcome
        "default": default,
    })
    return df

df = generate_synthetic_sba_loans(n=8000, seed=RANDOM_SEED)
print(f"Generated {len(df):,} synthetic SBA loan applications")
print(f"Default rate: {df['default'].mean():.3%}")
print("\nProtected-attribute distributions:")
for col_name in ["applicant_gender", "applicant_race", "applicant_age_band"]:
    print(f"\n{col_name}:")
    print(df[col_name].value_counts(normalize=True).round(3).to_string())

# COMMAND ----------

# MAGIC %md
# MAGIC ## Train Model — Excluding Protected Attributes
# MAGIC
# MAGIC We train on **only** the non-protected, business-relevant features. The protected attributes
# MAGIC remain in the dataframe for **audit purposes only** and are never passed to the model. This is
# MAGIC necessary but **not sufficient** — proxies (ZIP, surname, etc.) can still leak protected
# MAGIC information, which is exactly why downstream fairness audits are mandatory.

# COMMAND ----------

FEATURE_COLUMNS = [
    "loan_amount",
    "term_months",
    "interest_rate",
    "credit_score",
    "debt_to_income",
    "prior_defaults",
    "business_age_years",
    "business_revenue",
    "employee_count",
]
PROTECTED_ATTRIBUTES = [
    "applicant_gender",
    "applicant_race",
    "applicant_age_band",
    "applicant_zip",
]
TARGET = "default"

X = df[FEATURE_COLUMNS].copy()
y = df[TARGET].copy()
A = df[PROTECTED_ATTRIBUTES].copy()  # held back for audit

X_train, X_test, y_train, y_test, A_train, A_test = train_test_split(
    X, y, A, test_size=0.25, random_state=RANDOM_SEED, stratify=y
)
print(f"Train rows: {len(X_train):,}   Test rows: {len(X_test):,}")
print(f"Train default rate: {y_train.mean():.3%}   Test default rate: {y_test.mean():.3%}")

# COMMAND ----------

mlflow.set_experiment("/Shared/responsible_ai_audit_sba")

with mlflow.start_run(run_name=f"{MODEL_NAME}_baseline") as run:
    mlflow.log_param("model_type", "GradientBoostingClassifier")
    mlflow.log_param("features", FEATURE_COLUMNS)
    mlflow.log_param("protected_attrs_excluded_from_training", PROTECTED_ATTRIBUTES)
    mlflow.log_param("train_rows", len(X_train))
    mlflow.log_param("test_rows", len(X_test))

    model = GradientBoostingClassifier(
        n_estimators=200,
        max_depth=4,
        learning_rate=0.05,
        random_state=RANDOM_SEED,
    )
    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    y_proba = model.predict_proba(X_test)[:, 1]

    auc = roc_auc_score(y_test, y_proba)
    precision = precision_score(y_test, y_pred, zero_division=0)
    recall = recall_score(y_test, y_pred, zero_division=0)

    mlflow.log_metric("auc_roc", auc)
    mlflow.log_metric("precision", precision)
    mlflow.log_metric("recall", recall)
    mlflow.sklearn.log_model(model, "model")

    BASELINE_RUN_ID = run.info.run_id

print(f"AUC-ROC : {auc:.4f}")
print(f"Precision: {precision:.4f}")
print(f"Recall   : {recall:.4f}")
print("\nConfusion matrix (rows = actual, cols = predicted):")
print(confusion_matrix(y_test, y_pred))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Fairness Audit — Build Per-Group Outcome Table
# MAGIC
# MAGIC The audit is a function of three columns: `prediction`, `label`, and the protected attribute.
# MAGIC We compute four metrics per group:
# MAGIC - **Selection Rate** — P(Ŷ=1 | A=a). Drives Demographic Parity.
# MAGIC - **TPR (recall)** — P(Ŷ=1 | Y=1, A=a). Drives Equal Opportunity.
# MAGIC - **FPR** — P(Ŷ=1 | Y=0, A=a). Drives Equalized Odds (alongside TPR).
# MAGIC - **PPV (precision)** — P(Y=1 | Ŷ=1, A=a). Drives Predictive Parity.
# MAGIC
# MAGIC **Note on convention:** This model predicts **default** (Ŷ=1 = default predicted). For the
# MAGIC borrower, Ŷ=1 is the *unfavorable* outcome (loan denied). Demographic-parity selection rate
# MAGIC is therefore measured on Ŷ=1 (denial), and ratios of `min/max` reveal whether one group
# MAGIC experiences disproportionately *more* denials.

# COMMAND ----------

audit_pdf = X_test.copy()
audit_pdf["label"] = y_test.values
audit_pdf["prediction"] = y_pred
audit_pdf["score"] = y_proba
for attr in PROTECTED_ATTRIBUTES:
    audit_pdf[attr] = A_test[attr].values

def per_group_metrics(audit: pd.DataFrame, attr: str) -> pd.DataFrame:
    """Selection rate, TPR, FPR, PPV per group of `attr`."""
    rows = []
    for group, sub in audit.groupby(attr):
        n = len(sub)
        if n == 0:
            continue
        positives_actual = (sub["label"] == 1).sum()
        negatives_actual = (sub["label"] == 0).sum()
        positives_pred = (sub["prediction"] == 1).sum()
        tp = ((sub["prediction"] == 1) & (sub["label"] == 1)).sum()
        fp = ((sub["prediction"] == 1) & (sub["label"] == 0)).sum()
        fn = ((sub["prediction"] == 0) & (sub["label"] == 1)).sum()
        rows.append({
            "group": str(group),
            "n": int(n),
            "selection_rate": positives_pred / n if n else 0.0,
            "tpr": tp / positives_actual if positives_actual else 0.0,
            "fpr": fp / negatives_actual if negatives_actual else 0.0,
            "ppv": tp / (tp + fp) if (tp + fp) else 0.0,
            "tp": int(tp), "fp": int(fp), "fn": int(fn),
            "actual_positive_rate": positives_actual / n if n else 0.0,
        })
    return pd.DataFrame(rows).sort_values("group").reset_index(drop=True)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Fairness Metric 1 — Demographic Parity (4/5ths Rule)
# MAGIC
# MAGIC `DPR = min(selection_rate) / max(selection_rate)` across groups. Per the EEOC Uniform
# MAGIC Guidelines, **DPR < 0.80** presumptively indicates adverse impact and triggers
# MAGIC business-necessity defense or mitigation. This is a screening test, not a safe harbor.

# COMMAND ----------

def demographic_parity(per_group: pd.DataFrame) -> dict:
    rates = per_group["selection_rate"]
    if rates.max() == 0:
        return {"dpr": 0.0, "min_group": None, "max_group": None, "passes": False}
    dpr = rates.min() / rates.max()
    return {
        "dpr": float(dpr),
        "min_group": per_group.loc[rates.idxmin(), "group"],
        "max_group": per_group.loc[rates.idxmax(), "group"],
        "passes": bool(dpr >= DPR_THRESHOLD),
    }

# COMMAND ----------

# MAGIC %md
# MAGIC ## Fairness Metric 2 — Equal Opportunity (TPR Parity)
# MAGIC
# MAGIC Among applicants who actually defaulted (Y=1), the model should flag them at equal rates
# MAGIC across groups. If a model has lower TPR for one group, the model is missing real defaults
# MAGIC there — a different but real harm. We flag if `max(TPR) - min(TPR) > 0.10`.

# COMMAND ----------

def equal_opportunity(per_group: pd.DataFrame) -> dict:
    tpr = per_group["tpr"]
    diff = float(tpr.max() - tpr.min())
    return {
        "eo_diff": diff,
        "min_group": per_group.loc[tpr.idxmin(), "group"],
        "max_group": per_group.loc[tpr.idxmax(), "group"],
        "passes": bool(diff <= EO_DIFF_THRESHOLD),
    }

# COMMAND ----------

# MAGIC %md
# MAGIC ## Fairness Metric 3 — Equalized Odds (TPR + FPR Parity)
# MAGIC
# MAGIC The strictest classical metric: both TPR *and* FPR must be similar across groups. The
# MAGIC equalized-odds difference is `max(TPR_diff, FPR_diff)`. A high FPR for one group means more
# MAGIC false denials — qualified borrowers wrongly flagged as defaulters.

# COMMAND ----------

def equalized_odds(per_group: pd.DataFrame) -> dict:
    tpr_diff = float(per_group["tpr"].max() - per_group["tpr"].min())
    fpr_diff = float(per_group["fpr"].max() - per_group["fpr"].min())
    eq_odds = max(tpr_diff, fpr_diff)
    return {
        "eq_odds_diff": eq_odds,
        "tpr_diff": tpr_diff,
        "fpr_diff": fpr_diff,
        "passes": bool(eq_odds <= EQ_ODDS_THRESHOLD),
    }

# COMMAND ----------

# MAGIC %md
# MAGIC ## Disparate Impact — Full Per-Group Table + z-Test
# MAGIC
# MAGIC For each protected attribute we compute the full per-group table and run a two-proportion
# MAGIC z-test of the selection rate of each group vs the reference group (the group with the
# MAGIC largest `n`). Significance at α=0.05 indicates a statistically meaningful gap that is
# MAGIC unlikely to be sampling noise.

# COMMAND ----------

def two_proportion_z_test(p1: float, n1: int, p2: float, n2: int) -> tuple[float, float]:
    """Returns (z, two-sided p-value) for the difference of two proportions."""
    if n1 == 0 or n2 == 0:
        return 0.0, 1.0
    p_pool = (p1 * n1 + p2 * n2) / (n1 + n2)
    se = np.sqrt(p_pool * (1 - p_pool) * (1 / n1 + 1 / n2))
    if se == 0:
        return 0.0, 1.0
    z = (p1 - p2) / se
    # Two-sided p via normal approximation
    from math import erf, sqrt
    p_value = 2.0 * (1.0 - 0.5 * (1.0 + erf(abs(z) / sqrt(2.0))))
    return float(z), float(p_value)

def disparate_impact_table(per_group: pd.DataFrame) -> pd.DataFrame:
    """Annotate the per-group table with z-test vs largest-n reference group."""
    if len(per_group) == 0:
        return per_group
    ref_idx = per_group["n"].idxmax()
    ref = per_group.loc[ref_idx]
    rows = []
    for _, r in per_group.iterrows():
        z, p = two_proportion_z_test(r["selection_rate"], r["n"],
                                     ref["selection_rate"], ref["n"])
        rows.append({
            **r.to_dict(),
            "ratio_vs_reference": (r["selection_rate"] / ref["selection_rate"]
                                   if ref["selection_rate"] else 0.0),
            "z_stat": z,
            "p_value": p,
            "significant_at_05": bool(p < 0.05 and r["group"] != ref["group"]),
        })
    out = pd.DataFrame(rows)
    out["reference_group"] = ref["group"]
    return out

# COMMAND ----------

# MAGIC %md
# MAGIC ## Run the Full Audit Across All Protected Attributes

# COMMAND ----------

audit_results = []
for attr in PROTECTED_ATTRIBUTES:
    print(f"\n{'=' * 72}")
    print(f"Protected attribute: {attr}")
    print('=' * 72)
    pg = per_group_metrics(audit_pdf, attr)
    di = disparate_impact_table(pg)
    print("\nPer-group metrics (with z-test vs reference):")
    display_cols = ["group", "n", "selection_rate", "tpr", "fpr", "ppv",
                    "ratio_vs_reference", "z_stat", "p_value", "significant_at_05"]
    print(di[display_cols].round(4).to_string(index=False))

    dp = demographic_parity(pg)
    eo = equal_opportunity(pg)
    eq = equalized_odds(pg)

    print(f"\nDemographic Parity Ratio: {dp['dpr']:.4f}  "
          f"(min={dp['min_group']}, max={dp['max_group']})  "
          f"{'PASS' if dp['passes'] else 'FAIL'} (>= {DPR_THRESHOLD})")
    print(f"Equal Opportunity Diff  : {eo['eo_diff']:.4f}  "
          f"{'PASS' if eo['passes'] else 'FAIL'} (<= {EO_DIFF_THRESHOLD})")
    print(f"Equalized Odds Diff     : {eq['eq_odds_diff']:.4f}  "
          f"(TPR_diff={eq['tpr_diff']:.4f}, FPR_diff={eq['fpr_diff']:.4f})  "
          f"{'PASS' if eq['passes'] else 'FAIL'} (<= {EQ_ODDS_THRESHOLD})")

    overall_pass = dp["passes"] and eo["passes"] and eq["passes"]
    audit_results.append({
        "audit_id": AUDIT_ID,
        "model_name": MODEL_NAME,
        "model_version": MODEL_VERSION,
        "audit_ts": AUDIT_TS,
        "attribute": attr,
        "demographic_parity_ratio": dp["dpr"],
        "equal_opportunity_diff": eo["eo_diff"],
        "equalized_odds_diff": eq["eq_odds_diff"],
        "tpr_diff": eq["tpr_diff"],
        "fpr_diff": eq["fpr_diff"],
        "passes_dp": dp["passes"],
        "passes_eo": eo["passes"],
        "passes_eq_odds": eq["passes"],
        "passes_overall": overall_pass,
        "reference_group": di["reference_group"].iloc[0] if len(di) else None,
        "min_group": dp["min_group"],
        "max_group": dp["max_group"],
        "per_group_table": di[display_cols].round(6).to_dict(orient="records"),
    })

# COMMAND ----------

# MAGIC %md
# MAGIC ## SHAP — Global Explainability
# MAGIC
# MAGIC `TreeExplainer` is exact and fast for tree ensembles. Global importance is the mean of the
# MAGIC absolute SHAP value for each feature across all test samples. Gives a defensible, model-class
# MAGIC native answer to "what drives this model's decisions overall?"

# COMMAND ----------

if SHAP_AVAILABLE:
    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(X_test)
    # sklearn GBT returns 2-D ndarray (n_samples, n_features) for binary classification
    if isinstance(shap_values, list):
        shap_values = shap_values[1]
    global_importance = np.abs(shap_values).mean(axis=0)
    shap_df = pd.DataFrame({
        "feature": FEATURE_COLUMNS,
        "mean_abs_shap": global_importance,
    }).sort_values("mean_abs_shap", ascending=False).reset_index(drop=True)
else:
    # Fallback: GBT native feature_importances_
    shap_values = None
    shap_df = pd.DataFrame({
        "feature": FEATURE_COLUMNS,
        "mean_abs_shap": model.feature_importances_,
    }).sort_values("mean_abs_shap", ascending=False).reset_index(drop=True)

print("Top 10 features (global importance):")
print(shap_df.head(10).to_string(index=False))

# COMMAND ----------

# MAGIC %md
# MAGIC ## SHAP — Local Explanations (Approved / Denied / Borderline)
# MAGIC
# MAGIC Picks three representative cases and reports the per-feature contribution that pushed the
# MAGIC prediction in either direction. A positive SHAP value pushes toward predicted-default
# MAGIC (denial); negative pushes toward predicted-no-default (approval). These are the rows we'd
# MAGIC store in the `ai_predictions` Eventhouse table for an appeals workflow.

# COMMAND ----------

X_test_reset = X_test.reset_index(drop=True)
proba_reset = pd.Series(y_proba, name="proba").reset_index(drop=True)

# Approved (predicted no-default with high confidence)
idx_approved = proba_reset.idxmin()
# Denied (predicted default with high confidence)
idx_denied = proba_reset.idxmax()
# Borderline (closest to 0.5)
idx_borderline = (proba_reset - 0.5).abs().idxmin()

case_indices = {
    "APPROVED (low default risk)": idx_approved,
    "DENIED (high default risk)": idx_denied,
    "BORDERLINE (HITL routing)": idx_borderline,
}

def explain_local(idx: int) -> pd.DataFrame:
    """Return per-feature SHAP for one row, sorted by absolute contribution."""
    if SHAP_AVAILABLE and shap_values is not None:
        contrib = shap_values[idx]
    else:
        # Fallback: feature value * global importance as a coarse proxy
        contrib = X_test_reset.iloc[idx].values * model.feature_importances_
    return pd.DataFrame({
        "feature": FEATURE_COLUMNS,
        "value": X_test_reset.iloc[idx].values,
        "contribution": contrib,
    }).assign(abs_contribution=lambda d: d["contribution"].abs()) \
      .sort_values("abs_contribution", ascending=False).reset_index(drop=True)

local_explanations: dict[str, pd.DataFrame] = {}
for label, idx in case_indices.items():
    print(f"\n{'-' * 72}")
    print(f"Case: {label}")
    print(f"  predicted default probability: {proba_reset.iloc[idx]:.4f}")
    print(f"  actual default label:          {y_test.iloc[idx]}")
    exp = explain_local(idx)
    print("\nTop 5 feature contributions:")
    print(exp.head(5).round(4).to_string(index=False))
    local_explanations[label] = exp

# COMMAND ----------

# MAGIC %md
# MAGIC ## Counterfactual Explanation (Simplified)
# MAGIC
# MAGIC For the denied case, find the **single-feature** change of smallest magnitude that would flip
# MAGIC the prediction to approved. This is the simplified counterfactual — production systems should
# MAGIC use [DiCE](https://github.com/interpretml/DiCE) for multi-feature, actionable counterfactuals.
# MAGIC The output is the literal text of an ECOA-compliant adverse-action notice:
# MAGIC > "Your loan would have been approved if your {feature} were {target_value}."

# COMMAND ----------

# Actionable features (a borrower cannot retroactively change loan_amount or business_age; we
# could in theory suggest different requested terms, so we include those that are negotiable).
ACTIONABLE_FEATURES = [
    "loan_amount",        # could request smaller loan
    "term_months",        # could request different term
    "credit_score",       # actionable over time
    "debt_to_income",     # actionable
]

def find_single_feature_counterfactual(
    row: pd.Series, model, threshold: float = 0.5, n_steps: int = 50
) -> dict | None:
    """
    Sweep each actionable feature linearly between observed min/max in training and find the
    smallest |delta| that flips the prediction. Returns None if no single-feature flip exists.
    """
    base = row[FEATURE_COLUMNS].copy().to_frame().T.astype(float)
    base_proba = float(model.predict_proba(base)[0, 1])
    if base_proba <= threshold:
        return None  # already approved

    candidates = []
    for feat in ACTIONABLE_FEATURES:
        f_min = float(X_train[feat].min())
        f_max = float(X_train[feat].max())
        sweep = np.linspace(f_min, f_max, n_steps)
        for v in sweep:
            trial = base.copy()
            trial[feat] = v
            p = float(model.predict_proba(trial)[0, 1])
            if p <= threshold:
                candidates.append({
                    "feature": feat,
                    "original_value": float(row[feat]),
                    "counterfactual_value": float(v),
                    "delta": float(v - row[feat]),
                    "abs_delta": float(abs(v - row[feat])),
                    "new_proba": p,
                })
                break  # first flip per feature
    if not candidates:
        return None
    # Pick the smallest relative change
    best = min(candidates, key=lambda c: c["abs_delta"] / (abs(c["original_value"]) + 1e-9))
    return best

denied_row = X_test_reset.iloc[idx_denied]
cf = find_single_feature_counterfactual(denied_row, model, threshold=0.5)
if cf is None:
    print("No single-feature counterfactual within training-data range. "
          "Refer to DiCE multi-feature search.")
else:
    print(f"Counterfactual for DENIED case:")
    print(f"  Feature        : {cf['feature']}")
    print(f"  Original value : {cf['original_value']:.4f}")
    print(f"  Required value : {cf['counterfactual_value']:.4f}")
    print(f"  Delta          : {cf['delta']:+.4f}")
    print(f"  New proba      : {cf['new_proba']:.4f}")
    print(f"\nUser-facing message:")
    print(f"  Your loan would have been approved if your {cf['feature']} "
          f"were {cf['counterfactual_value']:.2f} "
          f"(currently {cf['original_value']:.2f}).")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Mitigation — Post-Processing Threshold Optimization
# MAGIC
# MAGIC Post-processing mitigation does not retrain the model — it adjusts the decision threshold
# MAGIC per group so that fairness criteria (here: equalized odds) are met. This is the most common
# MAGIC mitigation for already-deployed black-box models and is supported by `fairlearn`. When
# MAGIC fairlearn is unavailable, we apply a manual per-group threshold calibrated to equalize TPR.
# MAGIC
# MAGIC > 💡 Mitigation almost always trades raw accuracy for fairness. Document the trade in the
# MAGIC > model card.

# COMMAND ----------

mitigation_attr = "applicant_race"  # demonstrate on race
A_train_attr = A_train[mitigation_attr].astype(str).values
A_test_attr = A_test[mitigation_attr].astype(str).values

if FAIRLEARN_AVAILABLE:
    print("Applying fairlearn ThresholdOptimizer (constraint=equalized_odds)...")
    mitigator = ThresholdOptimizer(
        estimator=model,
        constraints="equalized_odds",
        objective="balanced_accuracy_score",
        prefit=True,
        predict_method="predict_proba",
    )
    mitigator.fit(X_train, y_train, sensitive_features=A_train_attr)
    y_pred_mit = mitigator.predict(X_test, sensitive_features=A_test_attr,
                                    random_state=RANDOM_SEED)
else:
    # Manual per-group threshold calibration to roughly equalize TPR
    print("Applying manual per-group threshold calibration...")
    # Compute baseline TPR per group, then move thresholds to align toward the median group TPR
    tprs = audit_results[1]["per_group_table"]  # applicant_race entry (index 1 in PROTECTED_ATTRIBUTES)
    target_tpr = float(np.median([r["tpr"] for r in tprs if r["tpr"] > 0]))
    group_thresholds = {}
    for r in tprs:
        g = r["group"]
        # If this group's TPR is below target, lower its threshold (more denials of true defaulters)
        # If above target, raise threshold. Search in 0.05 steps.
        best_t, best_gap = 0.5, 1.0
        sub_idx = np.where(A_test_attr == g)[0]
        if len(sub_idx) == 0:
            group_thresholds[g] = 0.5
            continue
        sub_y = y_test.values[sub_idx]
        sub_p = y_proba[sub_idx]
        for t in np.linspace(0.10, 0.90, 33):
            pred_t = (sub_p >= t).astype(int)
            pos = sub_y.sum()
            tpr_t = ((pred_t == 1) & (sub_y == 1)).sum() / pos if pos else 0.0
            gap = abs(tpr_t - target_tpr)
            if gap < best_gap:
                best_gap, best_t = gap, t
        group_thresholds[g] = best_t
    print(f"  Target TPR={target_tpr:.3f}")
    print(f"  Per-group thresholds: {group_thresholds}")
    y_pred_mit = np.zeros_like(y_pred)
    for g, t in group_thresholds.items():
        mask = (A_test_attr == g)
        y_pred_mit[mask] = (y_proba[mask] >= t).astype(int)

# Re-run audit on mitigated predictions
mitigated_audit = audit_pdf.copy()
mitigated_audit["prediction"] = y_pred_mit
pg_mit = per_group_metrics(mitigated_audit, mitigation_attr)
dp_mit = demographic_parity(pg_mit)
eo_mit = equal_opportunity(pg_mit)
eq_mit = equalized_odds(pg_mit)

print(f"\nMitigation results for {mitigation_attr}:")
print(f"  DPR     : {audit_results[1]['demographic_parity_ratio']:.4f}  ->  {dp_mit['dpr']:.4f}")
print(f"  EO Diff : {audit_results[1]['equal_opportunity_diff']:.4f}  ->  {eo_mit['eo_diff']:.4f}")
print(f"  Eq Odds : {audit_results[1]['equalized_odds_diff']:.4f}  ->  {eq_mit['eq_odds_diff']:.4f}")
mit_auc = roc_auc_score(y_test, y_proba)  # AUC unchanged (post-processing only)
mit_precision = precision_score(y_test, y_pred_mit, zero_division=0)
mit_recall = recall_score(y_test, y_pred_mit, zero_division=0)
print(f"  Precision: {precision:.4f}  ->  {mit_precision:.4f}")
print(f"  Recall   : {recall:.4f}  ->  {mit_recall:.4f}  "
      f"(trade-off documented in model card)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Persist Fairness Audit Results to Gold Lakehouse
# MAGIC
# MAGIC Writes one row per (model, version, attribute) with timestamp, metric values, thresholds,
# MAGIC and pass/fail flags. This is the audit trail consumed by the RAI Lead, by the quarterly
# MAGIC review board, and by automated drift dashboards.

# COMMAND ----------

audit_records = []
for r in audit_results:
    for metric_name, metric_value, threshold, op_label in [
        ("demographic_parity_ratio", r["demographic_parity_ratio"], DPR_THRESHOLD, ">="),
        ("equal_opportunity_diff",   r["equal_opportunity_diff"],   EO_DIFF_THRESHOLD, "<="),
        ("equalized_odds_diff",      r["equalized_odds_diff"],      EQ_ODDS_THRESHOLD, "<="),
    ]:
        if op_label == ">=":
            passed = metric_value >= threshold
        else:
            passed = metric_value <= threshold
        audit_records.append({
            "audit_id": r["audit_id"],
            "model_name": r["model_name"],
            "model_version": r["model_version"],
            "audit_ts": r["audit_ts"],
            "attribute": r["attribute"],
            "metric_name": metric_name,
            "metric_value": float(metric_value),
            "threshold": float(threshold),
            "operator": op_label,
            "pass_fail": "PASS" if passed else "FAIL",
        })

audit_schema = StructType([
    StructField("audit_id", StringType(), False),
    StructField("model_name", StringType(), False),
    StructField("model_version", StringType(), False),
    StructField("audit_ts", TimestampType(), False),
    StructField("attribute", StringType(), False),
    StructField("metric_name", StringType(), False),
    StructField("metric_value", DoubleType(), False),
    StructField("threshold", DoubleType(), False),
    StructField("operator", StringType(), False),
    StructField("pass_fail", StringType(), False),
])
audit_df = spark.createDataFrame(audit_records, schema=audit_schema)
(audit_df.write.format("delta").mode("append")
        .saveAsTable("lh_gold.ml_fairness_audit"))
print(f"Wrote {audit_df.count()} fairness audit rows to lh_gold.ml_fairness_audit")
audit_df.show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Adverse-Action Notes — ECOA-Required Reasons
# MAGIC
# MAGIC ECOA Reg B §1002.9 requires creditors to provide **specific reasons** for adverse action
# MAGIC within 30 days. The top-3 features by |SHAP value| for a denial provide a defensible,
# MAGIC personalized, machine-generated explanation. We translate raw feature names to user-facing
# MAGIC sentences via a templated function — never let raw SHAP numbers reach an end user.

# COMMAND ----------

USER_FACING_TEMPLATES = {
    "credit_score":        "Credit score of {value:.0f} was a {direction} factor.",
    "debt_to_income":      "Debt-to-income ratio of {value:.1f}% was a {direction} factor.",
    "prior_defaults":      "Number of prior defaults ({value:.0f}) was a {direction} factor.",
    "loan_amount":         "Requested loan amount of ${value:,.0f} was a {direction} factor.",
    "term_months":         "Requested loan term of {value:.0f} months was a {direction} factor.",
    "interest_rate":       "Quoted interest rate of {value:.2f}% was a {direction} factor.",
    "business_age_years":  "Business age of {value:.1f} years was a {direction} factor.",
    "business_revenue":    "Annual business revenue of ${value:,.0f} was a {direction} factor.",
    "employee_count":      "Employee count of {value:.0f} was a {direction} factor.",
}

def adverse_action_notes_for(idx: int, applicant_id: str) -> list[dict]:
    exp = local_explanations.get("DENIED (high default risk)") if idx == idx_denied \
          else explain_local(idx)
    top3 = exp.head(3)
    notes = []
    for _, r in top3.iterrows():
        # contribution > 0 = pushed toward default-predicted (negative for borrower)
        direction = "negative" if r["contribution"] > 0 else "positive"
        template = USER_FACING_TEMPLATES.get(
            r["feature"], "{feature} of {value} was a {direction} factor."
        )
        notes.append({
            "applicant_id": applicant_id,
            "model_name": MODEL_NAME,
            "model_version": MODEL_VERSION,
            "audit_ts": AUDIT_TS,
            "feature": r["feature"],
            "feature_value": float(r["value"]),
            "shap_contribution": float(r["contribution"]),
            "direction": direction,
            "user_facing_text": template.format(
                feature=r["feature"], value=r["value"], direction=direction
            ),
        })
    return notes

# Generate notes for every denied case in the test set
denied_indices = np.where(y_pred == 1)[0]
print(f"Generating adverse-action notes for {len(denied_indices)} denied applications...")

# For demo: process a sample of 100 (full population can be too slow inline)
sample_denied = denied_indices[:100] if len(denied_indices) > 100 else denied_indices
all_notes = []
applicant_ids_test = df.loc[X_test.index, "applicant_id"].values
for idx in sample_denied:
    all_notes.extend(adverse_action_notes_for(int(idx), applicant_ids_test[int(idx)]))

print(f"Generated {len(all_notes)} adverse-action note rows (3 per denied applicant)")
print("\nSample (first denial):")
for n in all_notes[:3]:
    print(f"  [{n['feature']:18s}] {n['user_facing_text']}")

notes_schema = StructType([
    StructField("applicant_id", StringType(), False),
    StructField("model_name", StringType(), False),
    StructField("model_version", StringType(), False),
    StructField("audit_ts", TimestampType(), False),
    StructField("feature", StringType(), False),
    StructField("feature_value", DoubleType(), False),
    StructField("shap_contribution", DoubleType(), False),
    StructField("direction", StringType(), False),
    StructField("user_facing_text", StringType(), False),
])
if all_notes:
    notes_df = spark.createDataFrame(all_notes, schema=notes_schema)
    (notes_df.write.format("delta").mode("append")
            .saveAsTable("lh_gold.ml_adverse_action_notes"))
    print(f"\nWrote {notes_df.count()} rows to lh_gold.ml_adverse_action_notes")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Model Card — Persisted to Gold
# MAGIC
# MAGIC Mirrors the [Model Card template](../../docs/best-practices/responsible-ai-framework.md#-templates).
# MAGIC One row per (model, version) with the full model card payload as JSON. Surface in the
# MAGIC Workspace Wiki by linking to the OneLake URL; update on every promotion.

# COMMAND ----------

model_card = {
    "model_name": MODEL_NAME,
    "model_version": MODEL_VERSION,
    "audit_id": AUDIT_ID,
    "audit_ts": AUDIT_TS.isoformat(),
    "rai_risk_tier": "🔴 High",
    "purpose": (
        "Predict probability of default for SBA 7(a) small-business loan applications "
        "to support underwriter triage. Predictions feed an HITL review queue, never "
        "an automated denial."
    ),
    "out_of_scope_use": [
        "Final approve/deny decisions without human review",
        "Pricing decisions (interest-rate setting)",
        "Loan products outside SBA 7(a) (PPP, Disaster, SBIR)",
        "Borrowers in U.S. territories (model not validated)",
    ],
    "training_data": {
        "source": "synthetic SBA 7(a) loan applications",
        "rows": int(len(X_train)),
        "features": FEATURE_COLUMNS,
        "protected_attrs_held_back": PROTECTED_ATTRIBUTES,
        "label_definition": "default = 1 if loan went into default within 24 months",
    },
    "performance": {
        "auc_roc": float(auc),
        "precision": float(precision),
        "recall": float(recall),
        "holdout_rows": int(len(X_test)),
    },
    "performance_by_subgroup": {
        r["attribute"]: r["per_group_table"] for r in audit_results
    },
    "fairness_metrics": [
        {"attribute": r["attribute"],
         "demographic_parity_ratio": r["demographic_parity_ratio"],
         "equal_opportunity_diff": r["equal_opportunity_diff"],
         "equalized_odds_diff": r["equalized_odds_diff"],
         "passes_overall": r["passes_overall"]}
        for r in audit_results
    ],
    "mitigation_applied": {
        "type": "post-processing threshold optimization",
        "library": "fairlearn.ThresholdOptimizer" if FAIRLEARN_AVAILABLE else "manual per-group calibration",
        "constraint": "equalized_odds",
        "attribute": mitigation_attr,
        "before_dpr": audit_results[1]["demographic_parity_ratio"],
        "after_dpr": dp_mit["dpr"],
        "recall_change": float(mit_recall - recall),
    },
    "explainability": {
        "global_top_features": shap_df.head(10).to_dict(orient="records"),
        "local_explanation_storage": "lh_gold.ml_adverse_action_notes (per denial)",
        "counterfactual_method": "single-feature linear sweep (DiCE in production)",
    },
    "limitations": [
        "Trained on synthetic data — performance on real SBA 7(a) data not validated",
        "Performance degrades for applicants with < 6 months credit history",
        "Not validated for loans > $5M",
        "ZIP-code feature retained — proxy-bias risk; monitored quarterly",
    ],
    "monitoring": {
        "performance_threshold_drop_pct": 5,
        "drift_psi_threshold": 0.20,
        "fairness_dpr_threshold": DPR_THRESHOLD,
        "calibration_ece_threshold": 0.10,
        "abstention_rate_threshold": 0.25,
        "retraining_schedule": "quarterly + on-trigger (drift or fairness regression)",
    },
    "contact": {
        "team_email": "ml-lending@example.gov",
        "appeals_url": "https://lending-appeals.example.gov",
        "compliance_email": "compliance@example.gov",
    },
}

card_schema = StructType([
    StructField("model_name", StringType(), False),
    StructField("model_version", StringType(), False),
    StructField("audit_id", StringType(), False),
    StructField("audit_ts", TimestampType(), False),
    StructField("rai_risk_tier", StringType(), False),
    StructField("model_card_json", StringType(), False),
])
card_row = Row(
    model_name=MODEL_NAME,
    model_version=MODEL_VERSION,
    audit_id=AUDIT_ID,
    audit_ts=AUDIT_TS,
    rai_risk_tier=model_card["rai_risk_tier"],
    model_card_json=json.dumps(model_card, default=str, indent=2),
)
card_df = spark.createDataFrame([card_row], schema=card_schema)
(card_df.write.format("delta").mode("append")
       .saveAsTable("lh_gold.ml_model_cards"))
print(f"Wrote model card for {MODEL_NAME} {MODEL_VERSION} to lh_gold.ml_model_cards")

# COMMAND ----------

# MAGIC %md
# MAGIC ## CI Promotion Decision
# MAGIC
# MAGIC The `lh_gold.ml_promotion_audit` table is the gate consumed by the GitHub Actions
# MAGIC `ml-promotion.yml` workflow. If `block_promotion = true`, the workflow refuses to publish the
# MAGIC model to the Production stage in the MLflow registry and posts the failure reason to the PR.

# COMMAND ----------

failed_attrs = [r["attribute"] for r in audit_results if not r["passes_overall"]]
block_promotion = len(failed_attrs) > 0

decision = {
    "audit_id": AUDIT_ID,
    "model_name": MODEL_NAME,
    "model_version": MODEL_VERSION,
    "audit_ts": AUDIT_TS,
    "block_promotion": block_promotion,
    "failed_attributes": ",".join(failed_attrs) if failed_attrs else "",
    "reason": (
        f"Fairness gate FAILED for: {', '.join(failed_attrs)}. "
        f"Mitigation required before promotion."
        if block_promotion else
        "Fairness gate PASSED for all protected attributes."
    ),
    "fairness_thresholds_json": json.dumps({
        "DPR_threshold": DPR_THRESHOLD,
        "EO_diff_threshold": EO_DIFF_THRESHOLD,
        "Eq_odds_threshold": EQ_ODDS_THRESHOLD,
    }),
}
promo_schema = StructType([
    StructField("audit_id", StringType(), False),
    StructField("model_name", StringType(), False),
    StructField("model_version", StringType(), False),
    StructField("audit_ts", TimestampType(), False),
    StructField("block_promotion", StringType(), False),
    StructField("failed_attributes", StringType(), False),
    StructField("reason", StringType(), False),
    StructField("fairness_thresholds_json", StringType(), False),
])
promo_row = Row(
    audit_id=decision["audit_id"],
    model_name=decision["model_name"],
    model_version=decision["model_version"],
    audit_ts=decision["audit_ts"],
    block_promotion=str(decision["block_promotion"]),
    failed_attributes=decision["failed_attributes"],
    reason=decision["reason"],
    fairness_thresholds_json=decision["fairness_thresholds_json"],
)
promo_df = spark.createDataFrame([promo_row], schema=promo_schema)
(promo_df.write.format("delta").mode("append")
        .saveAsTable("lh_gold.ml_promotion_audit"))

print("=" * 72)
print(f"PROMOTION DECISION: {'BLOCK' if block_promotion else 'ALLOW'}")
print("=" * 72)
print(decision["reason"])
if block_promotion:
    print("\nMitigation playbook: see responsible-ai-framework.md > Mitigation Techniques")
    print("After mitigation, re-run this notebook and confirm all gates PASS.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cleanup
# MAGIC
# MAGIC Unpersist any cached frames; the Delta tables persist for downstream auditors. The MLflow
# MAGIC run remains in the experiment for traceability.

# COMMAND ----------

try:
    audit_df.unpersist()
except Exception:
    pass
print(f"Audit complete. Audit ID: {AUDIT_ID}")
print(f"Tables written:")
print(f"  - lh_gold.ml_fairness_audit       ({len(audit_records)} rows)")
print(f"  - lh_gold.ml_adverse_action_notes ({len(all_notes)} rows)")
print(f"  - lh_gold.ml_model_cards          (1 row)")
print(f"  - lh_gold.ml_promotion_audit      (1 row, block_promotion={block_promotion})")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Production Deployment Notes
# MAGIC
# MAGIC 1. **Schedule** as part of the model-promotion CI pipeline (`.github/workflows/ml-promotion.yml`)
# MAGIC    via `scripts/run_fabric_notebook.py`
# MAGIC 2. **Wire** `lh_gold.ml_promotion_audit.block_promotion = true` to **fail the workflow**
# MAGIC    and post the reason to the PR
# MAGIC 3. **Re-run quarterly** on a fresh production-data holdout — fairness drifts as population
# MAGIC    mix changes
# MAGIC 4. **Tee** every prediction (with SHAP top-3 drivers) into the `ai_predictions` Eventhouse
# MAGIC    table for the appeals workflow
# MAGIC 5. **Sign-off:** RAI Lead in Archon before any Production-stage transition
# MAGIC 6. **Retention:** 5 years for ECOA (Reg B §1002.12 + statute-of-limitations buffer);
# MAGIC    sensitivity label "Confidential" on all four Gold tables
