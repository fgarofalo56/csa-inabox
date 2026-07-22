// CSA Loom — Admin Plane DEFAULT Azure Monitor alert rules + action group.
//
// Day-one OPT-OUT config (per the Wave-2 zero-manual-setup goal + no-vaporware.md):
// a fresh deploy lands a real, working default set of Azure Monitor alert rules
// in the alert resource group (LOOM_ALERT_RG == the admin RG) so the /monitor
// Alerts surface shows a populated, real default set out of the box — no manual
// authoring required. Every rule is a real Microsoft.Insights/scheduledQueryRules
// (kind LogAlert) over the deployment's Log Analytics workspace, in the EXACT
// shape lib/azure/monitor-client.ts:listScheduledQueryRules / upsertScheduledQueryRule
// read (criteria.allOf[0].{query,timeAggregation,operator,threshold,failingPeriods};
// actions.actionGroups) so they round-trip through the Loom Alerts editor and can
// be enabled / disabled / deleted there like any operator-authored rule.
//
// This is the Azure-native Activator parity (NO Microsoft Fabric / Reflex
// dependency, per no-fabric-dependency.md) — Azure Monitor scheduled-query alerts
// are the canonical Loom backend for alerting.
//
// Notifications route to a default action group that emails the admin (when an
// admin email is supplied) AND/OR every owner of the deployment subscription via
// an ARM-role receiver (Owner role) so the admin group is reached without needing
// a static Entra group OID in the action-group schema. When no email + no role
// receiver can be wired, the action group is still created (enabled, zero
// receivers) so the rules + group are present and visible day-one; the operator
// adds receivers from the /monitor Alerts editor.
//
// O1 (loom-next-level rev-2 alert standard) — THE ONE ACTION GROUP:
// every programmatic alert (S1 secret-expiry, V1 synthetic journeys, later
// DR4/C3/A11) routes through lib/azure/alert-dispatch.ts::dispatchAlert to
// THIS group (derived var LOOM_ALERT_ACTION_GROUP_ID). Email / ARM-role /
// webhook are RECEIVERS here — never parallel per-item groups or Logic Apps.
//
// SEVERITY TAG CONVENTION (O1 — the P1-page vs P3-email contract; human side
// in docs/fiab/runbooks/on-call.md):
//   loom-severity: 'P1' — page: user-facing outage / sign-in down. ARM
//                  severity 0–1. Delivered to ALL receivers incl. the on-call
//                  webhook.
//   loom-severity: 'P2' — urgent (next business hour): degraded but up. ARM
//                  severity 2. All receivers.
//   loom-severity: 'P3' — email band: informational / trending. ARM severity
//                  3–4. dispatchAlert drops webhook/Logic App receivers for P3.
// Every scheduledQueryRule below carries its loom-severity tag; new default
// rules MUST tag one of the three bands.
//
// SECURE WEBHOOK RECEIVER (O1, optional/empty-safe): pass `alertWebhookUrl`
// (@secure — e.g. from a .bicepparam getSecret() against the Loom Key Vault
// secret `loom-alert-webhook-url`) to persist a Teams-workflow / PagerDuty /
// on-call-bridge webhook receiver on the group so the default LogAlert rules
// page it too. Empty (default) = receivers unchanged. The runtime dispatch
// path does NOT require it: when the Console has LOOM_ALERT_WEBHOOK_URL
// (secretRef via observabilityConfig.alertWebhookEnabled), dispatchAlert
// mirrors the webhook into every P1/P2 notification and posts the full
// loom-alert/v1 payload directly.

targetScope = 'resourceGroup'

@description('Primary region (scheduledQueryRules + action group "location" — action group is Global, rules are regional).')
param location string

@description('Compliance tags applied to every alert resource.')
param complianceTags object

@description('ARM resource id of the Log Analytics workspace the default rules query (monitoring.outputs.lawId).')
param lawId string

@description('Container Apps name of the Console (for the per-app KQL filters). Defaults to loom-console.')
param consoleAppName string = 'loom-console'

