#!/usr/bin/env python3
"""
Data Quality Runner — Executes quality checks and reports results.

Integrates with:
- dbt tests (via dbt test command)
- Great Expectations (via GE checkpoint runs)
- Azure Monitor (custom metrics for observability)
- Azure Log Analytics (structured quality logs)

Usage:
    python run_quality_checks.py --suite bronze --config quality-rules.yaml
    python run_quality_checks.py --suite all --report
    python run_quality_checks.py --freshness-only
"""

import argparse
import json
import subprocess
import sys
from collections.abc import MutableMapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


def _ensure_repo_root_on_path() -> None:
    """Add the repo root to sys.path so governance.common imports work."""
    repo_root = str(Path(__file__).resolve().parents[2])
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)


if __name__ == "__main__":
    _ensure_repo_root_on_path()

from csa_platform.governance.common.logging import (  # noqa: E402
    configure_structlog,
    get_logger,
    new_correlation_id,
)
from csa_platform.governance.common.validation import substitute_common_patterns  # noqa: E402
from csa_platform.governance.dataquality.ge_runner import (  # noqa: E402
    SuiteResult,
    run_ge_checkpoints,
)

configure_structlog(service="csa-data-quality")
logger = get_logger("data_quality")


class QualityCheckResult:
    """Result of a single quality check."""

    def __init__(
        self,
        check_name: str,
        table: str,
        status: str,  # "pass", "warn", "fail"
        message: str = "",
        details: dict[str, Any] | None = None,
    ):
        self.check_name = check_name
        self.table = table
        self.status = status
        self.message = message
        self.details = details or {}
        self.timestamp = datetime.now(timezone.utc).isoformat()

    def to_dict(self) -> dict[str, Any]:
        return {
            "check_name": self.check_name,
            "table": self.table,
            "status": self.status,
            "message": self.message,
            "details": self.details,
            "timestamp": self.timestamp,
        }


