// ─────────────────────────────────────────────────────────────
// Action Group Module — Reusable action group for alert notifications
// Used by budget-alerts.bicep and other alert templates
// ─────────────────────────────────────────────────────────────

@description('Name of the action group')
param actionGroupName string

@description('Short name for the action group (max 12 characters)')
@maxLength(12)
param shortName string

@description('Email receivers configuration')
param emailReceivers array = []

@description('Webhook receivers configuration (Teams, PagerDuty, etc.)')
param webhookReceivers array = []

@description('Tags to apply')
param tags object = {}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: actionGroupName
  location: 'global'
  tags: tags
  properties: {
    enabled: true
    groupShortName: shortName
    emailReceivers: emailReceivers
    webhookReceivers: webhookReceivers
    smsReceivers: []
    azureAppPushReceivers: []
    automationRunbookReceivers: []
    voiceReceivers: []
    logicAppReceivers: []
    azureFunctionReceivers: []
    armRoleReceivers: [
      {
        name: 'Monitoring Contributor'
        roleId: '749f88d5-cbae-40b8-bcfc-e573ddc772fa'
        useCommonAlertSchema: true
      }
    ]
  }
}

output actionGroupId string = actionGroup.id
output actionGroupName string = actionGroup.name
