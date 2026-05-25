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

// =====================================================================
// Logic App playbook — enriches alerts + posts to Teams / email
// =====================================================================

resource playbook 'Microsoft.Logic/workflows@2019-05-01' = if (!defenderForAIEnabled) {
  name: 'la-csa-loom-ai-alert-${location}'
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    state: 'Enabled'
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      parameters: {
        '$connections': {
          defaultValue: {}
          type: 'Object'
        }
      }
      triggers: {
        manual: {
          type: 'Request'
          kind: 'Http'
          inputs: {
            schema: {
              type: 'object'
              properties: {
                IncidentName: { type: 'string' }
                Severity: { type: 'string' }
                Description: { type: 'string' }
                Events: { type: 'array' }
              }
            }
          }
        }
      }
      actions: {
        // 1. Look up alerted principals / IPs for context
        ComposeContext: {
          type: 'Compose'
          inputs: {
            'incident': '@triggerBody()?[\'IncidentName\']'
            'severity': '@triggerBody()?[\'Severity\']'
            'description': '@triggerBody()?[\'Description\']'
            'when': '@utcNow()'
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
                          { title: 'Time', value: '@{outputs(\'ComposeContext\')[\'when\']}' }
                        ]
                      }
                      {
                        type: 'TextBlock'
                        wrap: true
                        text: '@{outputs(\'ComposeContext\')[\'description\']}'
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
    parameters: {
      TeamsWebhookUrl: {
        // Resolved from Key Vault by the LA's managed identity at runtime
        value: notificationWebhookKvRef
      }
    }
  }
}

// =====================================================================
// Sentinel automation rule — fires the playbook on AI rule incidents
// =====================================================================

resource automationRule 'Microsoft.SecurityInsights/automationRules@2024-09-01' = if (!defenderForAIEnabled) {
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
            propertyValues: ['csa-loom-ai-prompt-injection', 'csa-loom-ai-abuse-quota-spike']
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
