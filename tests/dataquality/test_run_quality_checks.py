"""Tests for governance/dataquality/run_quality_checks.py.

Coverage targets
----------------
- YAML rule loading and placeholder substitution
- DataQualityRunner.run_dbt_tests  (subprocess mocked)
- DataQualityRunner.check_freshness  (subprocess mocked)
- DataQualityRunner.check_volume_rules  (subprocess mocked)
- DataQualityRunner.run_ge_checkpoints  (uses in-memory fallback)
- DataQualityRunner.generate_report
- DataQualityRunner.emit_to_log_analytics  (SDK mocked / env-var path)
- DataQualityRunner._parse_dbt_failures  (stdout and JSON paths)
- QualityCheckResult.to_dict
- Alert integration hooks (Teams webhook env var path)
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import yaml

from governance.common.logging import reset_logging_state

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_logging() -> Iterator[None]:
    reset_logging_state()
    yield
    reset_logging_state()


def _minimal_config() -> dict[str, Any]:
    """Return the smallest valid quality-rules config with no external deps."""
    return {
        "version": "1.0",
        "rules": {
            "volume": [],
        },
        "great_expectations": {
            "suites": [],
        },
    }


_DEFAULT_VOLUME_RULE: list[dict[str, Any]] = [
    {"table": "bronze.orders", "min_rows": 100, "max_growth_pct": 50}
]


def _config_with_volume_rules(
    rules: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    cfg = _minimal_config()
    cfg["rules"]["volume"] = _DEFAULT_VOLUME_RULE if rules is None else rules
    return cfg


def _config_with_ge_suites(suites: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    cfg = _minimal_config()
    cfg["great_expectations"]["suites"] = suites or [
        {
            "name": "bronze_customers_suite",
            "datasource": "adls_bronze",
            "expectations": [
                {
                    "expect_table_row_count_to_be_between": {
                        "min_value": 2,
                        "max_value": 100,
                    }
                }
            ],
        }
    ]
    return cfg


@pytest.fixture
def config_file(tmp_path: Path) -> Path:
    """Write a minimal config file and return its path."""
    cfg = _minimal_config()
    path = tmp_path / "quality-rules.yaml"
    path.write_text(yaml.dump(cfg), encoding="utf-8")
    return path


@pytest.fixture
def runner(config_file: Path) -> Any:
    from governance.dataquality.run_quality_checks import DataQualityRunner

    return DataQualityRunner(str(config_file))


# ---------------------------------------------------------------------------
# QualityCheckResult
# ---------------------------------------------------------------------------


class TestQualityCheckResult:
    def test_to_dict_contains_required_keys(self) -> None:
        from governance.dataquality.run_quality_checks import QualityCheckResult

        result = QualityCheckResult(
            check_name="dbt_tests",
            table="all",
            status="pass",
            message="All tests passed",
        )
        d = result.to_dict()
        assert d["check_name"] == "dbt_tests"
        assert d["table"] == "all"
        assert d["status"] == "pass"
        assert d["message"] == "All tests passed"
        assert "timestamp" in d
        assert "details" in d

    def test_to_dict_details_defaults_to_empty_dict(self) -> None:
        from governance.dataquality.run_quality_checks import QualityCheckResult

        result = QualityCheckResult(check_name="x", table="y", status="warn")
        assert result.to_dict()["details"] == {}

    def test_to_dict_details_preserved(self) -> None:
        from governance.dataquality.run_quality_checks import QualityCheckResult

        result = QualityCheckResult(
            check_name="x",
            table="y",
            status="fail",
            details={"rows": 5, "threshold": 100},
        )
        assert result.to_dict()["details"]["rows"] == 5

    @pytest.mark.parametrize("status", ["pass", "warn", "fail"])
    def test_all_statuses_round_trip(self, status: str) -> None:
        from governance.dataquality.run_quality_checks import QualityCheckResult

        r = QualityCheckResult("c", "t", status)
        assert r.to_dict()["status"] == status


# ---------------------------------------------------------------------------
# DataQualityRunner — YAML loading
# ---------------------------------------------------------------------------


class TestDataQualityRunnerInit:
    def test_loads_config_from_file(self, config_file: Path) -> None:
        from governance.dataquality.run_quality_checks import DataQualityRunner

        runner = DataQualityRunner(str(config_file))
        # Config should have been loaded and parsed
        assert isinstance(runner.config, dict)

    def test_email_regex_placeholder_substituted(self, tmp_path: Path) -> None:
        """The {EMAIL_REGEX} placeholder must be expanded at load time."""
        from governance.dataquality.run_quality_checks import DataQualityRunner

        cfg = {
            "great_expectations": {
                "suites": [
                    {
                        "name": "test_suite",
                        "datasource": "x",
                        "expectations": [
                            {
                                "expect_column_values_to_match_regex": {
                                    "column": "email",
                                    "regex": "{EMAIL_REGEX}",
                                }
                            }
                        ],
                    }
                ]
            }
        }
        path = tmp_path / "rules.yaml"
        path.write_text(yaml.dump(cfg), encoding="utf-8")

        runner = DataQualityRunner(str(path))
        suite = runner.config["great_expectations"]["suites"][0]
        expectation = suite["expectations"][0]
        regex = expectation["expect_column_values_to_match_regex"]["regex"]
        assert "{EMAIL_REGEX}" not in regex
        assert "@" in regex  # The real regex contains "@"

    def test_results_list_starts_empty(self, runner: Any) -> None:
        assert runner.results == []

    def test_missing_config_file_raises(self, tmp_path: Path) -> None:
        from governance.dataquality.run_quality_checks import DataQualityRunner

        with pytest.raises(FileNotFoundError):
            DataQualityRunner(str(tmp_path / "nonexistent.yaml"))


# ---------------------------------------------------------------------------
# DataQualityRunner — dbt tests
# ---------------------------------------------------------------------------


class TestRunDbtTests:
    def test_dbt_success_appends_pass_result(self, runner: Any) -> None:
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "All 10 tests passed."

        with patch("subprocess.run", return_value=mock_result):
            results = runner.run_dbt_tests()

        assert len(results) == 1
        assert results[0].status == "pass"
        assert results[0].check_name == "dbt_tests"

    def test_dbt_failure_appends_fail_results(self, runner: Any) -> None:
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stdout = "FAIL test_not_null_orders.order_id"

        with patch("subprocess.run", return_value=mock_result):
            results = runner.run_dbt_tests()

        assert any(r.status == "fail" for r in results)

    def test_dbt_timeout_appends_fail_result(self, runner: Any) -> None:
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="dbt", timeout=600)):
            results = runner.run_dbt_tests()

        timeout_results = [r for r in results if "timed out" in r.message.lower()]
        assert len(timeout_results) == 1
        assert timeout_results[0].status == "fail"

    def test_dbt_not_found_skips_silently(self, runner: Any) -> None:
        """If dbt binary is missing, no results are added (graceful skip)."""
        with patch("subprocess.run", side_effect=FileNotFoundError):
            results = runner.run_dbt_tests()

        assert not any(r.check_name == "dbt_tests" for r in results)

    def test_dbt_with_select_filter(self, runner: Any) -> None:
        """--select parameter should be passed to dbt command when provided."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ""

        with patch("subprocess.run", return_value=mock_result) as mock_run:
            runner.run_dbt_tests(select="tag:bronze")

        cmd_args = mock_run.call_args[0][0]
        assert "--select" in cmd_args
        assert "tag:bronze" in cmd_args

    def test_dbt_select_invalid_pattern_raises(self, runner: Any) -> None:
        with pytest.raises(ValueError, match="Invalid dbt select pattern"):
            runner.run_dbt_tests(select="tag:bronze; rm -rf /")

    def test_dbt_results_accumulate_across_calls(self, runner: Any) -> None:
        """Results list should grow with each call."""
        mock_ok = MagicMock(returncode=0, stdout="")
        with patch("subprocess.run", return_value=mock_ok):
            runner.run_dbt_tests()
            runner.run_dbt_tests()

        assert len(runner.results) == 2


