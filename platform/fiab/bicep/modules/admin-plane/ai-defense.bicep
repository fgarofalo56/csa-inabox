// CSA Loom — Defender for AI Threat Protection workaround (PRP-13)
//
// Native Defender for Cloud AI Threat Protection is Commercial-only
// as of 2026-05-22. In Gov boundaries we substitute a Sentinel-based
// equivalent: Scheduled Analytics Rules + an automation rule that
// fires a Logic App to enrich + notify.
//
// The Scheduled Rules themselves are defined in monitoring.bicep
// (gated on !defenderForAIEnabled). This module adds the Logic App
// playbook + the automation rule that connects them.
//
// TRIGGER REWORK (2026-07-11): the playbook now uses a Microsoft Sentinel
// **Incident** trigger (azuresentinel managed connector, managed-identity
// auth) instead of the old HTTP `Request` trigger. Sentinel's RunPlaybook
// automation action only binds to a playbook whose trigger is the Sentinel
// Incident trigger — the HTTP trigger failed preflight with
// `Playbook resource is not using Microsoft Sentinel Incident trigger`
// (live usgovvirginia). With the incident trigger + a fully-declarative
// managed-identity API connection, the automation rule is valid, so
// `sentinelPlaybookAutomationEnabled` now defaults to true.
//
// Grounded in Microsoft Learn:
//   Sentinel incident-trigger playbooks (Consumption):
//     https://learn.microsoft.com/azure/sentinel/automation/create-playbooks
//   Authenticate playbooks with a managed identity + azuresentinel connection:
//     https://learn.microsoft.com/azure/sentinel/automation/authenticate-playbooks-to-sentinel
//   ARM managed-identity API connection (parameterValueType 'Alternative'):
//     https://learn.microsoft.com/azure/logic-apps/authenticate-with-managed-identity#arm-template-for-api-connections-and-managed-identities
//   Automation rule RunPlaybook permission (Azure Security Insights SP needs
//   'Microsoft Sentinel Automation Contributor' on the playbook RG — granted
//   in csa-loom-post-deploy-bootstrap.yml):
//     https://learn.microsoft.com/azure/sentinel/automation/run-playbooks#prerequisites

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Defender for AI native availability')
param defenderForAIEnabled bool

@description('Sentinel workspace ID (Log Analytics workspace ID). Reserved for v3.x — current Defender for AI wiring resolves the workspace via lawName; the explicit ID will be used once the diagnostic-settings module switches to resourceId binding.')
#disable-next-line no-unused-params
param lawId string

@description('Sentinel workspace name')
param lawName string

resource law 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = {
  name: lawName
}

@description('Teams / email destination for security alerts (Key Vault secret reference for the Logic App)')
param notificationWebhookKvRef string

@description('Compliance tags')
param complianceTags object

@description('Wire the Sentinel automation rule that auto-runs the alert playbook on AI-rule incidents. As of 2026-07-11 the playbook exposes a Microsoft Sentinel *Incident* trigger (azuresentinel managed connector, managed-identity auth), so the RunPlaybook binding is valid and this DEFAULTS to true. The only runtime prerequisite is the Azure Security Insights SP holding "Microsoft Sentinel Automation Contributor" on this RG — granted durably by csa-loom-post-deploy-bootstrap.yml. Set to false only to disable the auto-response wiring (the analytic detection rules + the notification playbook still deploy either way). Gov-only path: Commercial (defenderForAIEnabled=true) never deploys any of this.')
param sentinelPlaybookAutomationEnabled bool = true

// Built-in role: Microsoft Sentinel Responder (read incident data / operate the
// incident trigger). Granted to the playbook's system-assigned identity on the
// workspace so the azuresentinel managed-identity connection can read incidents.
// https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#microsoft-sentinel-responder
var sentinelResponderRoleId = '3e150937-b8fe-4cfb-8069-0eaf05ecd056'

