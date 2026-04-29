---
status: accepted
date: 2026-04-19
deciders: csa-inabox platform team
consulted: security, governance, dev-loop
informed: all
---

# ADR 0008 — dbt Core over dbt Cloud for transformations

## Context and Problem Statement

ADR-0001 established dbt as the canonical transformation layer above
Databricks/Synapse SQL. dbt is distributed as both an open-source CLI
("dbt Core") and a SaaS product ("dbt Cloud") with an IDE, scheduler, and
hosted metadata. We must pick which distribution our reference
implementation runs, with full awareness that federal tenants cannot
easily consume SaaS that is not FedRAMP-authorized in Gov regions.

## Decision Drivers

- **Federal data residency** — no customer data or metadata should leave
  the Azure Gov boundary.
- **Toolchain footprint** — prefer fewer external SaaS dependencies; one
  more SaaS vendor is one more FedRAMP boundary to manage.
- **CI/CD integration** — dbt must run inside ADF pipelines and GitHub
  Actions / Azure DevOps; a CLI is easier to embed than a SaaS runner.
- **Cost per seat** — dbt Cloud priced per developer-seat scales poorly for
  broad enablement; open-source Core has no seat tax.
- **Optionality** — nothing we adopt should prevent a tenant from moving
  to dbt Cloud later if they want the IDE + scheduler story.

## Considered Options

1. **dbt Core (chosen)** — Open-source CLI, runs anywhere, embeddable in
   ADF and CI, no SaaS dependency.
2. **dbt Cloud** — Hosted IDE, scheduler, docs, metadata API; strong dev
   ergonomics.
3. **SQLMesh** — Alternative transformation framework with stronger
   state-aware planning; smaller community.
4. **Raw SQL scripts + stored procedures** — Simplest, but no dependency
   graph, no tests, no docs.

## Decision Outcome

Chosen: **Option 1 — dbt Core** executed from ADF
(`domains/shared/pipelines/adf/pl_run_dbt_models.json`) and from CI. The
project lives in `domains/shared/dbt/` and is invoked through a
containerized runner so the CLI version is pinned per release.

## Consequences

- Positive: No SaaS boundary to clear — dbt Core runs inside the tenant
  network.
- Positive: Zero per-seat licensing; broad enablement is friction-free.
- Positive: Fits the containerized-pipeline pattern and is embeddable in
  ADF, GitHub Actions, and Databricks Workflows identically.
- Positive: Artifacts (`manifest.json`, `catalog.json`, `run_results.json`)
  are emitted to ADLS for downstream consumption by Purview and
  observability dashboards.
- Negative: Scheduler, job UI, and metadata API must be provided elsewhere
  — we lean on ADF for scheduling and Purview for metadata.
- Negative: Web-based docs site (`dbt docs`) requires a hosting decision —
  we publish it to the portal via a static-site pipeline.
- Negative: Semantic-layer features introduced in dbt Cloud (MetricFlow)
  are available in Core but less polished.
- Neutral: Tenants that prefer dbt Cloud can swap in their Cloud project
  — the model SQL is unchanged.

## Pros and Cons of the Options

### Option 1 — dbt Core

- Pros: Open-source; no SaaS boundary; embeddable; zero seat cost;
  container-friendly; portable across Databricks + Synapse + Fabric.
- Cons: No hosted IDE; scheduler + metadata API are bring-your-own.

### Option 2 — dbt Cloud

- Pros: Hosted IDE; scheduler; hosted docs; Semantic Layer; CI integration.
- Cons: SaaS boundary (FedRAMP Moderate in Commercial; Gov story varies);
  per-seat pricing; vendor procurement.

### Option 3 — SQLMesh

- Pros: State-aware planning (virtual environments); strong column-level
  lineage; Python-native models.
- Cons: Smaller community; fewer adapters; adapter ecosystem lags dbt.

### Option 4 — Raw SQL + stored procedures

- Pros: Zero framework cost.
- Cons: No DAG, no tests, no docs, no lineage — rebuilds what dbt already
  solves.

## Validation

We will know this decision is right if:

- All dbt projects run identically in ADF, GitHub Actions, and Databricks
  Workflows.
- `manifest.json` + `run_results.json` are published to ADLS on every run
  and consumed by observability.
- If federal tenants accept dbt Cloud's Gov authorization and the
  per-seat cost is acceptable, the dbt Cloud path may be opened for
  organizations that prefer the hosted IDE.

## References

- Decision tree:
  [ETL vs. ELT](../decisions/etl-vs-elt.md)
- Related code: `domains/shared/dbt/dbt_project.yml`,
  `domains/shared/dbt/profiles.yml`, `domains/shared/dbt/models/`,
  `domains/shared/pipelines/adf/pl_run_dbt_models.json`
- Framework controls: NIST 800-53 **CM-3** (change control — dbt models
  are reviewed in PRs), **CM-4** (impact analysis — dbt DAG makes the
  blast radius explicit), **SI-10** (information-input validation — dbt
  tests enforce contracts). See
  `governance/compliance/nist-800-53-rev5.yaml`.
- Discussion: CSA-0087
