---
status: accepted
date: 2026-04-20
deciders: csa-inabox platform team
consulted: data engineering, governance, security
informed: all
---

# ADR 0013 — dbt Core as the canonical transformation layer

## Context and Problem Statement

Bronze → Silver → Gold transformations exist in the repository along
two parallel paths:

1. **dbt models** under each domain's `dbt/` tree
   (`domains/shared/dbt/models/`, `domains/finance/dbt/models/`,
   `domains/sales/dbt/models/`, `domains/inventory/dbt/models/`). The
   domains README marks dbt as the canonical medallion path, and
   ADR-0001 already named dbt the canonical transformation layer
   above orchestration.
2. **PySpark notebooks** under
   `domains/shared/notebooks/databricks/` — notably
   `bronze_to_silver_spark.py` — which implement the same
   cleansing / validation / dedup logic using the Databricks Spark
   API. The header even describes itself as "alternative to dbt for
   teams that prefer native Spark processing."

The two implementations drift. Bugs fix in one path and not the
other. Contributors split effort between the SQL and PySpark
versions. Data quality semantics (null handling, SCD behavior,
timestamp normalization) diverge because they are encoded twice.
ADR-0008 already chose dbt Core over dbt Cloud, but it did **not**
rule parallel Spark notebooks in or out. An explicit ADR is the
missing piece.

## Decision Drivers

- **Single source of truth** for Bronze → Silver → Gold lineage —
  auditors, Purview, and downstream consumers can point at one path.
- **Test framework consolidation** — dbt generic + singular tests
  are the data-quality primitive; replicating equivalent logic in
  Spark notebooks duplicates effort and drifts from
  `csa_platform/governance/dataquality/` rules.
- **Purview lineage ingest** — Purview consumes dbt `manifest.json`
  natively. The mesh federation model introduced in ADR-0012 and
  CSA-0128 depends on dbt-as-canonical for automated lineage and
  contract propagation across domains.
- **Contributor velocity** — onboarding a new domain is "copy the
  dbt template," not "write Spark notebooks and wire dbt in
  parallel."
- **Alignment with already-accepted ADRs** — ADR-0001 (dbt above
  orchestration), ADR-0002 (Databricks compute), ADR-0003 (Delta
  format), ADR-0008 (dbt Core over Cloud) all push toward dbt-only
  for medallion transforms; only the absence of an explicit
  exclusion ADR allowed parallel Spark notebooks to persist.

## Considered Options

1. **dbt-first; deprecate duplicate Spark notebooks (chosen)** —
   dbt owns the medallion transformation layer; Spark notebooks
   remain appropriate for exploration, provisioning, OPTIMIZE /
   VACUUM maintenance, and ML workloads.
2. **Spark-first** — invert and rely on PySpark notebooks as
   canonical; treat dbt as optional overlay.
3. **Both remain canonical** — codify the status quo; accept the
   drift as a feature-for-flexibility trade-off.
4. **Rewrite everything in a third tool (SQLMesh, Dataform,
   hand-rolled Python)** — out of scope; reopens ADR-0008.

## Decision Outcome

Chosen: **Option 1 — dbt-first**. **dbt Core is the canonical
transformation layer** for all Bronze → Silver → Gold work in
csa-inabox.

**In-scope for dbt (the only sanctioned path):**
- Bronze → Silver (cleansing, validation, canonicalization,
  schema enforcement)
- Silver → Gold (joins, aggregations, business logic, dimensional
  modelling)
- Schema tests (generic + singular)
- Contract-driven schema declarations (`schema.yml` /
  `schema_contract_generated.yml` alongside models)
- Snapshot models for SCD2

**Out-of-scope for dbt — Spark notebooks remain appropriate:**
- Ad-hoc exploration and profiling
  (`domains/shared/notebooks/data_exploration.py`)
- One-off Delta Lake `OPTIMIZE` / `VACUUM` / Z-ORDER operations
  (`delta_lake_optimization.py`)
- Unity Catalog provisioning, metastore setup, and RBAC
  automation (`unity_catalog_setup.py`)
- ML feature engineering and model training with MLflow
  (`databricks/ml/ml_pipeline_template.py`)
- dbt orchestration from Databricks itself
  (`databricks/orchestration/run_dbt.py` — this *invokes* dbt,
  it does not replicate it)
