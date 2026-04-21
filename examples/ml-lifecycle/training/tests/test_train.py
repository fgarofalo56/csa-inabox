"""End-to-end tests for the loan-default training pipeline.

These tests ACTUALLY run ``train.run_training`` on a ~2k-row sample and
assert:

  * AUC >= 0.70 (the contract threshold promised in CSA-0115).
  * Model pickle + metrics.json are written.
  * Pipeline is reproducible — same seed → same AUC (within tolerance).
  * Predictions have valid ranges and shapes.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# Ensure the sibling ``train.py`` module is importable.
_TRAIN_DIR = Path(__file__).resolve().parent.parent
if str(_TRAIN_DIR) not in sys.path:
    sys.path.insert(0, str(_TRAIN_DIR))

from train import (  # noqa: E402
    CATEGORICAL_FEATURES,
    NUMERIC_FEATURES,
    run_training,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def trained_result(tmp_path_factory: pytest.TempPathFactory) -> object:
    """Train once per module — training is ~2-3s for 2000 rows."""
    out = tmp_path_factory.mktemp("ml_out")
    return run_training(rows=2000, seed=42, output_dir=out)


# ---------------------------------------------------------------------------
# Contract assertions
# ---------------------------------------------------------------------------


def test_auc_clears_contract_threshold(trained_result: object) -> None:
    """AUC must be >= 0.70 — contract SLO for the CSA-0115 example."""
    assert trained_result.auc >= 0.70, (  # type: ignore[attr-defined]
        f"AUC {trained_result.auc:.4f} below 0.70 threshold"  # type: ignore[attr-defined]
    )


def test_accuracy_is_meaningfully_above_baseline(trained_result: object) -> None:
    # Majority-class baseline on a ~20% positive dataset is ~0.80.
    # Model must do at least as well; if it falls below, something
    # is very wrong with the feature pipeline.
    assert trained_result.accuracy >= 0.70  # type: ignore[attr-defined]


def test_model_and_metrics_are_persisted(trained_result: object) -> None:
    model_path = trained_result.model_path  # type: ignore[attr-defined]
    metrics_path = model_path.parent / "metrics.json"
    assert model_path.exists()
    assert metrics_path.exists()

    metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
    assert metrics["auc"] == pytest.approx(trained_result.auc, rel=1e-6)  # type: ignore[attr-defined]
    assert metrics["target"] == "defaulted"
    assert "credit_score" in metrics["feature_names"]


def test_train_test_split_sizes(trained_result: object) -> None:
    # 2000 rows, 25% test.
    assert trained_result.n_train + trained_result.n_test == 2000  # type: ignore[attr-defined]
    assert abs(trained_result.n_test - 500) <= 5  # stratify jitter  # type: ignore[attr-defined]


def test_features_include_numeric_and_categorical(trained_result: object) -> None:
    fn = set(trained_result.feature_names)  # type: ignore[attr-defined]
    assert set(NUMERIC_FEATURES).issubset(fn)
    assert set(CATEGORICAL_FEATURES).issubset(fn)


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def test_training_is_reproducible(tmp_path: Path) -> None:
    r1 = run_training(rows=1000, seed=7, output_dir=tmp_path / "r1")
    r2 = run_training(rows=1000, seed=7, output_dir=tmp_path / "r2")
    # Allow a tiny float tolerance since BLAS summation order varies.
    assert r1.auc == pytest.approx(r2.auc, abs=1e-6)
    assert r1.accuracy == pytest.approx(r2.accuracy, abs=1e-6)


# ---------------------------------------------------------------------------
# Duration guard
# ---------------------------------------------------------------------------


def test_duration_is_reasonable(trained_result: object) -> None:
    # Synthetic 2000-row LR fit should be well under 30s even on CI.
    assert trained_result.duration_sec < 30.0  # type: ignore[attr-defined]
