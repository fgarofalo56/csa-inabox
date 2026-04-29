---
status: accepted
date: 2026-04-19
deciders: csa-inabox platform team
consulted: security, governance, dev-loop
informed: all
---

# ADR 0002 — Azure Databricks over open-source Spark-on-AKS for heavy compute

## Context and Problem Statement

Medallion transformations, large-scale enrichment, and ML feature engineering
require a distributed Spark runtime. Customers need a predictable Spark
experience in both Azure Commercial and Azure Government, with a credible
story for governance (Unity Catalog), performance (Photon), and cost control
(job clusters with auto-termination). We must pick a primary compute engine
before the Databricks-specific Bicep modules (see
`deploy/bicep/DMLZ/modules/Databricks/databricks.bicep`) are finalized.

## Decision Drivers

- **Azure Government availability** for the Spark runtime with FedRAMP High
  authorization inheritance.
- **Total cost of ownership** — we prefer a managed runtime over customer-run
  AKS Spark operators that need 24x7 platform engineering.
- **Governance** — native integration with Unity Catalog and Purview for
  row/column lineage, classification propagation, and table-level ACLs.
- **Performance** — Photon + Delta Lake optimizations materially reduce
  query latency for Silver/Gold.
- **Composability** — the choice must not lock in proprietary transformation
  code; dbt and PySpark are both portable.

## Considered Options

1. **Azure Databricks (chosen)** — Managed Spark, Unity Catalog, Photon,
   Delta Lake native, Gov-GA, strong Purview integration.
2. **Open-source Apache Spark on AKS** — Full control, no platform markup,
   but customer-owned HA, upgrades, and autoscaling.
3. **Azure Synapse Spark Pools** — Managed, integrated with Synapse SQL, but
   less aggressive innovation cadence and weaker Unity-Catalog-equivalent
   governance.
4. **Microsoft Fabric Spark** — Strategic target (see ADR-0010) but Gov
   availability lags Commercial by quarters to a year.

## Decision Outcome

Chosen: **Option 1 — Azure Databricks** as the primary heavy-compute engine,
with Synapse Spark permitted for tenants that have an existing Synapse
footprint and Fabric Spark planned as a migration target once Gov-GA lands.

## Consequences

- Positive: Managed service, auto-termination controls cost, Photon gives
  real speedups on Delta, Unity Catalog gives fine-grained access control
  and lineage without custom code.
- Positive: Gov-GA available with FedRAMP High inheritance from Microsoft.
- Positive: PySpark + dbt transformations remain portable to Fabric Spark
  or OSS Spark if we migrate later.
- Negative: Per-DBU premium on top of VM cost; requires active cluster
  policy enforcement to stop sprawl (tracked in
  `deploy/bicep/DMLZ/modules/Databricks/databricks.bicep` cluster policies).
- Negative: Workspace sprawl if one workspace per domain becomes the
  default — mitigated by Unity-Catalog-scoped workspaces.
- Negative: Some Databricks-specific APIs (e.g. SQL warehouses, Jobs 2.1)
  are non-portable; we cap their use to orchestration glue, not business
  logic.
- Neutral: Does not preclude a future migration to Fabric Spark; Delta
  tables and Unity Catalog entries are first-class in Fabric OneLake.

## Pros and Cons of the Options

### Option 1 — Azure Databricks

- Pros: Managed runtime; Photon; Unity Catalog; Gov-GA; strong Purview
  integration; Delta Lake-native; mature job scheduler.
- Cons: DBU markup; SQL Warehouses are proprietary; workspace proliferation
  risk.

### Option 2 — OSS Spark on AKS

- Pros: No DBU premium; full version control; portable everywhere.
- Cons: Customer-owned HA, upgrades, autoscaling, and governance; no
  equivalent to Unity Catalog; no Photon.

### Option 3 — Synapse Spark Pools

- Pros: Managed; integrated with Synapse SQL; Gov-GA; cheaper DBU-free
  pricing model.
- Cons: Slower innovation; no Photon equivalent; Purview lineage is
  shallower; tighter coupling to a Synapse workspace.

### Option 4 — Fabric Spark

- Pros: Strategic future target; OneLake-native; deep Purview + Fabric
  governance integration.
- Cons: Gov-GA lags; not viable for current federal tenants.

## Validation

We will know this decision is right if:

- Spark job cost per TB processed is within 25% of a well-tuned OSS Spark
  benchmark after cluster policies are applied.
- Unity Catalog replaces legacy Hive-metastore + ACL code in all domains
  within two quarters.
- If Fabric Spark reaches Gov-GA and matches Databricks feature parity,
  revisit for new workloads (tracked in ADR-0010).

## References

- Decision tree:
  [Fabric vs. Databricks vs. Synapse](../decisions/fabric-vs-databricks-vs-synapse.md)
- Related code: `deploy/bicep/DMLZ/modules/Databricks/databricks.bicep`,
  `deploy/bicep/DLZ/modules/databricks/databricks.bicep`,
  `deploy/bicep/gov/modules/databricks.bicep`, `domains/spark/configs/`
- Framework controls: NIST 800-53 **AC-3** (Unity Catalog access
  enforcement), **AU-12** (cluster audit logs to Log Analytics), **SC-8**
  (encryption in transit via customer-managed keys). See
  `governance/compliance/nist-800-53-rev5.yaml`.
- Discussion: CSA-0087
