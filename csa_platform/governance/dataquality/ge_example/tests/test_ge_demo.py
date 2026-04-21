"""Tests for the ge_example GE 1.x demo.

Exercise both the happy path (every expectation passes) and the negative
path (injected violations fail the suite) to confirm the tutorial stays
runnable as Great Expectations evolves.

The whole module is gated on ``great_expectations`` being importable - the
tutorial ships as a `tutorials` optional-dependency extra.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

ge = pytest.importorskip(
    "great_expectations",
    reason="install the tutorials extra: pip install -e \".[tutorials]\"",
)
pd = pytest.importorskip("pandas")

from csa_platform.governance.dataquality.ge_example import ge_demo  # noqa: E402


SUITE_JSON = (
    Path(ge_demo.__file__).resolve().parent
    / "expectations"
    / "noaa_observations_suite.json"
)
CHECKPOINT_YAML = (
    Path(ge_demo.__file__).resolve().parent
    / "checkpoints"
    / "daily_quality.yml"
)


# --- Static artifact sanity checks ---------------------------------------


def test_suite_json_is_valid_and_nonempty() -> None:
    """The shipped JSON suite must parse and contain expectations."""
    data = json.loads(SUITE_JSON.read_text(encoding="utf-8"))
    assert data["name"] == "noaa_observations_suite"
    assert isinstance(data["expectations"], list)
    assert len(data["expectations"]) >= 5, "Demo should exercise a non-trivial suite"
    # Every expectation must carry a type string.
    for exp in data["expectations"]:
        assert "type" in exp, exp
        assert isinstance(exp["type"], str)
        assert "kwargs" in exp, exp


def test_checkpoint_yaml_is_parseable() -> None:
    """The shipped checkpoint YAML must parse as valid YAML."""
    import yaml

    data = yaml.safe_load(CHECKPOINT_YAML.read_text(encoding="utf-8"))
    assert data["name"] == "daily_quality"
    assert data["validations"][0]["expectation_suite_name"] == "noaa_observations_suite"


# --- Synthetic data seeder -----------------------------------------------


def test_seed_dataframe_happy_path_shape() -> None:
    """The seeded DataFrame must have the columns the suite validates."""
    df = ge_demo.seed_dataframe(rows=10)
    assert len(df) == 10
    expected_columns = {
        "station_id",
        "station_type",
        "observation_datetime",
        "latitude",
        "longitude",
        "air_temperature_c",
        "pressure_hpa",
        "wind_speed_ms",
        "quality_flag",
    }
    assert expected_columns.issubset(set(df.columns))


def test_seed_dataframe_violations_differ_from_happy_path() -> None:
    """Injecting violations must actually change the DataFrame."""
    happy = ge_demo.seed_dataframe(rows=5, include_violations=False)
    bad = ge_demo.seed_dataframe(rows=5, include_violations=True)
    assert happy.iloc[0]["air_temperature_c"] != bad.iloc[0]["air_temperature_c"]
    assert bad.iloc[0]["air_temperature_c"] == 999.0
    assert bad.iloc[0]["station_type"] == "INVALID"


# --- End-to-end checkpoint run (core requirement) ------------------------


def test_run_demo_happy_path_checkpoint_passes() -> None:
    """Running the demo with clean data must pass every expectation."""
    result = ge_demo.run_demo(rows=24, include_violations=False)
    assert result.success is True, (
        f"Expected checkpoint to pass. Failed: {result.failed_expectations}/"
        f"{result.total_expectations}"
    )
    assert result.failed_expectations == 0
    assert result.total_expectations >= 5
    assert result.successful_expectations == result.total_expectations
    assert result.row_count == 24
    assert result.suite_name == "noaa_observations_suite"


def test_run_demo_negative_path_detects_violations() -> None:
    """Injected out-of-range values must fail the suite."""
    result = ge_demo.run_demo(rows=12, include_violations=True)
    assert result.success is False
    assert result.failed_expectations >= 1
    # The happy path passes every expectation, so a failed count proves the
    # injected violations were actually evaluated.
    assert result.total_expectations >= 5


def test_main_returns_zero_on_success(capsys: pytest.CaptureFixture[str]) -> None:
    """The CLI entry point exits 0 when the checkpoint passes."""
    rc = ge_demo.main()
    assert rc == 0
    captured = capsys.readouterr()
    assert "success=True" in captured.out
