# Capacity & compute admin page

> **Surface:** `/admin/capacity`
> **BFF:** `apps/fiab-console/app/api/admin/capacity/{cost,utilization,guardrails,chargeback,viz-config}/route.ts`
> **Bicep dependency:** the backing compute modules under `platform/fiab/bicep/modules/**` (ACA, Databricks, Synapse, ADF, Cosmos, ACR, AML)

The **Capacity & compute** page is the operator's single view of the underlying
Azure services CSA Loom orchestrates — Azure Container Apps, Databricks, Synapse,
Azure Data Factory, Azure Data Lake Analytics, Azure Machine Learning, Cosmos DB
and Azure Container Registry — with their live utilization, cost, and the
admission-control guardrails that keep spend bounded.

Per the **no-vaporware** rule every number on this page is a real Azure read; a
service that isn't provisioned shows an honest `MessageBar` naming the exact
resource / env var to set, never a fabricated figure.

## What you can do

- **Utilization** — live per-engine utilization pulled from Azure Monitor
  (`/api/admin/capacity/utilization`), normalized so ACA, Spark, Synapse, ADX and
  Cosmos read on one scale.
- **Cost** — real spend from Azure Cost Management (`/api/admin/capacity/cost`),
  broken down by service.
- **Guardrails** — the FGC-25 capacity surge-protection policy
  (`/api/admin/capacity/guardrails`): the master switch, the capacity-level
  rejection threshold, per-engine overrides, and the per-workspace LCU/hour cap.
  Ships **default-on** as a cost-protection control (not an enablement gate).
- **Chargeback** — a shortcut into the per-domain attribution used by the
  [Chargeback report](chargeback.md).

## Backend

| Control | Backend |
|---|---|
| Utilization tiles | Azure Monitor metrics (`monitor-client`) |
| Cost tiles | Azure Cost Management query API |
| Guardrails | Cosmos `capacity-guardrails` (PK `/tenantId`) + enforced at every job/query submit |
| Chargeback drill | Cosmos `cost-attribution` ledger (PK `/tenantId`, TTL 90d) |

## RBAC & honest gates

The page runs as the Console UAMI. It needs **Monitoring Reader** on the
subscription (utilization) and **Cost Management Reader** (cost). Where a grant
or a resource is missing, the card renders the remediation text verbatim and the
rest of the page still loads.

## Related

- [Scale by SKU](scaling.md) — change the tier of any backing service.
- [Usage & chargeback](usage-chargeback.md) — unified LCU capacity metrics.
- [Chargeback report](chargeback.md) — per-domain spend attribution.