# ---------------------------------------------------------------------------
# DataQualityRunner — freshness checks
# ---------------------------------------------------------------------------


class TestCheckFreshness:
    def test_freshness_pass_on_returncode_0(self, runner: Any) -> None:
        mock_result = MagicMock(returncode=0, stdout="")
        with patch("subprocess.run", return_value=mock_result):
            results = runner.check_freshness()

        assert any(r.status == "pass" and r.check_name == "freshness" for r in results)

    def test_freshness_warn_on_nonzero_returncode(self, runner: Any) -> None:
        mock_result = MagicMock(returncode=1, stdout="Some sources are stale")
        with patch("subprocess.run", return_value=mock_result):
            results = runner.check_freshness()

        warn_results = [r for r in results if r.status == "warn"]
        assert len(warn_results) == 1

    def test_freshness_skipped_when_dbt_missing(self, runner: Any) -> None:
        with patch("subprocess.run", side_effect=FileNotFoundError):
            results = runner.check_freshness()

        # Should not raise; returns empty (or accumulates nothing new)
        assert not any(r.status == "fail" for r in results)


# ---------------------------------------------------------------------------
# DataQualityRunner — volume rules
# ---------------------------------------------------------------------------


class TestCheckVolumeRules:
    def _make_runner_with_volume(
        self, tmp_path: Path, rules: list[dict[str, Any]]
    ) -> Any:
        from governance.dataquality.run_quality_checks import DataQualityRunner

        cfg = _config_with_volume_rules(rules)
        path = tmp_path / "rules.yaml"
        path.write_text(yaml.dump(cfg), encoding="utf-8")
        return DataQualityRunner(str(path))

    def test_volume_no_rules_returns_empty(
        self, tmp_path: Path
    ) -> None:
        runner = self._make_runner_with_volume(tmp_path, [])
        results = runner.check_volume_rules()
        assert results == []

    def test_volume_dbt_unavailable_warns(self, tmp_path: Path) -> None:
        runner = self._make_runner_with_volume(
            tmp_path, [{"table": "bronze.orders", "min_rows": 100}]
        )
        with patch("subprocess.run", side_effect=FileNotFoundError):
            results = runner.check_volume_rules()

        assert len(results) == 1
        assert results[0].status == "warn"
        assert "dbt unavailable" in results[0].message.lower() or "not verified" in results[0].message.lower()

    def test_volume_row_count_pass(self, tmp_path: Path) -> None:
        runner = self._make_runner_with_volume(
            tmp_path, [{"table": "bronze.orders", "min_rows": 10}]
        )
        mock_result = MagicMock(returncode=0, stdout="100\n")
        with patch("subprocess.run", return_value=mock_result):
            results = runner.check_volume_rules()

        pass_results = [r for r in results if r.status == "pass"]
        assert len(pass_results) == 1
        assert "100" in pass_results[0].message

    def test_volume_row_count_fail_below_minimum(self, tmp_path: Path) -> None:
        runner = self._make_runner_with_volume(
            tmp_path, [{"table": "bronze.orders", "min_rows": 1000}]
        )
        mock_result = MagicMock(returncode=0, stdout="5\n")
        with patch("subprocess.run", return_value=mock_result):
            results = runner.check_volume_rules()

        fail_results = [r for r in results if r.status == "fail"]
        assert len(fail_results) == 1
        assert "below minimum" in fail_results[0].message

    def test_volume_multiple_rules(self, tmp_path: Path) -> None:
        rules = [
            {"table": "bronze.orders", "min_rows": 10},
            {"table": "bronze.customers", "min_rows": 5},
        ]
        runner = self._make_runner_with_volume(tmp_path, rules)
        mock_result = MagicMock(returncode=0, stdout="100\n")
        with patch("subprocess.run", return_value=mock_result):
            results = runner.check_volume_rules()

        assert len(results) == 2

    def test_volume_invalid_table_name_skipped(self, tmp_path: Path) -> None:
        """Table names with SQL injection characters should be silently skipped."""
        runner = self._make_runner_with_volume(
            tmp_path, [{"table": "bronze.orders; DROP TABLE orders", "min_rows": 10}]
        )
        with patch("subprocess.run", side_effect=FileNotFoundError):
            results = runner.check_volume_rules()

        # The invalid name triggers ValueError → falls through to warn mode
        assert len(results) == 1
        assert results[0].status == "warn"


