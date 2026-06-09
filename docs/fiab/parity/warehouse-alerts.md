# warehouse-alerts — parity with Databricks SQL Alerts (Azure Monitor on Gov)

Source UI:
- Databricks SQL Alerts editor — https://learn.microsoft.com/azure/databricks/sql/user/alerts/create
- Azure Monitor scheduled-query alert rules — https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-create-log-alert-rule

This surface implements query-result alerting for warehouse-style items
(`databricks-sql-warehouse` and the Synapse-backed `warehouse`). Per
`.claude/rules/no-fabric-dependency.md` the backend is Azure-native and chosen
purely on the sovereign boundary — there is no Fabric / Power BI dependency on
any path.

| Boundary | Backend | Real REST |
|---|---|---|
| Commercial / GCC | Databricks SQL Alerts | `POST /api/2.0/sql/queries`, `POST/GET/PATCH/DELETE /api/2.0/sql/alerts` |
| GCC-High / IL5 / DoD | Azure Monitor scheduled-query rule | `PUT/GET/DELETE Microsoft.Insights/scheduledQueryRules` (api 2023-12-01) |

Databricks is not IL5-authorized, so `isGovCloud()` gates the split. The GET
response reports `backend` so the editor adapts its fields without hard-coding
the cloud client-side.

## Databricks SQL Alerts feature inventory (grounded in Learn)

| # | Capability (real UI) | Loom coverage | Backend per control |
|---|---|---|---|
| 1 | Alerts listing page (name / status / schedule / owner) | built ✅ | GET `/api/2.0/sql/alerts` → list table |
| 2 | Status badge — OK / TRIGGERED / ERROR | built ✅ | `alert.state` → Badge color |
| 3 | Query editor (SQL the alert runs) | built ✅ | Monaco SQL editor → `POST /api/2.0/sql/queries` (`query_text` + `warehouse_id`) |
| 4 | Compute (SQL warehouse that runs the query) | built ✅ | `warehouseId` from the editor → query `warehouse_id` |
| 5 | Condition — value column + operator + threshold | built ✅ | `POST /api/2.0/sql/alerts` `condition.{op,operand.column.name,threshold.value.double_value}` |
| 6 | Operators (above / below / equal / ≥ / ≤ / ≠) | built ✅ | op dropdown → `DbxAlertOp` enum |
| 7 | Schedule (periodic, Quartz cron) | built ✅ | cron preset dropdown → `schedule.quartz_cron_schedule` |
| 8 | Time zone for the schedule | built ✅ | timezone dropdown → `timezone_id` |
| 9 | Edit an existing alert | built ✅ | `PATCH /api/2.0/sql/alerts/{id}` (update_mask) |
| 10 | Delete (trash) an alert | built ✅ | `DELETE /api/2.0/sql/alerts/{id}` |
| 11 | Notifications / subscribers | honest-gate ⚠️ | MessageBar: subscribers are managed at the Databricks workspace destinations level (the alert + condition are created here) |
| 12 | Notification templates / advanced (notify-on-OK, empty-result) | honest-gate ⚠️ | advanced template customization deferred to the workspace destination; not a stub banner — the create flow is fully functional |

## Azure Monitor scheduled-query-rule feature inventory (Gov parity)

| # | Capability | Loom coverage | Backend per control |
|---|---|---|---|
| 1 | Rule list (name / enabled / severity) | built ✅ | GET `listScheduledQueryRules()` → list table |
| 2 | Query (KQL over the Log Analytics workspace) | built ✅ | Monaco Kusto editor → rule `criteria.allOf[0].query` |
| 3 | Condition — operator + threshold (row count) | built ✅ | `upsertScheduledQueryRule` `operator` + `threshold` |
| 4 | Evaluation frequency | built ✅ | frequency dropdown → `evaluationFrequency` (ISO-8601) |
| 5 | Look-back window | built ✅ | window dropdown → `windowSize` |
| 6 | Severity (0–4) | built ✅ | severity dropdown → `severity` |
| 7 | Action group destination | built ✅ | picker from `GET /api/monitor/action-groups` → `actions.actionGroups` |
| 8 | Delete rule | built ✅ | `DELETE …/scheduledQueryRules/{name}` |

## Backend per control — summary

- All controls call the real BFF `/api/items/[type]/[id]/alerts` (GET/POST/PATCH/DELETE).
- No mock arrays, no `return []`, no `useState(MOCK)`. The post-create receipt
  surfaces the server-assigned alert id from the live response.
- Honest infra-gates only: missing `LOOM_DATABRICKS_HOSTNAME` (Comm/GCC) or
  `LOOM_LOG_ANALYTICS_RESOURCE_ID` / `LOOM_ALERT_RG` (Gov) render a Fluent
  MessageBar naming the exact env var — never a Fabric gate.

## Bicep sync

The Console UAMI already holds **Monitoring Contributor**
(`749f88ad-0bdc-4e1b-a8b6-bfb96b995e05`) on the alert resource group via
`platform/fiab/bicep/modules/admin-plane/monitoring.bicep` — this grant now
backs both the Activator wizard and the warehouse Alerts editor (Gov path).
Env (`LOOM_ALERT_RG`, `LOOM_LOG_ANALYTICS_RESOURCE_ID`, `LOOM_ALERT_LOCATION`,
`LOOM_SUBSCRIPTION_ID`, `LOOM_DATABRICKS_HOSTNAME`) is already wired in
`admin-plane/main.bicep`. No new role assignment or env var is required.

## Verification

- `npx tsc --noEmit` — clean on all touched files (zero non-Griffel errors).
- `lib/azure/__tests__/cloud-matrix.test.ts` — backend-dispatch matrix green
  (Commercial/GCC → Databricks; GCC-High/IL5/DoD → Azure Monitor).
- Live acceptance (operator, post-merge): create an alert on Commercial →
  `alertId` returned from the live Databricks response and listed by a
  subsequent GET; on Gov → a real `scheduledQueryRules` rule id in the receipt.