// =====================================================================
// azuresentinel API connection (managed identity — no stored creds)
// =====================================================================
// Fully declarative managed-identity connection: parameterValueType
// 'Alternative' is the ARM-template form for a single-auth managed connector
// authenticated by the consuming Logic App's managed identity (Learn ref
// above). No portal consent / OAuth prompt is required for MI auth — the
// workflow's $connections binding sets authentication.type =
// ManagedServiceIdentity and the runtime uses the playbook's system-assigned
// identity (granted Sentinel Responder below).
// BCP187/BCP037: `kind` and `parameterValueType` are valid on managed API
// connections (per the ARM managed-identity connection Learn ref) but are not
// in Bicep's type model for Microsoft.Web/connections — suppress the noise.
resource sentinelConnection 'Microsoft.Web/connections@2016-06-01' = if (!defenderForAIEnabled) {
  name: 'azuresentinel-loom-ai-${location}'
  location: location
  tags: complianceTags
  #disable-next-line BCP187
  kind: 'V1'
  properties: {
    displayName: 'Microsoft Sentinel — Loom AI Alerts (managed identity)'
    api: {
      name: 'azuresentinel'
      id: subscriptionResourceId('Microsoft.Web/locations/managedApis', location, 'azuresentinel')
      type: 'Microsoft.Web/locations/managedApis'
    }
    // Single-auth managed-identity connection (no parameterValues / OAuth).
    #disable-next-line BCP037
    parameterValueType: 'Alternative'
  }
}

// =====================================================================
// Logic App playbook — Sentinel incident trigger → enrich + Teams post
// =====================================================================

resource playbook 'Microsoft.Logic/workflows@2019-05-01' = if (!defenderForAIEnabled) {
  name: 'la-csa-loom-ai-alert-${location}'
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    state: 'Enabled'
    // Wire the azuresentinel connection into the workflow's $connections
    // parameter, authenticated by this playbook's system-assigned identity.
    parameters: {
      '$connections': {
        value: {
          azuresentinel: {
            id: subscriptionResourceId('Microsoft.Web/locations/managedApis', location, 'azuresentinel')
            connectionId: sentinelConnection.id
            connectionName: sentinelConnection.name
            connectionProperties: {
              authentication: {
                type: 'ManagedServiceIdentity'
              }
            }
          }
        }
      }
      TeamsWebhookUrl: {
        // Resolved from Key Vault by the LA's managed identity at runtime
        value: notificationWebhookKvRef
      }
    }
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      parameters: {
        '$connections': {
          defaultValue: {}
          type: 'Object'
        }
        // Declared here so the resource-level parameters block above can supply
        // its value; the PostToTeams action references @parameters('TeamsWebhookUrl').
        // Without this declaration ARM rejects the workflow with InvalidTemplate
        // ("workflow parameters 'TeamsWebhookUrl' are not valid; not declared in
        // the definition"). Holds the Teams incoming-webhook URL (a KV reference).
        TeamsWebhookUrl: {
          defaultValue: ''
          type: 'String'
        }
      }
      triggers: {
        // Microsoft Sentinel Incident trigger (ApiConnectionWebhook against the
        // azuresentinel connector). This is the trigger the RunPlaybook automation
        // action binds to. On each new AI-rule incident Sentinel POSTs the incident
        // object (its properties + related analytic-rule ids + alerts/entities) here.
        When_Azure_Sentinel_incident_creation_rule_was_triggered: {
          type: 'ApiConnectionWebhook'
          inputs: {
            body: {
              callback_url: '@{listCallbackUrl()}'
            }
            host: {
              connection: {
                name: '@parameters(\'$connections\')[\'azuresentinel\'][\'connectionId\']'
              }
            }
            path: '/incident-creation'
          }
        }
      }
      actions: {
        // 1. Project the incident fields we care about for the Teams card.
        //    Incident schema: triggerBody().object.properties.{title,severity,
        //    description,incidentNumber,incidentUrl,relatedAnalyticRuleIds}.
        ComposeContext: {
          type: 'Compose'
          inputs: {
            incident: '@triggerBody()?[\'object\']?[\'properties\']?[\'title\']'
            severity: '@triggerBody()?[\'object\']?[\'properties\']?[\'severity\']'
            description: '@triggerBody()?[\'object\']?[\'properties\']?[\'description\']'
            incidentNumber: '@triggerBody()?[\'object\']?[\'properties\']?[\'incidentNumber\']'
            incidentUrl: '@triggerBody()?[\'object\']?[\'properties\']?[\'incidentUrl\']'
            when: '@utcNow()'
          }
        }
        // 2. Post adaptive card to Teams via incoming webhook (URL in KV)
        PostToTeams: {
          type: 'Http'
          runAfter: { ComposeContext: ['Succeeded'] }
          inputs: {
            method: 'POST'
            uri: '@parameters(\'TeamsWebhookUrl\')'
            headers: { 'Content-Type': 'application/json' }
            body: {
              type: 'message'
              attachments: [
                {
                  contentType: 'application/vnd.microsoft.card.adaptive'
                  content: {
                    type: 'AdaptiveCard'
                    version: '1.5'
                    body: [
                      {
                        type: 'TextBlock'
                        size: 'Large'
                        weight: 'Bolder'
                        text: '🔒 CSA Loom AI Security Signal'
                      }
                      {
                        type: 'FactSet'
                        facts: [
                          { title: 'Incident', value: '@{outputs(\'ComposeContext\')[\'incident\']}' }
                          { title: 'Severity', value: '@{outputs(\'ComposeContext\')[\'severity\']}' }
                          { title: 'Number', value: '@{outputs(\'ComposeContext\')[\'incidentNumber\']}' }
                          { title: 'Time', value: '@{outputs(\'ComposeContext\')[\'when\']}' }
                        ]
                      }
                      {
                        type: 'TextBlock'
                        wrap: true
                        text: '@{outputs(\'ComposeContext\')[\'description\']}'
                      }
                      {
                        type: 'ActionSet'
                        actions: [
                          {
                            type: 'Action.OpenUrl'
                            title: 'Open incident in Microsoft Sentinel'
                            url: '@{outputs(\'ComposeContext\')[\'incidentUrl\']}'
                          }
                        ]
                      }
                    ]
                  }
                }
              ]
            }
          }
        }
      }
    }
  }
}