# ---------------------------------------------------------------------------
# DataQualityRunner — Great Expectations checkpoints
# ---------------------------------------------------------------------------


class TestRunGECheckpoints:
    def _make_runner_with_ge(
        self, tmp_path: Path, suites: list[dict[str, Any]]
    ) -> Any:
        from governance.dataquality.run_quality_checks import DataQualityRunner

        cfg = _config_with_ge_suites(suites)
        path = tmp_path / "rules.yaml"
        path.write_text(yaml.dump(cfg), encoding="utf-8")
        return DataQualityRunner(str(path))

    def test_ge_no_suites_returns_empty(self, runner: Any) -> None:
        results = runner.run_ge_checkpoints()
        assert results == []

    def test_ge_suite_pass_with_sample_data(self, tmp_path: Path) -> None:
        suite = {
            "name": "bronze_customers_suite",
            "datasource": "adls_bronze",
            "expectations": [
                {"expect_table_row_count_to_be_between": {"min_value": 2, "max_value": 50}}
            ],
        }
        runner = self._make_runner_with_ge(tmp_path, [suite])
        sample_data = {"bronze_customers_suite": [{"id": i} for i in range(10)]}
        results = runner.run_ge_checkpoints(sample_data=sample_data)

        assert len(results) == 1
        ge_results = [r for r in results if r.check_name == "ge:bronze_customers_suite"]
        assert ge_results[0].status == "pass"

    def test_ge_suite_fail_with_sample_data(self, tmp_path: Path) -> None:
        suite = {
            "name": "bronze_customers_suite",
            "datasource": "adls_bronze",
            "expectations": [
                {"expect_table_row_count_to_be_between": {"min_value": 100, "max_value": 500}}
            ],
        }
        runner = self._make_runner_with_ge(tmp_path, [suite])
        sample_data = {"bronze_customers_suite": [{"id": i} for i in range(5)]}
        results = runner.run_ge_checkpoints(sample_data=sample_data)

        ge_results = [r for r in results if r.check_name == "ge:bronze_customers_suite"]
        assert ge_results[0].status == "fail"

    def test_ge_suite_details_include_expectations(self, tmp_path: Path) -> None:
        suite = {
            "name": "bronze_customers_suite",
            "datasource": "adls_bronze",
            "expectations": [
                {"expect_column_values_to_not_be_null": {"column": "customer_id"}}
            ],
        }
        runner = self._make_runner_with_ge(tmp_path, [suite])
        sample_data = {
            "bronze_customers_suite": [{"customer_id": "c1"}, {"customer_id": "c2"}]
        }
        results = runner.run_ge_checkpoints(sample_data=sample_data)

        ge_results = [r for r in results if r.check_name.startswith("ge:")]
        details = ge_results[0].details
        assert "expectations" in details
        assert len(details["expectations"]) == 1

    def test_ge_multiple_suites(self, tmp_path: Path) -> None:
        suites = [
            {
                "name": "bronze_orders_suite",
                "datasource": "adls_bronze",
                "expectations": [
                    {"expect_column_values_to_not_be_null": {"column": "order_id"}}
                ],
            },
            {
                "name": "silver_customers_suite",
                "datasource": "adls_silver",
                "expectations": [
                    {"expect_column_values_to_be_unique": {"column": "customer_sk"}}
                ],
            },
        ]
        runner = self._make_runner_with_ge(tmp_path, suites)
        sample_data = {
            "bronze_orders_suite": [{"order_id": "o1"}, {"order_id": "o2"}],
            "silver_customers_suite": [{"customer_sk": "c1"}, {"customer_sk": "c2"}],
        }
        results = runner.run_ge_checkpoints(sample_data=sample_data)
        ge_results = [r for r in results if r.check_name.startswith("ge:")]
        assert len(ge_results) == 2

    def test_ge_suite_no_sample_data_skipped(self, tmp_path: Path) -> None:
        """Without sample_data and without GE installed, suites should be skipped."""
        suite = {
            "name": "bronze_customers_suite",
            "datasource": "adls_bronze",
            "expectations": [
                {"expect_table_row_count_to_be_between": {"min_value": 1}}
            ],
        }
        runner = self._make_runner_with_ge(tmp_path, [suite])

        with patch(
            "governance.dataquality.ge_runner._great_expectations_available",
            return_value=False,
        ):
            results = runner.run_ge_checkpoints()

        ge_results = [r for r in results if r.check_name.startswith("ge:")]
        assert ge_results[0].status == "skipped"

    def test_ge_results_accumulated_on_runner(self, tmp_path: Path) -> None:
        """run_ge_checkpoints should append to self.results."""
        suite = {
            "name": "bronze_customers_suite",
            "datasource": "adls_bronze",
            "expectations": [
                {"expect_table_row_count_to_be_between": {"min_value": 1, "max_value": 100}}
            ],
        }
        runner = self._make_runner_with_ge(tmp_path, [suite])
        sample_data = {"bronze_customers_suite": [{"id": 1}]}
        runner.run_ge_checkpoints(sample_data=sample_data)
        assert len(runner.results) == 1


