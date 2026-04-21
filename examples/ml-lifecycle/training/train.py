"""Train a loan-default logistic regression on the synthetic loan dataset.

End-to-end pipeline:
  1. Generate (or load) the deterministic loan CSV.
  2. Split into train/test (stratified, seeded).
  3. Build a ``ColumnTransformer`` feature pipeline (numeric scaling +
     one-hot encoding of categoricals) inside a ``Pipeline``.
  4. Fit a :class:`sklearn.linear_model.LogisticRegression` classifier.
  5. Evaluate ROC-AUC on the held-out split.
  6. Persist the fitted pipeline to ``model.pkl`` via :mod:`joblib`.

The script targets an AUC of **>= 0.70** on the synthetic dataset —
:mod:`examples.ml_lifecycle.training.tests.test_train` asserts this
threshold end-to-end.

CLI::

    python train.py \\
        --rows 5000 --seed 42 \\
        --data data/loans.csv \\
        --output-dir outputs/
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

_GEN_DIR = (Path(__file__).resolve().parent.parent / "data" / "generators").resolve()
if str(_GEN_DIR) not in sys.path:
    sys.path.insert(0, str(_GEN_DIR))

# ``generate_loan_data`` lives in the sibling ``data/generators`` dir and
# is reused here to avoid a separate data-loading path.
from generate_loan_data import (  # type: ignore[import-not-found]  # noqa: E402
    FIELDNAMES,
    generate_loan_dataset,
    write_csv,
)

# ---------------------------------------------------------------------------
# Feature catalogue
# ---------------------------------------------------------------------------

NUMERIC_FEATURES: tuple[str, ...] = (
    "applicant_age",
    "annual_income",
    "loan_amount",
    "loan_term_months",
    "credit_score",
    "employment_years",
    "debt_to_income",
    "delinquencies_2yr",
)
CATEGORICAL_FEATURES: tuple[str, ...] = (
    "home_ownership",
    "loan_purpose",
)
TARGET: str = "defaulted"


@dataclass
class TrainingResult:
    auc: float
    accuracy: float
    n_train: int
    n_test: int
    default_rate: float
    feature_names: list[str]
    model_path: Path
    duration_sec: float


# ---------------------------------------------------------------------------
# Pipeline construction
# ---------------------------------------------------------------------------


def _load_sklearn() -> Any:
    """Lazy sklearn import so this module stays importable on lean test envs."""
    import sklearn  # noqa: F401
    from sklearn.compose import ColumnTransformer
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import accuracy_score, roc_auc_score
    from sklearn.model_selection import train_test_split
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder, StandardScaler

    return {
        "ColumnTransformer": ColumnTransformer,
        "LogisticRegression": LogisticRegression,
        "OneHotEncoder": OneHotEncoder,
        "Pipeline": Pipeline,
        "StandardScaler": StandardScaler,
        "accuracy_score": accuracy_score,
        "roc_auc_score": roc_auc_score,
        "train_test_split": train_test_split,
    }


def build_pipeline(*, seed: int = 42) -> Any:
    """Build the feature pipeline + logistic-regression estimator."""
    sk = _load_sklearn()

    numeric_pipeline = sk["StandardScaler"]()
    try:
        # sklearn >= 1.2 uses ``sparse_output``; older versions use ``sparse``.
        categorical_pipeline = sk["OneHotEncoder"](
            handle_unknown="ignore",
            sparse_output=False,
        )
    except TypeError:  # pragma: no cover - compat shim
        categorical_pipeline = sk["OneHotEncoder"](
            handle_unknown="ignore",
            sparse=False,
        )

    preprocessor = sk["ColumnTransformer"](
        transformers=[
            ("num", numeric_pipeline, list(NUMERIC_FEATURES)),
            ("cat", categorical_pipeline, list(CATEGORICAL_FEATURES)),
        ],
        remainder="drop",
    )

    classifier = sk["LogisticRegression"](
        max_iter=500,
        solver="lbfgs",
        C=1.0,
        random_state=seed,
    )

    return sk["Pipeline"](
        steps=[
            ("features", preprocessor),
            ("classifier", classifier),
        ],
    )


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------


def _load_data_as_arrays(
    records: list[Any],
) -> tuple[list[dict[str, Any]], np.ndarray]:
    """Convert :class:`LoanRecord` objects to feature dicts + label array.

    Returns the features as a list of dicts (compatible with
    :class:`pandas.DataFrame` or :class:`sklearn.utils.Bunch`) and the
    target as an ``np.int64`` array.
    """
    feature_rows: list[dict[str, Any]] = []
    y: list[int] = []
    for r in records:
        feature_rows.append(
            {
                "applicant_age": r.applicant_age,
                "annual_income": r.annual_income,
                "loan_amount": r.loan_amount,
                "loan_term_months": r.loan_term_months,
                "credit_score": r.credit_score,
                "employment_years": r.employment_years,
                "debt_to_income": r.debt_to_income,
                "delinquencies_2yr": r.delinquencies_2yr,
                "home_ownership": r.home_ownership,
                "loan_purpose": r.loan_purpose,
            },
        )
        y.append(int(r.defaulted))
    return feature_rows, np.asarray(y, dtype=np.int64)


def _features_to_dataframe(feature_rows: list[dict[str, Any]]) -> Any:
    """Convert the list of dicts into a DataFrame lazily, with a pure-Python fallback."""
    try:
        import pandas as pd  # noqa: F401
    except ImportError:  # pragma: no cover - pandas always bundled with sklearn
        return feature_rows
    import pandas as pd

    return pd.DataFrame(feature_rows)


# ---------------------------------------------------------------------------
# Main training routine
# ---------------------------------------------------------------------------


def run_training(
    *,
    rows: int = 5000,
    seed: int = 42,
    data_path: Path | None = None,
    output_dir: Path | None = None,
) -> TrainingResult:
    """Train the model and return a :class:`TrainingResult` dataclass.

    Args:
        rows: Number of synthetic records to generate if no ``data_path``
            is supplied or if the file is missing.
        seed: RNG seed used for generation, split, and classifier init.
        data_path: Optional override — if a CSV already exists at this
            path it is loaded directly; otherwise the file is written.
        output_dir: Destination directory for ``model.pkl`` and
            ``metrics.json``.  Defaults to ``./outputs/`` relative to CWD.

    Returns:
        A :class:`TrainingResult` with AUC, accuracy, feature names, and
        the path to the serialized pipeline.
    """
    start = time.perf_counter()
    output_dir = (output_dir or Path("outputs")).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    # ---- data ----
    records = generate_loan_dataset(rows=rows, seed=seed)
    if data_path is not None:
        data_path.parent.mkdir(parents=True, exist_ok=True)
        write_csv(records, data_path)

    feature_rows, y = _load_data_as_arrays(records)
    x_df = _features_to_dataframe(feature_rows)

    # ---- split ----
    sk = _load_sklearn()
    x_train, x_test, y_train, y_test = sk["train_test_split"](
        x_df,
        y,
        test_size=0.25,
        random_state=seed,
        stratify=y,
    )

    # ---- fit ----
    pipeline = build_pipeline(seed=seed)
    pipeline.fit(x_train, y_train)

    # ---- evaluate ----
    y_pred = pipeline.predict(x_test)
    y_prob = pipeline.predict_proba(x_test)[:, 1]
    auc = float(sk["roc_auc_score"](y_test, y_prob))
    accuracy = float(sk["accuracy_score"](y_test, y_pred))

    # ---- persist ----
    import joblib

    model_path = output_dir / "model.pkl"
    joblib.dump(pipeline, model_path)

    metrics = {
        "auc": auc,
        "accuracy": accuracy,
        "n_train": len(y_train),
        "n_test": len(y_test),
        "default_rate_train": float(np.mean(y_train)),
        "default_rate_test": float(np.mean(y_test)),
        "seed": seed,
        "feature_names": list(NUMERIC_FEATURES + CATEGORICAL_FEATURES),
        "target": TARGET,
    }
    (output_dir / "metrics.json").write_text(
        json.dumps(metrics, indent=2) + "\n",
        encoding="utf-8",
    )

    duration = time.perf_counter() - start
    return TrainingResult(
        auc=auc,
        accuracy=accuracy,
        n_train=len(y_train),
        n_test=len(y_test),
        default_rate=float(np.mean(y)),
        feature_names=list(NUMERIC_FEATURES + CATEGORICAL_FEATURES),
        model_path=model_path,
        duration_sec=duration,
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=5000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--data", type=Path, default=None)
    parser.add_argument("--output-dir", type=Path, default=Path("outputs"))
    args: Any = parser.parse_args(argv)

    result = run_training(
        rows=args.rows,
        seed=args.seed,
        data_path=args.data,
        output_dir=args.output_dir,
    )
    print(
        f"Trained logistic regression on {result.n_train} rows "
        f"(test={result.n_test}). "
        f"AUC={result.auc:.4f} accuracy={result.accuracy:.4f} "
        f"duration={result.duration_sec:.2f}s "
        f"model={result.model_path}",
    )
    # Informative schema print
    print(f"Schema fields: {', '.join(FIELDNAMES)}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
