---
status: accepted
date: 2026-04-19
deciders: csa-inabox platform team
consulted: security, governance, dev-loop
informed: all
---

# ADR 0001 — ADF (+ dbt) over Airflow as primary orchestration

## Context and Problem Statement

CSA-in-a-Box targets federal and regulated customers who deploy to **Azure
Government** and require an orchestrator with an ATO-ready story on day one.
The platform also needs to carry lineage through to Purview and expose
transformations that SQL-literate analysts can author without Python
operator-authoring skills. We therefore had to choose a default orchestrator
plus transformation layer before onboarding vertical examples.

## Decision Drivers

- Must run natively in **Azure Government** (IL4/IL5) on the day a tenant is
  onboarded — no self-hosted HA clusters.
- Must emit **lineage to Microsoft Purview** without custom bridges (governance
  baseline, CSA-0012 control mapping).
- Prefer a **managed PaaS** orchestrator over self-hosted workloads to shrink
  the ATO surface area and reduce FedRAMP inheritance burden.
- Transformations should be authorable by the **broad SQL skill pool** in
  federal data teams rather than requiring Python/Airflow-operator experience.
- Decision must be **composable** — the orchestrator should be replaceable at
  the transformation seam without rewriting SQL.

## Considered Options

1. **Azure Data Factory + dbt Core (chosen)** — Azure-native, Gov-GA, mature
   Self-Hosted Integration Runtime (SHIR), Purview lineage is first-class, and
   dbt owns the transformation layer in portable SQL.
2. **Apache Airflow on AKS** — Open-source, flexible Python DAGs, large
   operator ecosystem; but not a managed Gov PaaS and requires customer-owned
   HA + patching.
3. **Azure Synapse Pipelines** — Functionally overlaps ADF; no clear win and
   couples orchestration to a Synapse workspace we may not provision.
4. **Azure Logic Apps** — Suitable for lightweight event-driven flows but too
   thin for full ELT with parameterized metadata frameworks.

## Decision Outcome

Chosen: **Option 1 — ADF + dbt Core**.

ADF owns control flow, copy activities, trigger scheduling, and SHIR-based
ingress from private networks. dbt Core owns all modelled transformations
(Bronze → Silver → Gold) as portable SQL. ADF invokes dbt via a pipeline
activity (see `domains/shared/pipelines/adf/pl_run_dbt_models.json`).

## Consequences

- Positive: Managed PaaS in Azure Gov with no HA burden on the customer.
- Positive: Purview lineage is automatic for ADF activities and surfaces
  dbt-emitted column-level lineage through the `dbt-meta` exporter.
- Positive: Transformation logic is expressed as SQL — broad skill pool,
  review-friendly, and portable if the orchestrator layer is later swapped.
- Positive: Pipeline authoring can be metadata-driven (see
  `domains/shared/pipelines/adf/pl_medallion_orchestration.json`), reducing
  per-source bespoke code.
- Negative: ADF's UI-first authoring model makes complex branching verbose;
  workaround is nested pipelines and execute-pipeline activities.
- Negative: Copy-activity DIU pricing scales linearly with data volume — a
  real cost exposure on petabyte ingest. See cost tree.
- Negative: Canonical DAG history lives inside ADF (not Git) unless Git
  integration is enabled; requires deliberate CI/CD.
- Neutral: The decision is replaceable at the dbt seam — if we later move to
  a different orchestrator, the dbt project is unchanged.

## Pros and Cons of the Options

### Option 1 — ADF + dbt Core

- Pros: Managed PaaS; Gov-GA; Purview-native lineage; SQL transformation
  skill pool; SHIR for private-network ingress; metadata-driven pipelines.
- Cons: UI-heavy complex branching; copy-activity cost at volume; Git
  integration is opt-in.

### Option 2 — Airflow on AKS

- Pros: Open source; Python DAG expressiveness; huge operator ecosystem;
  provider-neutral.
- Cons: Self-managed HA; customer owns patching + scheduler + worker
  scaling; not a Gov-PaaS offering; Purview integration requires custom code.

### Option 3 — Synapse Pipelines

- Pros: Integrated with Synapse SQL/Spark; identical authoring model to ADF.
- Cons: Functionally a subset of ADF; couples orchestration to a Synapse
  workspace; weaker story when Databricks is the compute tier.

### Option 4 — Logic Apps

- Pros: Cheap; event-native; strong connector catalog.
- Cons: Not a data-engineering orchestrator; no bulk copy; awkward for
  parameterized, metadata-driven pipeline generation.

## Validation

We will know this decision is right if:

- 90th-percentile vertical example onboards with zero custom Python
  operators in the orchestrator.
- Purview shows end-to-end lineage for Bronze → Silver → Gold without
  manual entity registration.
- If we exceed five custom-activity .NET extensions per quarter, revisit
  and reconsider Airflow on AKS.

## References

- Decision tree: [ETL vs. ELT](../decisions/etl-vs-elt.md)
- Related code: `domains/shared/pipelines/adf/pl_ingest_to_bronze.json`,
  `domains/shared/pipelines/adf/pl_run_dbt_models.json`,
  `domains/shared/pipelines/adf/pl_medallion_orchestration.json`,
  `domains/shared/dbt/dbt_project.yml`
- Framework controls: NIST 800-53 **CM-3** (configuration change control,
  pipeline-as-code), **AU-2** (auditable pipeline events), **CP-10** (system
  recovery via re-runnable pipelines). Mapped in
  `governance/compliance/nist-800-53-rev5.yaml`.
- Discussion: CSA-0010 + CSA-0087
