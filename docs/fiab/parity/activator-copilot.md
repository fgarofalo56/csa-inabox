# activator-copilot — parity with Azure Monitor scheduled-query alert authoring

Source UI: Azure Portal → Monitor → Alerts → **Create alert rule** (signal type
"Custom log search"), backed by `Microsoft.Insights/scheduledQueryRules`
(api-version 2023-12-01). Learn:
https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-create-log-alert-rule

The Activator Copilot is the natural-language authoring path for that same
backend — it does NOT replace the Activator editor's full rule wizard
(`ActivatorEditor` in `lib/editors/phase3-editors.tsx`), it accelerates it.
Every rule it creates is a real Azure Monitor scheduled-query alert rule. No
Microsoft Fabric / Reflex dependency (`.claude/rules/no-fabric-dependency.md`):
the default backend is `lib/azure/activator-monitor.ts → createMonitorActivatorRule`.

## Azure feature inventory (Create-alert-rule, log signal)

| Capability (portal) | Where |
|---|---|
| Pick a Log Analytics scope | Scope tab |
| Author the KQL search query | Condition tab → "Search query" |
| Choose measurement / aggregation (Count, Table rows) | Condition → Measurement |
| Operator + threshold value | Condition → Alert logic |
| **Threshold guidance from history** (portal previews the query result graph; the operator eyeballs a baseline) | Condition → preview chart |
| Evaluation frequency | Condition → "Frequency of evaluation" |
| Aggregation granularity / window | Condition → "Aggregation granularity" |
| Severity (0–4) | Details tab |
| Action group (email / SMS / webhook / Logic App) | Actions tab |
| Create the rule (ARM PUT) | Review + create |
| List existing rules | Alerts → Alert rules |
| Fired/resolved history | Alerts → Alert instances |

## Loom coverage (Activator Copilot persona)

| Inventory row | Loom | Backend per control |
|---|---|---|
| Pick LA scope | ⚠️ honest-gate — uses `LOOM_LOG_ANALYTICS_RESOURCE_ID` (alert scope) + `LOOM_LOG_ANALYTICS_WORKSPACE_ID` (query); `MonitorNotConfiguredError` names the missing var | `monitor-client.logAnalyticsResourceId()` / `logAnalyticsWorkspaceId()` |
| Author KQL | ✅ `activator_author_rule` drafts the KQL (table + filter + summarize) from NL | pure transformer (deterministic, like `buildRuleQuery`) |
| Measurement / aggregation | ✅ summarize expression in the draft (count/avg) | embedded in alert KQL |
| Operator + threshold | ✅ operator from NL; **threshold derived from real data** | `activator_create_rule` embeds `\| where <metric> <op> <threshold>` |
| **Threshold guidance from history** | ✅ `activator_suggest_threshold` runs a REAL `percentile()` KQL over the historical per-window distribution and returns p50/p95/p99 + suggestedThreshold | `monitor-client.queryLogs()` → LA query API |
| Evaluation frequency | ✅ `evaluationFrequency` (default PT5M) | `upsertScheduledQueryRule` |
| Window size | ✅ `windowSize` (default PT5M) | `upsertScheduledQueryRule` |
| Severity | ✅ `severity` (0–4, default 2) | `upsertScheduledQueryRule` |
| Action group | ✅ `actionKind`/`actionTarget` (Email / Teams-or-webhook / SMS) or `existingActionGroupId` | `upsertActionGroup` via `createMonitorActivatorRule` |
| Create the rule | ✅ `activator_create_rule` (gated on `confirm=true`) → real ARM PUT; returns ruleId + portal deep-link | `upsertScheduledQueryRule` (ARM PUT, api 2023-12-01) |
| List existing rules | ✅ `activator_list_rules` | `monitor-client.listScheduledQueryRules()` |
| Fired/resolved history | ✅ `activator_describe_history` | `activator-monitor.getActivatorHistory()` → `Microsoft.AlertsManagement/alerts` |

Zero ❌. The one ⚠️ is an honest Azure infra-gate (env var), not a Fabric gate.

## Backend per control — summary

- **Threshold suggestion** is a real KQL query (`percentile(metricVal, 95)` over
  `bin(TimeGenerated, Nm)`) against the Log Analytics workspace — no synthetic
  data. Empty table → honest heuristic estimate, flagged as such.
- **Rule creation** is a real `Microsoft.Insights/scheduledQueryRules` ARM PUT
  via `createMonitorActivatorRule`; the data-derived threshold is embedded in
  the rule's KQL so it is visible in the Azure Portal.
- **Confirm gate**: `activator_create_rule` provisions nothing unless
  `confirm=true`; the persona system prompt forbids speculative creation.

## RBAC / bicep (already deployed — no new infra in this PR)

- **Monitoring Contributor** (`749f88ad-0bdc-4e1b-a8b6-bfb96b995e05`) on the
  alert RG — `platform/fiab/bicep/modules/admin-plane/monitoring.bicep:184` —
  covers `scheduledQueryRules` + `actionGroups` write/read.
- **Log Analytics Reader** (`73c42c96-874c-492b-b04d-ab87d138a893`) on the LAW —
  `monitoring.bicep:173` — covers the `queryLogs` threshold sampling.

## Per-cloud

ARM + LA + AOAI endpoints resolve from the existing cloud helpers
(`monitor-client` ARM/LA constants honour `LOOM_LOG_ANALYTICS_ENDPOINT`;
`cloud-endpoints.cogScope()` returns the AOAI scope). `SigninLogs` is available
on Entra Commercial / GCC / GCC-High / DoD when the sign-in-logs diagnostic
setting routes to the LAW. No Fabric on any cloud.

## Verification

`lib/copilot/__tests__/activator-tools.test.ts` (7 tests, GREEN): NL→draft for
SigninLogs/Perf, real LA percentile query → p95 suggestedThreshold, no-history
heuristic, `confirm=false` provisions nothing, `confirm=true` issues the ARM PUT
with the threshold embedded in the criteria KQL, and `activator_list_rules`
lists real rules. Live acceptance: open the Activator editor → **Author rule
with Copilot** → "alert when failed logins exceed normal" → the rule appears in
Azure Monitor → Alerts → Alert rules.
