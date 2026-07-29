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

It is the console's **monitoring, observability and health** surface: the place
you go to answer "is anything down, slow, failing, costing too much, or
misconfigured right now?". It is Azure-native throughout — every tab reads real
Azure REST, and none of it requires a Microsoft Fabric capacity or workspace.

**Where it lives:** `/monitor`, rendered by
`lib/components/monitor/monitor-pane.tsx`. The surface is a 13-tab strip:
**Overview · Activities · Spark · Metrics · Logs (KQL) · Diagnostics ·
Activity log · Deployed items · Refresh summary · Alerts · Cost · Security ·
Maintenance**.

> **Related but distinct:** [Health & self-audit](../admin/health.md)
> (`/admin/health`) answers "is this deployment *wired* correctly" by probing
> Loom's own dependencies. Monitor answers "how are the deployed Azure resources
> *behaving*". Uptime, availability and resource-health signals live here.

## Azure Monitor feature inventory → Loom coverage

| Azure Monitor capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| **Resource inventory** — what's deployed | ✅ Overview tab, grid of all resources across Loom RGs | ARM `GET /subscriptions/{s}/resourceGroups/{rg}/resources?api-version=2021-04-01` |
| **Resource health** — Available/Degraded/Down | ✅ Overview tab, health badge per resource + roll-up stats | `GET /subscriptions/{s}/providers/Microsoft.ResourceHealth/availabilityStatuses?api-version=2023-10-01-preview` (ARG `HealthResources` fast path) |
| **Metrics explorer** — platform metric time-series | ✅ Metrics tab, per-resource SVG charts, time-range + refresh | `GET {resourceId}/providers/microsoft.insights/metrics?metricnames=…&timespan=…&interval=…&aggregation=…&api-version=2023-10-01` |
| **Metric catalog per service** (CPU/mem/requests, Cosmos RU, AI Search QPS, ADX CPU, ADF runs, APIM, App Insights, Fabric CU, AOAI tokens) | ✅ Curated `METRIC_CATALOG` keyed by resource type, grounded in Microsoft.Insights supported-metrics | same metrics REST |
| **Logs (Log Analytics) KQL** | ✅ Logs tab, ad-hoc KQL editor + result grid + curated presets + time-range | `POST https://api.loganalytics.azure.com/v1/workspaces/{id}/query` body `{query,timespan}` |
| **Diagnostic settings** — is telemetry even being collected | ✅ Diagnostics tab, per-resource coverage audit + one-click enable (single or all) | ARM `diagnosticSettings` GET per resource + PUT to enable |
| **Activity log** — control-plane events | ✅ Activity log tab, grid (time/operation/status/RG/caller) + 24h–90d window | `GET /subscriptions/{s}/providers/Microsoft.Insights/eventtypes/management/values?api-version=2015-04-01&$filter=eventTimestamp ge … and resourceGroupName eq '{rg}'` |
| **Deployed-item telemetry** — who ran/edited/shared what | ✅ Deployed items tab (`ActivityFeedPane`) | Cosmos audit-log + comments + shares via `/api/activity` |
| **Pipeline / job run history** | ✅ Activities tab, live run feed with status + name filters | Log Analytics KQL `ADFPipelineRun` ∪ `SynapseIntegrationPipelineRuns` (`union isfuzzy=true`) |
| **Spark application analytics + tuning** | ✅ Spark tab, recent applications, per-app metric summary, tuning recommendations | Log Analytics KQL `SparkListenerEvent_CL` / `SparkMetrics_CL` / `DatabricksJobs` |
| **Scheduled-refresh overview** | ✅ Refresh summary tab, last run / status / duration / next scheduled run per item | `/api/admin/refresh-summary` — LA run history joined with real ADF trigger schedules |
| **Alerts** — list metric-alert rules | ✅ Alerts tab, grid (name/enabled/severity/RG/description) | `GET /subscriptions/{s}/providers/Microsoft.Insights/metricAlerts?api-version=2018-03-01` |
| **Alert rule authoring** (create/edit/enable/delete) | ✅ Alerts tab authoring UI over `scheduledQueryRules` — create, edit, enable/disable, delete | `PUT/PATCH/DELETE Microsoft.Insights/scheduledQueryRules` via `POST /api/monitor/alerts` |
| **Action groups** — who gets notified | ✅ Action-group builder + test notification | `PUT Microsoft.Insights/actionGroups`, `POST …/notificationsAtActionGroupResourceLevel` |
| **Cost / spend** | ✅ Cost tab — spend by service/RG/subscription/resource/region/tag, daily series, month-end forecast, anomalies | `POST Microsoft.CostManagement/query` |
| **Security posture** | ✅ Security tab — Defender for Cloud secure score, recommendations, active alerts, remediation | Microsoft Defender for Cloud REST via `defender-client` |
| **Table maintenance jobs** | ✅ Maintenance tab — lakehouse OPTIMIZE/VACUUM job state | `/api/lakehouse/maintenance` |
| **Workbooks / pinned dashboards** | ⚠️ out of scope; the metrics + logs + cost tabs cover the observable surface | — |

