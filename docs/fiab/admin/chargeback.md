# Chargeback report admin page

> **Surface:** `/admin/chargeback`
> **BFF:** `apps/fiab-console/app/api/admin/chargeback/{attribution,workspaces}/route.ts`
> **Store:** Cosmos `cost-attribution` (PK `/tenantId`, TTL 90d)

The **Chargeback report** attributes real Azure Cost Management spend to
governance domains using the `loom-domain` resource tag — the Azure-native 1:1 of
the Microsoft Fabric Chargeback app. It answers "which business domain is
spending what" with a real per-domain report: a stacked bar chart, CSV export,
and per-user drill-down.

## What you can do

- **Per-domain spend** — `/api/admin/chargeback/attribution` joins Cost
  Management actual spend to domains via the `loom-domain` tag and the
  `cost-attribution` ledger of per-execution costs.
- **Per-workspace breakdown** — `/api/admin/chargeback/workspaces` drills a
  domain into its workspaces.
- **Drill to user** — expand any domain/workspace to the per-user execution costs
  recorded at each Spark / Databricks / ADX / AOAI submit.
- **Export** — download the report as CSV for finance.

## Backend

| Control | Backend |
|---|---|
| Actual spend | Azure Cost Management query API, filtered by the `loom-domain` tag |
| Per-execution costs | Cosmos `cost-attribution` (append-only, TTL 90d) written at each job/query submit |
| Domain list | Cosmos `governance-domains` (PK `/tenantId`) |

## RBAC & honest gates

Runs as the Console UAMI with **Cost Management Reader** on the billing scope and
the **Cost Management chargeback RBAC** module applied (deployed on demand). If
the grant is absent the page shows the exact role + scope to assign; the
`cost-attribution` ledger still renders the per-execution view it owns.

## Related

- [Usage & chargeback](usage-chargeback.md) — capacity/LCU view.
- [Capacity & compute](capacity.md) · [Domains](domains.md)
