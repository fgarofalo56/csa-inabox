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

// ── WHY startDate IS REQUIRED AND HAS NO DEFAULT (#4253) ───────────────────
// This defaulted to `utcNow('yyyy-MM-01')`, which is the SAME defect that broke
// deploy-fiab-commercial for eight consecutive days — found here by widening
// the anti-rotator sweep in scripts/ci/__tests__/program-budget-start-date.test.mjs
// past platform/fiab/bicep, where it had been looking.
//
// `timePeriod.startDate` on Microsoft.Consumption/budgets is IMMUTABLE. utcNow()
// re-evaluates on every deployment, so on the 1st of each month the template
// starts asking for a start the live budget can never accept, and ARM refuses
// every apply from then on:
//   400 → "Start date of budgets cannot be updated. Please delete and create a
//   new budget."
//
// NOTHING CURRENTLY DEPLOYS THIS FILE — measured: the only references are a
// comment in the sibling action-group.bicep and monitoring/README.md, no
// workflow — so this was armed but not firing, and is not a second P0. It is
// fixed rather than allowlisted because "no caller today" is not a property that
// stays true, and the fix is the same two lines either way.
//
// A caller must now supply the value: the LIVE budget's existing start when one
// exists, or the first of the current month when creating (Azure accepts only
// the current month's first on a create — Learn, BudgetProperties.timePeriod:
// "Past start date should be selected within the timegrain period"). The Loom
// program budget resolves exactly this from the estate in
// scripts/ci/resolve-program-budget-start-date.mjs; that is the pattern to
// follow if this module is ever wired to a lane.
@description('First day of the budget period, as YYYY-MM-01. REQUIRED — no default, deliberately: timePeriod.startDate is IMMUTABLE, so a value computed at deploy time breaks every apply in a later month than the budget\'s creation month (#4253). Pass the live budget\'s existing start, or the first of the current month when creating.')
@minLength(10)
@maxLength(10)
param startDate string

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
