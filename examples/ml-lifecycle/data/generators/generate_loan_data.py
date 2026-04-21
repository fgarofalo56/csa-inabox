"""Deterministic synthetic loan-default dataset generator.

Purpose
-------
Produces a seeded, reproducible CSV of loan-application records for the
CSA ``ml-lifecycle`` example.  The dataset is designed so a logistic
regression trained on it reliably clears ``AUC >= 0.70`` — training
tests assert that threshold.

Determinism
-----------
Same ``--seed`` and ``--rows`` → same SHA-256.  Uses :mod:`numpy` RNG
with an explicit seed; no wall-clock entropy enters the generator.

Schema
------
See ``contracts/loan_training_features.yaml`` for the authoritative
field list.  Columns produced:

    application_id      string, PK
    application_ts      ISO-8601 UTC timestamp (synthetic)
    applicant_age       int, 18..80
    annual_income       float, USD
    loan_amount         float, USD
    loan_term_months    int, {12, 24, 36, 48, 60}
    credit_score        int, 300..850 (FICO range)
    employment_years    float, 0..40
    debt_to_income      float, 0..1.5
    home_ownership      {OWN, RENT, MORTGAGE}
    loan_purpose        {AUTO, HOME_IMPROVEMENT, DEBT_CONSOLIDATION, BUSINESS, EDUCATION}
    delinquencies_2yr   int, 0..10
    defaulted           int, 0/1 (target)

Usage::

    python -m examples.ml_lifecycle.data.generators.generate_loan_data \\
        --rows 5000 --seed 42 --output data/loans.csv
"""

from __future__ import annotations

import argparse
import csv
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

HOME_OWNERSHIP_CATEGORIES: tuple[str, ...] = ("OWN", "RENT", "MORTGAGE")
HOME_OWNERSHIP_WEIGHTS: tuple[float, ...] = (0.25, 0.40, 0.35)

LOAN_PURPOSES: tuple[str, ...] = (
    "AUTO",
    "HOME_IMPROVEMENT",
    "DEBT_CONSOLIDATION",
    "BUSINESS",
    "EDUCATION",
)
LOAN_PURPOSE_WEIGHTS: tuple[float, ...] = (0.20, 0.15, 0.35, 0.15, 0.15)

LOAN_TERM_MONTHS: tuple[int, ...] = (12, 24, 36, 48, 60)
LOAN_TERM_WEIGHTS: tuple[float, ...] = (0.10, 0.25, 0.35, 0.20, 0.10)


# ---------------------------------------------------------------------------
# Data shape
# ---------------------------------------------------------------------------


@dataclass
class LoanRecord:
    application_id: str
    application_ts: str
    applicant_age: int
    annual_income: float
    loan_amount: float
    loan_term_months: int
    credit_score: int
    employment_years: float
    debt_to_income: float
    home_ownership: str
    loan_purpose: str
    delinquencies_2yr: int
    defaulted: int


# ---------------------------------------------------------------------------
# Generator
# ---------------------------------------------------------------------------


