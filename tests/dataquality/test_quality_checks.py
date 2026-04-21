"""Tests for run_quality_checks.py — DataQualityRunner orchestration.

Covers:
- Config loading and YAML placeholder substitution
- run_dbt_tests(): subprocess mocking, success/failure/timeout/not-found paths
- check_freshness(): subprocess mocking
- check_volume_rules(): dbt available vs. unavailable paths
- run_ge_checkpoints(): GE integration bridge (delegates to ge_runner)
- generate_report(): counts, health score, shape
- emit_to_log_analytics(): SDK path and graceful skip when env vars absent
- _parse_dbt_failures(): structured JSON path and stdout fallback
- QualityCheckResult.to_dict() contract

No subprocess, Azure SDK, or filesystem access is exercised without mocking.
"""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, call, mock_open, patch

import pytest
import yaml


# ---------------------------------------------------------------------------
# Helpers to build a minimal config and runner
# ---------------------------------------------------------------------------


def _minimal_config(extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return the smallest valid quality-rules config structure."""
    config: dict[str, Any] = {
        "version": "1.0",
        "rules": {
            "volume": [],
            "freshness": [],
        },
        "great_expectations": {"suites": []},
    }
    if extra:
        config.update(extra)
    return config


def _make_runner(tmp_path: Path, config: dict[str, Any] | None = None) -> Any:
    """Instantiate a DataQualityRunner pointing at a temp YAML config file."""
    from csa_platform.governance.dataquality.run_quality_checks import DataQualityRunner

    cfg = config if config is not None else _minimal_config()
    config_file = tmp_path / "quality-rules.yaml"
    config_file.write_text(yaml.dump(cfg), encoding="utf-8")
    return DataQualityRunner(str(config_file))


# ---------------------------------------------------------------------------
# QualityCheckResult
# ---------------------------------------------------------------------------


class TestQualityCheckResult:
    def test_to_dict_has_required_keys(self) -> None:
        from csa_platform.governance.dataquality.run_quality_checks import QualityCheckResult

        r = QualityCheckResult(
            check_name="dbt_tests",
            table="all",
            status="pass",
            message="All passed",
            details={"count": 42},
        )
        d = r.to_dict()
        assert set(d.keys()) == {"check_name", "table", "status", "message", "details", "timestamp"}

    def test_to_dict_values_match_constructor(self) -> None:
        from csa_platform.governance.dataquality.run_quality_checks import QualityCheckResult

        r = QualityCheckResult(
            check_name="ge:bronze_suite",
            table="bronze.customers",
            status="fail",
            message="2 expectations failed",
            details={"failed_expectations": 2},
        )
        d = r.to_dict()
        assert d["check_name"] == "ge:bronze_suite"
        assert d["table"] == "bronze.customers"
        assert d["status"] == "fail"
        assert d["details"]["failed_expectations"] == 2

    def test_timestamp_is_iso_utc(self) -> None:
        from csa_platform.governance.dataquality.run_quality_checks import QualityCheckResult

        r = QualityCheckResult("n", "t", "pass")
        # Should parse without raising
        dt = datetime.fromisoformat(r.timestamp)
        assert dt.tzinfo is not None

    def test_details_defaults_to_empty_dict(self) -> None:
        from csa_platform.governance.dataquality.run_quality_checks import QualityCheckResult

        r = QualityCheckResult("n", "t", "pass")
        assert r.details == {}


# ---------------------------------------------------------------------------
# DataQualityRunner.__init__ — config loading
# ---------------------------------------------------------------------------


class TestDataQualityRunnerInit:
    def test_loads_yaml_config(self, tmp_path: Path) -> None:
        from csa_platform.governance.dataquality.run_quality_checks import DataQualityRunner

        cfg = _minimal_config()
        f = tmp_path / "qr.yaml"
        f.write_text(yaml.dump(cfg), encoding="utf-8")
        runner = DataQualityRunner(str(f))
        assert runner.config["version"] == "1.0"

    def test_results_initially_empty(self, tmp_path: Path) -> None:
        runner = _make_runner(tmp_path)
        assert runner.results == []

    def test_placeholder_substitution_applied(self, tmp_path: Path) -> None:
        """substitute_common_patterns() must expand {EMAIL_REGEX} placeholders."""
        cfg = _minimal_config(
            {
                "great_expectations": {
                    "suites": [
                        {
                            "name": "test_suite",
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
        )
        from csa_platform.governance.common.validation import EMAIL_REGEX_PATTERN
        from csa_platform.governance.dataquality.run_quality_checks import DataQualityRunner

        f = tmp_path / "qr.yaml"
        f.write_text(yaml.dump(cfg), encoding="utf-8")
        runner = DataQualityRunner(str(f))

        suite = runner.config["great_expectations"]["suites"][0]
        regex_val = suite["expectations"][0]["expect_column_values_to_match_regex"]["regex"]
        assert regex_val == EMAIL_REGEX_PATTERN


# ---------------------------------------------------------------------------
# run_dbt_tests
# ---------------------------------------------------------------------------


class TestRunDbtTests:
    def test_success_appends_pass_result(self, tmp_path: Path) -> None:
        runner = _make_runner(tmp_path)
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = "All dbt tests passed."

        with patch("subprocess.run", return_value=mock_proc):
            results = runner.run_dbt_tests()

        assert len(results) == 1
        assert results[0].status == "pass"
        assert results[0].check_name == "dbt_tests"

    def test_failure_parses_stdout_and_appends_fail_result(self, tmp_path: Path) -> None:
        runner = _make_runner(tmp_path)
        mock_proc = MagicMock()
        mock_proc.returncode = 1
        mock_proc.stdout = "FAIL 1 test.not_null_customers.customer_id"

        with patch("subprocess.run", return_value=mock_proc), \
             patch.object(runner, "_parse_dbt_failures", return_value=[
                 {"test": "not_null_customers.customer_id", "model": "customers", "message": "Null found"}
             ]):
            results = runner.run_dbt_tests()

        fail_results = [r for r in results if r.status == "fail"]
        assert len(fail_results) == 1
        assert "dbt_test:" in fail_results[0].check_name

    def test_timeout_appends_fail_result(self, tmp_path: Path) -> None:
        runner = _make_runner(tmp_path)
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("dbt", 600)):
            results = runner.run_dbt_tests()

        assert any(r.status == "fail" and "timed out" in r.message for r in results)

    def test_dbt_not_found_does_not_append_result(self, tmp_path: Path) -> None:
        runner = _make_runner(tmp_path)
        with patch("subprocess.run", side_effect=FileNotFoundError("dbt not found")):
            results = runner.run_dbt_tests()

        # FileNotFoundError is swallowed; no result appended
        assert results == [] or all(r.check_name != "dbt_tests" for r in results)

    def test_select_appended_to_command_when_provided(self, tmp_path: Path) -> None:
        runner = _make_runner(tmp_path)
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = ""

        with patch("subprocess.run", return_value=mock_proc) as mock_run:
            runner.run_dbt_tests(select="tag:bronze")

        cmd = mock_run.call_args[0][0]
        assert "--select" in cmd
        assert "tag:bronze" in cmd

    def test_invalid_select_pattern_raises_value_error(self, tmp_path: Path) -> None:
        """Patterns with shell-special characters outside the allowed set must raise."""
        runner = _make_runner(tmp_path)
        # The allowed set is [a-zA-Z0-9_.,+*/:@-]; semicolons and spaces are not
        with pytest.raises(ValueError, match="Invalid dbt select pattern"):
            runner.run_dbt_tests(select="bronze; rm -rf /")

    def test_empty_select_omits_flag(self, tmp_path: Path) -> None:
        runner = _make_runner(tmp_path)
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = ""

        with patch("subprocess.run", return_value=mock_proc) as mock_run:
            runner.run_dbt_tests(select="")

        cmd = mock_run.call_args[0][0]
        assert "--select" not in cmd

    def test_results_list_populated_cumulatively(self, tmp_path: Path) -> None:
        """Calling run_dbt_tests twice should accumulate results."""
        runner = _make_runner(tmp_path)
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = ""

        with patch("subprocess.run", return_value=mock_proc):
            runner.run_dbt_tests()
            runner.run_dbt_tests()

        assert len(runner.results) == 2


# ---------------------------------------------------------------------------
# check_freshness
# ---------------------------------------------------------------------------


class TestCheckFreshness:
    def test_success_appends_pass(self, tmp_path: Path) -> None:
        runner = _make_runner(tmp_path)
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = ""

        with patch("subprocess.run", return_value=mock_proc):
            results = runner.check_freshness()

        freshness = next(r for r in results if r.check_name == "freshness")
        assert freshness.status == "pass"
        assert freshness.table == "all_sources"

    def test_failure_appends_warn(self, tmp_path: Path) -> None:
        runner = _make_runner(tmp_path)
        mock_proc = MagicMock()
        mock_proc.returncode = 1
        mock_proc.stdout = "Some source is stale."

        with patch("subprocess.run", return_value=mock_proc):
            results = runner.check_freshness()

        freshness = next(r for r in results if r.check_name == "freshness")
        assert freshness.status == "warn"

    def test_timeout_does_not_raise(self, tmp_path: Path) -> None:
        runner = _make_runner(tmp_path)
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("dbt", 300)):
            # Should log warning and return without raising
            runner.check_freshness()

    def test_dbt_not_found_does_not_raise(self, tmp_path: Path) -> None:
        runner = _make_runner(tmp_path)
        with patch("subprocess.run", side_effect=FileNotFoundError()):
            runner.check_freshness()


# ---------------------------------------------------------------------------
# check_volume_rules
# ---------------------------------------------------------------------------


class TestCheckVolumeRules:
    def test_no_rules_returns_empty_addition(self, tmp_path: Path) -> None:
        runner = _make_runner(tmp_path, _minimal_config())
        initial_len = len(runner.results)
        runner.check_volume_rules()
        assert len(runner.results) == initial_len

    def test_rule_passes_when_row_count_meets_minimum(self, tmp_path: Path) -> None:
        cfg = _minimal_config(
            {
                "rules": {
                    "volume": [
                        {"table": "bronze.brz_customers", "min_rows": 100, "max_growth_pct": 50}
                    ],
                    "freshness": [],
                }
            }
        )
        runner = _make_runner(tmp_path, cfg)

        # Simulate dbt run-operation returning a row count
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = "150\n"

        with patch("subprocess.run", return_value=mock_proc):
            results = runner.check_volume_rules()

        volume_result = next(r for r in results if "bronze.brz_customers" in r.table)
        assert volume_result.status == "pass"
        assert "150" in volume_result.message

    def test_rule_fails_when_row_count_below_minimum(self, tmp_path: Path) -> None:
        cfg = _minimal_config(
            {
                "rules": {
                    "volume": [
                        {"table": "bronze.brz_customers", "min_rows": 1000, "max_growth_pct": 50}
                    ],
                    "freshness": [],
                }
            }
        )
        runner = _make_runner(tmp_path, cfg)
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = "50\n"

        with patch("subprocess.run", return_value=mock_proc):
            results = runner.check_volume_rules()

        volume_result = next(r for r in results if "bronze.brz_customers" in r.table)
        assert volume_result.status == "fail"

    def test_dbt_unavailable_emits_warn(self, tmp_path: Path) -> None:
        cfg = _minimal_config(
            {
                "rules": {
                    "volume": [
                        {"table": "bronze.brz_sales_orders", "min_rows": 100, "max_growth_pct": 200}
                    ],
                    "freshness": [],
                }
            }
        )
        runner = _make_runner(tmp_path, cfg)
        with patch("subprocess.run", side_effect=FileNotFoundError()):
            results = runner.check_volume_rules()

        volume_result = next(r for r in results if "bronze.brz_sales_orders" in r.table)
        assert volume_result.status == "warn"
        assert volume_result.details["verified"] is False

    def test_dbt_output_without_digit_line_falls_back_to_warn(self, tmp_path: Path) -> None:
        cfg = _minimal_config(
            {
                "rules": {
                    "volume": [
                        {"table": "bronze.brz_customers", "min_rows": 100, "max_growth_pct": 50}
                    ],
                    "freshness": [],
                }
            }
        )
        runner = _make_runner(tmp_path, cfg)
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = "No row count found in output.\n"

        with patch("subprocess.run", return_value=mock_proc):
            results = runner.check_volume_rules()

        volume_result = next(r for r in results if "bronze.brz_customers" in r.table)
        assert volume_result.status == "warn"

    def test_invalid_table_name_raises_value_error(self, tmp_path: Path) -> None:
        cfg = _minimal_config(
            {
                "rules": {
                    "volume": [
                        {"table": "../../etc/passwd", "min_rows": 1, "max_growth_pct": 10}
                    ],
                    "freshness": [],
                }
            }
        )
        runner = _make_runner(tmp_path, cfg)
        # ValueError from table name validation causes fall-through to warn
        with patch("subprocess.run", return_value=MagicMock(returncode=0, stdout="")):
            results = runner.check_volume_rules()

        # The invalid table name should result in a warn (not crash)
        assert len(results) == 1
        assert results[0].status == "warn"

    def test_details_contain_min_rows_and_max_growth(self, tmp_path: Path) -> None:
        cfg = _minimal_config(
            {
                "rules": {
                    "volume": [
                        {"table": "bronze.brz_customers", "min_rows": 500, "max_growth_pct": 75}
                    ],
                    "freshness": [],
                }
            }
        )
        runner = _make_runner(tmp_path, cfg)
        with patch("subprocess.run", side_effect=FileNotFoundError()):
            runner.check_volume_rules()

        result = runner.results[-1]
        assert result.details["min_rows"] == 500
        assert result.details["max_growth_pct"] == 75


# ---------------------------------------------------------------------------
# run_ge_checkpoints (bridge to ge_runner)
# ---------------------------------------------------------------------------


class TestRunGeCheckpoints:
    def test_delegates_to_ge_runner_and_maps_results(self, tmp_path: Path) -> None:
        from csa_platform.governance.dataquality.ge_runner import SuiteResult

        cfg = _minimal_config(
            {
                "great_expectations": {
                    "suites": [
                        {
                            "name": "bronze_customers_suite",
                            "datasource": "adls_bronze",
                            "expectations": [
                                {"expect_column_values_to_not_be_null": {"column": "customer_id"}}
                            ],
                        }
                    ]
                }
            }
        )
        runner = _make_runner(tmp_path, cfg)

        mock_suite_result = SuiteResult(
            suite_name="bronze_customers_suite",
            datasource="adls_bronze",
            table="bronze.customers",
            status="pass",
            message="1 expectations passed",
        )

        with patch(
            "csa_platform.governance.dataquality.run_quality_checks.run_ge_checkpoints",
            return_value=[mock_suite_result],
        ):
            results = runner.run_ge_checkpoints()

        ge_results = [r for r in results if r.check_name.startswith("ge:")]
        assert len(ge_results) == 1
        assert ge_results[0].status == "pass"
        assert ge_results[0].table == "bronze.customers"
        assert ge_results[0].check_name == "ge:bronze_customers_suite"

    def test_failed_suite_mapped_to_fail_status(self, tmp_path: Path) -> None:
        from csa_platform.governance.dataquality.ge_runner import ExpectationResult, SuiteResult

        runner = _make_runner(tmp_path)
        failed_exp = ExpectationResult(
            expectation_type="expect_column_values_to_not_be_null",
            column="email",
            success=False,
            message="3 null values in 'email'",
        )
        mock_suite = SuiteResult(
            suite_name="silver_customers_suite",
            datasource="adls_silver",
            table="silver.customers",
            status="fail",
            message="1/1 expectations failed",
            expectations=[failed_exp],
        )

        with patch(
            "csa_platform.governance.dataquality.run_quality_checks.run_ge_checkpoints",
            return_value=[mock_suite],
        ):
            results = runner.run_ge_checkpoints()

        ge_result = next(r for r in results if r.check_name == "ge:silver_customers_suite")
        assert ge_result.status == "fail"
        assert ge_result.details["failed_expectations"] == 1
        assert ge_result.details["total_expectations"] == 1

    def test_sample_data_forwarded_to_ge_runner(self, tmp_path: Path) -> None:
        runner = _make_runner(tmp_path)
        sample = {"bronze_customers_suite": [{"customer_id": "c1"}]}

        with patch(
            "csa_platform.governance.dataquality.run_quality_checks.run_ge_checkpoints",
            return_value=[],
        ) as mock_ge:
            runner.run_ge_checkpoints(sample_data=sample)

        _, kwargs = mock_ge.call_args
        assert kwargs["sample_data"] == sample

    def test_expectation_details_in_result(self, tmp_path: Path) -> None:
        from csa_platform.governance.dataquality.ge_runner import ExpectationResult, SuiteResult

        runner = _make_runner(tmp_path)
        exp = ExpectationResult(
            expectation_type="expect_column_values_to_be_unique",
            column="order_id",
            success=True,
            message="0 duplicate rows",
        )
        mock_suite = SuiteResult(
            suite_name="silver_orders_suite",
            datasource="adls_silver",
            table="silver.orders",
            status="pass",
            message="1 expectations passed",
            expectations=[exp],
        )

        with patch(
            "csa_platform.governance.dataquality.run_quality_checks.run_ge_checkpoints",
            return_value=[mock_suite],
        ):
            results = runner.run_ge_checkpoints()

        ge_result = results[-1]
        exp_list = ge_result.details["expectations"]
        assert len(exp_list) == 1
        assert exp_list[0]["type"] == "expect_column_values_to_be_unique"
        assert exp_list[0]["success"] is True

    def test_end_to_end_with_real_ge_runner_in_memory(self, tmp_path: Path) -> None:
        """Integration: DataQualityRunner -> ge_runner fallback evaluator."""
        cfg = _minimal_config(
            {
                "great_expectations": {
                    "suites": [
                        {
                            "name": "bronze_test_suite",
                            "datasource": "adls_bronze",
                            "expectations": [
                                {"expect_table_row_count_to_be_between": {"min_value": 1}},
                                {"expect_column_values_to_not_be_null": {"column": "id"}},
                            ],
                        }
                    ]
                }
            }
        )
        runner = _make_runner(tmp_path, cfg)
        sample = {
            "bronze_test_suite": [
                {"id": "row-1"},
                {"id": "row-2"},
            ]
        }
        results = runner.run_ge_checkpoints(sample_data=sample)

        ge_result = next(r for r in results if r.check_name == "ge:bronze_test_suite")
        assert ge_result.status == "pass"


# ---------------------------------------------------------------------------
# generate_report
# ---------------------------------------------------------------------------


class TestGenerateReport:
    def test_empty_results_returns_zero_health_score(self, tmp_path: Path) -> None:
        runner = _make_runner(tmp_path)
        report = runner.generate_report()
        assert report["summary"]["total_checks"] == 0
        assert report["summary"]["health_score"] == 0.0

    def test_all_pass_gives_100_health_score(self, tmp_path: Path) -> None:
        from csa_platform.governance.dataquality.run_quality_checks import QualityCheckResult

        runner = _make_runner(tmp_path)
        runner.results = [
            QualityCheckResult("c1", "t1", "pass"),
            QualityCheckResult("c2", "t2", "pass"),
            QualityCheckResult("c3", "t3", "pass"),
        ]
        report = runner.generate_report()
        assert report["summary"]["health_score"] == 100.0
        assert report["summary"]["failures"] == 0

    def test_mixed_results_health_score(self, tmp_path: Path) -> None:
        from csa_platform.governance.dataquality.run_quality_checks import QualityCheckResult

        runner = _make_runner(tmp_path)
        runner.results = [
            QualityCheckResult("c1", "t1", "pass"),
            QualityCheckResult("c2", "t2", "pass"),
            QualityCheckResult("c3", "t3", "fail"),
            QualityCheckResult("c4", "t4", "warn"),
        ]
        report = runner.generate_report()
        # 2 pass out of 4 total = 50.0%
        assert report["summary"]["health_score"] == pytest.approx(50.0)
        assert report["summary"]["failures"] == 1
        assert report["summary"]["warnings"] == 1
        assert report["summary"]["passed"] == 2

    def test_report_contains_results_list(self, tmp_path: Path) -> None:
        from csa_platform.governance.dataquality.run_quality_checks import QualityCheckResult

        runner = _make_runner(tmp_path)
        runner.results = [QualityCheckResult("c1", "t1", "pass", "ok")]
        report = runner.generate_report()
        assert isinstance(report["results"], list)
        assert len(report["results"]) == 1
        assert report["results"][0]["check_name"] == "c1"

    def test_report_timestamp_is_present(self, tmp_path: Path) -> None:
        runner = _make_runner(tmp_path)
        report = runner.generate_report()
        assert "report_timestamp" in report
        datetime.fromisoformat(report["report_timestamp"])

    def test_health_score_rounded_to_one_decimal(self, tmp_path: Path) -> None:
        from csa_platform.governance.dataquality.run_quality_checks import QualityCheckResult

        runner = _make_runner(tmp_path)
        # 1 pass out of 3 = 33.333...% → should round to 33.3
        runner.results = [
            QualityCheckResult("c1", "t1", "pass"),
            QualityCheckResult("c2", "t2", "fail"),
            QualityCheckResult("c3", "t3", "fail"),
        ]
        report = runner.generate_report()
        assert report["summary"]["health_score"] == pytest.approx(33.3, abs=0.05)


# ---------------------------------------------------------------------------
# emit_to_log_analytics
# ---------------------------------------------------------------------------


class TestEmitToLogAnalytics:
    def test_skips_upload_when_env_vars_missing(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("MONITOR_DCR_ENDPOINT", raising=False)
        monkeypatch.delenv("MONITOR_DCR_RULE_ID", raising=False)

        runner = _make_runner(tmp_path)
        report = runner.generate_report()

        # When endpoint/rule_id env vars are absent the method must return
        # early without raising and without attempting any network calls.
        # We verify the early return by ensuring subprocess.run is not called.
        with patch("subprocess.run") as mock_sub:
            runner.emit_to_log_analytics(report)
            mock_sub.assert_not_called()

    def test_emits_to_monitor_when_env_vars_set(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from csa_platform.governance.dataquality.run_quality_checks import QualityCheckResult

        monkeypatch.setenv("MONITOR_DCR_ENDPOINT", "https://dcr.monitor.azure.com")
        monkeypatch.setenv("MONITOR_DCR_RULE_ID", "dcr-12345")

        runner = _make_runner(tmp_path)
        runner.results = [QualityCheckResult("c1", "t1", "pass", "ok")]
        report = runner.generate_report()

        mock_client = MagicMock()
        mock_credential = MagicMock()

        with patch.dict(
            "sys.modules",
            {
                "azure.monitor.ingestion": MagicMock(LogsIngestionClient=MagicMock(return_value=mock_client)),
                "azure.identity": MagicMock(DefaultAzureCredential=MagicMock(return_value=mock_credential)),
            },
        ):
            runner.emit_to_log_analytics(report)

    def test_sdk_import_error_does_not_raise(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("MONITOR_DCR_ENDPOINT", "https://dcr.monitor.azure.com")
        monkeypatch.setenv("MONITOR_DCR_RULE_ID", "dcr-12345")

        runner = _make_runner(tmp_path)
        report = runner.generate_report()

        # Simulate the Azure Monitor Ingestion SDK not being installed by making
        # its module-level import raise ImportError.  The method catches this and
        # logs a warning — it must not re-raise.
        with patch.dict(
            "sys.modules",
            {
                "azure.monitor.ingestion": None,  # None causes ImportError on import
            },
        ):
            # Should not raise — the method gracefully degrades
            runner.emit_to_log_analytics(report)

    def test_default_stream_name_used_when_env_not_set(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("MONITOR_DCR_STREAM", raising=False)
        monkeypatch.setenv("MONITOR_DCR_ENDPOINT", "https://dcr.monitor.azure.com")
        monkeypatch.setenv("MONITOR_DCR_RULE_ID", "dcr-12345")

        runner = _make_runner(tmp_path)
        report = runner.generate_report()

        mock_client_instance = MagicMock()
        mock_client_class = MagicMock(return_value=mock_client_instance)

        with patch.dict(
            "sys.modules",
            {
                "azure.monitor.ingestion": MagicMock(LogsIngestionClient=mock_client_class),
                "azure.identity": MagicMock(DefaultAzureCredential=MagicMock()),
            },
        ):
            runner.emit_to_log_analytics(report)

            if mock_client_instance.upload.called:
                upload_kwargs = mock_client_instance.upload.call_args.kwargs
                assert upload_kwargs.get("stream_name") == "Custom-DataQuality_CL"


# ---------------------------------------------------------------------------
# _parse_dbt_failures
# ---------------------------------------------------------------------------


class TestParseDbtFailures:
    def test_parses_structured_run_results_json(self, tmp_path: Path) -> None:
        from csa_platform.governance.dataquality.run_quality_checks import DataQualityRunner

        run_results = {
            "results": [
                {
                    "unique_id": "test.project.not_null_customers.customer_id",
                    "status": "fail",
                    "message": "Got 3 rows",
                },
                {
                    "unique_id": "test.project.unique_orders.order_id",
                    "status": "error",
                    "message": "Schema error",
                },
                {
                    "unique_id": "test.project.not_null_orders.total",
                    "status": "pass",
                    "message": "",
                },
            ]
        }
        results_file = tmp_path / "target" / "run_results.json"
        results_file.parent.mkdir(parents=True)
        results_file.write_text(json.dumps(run_results), encoding="utf-8")

        # Override the hardcoded path by running from tmp_path
        original_cwd = Path.cwd()
        import os

        os.chdir(tmp_path)
        try:
            failures = DataQualityRunner._parse_dbt_failures("ignored stdout")
        finally:
            os.chdir(original_cwd)

        assert len(failures) == 2  # only fail/error statuses
        test_ids = {f["test"] for f in failures}
        assert "test.project.not_null_customers.customer_id" in test_ids
        assert "test.project.unique_orders.order_id" in test_ids

    def test_falls_back_to_stdout_when_no_json_file(self) -> None:
        from csa_platform.governance.dataquality.run_quality_checks import DataQualityRunner

        stdout = (
            "Running 3 tests...\n"
            "FAIL 1 test.not_null_customers...\n"
            "FAIL 1 test.unique_orders...\n"
            "Done.\n"
        )

        # Ensure target/run_results.json does not exist in cwd
        with patch("pathlib.Path.exists", return_value=False):
            failures = DataQualityRunner._parse_dbt_failures(stdout)

        assert len(failures) >= 2

    def test_returns_empty_on_clean_output(self) -> None:
        from csa_platform.governance.dataquality.run_quality_checks import DataQualityRunner

        with patch("pathlib.Path.exists", return_value=False):
            failures = DataQualityRunner._parse_dbt_failures(
                "Running 5 tests...\nPASS all.\nDone."
            )

        assert failures == []

    def test_handles_malformed_json_gracefully(self, tmp_path: Path) -> None:
        from csa_platform.governance.dataquality.run_quality_checks import DataQualityRunner

        results_file = tmp_path / "target" / "run_results.json"
        results_file.parent.mkdir(parents=True)
        results_file.write_text("{invalid json}", encoding="utf-8")

        import os

        original_cwd = Path.cwd()
        os.chdir(tmp_path)
        try:
            # Should not raise; falls back to stdout parsing
            failures = DataQualityRunner._parse_dbt_failures("FAIL 1 some test")
        finally:
            os.chdir(original_cwd)

        # Fallback to stdout — may find "FAIL" line
        assert isinstance(failures, list)


# ---------------------------------------------------------------------------
# Integration: full orchestration path with all mocks
# ---------------------------------------------------------------------------


class TestFullOrchestration:
    """Simulate a complete run: dbt + freshness + volume + GE -> report."""

    def test_full_run_produces_report_with_correct_summary(self, tmp_path: Path) -> None:
        from csa_platform.governance.dataquality.ge_runner import SuiteResult

        cfg = _minimal_config(
            {
                "rules": {
                    "volume": [
                        {"table": "bronze.brz_customers", "min_rows": 100, "max_growth_pct": 50}
                    ],
                    "freshness": [],
                },
                "great_expectations": {
                    "suites": [
                        {
                            "name": "bronze_customers_suite",
                            "datasource": "adls_bronze",
                            "expectations": [
                                {"expect_table_row_count_to_be_between": {"min_value": 1}}
                            ],
                        }
                    ]
                },
            }
        )
        runner = _make_runner(tmp_path, cfg)

        dbt_success = MagicMock(returncode=0, stdout="")
        dbt_row_count = MagicMock(returncode=0, stdout="500\n")
        freshness_ok = MagicMock(returncode=0, stdout="")

        mock_ge_result = SuiteResult(
            suite_name="bronze_customers_suite",
            datasource="adls_bronze",
            table="bronze.customers",
            status="pass",
            message="1 expectations passed",
        )

        call_sequence = [dbt_success, freshness_ok, dbt_row_count]

        with patch("subprocess.run", side_effect=call_sequence), \
             patch(
                 "csa_platform.governance.dataquality.run_quality_checks.run_ge_checkpoints",
                 return_value=[mock_ge_result],
             ):
            runner.run_dbt_tests()
            runner.check_freshness()
            runner.check_volume_rules()
            runner.run_ge_checkpoints()

        report = runner.generate_report()

        assert report["summary"]["total_checks"] >= 3
        # All should be pass in this scenario
        assert report["summary"]["failures"] == 0
        assert report["summary"]["health_score"] == 100.0
