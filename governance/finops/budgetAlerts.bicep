// Budget Alerts for Data Platform FinOps
// Creates Azure Budget resources with notification thresholds

targetScope = 'subscription'

@description('Environment name')
param environment string = 'dev'

@description('Monthly budget amount in USD')
param monthlyBudgetUSD int = environment == 'dev' ? 5000 : 50000

@description('Budget start date (YYYY-MM-01 format)')
param startDate string = '2026-04-01'

@description('Contact emails for budget alerts')
param contactEmails array = []

@description('Action group resource ID for alerts')
param actionGroupId string = ''

resource platformBudget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'csa-platform-budget-${environment}'
  properties: {
    category: 'Cost'
    amount: monthlyBudgetUSD
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
    }
    notifications: {
      Actual_50Pct: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 50
        contactEmails: contactEmails
        thresholdType: 'Actual'
      }
      Actual_75Pct: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 75
        contactEmails: contactEmails
        thresholdType: 'Actual'
      }
      Actual_90Pct: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 90
        contactEmails: contactEmails
        thresholdType: 'Actual'
      }
      Forecast_100Pct: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        contactEmails: contactEmails
        thresholdType: 'Forecasted'
      }
      Actual_110Pct: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 110
        contactEmails: contactEmails
        thresholdType: 'Actual'
      }
    }
    filter: {
      tags: {
        name: 'Platform'
        values: ['csa-inabox']
        operator: 'In'
      }
    }
  }
}