### Overview tab — resource inventory and resource health

The landing tab. KPI cards, a health roll-up donut and a resource-type
breakdown over every resource in the Loom resource groups, then the full
inventory grid. The health badge per resource (Available / Degraded /
Unavailable / Unknown) comes from the real
`Microsoft.ResourceHealth/availabilityStatuses` API.

Resource health is read through an Azure Resource Graph `HealthResources` query
first (one POST for the whole estate); because ARG's health coverage is
VM-leaning and the Loom estate is PaaS-heavy, an empty or unavailable ARG result
falls back to the authoritative paginated `availabilityStatuses` crawl, so
coverage never regresses. The tab paints in two stages — fast inventory first,
the slower health roll-up in parallel and non-blocking.

### Metrics tab — platform metric time-series

Pick a resource, pick a time range, and the tab renders that resource's
catalogued metrics as dependency-free SVG time-series charts
(`metric-chart.tsx`), with an explicit Refresh. Which metrics appear is driven
by `METRIC_CATALOG` in `monitor-client.ts`, keyed by ARM resource type and
grounded in the Microsoft.Insights supported-metrics list — CPU/memory/requests
for Container Apps, RU consumption for Cosmos, QPS for AI Search, CPU for ADX,
pipeline runs for ADF, token counts for AOAI, and so on. Data comes from the
real `microsoft.insights/metrics` REST; nothing here is sampled or synthesised.

### Logs (KQL) tab — ad-hoc Log Analytics queries

A KQL editor with a result grid, a time-range picker and a set of curated
presets (application errors, HTTP failures, sign-ins, pipeline failures,
exceptions). Queries are POSTed to the Log Analytics query API for the
configured workspace. If `LOOM_LOG_ANALYTICS_WORKSPACE_ID` is unset the editor
still renders and an honest MessageBar names the missing variable.

### Diagnostics tab — is telemetry actually being collected

Audits every Loom Azure resource for a diagnostic setting routing its logs and
metrics into the Loom Log Analytics workspace, and reports per-resource
coverage. Deploy-time bicep (`modules/shared/diagnostic-settings.bicep`) covers
what it deploys; this tab catches the rest — resources created at runtime, and
configuration drift. An admin can enable a missing setting on one resource or on
every supported resource that lacks one, via `POST /api/monitor/diagnostics`.

### Activity log tab — control-plane events

Azure control-plane history scoped to the Loom resource groups: deployments,
role assignments, scale operations. The grid shows time, operation, status,
resource group and caller, over a selectable 24-hour-to-90-day window, read from
the `Microsoft.Insights` management-events REST.

### Activities and Spark tabs — pipeline runs and job performance

**Activities** is the live run feed: pipeline and job run history read from Log
Analytics (`ADFPipelineRun`, optionally unioned with
`SynapseIntegrationPipelineRuns`), filterable by status and by name over a
1-to-90-day window. **Spark** covers Spark application analytics,
performance-tuning and troubleshooting — recent applications and runs, a
per-application metric summary, and tuning recommendations, from the Spark
tables in Log Analytics. Both use `union isfuzzy=true`, so a table that does not
exist in a given deployment contributes zero rows instead of failing the query.

### Deployed items and Refresh summary tabs