@description('Optional admin email for the default action group. When set, an email receiver is added so the default rules notify a human day-one. Empty = no email receiver (the role receiver / operator-added receivers still apply).')
param alertEmail string = ''

@description('When true, add an ARM-role receiver targeting the subscription Owner role so the default rules reach the deployment owners (the admin group) without a static Entra group OID. Default true.')
param notifyOwners bool = true

@description('Skip provisioning the default alert set (e.g. an environment that already has it, or an operator who manages alerts entirely by hand). Default false — provisioned day-one.')
param skipDefaultAlerts bool = false

@description('OPTIONAL secure on-call webhook URL (O1). When set, a webhook receiver (name oncall-webhook, Common Alert Schema) is persisted on the default action group so the default LogAlert rules page it. Source from Key Vault (e.g. .bicepparam getSecret over secret loom-alert-webhook-url) — NEVER a literal in a params file. Empty (default) = no webhook receiver (empty-safe); the runtime dispatchAlert path can still page via the Console\'s LOOM_ALERT_WEBHOOK_URL secretRef.')
@secure()
param alertWebhookUrl string = ''

// Owner built-in role id (8e3af657-a8ff-443c-a75c-2fe8c4bcb635) — used by the
// ARM-role receiver so subscription Owners (the admin group) are notified.
var ownerRoleId = '8e3af657-a8ff-443c-a75c-2fe8c4bcb635'

var emailReceivers = empty(alertEmail) ? [] : [
  {
    name: 'admin-email'
    emailAddress: alertEmail
    useCommonAlertSchema: true
  }
]

var armRoleReceivers = notifyOwners ? [
  {
    name: 'subscription-owners'
    roleId: ownerRoleId
    useCommonAlertSchema: true
  }
] : []

// O1 — optional secure on-call webhook receiver (empty-safe; see header).
var webhookReceivers = empty(alertWebhookUrl) ? [] : [
  {
    name: 'oncall-webhook'
    serviceUri: alertWebhookUrl
    useCommonAlertSchema: true
  }
]

// ---------------------------------------------------------------------------
// Default action group — emails the admin + (optionally) notifies subscription
// Owners. Created even with zero receivers so the group exists day-one.
// ---------------------------------------------------------------------------
resource defaultActionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = if (!skipDefaultAlerts) {
  name: 'loom-default-alerts'
  location: 'Global'
  tags: complianceTags
  properties: {
    groupShortName: 'loomalerts'
    enabled: true
    emailReceivers: emailReceivers
    armRoleReceivers: armRoleReceivers
    webhookReceivers: webhookReceivers
  }
}

// The action group id to wire into every default rule (empty when skipped).
var actionGroupIds = skipDefaultAlerts ? [] : [ defaultActionGroup.id ]

// ---------------------------------------------------------------------------
// 1) Console availability — fires when the Console emits NO logs in the window
//    (a healthy Console logs continuously). Heartbeat-absence over the
//    Container Apps console-log table.
// ---------------------------------------------------------------------------
resource alertConsoleAvailability 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = if (!skipDefaultAlerts) {
  name: 'loom-console-availability'
  location: location
  // O1 severity tag convention: heartbeat absence = possible outage → P1 (page).
  tags: union(complianceTags, { 'loom-severity': 'P1' })
  kind: 'LogAlert'
  properties: {
    displayName: 'loom-console-availability'
    description: 'CSA Loom default — fires when the Console container app emits no logs in the evaluation window (heartbeat absence => possible outage). Azure-native Activator parity; no Microsoft Fabric required.'
    severity: 1
    enabled: true
    // The default rules query the Container Apps custom tables
    // (ContainerAppConsoleLogs_CL / ContainerAppSystemLogs_CL), which are created
    // by the platform only when the Console first logs — they do NOT exist in a
    // fresh Log Analytics workspace. Azure Government validates the KQL against
    // the workspace schema at create time, so a from-scratch deploy into
    // usgovvirginia (2026-07-10) failed these rules ("failed to resolve table or
    // column expression ... ContainerAppConsoleLogs_CL"). skipQueryValidation
    // lets the rule deploy against a not-yet-existent table; it starts evaluating
    // correctly once the table materializes. Cloud-neutral — this is a latent
    // from-scratch failure in Commercial too (masked only when apps have already
    // logged). Pre-creating the _CL tables was rejected as the fix because their
    // schema/lifecycle is owned by the Container Apps diagnostic pipeline.
    skipQueryValidation: true
    scopes: [ lawId ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'ContainerAppConsoleLogs_CL\n| where ContainerAppName_s == "${consoleAppName}"\n| summarize logCount = count()\n| where logCount == 0'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: actionGroupIds
    }
  }
}

