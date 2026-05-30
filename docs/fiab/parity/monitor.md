# monitor — parity with Azure Monitor (for everything deployed in CSA Loom)

Source UI: Azure portal **Monitor** hub
(https://portal.azure.com/#view/Microsoft_Azure_Monitoring/AzureMonitoringBrowseBlade)
Grounded in Microsoft Learn:
- Azure monitoring REST API walkthrough — https://learn.microsoft.com/azure/azure-monitor/platform/rest-api-walkthrough
- Logs query API — https://learn.microsoft.com/azure/azure-monitor/logs/api/overview
- Activity log REST — https://learn.microsoft.com/azure/azure-monitor/platform/activity-log
- Resource Health availabilityStatuses — https://learn.microsoft.com/rest/api/resourcehealth
- metricAlerts — https://learn.microsoft.com/azure/azure-monitor/fundamentals/azure-monitor-rest-api-index

The Loom Monitor surface is scoped to **everything CSA Loom deployed** — the
Azure resources in the Loom resource groups (Container Apps, Cosmos, AI Search,
ADX/Kusto, Synapse/ADF, APIM, Foundry/AOAI, Fabric capacity, App Insights) plus
the Cosmos-backed item telemetry (who deployed/edited what).

## Azure Monitor feature inventory → Loom coverage

| Azure Monitor capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| **Resource inventory** — what's deployed | ✅ Overview tab, grid of all resources across Loom RGs | ARM `GET /subscriptions/{s}/resourceGroups/{rg}/resources?api-version=2021-04-01` |
| **Resource health** — Available/Degraded/Down | ✅ Overview tab, health badge per resource + roll-up stats | `GET /subscriptions/{s}/providers/Microsoft.ResourceHealth/availabilityStatuses?api-version=2023-10-01-preview` |
| **Metrics explorer** — platform metric time-series | ✅ Metrics tab, per-resource SVG charts, time-range + refresh | `GET {resourceId}/providers/microsoft.insights/metrics?metricnames=…&timespan=…&interval=…&aggregation=…&api-version=2023-10-01` |
| **Metric catalog per service** (CPU/mem/requests, Cosmos RU, AI Search QPS, ADX CPU, ADF runs, APIM, App Insights, Fabric CU, AOAI tokens) | ✅ Curated `METRIC_CATALOG` keyed by resource type, grounded in Microsoft.Insights supported-metrics | same metrics REST |
| **Logs (Log Analytics) KQL** | ✅ Logs tab, ad-hoc KQL editor + result grid + 5 curated presets (app errors, HTTP failures, sign-ins, pipeline failures, exceptions) + time-range | `POST https://api.loganalytics.azure.com/v1/workspaces/{id}/query` body `{query,timespan}` |
| **Activity log** — control-plane events | ✅ Activity log tab, grid (time/operation/status/RG/caller) + 24h–90d window | `GET /subscriptions/{s}/providers/Microsoft.Insights/eventtypes/management/values?api-version=2015-04-01&$filter=eventTimestamp ge … and resourceGroupName eq '{rg}'` |
| **Deployed-item telemetry** — who ran/edited/shared what | ✅ Deployed items tab (existing `ActivityFeedPane`) | Cosmos audit-log + comments + shares via `/api/activity` |
| **Alerts** — list metric-alert rules | ✅ Alerts tab, grid (name/enabled/severity/RG/description) | `GET /subscriptions/{s}/providers/Microsoft.Insights/metricAlerts?api-version=2018-03-01` |
| **Alert rule authoring** (create/edit) | ⚠️ honest note: list-only today; rule authoring (`PUT metricAlerts` with criteria + action groups) not yet wired. Manage in portal. | (planned) PUT metricAlerts |
| **Workbooks / dashboards** | ⚠️ out of scope for v1; metrics + logs tabs cover the observable surface | — |

## Honest gates (full UI still renders)

| Condition | Gate (MessageBar `intent="warning"`) |
| --- | --- |
| `LOOM_SUBSCRIPTION_ID` / a Loom `*_RG` unset | "Resource inventory / Metrics / Activity log / Alerts not configured — set LOOM_SUBSCRIPTION_ID / LOOM_ADMIN_RG" |
| `LOOM_LOG_ANALYTICS_WORKSPACE_ID` unset | "Logs (Log Analytics) not configured — set LOOM_LOG_ANALYTICS_WORKSPACE_ID" |

## Backend per control

- `lib/azure/monitor-client.ts` — all six Azure REST callers + the metric catalog.
  Auth: `ChainedTokenCredential(UAMI, DefaultAzureCredential)` (same pattern as
  every other Loom ARM client). UAMI needs **Monitoring Reader** on the
  subscription/RGs and **Log Analytics Reader** on the workspace.
- BFF routes: `app/api/monitor/{inventory,health,metrics,logs,activity,alerts}/route.ts`
  — session-validated, `{ok,data,error}` JSON, honest gates.
- Front-end: `lib/components/monitor/monitor-pane.tsx` (tabbed surface) +
  `metric-chart.tsx` (dependency-free SVG sparkline).

## Required env (admin-plane bicep `apps[]` env list)

| Env var | Purpose |
| --- | --- |
| `LOOM_SUBSCRIPTION_ID` | sub for ARM/metrics/activity/health/alerts (already set) |
| `LOOM_ADMIN_RG` (+ `LOOM_ACA_RG` / `LOOM_DLZ_RG` / `LOOM_AI_SEARCH_RG` / `LOOM_KUSTO_RG` / `LOOM_APIM_RG` / `LOOM_FOUNDRY_RG` / `LOOM_AOAI_RG`) | Loom resource groups to inventory (already set) |
| `LOOM_LOG_ANALYTICS_WORKSPACE_ID` | Log Analytics workspace GUID for the Logs tab (**new** — add to apps env) |
| `LOOM_LOG_ANALYTICS_ENDPOINT` | optional; defaults to `https://api.loganalytics.azure.com` (Gov override) |

## Required role grants (UAMI)

- **Monitoring Reader** on the Loom subscription (metrics, activity log, alerts, resource health).
- **Log Analytics Reader** on the Log Analytics workspace (KQL queries).

## Verification

- Backend contract tests: `lib/azure/__tests__/monitor-client.test.ts` (12) +
  `lib/azure/__tests__/monitor-routes.test.ts` (12) — assert each Azure REST
  URL/method/body, the honest gates, 401-on-no-session, and JSON content-type.
  24/24 green.
- `pnpm build` clean; `/monitor` route prerenders.
- Live probe (minted-session browser walk) pending — not available in the
  worktree environment; to run post-merge against the deployed Console.
