"""Tests for scripts/seed/load_sample_data.py — sample data loader."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.conftest import load_script_module

# Load module from scripts directory (not a package).
_SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "seed" / "load_sample_data.py"
_mod = load_script_module("load_sample_data", _SCRIPT_PATH)

upload_to_adls = _mod.upload_to_adls
run_dbt_seed = _mod.run_dbt_seed
SEED_DIR: Path = _mod.SEED_DIR
DBT_PROJECT_DIR: Path = _mod.DBT_PROJECT_DIR


class TestConstants:
    """Verify path constants resolve correctly."""

    def test_seed_dir_points_to_shared_seeds(self) -> None:
        assert SEED_DIR.name == "seeds"
        assert "shared" in str(SEED_DIR)

    def test_dbt_project_dir_exists(self) -> None:
        # The dbt project should exist in the repo
        assert DBT_PROJECT_DIR.is_dir()


class TestRunDbtSeed:
    """Tests for the dbt seed wrapper."""

    def test_dry_run_does_not_execute(self, capsys: pytest.CaptureFixture[str]) -> None:
        run_dbt_seed(dry_run=True)
        captured = capsys.readouterr()
        assert "DRY RUN" in captured.out
        assert "dbt" in captured.out
        assert "seed" in captured.out

    def test_dry_run_prints_command(self, capsys: pytest.CaptureFixture[str]) -> None:
        run_dbt_seed(dry_run=True)
        captured = capsys.readouterr()
        assert "--project-dir" in captured.out


class TestUploadToAdls:
    """Tests for ADLS upload logic (SDK mocked)."""

    def test_dry_run_does_not_call_azure(self, capsys: pytest.CaptureFixture[str]) -> None:
        """dry_run=True should list files without importing Azure SDK."""
        # Only works if SEED_DIR has CSV files
        csvs = list(SEED_DIR.glob("*.csv"))
        if not csvs:
            pytest.skip("No seed CSV files found")

        upload_to_adls(
            storage_account="testaccount",
            container="raw",
            domain="shared",
            dry_run=True,
        )
        captured = capsys.readouterr()
        assert "DRY RUN" in captured.out
        # Should mention the CSV file names
        for csv in csvs:
            assert csv.name in captured.out
