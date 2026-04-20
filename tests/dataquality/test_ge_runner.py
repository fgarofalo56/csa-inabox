"""Tests for the Great Expectations checkpoint runner.

These exercise the in-memory fallback evaluator — the live Spark path
is only executed from Databricks and is not part of the unit test
scope.  The fallback is the sanctioned test path and must cover every
expectation type that appears in ``governance/dataquality/quality-rules.yaml``.
"""

from __future__ import annotations

from typing import Any

import pytest

from csa_platform.governance.common.validation import EMAIL_REGEX_PATTERN
from csa_platform.governance.dataquality.ge_runner import (
    SuiteResult,
    _evaluate_expectation,
    _infer_table_from_suite_name,
    run_ge_checkpoints,
    run_suite_in_memory,
)

# ---------------------------------------------------------------------------
# _infer_table_from_suite_name
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("suite_name", "expected"),
    [
        ("bronze_customers_suite", "bronze.customers"),
        ("silver_sales_orders_suite", "silver.sales_orders"),
        ("gold_clv_suite", "gold.clv"),
        ("no_suffix", "no_suffix"),
    ],
)
def test_infer_table_from_suite_name(suite_name: str, expected: str) -> None:
    assert _infer_table_from_suite_name(suite_name) == expected


# ---------------------------------------------------------------------------
# _evaluate_expectation — one case per supported expectation type
# ---------------------------------------------------------------------------


def test_expect_table_row_count_to_be_between_passes_within_range() -> None:
    rows = [{"id": i} for i in range(10)]
    result = _evaluate_expectation(
        {"expect_table_row_count_to_be_between": {"min_value": 5, "max_value": 20}},
        rows,
    )
    assert result.success is True


def test_expect_table_row_count_to_be_between_fails_below_min() -> None:
    rows = [{"id": 1}]
    result = _evaluate_expectation(
        {"expect_table_row_count_to_be_between": {"min_value": 10}},
        rows,
    )
    assert result.success is False


def test_expect_column_values_to_not_be_null_passes_when_clean() -> None:
    rows = [{"customer_id": "c1"}, {"customer_id": "c2"}]
    result = _evaluate_expectation(
        {"expect_column_values_to_not_be_null": {"column": "customer_id"}},
        rows,
    )
    assert result.success is True


def test_expect_column_values_to_not_be_null_fails_when_any_null() -> None:
    rows: list[dict[str, Any]] = [{"customer_id": "c1"}, {"customer_id": None}]
    result = _evaluate_expectation(
        {"expect_column_values_to_not_be_null": {"column": "customer_id"}},
        rows,
    )
    assert result.success is False
    assert result.details["null_count"] == 1


def test_expect_column_values_to_be_unique_fails_on_duplicates() -> None:
    rows = [{"id": 1}, {"id": 2}, {"id": 1}]
    result = _evaluate_expectation(
        {"expect_column_values_to_be_unique": {"column": "id"}},
        rows,
    )
    assert result.success is False
    assert result.details["duplicate_count"] == 1


def test_expect_column_values_to_match_regex_honours_mostly_threshold() -> None:
    rows = [
        {"email": "good@example.com"},
        {"email": "also-good@example.co"},
        {"email": "bad"},
    ]
    # 2/3 ≈ 0.667 — fails mostly=0.95, passes mostly=0.5
    result_strict = _evaluate_expectation(
        {
            "expect_column_values_to_match_regex": {
                "column": "email",
                "regex": EMAIL_REGEX_PATTERN,
                "mostly": 0.95,
            }
        },
        rows,
    )
    assert result_strict.success is False

    result_lenient = _evaluate_expectation(
        {
            "expect_column_values_to_match_regex": {
                "column": "email",
                "regex": EMAIL_REGEX_PATTERN,
                "mostly": 0.5,
            }
        },
        rows,
    )
    assert result_lenient.success is True


def test_expect_column_values_to_be_between_catches_negative_values() -> None:
    rows = [{"total_amount": 10}, {"total_amount": -5}]
    result = _evaluate_expectation(
        {
            "expect_column_values_to_be_between": {
                "column": "total_amount",
                "min_value": 0,
            }
        },
        rows,
    )
    assert result.success is False
    assert result.details["out_of_range"] == 1


def test_expect_column_values_to_be_in_set_passes_when_all_valid() -> None:
    rows = [
        {"status": "active"},
        {"status": "churned"},
        {"status": "at_risk"},
    ]
    result = _evaluate_expectation(
        {
            "expect_column_values_to_be_in_set": {
                "column": "status",
                "value_set": ["active", "at_risk", "churned", "never_purchased"],
            }
        },
        rows,
    )
    assert result.success is True


def test_evaluate_expectation_flags_unsupported_types() -> None:
    result = _evaluate_expectation(
        {"expect_something_novel": {"column": "x"}},
        [{"x": 1}],
    )
    assert result.success is False
    assert "Unsupported" in result.message


# ---------------------------------------------------------------------------
# run_suite_in_memory + run_ge_checkpoints
# ---------------------------------------------------------------------------


@pytest.fixture
def sample_suite() -> dict[str, Any]:
    return {
        "name": "bronze_customers_suite",
        "datasource": "adls_bronze",
        "expectations": [
            {"expect_table_row_count_to_be_between": {"min_value": 2}},
            {"expect_column_values_to_not_be_null": {"column": "customer_id"}},
            {"expect_column_values_to_be_unique": {"column": "customer_id"}},
        ],
    }


def test_run_suite_in_memory_reports_pass_when_all_expectations_hold(
    sample_suite: dict[str, Any],
) -> None:
    rows = [{"customer_id": "c1"}, {"customer_id": "c2"}, {"customer_id": "c3"}]
    result = run_suite_in_memory(sample_suite, rows)
    assert isinstance(result, SuiteResult)
    assert result.status == "pass"
    assert result.failed == 0
    assert result.total == 3
    assert result.table == "bronze.customers"


def test_run_suite_in_memory_reports_fail_when_any_expectation_fails(
    sample_suite: dict[str, Any],
) -> None:
    rows: list[dict[str, Any]] = [{"customer_id": "c1"}, {"customer_id": None}]  # row count ok, but null
    result = run_suite_in_memory(sample_suite, rows)
    assert result.status == "fail"
    assert result.failed == 1
    assert any(not e.success for e in result.expectations)


def test_run_ge_checkpoints_skips_without_sample_data_or_live_context() -> None:
    config = {
        "great_expectations": {
            "suites": [
                {
                    "name": "bronze_customers_suite",
                    "datasource": "adls_bronze",
                    "expectations": [
                        {"expect_table_row_count_to_be_between": {"min_value": 1}},
                    ],
                }
            ]
        }
    }
    results = run_ge_checkpoints(config)
    assert len(results) == 1
    assert results[0].status == "skipped"


def test_run_ge_checkpoints_uses_sample_data_when_provided() -> None:
    config = {
        "great_expectations": {
            "suites": [
                {
                    "name": "bronze_customers_suite",
                    "datasource": "adls_bronze",
                    "expectations": [
                        {"expect_column_values_to_not_be_null": {"column": "customer_id"}},
                    ],
                }
            ]
        }
    }
    results = run_ge_checkpoints(
        config,
        sample_data={
            "bronze_customers_suite": [
                {"customer_id": "c1"},
                {"customer_id": "c2"},
            ]
        },
    )
    assert len(results) == 1
    assert results[0].status == "pass"


def test_run_ge_checkpoints_returns_empty_for_missing_ge_section() -> None:
    assert run_ge_checkpoints({"rules": {}}) == []
