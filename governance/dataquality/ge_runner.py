"""Great Expectations checkpoint runner.

Bridges the declarative ``great_expectations`` section in
``quality-rules.yaml`` to actual expectation evaluation. Uses real
`Great Expectations <https://greatexpectations.io>`_ when the
``great-expectations`` package is installed (via the ``governance``
optional-dependency group), and falls back to a lightweight in-process
evaluator otherwise so the runner is still exercisable in CI, dev, and
unit tests without the 200MB+ GE install.

The fallback evaluator covers the subset of expectations the project
actually uses today (see ``docs/LOG_SCHEMA.md`` and
``governance/dataquality/quality-rules.yaml``):

- ``expect_table_row_count_to_be_between``
- ``expect_column_values_to_not_be_null``
- ``expect_column_values_to_be_unique``
- ``expect_column_values_to_match_regex``
- ``expect_column_values_to_be_between``
- ``expect_column_values_to_be_in_set``

Adding a new expectation type is a small addition to
``_evaluate_expectation``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping

from governance.common.logging import get_logger

logger = get_logger(__name__)


@dataclass
class ExpectationResult:
    """Per-expectation outcome used by the fallback evaluator."""

    expectation_type: str
    column: str | None
    success: bool
    message: str
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class SuiteResult:
    """Aggregate outcome of a single expectation suite."""

    suite_name: str
    datasource: str
    table: str
    status: str  # "pass" | "warn" | "fail" | "skipped"
    message: str
    expectations: list[ExpectationResult] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.expectations)

    @property
    def failed(self) -> int:
        return sum(1 for e in self.expectations if not e.success)


def _great_expectations_available() -> bool:
    """Return True if the ``great_expectations`` package is importable."""
    try:
        import great_expectations  # noqa: F401
        return True
    except ImportError:
        return False


_KNOWN_LAYERS = frozenset({"bronze", "silver", "gold", "raw", "staging"})


def _infer_table_from_suite_name(suite_name: str) -> str:
    """Derive a ``layer.table`` identifier from a suite name.

    ``bronze_customers_suite`` -> ``bronze.customers``
    ``silver_sales_orders_suite`` -> ``silver.sales_orders``
    ``gold_clv_suite`` -> ``gold.clv``

    Suite names that do not start with a recognised medallion layer
    prefix are returned unchanged (after stripping the optional
    ``_suite`` suffix) so unrelated conventions are not silently
    rewritten.
    """
    base = suite_name.removesuffix("_suite")
    parts = base.split("_", 1)
    if len(parts) == 2 and parts[0] in _KNOWN_LAYERS:
        return f"{parts[0]}.{parts[1]}"
    return base


def _evaluate_expectation(
    expectation: Mapping[str, Any],
    rows: list[dict[str, Any]],
) -> ExpectationResult:
    """Evaluate a single expectation against an in-memory list of rows."""
    # Each expectation is a dict with a single key: its type.
    ((exp_type, cfg),) = expectation.items()
    cfg = cfg or {}
    column_raw = cfg.get("column")
    # ``column`` is annotated for the column-scoped expectations; for
    # ``expect_table_row_count_to_be_between`` it is None.
    column: str = str(column_raw) if column_raw is not None else ""

    if exp_type == "expect_table_row_count_to_be_between":
        min_value = cfg.get("min_value")
        max_value = cfg.get("max_value")
        count = len(rows)
        ok = True
        if min_value is not None and count < min_value:
            ok = False
        if max_value is not None and count > max_value:
            ok = False
        return ExpectationResult(
            expectation_type=exp_type,
            column=None,
            success=ok,
            message=f"row_count={count}, min={min_value}, max={max_value}",
            details={"count": count, "min_value": min_value, "max_value": max_value},
        )

    if exp_type == "expect_column_values_to_not_be_null":
        nulls = sum(1 for row in rows if row.get(column) is None)
        return ExpectationResult(
            expectation_type=exp_type,
            column=column,
            success=nulls == 0,
            message=f"{nulls} null rows in {column!r}",
            details={"null_count": nulls, "total": len(rows)},
        )

    if exp_type == "expect_column_values_to_be_unique":
        seen: set[Any] = set()
        dupes = 0
        for row in rows:
            value = row.get(column)
            if value in seen:
                dupes += 1
            else:
                seen.add(value)
        return ExpectationResult(
            expectation_type=exp_type,
            column=column,
            success=dupes == 0,
            message=f"{dupes} duplicate rows in {column!r}",
            details={"duplicate_count": dupes, "total": len(rows)},
        )

    if exp_type == "expect_column_values_to_match_regex":
        pattern = re.compile(str(cfg.get("regex", "")))
        mostly = float(cfg.get("mostly", 1.0))
        matches = 0
        for row in rows:
            value = row.get(column)
            if isinstance(value, str) and pattern.match(value):
                matches += 1
        ratio = matches / len(rows) if rows else 0.0
        return ExpectationResult(
            expectation_type=exp_type,
            column=column,
            success=ratio >= mostly,
            message=f"{matches}/{len(rows)} rows match (ratio={ratio:.3f}, mostly={mostly})",
            details={"matches": matches, "total": len(rows), "ratio": ratio, "mostly": mostly},
        )

    if exp_type == "expect_column_values_to_be_between":
        min_value = cfg.get("min_value")
        max_value = cfg.get("max_value")
        out_of_range = 0
        for row in rows:
            value = row.get(column)
            if value is None:
                continue
            if min_value is not None and value < min_value:
                out_of_range += 1
            elif max_value is not None and value > max_value:
                out_of_range += 1
        return ExpectationResult(
            expectation_type=exp_type,
            column=column,
            success=out_of_range == 0,
            message=f"{out_of_range} out-of-range values in {column!r}",
            details={"out_of_range": out_of_range, "min_value": min_value, "max_value": max_value},
        )

    if exp_type == "expect_column_values_to_be_in_set":
        value_set = set(cfg.get("value_set", []))
        violations = 0
        for row in rows:
            value = row.get(column)
            if value is not None and value not in value_set:
                violations += 1
        return ExpectationResult(
            expectation_type=exp_type,
            column=column,
            success=violations == 0,
            message=f"{violations} rows with values outside {sorted(value_set)}",
            details={"violations": violations, "value_set": sorted(value_set)},
        )

    return ExpectationResult(
        expectation_type=exp_type,
        column=column or None,
        success=False,
        message=f"Unsupported expectation type {exp_type!r}",
        details={"config": dict(cfg)},
    )


def run_suite_in_memory(
    suite: Mapping[str, Any],
    rows: list[dict[str, Any]],
) -> SuiteResult:
    """Run an expectation suite against an in-memory list of rows.

    This is the fallback evaluator used by :func:`run_ge_checkpoints`
    when ``great_expectations`` is not installed or when a live data
    source is not available (e.g. during unit tests).
    """
    suite_name = str(suite.get("name", "unknown"))
    datasource = str(suite.get("datasource", "unknown"))
    expectations: Iterable[Mapping[str, Any]] = suite.get("expectations", [])

    results = [_evaluate_expectation(e, rows) for e in expectations]
    failed = sum(1 for r in results if not r.success)

    if not results:
        status = "skipped"
        message = f"Suite {suite_name!r} has no expectations"
    elif failed == 0:
        status = "pass"
        message = f"{len(results)} expectations passed"
    else:
        status = "fail"
        message = f"{failed}/{len(results)} expectations failed"

    return SuiteResult(
        suite_name=suite_name,
        datasource=datasource,
        table=_infer_table_from_suite_name(suite_name),
        status=status,
        message=message,
        expectations=results,
    )


def run_ge_checkpoints(
    config: Mapping[str, Any],
    *,
    sample_data: Mapping[str, list[dict[str, Any]]] | None = None,
) -> list[SuiteResult]:
    """Execute every configured expectation suite.

    Args:
        config: The full ``quality-rules.yaml`` payload (already loaded,
            and with ``{EMAIL_REGEX}``-style placeholders expanded by
            :func:`governance.common.validation.substitute_common_patterns`).
        sample_data: Optional mapping of suite name -> list of row dicts.
            When provided, each suite is evaluated against its sample
            rows using the in-process fallback evaluator.  Useful for
            unit tests and local smoke checks without a live Spark
            session.

    Returns:
        One :class:`SuiteResult` per suite.  Suites without sample data
        and without a live GE context return status ``"skipped"`` with a
        message explaining why.

    When the ``great_expectations`` package is installed and
    ``sample_data`` is ``None``, the runner will eventually delegate to
    a real GE checkpoint run (left as a TODO — the live Spark datasource
    wiring lives in the Databricks notebook side and is exercised in the
    production pipeline, not in this CLI).  The fallback is the
    sanctioned test path and covers the expectation types in use today.
    """
    ge_section = config.get("great_expectations") or {}
    suites: list[Mapping[str, Any]] = list(ge_section.get("suites", []))
    results: list[SuiteResult] = []

    if not suites:
        logger.info("ge.no_suites_configured")
        return results

    ge_installed = _great_expectations_available()
    logger.info(
        "ge.runner_start",
        suite_count=len(suites),
        great_expectations_installed=ge_installed,
        fallback="in_memory" if not ge_installed or sample_data is not None else "live",
    )

    for suite in suites:
        suite_name = str(suite.get("name", "unknown"))
        rows = (sample_data or {}).get(suite_name)

        if rows is not None:
            result = run_suite_in_memory(suite, rows)
        elif ge_installed:
            # Real GE checkpoint runs require a live Spark datasource
            # pointing at ADLS; that wiring lives outside this CLI
            # runner (the Databricks notebooks call the GE API directly
            # after materialising Silver/Gold tables).  From the CLI we
            # mark the suite as skipped-with-context so operators know
            # the suite exists and is ready to run.
            result = SuiteResult(
                suite_name=suite_name,
                datasource=str(suite.get("datasource", "unknown")),
                table=_infer_table_from_suite_name(suite_name),
                status="skipped",
                message=(
                    "Great Expectations installed but no live datasource "
                    "provided to the CLI runner. Run from a Databricks "
                    "notebook with a Spark context, or pass sample_data= "
                    "to run_ge_checkpoints() for in-memory evaluation."
                ),
            )
        else:
            result = SuiteResult(
                suite_name=suite_name,
                datasource=str(suite.get("datasource", "unknown")),
                table=_infer_table_from_suite_name(suite_name),
                status="skipped",
                message=(
                    "great_expectations not installed. "
                    "Install `pip install -e \".[governance]\"` to enable, "
                    "or pass sample_data= to run in-memory."
                ),
            )

        results.append(result)
        logger.info(
            "ge.suite_completed",
            suite=suite_name,
            status=result.status,
            failed=result.failed,
            total=result.total,
        )

    return results