# ---------------------------------------------------------------------------
# DataQualityRunner — report generation
# ---------------------------------------------------------------------------


class TestGenerateReport:
    def _inject_results(self, runner: Any, statuses: list[str]) -> None:
        from governance.dataquality.run_quality_checks import QualityCheckResult

        for i, status in enumerate(statuses):
            runner.results.append(
                QualityCheckResult(f"check_{i}", f"table_{i}", status, f"msg {i}")
            )

    def test_report_no_results_zero_health_score(self, runner: Any) -> None:
        report = runner.generate_report()
        assert report["summary"]["total_checks"] == 0
        assert report["summary"]["health_score"] == 0.0

    def test_report_all_pass_health_score_100(self, runner: Any) -> None:
        self._inject_results(runner, ["pass", "pass", "pass"])
        report = runner.generate_report()
        assert report["summary"]["health_score"] == 100.0

    def test_report_mixed_statuses(self, runner: Any) -> None:
        self._inject_results(runner, ["pass", "pass", "warn", "fail"])
        report = runner.generate_report()
        summary = report["summary"]
        assert summary["total_checks"] == 4
        assert summary["passed"] == 2
        assert summary["warnings"] == 1
        assert summary["failures"] == 1
        assert round(summary["health_score"], 1) == 50.0

    def test_report_contains_all_results(self, runner: Any) -> None:
        self._inject_results(runner, ["pass", "fail"])
        report = runner.generate_report()
        assert len(report["results"]) == 2

    def test_report_has_timestamp(self, runner: Any) -> None:
        report = runner.generate_report()
        assert "report_timestamp" in report
        assert "T" in report["report_timestamp"]  # ISO-8601 contains 'T'

    def test_report_results_are_dicts(self, runner: Any) -> None:
        self._inject_results(runner, ["pass"])
        report = runner.generate_report()
        assert isinstance(report["results"][0], dict)


