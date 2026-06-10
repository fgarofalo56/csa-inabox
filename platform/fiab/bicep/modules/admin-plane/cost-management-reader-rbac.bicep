// CSA Loom — Cost Management Reader (subscription scope) for the Console UAMI
//
// The /admin/capacity cost column (F5) + the /monitor → Cost tab query
// Microsoft.CostManagement for month-to-date spend per resource and the
// multi-subscription rollup:
//   - cost queries      (Microsoft.CostManagement/query)
//   - consumption usage  (Microsoft.Consumption/*/read)
//   - budgets            (Microsoft.Consumption/budgets)
//
// These are subscription-scoped reads, so the Console UAMI needs the built-in
// "Cost Management Reader" role at subscription scope. Without it the cost
// column returns an honest 403 gate ("⚠ No access"); with it, every row shows
// real billing data. The role GUID 72fafb9e-0641-4937-9268-a91bfd8191a3 is
// identical across all clouds (Commercial / GCC / GCC-High / IL5 / DoD).
//
// Note (Azure Government): Cost Management is available for EA + PAYG offers on
// management.usgovcloudapi.net; some CSP Gov tenants have no Cost Management
// offer, in which case the BFF surfaces an honest gate and utilization (Azure
// Monitor) still works. No Microsoft Fabric dependency (no-fabric-dependency.md).
//
// Split into its own subscription-scoped module so the principalId — a module
// OUTPUT in main.bicep — is a plain start-time-known param here, satisfying the
// role-assignment name/if requirements (avoids BCP177). Mirrors
// admin-plane/monitoring-reader-rbac.bicep.

targetScope = 'subscription'

@description('Console UAMI principalId — granted Cost Management Reader at subscription scope. Empty string skips the grant.')
param consolePrincipalId string

@description('When true, skip the role grant (e.g. re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Cost Management Reader — 72fafb9e-0641-4937-9268-a91bfd8191a3
resource consoleCostManagementReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(subscription().id, consolePrincipalId, 'cost-management-reader')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '72fafb9e-0641-4937-9268-a91bfd8191a3')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}