**Deployed items** is the Loom-side telemetry rather than the Azure side: the
Cosmos audit log plus comments and shares, surfaced through `/api/activity` as
the existing activity feed of who ran, edited or shared each deployed item.
**Refresh summary** gives one row per pipeline or dataflow with its last run,
status, duration and next scheduled run, joining real Log Analytics run history
to real ADF trigger schedules.

### Alerts tab — listing rules AND authoring them

Two ARM resource types sit behind this tab, both Azure-native:

* **`metricAlerts`** — a read-only inventory of existing threshold-on-metric
  rules scoped to the Loom resource groups (`GET /api/monitor/alerts`).
* **`scheduledQueryRules`** — the KQL-evaluated rules Loom itself manages. These
  are fully authorable from the console: create and edit (idempotent upsert),
  enable/disable in place, and delete, all through
  `POST /api/monitor/alerts` with `_action` of `upsert` / `patch` / `delete` /
  `list-scheduled`.

Notification targets are **action groups**, also managed here: build an action
group, and send it a test notification to confirm it fires before you depend on
it (`/api/monitor/action-groups`).

Authoring requires the Console UAMI to hold **Monitoring Contributor** on
`LOOM_ALERT_RG` (granted by the `monitoring.bicep` module). A missing grant
surfaces an honest 403 naming that exact role and resource group — never a
Fabric gate.

### Cost, Security and Maintenance tabs

**Cost** reads Microsoft Cost Management for the Loom deployment: total spend
broken down by service, resource group, subscription, resource, region and
cost-allocation tag, with resolved subscription display names, a daily series, a
linear month-end forecast, and daily-spend anomaly detection. **Security**
surfaces Microsoft Defender for Cloud — secure score, action-required
recommendations with their remediation, and active security alerts for the Loom
subscription. **Maintenance** tracks lakehouse table-maintenance jobs
(OPTIMIZE / VACUUM) with per-job state.

## Honest gates (full UI still renders)

Every gate below is an **Azure** configuration gate. None of them is a Fabric
gate, and no tab requires a Fabric capacity or workspace to function.

| Condition | Gate (MessageBar `intent="warning"`) |
| --- | --- |
| `LOOM_SUBSCRIPTION_ID` / a Loom `*_RG` unset | "Resource inventory / Metrics / Activity log / Alerts not configured — set LOOM_SUBSCRIPTION_ID / LOOM_ADMIN_RG" |
| `LOOM_LOG_ANALYTICS_WORKSPACE_ID` unset | "Logs (Log Analytics) not configured — set LOOM_LOG_ANALYTICS_WORKSPACE_ID" — also gates Activities, Spark and Refresh summary |
| `LOOM_LOG_ANALYTICS_RESOURCE_ID` / `LOOM_ALERT_RG` unset | Diagnostics coverage and scheduled-query alert authoring return a 503 naming the missing variable |
| Console UAMI lacks **Monitoring Contributor** on `LOOM_ALERT_RG` | 403 naming the exact role and scope to grant, for alert-rule create/edit/delete |
| Log Analytics configured but the Spark tables are empty | `ok:true` with an empty list plus a "telemetry not flowing" hint; the tab still shows native diagnostic links and the tuning reference |

## Backend per control

- `lib/azure/monitor-client.ts` — the Azure REST callers and the metric catalog:
  `listResources`, `listResourceHealth`, `fetchMetrics`, `queryLogs`,
  `queryActivityFeed`, `listActivityLog`, `listAlertRules`, `listAlertHistory`,
  `getDiagnosticsCoverage` / `enableDiagnostics`, the scheduled-query-rule
  lifecycle (`upsert` / `list` / `patch` / `delete`) and the action-group
  lifecycle (`upsertActionGroup`, `listActionGroups`,
  `sendActionGroupTestNotification`, `getLogicAppCallbackUrl`).
  `lib/azure/cost-client.ts` and `lib/azure/defender-client.ts` back the Cost
  and Security tabs.
- **Auth:** `ChainedTokenCredential(UAMI, DefaultAzureCredential)` — the same
  UAMI-first pattern as every other Loom ARM client. No connection strings, no
  keys, no user credentials.
- **BFF routes:** `app/api/monitor/{inventory,health,metrics,logs,activity,`
  `activities,spark,diagnostics,alerts,action-groups,cost,defender,`
  `logic-app-callback}/route.ts` — every one session-validated, returning
  `{ok,data,error}` JSON with honest gates.
