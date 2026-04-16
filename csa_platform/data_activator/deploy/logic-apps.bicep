// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Data Activator — Logic Apps notification workflows.
// Deploys Logic Apps that orchestrate multi-channel alert delivery
// (Teams, email, PagerDuty) triggered by the rule evaluation engine.

targetScope = 'resourceGroup'

// ─── Parameters ─────────────────────────────────────────────────────────────

@description('Azure region for resource deployment.')
param location string = resourceGroup().location

@description('Resource tags applied to all deployed resources.')
param tags object = {}

@description('Environment identifier.')
@allowed(['dev', 'stg', 'prod'])
param environment string

@description('Base name prefix for all resources.')
param baseName string = 'csa-activator'

@description('Teams webhook URL for alert notifications.')
@secure()
param teamsWebhookUrl string = ''

@description('SendGrid API key for email notifications.')
@secure()
param sendGridApiKey string = ''

@description('Alert email sender address.')
param alertFromEmail string = 'alerts@csa-inabox.gov'

@description('Default alert email recipients (semicolon-separated).')
param alertEmailRecipients string = ''

@description('Log Analytics workspace resource ID for diagnostics.')
param logAnalyticsWorkspaceId string = ''

// ─── Variables ──────────────────────────────────────────────────────────────

var teamsAlertAppName = '${baseName}-teams-${environment}'
var emailAlertAppName = '${baseName}-email-${environment}'
var escalationAppName = '${baseName}-escalation-${environment}'

// ─── Logic App: Teams Alert ────────────────────────────────────────────────

@description('Logic App that sends alert notifications to Microsoft Teams.')
resource teamsAlertApp 'Microsoft.Logic/workflows@2019-05-01' = {
  name: teamsAlertAppName
  location: location
  tags: union(tags, { Pattern: 'DataActivator', Channel: 'Teams' })
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    state: 'Enabled'
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      parameters: {
        teamsWebhookUrl: {
          defaultValue: ''
          type: 'SecureString'
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
                ruleName: { type: 'string' }
                severity: { type: 'string' }
                description: { type: 'string' }
                field: { type: 'string' }
                actualValue: { type: 'number' }
                threshold: {}
                source: { type: 'string' }
                timestamp: { type: 'string' }
                metadata: { type: 'object' }
              }
              required: ['ruleName', 'severity']
            }
          }
        }
      }
      actions: {
        Build_Adaptive_Card: {
          type: 'Compose'
          inputs: {
            type: 'message'
            attachments: [
              {
                contentType: 'application/vnd.microsoft.card.adaptive'
                content: {
                  type: 'AdaptiveCard'
                  '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json'
                  version: '1.5'
                  body: [
                    {
                      type: 'TextBlock'
                      size: 'Large'
                      weight: 'Bolder'
                      text: '@{triggerBody()?[\'ruleName\']}'
                      style: 'heading'
                    }
                    {
                      type: 'TextBlock'
                      text: 'Severity: **@{toUpper(triggerBody()?[\'severity\'])}**'
                      weight: 'Bolder'
                    }
                    {
                      type: 'FactSet'
                      facts: [
                        { title: 'Field', value: '@{triggerBody()?[\'field\']}' }
                        { title: 'Value', value: '@{triggerBody()?[\'actualValue\']}' }
                        { title: 'Threshold', value: '@{triggerBody()?[\'threshold\']}' }
                        { title: 'Source', value: '@{triggerBody()?[\'source\']}' }
                        { title: 'Time', value: '@{triggerBody()?[\'timestamp\']}' }
                      ]
                    }
                    {
                      type: 'TextBlock'
                      text: '@{triggerBody()?[\'description\']}'
                      wrap: true
                    }
                  ]
                }
              }
            ]
          }
        }
        Post_to_Teams: {
          type: 'Http'
          runAfter: {
            Build_Adaptive_Card: ['Succeeded']
          }
          inputs: {
            method: 'POST'
            uri: '@parameters(\'teamsWebhookUrl\')'
            headers: {
              'Content-Type': 'application/json'
            }
            body: '@outputs(\'Build_Adaptive_Card\')'
          }
        }
        Response: {
          type: 'Response'
          runAfter: {
            Post_to_Teams: ['Succeeded', 'Failed']
          }
          inputs: {
            statusCode: 200
            body: {
              status: 'completed'
              teamsDelivery: '@{outputs(\'Post_to_Teams\')[\'statusCode\']}'
            }
          }
        }
      }
    }
    parameters: {
      teamsWebhookUrl: {
        value: teamsWebhookUrl
      }
    }
  }
}

// ─── Logic App: Email Alert ─────────────────────────────────────────────────

