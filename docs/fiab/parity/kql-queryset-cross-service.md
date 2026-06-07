# kql-queryset (cross-service source binder) — parity with ADX cross-service query

Source UI: Azure Data Explorer web UI "Add connection / cross-service query"
+ Microsoft Learn — [Query data in Azure Monitor using Azure Data
Explorer](https://learn.microsoft.com/azure/data-explorer/query-monitor-data).

The Loom KQL Queryset editor (Fabric KQL Queryset parity) gains a **Bind query
source** dialog so a saved query can join Azure Data Explorer (ADX) data with a
Log Analytics workspace or Application Insights component, federated via the ADX
`cluster()` proxy. This is the Azure-native equivalent of Fabric Real-Time
Intelligence cross-source querying — no Fabric/Power BI workspace required.

## Azure/ADX feature inventory

| Capability | Notes |
|---|---|
| Pick a source type for a query (native cluster vs. Monitor proxy) | ADX web UI "Connections" |
| Resolve a Log Analytics workspace by ARM resource ID | `cluster('https://adx.monitor.azure.com/<resourceId>')` |
| Resolve an Application Insights component by ARM resource ID | `.../microsoft.insights/components/<name>` |
| Sovereign endpoint selection (Commercial vs. Government) | `adx.monitor.azure.com` vs. `adx.monitor.azure.us` |
| Federated query (join ADX + LA via `union` / explicit join) | runs as one `/v1/rest/query` on the ADX cluster |
| Auth via the caller identity (no second token) | UAMI holds Log Analytics Reader on the workspace |
| Honest error when no workspace is reachable | precise message instead of a raw proxy 400 |

## Loom coverage

| Inventory row | Status | Where |
|---|---|---|
| Source-type picker (adx / log-analytics / app-insights) | ✅ | `KqlQuerysetEditor` "Bind query source" dialog |
| Resolve LA workspace by ARM resource ID | ✅ | `laProxyClusterUri()` from `LOOM_LOG_ANALYTICS_RESOURCE_ID` |
| Resolve App Insights component | ✅ | dialog shows the `components/<name>` proxy form |
| Sovereign endpoint selection | ✅ | `laProxyClusterUri()` reads `AZURE_CLOUD` → `.us` host for Gov |
| Federated query execution | ✅ | `/run` passes KQL verbatim to `executeQuery()`; ADX resolves `cluster()` |
| Auth (no second token) | ✅ | Console UAMI + `consoleLaReader` (Log Analytics Reader) |
| Honest gate when env var unset | ⚠️ honest-gate | `laConfigGate()` → Fluent `MessageBar intent="warning"` naming `LOOM_LOG_ANALYTICS_RESOURCE_ID`; `/run` returns HTTP 503 |

Zero ❌. The honest-gate row is the documented no-vaporware state when a
Log Analytics workspace has not been deployed.

## Backend per control

| Control | Backend |
|---|---|
| "Source" toolbar button → dialog | client state only (opens dialog) |
| Source-type `Select` | sets `draft.sourceType` |
| KQL snippet textarea | populated from `GET /api/items/kql-queryset/[id]` (`laProxyUri`, `laWorkspaceName`) |
| "Bind" | persists `sourceType` onto the saved query via `PUT /api/items/kql-queryset/[id]` |
| "Run" | `POST /api/items/kql-queryset/[id]/run` → `executeQuery(db, kql)` on the ADX cluster; ADX resolves the `cluster()` cross-cluster reference server-side |

## Per-cloud endpoint

| Boundary | `AZURE_CLOUD` | ADX proxy host | Works (ADX → LA)? |
|---|---|---|---|
| Commercial / GCC | `AzureCloud` | `adx.monitor.azure.com` | Yes |
| GCC-High / IL5 | `AzureUSGovernment` | `adx.monitor.azure.us` | Yes |

The Government-cloud limitation in Learn applies to the LA-initiated direction
(`adx()` function, LA → ADX). Loom initiates **from ADX** with `cluster()`
(ADX → LA), for which the `adx.monitor.azure.us` endpoint is documented and
supported.

## Bicep sync

No new env var or role required — all plumbing already exists:

- `LOOM_LOG_ANALYTICS_RESOURCE_ID` — `platform/fiab/bicep/modules/admin-plane/main.bicep:733`
- `AZURE_CLOUD` — `main.bicep:849`
- Log Analytics Reader grant (`consoleLaReader`) — `monitoring.bicep:174`