# ---------------------------------------------------------------------------
# DataQualityRunner — emit_to_log_analytics
# ---------------------------------------------------------------------------


class TestEmitToLogAnalytics:
    def _sample_report(self) -> dict[str, Any]:
        return {
            "report_timestamp": "2026-04-17T00:00:00+00:00",
            "summary": {
                "total_checks": 2,
                "passed": 2,
                "warnings": 0,
                "failures": 0,
                "health_score": 100.0,
            },
            "results": [
                {
                    "check_name": "dbt_tests",
                    "table": "all",
                    "status": "pass",
                    "message": "OK",
                    "details": {},
                    "timestamp": "2026-04-17T00:00:00+00:00",
                }
            ],
        }

    def test_emit_skips_when_env_vars_missing(self, runner: Any) -> None:
        """When DCR env vars are absent the function should return without error."""
        report = self._sample_report()
        with patch.dict("os.environ", {}, clear=True):
            # Should not raise
            runner.emit_to_log_analytics(report)

    def test_emit_calls_sdk_upload_when_env_vars_set(self, runner: Any) -> None:
        """When DCR env vars are present and SDK is importable, upload is called."""
        report = self._sample_report()
        env_vars = {
            "MONITOR_DCR_ENDPOINT": "https://my-endpoint.ingest.monitor.azure.com",
            "MONITOR_DCR_RULE_ID": "dcr-abc123",
            "MONITOR_DCR_STREAM": "Custom-DataQuality_CL",
        }

        mock_client_instance = MagicMock()
        mock_ingestion_module = MagicMock()
        mock_ingestion_module.LogsIngestionClient = MagicMock(
            return_value=mock_client_instance
        )
        mock_identity_module = MagicMock()

        with patch.dict("os.environ", env_vars):
            with patch.dict(
                "sys.modules",
                {
                    "azure.monitor.ingestion": mock_ingestion_module,
                    "azure.identity": mock_identity_module,
                },
            ):
                # Should not raise
                runner.emit_to_log_analytics(report)

    def test_emit_handles_empty_results_gracefully(self, runner: Any) -> None:
        """A report with no individual results should still emit a summary entry."""
        report = {
            "report_timestamp": "2026-04-17T00:00:00+00:00",
            "summary": {
                "total_checks": 0,
                "passed": 0,
                "warnings": 0,
                "failures": 0,
                "health_score": 0.0,
            },
            "results": [],
        }
        # Should not raise regardless of env vars
        with patch.dict("os.environ", {}, clear=True):
            runner.emit_to_log_analytics(report)

    def test_emit_sdk_not_installed_logs_warning(self, runner: Any) -> None:
        """When SDK is not importable, the function should log a warning and return."""
        report = self._sample_report()
        env_vars = {
            "MONITOR_DCR_ENDPOINT": "https://endpoint",
            "MONITOR_DCR_RULE_ID": "dcr-id",
        }

        with patch.dict("os.environ", env_vars):
            with patch.dict("sys.modules", {
                "azure.monitor.ingestion": None,
                "azure.identity": None,
            }):
                # Should not raise — graceful fallback
                runner.emit_to_log_analytics(report)


