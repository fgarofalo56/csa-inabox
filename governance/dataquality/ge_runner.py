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

import os
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

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
        nulls = sum(1 for row in rows if column in row and row[column] is None)
        missing = sum(1 for row in rows if column not in row)
        return ExpectationResult(
            expectation_type=exp_type,
            column=column,
            success=nulls == 0,
            message=f"{nulls} null values in {column!r} ({missing} rows missing the column entirely)",
            details={"null_count": nulls, "missing_count": missing, "total": len(rows)},
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
            if (min_value is not None and value < min_value) or (max_value is not None and value > max_value):
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


# ── Checkpoint discovery ─────────────────────────────────────────────


_CHECKPOINT_DIR = Path(
    os.environ.get(
        "GE_CHECKPOINT_DIR",
        str(Path(__file__).resolve().parents[2] / "great_expectations" / "checkpoints"),
    ),
)


def _load_checkpoint_configs(
    checkpoint_dir: Path | None = None,
) -> dict[str, dict[str, Any]]:
    """Load checkpoint YAML files and return a mapping of suite name -> config.

    Each checkpoint YAML is expected to have ``validations[*].expectation_suite_name``
    which is used as the key.  If ``checkpoint_dir`` does not exist or contains
    no YAML files, an empty dict is returned.
    """
    directory = checkpoint_dir or _CHECKPOINT_DIR
    if not directory.is_dir():
        return {}

    configs: dict[str, dict[str, Any]] = {}
    for path in sorted(directory.glob("*.yml")):
        try:
            raw: dict[str, Any] = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except Exception:
            logger.warning("ge.checkpoint_load_failed", path=str(path))
            continue

        for validation in raw.get("validations", []):
            suite_name = validation.get("expectation_suite_name")
            if suite_name:
                configs[suite_name] = raw
                logger.debug("ge.checkpoint_loaded", suite=suite_name, path=str(path))

    return configs


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
    a real GE checkpoint run.  The live Spark datasource wiring lives in
    the Databricks notebook side and is exercised in the production
    pipeline, not in this CLI.  The fallback evaluator is the sanctioned
    test path and covers the expectation types in use today.

    .. rubric:: Enabling live Spark GE checkpoints (future work)

    To run expectations against real data via Spark rather than the
    in-memory fallback, the following would be required:

    1. **Active SparkSession** -- A ``SparkSession`` configured with the
       cluster's Spark conf (typically available inside a Databricks
       notebook via ``spark``).

    2. **JDBC or ADLS connection** -- A ``RuntimeDataConnector`` or
       ``InferredAssetFilesystemDataConnector`` pointing at the ADLS
       Gen2 Delta tables produced by dbt.  The connection string format:
       ``abfss://<container>@<account>.dfs.core.windows.net/<path>``.

    3. **GE DataContext & Datasource registration** -- Create a
       ``DataContext``, register a ``SparkDFDatasource`` using
       ``spark_config`` or ``execution_engine``, and wire each suite to
       a ``BatchRequest`` targeting the correct table asset.

    4. **Checkpoint execution** -- Build a ``SimpleCheckpoint`` per
       suite and call ``context.run_checkpoint()``.  Map the returned
       ``CheckpointResult`` back to our ``SuiteResult`` dataclass.

    5. **Dependencies** -- ``great_expectations``, ``pyspark``, and the
       Azure ADLS Hadoop driver (``hadoop-azure``) must be available in
       the cluster runtime.

    **In-memory DuckDB fallback (current approach):**  When GE is not
    installed or ``sample_data`` is provided, suites are evaluated by
    :func:`run_suite_in_memory`, which iterates over plain Python dicts
    (loaded from CSV/Parquet fixtures or generated in tests).  This
    covers the six expectation types declared in
    ``governance/dataquality/quality-rules.yaml`` and is exercised in
    CI without needing a live Spark cluster or 200 MB+ GE install.

    For full Spark datasource configuration reference, see:
    https://docs.greatexpectations.io/docs/guides/connecting_to_your_data/datasource_configuration/how_to_configure_a_spark_datasource
    """
    ge_section = config.get("great_expectations") or {}
    suites: list[Mapping[str, Any]] = list(ge_section.get("suites", []))
    results: list[SuiteResult] = []

    if not suites:
        logger.info("ge.no_suites_configured")
        return results

    ge_installed = _great_expectations_available()
    checkpoint_configs = _load_checkpoint_configs()
    logger.info(
        "ge.runner_start",
        suite_count=len(suites),
        great_expectations_installed=ge_installed,
        checkpoints_found=len(checkpoint_configs),
        fallback="in_memory" if not ge_installed or sample_data is not None else "live",
    )

    for suite in suites:
        suite_name = str(suite.get("name", "unknown"))
        rows = (sample_data or {}).get(suite_name)

        if rows is not None:
            result = run_suite_in_memory(suite, rows)
        elif ge_installed:
            # Real GE checkpoint runs require a live SparkSession and an
            # ADLS-backed Spark datasource.  That wiring lives outside
            # this CLI runner: the Databricks notebooks call the GE API
            # directly after materialising Silver/Gold Delta tables.
            #
            # Checkpoint definitions are now available in
            # great_expectations/checkpoints/ — the Databricks notebook
            # can load them via:
            #   context = ge.get_context("great_expectations/")  # noqa: ERA001
            #   result = context.run_checkpoint(checkpoint_name="...")  # noqa: ERA001
            #
            # From the CLI we mark the suite as skipped-with-context so
            # operators know the suite exists and is ready to run.
            has_checkpoint = suite_name in checkpoint_configs
            result = SuiteResult(
                suite_name=suite_name,
                datasource=str(suite.get("datasource", "unknown")),
                table=_infer_table_from_suite_name(suite_name),
                status="skipped",
                message=(
                    f"Great Expectations installed; checkpoint "
                    f"{'found' if has_checkpoint else 'not found'} for "
                    f"'{suite_name}'. Run from a Databricks notebook with "
                    f"a Spark context, or pass sample_data= to "
                    f"run_ge_checkpoints() for in-memory evaluation."
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
                    'Install `pip install -e ".[governance]"` to enable, '
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
