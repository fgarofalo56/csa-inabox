// CSA Loom — Cost Management Reader + billing scope for the unified capacity +
// chargeback dashboard (/admin/usage-chargeback).
//
// The dashboard is the Azure-native 1:1 of the Fabric Capacity Metrics app:
// it rolls up real Azure Cost Management spend (by service, by workspace) and
// Azure Monitor utilization (normalized to one Loom Capacity Unit) ACROSS every
// engine, tenant-wide. Its BFF (app/api/admin/capacity/chargeback) needs the
// Console UAMI to be able to read Cost Management:
//   - cost queries       (Microsoft.CostManagement/query)
//   - consumption usage   (Microsoft.Consumption/*/read)
//   - budgets             (Microsoft.Consumption/budgets)
//
// Without the grant the dashboard renders an honest 503 gate naming this exact
// role + LOOM_BILLING_SCOPE; with it, every card/table lights up with real
// billing data. The built-in "Cost Management Reader" role GUID
// 72fafb9e-0641-4937-9268-a91bfd8191a3 is identical across all clouds
// (Commercial / GCC / GCC-High / IL5 / DoD).
//
// This module ALSO emits `loomBillingScope` — the ARM scope the chargeback
// rollup should cover — so the integration pass can set the LOOM_BILLING_SCOPE
// app env var without hand-authoring it. Defaults to the deployment's
// subscription scope; override `billingScopeOverride` to roll up at a billing
// account / enrollment / management-group scope instead.
//
// No Microsoft Fabric dependency (see .claude/rules/no-fabric-dependency.md).
// Subscription-scoped so the principalId (a main.bicep module OUTPUT) is a
// start-time-known param here, satisfying role-assignment name/if requirements
// (avoids BCP177). Mirrors admin-plane/cost-management-reader-rbac.bicep.
//
// ─── Integration pass — wire into platform/fiab/bicep/main.bicep ──────────────
// Do NOT edit main.bicep from the feature branch; the operator wires this in a
// dedicated integration commit. The wiring is:
//
//   module costManagementChargebackRbac 'modules/admin-plane/cost-management-rbac.bicep' = {
//     name: 'cost-mgmt-chargeback-rbac'
//     scope: subscription()
//     params: {
//       consolePrincipalId: consoleIdentity.outputs.principalId
//       skipRoleGrants: skipRoleGrants
//       billingScopeOverride: '' // or a billing-account / mgmt-group scope
//     }
//   }
//
// Then add to the Console app env list (admin-plane/main.bicep apps[].env):
//   { name: 'LOOM_BILLING_SCOPE', value: costManagementChargebackRbac.outputs.loomBillingScope }
// Optional cap (Loom Capacity Unit SKU ceiling for the throttle gauge):
//   { name: 'LOOM_CAPACITY_LCU', value: '' } // empty ⇒ auto-derived + 25% headroom
// ──────────────────────────────────────────────────────────────────────────────

targetScope = 'subscription'

@description('Console UAMI principalId — granted Cost Management Reader at subscription scope. Empty string skips the grant.')
param consolePrincipalId string

@description('When true, skip the role grant (e.g. re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

@description('Optional explicit Cost Management scope for the chargeback rollup (e.g. "/providers/Microsoft.Billing/billingAccounts/{id}" or a management-group scope). Empty ⇒ the deployment subscription scope.')
param billingScopeOverride string = ''

// Cost Management Reader — 72fafb9e-0641-4937-9268-a91bfd8191a3
resource consoleCostManagementReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(subscription().id, consolePrincipalId, 'cost-management-chargeback-reader')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '72fafb9e-0641-4937-9268-a91bfd8191a3')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('The ARM scope the chargeback dashboard rolls up cost for. Set this as the LOOM_BILLING_SCOPE app env var.')
output loomBillingScope string = empty(billingScopeOverride) ? subscription().id : billingScopeOverride

@description('The Cost Management Reader role definition GUID (identical across clouds).')
output costManagementReaderRoleId string = '72fafb9e-0641-4937-9268-a91bfd8191a3'
