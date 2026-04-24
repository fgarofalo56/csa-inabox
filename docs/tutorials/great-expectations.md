[Home](../../README.md) > [Docs](../) > [Tutorials](./) > **Great Expectations**

# Great Expectations Tutorial (CSA-0074)


!!! tip
    **TL;DR** - Stand up a Great Expectations 1.x project, write an
    expectation suite against ADLS Gen2 Bronze/Silver Delta tables, run a
    checkpoint as a PR gate, and plug the result into the CSA-in-a-Box
    governance runner (`csa_platform/governance/dataquality/ge_runner.py`).
    A fully runnable example lives at
    [`csa_platform/governance/dataquality/ge_example/`](../../csa_platform/governance/dataquality/ge_example/).

Great Expectations (GE) is the data-quality backbone of CSA-in-a-Box. The
platform's governance runner already has a stable interface for executing
expectation suites; this tutorial takes you from empty folder to green PR
in eight numbered steps.

## Table of Contents

- [0. Prerequisites](#0-prerequisites)
- [1. Install and verify](#1-install-and-verify)
- [2. Connect to ADLS Gen2 Bronze and Silver](#2-connect-to-adls-gen2-bronze-and-silver)
- [3. Author an Expectation Suite](#3-author-an-expectation-suite)
- [4. Create a Checkpoint](#4-create-a-checkpoint)
- [5. Run via CLI and the programmatic API](#5-run-via-cli-and-the-programmatic-api)
- [6. Read the Data Docs](#6-read-the-data-docs)
- [7. Integrate with the CSA governance runner](#7-integrate-with-the-csa-governance-runner)
- [8. Wire it into CI as a PR gate](#8-wire-it-into-ci-as-a-pr-gate)
- [9. Related](#9-related)

---

## 0. Prerequisites

- Python 3.10+
- An Azure subscription with ADLS Gen2 (you can follow along locally with
  Pandas - a concrete ADLS snippet is included at the end of each step).
- Access to the CSA-in-a-Box repo. From the repo root:

  ```bash
  pip install -e ".[tutorials]"
  ```

  The `tutorials` extra pins `great-expectations>=1.0.0`. GE is intentionally
  not a core dependency of the repo - it is ~200 MB installed and only the
  data-quality surface needs it.

- The runnable companion example for this tutorial lives at
  [`csa_platform/governance/dataquality/ge_example/`](../../csa_platform/governance/dataquality/ge_example/).
  Every snippet in this tutorial is exercised by
  `ge_example/tests/test_ge_demo.py`.

---

## 1. Install and verify

1. Create the project directory.

   ```bash
   mkdir -p csa_platform/governance/dataquality/ge_example
   cd       csa_platform/governance/dataquality/ge_example
   ```

   (The repo already contains this folder. Re-run the next step in a
   scratch directory if you prefer to start from empty.)

2. Install GE via the `tutorials` extra.

   ```bash
   pip install -e ".[tutorials]"
   python -c "import great_expectations as gx; print(gx.__version__)"
   # -> 1.x.x
   ```

3. Point GE at the config shipped with the example.

   ```python
   import great_expectations as gx

   context = gx.get_context(project_root_dir="csa_platform/governance/dataquality/ge_example")
   print(type(context).__name__)   # -> FileDataContext
   ```

   Using the shipped `great_expectations.yml` rather than the default
   `gx init` output keeps the CSA governance runner happy: stores,
   checkpoints, and data_docs all land under predictable paths.

---

## 2. Connect to ADLS Gen2 Bronze and Silver

Great Expectations 1.x supports two realistic production paths for
CSA-in-a-Box:

### 2a. Spark datasource (Databricks)

Inside a Databricks notebook (where `spark` is pre-bound):

```python
import great_expectations as gx

context = gx.get_context(project_root_dir="<repo>/csa_platform/governance/dataquality/ge_example")

data_source = context.data_sources.add_spark(name="adls_bronze")
data_asset  = data_source.add_dataframe_asset(name="noaa_observations_bronze")
batch_def   = data_asset.add_batch_definition_whole_dataframe(name="whole_df")

# ADLS Gen2 Delta table read through Unity Catalog:
bronze_df = spark.table("csa_bronze.noaa.observations")

# The DataFrame is passed at checkpoint run time via batch_parameters.
```

### 2b. Pandas-on-Parquet (local dev / CI smoke tests)

When you want a fast feedback loop on your laptop:

```python
import pandas as pd
import great_expectations as gx

context = gx.get_context(mode="ephemeral")

df = pd.read_parquet("data/seed/observations_bronze.parquet")

data_source = context.data_sources.add_pandas(name="csa_local")
data_asset  = data_source.add_dataframe_asset(name="noaa_observations_bronze")
batch_def   = data_asset.add_batch_definition_whole_dataframe(name="whole_df")
```

Silver tables reuse the same pattern - just bind a different DataFrame.
Referential-integrity expectations (e.g. every Silver `station_id` exists in
the station catalog) are authored in a second suite that joins the two in
Spark before validation.

---

## 3. Author an Expectation Suite

The [shipped suite](../../csa_platform/governance/dataquality/ge_example/expectations/noaa_observations_suite.json)
covers four categories:

1. **Column types** - `expect_column_to_exist` for each required column.
2. **Null rates** - `expect_column_values_to_not_be_null` for the primary key.
3. **Value domains** - `expect_column_values_to_be_in_set` for
   enumerations, `expect_column_values_to_be_between` for numeric ranges.
4. **Referential integrity** - enforced by a companion suite that joins the
   observations to the station catalog (authored in the same folder).

### Build the suite programmatically

```python
import great_expectations as gx
from great_expectations import expectations as gxe

suite = gx.ExpectationSuite(name="noaa_observations_suite")

# Shape
suite.add_expectation(gxe.ExpectTableRowCountToBeBetween(min_value=1, max_value=100_000))
suite.add_expectation(gxe.ExpectColumnToExist(column="station_id"))
suite.add_expectation(gxe.ExpectColumnToExist(column="observation_datetime"))
suite.add_expectation(gxe.ExpectColumnToExist(column="air_temperature_c"))

# Null rates
suite.add_expectation(gxe.ExpectColumnValuesToNotBeNull(column="station_id"))
suite.add_expectation(gxe.ExpectColumnValuesToNotBeNull(column="observation_datetime"))

# Domains and ranges (mirrors examples/noaa/contracts/ocean-buoys.yaml)
suite.add_expectation(gxe.ExpectColumnValuesToBeInSet(column="station_type", value_set=["Buoy", "C-MAN"]))
suite.add_expectation(gxe.ExpectColumnValuesToBeBetween(column="latitude",  min_value=-90,  max_value=90))
suite.add_expectation(gxe.ExpectColumnValuesToBeBetween(column="longitude", min_value=-180, max_value=180))
suite.add_expectation(gxe.ExpectColumnValuesToBeBetween(column="air_temperature_c", min_value=-60, max_value=60, mostly=0.99))
suite.add_expectation(gxe.ExpectColumnValuesToBeBetween(column="pressure_hpa",      min_value=870, max_value=1084, mostly=0.99))

context.suites.add(suite)
```

### Or load from JSON

CSA-in-a-Box ships expectation suites as JSON artifacts so they are
diff-friendly in code review. See
[`ge_demo.py::_build_suite`](../../csa_platform/governance/dataquality/ge_example/ge_demo.py)
for the exact load-from-JSON pattern the tests exercise.

---

## 4. Create a Checkpoint

A Checkpoint binds a batch definition to a suite and a set of actions
(rebuild Data Docs, post a Slack notification, publish to a metrics
endpoint, ...).

```python
import great_expectations as gx

validation_definition = gx.ValidationDefinition(
    data=batch_def,
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
```

The declarative twin of this checkpoint is shipped at
[`checkpoints/daily_quality.yml`](../../csa_platform/governance/dataquality/ge_example/checkpoints/daily_quality.yml)
so operators can read the same intent from YAML.

---

## 5. Run via CLI and the programmatic API

### Programmatic

```python
result = checkpoint.run(batch_parameters={"dataframe": df})
assert result.success, "daily_quality checkpoint failed"
```

### From the repo CLI

```bash
python csa_platform/governance/dataquality/ge_example/ge_demo.py
# -> PASS expect_table_row_count_to_be_between
#    PASS expect_column_to_exist ...
#    Checkpoint: noaa_observations_suite rows=24 expectations=12/12 success=True
```

Exit code is `0` when every expectation passes and `1` otherwise, so the
demo is usable as a pre-commit hook or a CI step out of the box.

### One-off smoke test (no repo required)

```python
from csa_platform.governance.dataquality.ge_example.ge_demo import run_demo
print(run_demo(rows=24, verbose=True))
# DemoResult(success=True, total_expectations=12, ...)
```

---

## 6. Read the Data Docs

Great Expectations' HTML Data Docs are the single most valuable diagnostic
the toolchain ships. Build them with:

```python
context.build_data_docs()
```

Data Docs land under
`csa_platform/governance/dataquality/ge_example/uncommitted/data_docs/local_site/index.html`.
Open that file in a browser to see:

- Suite overview (every expectation, current pass / fail status).
- Validation history (every checkpoint run, linked to the suite version).
- Profiling reports (distributions, null rates, uniqueness).

In production, the site_builder target is usually an Azure Static Web App
or an ADLS public container - swap the `store_backend` under
`data_docs_sites.local_site` in `great_expectations.yml`.

---

## 7. Integrate with the CSA governance runner

CSA-in-a-Box ships a runner at
[`csa_platform/governance/dataquality/ge_runner.py`](../../csa_platform/governance/dataquality/ge_runner.py)
that:

1. Loads the declarative rules from `quality-rules.yaml`.
2. Delegates to a **real GE checkpoint** when `great_expectations` is
   importable **and** sample data is not injected.
3. Falls back to an **in-memory evaluator** for unit tests / CI where a
   Spark cluster is unavailable.

To wire the tutorial's checkpoint into the runner:

1. Add a `great_expectations.suites[]` entry to `quality-rules.yaml`
   (the fallback evaluator will pick it up automatically).
2. Drop the checkpoint YAML at the path indicated by
   `GE_CHECKPOINT_DIR` (default:
   `csa_platform/great_expectations/checkpoints/`).
3. From a Databricks notebook with an active `SparkSession`:

   ```python
   import great_expectations as gx

   context = gx.get_context(project_root_dir="<repo>/csa_platform/governance/dataquality/ge_example")
   result  = context.checkpoints.get("daily_quality").run(batch_parameters={"dataframe": df})
   ```

The runner reports every suite outcome through the shared structlog
surface (`csa_platform.governance.common.logging`) so checkpoint runs show
up alongside the rest of the governance telemetry in Log Analytics.

---

## 8. Wire it into CI as a PR gate

Add a single job to the existing governance workflow (or to a new
`data-quality.yml`):

```yaml
name: Data Quality

on:
  pull_request:
    paths:
      - 'csa_platform/governance/dataquality/**'
      - 'domains/**/models/**'

jobs:
  checkpoint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - name: Install tutorials extra
        run: pip install -e ".[tutorials]"
      - name: Run checkpoint
        run: |
          python csa_platform/governance/dataquality/ge_example/ge_demo.py
      - name: Run suite tests
        run: pytest csa_platform/governance/dataquality/ge_example/tests/ -v
```

The job fails the PR when any expectation fails. Data Docs are built
locally during the run and can be uploaded as an artifact for review.

---

## 9. Related

- [`csa_platform/governance/dataquality/ge_example/`](../../csa_platform/governance/dataquality/ge_example/) - runnable example referenced throughout.
- [`csa_platform/governance/dataquality/ge_runner.py`](../../csa_platform/governance/dataquality/ge_runner.py) - platform checkpoint runner with fallback evaluator.
- [`docs/runbooks/dbt-ci.md`](../runbooks/dbt-ci.md) - dbt PR gate this tutorial complements.
- [`examples/noaa/contracts/ocean-buoys.yaml`](../../examples/noaa/contracts/ocean-buoys.yaml) - contract that the shipped expectation suite mirrors.
- [Great Expectations 1.x docs](https://docs.greatexpectations.io/docs/core/introduction/).
