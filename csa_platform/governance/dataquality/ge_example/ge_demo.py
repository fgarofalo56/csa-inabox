"""Runnable Great Expectations 1.x demo for CSA-in-a-Box.

Self-contained reproduction of the end-to-end GE flow used in the tutorial
at ``docs/tutorials/great-expectations.md``:

    1. Seed a tiny synthetic NOAA-style observations DataFrame.
    2. Build an ephemeral DataContext (no on-disk GX project needed).
    3. Register a Pandas datasource and batch definition.
    4. Build an ``ExpectationSuite`` from the JSON template at
       ``expectations/noaa_observations_suite.json``.
    5. Wire a ValidationDefinition + Checkpoint and run it.
    6. Return / print the results.

The script is runnable as ``python ge_demo.py`` and importable as
``from csa_platform.governance.dataquality.ge_example.ge_demo import run_demo``.
This lets the pytest harness exercise the same code path in CI without
shelling out.

Why an ephemeral context?
    The tutorial config at ``great_expectations.yml`` uses filesystem
    stores; an ephemeral context keeps the test isolated and is the
    recommended approach for unit tests in the GE 1.x docs:
    https://docs.greatexpectations.io/docs/reference/learn/terms/data_context/.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import pandas as pd  # type: ignore[import-untyped, unused-ignore]

# Module-level paths so tests can import them without constructing the demo.
MODULE_DIR = Path(__file__).resolve().parent
EXPECTATIONS_DIR = MODULE_DIR / "expectations"
SUITE_JSON = EXPECTATIONS_DIR / "noaa_observations_suite.json"
SUITE_NAME = "noaa_observations_suite"


@dataclass
class DemoResult:
    """Typed wrapper over the CheckpointResult we actually care about."""

    success: bool
    total_expectations: int
    successful_expectations: int
    failed_expectations: int
    suite_name: str
    row_count: int


def seed_dataframe(
    *,
    rows: int = 24,
    start: datetime | None = None,
    include_violations: bool = False,
) -> pd.DataFrame:
    """Generate a deterministic synthetic observations DataFrame.

    Args:
        rows: Number of rows (observations) to generate. Defaults to 24, which
            is roughly one calendar day of hourly buoy observations.
        start: First observation timestamp. Defaults to 2024-06-01T00:00Z.
        include_violations: When True, injects values that will fail the
            suite. Used by the negative-path test.

    Returns:
        A pandas DataFrame whose columns match the shape declared by
        ``examples/noaa/contracts/ocean-buoys.yaml`` (the subset the suite
        actually validates).
    """
    # Lazy import so importing this module is cheap and the extras gate is
    # clearly reported when the user forgot to install pandas.
    import pandas as pd

    if start is None:
        start = datetime(2024, 6, 1, tzinfo=timezone.utc)

    station_ids = ["buoy-46025", "buoy-46047", "buoy-44013"]
    station_types = ["Buoy", "Buoy", "C-MAN"]
    base_lat = [33.7, 32.4, 42.3]
    base_lon = [-119.0, -119.5, -70.7]

    records: list[dict[str, Any]] = []
    for i in range(rows):
        s = i % len(station_ids)
        records.append(
            {
                "station_id": station_ids[s],
                "station_type": station_types[s],
                "observation_datetime": start + timedelta(hours=i),
                "latitude": base_lat[s],
                "longitude": base_lon[s],
                # Plausible ranges well inside the suite thresholds.
                "air_temperature_c": 15.0 + (i % 12) * 0.8,
                "pressure_hpa": 1012.5 + (i % 5) * 0.7,
                "wind_speed_ms": 4.0 + (i % 6) * 1.1,
                "quality_flag": "GOOD",
            },
        )

    if include_violations and records:
        # Inject a single out-of-range value to prove the suite detects it.
        records[0]["air_temperature_c"] = 999.0
        records[0]["station_type"] = "INVALID"

    return pd.DataFrame.from_records(records)


def _load_suite_json(path: Path = SUITE_JSON) -> dict[str, Any]:
    """Load the static suite JSON authored in ``expectations/``.

    Keeping the suite as a JSON artifact means the same definition is
    reviewable (diffable) in source control AND loadable by the GE SDK.
    """
    if not path.exists():
        raise FileNotFoundError(
            f"Expectation suite JSON not found at {path}. "
            f"The ge_example module is missing files - please reinstall.",
        )
    return json.loads(path.read_text(encoding="utf-8"))


def _build_suite(context: Any, suite_name: str = SUITE_NAME) -> Any:
    """Translate the JSON suite into a live GE ExpectationSuite.

    Uses the GE 1.x ``great_expectations.expectations`` module which ships
    typed Expectation classes. Falls back to the ``type`` string at load
    time so any expectation added to the JSON is picked up automatically.
    """
    import great_expectations as gx
    from great_expectations import expectations as gxe

    suite_json = _load_suite_json()
    suite = gx.ExpectationSuite(name=suite_name)

    # Lookup table: expectation type string -> class. Keeps the mapping
    # explicit, which makes it trivial to spot a missing expectation type in
    # code review and avoids ``getattr`` by string (which would silently
    # succeed on typos and fail at evaluation time).
    factories: dict[str, type] = {
        "expect_table_row_count_to_be_between": gxe.ExpectTableRowCountToBeBetween,  # type: ignore[attr-defined, unused-ignore]
        "expect_column_to_exist": gxe.ExpectColumnToExist,  # type: ignore[attr-defined, unused-ignore]
        "expect_column_values_to_not_be_null": gxe.ExpectColumnValuesToNotBeNull,  # type: ignore[attr-defined, unused-ignore]
        "expect_column_values_to_be_in_set": gxe.ExpectColumnValuesToBeInSet,  # type: ignore[attr-defined, unused-ignore]
        "expect_column_values_to_be_between": gxe.ExpectColumnValuesToBeBetween,  # type: ignore[attr-defined, unused-ignore]
    }

    for exp in suite_json["expectations"]:
        exp_type = exp["type"]
        kwargs = exp.get("kwargs", {})
        cls = factories.get(exp_type)
        if cls is None:
            raise ValueError(
                f"Unknown expectation type {exp_type!r} in {SUITE_JSON}. "
                f"Add it to the factories table in ge_demo._build_suite.",
            )
        suite.add_expectation(cls(**kwargs))

    # Register with the context so the ValidationDefinition can reference it.
    context.suites.add(suite)
    return suite


def run_demo(
    *,
    rows: int = 24,
    include_violations: bool = False,
    verbose: bool = False,
) -> DemoResult:
    """Run the full tutorial end-to-end and return a typed result.

    Args:
        rows: How many synthetic observation rows to seed.
        include_violations: If True, inject a row that violates the suite.
        verbose: Print each expectation outcome to stdout.

    Returns:
        A ``DemoResult`` summarising the checkpoint outcome.
    """
    import great_expectations as gx
    import pandas as pd  # noqa: F401  - imported for type-check clarity.

    df = seed_dataframe(rows=rows, include_violations=include_violations)

    # Ephemeral context: no filesystem writes, idiomatic for tests.
    context = gx.get_context(mode="ephemeral")

    # Register a Pandas datasource + whole-dataframe batch definition. In
    # production against ADLS one would use a Spark datasource or a
    # pandas-on-parquet path; see the tutorial for the ADLS recipe.
    data_source = context.data_sources.add_pandas(name="csa_demo")
    data_asset = data_source.add_dataframe_asset(name="noaa_observations")
    batch_definition = data_asset.add_batch_definition_whole_dataframe(
        name="whole_dataframe",
    )

    # Build the suite from the JSON artifact shipped alongside this module.
    suite = _build_suite(context)

    # Wire validation definition + checkpoint.
    validation_definition = gx.ValidationDefinition(
        data=batch_definition,
        suite=suite,
        name="noaa_observations_validation",
    )
    context.validation_definitions.add(validation_definition)

    checkpoint = gx.Checkpoint(
        name="daily_quality",
        validation_definitions=[validation_definition],
        result_format={"result_format": "COMPLETE"},
    )
    context.checkpoints.add(checkpoint)

    # Actually run the checkpoint against the in-memory DataFrame.
    result = checkpoint.run(batch_parameters={"dataframe": df})

    # ``result.run_results`` maps ValidationResultIdentifier -> ExpectationSuiteValidationResult.
    # In GE 1.x there is exactly one entry per validation definition.
    total = 0
    successful = 0
    for validation_result in result.run_results.values():
        # validation_result may expose either 'results' or 'expectation_results'.
        per_expectation = getattr(validation_result, "results", None) or []
        for expectation in per_expectation:
            total += 1
            if getattr(expectation, "success", False):
                successful += 1
            if verbose:
                exp_type = expectation.expectation_config.type
                status = "PASS" if expectation.success else "FAIL"
                print(f"  {status}  {exp_type}")

    demo = DemoResult(
        success=bool(result.success),
        total_expectations=total,
        successful_expectations=successful,
        failed_expectations=total - successful,
        suite_name=SUITE_NAME,
        row_count=len(df),
    )

    if verbose:
        print("")
        print(
            f"Checkpoint: {demo.suite_name}  "
            f"rows={demo.row_count}  "
            f"expectations={demo.successful_expectations}/{demo.total_expectations} "
            f"success={demo.success}",
        )

    return demo


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: run the happy-path demo and print a summary."""
    del argv  # No CLI args today; reserved for future --violations / --rows.
    demo = run_demo(verbose=True)
    return 0 if demo.success else 1


if __name__ == "__main__":
    sys.exit(main())
