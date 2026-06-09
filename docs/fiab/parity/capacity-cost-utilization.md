# capacity-cost-utilization — parity with the Azure portal Cost + Monitor surfaces

Source UI:
- Azure portal → Subscriptions / Resource → **Cost analysis** (Cost Management):
  https://learn.microsoft.com/azure/cost-management-billing/costs/quick-acm-cost-analysis
- Azure portal → Resource → **Metrics** (Azure Monitor):
  https://learn.microsoft.com/azure/azure-monitor/essentials/metrics-getting-started
- Azure Managed Grafana (Gov embed): https://learn.microsoft.com/azure/managed-grafana/overview

The Loom `/admin/capacity` page is the inventory + capacity command-center. F5
lifts the previously-deferred "Cost & utilization" gate and builds the real
columns/charts against Azure-native backends (no Microsoft Fabric dependency —
`cu_percentage` is read as an Azure Monitor platform metric on the
`Microsoft.Fabric/capacities` ARM type, never via a Fabric REST call).

## Azure feature inventory (every capability)

| # | Capability (Azure portal) | Backend |
|---|---|---|
| 1 | Month-to-date actual cost per resource | `Microsoft.CostManagement/query` (ActualCost, ResourceId dimension filter) |
| 2 | Currency-aware cost formatting | `Currency` column of the cost query |
| 3 | Aggregate cost roll-up across selected scope | sum of per-resource MTD costs |
| 4 | Per-resource utilization metric (CU% / CPU% / SU% / RU / req-rate) | `…/providers/microsoft.insights/metrics` (Azure Monitor) |
| 5 | Inline metric time-series chart (last/min/max) | Azure Monitor metrics, multiple aggregations |
| 6 | Per-resource detail blade with all platform metrics | Azure Monitor `metricsForType()` catalog |
| 7 | Open resource in Azure portal | portal deep-link |
| 8 | Rich embedded dashboard (Power BI Embedded / Managed Grafana) | Power BI (Commercial) / Managed Grafana (Gov) deep-link |

## Loom coverage

| # | Capability | Status | Where |
|---|---|---|---|
| 1 | MTD cost per resource — `$/mo` column | ✅ | `CostCell` → `GET /api/admin/capacity/cost` → `cost-client.getResourceMonthlyCost` |
| 2 | Currency-aware formatting | ✅ | `Intl.NumberFormat` from the query's `Currency` |
| 3 | Cost roll-up footer (loaded rows) | ✅ | `costTotals` sum in `page.tsx` |
| 4 | Per-row utilization sparkline | ✅ | `UtilizationSparkCell` → `POST /api/admin/capacity/utilization` (headline metric) |
| 5 | Inline metric charts | ✅ | detail `Drawer` → `MetricChart` grid (`allMetrics:true`) |
| 6 | Per-resource detail pane (all metrics) | ✅ | `DetailPane`, row click |
| 7 | Open in Azure portal | ✅ | portal deep-link button + column |
| 8 | Power BI (Commercial) / Managed Grafana (Gov) embed link | ✅ | `GET /api/admin/capacity/viz-config` → deep-link buttons |
| — | Cost Mgmt unavailable (no role / no offer) | ⚠️ honest-gate | `cost` cell → "⚠ No access" badge + tooltip; never a fake number |
| — | No platform metric for a type (e.g. Fabric capacity in Gov) | ⚠️ honest-gate | util cell → "—"; detail pane → MessageBar |

Zero ❌. Gov fallback: detail pane always renders inline Azure Monitor charts
(work in every cloud) + a "View in Managed Grafana" link when configured —
never blank.

## Backend per control

| Control | REST / data-plane |
|---|---|
| `$/mo` cost cell + footer | `POST {ARM}/subscriptions/{sub}/providers/Microsoft.CostManagement/query?api-version=2023-03-01` (ResourceId filter) |
| Utilization sparkline + charts | `GET {resourceId}/providers/microsoft.insights/metrics?api-version=2023-10-01` |
| Viz config (Grafana/PBI links) | server env (`LOOM_GRAFANA_ENDPOINT`, `LOOM_GOVERN_PBI_*`) via `/api/admin/capacity/viz-config` |

## RBAC required on the Console UAMI

| Role | Scope | Wired by |
|---|---|---|
| Cost Management Reader (`72fafb9e-0641-4937-9268-a91bfd8191a3`) | subscription | `modules/admin-plane/cost-management-reader-rbac.bicep` (new) |
| Monitoring Reader (`43d0d8ad-25c7-4714-9337-8ba259a9fe05`) | subscription | `modules/admin-plane/monitoring-reader-rbac.bicep` (existing) |

## Per-cloud matrix

| Feature | Commercial | GCC | GCC-High / IL5 | DoD |
|---|---|---|---|---|
| Cost column | ✅ EA/PAYG | ✅ same ARM host | ✅ `management.usgovcloudapi.net` EA/PAYG (CSP offers → honest gate) | ✅ `management.azure.microsoft.scloud` |
| Utilization metrics | ✅ | ✅ | ✅ | ✅ |
| `cu_percentage` (Fabric capacity) | ✅ resource exists | ✅ | ⚠️ honest "—" (no Fabric capacity in Gov) | ⚠️ honest "—" |
| Inline Monitor charts | ✅ | ✅ | ✅ | ✅ |
| Embed link | Power BI / Grafana (optional) | Power BI / Grafana | Managed Grafana (PBI Embedded N/A) | Managed Grafana |

## Verification

- `vitest run lib/clients/__tests__/cost-client.test.ts` — pure parse/extract.
- Live: with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, the cost column shows real
  Cost Management spend and the utilization sparkline shows real Monitor metrics;
  removing Cost Management Reader renders the "⚠ No access" gate (not blank).