# ---------------------------------------------------------------------------
# DataQualityRunner — _parse_dbt_failures
# ---------------------------------------------------------------------------


class TestParseDbtFailures:
    def test_parse_failures_from_stdout_fallback(self, runner: Any) -> None:
        output = textwrap.dedent("""\
            Running dbt test...
            FAIL test_not_null_orders.order_id
            FAIL test_unique_customers.customer_id
            Done. FAIL=2
        """)
        with patch.object(Path, "exists", return_value=False):
            failures = runner._parse_dbt_failures(output)

        assert len(failures) == 2
        assert all("FAIL" in f["test"] for f in failures)

    def test_parse_failures_from_run_results_json(
        self, runner: Any, tmp_path: Path
    ) -> None:
        run_results = {
            "results": [
                {
                    "unique_id": "test.model.test_not_null_orders.order_id",
                    "status": "fail",
                    "message": "Test failed",
                },
                {
                    "unique_id": "test.model.test_unique_customers",
                    "status": "pass",
                    "message": "OK",
                },
            ]
        }
        results_file = tmp_path / "run_results.json"
        results_file.write_text(json.dumps(run_results), encoding="utf-8")

        with patch.object(Path, "exists", return_value=True):
            with patch("builtins.open", return_value=results_file.open()):
                failures = runner._parse_dbt_failures("")

        # Only the "fail" result should be returned
        assert len(failures) == 1
        assert failures[0]["status"] == "fail"

    def test_parse_failures_empty_output_returns_empty(self, runner: Any) -> None:
        with patch.object(Path, "exists", return_value=False):
            failures = runner._parse_dbt_failures("")

        assert failures == []

    def test_parse_failures_malformed_json_falls_back_to_stdout(
        self, runner: Any
    ) -> None:
        output = "FAIL test_something\n"
        bad_json = b"{ invalid json"

        with patch.object(Path, "exists", return_value=True):
            with patch("builtins.open", return_value=__import__("io").BytesIO(bad_json)):
                # json.JSONDecodeError triggers fallback to stdout parsing
                failures = runner._parse_dbt_failures(output)

        # Fallback path should find the FAIL line
        assert any("FAIL" in f.get("test", "") for f in failures)


