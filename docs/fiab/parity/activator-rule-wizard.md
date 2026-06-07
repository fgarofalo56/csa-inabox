# activator-rule-wizard — parity with Azure Monitor "Create log alert rule" (and Fabric Activator rules)

Source UI:
- Azure portal → Monitor → Alerts → Create → Alert rule (log search / scheduled query):
  https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-create-log-alert-rule
- Fabric Activator rule (object-property condition → action), mapped 1:1 onto the
  Azure-native Azure Monitor `Microsoft.Insights/scheduledQueryRules` backend per
  `.claude/rules/no-fabric-dependency.md`. No Microsoft Fabric workspace required.

The Loom Activator editor (`ActivatorEditor`, `lib/editors/phase3-editors.tsx`)
"New rule" wizard creates a real scheduled-query alert rule + action group.

## Azure Monitor "Create log alert rule" feature inventory

| # | Capability (portal) | Notes |
|---|---------------------|-------|
| 1 | Scope / data source | Resource the query runs against (a Log Analytics workspace). |
| 2 | Condition — log query (KQL) | Free KQL the rule evaluates. |
| 3 | Condition — measurement / aggregation | Count of rows / metric measurement. |
| 4 | Alert logic — operator + threshold | GreaterThan / LessThan / … + numeric threshold. |
| 5 | Evaluation — frequency | How often the query runs (ISO-8601, e.g. PT5M). |
| 6 | Evaluation — window (lookback) | Time range the query spans (ISO-8601, ≥ frequency). |
| 7 | Actions — action group | Email / webhook / etc. fired when the rule alerts. |
| 8 | Severity | 0 (Critical) – 4 (Verbose). |
| 9 | Rule name / description | Identity of the rule. |
| 10| Enable / disable | Stop or start evaluation. |
| 11| Test / preview | Run the query now to see if it would fire. |

## Loom coverage

| # | Capability | Status | Where |
|---|------------|--------|-------|
| 1 | Data source picker (KQL query **or** Event Hub) | built ✅ | `sourceType` Select; Event Hub mode uses `EventHubsNamespaceTree`, derives the LA table `<hub>_CL`, and shows an honest `intent="warning"` MessageBar naming the DCR / ADX data-connection requirement. |
| 2 | KQL query editor | built ✅ | `MonacoTextarea language="kql"`; verbatim query wins (`buildRuleQuery`). |
| 3 | Measurement (Count) | built ✅ | `upsertScheduledQueryRule` sets `timeAggregation: 'Count'`; fires when query returns ≥ 1 row. |
| 4 | Operator + threshold | built ✅ | Condition builder (property/operator/value) composes KQL; ARM body defaults `operator: GreaterThan`, `threshold: 0`. |
| 5 | Evaluation frequency | built ✅ | `evalFreq` Select (PT1M…PT6H) → `evaluationFrequency`. |
| 6 | Window size | built ✅ | `winSize` Select (PT5M…P1D) → `windowSize`. |
| 7 | Action group | built ✅ | Action picker (Email/Teams/Webhook/Pipeline/Notebook/Power Automate); Email targets are turned into an `upsertActionGroup` with email receivers. |
| 8 | Severity | built ✅ | `severity` Select (0–4) → ARM `severity`. |
| 9 | Rule name | built ✅ | `ruleName` Input → ARM `displayName`. |
| 10| Enable / disable (Start / Stop) | built ✅ | Ribbon Start/Stop on the reflex. |
| 11| Test / preview ("Trigger") | built ✅ | Per-row "Trigger" runs the rule's KQL now (`triggerMonitorActivatorRule` → `queryLogs`); inline MessageBar reports rows + FIRED. |

Zero ❌. The only non-functional state is the honest infra-gate: when
`LOOM_LOG_ANALYTICS_RESOURCE_ID` / `LOOM_ALERT_RG` are unset, or the Console
UAMI lacks Monitoring Contributor, the route returns a 503/403 with the exact
env var / role to set (`monitorGate`) — and the full wizard still renders.

## Backend per control

| Control | Backend call |
|---------|--------------|
| Add rule (create) | `POST /api/items/activator/[id]/rules` → `createMonitorActivatorRule` → `upsertActionGroup` + `upsertScheduledQueryRule` (ARM `PUT Microsoft.Insights/scheduledQueryRules@2023-12-01`). |
| Trigger | `POST …/rules?trigger=<id>` → `triggerMonitorActivatorRule` → `queryLogs` (Log Analytics query API). |
| Start / Stop | `POST …/[id]/start|stop`. |
| Event Hub picker | `EventHubsNamespaceTree` → live Event Hubs ARM. |

## Sovereign-cloud notes

`monitor-client.ts` resolves the ARM host from `AZURE_CLOUD` / `LOOM_ARM_ENDPOINT`
(Commercial `management.azure.com`, GCC-High/IL5 `management.usgovcloudapi.net`).
`LOOM_ALERT_LOCATION` (defaulted to the deployment region in `main.bicep`) is
stamped into the rule + action-group ARM bodies so Gov deployments do not fall
back to the Commercial `eastus` default. API version `2023-12-01` is GA in
Commercial + Azure Government + DoD.

## Bicep + RBAC

- `platform/fiab/bicep/modules/admin-plane/monitoring.bicep`: grants the Console
  UAMI **Monitoring Contributor** (`749f88ad-0bdc-4e1b-a8b6-bfb96b995e05`) on the
  admin RG so it can PUT scheduledQueryRules + action groups.
- `platform/fiab/bicep/modules/admin-plane/main.bicep`: `LOOM_ALERT_RG` defaults
  to the admin RG (matching the grant scope); `LOOM_ALERT_LOCATION` = deployment
  region.

## Verification

With `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET:
1. Open an Activator → New rule → KQL source, query `Heartbeat | where TimeGenerated > ago(5m)`, frequency PT5M, window PT5M, severity 2 → Add.
2. POST returns `{ ok: true, rule: { id, azureRuleName, backend: 'azure-monitor', evaluationFrequency, windowSize, severity } }`; the ARM resource `/subscriptions/<sub>/resourceGroups/<LOOM_ALERT_RG>/providers/Microsoft.Insights/scheduledQueryRules/<name>` exists.
3. Click Trigger — returns `{ ok: true, fired: true, count: N }` when the KQL returns rows (force the condition by querying a table with current data).

Receipt = the scheduledQueryRule ARM id (`rule.azureRuleName`) + the trigger
response `{ fired: true, count }`.
