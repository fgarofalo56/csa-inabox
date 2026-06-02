// CSA Loom deploy-planner — Microsoft Defender for Cloud (pricing tiers)
//
// Wired by the deploy-planner catalog (key: defenderCloud → defenderCloudEnabled).
// Self-contained: sets the subscription's Microsoft Defender for Cloud pricing
// tiers (Microsoft.Security/pricings) to Standard for a curated set of plans so
// the Defender for Cloud navigator reflects real enabled coverage. This is a
// subscription-scoped resource, so the module is deployed with
// `scope: subscription()` from main.bicep.
//
// Grounded in Microsoft Learn:
//   Microsoft.Security/pricings (Bicep, subscription scope)
//   https://learn.microsoft.com/azure/templates/microsoft.security/pricings

targetScope = 'subscription'

@description('Defender plans to enable at Standard. Each becomes a Microsoft.Security/pricings resource set to Standard.')
param plans array = [
  'VirtualMachines'
  'StorageAccounts'
  'KeyVaults'
  'Arm'
  'Containers'
]

resource pricings 'Microsoft.Security/pricings@2024-01-01' = [for plan in plans: {
  name: plan
  properties: {
    pricingTier: 'Standard'
  }
}]

output enabledPlans array = plans
