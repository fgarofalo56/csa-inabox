// CSA Loom — loom-next-level program run-rate budget (COST0, round-3 F1).
//
// A Microsoft.Consumption/budgets ceiling at SUBSCRIPTION scope, filtered on
// the `loom-next-level` resource tag, so the aggregate spend of every
// always-on resource this program deploys (see program-budget.README.md for
// the itemized run-rate inventory) is BOUNDED and alerted — not just
// observable. Notifications fire at 80% + 100% of ACTUAL spend and 100% of
// FORECASTED spend, through the ONE shared default action group
// (monitoring-default-alerts.bicep::loom-default-alerts — the same group the
// LOOM_ALERT_ACTION_GROUP_ID convention routes S1/V1 alerts through; no
// parallel per-item alert channels, per the rev-2 alert standard) plus the
// subscription Owner contact role (mirrors the action group's ARM-role
// receiver, so the admin group is reached even before receivers are added).
//
// Dogfooding: the budget is a plain Consumption budget at subscription scope,
// which is exactly what lib/azure/cost-client.ts listBudgets() enumerates —
// so it renders in the /monitor Cost tab "Budgets" section (name, ceiling,
// current burn, % used) with ZERO new UI. The platform monitors its own spend.
//
// Cost: ~$0 — a budget object is free; it *bounds* spend, it doesn't add any.
//
// Per-cloud: Microsoft.Consumption/budgets is GA in Azure Government (Cost
// Management is in-boundary — C1/C2 findings); the same module deploys to Gov
// via the Gov SP. IL5: in-boundary Cost Management only — no external egress
// (notifications go to the in-boundary action group / subscription Owners).
//
// NOTE (honest limitation): budgets require a supported offer type
// (EA / MCA / PAYG). On unsupported offers (e.g. MSDN / sponsored subs) the
// PUT fails — opt out via observabilityConfig.programBudgetEnabled=false.
// Tag-filtered budgets track spend of TAGGED resources only: every resource
// the loom-next-level program deploys carries the `loom-next-level: 'true'`
// tag in its bicep module (tag convention in the PRP master bicep-sync
// standard; retro-applied to V1/S1/E2 in the COST0 PR).

targetScope = 'subscription'

@description('Budget resource name (subscription-scoped).')
param budgetName string = 'loom-next-level-program'

@description('Monthly run-rate ceiling for the program\'s tagged resources, in the billing currency (USD on the Loom estates). Override via observabilityConfig.programBudgetAmount.')
@minValue(1)
param amount int = 1000

@description('First day of the budget period. Must be the first of a month; defaults to the first of the current month (UTC).')
param startDate string = utcNow('yyyy-MM-01')

@description('Resource id of the shared default action group (monitoring-default-alerts.bicep::loom-default-alerts) the threshold notifications route through. Empty (action group skipped) → notifications fall back to the subscription Owner contact role only.')
param actionGroupId string = ''

@description('Optional extra notification emails. The action group + Owner role usually suffice; use this for a finops DL.')
param contactEmails array = []

@description('Resource tag the budget filters on. Every resource the loom-next-level program deploys carries this tag.')
param programTagName string = 'loom-next-level'

@description('Tag values counted into the budget.')
param programTagValues array = ['true']

// Budgets run 10 years from start unless told otherwise — effectively "until
// deleted", matching the portal default. dateTimeAdd keeps it relative.
var endDate = dateTimeAdd(startDate, 'P10Y')

var contactGroups = empty(actionGroupId) ? [] : [actionGroupId]

// Shared notification contact block: the ONE action group (when present) +
// subscription Owners (the admin group — mirrors the default action group's
// ARM-role receiver) + optional explicit emails.
var contacts = {
  contactEmails: contactEmails
  contactGroups: contactGroups
  contactRoles: ['Owner']
}

resource programBudget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: budgetName
  properties: {
    category: 'Cost'
    amount: amount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
      endDate: endDate
    }
    filter: {
      tags: {
        name: programTagName
        operator: 'In'
        values: [for v in programTagValues: string(v)]
      }
    }
    notifications: {
      // 80% of actual spend — early warning, month still recoverable.
      actual80Percent: union(contacts, {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
      })
      // 100% of actual spend — ceiling breached.
      actual100Percent: union(contacts, {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
      })
      // Forecasted to breach the ceiling this month — fires ahead of the
      // actual breach so the run-rate can be trimmed in time.
      forecasted100Percent: union(contacts, {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
      })
    }
  }
}

@description('Resource id of the program budget (for the deploy receipt).')
output budgetId string = programBudget.id

@description('Budget name — the row the /monitor Cost tab Budgets section shows via cost-client listBudgets().')
output budgetNameOut string = programBudget.name