// ---------------------------------------------------------------------------
// 2) Console 5xx errors — fires when the Console logs server-error (5xx /
//    HTTP 50x / "error"-level) lines above a low threshold in the window.
// ---------------------------------------------------------------------------
resource alertConsole5xx 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = if (!skipDefaultAlerts) {
  name: 'loom-console-5xx-errors'
  location: location
  // O1 severity tag convention: elevated 5xx = degraded but up → P2 (urgent).
  tags: union(complianceTags, { 'loom-severity': 'P2' })
  kind: 'LogAlert'
  properties: {
    displayName: 'loom-console-5xx-errors'
    description: 'CSA Loom default — fires when the Console emits server-error (5xx) log lines above threshold in the window. Azure-native Activator parity; no Microsoft Fabric required.'
    severity: 2
    enabled: true
    // See loom-console-availability: the _CL tables don't exist in a fresh LAW,
    // so skip create-time query validation (Gov enforces it). Cloud-neutral.
    skipQueryValidation: true
    scopes: [ lawId ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'ContainerAppConsoleLogs_CL\n| where ContainerAppName_s == "${consoleAppName}"\n| where Log_s has_cs "Internal Server Error" or Log_s has " 500 " or Log_s has " 502 " or Log_s has " 503 " or Log_s has " 504 " or Log_s has "level=error"\n| summarize errorCount = count()\n| where errorCount > 10'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: actionGroupIds
    }
  }
}

// ---------------------------------------------------------------------------
// 3) Replica restarts / revision provisioning errors — fires on Container Apps
//    system-log restart / crash / provisioning-error signals for the Console.
// ---------------------------------------------------------------------------
resource alertReplicaRestarts 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = if (!skipDefaultAlerts) {
  name: 'loom-console-replica-restarts'
  location: location
  // O1 severity tag convention: crash-loop signals = degraded but self-healing → P2.
  tags: union(complianceTags, { 'loom-severity': 'P2' })
  kind: 'LogAlert'
  properties: {
    displayName: 'loom-console-replica-restarts'
    description: 'CSA Loom default — fires on Container Apps system-log replica restart / container-crash / revision provisioning-error signals for the Console (crash-loop detection). Azure-native Activator parity; no Microsoft Fabric required.'
    severity: 2
    enabled: true
    // See loom-console-availability: the _CL tables don't exist in a fresh LAW,
    // so skip create-time query validation (Gov enforces it). Cloud-neutral.
    skipQueryValidation: true
    scopes: [ lawId ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'ContainerAppSystemLogs_CL\n| where ContainerAppName_s == "${consoleAppName}"\n| where Log_s has_any ("ContainerCrashing", "ContainerCrashed", "Error provisioning revision", "restart", "Deployment Progress Deadline Exceeded")\n| summarize restartSignals = count()\n| where restartSignals > 3'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: actionGroupIds
    }
  }
}

@description('Resource id of the default action group (empty when skipped).')
output actionGroupId string = skipDefaultAlerts ? '' : defaultActionGroup.id

@description('Names of the default alert rules provisioned (for the post-deploy receipt).')
output ruleNames array = skipDefaultAlerts ? [] : [
  'loom-console-availability'
  'loom-console-5xx-errors'
  'loom-console-replica-restarts'
]

// NOTE (O1): intentionally NO output derived from alertWebhookUrl — even a
// boolean trips the outputs-should-not-contain-secrets linter. Verify the
// receiver live instead: az monitor action-group show -n loom-default-alerts
// --query 'webhookReceivers[].name' (expects ['oncall-webhook'] when wired).