- **Read performance:** the heavy reads are memoized behind a TTL cache with
  stale-while-revalidate and a per-call budget, so a tab revisit or Refresh
  inside the window is served from memory and no read can hang the surface.
  Failures are never cached, and a write (for example enabling a diagnostic
  setting) busts the relevant cache so the next read reflects it.
- **Front-end:** `lib/components/monitor/monitor-pane.tsx` (the 13-tab surface),
  `metric-chart.tsx` and `kql-chart.tsx` (dependency-free SVG charts),
  `monitor-action-builder.tsx` (action groups),
  `lib/panes/refresh-summary.tsx`, `lib/panes/spark-observability.tsx`.

## Required env (admin-plane bicep `apps[]` env list)

| Env var | Purpose |
| --- | --- |
| `LOOM_SUBSCRIPTION_ID` | sub for ARM/metrics/activity/health/alerts/cost |
| `LOOM_ADMIN_RG` (+ `LOOM_ACA_RG` / `LOOM_DLZ_RG` / `LOOM_AI_SEARCH_RG` / `LOOM_KUSTO_RG` / `LOOM_APIM_RG` / `LOOM_FOUNDRY_RG` / `LOOM_AOAI_RG`) | Loom resource groups to inventory |
| `LOOM_LOG_ANALYTICS_WORKSPACE_ID` | Log Analytics workspace GUID — Logs, Activities, Spark and Refresh summary |
| `LOOM_LOG_ANALYTICS_RESOURCE_ID` | full ARM id of the workspace — diagnostic-settings coverage + scheduled-query rules |
| `LOOM_ALERT_RG` | resource group the Loom-managed scheduled-query alert rules are created in (defaults to `LOOM_ADMIN_RG`) |

### Optional env — sovereign-cloud overrides and cache tuning

Every variable here has a working in-code default; none is required to run.

| Env var | Purpose |
| --- | --- |
| `LOOM_LOG_ANALYTICS_ENDPOINT` | **Gov / sovereign-cloud override** for the Log Analytics query endpoint. Defaults to the commercial `https://api.loganalytics.azure.com`; set it to the Azure Government endpoint when deploying to Gov. |
| `LOOM_ALERT_LOCATION` | region for created alert rules (defaults to `LOOM_LOCATION`) |
| `LOOM_MONITOR_INVENTORY_TTL_MS` / `LOOM_MONITOR_HEALTH_TTL_MS` / `LOOM_MONITOR_ACTIVITY_TTL_MS` / `LOOM_MONITOR_ACTIVITY_LOG_TTL_MS` / `LOOM_MONITOR_ALERTS_TTL_MS` / `LOOM_MONITOR_DIAG_TTL_MS` | cache-TTL tuning overrides for the memoized reads |

## Required role grants (UAMI)

The Console UAMI needs, on the Loom subscription unless noted:

- **Monitoring Reader** — metrics, activity log, alert listing, resource health.
- **Log Analytics Reader** on the Log Analytics workspace — KQL queries, the
  Activities feed, Spark telemetry, Refresh summary.
- **Monitoring Contributor** on `LOOM_ALERT_RG` — creating, editing, enabling
  and deleting scheduled-query alert rules and action groups. Granted by the
  `monitoring.bicep` module. Without it the Alerts tab still lists rules;
  authoring returns an honest 403 naming this role.
- **Reader** at subscription scope — the Azure Resource Graph `HealthResources`
  fast path (already granted for the RTI hub).
- **Cost Management Reader** — the Cost tab.
- **Security Reader** — the Security (Defender for Cloud) tab.

## Verification

- Backend contract tests: `lib/azure/__tests__/monitor-client.test.ts` (12) +
  `lib/azure/__tests__/monitor-routes.test.ts` (12) — assert each Azure REST
  URL/method/body, the honest gates, 401-on-no-session, and JSON content-type.
  24/24 green.
- `pnpm build` clean; `/monitor` route prerenders.
- Live probe (minted-session browser walk) pending — not available in the
  worktree environment; to run post-merge against the deployed Console.

## Load-performance hardening (audit-t117)