@description('Logic App that sends alert emails via SendGrid.')
resource emailAlertApp 'Microsoft.Logic/workflows@2019-05-01' = {
  name: emailAlertAppName
  location: location
  tags: union(tags, { Pattern: 'DataActivator', Channel: 'Email' })
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    state: 'Enabled'
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      parameters: {
        sendGridApiKey: {
          defaultValue: ''
          type: 'SecureString'
        }
        fromEmail: {
          defaultValue: alertFromEmail
          type: 'String'
        }
        defaultRecipients: {
          defaultValue: alertEmailRecipients
          type: 'String'
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
                ruleName: { type: 'string' }
                severity: { type: 'string' }
                description: { type: 'string' }
                field: { type: 'string' }
                actualValue: { type: 'number' }
                threshold: {}
                source: { type: 'string' }
                timestamp: { type: 'string' }
                recipients: {
                  type: 'array'
                  items: { type: 'string' }
                }
              }
              required: ['ruleName', 'severity']
            }
          }
        }
      }
      actions: {
        Send_Email_via_SendGrid: {
          type: 'Http'
          inputs: {
            method: 'POST'
            uri: 'https://api.sendgrid.com/v3/mail/send'
            headers: {
              'Content-Type': 'application/json'
              Authorization: 'Bearer @{parameters(\'sendGridApiKey\')}'
            }
            body: {
              personalizations: [
                {
                  to: '@{if(empty(triggerBody()?[\'recipients\']), createArray(json(concat(\'{"email":"\', parameters(\'defaultRecipients\'), \'"}\'))), map(triggerBody()?[\'recipients\'], item, json(concat(\'{"email":"\', item, \'"}\')))}'
                }
              ]
              from: {
                email: '@{parameters(\'fromEmail\')}'
                name: 'CSA-in-a-Box Alerts'
              }
              subject: '[CSA @{toUpper(triggerBody()?[\'severity\'])}] @{triggerBody()?[\'ruleName\']}'
              content: [
                {
                  type: 'text/plain'
                  value: 'Alert: @{triggerBody()?[\'ruleName\']}\nSeverity: @{triggerBody()?[\'severity\']}\nDescription: @{triggerBody()?[\'description\']}\nField: @{triggerBody()?[\'field\']} = @{triggerBody()?[\'actualValue\']}\nThreshold: @{triggerBody()?[\'threshold\']}\nSource: @{triggerBody()?[\'source\']}\nTimestamp: @{triggerBody()?[\'timestamp\']}'
                }
              ]
            }
          }
        }
        Response: {
          type: 'Response'
          runAfter: {
            Send_Email_via_SendGrid: ['Succeeded', 'Failed']
          }
          inputs: {
            statusCode: 200
            body: {
              status: 'completed'
              emailDelivery: '@{outputs(\'Send_Email_via_SendGrid\')[\'statusCode\']}'
            }
          }
        }
      }
    }
    parameters: {
      sendGridApiKey: {
        value: sendGridApiKey
      }
    }
  }
}

// ─── Logic App: Escalation Workflow ─────────────────────────────────────────

@description('Logic App for severity-based escalation (Teams → Email → PagerDuty).')
resource escalationApp 'Microsoft.Logic/workflows@2019-05-01' = {
  name: escalationAppName
  location: location
  tags: union(tags, { Pattern: 'DataActivator', Channel: 'Escalation' })
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    state: 'Enabled'
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      triggers: {
        manual: {
          type: 'Request'
          kind: 'Http'
          inputs: {
            schema: {
              type: 'object'
              properties: {
                ruleName: { type: 'string' }
                severity: { type: 'string' }
                description: { type: 'string' }
                field: { type: 'string' }
                actualValue: { type: 'number' }
                threshold: {}
                source: { type: 'string' }
                timestamp: { type: 'string' }
              }
              required: ['ruleName', 'severity']
            }
          }
        }
      }
      actions: {
        Route_by_Severity: {
          type: 'Switch'
          expression: '@triggerBody()?[\'severity\']'
          cases: {
            Critical: {
              case: 'critical'
              actions: {
                Notify_All_Channels: {
                  type: 'Compose'
                  inputs: {
                    teams: true
                    email: true
                    pagerduty: true
                    message: 'CRITICAL: @{triggerBody()?[\'ruleName\']} — immediate attention required'
                  }
                }
              }
            }
            Warning: {
              case: 'warning'
              actions: {
                Notify_Teams_And_Email: {
                  type: 'Compose'
                  inputs: {
                    teams: true
                    email: true
                    pagerduty: false
                    message: 'WARNING: @{triggerBody()?[\'ruleName\']} — review recommended'
                  }
                }
              }
            }
          }
          default: {
            actions: {
              Log_Info_Only: {
                type: 'Compose'
                inputs: {
                  teams: false
                  email: false
                  pagerduty: false
                  message: 'INFO: @{triggerBody()?[\'ruleName\']} — logged for audit'
                }
              }
            }
          }
        }
        Response: {
          type: 'Response'
          runAfter: {
            Route_by_Severity: ['Succeeded']
          }
          inputs: {
            statusCode: 200
            body: {
              status: 'escalation-complete'
              severity: '@{triggerBody()?[\'severity\']}'
            }
          }
        }
      }
    }
  }
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

resource teamsAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${teamsAlertAppName}-diagnostics'
  scope: teamsAlertApp
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

resource emailAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${emailAlertAppName}-diagnostics'
  scope: emailAlertApp
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// ─── Outputs ────────────────────────────────────────────────────────────────

@description('Teams alert Logic App trigger URL (use listCallbackUrl to retrieve).')
output teamsAlertAppName string = teamsAlertApp.name

@description('Email alert Logic App name.')
output emailAlertAppName string = emailAlertApp.name

@description('Escalation Logic App name.')
output escalationAppName string = escalationApp.name

@description('Teams alert Logic App resource ID.')
output teamsAlertAppId string = teamsAlertApp.id

@description('Email alert Logic App resource ID.')
output emailAlertAppId string = emailAlertApp.id
