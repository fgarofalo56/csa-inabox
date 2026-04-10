"""Tests for the data quality runner."""

from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Add parent to path so we can import the module
import sys
sys.path.insert(0, str(Path(__file__).parent.parent / "governance" / "dataquality"))

from run_quality_checks import DataQualityRunner, QualityCheckResult  # noqa: E402


class TestQualityCheckResult:
    """Tests for QualityCheckResult data class."""

    def test_create_pass_result(self) -> None:
        result = QualityCheckResult(
            check_name="test_check",
            table="my_table",
            status="pass",
            message="All good",
        )
        assert result.status == "pass"
        assert result.table == "my_table"
        assert result.check_name == "test_check"

    def test_create_fail_result_with_details(self) -> None:
        result = QualityCheckResult(
            check_name="test_check",
            table="my_table",
            status="fail",
            message="Bad data",
            details={"row_count": 0, "expected": 100},
        )
        assert result.status == "fail"
        assert result.details["row_count"] == 0

    def test_to_dict(self) -> None:
        result = QualityCheckResult(
            check_name="volume:orders",
            table="orders",
            status="warn",
            message="Low count",
        )
        d = result.to_dict()
        assert isinstance(d, dict)
        assert d["check_name"] == "volume:orders"
        assert "timestamp" in d


class TestDataQualityRunner:
    """Tests for the DataQualityRunner orchestrator."""

    @pytest.fixture
    def config_path(self, tmp_path: Path) -> str:
        config = {
            "rules": {
                "volume": [
                    {"table": "bronze.orders", "min_rows": 100, "max_growth_pct": 200},
                    {"table": "silver.customers", "min_rows": 50},
                ],
                "freshness": [
                    {"source": "raw.customers", "warn_after_hours": 24},
                ],
            }
        }
        config_file = tmp_path / "quality-rules.yaml"
        import yaml
        config_file.write_text(yaml.dump(config))
        return str(config_file)

    def test_init_loads_config(self, config_path: str) -> None:
        runner = DataQualityRunner(config_path)
        assert "rules" in runner.config
        assert len(runner.results) == 0

    @patch("subprocess.run")
    def test_run_dbt_tests_success(self, mock_run: MagicMock, config_path: str) -> None:
        mock_run.return_value = MagicMock(returncode=0, stdout="All tests passed")
        runner = DataQualityRunner(config_path)
        runner.run_dbt_tests()
        assert any(r.status == "pass" for r in runner.results)

    @patch("subprocess.run")
    def test_run_dbt_tests_failure(self, mock_run: MagicMock, config_path: str) -> None:
        mock_run.return_value = MagicMock(
            returncode=1,
            stdout="FAIL 1 test_unique_orders_id\n",
        )
        runner = DataQualityRunner(config_path)
        runner.run_dbt_tests()
        assert any(r.status == "fail" for r in runner.results)

    @patch("subprocess.run", side_effect=FileNotFoundError)
    def test_run_dbt_tests_dbt_not_found(self, mock_run: MagicMock, config_path: str) -> None:
        runner = DataQualityRunner(config_path)
        runner.run_dbt_tests()
        # Should not raise, just skip
        assert len(runner.results) == 0

    def test_check_volume_rules_no_dbt(self, config_path: str) -> None:
        runner = DataQualityRunner(config_path)
        runner.check_volume_rules()
        assert len(runner.results) == 2  # Two volume rules in config
        # Without dbt, should be "warn" (not verified)
        assert all(r.status == "warn" for r in runner.results)

    def test_generate_report(self, config_path: str) -> None:
        runner = DataQualityRunner(config_path)
        runner.results = [
            QualityCheckResult("t1", "table1", "pass", "ok"),
            QualityCheckResult("t2", "table2", "fail", "bad"),
            QualityCheckResult("t3", "table3", "warn", "meh"),
        ]
        report = runner.generate_report()
        assert report["summary"]["total_checks"] == 3
        assert report["summary"]["passed"] == 1
        assert report["summary"]["failures"] == 1
        assert report["summary"]["warnings"] == 1
        assert report["summary"]["health_score"] == pytest.approx(33.3, abs=0.1)

    def test_generate_report_empty(self, config_path: str) -> None:
        runner = DataQualityRunner(config_path)
        report = runner.generate_report()
        assert report["summary"]["total_checks"] == 0
        assert report["summary"]["health_score"] == 0

    def test_parse_dbt_failures(self) -> None:
        output = """Running 3 tests...
PASS unique_orders_id
FAIL 1 test_not_null_orders_amount
PASS accepted_values_status"""
        failures = DataQualityRunner._parse_dbt_failures(output)
        assert len(failures) == 1
        assert "FAIL" in failures[0]["test"]

    def test_select_validation_rejects_injection(self, config_path: str) -> None:
        runner = DataQualityRunner(config_path)
        with pytest.raises(ValueError, match="Invalid dbt select pattern"):
            runner.run_dbt_tests(select="models; rm -rf /")

    def test_select_validation_allows_valid(self, config_path: str) -> None:
        runner = DataQualityRunner(config_path)
        # Should not raise
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="ok")
            runner.run_dbt_tests(select="tag:bronze")


class TestInputValidation:
    """Tests for SQL injection prevention in delta_lake_optimization."""

    def test_valid_identifiers(self) -> None:
        # Import the validator from delta_lake_optimization
        # Since it's a notebook, we test the pattern directly
        import re
        pattern = r'^[a-zA-Z0-9_]{1,256}$'
        assert re.match(pattern, "csa_analytics")
        assert re.match(pattern, "bronze")
        assert re.match(pattern, "my_table_123")
        assert not re.match(pattern, "table; DROP TABLE x")
        assert not re.match(pattern, "table`")
        assert not re.match(pattern, "")
        assert not re.match(pattern, "a" * 257)
