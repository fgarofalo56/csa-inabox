// CSA Loom F16 — Azure Connections RBAC.
//
// Grants the Console UAMI the two Contributor roles the F16 "Azure connections"
// pane needs to make a workspace's ADLS Gen2 + Log Analytics bindings fully
// functional:
//
//   - Storage Blob Data Contributor (ba92f5b4-2d11-453d-a403-e96b0029c9fe) on
//     the ADLS Gen2 account → the Dataflow Gen2 ADF run path writes staged
//     Parquet to the bound account, and the connect-time data-plane probe can
//     create the staging container.
//   - Log Analytics Contributor (92aaf0da-9dab-42b6-94a3-d43ce8d16293) on the
//     Log Analytics workspace → configure data collection / export so the
//     workspace's query/run logs stream to the bound LAW.
//
// Both built-in role IDs are cloud-agnostic (identical in Commercial / GCC /
// GCC-High / IL5). Each grant is conditional + idempotent (guid()-named) so a
// re-deploy is a no-op, and the whole module is skippable when the deployer
// lacks User Access Administrator (skipRoleGrants) — in which case the console
// renders an honest MessageBar gate per no-vaporware.md.
//
// This module is RG-scoped (the storage account and/or LAW live in this RG).
// When binding resources in another RG, run the module again at that RG scope.

targetScope = 'resourceGroup'

@description('Console UAMI principalId (start-time-known module param so the role-assignment name is calculable).')
param consolePrincipalId string

@description('ADLS Gen2 storage account name in this resource group. Empty = skip the storage grant.')
param storageAccountName string = ''

@description('Log Analytics workspace name in this resource group. Empty = skip the LAW grant.')
param logAnalyticsWorkspaceName string = ''

@description('When true, skip the role grants (re-deploy where RBAC exists or deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Storage Blob Data Contributor — ba92f5b4-2d11-453d-a403-e96b0029c9fe
resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' existing = if (!empty(storageAccountName)) {
  name: storageAccountName
}

resource adlsContrib 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(storageAccountName) && !empty(consolePrincipalId) && !skipRoleGrants) {
  scope: sa
  name: guid(sa.id, consolePrincipalId, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Log Analytics Contributor — 92aaf0da-9dab-42b6-94a3-d43ce8d16293
resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = if (!empty(logAnalyticsWorkspaceName)) {
  name: logAnalyticsWorkspaceName
}

resource lawContrib 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(logAnalyticsWorkspaceName) && !empty(consolePrincipalId) && !skipRoleGrants) {
  scope: law
  name: guid(law.id, consolePrincipalId, '92aaf0da-9dab-42b6-94a3-d43ce8d16293')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '92aaf0da-9dab-42b6-94a3-d43ce8d16293')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}