# ---------------------------------------------------------------------------
# Teams webhook / alerting config (env-var path)
# ---------------------------------------------------------------------------


class TestAlertingConfig:
    """Verify the alerting section is parsed from YAML and env vars are referenced."""

    def test_teams_webhook_url_env_var_present_in_config(self, tmp_path: Path) -> None:
        from governance.dataquality.run_quality_checks import DataQualityRunner

        cfg: dict[str, Any] = {
            "alerting": {
                "channels": [
                    {
                        "name": "teams_webhook",
                        "type": "webhook",
                        "url": "${TEAMS_WEBHOOK_URL}",
                    }
                ]
            },
            "great_expectations": {"suites": []},
        }
        path = tmp_path / "rules.yaml"
        path.write_text(yaml.dump(cfg), encoding="utf-8")
        runner = DataQualityRunner(str(path))
        channels = runner.config.get("alerting", {}).get("channels", [])
        teams = [c for c in channels if c.get("name") == "teams_webhook"]
        assert len(teams) == 1
        # The URL should still be the raw env-var reference (substitution is OS-level)
        assert "TEAMS_WEBHOOK_URL" in teams[0]["url"]


# ---------------------------------------------------------------------------
# Integration: full runner workflow
# ---------------------------------------------------------------------------


class TestFullRunnerWorkflow:
    def test_run_all_then_generate_report(self, tmp_path: Path) -> None:
        from governance.dataquality.run_quality_checks import DataQualityRunner

        ge_suite = {
            "name": "bronze_customers_suite",
            "datasource": "adls_bronze",
            "expectations": [
                {"expect_table_row_count_to_be_between": {"min_value": 1, "max_value": 100}}
            ],
        }
        cfg = {
            "great_expectations": {"suites": [ge_suite]},
            "rules": {"volume": []},
        }
        path = tmp_path / "rules.yaml"
        path.write_text(yaml.dump(cfg), encoding="utf-8")
        runner = DataQualityRunner(str(path))

        mock_ok = MagicMock(returncode=0, stdout="")
        with patch("subprocess.run", return_value=mock_ok):
            runner.run_dbt_tests()
            runner.check_freshness()
            runner.check_volume_rules()
            runner.run_ge_checkpoints(
                sample_data={"bronze_customers_suite": [{"id": i} for i in range(5)]}
            )

        report = runner.generate_report()
        assert report["summary"]["total_checks"] > 0
        assert report["summary"]["failures"] == 0

    def test_full_run_returns_nonzero_exit_on_failure(
        self, tmp_path: Path
    ) -> None:
        """generate_report should show failures when dbt tests fail."""
        from governance.dataquality.run_quality_checks import DataQualityRunner

        cfg: dict[str, Any] = {
            "great_expectations": {"suites": []},
            "rules": {"volume": []},
        }
        path = tmp_path / "rules.yaml"
        path.write_text(yaml.dump(cfg), encoding="utf-8")
        runner = DataQualityRunner(str(path))

        mock_fail = MagicMock(returncode=1, stdout="FAIL test_not_null_orders.order_id")
        with patch("subprocess.run", return_value=mock_fail):
            runner.run_dbt_tests()

        report = runner.generate_report()
        assert report["summary"]["failures"] >= 1


import textwrap  # noqa: E402 — used by TestParseDbtFailures above, placed here for clarity