class DataQualityRunner:
    """Orchestrates data quality checks."""

    def __init__(self, config_path: str):
        with open(config_path) as f:
            raw_config = yaml.safe_load(f)
        # Expand shared-pattern placeholders like {EMAIL_REGEX} so the rule
        # file stays in sync with governance.common.validation.
        self.config = substitute_common_patterns(raw_config)
        self.results: list[QualityCheckResult] = []

    def run_dbt_tests(self, select: str = "") -> list[QualityCheckResult]:
        """Run dbt tests and parse results."""
        logger.info("dbt.tests.starting", select=select or "all")
        cmd = ["dbt", "test", "--profiles-dir", ".", "--project-dir", "."]
        if select:
            import re

            if not re.match(r"^[a-zA-Z0-9_.,+*/:@-]+$", select):
                raise ValueError(f"Invalid dbt select pattern: {select!r}")
            cmd.extend(["--select", select])

        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            if result.returncode == 0:
                logger.info("All dbt tests passed.")
                self.results.append(
                    QualityCheckResult(
                        check_name="dbt_tests",
                        table="all",
                        status="pass",
                        message="All dbt tests passed",
                    )
                )
            else:
                logger.warning("dbt.tests.failed", stdout=result.stdout[:2000])
                # Parse individual test failures from dbt output
                failures = self._parse_dbt_failures(result.stdout)
                for failure in failures:
                    self.results.append(
                        QualityCheckResult(
                            check_name=f"dbt_test:{failure['test']}",
                            table=failure.get("model", "unknown"),
                            status="fail",
                            message=failure.get("message", "Test failed"),
                            details=failure,
                        )
                    )
        except subprocess.TimeoutExpired:
            self.results.append(
                QualityCheckResult(
                    check_name="dbt_tests",
                    table="all",
                    status="fail",
                    message="dbt test execution timed out after 600s",
                )
            )
        except FileNotFoundError:
            logger.warning("dbt CLI not found. Skipping dbt tests.")

        return self.results

    def check_freshness(self) -> list[QualityCheckResult]:
        """Check data freshness using dbt source freshness."""
        logger.info("freshness.checking")
        try:
            result = subprocess.run(
                ["dbt", "source", "freshness", "--profiles-dir", ".", "--project-dir", "."],
                capture_output=True,
                text=True,
                timeout=300,
            )
            if result.returncode == 0:
                self.results.append(
                    QualityCheckResult(
                        check_name="freshness",
                        table="all_sources",
                        status="pass",
                        message="All sources are fresh",
                    )
                )
            else:
                self.results.append(
                    QualityCheckResult(
                        check_name="freshness",
                        table="sources",
                        status="warn",
                        message="Some sources are stale",
                        details={"output": result.stdout[:2000]},
                    )
                )
        except (subprocess.TimeoutExpired, FileNotFoundError) as e:
            logger.warning("freshness.skipped", error=str(e))

        return self.results

    def check_volume_rules(self) -> list[QualityCheckResult]:
        """Validate row counts against configured thresholds.

        Uses dbt to query actual row counts and compares against configured
        min/max thresholds. Falls back to config-only mode if dbt unavailable.
        """
        volume_rules = self.config.get("rules", {}).get("volume", [])
        for rule in volume_rules:
            table = rule["table"]
            min_rows = rule.get("min_rows", 0)
            max_growth_pct = rule.get("max_growth_pct", 200)
            logger.info("volume.checking", table=table, min_rows=min_rows)

            # Try to get actual row count via dbt
            try:
                import re

                if not re.match(r"^[a-zA-Z0-9_.]+$", table):
                    raise ValueError(f"Invalid table name: {table!r}")
                result = subprocess.run(
                    [
                        "dbt",
                        "run-operation",
                        "get_row_count",
                        "--args",
                        json.dumps({"table_name": table}),
                        "--profiles-dir",
                        ".",
                        "--project-dir",
                        ".",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                # Parse row count from output if available
                row_count = None
                for line in result.stdout.split("\n"):
                    line = line.strip()
                    if line.isdigit():
                        row_count = int(line)
                        break

                if row_count is not None:
                    if row_count < min_rows:
                        status = "fail"
                        message = f"Row count {row_count} below minimum {min_rows}"
                    else:
                        status = "pass"
                        message = f"Row count {row_count} meets minimum {min_rows}"
                    self.results.append(
                        QualityCheckResult(
                            check_name=f"volume:{table}",
                            table=table,
                            status=status,
                            message=message,
                            details={"actual_rows": row_count, "min_rows": min_rows, "max_growth_pct": max_growth_pct},
                        )
                    )
                    continue
            except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
                pass  # Fall through to config-only mode

            # Config-only mode: report as warning (cannot verify)
            self.results.append(
                QualityCheckResult(
                    check_name=f"volume:{table}",
                    table=table,
                    status="warn",
                    message=f"Volume check not verified (dbt unavailable). min_rows={min_rows}",
                    details={"min_rows": min_rows, "max_growth_pct": max_growth_pct, "verified": False},
                )
            )
        return self.results

    def run_ge_checkpoints(
        self,
        sample_data: dict[str, list[dict[str, Any]]] | None = None,
    ) -> list[QualityCheckResult]:
        """Execute Great Expectations suites configured in quality-rules.yaml.

        Bridges the declarative ``great_expectations`` section of the
        config to the runner in :mod:`governance.dataquality.ge_runner`.
        Each :class:`SuiteResult` is converted to a
        :class:`QualityCheckResult` and appended to ``self.results`` so
        the normal report pipeline picks it up.

        Args:
            sample_data: Optional per-suite sample rows for the
                in-memory fallback evaluator.  See
                :func:`ge_runner.run_ge_checkpoints` for details.
        """
        logger.info("ge.checkpoints_starting")
        suite_results: list[SuiteResult] = run_ge_checkpoints(
            self.config,
            sample_data=sample_data,
        )

        for suite in suite_results:
            self.results.append(
                QualityCheckResult(
                    check_name=f"ge:{suite.suite_name}",
                    table=suite.table,
                    status=suite.status,
                    message=suite.message,
                    details={
                        "datasource": suite.datasource,
                        "failed_expectations": suite.failed,
                        "total_expectations": suite.total,
                        "expectations": [
                            {
                                "type": e.expectation_type,
                                "column": e.column,
                                "success": e.success,
                                "message": e.message,
                            }
                            for e in suite.expectations
                        ],
                    },
                )
            )

        return self.results

    def generate_report(self) -> dict[str, Any]:
        """Generate a quality report summary."""
        total = len(self.results)
        passed = sum(1 for r in self.results if r.status == "pass")
        warned = sum(1 for r in self.results if r.status == "warn")
        failed = sum(1 for r in self.results if r.status == "fail")

        return {
            "report_timestamp": datetime.now(timezone.utc).isoformat(),
            "summary": {
                "total_checks": total,
                "passed": passed,
                "warnings": warned,
                "failures": failed,
                "health_score": round((passed / total * 100) if total > 0 else 0, 1),
            },
            "results": [r.to_dict() for r in self.results],
        }

    def emit_to_log_analytics(self, report: dict[str, Any]) -> None:
        """Send quality metrics to Azure Log Analytics via Azure Monitor Ingestion.

        Uses the ``azure-monitor-ingestion`` SDK with ``DefaultAzureCredential``
        to push quality check results to a Data Collection Rule (DCR) endpoint.
        Falls back to structured logging if the Monitor Ingestion client is not
        configured (missing env vars) or the SDK is unavailable.

        Required environment variables for full ingestion:
            MONITOR_DCR_ENDPOINT: Data Collection Endpoint URL
            MONITOR_DCR_RULE_ID: Data Collection Rule immutable ID
            MONITOR_DCR_STREAM:  Custom log stream name (default: Custom-DataQuality_CL)
        """
        import os

        dcr_endpoint = os.environ.get("MONITOR_DCR_ENDPOINT", "")
        dcr_rule_id = os.environ.get("MONITOR_DCR_RULE_ID", "")
        dcr_stream = os.environ.get("MONITOR_DCR_STREAM", "Custom-DataQuality_CL")

        # Always emit to structured logs (Log Analytics picks these up via
        # diagnostic settings regardless of the Ingestion client).
        logger.info(
            "quality.report_summary",
            health_score=report["summary"]["health_score"],
            passed=report["summary"]["passed"],
            total_checks=report["summary"]["total_checks"],
            failures=report["summary"]["failures"],
            warnings=report["summary"]["warnings"],
        )

        if not dcr_endpoint or not dcr_rule_id:
            logger.debug(
                "monitor.ingestion_skipped",
                reason="MONITOR_DCR_ENDPOINT or MONITOR_DCR_RULE_ID not set",
            )
            return

        try:
            from azure.identity import DefaultAzureCredential
            from azure.monitor.ingestion import LogsIngestionClient
        except ImportError:
            logger.warning(
                "monitor.sdk_not_installed",
                package="azure-monitor-ingestion",
            )
            return

        # Build log entries — one per quality check result.
        entries: list[MutableMapping[str, Any]] = [
            {
                "TimeGenerated": r["timestamp"],
                "CheckName": r["check_name"],
                "Table": r["table"],
                "Status": r["status"],
                "Message": r["message"],
                "HealthScore": report["summary"]["health_score"],
                "TotalChecks": report["summary"]["total_checks"],
                "Passed": report["summary"]["passed"],
                "Failures": report["summary"]["failures"],
                "Warnings": report["summary"]["warnings"],
            }
            for r in report.get("results", [])
        ]

        if not entries:
            # At minimum, emit the summary even if no individual results
            entries = [
                {
                    "TimeGenerated": report["report_timestamp"],
                    "CheckName": "quality_summary",
                    "Table": "all",
                    "Status": "pass" if report["summary"]["failures"] == 0 else "fail",
                    "Message": f"Health score: {report['summary']['health_score']}%",
                    "HealthScore": report["summary"]["health_score"],
                    "TotalChecks": report["summary"]["total_checks"],
                    "Passed": report["summary"]["passed"],
                    "Failures": report["summary"]["failures"],
                    "Warnings": report["summary"]["warnings"],
                }
            ]

        try:
            credential = DefaultAzureCredential()
            client = LogsIngestionClient(
                endpoint=dcr_endpoint,
                credential=credential,
            )
            client.upload(
                rule_id=dcr_rule_id,
                stream_name=dcr_stream,
                logs=entries,
            )
            logger.info(
                "monitor.ingestion_complete",
                entries=len(entries),
                dcr_endpoint=dcr_endpoint,
            )
        except Exception:
            logger.exception("monitor.ingestion_failed")
            # Non-fatal — quality checks still ran and results are in logs

    @staticmethod
    def _parse_dbt_failures(output: str) -> list[dict[str, str]]:
        """Parse dbt test output to extract individual failures.

        Attempts to read run_results.json for structured data,
        falls back to line-by-line parsing of stdout.
        """
        # Try structured JSON results first
        results_path = Path("target/run_results.json")
        if results_path.exists():
            try:
                with open(results_path) as f:
                    run_results = json.load(f)
                return [
                    {
                        "test": r.get("unique_id", "unknown"),
                        "model": r.get("unique_id", "").split(".")[-1],
                        "message": r.get("message", "Test failed"),
                        "status": r.get("status", "fail"),
                    }
                    for r in run_results.get("results", [])
                    if r.get("status") in ("fail", "error")
                ]
            except (json.JSONDecodeError, KeyError):
                logger.warning("Could not parse run_results.json, falling back to stdout parsing")

        # Fallback: parse stdout
        failures = []
        for line in output.split("\n"):
            if "FAIL" in line and "test" in line.lower():
                failures.append(
                    {
                        "test": line.strip(),
                        "message": line.strip(),
                    }
                )
        return failures


def main() -> None:
    parser = argparse.ArgumentParser(description="CSA-in-a-Box Data Quality Runner")
    parser.add_argument(
        "--config",
        default=str(Path(__file__).parent / "quality-rules.yaml"),
        help="Path to quality rules config",
    )
    parser.add_argument(
        "--suite",
        choices=["bronze", "silver", "gold", "all"],
        default="all",
        help="Which test suite to run",
    )
    parser.add_argument("--freshness-only", action="store_true", help="Run only freshness checks")
    parser.add_argument(
        "--ge-only",
        action="store_true",
        help="Run only the Great Expectations checkpoint suites",
    )
    parser.add_argument("--report", action="store_true", help="Generate and print report")
    parser.add_argument("--output", help="Output report to JSON file")

    args = parser.parse_args()

    # Bind a run-scoped correlation_id so every log line from this invocation
    # shares the same ID (Log Analytics join key).  The trace_id is left
    # unbound here and generated by the first caller of bind_trace_context.
    from structlog.contextvars import bind_contextvars

    bind_contextvars(
        correlation_id=new_correlation_id(),
        suite=args.suite,
        freshness_only=args.freshness_only,
    )

    runner = DataQualityRunner(args.config)

    if args.freshness_only:
        runner.check_freshness()
    elif args.ge_only:
        runner.run_ge_checkpoints()
    else:
        select_filter = f"tag:{args.suite}" if args.suite != "all" else ""
        runner.run_dbt_tests(select=select_filter)
        runner.check_freshness()
        runner.check_volume_rules()
        runner.run_ge_checkpoints()

    report = runner.generate_report()

    if args.report or args.output:
        report_json = json.dumps(report, indent=2)
        if args.output:
            with open(args.output, "w") as f:
                f.write(report_json)
            logger.info("report.written", output=args.output)
        else:
            print(report_json)

    runner.emit_to_log_analytics(report)

    # Exit with non-zero if any failures
    if report["summary"]["failures"] > 0:
        logger.error("quality.checks_failed", failures=report["summary"]["failures"])
        sys.exit(1)

    logger.info("quality.all_passed", health_score=report["summary"]["health_score"])


if __name__ == "__main__":
    main()