// =====================================================================
// RBAC — playbook identity → Microsoft Sentinel Responder on the workspace
// =====================================================================
// The azuresentinel managed-identity connection reads incident data via the
// playbook's system-assigned identity; Sentinel Responder is the minimum role
// that lets the incident trigger operate + read the incident.
resource playbookSentinelResponder 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!defenderForAIEnabled) {
  scope: law
  name: guid(law.id, 'la-csa-loom-ai-alert', sentinelResponderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', sentinelResponderRoleId)
    // BCP318: `playbook` is conditional; this assignment shares the same
    // !defenderForAIEnabled gate, so the playbook exists whenever this deploys.
    #disable-next-line BCP318
    principalId: playbook.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// =====================================================================
// Sentinel automation rule — fires the playbook on AI rule incidents
// =====================================================================

// The IncidentRelatedAnalyticRuleIds condition matches the incident's
// relatedAnalyticRuleIds, which Sentinel exposes as FULL analytic-rule RESOURCE
// IDs — not friendly names. Supplying the bare names ('csa-loom-ai-prompt-injection')
// makes the automationRules PUT fail preflight with
// `BadRequest: Invalid Analytic rule id 'csa-loom-ai-prompt-injection'` (seen live
// in usgovvirginia; this path only runs where native Defender for AI is absent, i.e.
// !defenderForAIEnabled = Gov, so Commercial — defenderForAIEnabled=true — never
// deploys it and is byte-identical). Build the full extension-resource IDs of the
// two scheduled analytics rules created in monitoring.bicep on the same workspace.
// Ref: learn.microsoft.com — "relatedAnalyticRuleIds: List of resource ids of
// Analytic rules related to the incident".
var promptInjectionRuleId = '${law.id}/providers/Microsoft.SecurityInsights/alertRules/csa-loom-ai-prompt-injection'
var abuseQuotaRuleId = '${law.id}/providers/Microsoft.SecurityInsights/alertRules/csa-loom-ai-abuse-quota-spike'

resource automationRule 'Microsoft.SecurityInsights/automationRules@2024-09-01' = if (!defenderForAIEnabled && sentinelPlaybookAutomationEnabled) {
  scope: law
  name: 'csa-loom-ai-automation'
  properties: {
    displayName: 'CSA Loom — fire AI alert playbook on AI rule incidents'
    order: 100
    triggeringLogic: {
      isEnabled: true
      triggersOn: 'Incidents'
      triggersWhen: 'Created'
      conditions: [
        {
          conditionType: 'Property'
          conditionProperties: {
            propertyName: 'IncidentRelatedAnalyticRuleIds'
            operator: 'Contains'
            propertyValues: [promptInjectionRuleId, abuseQuotaRuleId]
          }
        }
      ]
    }
    actions: [
      {
        order: 1
        actionType: 'RunPlaybook'
        actionConfiguration: {
          logicAppResourceId: playbook.id
          tenantId: subscription().tenantId
        }
      }
    ]
  }
}

output playbookId string = !defenderForAIEnabled ? playbook.id : ''
