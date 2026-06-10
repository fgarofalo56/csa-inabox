# monitor-alert-rules — parity with Azure Monitor "Alerts" (alert rule authoring)

Source UI: Azure portal → Monitor → Alerts → Alert rules → **Create / Edit alert rule**
(`https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-create-log-alert-rule`).

CSA Loom surface: **Monitor pane → Alerts tab** (`lib/components/monitor/monitor-pane.tsx`
`AlertsTab`), editor `lib/monitor/monitor-alert-editor.tsx`, condition/schedule builder
`lib/monitor/monitor-conditions-builder.tsx`, BFF `app/api/monitor/alerts/route.ts`.

Azure-native only — no Microsoft Fabric / Power BI dependency (per
`.claude/rules/no-fabric-dependency.md`). The rules are real
`Microsoft.Insights/scheduledQueryRules` (API `2023-12-01`). This is the Azure-native
parity for a Fabric RTI Activator/Reflex alert trigger.

## Azure feature inventory (Create/Edit log alert rule)

| # | Azure capability | Where in the portal |
|---|------------------|---------------------|
| 1 | Scope — pick the Log Analytics workspace the query runs against | Scope tab |
| 2 | Condition — author the KQL log query | Condition tab → query editor |
| 3 | Measurement — aggregation (Count of result rows) | Condition tab |
| 4 | Alert logic — operator (>, ≥, <, ≤, =) + threshold | Condition tab |
| 5 | Evaluation — frequency (how often the query runs) | Condition tab → Evaluation |
| 6 | Evaluation — look-back window / time period (≥ frequency) | Condition tab → Evaluation |
| 7 | Actions — attach an Action Group (email/SMS/webhook/Logic App) | Actions tab |
| 8 | Details — severity (0 Critical … 4 Verbose) | Details tab |
| 9 | Details — rule name + description | Details tab |
| 10 | Enable/disable the rule | Details / rule list toggle |
| 11 | Auto-resolve / auto-mitigate when the condition clears | Details tab |
| 12 | List existing rules; edit an existing rule in place | Alert rules grid |
| 13 | Delete a rule | Alert rules grid → Delete |

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Scope = Log Analytics workspace | ⚠️ honest-gate | Defaults to `LOOM_LOG_ANALYTICS_RESOURCE_ID`; if unset, the BFF returns a 503 gate naming the env var. No per-rule scope picker (single Loom LAW), matching the Loom deployment model. |
| 2 | KQL query authoring | ✅ | Monaco editor, `language="kusto"`, in the Query tab. |
| 3 | Count aggregation | ✅ | `timeAggregation: 'Count'` over the result row count (server-set). UI explains it on the Condition tab. |
| 4 | Operator + threshold | ✅ | `MonitorConditionsBuilder` Condition section. Operators: GreaterThan / GreaterThanOrEqual / LessThan / LessThanOrEqual / Equal (the set the ARM schema accepts). |
| 5 | Evaluation frequency | ✅ | Schedule tab dropdown (PT5M … P1D). |
| 6 | Look-back window | ✅ | Schedule tab dropdown; client + server validate window ≥ frequency. |
| 7 | Action group | ✅ | Destination tab picker, loaded from `GET /api/monitor/action-groups` (real `Microsoft.Insights/actionGroups`). "None — record to Azure Monitor only" is allowed. Reload button. |
| 8 | Severity | ✅ | Schedule tab dropdown (0–4). |
| 9 | Name + description | ✅ | Editor header fields. Name is the rule identity; disabled in edit mode. |
| 10 | Enable/disable in place | ✅ | Grid row toggle → `POST { _action:'patch', name, enabled }` → ARM PATCH `properties.enabled` (never a full PUT, so query/criteria/action groups are preserved). |
| 11 | Auto-mitigate | ✅ | Server sets `autoMitigate: true` (fires once, resolves when the condition clears) — parity with the portal default. |
| 12 | List + edit | ✅ | Scheduled-rule grid (`POST { _action:'list-scheduled' }`); Edit icon opens the editor pre-populated; same idempotent PUT saves. |
| 13 | Delete | ✅ | Grid Delete icon → confirmation dialog → `POST { _action:'delete', name }` → ARM DELETE (404 treated as success). |

Metric-alert rules (`Microsoft.Insights/metricAlerts`) remain a **read-only inventory grid**
in the same tab — they are a different ARM resource type and are not authored here
(the portal authors them via a separate metric-condition wizard). They are clearly
labeled "read-only inventory".

Zero ❌, zero stub banners. One honest infra-gate (row 1) per `no-vaporware.md`.

## Backend per control

| Control | Backend call |
|---------|--------------|
| List scheduled rules | `listScheduledQueryRules()` → ARM GET `.../scheduledQueryRules?api-version=2023-12-01` |
| Create / edit rule | `upsertScheduledQueryRule()` → ARM PUT (idempotent by name) |
| Enable/disable | `patchScheduledQueryRule()` → ARM PATCH `{ properties: { enabled } }` |
| Delete | `deleteScheduledQueryRule()` → ARM DELETE |
| Action group picker | `listActionGroups()` via `GET /api/monitor/action-groups` |
| Metric-alert inventory | `listAlertRules()` → ARM GET `.../metricAlerts` |

## Per-cloud

| Cloud | Path | Notes |
|-------|------|-------|
| Commercial | `scheduledQueryRules` 2023-12-01 (GA) | Action groups are Global-region resources. |
| Azure Government (GCC-High) | Same API via `armBase()` / `cloud-endpoints.ts` | This is the intended Government path (Databricks SQL Alerts parity where Databricks is not authorized). |
| DoD (IL5) | Same | Sovereign ARM host; no Fabric / Databricks dependency. |

## RBAC / bicep (already in place — no change in this PR)

`platform/fiab/bicep/modules/admin-plane/monitoring.bicep` grants the Console UAMI
**Monitoring Contributor** (`749f88ad-0bdc-4e1b-a8b6-bfb96b995e05`) on the alert RG —
covers `scheduledQueryRules/write|delete` + `actionGroups/write`. Env vars
`LOOM_ALERT_RG`, `LOOM_ALERT_LOCATION`, and `LOOM_LOG_ANALYTICS_RESOURCE_ID` are wired
in `admin-plane/main.bicep` (lines ~1409, 1556, 1560).

## Verification (this PR)

- `tsc --noEmit` clean for the touched files (`monitor-pane.tsx`, `monitor-alert-editor.tsx`,
  `monitor-conditions-builder.tsx`, `api/monitor/alerts/route.ts`, `monitor-routes.test.ts`).
- Vitest: `lib/azure/__tests__/monitor-routes.test.ts` covers list-scheduled / upsert (PUT body
  asserted) / patch (PATCH body asserted) / delete (DELETE) / 400 validation / 503 honest-gate /
  401 unauth.
