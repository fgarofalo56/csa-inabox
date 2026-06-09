# admin-usage — parity with Fabric/Power BI Admin "Usage metrics" + "Feature usage and adoption"

Source UI:
- Power BI / Fabric Admin portal → **Usage metrics** (per-workspace + tenant) — https://learn.microsoft.com/power-bi/collaborate-share/service-modern-usage-metrics
- Fabric Admin monitoring → **Feature usage and adoption** report — https://learn.microsoft.com/fabric/admin/feature-usage-adoption
- Azure Monitor **Application Insights → Usage → Users / Events** — https://learn.microsoft.com/azure/azure-monitor/app/usage

CSA Loom surface: `/admin/usage` (F21). No Microsoft Fabric / Power BI workspace
required — every metric comes from **Azure Log Analytics** (the Loom Console's
own `AppRequests` telemetry) + **Cosmos** (workspaces / items / audit-log). The
optional "Open analytics" embed is the only Fabric-family touchpoint and it is
strictly opt-in (per `.claude/rules/no-fabric-dependency.md`).

## Fabric/Azure feature inventory

| # | Capability (real Fabric / Azure UI) | Notes |
|---|---|---|
| 1 | Active users trend (daily/weekly/monthly active users) | Usage metrics "Users" line + App Insights Users |
| 2 | Feature / report usage breakdown (events + distinct users) | Feature usage & adoption; App Insights Events |
| 3 | Top content / most-viewed items | Usage metrics "Views by report" |
| 4 | Tenant inventory (workspaces, items, item types) | Admin portal workspace + item counts |
| 5 | Activity-over-time (audited operations) | Fabric activity events / audit log |
| 6 | Time-window selector (7 / 14 / 30 / 90 days) | Usage metrics date range |
| 7 | Drill-through filter (pick a feature → see its content) | Usage metrics cross-filter on click |
| 8 | Open the full curated report (Power BI Embedded) | "Open in Power BI" |
| 9 | Government-cloud analytics surface (no Power BI) | Managed Grafana dashboard (GCC-High / IL5) |
| 10 | Sortable / resizable / filterable detail grid | Usage metrics table |

## Loom coverage

| # | Capability | State | How |
|---|---|---|---|
| 1 | Active-users trend | ✅ built | `usage-client.fetchActiveUsersTrend` → KQL `AppRequests | summarize dau=dcount(UserId) by bin(TimeGenerated,1d)`; daily DAU sparkline + peak-DAU KPI |
| 2 | Feature adoption (events + users) | ✅ built | `fetchFeatureAdoption` → KQL route-prefix `extract` on `Url`; clickable bars (events blue / users green) |
| 3 | Top items | ✅ built | Cosmos audit-by-item ⊕ LA `fetchTopItemsFromLa` (events per `/items/<type>/<id>`), merged + enriched, in `LoomDataTable` |
| 4 | Tenant inventory | ✅ built | Cosmos workspaces/items aggregate (KPI cards + by-type / by-workspace bars) |
| 5 | Activity-over-time | ✅ built | Cosmos audit-log daily sparkline |
| 6 | Time-window selector | ✅ built | 7/14/30d button group → `?days=N` re-fetch (route clamps 1–90) |
| 7 | Drill-through filter | ✅ built | Feature Dropdown + click-a-bar → `?feature=X`; restricts feature adoption + top-items table live |
| 8 | Power BI Embedded report | ⚠️ honest-gate (opt-in) | `/api/admin/usage/embed` → `generateReportEmbedToken` → `PowerBIEmbedFrame`; 503 MessageBar names `LOOM_USAGE_PBI_*` when unset |
| 9 | Gov analytics (Managed Grafana) | ⚠️ honest-gate (opt-in) | Same route → `{ kind:'grafana', iframeUrl }` kiosk iframe over `LOOM_GRAFANA_ENDPOINT` + `LOOM_GRAFANA_USAGE_DASHBOARD_UID`; **never the old promotional EmptyState** |
| 10 | Sortable/resizable/filterable grid | ✅ built | `LoomDataTable` (pre-existing) |

When `LOOM_LOG_ANALYTICS_WORKSPACE_ID` is unset the active-users + feature
sections render an honest info `MessageBar` naming the env var + the
`Log Analytics Reader` grant — the Cosmos inventory + activity sections stay
live. No `EmptyState` upsell anywhere.

## Backend per control

| Control | Backend |
|---|---|
| Active-users sparkline | `queryLogs(kql,'P{days}D')` → Log Analytics REST `POST {LA_ENDPOINT}/v1/workspaces/{id}/query` (UAMI, Log Analytics Reader) |
| Feature-adoption bars | same Log Analytics query API, route-prefix KQL |
| Top-items table | Cosmos `auditLogContainer` + Log Analytics item-path KQL, merged in the BFF |
| Tenant inventory / activity | Cosmos `workspacesContainer` / `itemsContainer` / `auditLogContainer` |
| Window + feature filters | `GET /api/admin/usage?days=N&feature=X` (Promise.allSettled; LA failure → `laConfigured:false`) |
| "Open analytics" (Commercial/GCC) | `GET /api/admin/usage/embed` → Power BI REST `GenerateToken` |
| "Open analytics" (GCC-High/IL5) | `GET /api/admin/usage/embed` → Managed Grafana kiosk iframe URL |

## Per-cloud matrix

| Cloud | Log Analytics host | Active users / adoption / top items | Embed |
|---|---|---|---|
| Commercial / GCC | `api.loganalytics.azure.com` | Real `AppRequests` KQL | Power BI Embedded (opt-in `loomUsageReportKind=powerbi`) or native charts only |
| GCC-High / IL5 | `api.loganalytics.us` | Real `AppRequests` KQL | Managed Grafana kiosk (opt-in `loomUsageReportKind=grafana`); never an EmptyState |

## Bicep sync

`platform/fiab/bicep/modules/admin-plane/main.bicep`:
- params `loomUsageReportKind` (`'' | 'powerbi' | 'grafana'`), `loomUsagePbiWorkspaceId`, `loomUsagePbiReportId`, `loomGrafanaUsageDashboardUid`
- env wiring: `LOOM_USAGE_REPORT_KIND`, `LOOM_USAGE_PBI_WORKSPACE_ID`, `LOOM_USAGE_PBI_REPORT_ID`, `LOOM_GRAFANA_USAGE_DASHBOARD_UID` (+ `LOOM_GRAFANA_ENDPOINT` when the usage embed uses Grafana and Govern doesn't)
- RBAC already deployed: `monitoring-reader-rbac.bicep` (Monitoring Reader, sub), `monitoring.bicep` (Log Analytics Reader, LAW), `grafana-rbac.bicep` (Grafana Viewer). `LOOM_LOG_ANALYTICS_WORKSPACE_ID` + `LOOM_LOG_ANALYTICS_ENDPOINT` already wired.
- `az bicep build` of `main.bicep` passes (exit 0).
