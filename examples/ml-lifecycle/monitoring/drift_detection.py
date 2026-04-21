"""Data-drift detection for the loan-default model.

Compares a ``current`` snapshot of scoring inputs against a ``reference``
distribution (usually the training set) and returns a
:class:`DriftReport` dataclass.  Two code paths are provided:

1. **Evidently (preferred)** — when :mod:`evidently` is installed the
   detector delegates to ``Report(metrics=[DataDriftPreset()])`` and
   extracts the ``dataset_drift`` bit and per-column drift flags from
   the report JSON.
2. **Pure-NumPy fallback** — when Evidently is missing (typical in CI
   lanes that don't install the ``ml`` extra) a lightweight Population
   Stability Index (PSI) + chi-squared proxy is used.  The two paths
   produce comparable dataset-level drift verdicts for our synthetic
   data.

CLI::

    python drift_detection.py \\
        --reference data/train.csv \\
        --current data/prod_sample.csv

Exit code ``0`` → no drift.  ``1`` → drift detected.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np


# ---------------------------------------------------------------------------
# Report shape
# ---------------------------------------------------------------------------


@dataclass
class ColumnDrift:
    column: str
    drift_score: float
    drifted: bool
    method: str


@dataclass
class DriftReport:
    """Top-level drift report.

    Attributes:
        dataset_drift: ``True`` if at least ``min_drifted_columns``
            numeric columns drifted.
        drifted_columns: Names of the columns that drifted.
        columns: Per-column scores.
        backend: ``"evidently"`` or ``"psi_fallback"``.
        threshold: Drift threshold used.
    """

    dataset_drift: bool
    drifted_columns: list[str]
    columns: list[ColumnDrift]
    backend: str
    threshold: float
    min_drifted_columns: int = 1
    extra: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)


# ---------------------------------------------------------------------------
# Feature catalogue (shared with training)
# ---------------------------------------------------------------------------

NUMERIC_COLUMNS: tuple[str, ...] = (
    "applicant_age",
    "annual_income",
    "loan_amount",
    "loan_term_months",
    "credit_score",
    "employment_years",
    "debt_to_income",
    "delinquencies_2yr",
)


# ---------------------------------------------------------------------------
# PSI helpers (fallback backend)
# ---------------------------------------------------------------------------


def _psi(
    reference: np.ndarray,
    current: np.ndarray,
    *,
    bins: int = 10,
    eps: float = 1e-6,
) -> float:
    """Population Stability Index between two numeric arrays.

    PSI < 0.10 → no significant shift.
    PSI 0.10-0.25 → moderate shift.
    PSI > 0.25 → major shift.
    """
    ref = np.asarray(reference, dtype=float)
    cur = np.asarray(current, dtype=float)
    ref = ref[np.isfinite(ref)]
    cur = cur[np.isfinite(cur)]
    if ref.size == 0 or cur.size == 0:
        return 0.0
    # Build quantile-based edges from reference so equal-frequency bins
    # make PSI invariant to outliers.
    quantiles = np.linspace(0.0, 1.0, bins + 1)
    edges = np.quantile(ref, quantiles)
    # Collapse duplicates (degenerate distributions).
    edges = np.unique(edges)
    if edges.size <= 2:
        return 0.0
    ref_hist, _ = np.histogram(ref, bins=edges)
    cur_hist, _ = np.histogram(cur, bins=edges)
    ref_pct = ref_hist / max(ref.size, 1)
    cur_pct = cur_hist / max(cur.size, 1)
    # Stability: smooth with eps to avoid log(0).
    ref_pct = np.clip(ref_pct, eps, None)
    cur_pct = np.clip(cur_pct, eps, None)
    return float(np.sum((cur_pct - ref_pct) * np.log(cur_pct / ref_pct)))


def _detect_drift_psi(
    reference: dict[str, np.ndarray],
    current: dict[str, np.ndarray],
    *,
    threshold: float,
    min_drifted_columns: int,
) -> DriftReport:
    columns: list[ColumnDrift] = []
    for col in reference:
        if col not in current:
            continue
        score = _psi(reference[col], current[col])
        columns.append(
            ColumnDrift(
                column=col,
                drift_score=round(score, 6),
                drifted=score > threshold,
                method="psi",
            ),
        )
    drifted = [c.column for c in columns if c.drifted]
    return DriftReport(
        dataset_drift=len(drifted) >= min_drifted_columns,
        drifted_columns=drifted,
        columns=columns,
        backend="psi_fallback",
        threshold=threshold,
        min_drifted_columns=min_drifted_columns,
    )


# ---------------------------------------------------------------------------
# Evidently backend (preferred when installed)
# ---------------------------------------------------------------------------


def _try_evidently(
    reference: dict[str, np.ndarray],
    current: dict[str, np.ndarray],
    *,
    threshold: float,
    min_drifted_columns: int,
) -> DriftReport | None:
    try:
        import pandas as pd
        from evidently.metric_preset import DataDriftPreset
        from evidently.report import Report
    except ImportError:
        return None

    ref_df = pd.DataFrame(reference)
    cur_df = pd.DataFrame(current)

    report = Report(metrics=[DataDriftPreset()])
    report.run(reference_data=ref_df, current_data=cur_df)
    payload = json.loads(report.json())

    # Evidently >=0.4 shape.
    columns: list[ColumnDrift] = []
    drifted: list[str] = []
    try:
        drift_metric = payload["metrics"][0]["result"]
        drift_by_column = drift_metric.get("drift_by_columns", {})
        for name, info in drift_by_column.items():
            score = float(info.get("drift_score", 0.0))
            is_drift = bool(info.get("drift_detected", False))
            columns.append(
                ColumnDrift(
                    column=name,
                    drift_score=round(score, 6),
                    drifted=is_drift,
                    method=str(info.get("stattest_name", "evidently")),
                ),
            )
            if is_drift:
                drifted.append(name)
    except (KeyError, IndexError, TypeError):
        # If the Evidently schema changed, fall back to PSI.
        return None

    return DriftReport(
        dataset_drift=len(drifted) >= min_drifted_columns,
        drifted_columns=drifted,
        columns=columns,
        backend="evidently",
        threshold=threshold,
        min_drifted_columns=min_drifted_columns,
        extra={},
    )


# ---------------------------------------------------------------------------
# Public entrypoint
# ---------------------------------------------------------------------------


def detect_drift(
    reference: dict[str, np.ndarray] | Any,
    current: dict[str, np.ndarray] | Any,
    *,
    threshold: float = 0.20,
    min_drifted_columns: int = 1,
    force_backend: str | None = None,
) -> DriftReport:
    """Detect data drift between ``reference`` and ``current``.

    Args:
        reference: Reference distribution.  Dict of ``{column: np.array}``
            or anything that :class:`pandas.DataFrame` can consume.
        current: Current distribution, same shape as ``reference``.
        threshold: PSI drift threshold (ignored when Evidently is used;
            Evidently uses its own per-stattest thresholds).
        min_drifted_columns: How many columns must drift before the
            report flags ``dataset_drift=True``.
        force_backend: ``"evidently"`` or ``"psi"`` — forces a specific
            backend regardless of availability.  Default ``None`` picks
            Evidently when importable, else PSI.

    Returns:
        A :class:`DriftReport`.
    """
    # Normalise inputs to {col: 1-D numpy array}.
    ref_norm = _normalise(reference)
    cur_norm = _normalise(current)

    if force_backend == "psi":
        return _detect_drift_psi(
            ref_norm,
            cur_norm,
            threshold=threshold,
            min_drifted_columns=min_drifted_columns,
        )

    if force_backend in (None, "evidently"):
        maybe_report = _try_evidently(
            ref_norm,
            cur_norm,
            threshold=threshold,
            min_drifted_columns=min_drifted_columns,
        )
        if maybe_report is not None:
            return maybe_report

    return _detect_drift_psi(
        ref_norm,
        cur_norm,
        threshold=threshold,
        min_drifted_columns=min_drifted_columns,
    )


def _normalise(data: Any) -> dict[str, np.ndarray]:
    if isinstance(data, dict):
        return {
            col: np.asarray(arr, dtype=float)
            for col, arr in data.items()
            if col in NUMERIC_COLUMNS
        }
    # DataFrame / list-of-dicts path.
    try:
        import pandas as pd

        df = data if hasattr(data, "to_dict") else pd.DataFrame(data)
        cols = [c for c in NUMERIC_COLUMNS if c in df.columns]
        return {col: df[col].to_numpy(dtype=float) for col in cols}
    except ImportError:  # pragma: no cover - pandas bundled with sklearn
        raise


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    import pandas as pd

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--current", type=Path, required=True)
    parser.add_argument("--threshold", type=float, default=0.20)
    parser.add_argument("--min-drifted-columns", type=int, default=1)
    args = parser.parse_args(argv)

    ref_df = pd.read_csv(args.reference)
    cur_df = pd.read_csv(args.current)
    report = detect_drift(
        ref_df,
        cur_df,
        threshold=args.threshold,
        min_drifted_columns=args.min_drifted_columns,
    )
    print(report.to_json())
    return 1 if report.dataset_drift else 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())


__all__ = [
    "ColumnDrift",
    "DriftReport",
    "NUMERIC_COLUMNS",
    "detect_drift",
]
