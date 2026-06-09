# cosmos-metrics — parity with Azure Cosmos DB **Metrics / Insights** blade

Source UI: Azure portal → Cosmos DB account → **Metrics** and **Insights**
(https://learn.microsoft.com/azure/cosmos-db/monitor-reference#supported-metrics-for-microsoftdocumentdbdatabaseaccounts)

This surface is the **Metrics** tab inside the Loom Cosmos DB Data Explorer
studio (`cosmos-account-editor.tsx`). It charts the live Azure Monitor platform
metrics for the configured navigator account (`LOOM_COSMOS_ACCOUNT`) scoped to
a container, a database, or the whole account.

## Azure feature inventory (grounded in Learn)

| Capability (portal Metrics/Insights) | Metric (REST) | Aggregation | Dimensions |
|---|---|---|---|
| Request Units consumed (Total Request Units) | `TotalRequestUnits` | Total | DatabaseName, CollectionName |
| Provisioned throughput (RU/s ceiling) | `ProvisionedThroughput` | Maximum | DatabaseName, CollectionName |
| Data storage (used) | `DataUsage` | Total | DatabaseName, CollectionName |
| Throttled requests — HTTP 429 (rate limited) | `TotalRequests` filtered `StatusCode eq '429'` | Count | DatabaseName, CollectionName, StatusCode |
| Time-range picker (1h / 6h / 24h / 7d) | n/a (timespan + grain) | — | — |
| Scope to container / database / account | OData `$filter` on DatabaseName + CollectionName | — | — |
| Refresh | re-issue metrics query | — | — |

`DataUsage` is current (the deprecated `AvailableStorage` was removed Sept 2023).
`ServerSideLatency` was deprecated Aug 2025 → catalog uses `ServerSideLatencyDirect`.

## Loom coverage

| Inventory row | Status | Notes |
|---|---|---|
| RU consumed | built ✅ | `TotalRequestUnits` Total, sparkline tile |
| Provisioned throughput | built ✅ | `ProvisionedThroughput` Maximum, adjacent tile → consumed-vs-provisioned |
| Data storage | built ✅ | `DataUsage` Total |
| Throttled (429) | built ✅ | `TotalRequests` + `StatusCode eq '429'` filter, Count |
| Time-range picker | built ✅ | PT1H / PT6H / P1D / P7D with grain auto-selected per window |
| Container/db/account scope | built ✅ | OData `$filter`; tree "Metrics" leaf scopes to the container, ribbon "Metrics" → account-level |
| Refresh | built ✅ | re-queries the BFF |
| Honest infra gate | gate ⚠️ | 503 `not_configured` when LOOM_COSMOS_ACCOUNT/_RG/SUBSCRIPTION_ID unset |

Zero ❌. No Fabric / Power BI dependency — pure Azure Monitor REST.

## Backend per control

- All series → `GET /api/items/cosmos-db/[id]/metrics?db&container&timespan`
  → `fetchMetrics()` in `lib/azure/monitor-client.ts`
  → Azure Monitor `…/providers/microsoft.insights/metrics?api-version=2023-10-01`
  with `$filter` for dimension scoping.
- Account resolution → `cosmosAccountResourceId()` in `lib/azure/cosmos-account-client.ts`
  (reads `LOOM_SUBSCRIPTION_ID` / `LOOM_COSMOS_ACCOUNT_RG` / `LOOM_COSMOS_ACCOUNT`).
- RBAC: Console UAMI **Monitoring Reader** at subscription scope, already granted
  in `platform/fiab/bicep/modules/admin-plane/monitoring-reader-rbac.bicep`. No
  new role grant or env var; no bicep change.

## Per-cloud

`monitor-client` and `cosmos-account-client` both resolve the ARM host via
`cloud-endpoints` (`armBase()`/`armScope()`), so Commercial, GCC,
GCC-High/IL5 (`management.usgovcloudapi.net`), and DoD
(`management.azure.microsoft.scloud`) all route automatically with no special
casing.
