// CSA Loom DLZ — per-domain Consumption budget + threshold alert rules (D4 chargeback)
//
// Deployment scope: SUBSCRIPTION. A tag-filtered budget can only be created at
// the subscription level (RG filters are "subscription level only"), and a tag
// filter is the only way to separate per-domain spend when several DLZs share a
// single subscription/RG (single-sub mode). Filters on `csa-loom-domain=<domain>`
// — the exact tag the DLZ orchestrator stamps on every resource via dlzTags —
// so the budget tracks this domain's spend across whatever RGs it spans.
//
// One notification rule is generated per threshold (percent of the budget).
// Each rule fires on ACTUAL spend crossing the threshold and notifies the
// supplied contact emails / action groups. Per no-vaporware, the caller only
// invokes this module when at least one recipient is supplied — a budget with
// no notifications is useless.
//
//   Microsoft.Consumption/budgets@2023-05-01
//   https://learn.microsoft.com/rest/api/consumption/budgets/create-or-update

targetScope = 'subscription'

@description('Domain name — used for the budget name and the csa-loom-domain tag filter.')
param domainName string

@description('Budget amount in the account currency.')
@minValue(1)
param amount int

@description('Reset cadence.')
@allowed(['Monthly', 'Quarterly', 'Annually'])
param timeGrain string = 'Monthly'

@description('Start date (yyyy-MM-01). Empty = first day of the current UTC month at deploy time. Consumption budgets require the start date to be the first of a month.')
param startDate string = ''

@description('Alert thresholds as percent of the budget (1–1000). One notification rule per threshold.')
param thresholds array = [
  50
  80
  100
]

@description('Email recipients for threshold alerts.')
param contactEmails array = []

@description('Action-group resource ids to notify on threshold alerts.')
param contactGroupIds array = []

// First-of-month start date (budgets reject mid-month starts). utcNow can only
// be used in a param default, so compute it here from a param default value.
@description('Internal: deploy-time UTC stamp used to derive the default budget start date. Do not override.')
param deployTimestamp string = utcNow('yyyy-MM-dd')

var effectiveStart = empty(startDate) ? '${substring(deployTimestamp, 0, 7)}-01' : startDate

// A far-future end date so the budget never auto-expires (Consumption budgets
// require timePeriod.endDate; 10 years out is the documented "evergreen" idiom).
var endYear = string(int(substring(effectiveStart, 0, 4)) + 10)
var effectiveEnd = '${endYear}-${substring(effectiveStart, 5, 2)}-01'

// Build one notification per threshold. Object keys must be static, so we key
// by a deterministic label derived from the threshold value.
var notifications = reduce(thresholds, {}, (cur, t) => union(cur, {
  '${'Actual_GreaterThan_'}${string(t)}_Percent': {
    enabled: true
    operator: 'GreaterThanOrEqualTo'
    threshold: t
    thresholdType: 'Actual'
    contactEmails: contactEmails
    contactGroups: contactGroupIds
    contactRoles: []
  }
}))

resource budget 'Microsoft.Consumption/budgets@2023-05-01' = {
  name: 'loom-${domainName}-budget'
  properties: {
    category: 'Cost'
    amount: amount
    timeGrain: timeGrain
    timePeriod: {
      startDate: '${effectiveStart}T00:00:00Z'
      endDate: '${effectiveEnd}T00:00:00Z'
    }
    filter: {
      tags: {
        name: 'csa-loom-domain'
        operator: 'In'
        values: [
          domainName
        ]
      }
    }
    notifications: notifications
  }
}

output budgetName string = budget.name
output budgetId string = budget.id
