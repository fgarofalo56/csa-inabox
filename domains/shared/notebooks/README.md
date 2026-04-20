[Home](../../../README.md) > [Domains](../../) > [Shared](../) > **Notebooks**

# Shared Notebooks

> **Last Updated:** 2026-04-20 | **Status:** Active | **Audience:**
> Data engineers, ML engineers, platform operators

> [!IMPORTANT]
> **This tree is NOT the canonical Bronze → Silver → Gold
> transformation path.** Per
> [ADR-0013](../../../docs/adr/0013-dbt-as-canonical-transformation.md),
> **dbt Core is the canonical transformation layer** in
> csa-inabox. Medallion transforms live under each domain's
> `dbt/models/` tree, not here. See
> [ADR-0008](../../../docs/adr/0008-dbt-core-over-dbt-cloud.md)
> for the dbt distribution choice.

## Purpose

This tree holds Databricks / PySpark notebooks that are
**intentionally outside the dbt medallion path**:

- **Ad-hoc exploration and profiling** — one-off data inspection,
  stat generation, prototyping before a pattern graduates into dbt.
- **Delta Lake maintenance** — `OPTIMIZE`, `VACUUM`, Z-ORDER jobs
  that dbt does not run.
- **Unity Catalog provisioning** — metastore setup, catalog /
  schema creation, RBAC automation.
- **ML workloads** — MLflow feature engineering, training,
  experiment tracking, model registry.
- **dbt orchestration** — notebooks that *invoke* dbt from
  Databricks (not notebooks that replicate dbt).
- **Data-quality reporting** — notebooks that read contract YAML
  and emit scorecards.

## Canonical transformation path

For Bronze → Silver → Gold medallion work, use dbt:

```
domains/shared/dbt/models/
domains/finance/dbt/models/
domains/sales/dbt/models/
domains/inventory/dbt/models/
```

dbt is invoked on Databricks via
[`databricks/orchestration/run_dbt.py`](databricks/orchestration/run_dbt.py)
or from ADF via the `pl_run_dbt_models` pipeline.

## File inventory

### Canonical (not deprecated)

| File | Purpose | Why it stays out of dbt |
|---|---|---|
| [`data_exploration.py`](data_exploration.py) | Ad-hoc multi-layer data inspection | Exploration / profiling, not transformation |
| [`data_quality_report.py`](data_quality_report.py) | Quality scorecard against contract YAML | Reads contracts; emits reports; not a transformation |
| [`databricks/delta_lake_optimization.py`](databricks/delta_lake_optimization.py) | OPTIMIZE / VACUUM / Z-ORDER maintenance | Delta maintenance is out of scope for dbt |
| [`databricks/unity_catalog_setup.py`](databricks/unity_catalog_setup.py) | Metastore, catalog, RBAC provisioning | Provisioning, not transformation |
| [`databricks/data_quality_monitor.py`](databricks/data_quality_monitor.py) | Reads contract YAML, logs SLA results to Log Analytics | Observability over contracts; does not transform medallion data |
| [`databricks/ml/ml_pipeline_template.py`](databricks/ml/ml_pipeline_template.py) | MLflow pipeline template | ML workloads are out of scope for dbt |
| [`databricks/orchestration/run_dbt.py`](databricks/orchestration/run_dbt.py) | Invokes dbt CLI from Databricks | Orchestrates dbt; does not replicate it |
| [`databricks/config/openlineage.json`](databricks/config/openlineage.json) | OpenLineage configuration | Config, not code |

### Deprecated (replaced by dbt)

| File | Deprecation | Canonical replacement |
|---|---|---|
| [`databricks/bronze_to_silver_spark.py`](databricks/bronze_to_silver_spark.py) | 2026-04-20 per CSA-0130 / ADR-0013 | `domains/<domain>/dbt/models/silver/slv_*.sql` |

Deprecated files remain on disk for historical reference and to
keep any ad-hoc one-off runs working during the migration window.
**New medallion transformation work MUST happen in the dbt tree.**

## References

- [ADR-0013 — dbt Core as the canonical transformation layer](../../../docs/adr/0013-dbt-as-canonical-transformation.md)
- [ADR-0008 — dbt Core over dbt Cloud](../../../docs/adr/0008-dbt-core-over-dbt-cloud.md)
- [ADR-0001 — ADF (+ dbt) over Airflow](../../../docs/adr/0001-adf-dbt-over-airflow.md)
- Finding: CSA-0130 (HIGH); approved ballot item E5 (AQ-0029)
