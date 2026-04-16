// ─────────────────────────────────────────────────────────────
// Budget Alerts — Azure Budget and Cost Alerting
// CSA-in-a-Box Monitoring
//
// Deploys Azure budgets with alert thresholds and action groups
// for Teams webhook and email notifications per domain/vertical.
// ─────────────────────────────────────────────────────────────

targetScope = 'subscription'

@description('Budget name prefix')
param budgetNamePrefix string = 'csa-budget'

@description('Start date for budget period (YYYY-MM-DD)')
param startDate string = utcNow('yyyy-MM-01')

@description('Time grain for the budget')
@allowed(['Monthly', 'Quarterly', 'Annually'])
param timeGrain string = 'Monthly'

@description('Budget configurations per domain/vertical')
param budgets array = [
  {
    name: 'shared'
    amount: 5000
    resourceGroupName: 'rg-csa-shared'
  }
  {
    name: 'finance'
    amount: 2000
    resourceGroupName: 'rg-csa-finance'
  }
  {
    name: 'inventory'
    amount: 2000
    resourceGroupName: 'rg-csa-inventory'
  }
  {
    name: 'sales'
    amount: 2000
    resourceGroupName: 'rg-csa-sales'
  }
  {
    name: 'streaming'
    amount: 3000
    resourceGroupName: 'rg-csa-streaming'
  }
  {
    name: 'platform'
    amount: 4000
    resourceGroupName: 'rg-csa-platform'
  }
]

// TODO: Set notificationEmails to your organization's actual distribution lists before deploying.
@description('Email addresses for budget alerts. Must be set to valid addresses before deployment.')
param notificationEmails array

@description('Teams webhook URL for budget alerts')
param teamsWebhookUrl string

@description('Azure region for action group resources')
param location string = 'eastus'

@description('Tags to apply to all resources')
param tags object = {
  Project: 'CSA-in-a-Box'
  Component: 'Monitoring'
  Environment: 'dev'
}

// ─── Action Group for Teams + Email ──────────────────────────
// Deployed in a monitoring resource group
resource monitoringRg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-csa-monitoring'
  location: location
  tags: tags
}

module actionGroupModule 'action-group.bicep' = {
  name: 'deploy-action-group'
  scope: monitoringRg
  params: {
    actionGroupName: 'ag-csa-budget-alerts'
    shortName: 'csabudget'
    emailReceivers: [for (email, i) in notificationEmails: {
      name: 'email-${i}'
      emailAddress: email
      useCommonAlertSchema: true
    }]
    webhookReceivers: [
      {
        name: 'teams-webhook'
        serviceUri: teamsWebhookUrl
        useCommonAlertSchema: true
        useAadAuth: false
      }
    ]
    tags: tags
  }
}

// ─── Budget per Domain/Vertical ──────────────────────────────
resource budget 'Microsoft.Consumption/budgets@2023-11-01' = [for b in budgets: {
  name: '${budgetNamePrefix}-${b.name}'
  properties: {
    category: 'Cost'
    amount: b.amount
    timeGrain: timeGrain
    timePeriod: {
      startDate: startDate
    }
    filter: {
      dimensions: {
        name: 'ResourceGroupName'
        operator: 'In'
        values: [b.resourceGroupName]
      }
    }
    notifications: {
      '50pct': {
        enabled: true
        operator: 'GreaterThan'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: notificationEmails
        contactGroups: [actionGroupModule.outputs.actionGroupId]
      }
      '75pct': {
        enabled: true
        operator: 'GreaterThan'
        threshold: 75
        thresholdType: 'Actual'
        contactEmails: notificationEmails
        contactGroups: [actionGroupModule.outputs.actionGroupId]
      }
      '90pct': {
        enabled: true
        operator: 'GreaterThan'
        threshold: 90
        thresholdType: 'Actual'
        contactEmails: notificationEmails
        contactGroups: [actionGroupModule.outputs.actionGroupId]
      }
      '100pct': {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: notificationEmails
        contactGroups: [actionGroupModule.outputs.actionGroupId]
      }
      '120pct_forecast': {
        enabled: true
        operator: 'GreaterThan'
        threshold: 120
        thresholdType: 'Forecasted'
        contactEmails: notificationEmails
        contactGroups: [actionGroupModule.outputs.actionGroupId]
      }
    }
  }
}]

// ─── Outputs ─────────────────────────────────────────────────
output budgetNames array = [for (b, i) in budgets: budget[i].name]
output actionGroupId string = actionGroupModule.outputs.actionGroupId
output monitoringResourceGroup string = monitoringRg.name
