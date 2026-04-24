# Load & Performance Tests

[tests](../../tests/) / **load**


> [!TIP]
> **TL;DR** — Regression-detection harnesses for four platform targets: Azure Function HTTP triggers (k6), dbt model execution (pytest benchmark), Databricks notebooks (Jobs API), and ADF pipelines (REST API). These are on-demand tests requiring live environments, not part of the default CI run.

## Table of Contents

- [Azure Function HTTP Triggers](#-azure-function-http-triggers)
- [dbt Model Performance Benchmarks](#-dbt-model-performance-benchmarks)
- [Databricks Notebook Baselines](#-databricks-notebook-baselines)
- [ADF Pipeline Throughput](#-adf-pipeline-throughput)
- [Storing Results](#-storing-results)
- [Related Documentation](#-related-documentation)

Regression-detection harnesses for the four moving parts of the CSA-in-a-Box
platform that are sensitive to load:

| Target | Harness | Location |
|---|---|---|
| Azure Function HTTP triggers | [k6](https://k6.io/) | `k6_ai_enrichment.js` |
| dbt model execution | pytest + subprocess timing | `benchmark_dbt_models.py` |
| Databricks notebooks & ADF | procedure + metrics contract | `README.md` section below |

> [!IMPORTANT]
> These are *not* part of the default CI run — they require a live environment (a running Function app URL, a Databricks SQL warehouse, or an ADF instance) and so are gated behind the optional `load-tests.yml` workflow (`workflow_dispatch` only). Run them on demand before shipping changes that touch hot paths, and capture the result in `.claude/DEVELOPMENT_LOG.md` so regressions show up in future diffs.

---

## ⚡ Azure Function HTTP Triggers

### ⚡ k6

```bash
k6 run tests/load/k6_ai_enrichment.js \
  --env BASE_URL=https://<your-function-app>.azurewebsites.net \
  --env FUNCTION_KEY=$FUNCTION_KEY \
  --vus 50 \
  --duration 2m
```

The k6 script shares the acceptance targets above and enforces them with
`thresholds{}` so the run exits non-zero on regression — safe to wire
into CI as a blocking check if the team decides to move to k6 Cloud.

---

## ⚡ dbt Model Performance Benchmarks

```bash
# Single run
python tests/load/benchmark_dbt_models.py \
  --target dev \
  --models tag:silver \
  --output reports/dbt-bench-silver.json

# Regression check (compares against a stored baseline)
python tests/load/benchmark_dbt_models.py \
  --target dev \
  --models tag:silver \
  --baseline reports/dbt-bench-silver.baseline.json \
  --max-regression-pct 20
```

The benchmark script runs `dbt run --select <models>` N times (default 3),
records wall-clock time per model from `target/run_results.json`, and
emits a JSON report. When `--baseline` is supplied it exits non-zero if
any model slows down by more than `--max-regression-pct`.

Acceptance targets — run on a small-but-realistic dataset
(1k customers, 10k orders):

| Layer | Target |
|---|---|
| Silver incremental run | < 60s |
| Gold full refresh | < 3min |

---

## ⚡ Databricks Notebook Baselines

Baselines for `domains/shared/notebooks/databricks/delta_lake_optimization.py`
should be captured directly in Databricks via the Jobs API. Procedure:

1. Create a Databricks Job pointing at the notebook, parameterised with a
   small/medium/large config.
2. Trigger the job via:
   ```bash
   databricks jobs run-now --job-id <id> --notebook-params '{"config":"small"}'
   ```
3. Record the run's `execution_duration` metric from the Jobs API into
   `reports/databricks-opt-baseline.json`.
4. Compare future runs against the baseline and flag any regression >20%.

Target: OPTIMIZE + VACUUM pass over the Silver layer on a small-cluster
should complete in < 10 minutes.

---

## ⚡ ADF Pipeline Throughput

ADF pipelines do not have a local harness today. The recommended
procedure is:

1. Trigger `pl_ingest_to_bronze` via the ADF REST API with a known
   synthetic file size (e.g. 1GB of rows).
2. Query the pipeline run's
   [`rowsRead` / `rowsCopied`](https://learn.microsoft.com/azure/data-factory/copy-activity-monitoring)
   output metrics via
   `az datafactory pipeline-run query-by-factory`.
3. Divide `rowsRead` by `executionDuration` to derive throughput.
4. Record the result in `reports/adf-pl_ingest_to_bronze-baseline.json`.

Target: sustained ≥ 50k rows/sec on a DIU=4 copy activity.

---

## 📁 Storing Results

All reports land under a top-level `reports/` directory (gitignored —
see `.gitignore`). To preserve a run for regression tracking, copy the
file into `tests/load/baselines/<date>/` and commit it alongside the
deploy tag that produced it.

---

## 🔗 Related Documentation

- [Production Checklist](../../docs/PRODUCTION_CHECKLIST.md) — Pre-deployment verification steps