- Data-quality report generation from contract YAML
  (`data_quality_report.py`, `data_quality_monitor.py`) — these
  read contracts, they do not transform medallion data

Notebooks that currently duplicate dbt models receive a
deprecation banner, not deletion; they stay on disk for
historical reference and because one-off ad-hoc runs may still
pull from them during the migration window. New medallion work
**must** happen in the dbt tree.

## Consequences

- Positive: Single path for medallion transforms; deduplicates
  maintenance and test logic.
- Positive: Purview lineage works natively via `manifest.json`
  ingest; no need to teach Purview about PySpark notebook graphs.
- Positive: dbt contract tests match the CSA-0128 data-mesh
  federation model and the governance rules in
  `csa_platform/governance/dataquality/`.
- Positive: Contributor onboarding simplifies — one pattern per
  layer, not two.
- Negative: Spark notebooks that duplicate dbt models are now
  deprecated in-place; contributors must migrate any new work
  to dbt rather than extending the notebook.
- Negative: Teams with deep Spark expertise but no SQL experience
  have a short ramp-up cost to dbt Jinja + macro patterns.
- Neutral: ML, provisioning, and ad-hoc exploration notebooks are
  unaffected — they were never in scope for dbt.

## Pros and Cons of the Options

### Option 1 — dbt-first (chosen)
- Pros: Aligns with ADR-0001 / 0002 / 0003 / 0008; native Purview
  lineage; dbt tests reuse governance contracts; single path for
  contributors.
- Cons: One-time deprecation cost on
  `domains/shared/notebooks/databricks/bronze_to_silver_spark.py`;
  short ramp-up for Spark-only contributors.

### Option 2 — Spark-first
- Pros: Maximum flexibility; PySpark can express operations that
  dbt Jinja cannot express cleanly.
- Cons: Loses dbt test framework, contract lineage, and
  Purview-native ingest; contradicts ADR-0008; forces us to
  re-implement dbt's dependency graph by hand.

### Option 3 — Both remain canonical
- Pros: No migration cost.
- Cons: Already producing drift (CSA-0130 was filed precisely
  because bug fixes land in one path and not the other); no audit
  story; no single source of truth.

### Option 4 — Rewrite in a third tool
- Pros: Clean slate.
- Cons: Re-opens ADR-0008; loses SQL-native lineage; community
  adapter gap; scope creep.

## Validation

We will know this decision is right if:
- Every Bronze → Silver → Gold flow in new verticals routes
  through dbt, with no new PySpark "alternative" notebooks
  introduced.
- `manifest.json` artifacts from all domains ingest cleanly into
  Purview and produce complete end-to-end lineage without manual
  stitching.
- CSA-0130-class findings (duplicate implementations drifting)
  do not recur in subsequent audits.
- Contributor time-to-first-PR on a new domain drops, because
  there is only one template to copy.

If PySpark notebooks start creeping back into medallion paths,
the policy is not holding and this ADR should be revisited (a
superseding ADR, not an in-place edit — records are immutable).

## References

- ADR-0001 ADF (+ dbt) over Airflow — names dbt as canonical
  transformation layer above orchestration
- ADR-0002 Azure Databricks over OSS Spark — the compute substrate
  that dbt runs against
- ADR-0003 Delta Lake over Iceberg / Parquet — the storage format
  dbt materializes to
- ADR-0008 dbt Core over dbt Cloud — names the dbt distribution
- ADR-0012 data-mesh federation — depends on dbt being canonical
  so lineage and contracts propagate automatically
- Related code (canonical path): `domains/shared/dbt/models/`,
  `domains/finance/dbt/models/`, `domains/sales/dbt/models/`,
  `domains/inventory/dbt/models/`
- Deprecated code (migration window):
  `domains/shared/notebooks/databricks/bronze_to_silver_spark.py`
- Framework controls: NIST 800-53 **CM-3** (change control —
  medallion transforms are reviewed once, in the dbt tree),
  **CM-4** (impact analysis — dbt DAG makes blast radius
  explicit), **SI-10** (input validation — dbt tests enforce
  contracts once, not twice). See
  `csa_platform/governance/compliance/nist-800-53-rev5.yaml`.
- Discussion / finding: CSA-0130 (HIGH); approved ballot item E5
  (AQ-0029).
