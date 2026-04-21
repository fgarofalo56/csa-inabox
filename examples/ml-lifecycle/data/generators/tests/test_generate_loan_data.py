"""Tests for ``generate_loan_data.py``.

Asserts:
  * Determinism — same seed → same row list → same SHA-256.
  * Schema — every record has the documented fields and sane ranges.
  * Signal — the default rate falls within a plausible window so the
    dataset is not trivially degenerate for a classifier.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Add generators package to path (this is an ad-hoc example, not an installed pkg).
_GEN_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_GEN_DIR))

from generate_loan_data import (  # noqa: E402
    FIELDNAMES,
    HOME_OWNERSHIP_CATEGORIES,
    LOAN_PURPOSES,
    LOAN_TERM_MONTHS,
    compute_sha256,
    generate_loan_dataset,
    write_csv,
)


def test_dataset_is_deterministic_for_fixed_seed() -> None:
    a = generate_loan_dataset(rows=200, seed=42)
    b = generate_loan_dataset(rows=200, seed=42)
    assert len(a) == len(b) == 200
    # Every field of every record matches byte-for-byte
    for ra, rb in zip(a, b):
        assert ra == rb


def test_dataset_differs_for_different_seed() -> None:
    a = generate_loan_dataset(rows=200, seed=1)
    b = generate_loan_dataset(rows=200, seed=2)
    # Non-trivial datasets produced by different seeds shouldn't match
    assert any(ra != rb for ra, rb in zip(a, b))


def test_sha256_is_reproducible(tmp_path: Path) -> None:
    p1 = tmp_path / "run1.csv"
    p2 = tmp_path / "run2.csv"
    write_csv(generate_loan_dataset(rows=500, seed=7), p1)
    write_csv(generate_loan_dataset(rows=500, seed=7), p2)
    assert compute_sha256(p1) == compute_sha256(p2)


def test_schema_shape(tmp_path: Path) -> None:
    rows = generate_loan_dataset(rows=100, seed=42)
    p = tmp_path / "loans.csv"
    write_csv(rows, p)

    header = p.read_text(encoding="utf-8").splitlines()[0].split(",")
    assert tuple(header) == FIELDNAMES


def test_field_ranges() -> None:
    rows = generate_loan_dataset(rows=1000, seed=3)
    for r in rows:
        assert 18 <= r.applicant_age <= 80
        assert 15_000.0 <= r.annual_income <= 400_000.0
        assert 1_000.0 <= r.loan_amount <= 250_000.0
        assert r.loan_term_months in LOAN_TERM_MONTHS
        assert 300 <= r.credit_score <= 850
        assert 0.0 <= r.employment_years <= 40.0
        assert 0.0 <= r.debt_to_income <= 1.5
        assert r.home_ownership in HOME_OWNERSHIP_CATEGORIES
        assert r.loan_purpose in LOAN_PURPOSES
        assert 0 <= r.delinquencies_2yr <= 10
        assert r.defaulted in (0, 1)


def test_default_rate_is_plausible() -> None:
    rows = generate_loan_dataset(rows=2000, seed=11)
    rate = sum(r.defaulted for r in rows) / len(rows)
    # Realistic subprime/near-prime default rate window.  The lower bound
    # guards against degenerate always-0 targets; the upper against
    # degenerate always-1 targets.
    assert 0.10 <= rate <= 0.40, f"default rate out of range: {rate:.2%}"


def test_signal_correlates_with_credit_score() -> None:
    """Simple statistical sanity: defaulters have lower mean credit score."""
    rows = generate_loan_dataset(rows=3000, seed=5)
    defaulters = [r.credit_score for r in rows if r.defaulted == 1]
    performers = [r.credit_score for r in rows if r.defaulted == 0]
    assert defaulters, "no defaulters in sample"
    assert performers, "no performers in sample"
    assert (sum(defaulters) / len(defaulters)) < (sum(performers) / len(performers))