The Monitor surface was slow to load because each visible tab re-ran its full
Azure read on every mount/revisit and every Refresh click, dominated by the
whole-subscription resource-health crawl and the heavy ADF+Synapse activity
KQL. Three Azure-native, zero-new-RBAC fixes address this — all still work with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset (ARM + Azure Resource Graph + Log
Analytics only; no Fabric/Power BI host on any path):

1. **Server-side TTL memo** (`monitor-client.ts`, `cached()`): `listResources()`,
   `listResourceHealth()` and `queryActivityFeed()` are memoized in-process
   (inventory 60 s, health/activities 45 s; overridable via
   `LOOM_MONITOR_{INVENTORY,HEALTH,ACTIVITY}_TTL_MS`). The Promise is cached, so
   N concurrent callers share ONE Azure round-trip, and a tab-revisit / Refresh
   inside the window is served from memory. Failures are evicted (never cached),
   so the next call retries Azure. `clearMonitorCache()` is exported for tests /
   an explicit hard-refresh path.
2. **Resource-health fast path via Azure Resource Graph**: `listResourceHealth()`
   issues ONE `Microsoft.ResourceGraph/resources` POST querying the
   `HealthResources` table instead of the paginated subscription-wide
   `availabilityStatuses` crawl. Because ARG's `HealthResources` coverage is
   VM-leaning and the Loom estate is PaaS-heavy, when ARG returns no rows (or its
   provider is unavailable / RBAC-blocked) the code falls back to the
   authoritative `availabilityStatuses` crawl — no coverage regression, honest
   per `no-vaporware.md`. ARG honours the caller's RBAC; the Console UAMI's
   existing subscription-scoped **Reader** grant (`main.bicep` → `rti-hub-rbac`,
   already deployed for the RTI hub) plus **Monitoring Reader** cover it, so
   **no new role assignment** is required.
3. **Client debounce on the Activities window** (`monitor-hub.tsx`): the `days`
   dropdown is debounced 300 ms before refetching, so changing the window no
   longer fires the heavy union KQL per intermediate value; the dropdown +
   caption still reflect the selection instantly.

The deliberate two-stage Overview split (fast `/api/monitor/inventory` first
paint, slow `/api/monitor/health` in parallel and non-blocking) is preserved —
it is NOT regressed into a single blocking aggregate.

4. **TTL memo extended to the remaining tab-gated read paths** (`monitor-client.ts`):
   the three heaviest first-activation reads outside the Overview critical path
   are now memoized with the same `cached()` mechanism — `listActivityLog()`
   (paginated management-eventtypes crawl across every Loom RG;
   `LOOM_MONITOR_ACTIVITY_LOG_TTL_MS`, 45 s), `listAlertRules()` (whole-sub
   `metricAlerts` list; `LOOM_MONITOR_ALERTS_TTL_MS`, 45 s), and
   `getDiagnosticsCoverage()` (the single heaviest read — ONE
   `diagnosticSettings` GET **per resource** in the estate, N ARM round-trips;
   `LOOM_MONITOR_DIAG_TTL_MS`, 60 s). A revisit / Refresh inside the window is
   served from memory; failures are still evicted (never cached); and
   `enableDiagnostics()` calls `clearMonitorCache()` so a freshly-enabled diag
   setting shows on the next read. Same Azure-native paths (ARM only) — works
   with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset, no new RBAC, no new required env.

### Verification (audit-t117)

- `lib/azure/__tests__/monitor-client.test.ts` — 34/34 green, including the ARG
  fast path, the crawl fallback on empty/error, the TTL memo (repeat call does
  not re-hit ARM; `clearMonitorCache()` forces a refetch), failure non-caching,
  and the three newly-memoized paths (`listActivityLog`, `listAlertRules`,
  `getDiagnosticsCoverage` — the last asserting N per-resource probes run once
  and that `enableDiagnostics()` busts the coverage cache).
- `npx tsc --noEmit` — touched files clean (monitor-client.ts, monitor-pane.tsx).
- No new env var is required to run (the `*_TTL_MS` vars are optional tuning
  overrides with sane in-code defaults); no new RBAC.
- Pre-existing unrelated failure: `monitor-routes.test.ts` "POST /api/monitor/logs
  resolves a preset to KQL" fails identically on clean `origin/main` (signIns
  preset / `queryLogs` path, untouched here) — part of the known backlog.