def generate_loan_dataset(
    rows: int = 5000,
    seed: int = 42,
) -> list[LoanRecord]:
    """Generate a deterministic list of :class:`LoanRecord` instances.

    Args:
        rows: Number of records to produce.
        seed: RNG seed — same seed gives the exact same output.

    Returns:
        A list of ``rows`` loan records with a realistic class balance
        (~20% defaulted).  The label depends on a linear combination of
        ``credit_score``, ``debt_to_income``, ``delinquencies_2yr``, and
        ``employment_years`` so a logistic regression can learn it.
    """
    rng = np.random.default_rng(seed)

    # ---- features ----
    # Applicant age: mildly right-skewed
    ages = rng.integers(low=18, high=81, size=rows)

    # Annual income: log-normal, median around 65k
    annual_income = np.clip(
        np.exp(rng.normal(loc=10.95, scale=0.45, size=rows)),
        15_000.0,
        400_000.0,
    )

    # Credit score: beta-ish centered ~680
    credit_score = np.clip(
        rng.normal(loc=680, scale=70, size=rows),
        300,
        850,
    ).astype(int)

    # Employment years: uniform 0..40, truncated by age
    employment_years = np.minimum(
        rng.uniform(low=0.0, high=40.0, size=rows),
        np.maximum(ages - 18, 0).astype(float),
    )

    # Loan amount: correlated with income
    loan_amount = np.clip(
        annual_income * rng.uniform(0.05, 0.6, size=rows),
        1_000.0,
        250_000.0,
    )

    loan_term_months = rng.choice(
        LOAN_TERM_MONTHS,
        size=rows,
        p=LOAN_TERM_WEIGHTS,
    )

    # Debt-to-income: right-skewed, clipped
    debt_to_income = np.clip(
        rng.beta(a=2.0, b=5.0, size=rows) * 1.2,
        0.0,
        1.5,
    )

    delinquencies_2yr = rng.poisson(lam=0.6, size=rows).clip(max=10)

    home_ownership = rng.choice(
        HOME_OWNERSHIP_CATEGORIES,
        size=rows,
        p=HOME_OWNERSHIP_WEIGHTS,
    )
    loan_purpose = rng.choice(
        LOAN_PURPOSES,
        size=rows,
        p=LOAN_PURPOSE_WEIGHTS,
    )

    # ---- label (defaulted) ----
    # Normalised features
    cs_norm = (credit_score - 680) / 70.0  # higher is safer
    dti_norm = (debt_to_income - 0.3) / 0.25  # higher is riskier
    delinq_norm = delinquencies_2yr / 2.0  # higher is riskier
    emp_norm = (employment_years - 10.0) / 10.0  # higher is safer

    # Linear log-odds score.  Coefficients tuned so:
    #   - defaults end up around 18-25% (realistic baseline)
    #   - model AUC with these features lands ~0.80-0.88
    logits = (
        -1.7
        + -1.4 * cs_norm
        + 1.3 * dti_norm
        + 0.9 * delinq_norm
        + -0.55 * emp_norm
        + 0.45 * (loan_amount / 50_000.0 - 1.0)
    )
    # Add modest noise so the problem isn't trivially separable.
    logits = logits + rng.normal(loc=0.0, scale=0.35, size=rows)
    prob_default = 1.0 / (1.0 + np.exp(-logits))
    defaulted = (rng.uniform(0, 1, size=rows) < prob_default).astype(int)

    # ---- assemble ----
    records: list[LoanRecord] = []
    # Deterministic synthetic timestamps (one per record, ascending).
    # We deliberately avoid datetime.now() so the CSV is reproducible.
    base_epoch = 1_700_000_000  # fixed, 2023-11-14T22:13:20Z
    for i in range(rows):
        record = LoanRecord(
            application_id=f"APP-{seed:04d}-{i:07d}",
            application_ts=_format_epoch(base_epoch + int(i) * 300),
            applicant_age=int(ages[i]),
            annual_income=float(round(annual_income[i], 2)),
            loan_amount=float(round(loan_amount[i], 2)),
            loan_term_months=int(loan_term_months[i]),
            credit_score=int(credit_score[i]),
            employment_years=float(round(employment_years[i], 2)),
            debt_to_income=float(round(debt_to_income[i], 4)),
            home_ownership=str(home_ownership[i]),
            loan_purpose=str(loan_purpose[i]),
            delinquencies_2yr=int(delinquencies_2yr[i]),
            defaulted=int(defaulted[i]),
        )
        records.append(record)
    return records


def _format_epoch(epoch: int) -> str:
    """Format a POSIX epoch as a UTC ISO-8601 string without importing datetime."""
    # Avoid datetime.now()/utcnow() so outputs are deterministic.
    import time

    # time.gmtime is deterministic for a given epoch.
    t = time.gmtime(epoch)
    return (
        f"{t.tm_year:04d}-{t.tm_mon:02d}-{t.tm_mday:02d}T"
        f"{t.tm_hour:02d}:{t.tm_min:02d}:{t.tm_sec:02d}Z"
    )


# ---------------------------------------------------------------------------
# IO
# ---------------------------------------------------------------------------


FIELDNAMES: tuple[str, ...] = (
    "application_id",
    "application_ts",
    "applicant_age",
    "annual_income",
    "loan_amount",
    "loan_term_months",
    "credit_score",
    "employment_years",
    "debt_to_income",
    "home_ownership",
    "loan_purpose",
    "delinquencies_2yr",
    "defaulted",
)


def write_csv(records: list[LoanRecord], output: Path) -> None:
    """Write the records to ``output`` in deterministic CSV form."""
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh, lineterminator="\n")
        writer.writerow(FIELDNAMES)
        for r in records:
            writer.writerow(
                [
                    r.application_id,
                    r.application_ts,
                    r.applicant_age,
                    _fmt_num(r.annual_income),
                    _fmt_num(r.loan_amount),
                    r.loan_term_months,
                    r.credit_score,
                    _fmt_num(r.employment_years),
                    _fmt_num(r.debt_to_income),
                    r.home_ownership,
                    r.loan_purpose,
                    r.delinquencies_2yr,
                    r.defaulted,
                ],
            )


def _fmt_num(value: float) -> str:
    """Format numeric values deterministically (no locale drift)."""
    # Trim trailing zeros so 1000.0 → "1000" and 0.1234 stays "0.1234".
    return f"{value:.4f}".rstrip("0").rstrip(".")


def compute_sha256(path: Path) -> str:
    """Return the SHA-256 hex digest of ``path`` — used by determinism tests."""
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=5000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/loans.csv"),
    )
    args: Any = parser.parse_args(argv)

    records = generate_loan_dataset(rows=args.rows, seed=args.seed)
    write_csv(records, args.output)
    digest = compute_sha256(args.output)

    default_rate = sum(r.defaulted for r in records) / len(records)
    print(
        f"Wrote {len(records)} rows to {args.output} "
        f"(default_rate={default_rate:.1%}, sha256={digest})",
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
