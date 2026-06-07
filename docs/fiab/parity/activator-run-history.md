# activator-run-history — parity with Fabric Activator "Recent activity" / Azure Monitor alert history

Source UI:
- Fabric Activator object → **Recent activity / run history** (per-trigger fired log).
- Azure portal → **Monitor ▸ Alerts** ▸ alert instances for a scheduled-query
  (log search) alert rule: <https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-types#log-search-alerts>
- REST: `GET /subscriptions/{sub}/providers/Microsoft.AlertsManagement/alerts`
  <https://learn.microsoft.com/rest/api/monitor/alertsmanagement/alerts/get-all>

Per `.claude/rules/no-fabric-dependency.md` the Azure-native backend is the
DEFAULT: each Loom Activator rule is a `Microsoft.Insights/scheduledQueryRule`;
every firing/resolution it records is an alert INSTANCE under
`Microsoft.AlertsManagement/alerts`. The run-history grid lists those instances.
No Microsoft Fabric / Power BI workspace is required.

## Azure/Fabric feature inventory (run history surface)

| # | Capability (real UI) | Notes |
|---|----------------------|-------|
| 1 | List fired/resolved events for the object's rules, newest-first | one row per alert instance |
| 2 | Timestamp of each event (fired / last modified / resolved) | `essentials.startDateTime` / `lastModifiedDateTime` / `monitorConditionResolvedDateTime` |
| 3 | State badge — Fired vs Resolved | `essentials.monitorCondition` |
| 4 | Alert state — New / Acknowledged / Closed | `essentials.alertState` |
| 5 | Severity | `essentials.severity` (Sev0–Sev4) |
| 6 | Target resource that emitted the data | `essentials.targetResourceName` |
| 7 | Firing payload — rows matched, operator, threshold, search query | `properties.context.condition.allOf[0]` via `includeContext=true` |
| 8 | Evaluation window (start → end) | `condition.windowStartTime` / `windowEndTime` |
| 9 | Drill-in: open matching rows in Azure Monitor | `allOf[0].linkToSearchResultsUI` |
| 10 | Time range scoping (last 30 days; Azure retains instances 30 days) | `timeRange` query param, capped at 30d |
| 11 | Refresh | re-query on demand |

## Loom coverage

| # | Capability | Status | Where |
|---|------------|--------|-------|
| 1 | Fired/resolved list newest-first | ✅ | `ActivatorEditor` → Run history tab; `getActivatorHistory()` merges per-rule + sorts desc |
| 2 | Timestamps | ✅ | Timestamp column + payload dialog (fired/resolved) |
| 3 | Fired/Resolved badge | ✅ | Fluent `Badge` (danger / success) |
| 4 | Alert state | ✅ | surfaced in the payload dialog; badge falls back to state |
| 5 | Severity | ✅ | Severity column |
| 6 | Target | ✅ | Target column |
| 7 | Payload (rows matched, operator, threshold, query) | ✅ | "Rows matched" column + "View" payload dialog |
| 8 | Evaluation window | ✅ | payload dialog |
| 9 | Drill-in link to Azure Monitor | ✅ | payload dialog anchor |
| 10 | 30-day scoping | ✅ | `listAlertHistory({ days })`, capped at 30d |
| 11 | Refresh | ✅ | Refresh button → `loadHistory()` |
| — | No rules provisioned yet | ⚠️ honest note | route returns `{ ok:true, events:[], note }` |
| — | Monitoring Reader not granted | ⚠️ honest gate | route returns 503/403 naming `Monitoring Reader` at sub scope |

Zero ❌ — every inventory row is built ✅ or an honest gate ⚠️.

## Backend per control

| Control | Backend call |
|---------|--------------|
| Run history grid | `GET /api/items/activator/[id]/history` → `getActivatorHistory()` → `listAlertHistory()` → `GET {ARM}/subscriptions/{sub}/providers/Microsoft.AlertsManagement/alerts?alertRule=<name>&includeContext=true&timeRange=30d` |
| Payload dialog | same response (`properties.context` extracted into `payload`) |
| Refresh | re-issues the GET above |

RBAC: `Microsoft.AlertsManagement/alerts/read` (built-in **Monitoring Reader** at
subscription scope) — granted by `platform/fiab/bicep/modules/admin-plane/monitoring-reader-rbac.bicep`.
Sovereign clouds: ARM host selected via `LOOM_ARM_ENDPOINT` (Gov →
`management.usgovcloudapi.net`), wired in `admin-plane/main.bicep`.
