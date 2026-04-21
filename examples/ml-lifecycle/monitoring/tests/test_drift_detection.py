"""Drift-detection tests.

Covers both the PSI fallback (always available) and the Evidently path
(only asserted if ``evidently`` is importable; otherwise skipped).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

_MONITOR_DIR = Path(__file__).resolve().parent.parent
if str(_MONITOR_DIR) not in sys.path:
    sys.path.insert(0, str(_MONITOR_DIR))

from drift_detection import (  # noqa: E402
    NUMERIC_COLUMNS,
    ColumnDrift,
    DriftReport,
    _psi,
    detect_drift,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _reference_block(seed: int = 0) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    return {
        "applicant_age": rng.integers(18, 80, size=1000).astype(float),
        "annual_income": rng.normal(65_000, 15_000, size=1000),
        "loan_amount": rng.normal(18_000, 6_000, size=1000),
        "loan_term_months": rng.choice([24, 36, 48, 60], size=1000).astype(float),
        "credit_score": rng.normal(680, 70, size=1000),
        "employment_years": rng.uniform(0, 40, size=1000),
        "debt_to_income": rng.beta(2, 5, size=1000),
        "delinquencies_2yr": rng.poisson(0.6, size=1000).astype(float),
    }


def _drifted_block(seed: int = 1) -> dict[str, np.ndarray]:
    """Shift credit_score down and debt_to_income up — obvious drift."""
    rng = np.random.default_rng(seed)
    return {
        "applicant_age": rng.integers(18, 80, size=1000).astype(float),
        "annual_income": rng.normal(65_000, 15_000, size=1000),
        "loan_amount": rng.normal(18_000, 6_000, size=1000),
        "loan_term_months": rng.choice([24, 36, 48, 60], size=1000).astype(float),
        "credit_score": rng.normal(560, 80, size=1000),  # DRIFT: median drops 120
        "employment_years": rng.uniform(0, 40, size=1000),
        "debt_to_income": rng.beta(5, 2, size=1000),  # DRIFT: mass moves right
        "delinquencies_2yr": rng.poisson(2.5, size=1000).astype(float),  # DRIFT
    }


# ---------------------------------------------------------------------------
# PSI primitive
# ---------------------------------------------------------------------------


def test_psi_is_zero_for_identical_samples() -> None:
    rng = np.random.default_rng(0)
    x = rng.normal(0, 1, size=5000)
    assert _psi(x, x) == pytest.approx(0.0, abs=1e-6)


def test_psi_is_positive_for_shifted_samples() -> None:
    rng = np.random.default_rng(0)
    ref = rng.normal(0, 1, size=5000)
    shifted = rng.normal(3, 1, size=5000)
    assert _psi(ref, shifted) > 0.5


def test_psi_handles_degenerate_reference() -> None:
    # Single-valued reference → 0 (edges collapse).
    ref = np.ones(100)
    cur = np.array([1.0, 2.0, 3.0])
    assert _psi(ref, cur) == 0.0


# ---------------------------------------------------------------------------
# detect_drift — fallback path
# ---------------------------------------------------------------------------


def test_detect_drift_reports_no_drift_for_same_distribution() -> None:
    ref = _reference_block(seed=42)
    cur = _reference_block(seed=43)  # different seed, same distribution
    report = detect_drift(ref, cur, threshold=0.25, force_backend="psi")
    assert isinstance(report, DriftReport)
    assert report.dataset_drift is False
    assert report.drifted_columns == []
    assert report.backend == "psi_fallback"
    assert len(report.columns) == len(NUMERIC_COLUMNS)


def test_detect_drift_flags_shifted_distribution() -> None:
    ref = _reference_block(seed=42)
    cur = _drifted_block(seed=99)
    report = detect_drift(ref, cur, threshold=0.10, force_backend="psi")
    assert report.dataset_drift is True
    assert "credit_score" in report.drifted_columns
    assert "debt_to_income" in report.drifted_columns


def test_detect_drift_threshold_controls_sensitivity() -> None:
    """Very high threshold suppresses drift detection."""
    ref = _reference_block(seed=42)
    cur = _drifted_block(seed=99)
    # PSI on our synthetic drift reaches ~1-7; pick a threshold safely above.
    lax = detect_drift(ref, cur, threshold=100.0, force_backend="psi")
    assert lax.dataset_drift is False
    # Tight threshold still flags drift.
    strict = detect_drift(ref, cur, threshold=0.05, force_backend="psi")
    assert strict.dataset_drift is True


def test_detect_drift_min_drifted_columns_controls_quorum() -> None:
    ref = _reference_block(seed=42)
    cur = _drifted_block(seed=99)
    # Require 10 columns to drift — we only have 8 numeric, so can't.
    strict = detect_drift(
        ref,
        cur,
        threshold=0.1,
        min_drifted_columns=10,
        force_backend="psi",
    )
    assert strict.dataset_drift is False


def test_detect_drift_accepts_dataframe() -> None:
    pd = pytest.importorskip("pandas")
    ref_df = pd.DataFrame(_reference_block(seed=0))
    cur_df = pd.DataFrame(_drifted_block(seed=1))
    report = detect_drift(ref_df, cur_df, force_backend="psi")
    assert isinstance(report, DriftReport)


def test_column_drift_records_method() -> None:
    ref = _reference_block(seed=0)
    cur = _reference_block(seed=1)
    report = detect_drift(ref, cur, force_backend="psi")
    for col in report.columns:
        assert isinstance(col, ColumnDrift)
        assert col.method == "psi"


def test_report_is_json_serializable() -> None:
    ref = _reference_block(seed=0)
    cur = _drifted_block(seed=1)
    report = detect_drift(ref, cur, force_backend="psi")
    body = report.to_json()
    assert '"dataset_drift"' in body
    assert '"backend": "psi_fallback"' in body


# ---------------------------------------------------------------------------
# Evidently path (skip when not installed)
# ---------------------------------------------------------------------------


def test_evidently_path_used_when_available() -> None:
    pytest.importorskip("evidently")
    ref = _reference_block(seed=0)
    cur = _drifted_block(seed=1)
    report = detect_drift(ref, cur)  # no force_backend
    # The dataset_drift boolean must still match the strong shift.
    assert report.dataset_drift is True
    assert report.backend in ("evidently", "psi_fallback")
