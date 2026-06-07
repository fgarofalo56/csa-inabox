# activator-action-editor — parity with Fabric Activator actions / Azure Monitor action groups

Source UI:
- **Microsoft Fabric Activator** → rule **Action** card (Email / Teams message /
  Power Automate / pipeline / notebook).
- **Azure Monitor → Alerts → Action groups** create/edit blade (Email / SMS /
  Push / Voice / Webhook / Logic App / Automation Runbook / Azure Function /
  Event Hub / ITSM receivers) and the per-action-group **Test** button.

The Azure-native default backend (per `.claude/rules/no-fabric-dependency.md`):
a Loom Activator rule's action becomes a real
`Microsoft.Insights/actionGroups` resource attached to the rule's
`scheduledQueryRule`. Built in
`apps/fiab-console/lib/editors/phase3-editors.tsx → ActivatorEditor`, backed by
`lib/azure/activator-monitor.ts` + `lib/azure/monitor-client.ts` and the routes
`app/api/items/activator/[id]/rules`, `app/api/monitor/action-groups`,
`app/api/monitor/logic-app-callback`. No Microsoft Fabric / Power BI workspace
required.

Grounded in Microsoft Learn:
- Action groups REST (create/update receivers): https://learn.microsoft.com/rest/api/monitor/action-groups
- Action groups — create test notifications: https://learn.microsoft.com/cli/azure/monitor/action-group/test-notifications
- Logic App workflow trigger `listCallbackUrl`: https://learn.microsoft.com/rest/api/logic/workflow-triggers/list-callback-url
- Scheduled query alert rules: https://learn.microsoft.com/rest/api/monitor/scheduled-query-rules

## Azure / Fabric feature inventory → Loom coverage

| Capability (source UI)                                  | Loom coverage | Backend / control |
|---------------------------------------------------------|---------------|-------------------|
| Email receiver                                          | ✅ built       | `upsertActionGroup` → `emailReceivers` (action kind **Email**) |
| SMS receiver (country code + phone)                     | ✅ built       | `upsertActionGroup` → `smsReceivers` (action kind **SMS**) |
| Webhook receiver (Teams / PagerDuty / custom HTTPS)     | ✅ built       | `upsertActionGroup` → `webhookReceivers` (Teams / Webhook / Power Automate kinds) |
| Logic App receiver (Teams card / pipeline trigger flow) | ✅ built       | `upsertActionGroup` → `logicAppReceivers`; callback URL via `getLogicAppCallbackUrl` (`listCallbackUrl`) |
| Resolve Logic App trigger callback URL from ARM         | ✅ built       | `POST /api/monitor/logic-app-callback` → `listCallbackUrl` |
| Pick / re-use an EXISTING action group                  | ✅ built       | `GET /api/monitor/action-groups` (`listActionGroups`) + "Attach existing action group" checkbox |
| Create a NEW action group from the rule's action        | ✅ built       | `createMonitorActivatorRule` → `upsertActionGroup` |
| Action group short name                                 | ✅ built       | `groupShortName` (derived from activator display name; ≤12 chars) |
| Show the resolved action-group ARM id per rule          | ✅ built       | Rules table "Action group" column + "Action groups" panel |
| **Test** notification (fire receivers without an alert) | ✅ built       | `sendActionGroupTestNotification` → `createNotifications` ("Test notification" button) |
| Fire on a real alert (scheduled-query rule)             | ✅ built       | `upsertScheduledQueryRule` (rule's KQL) → action group |
| Run a pipeline / notebook action                        | ✅ built       | action kinds **Run pipeline** / **Run notebook** (delegated handlers) |
| Voice / Push / Automation Runbook / Azure Function / Event Hub / ITSM receivers | ⚠️ honest gate | Not exposed in the editor; the four common escalation channels (Email/SMS/Webhook/Logic App) cover the Activator parity surface. Additional receiver kinds can be added to `ActionGroupInput` without schema change. |

## Sovereign-cloud notes

- `monitor-client.ts` resolves the ARM endpoint + token scope from
  `LOOM_ARM_ENDPOINT` / `LOOM_ARM_SCOPE` (Commercial default
  `https://management.azure.com`). For **GCC-High / IL5** set both to
  `https://management.usgovcloudapi.net` (+ `/.default`). Wired in
  `platform/fiab/bicep/modules/admin-plane/main.bicep`.
- Logic App callback URLs are `*.logic.azure.us` in Azure Government; resolved
  through the same gov ARM endpoint automatically.
- For IL5, a Consumption Logic App receiver is acceptable only for unclassified
  coordination (see `platform/fiab/bicep/modules/integration/approval-logicapp.bicep`).

## Honest infra-gates (not Fabric gates)

- `LOOM_SUBSCRIPTION_ID` + `LOOM_ALERT_RG` unset → 503 naming the exact vars.
- Console UAMI lacking rights → 403 "Grant the Console UAMI Monitoring
  Contributor on LOOM_ALERT_RG".
