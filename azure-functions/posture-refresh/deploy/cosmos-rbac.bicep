// CSA Loom — posture-refresh Function → Loom Cosmos data-plane RBAC grant.
//
// Deployed as a module scoped to the Loom Cosmos account's resource group (which
// may differ from the Function App's RG). Binds the Function App's system-
// assigned managed identity to the built-in "Cosmos DB Built-in Data
// Contributor" role at account scope, so the Function can query the catalog and
// upsert posture-aggregates / recommended-actions. AAD-only — no account keys.

@description('Loom Cosmos DB account name (the account that holds the loom database).')
param loomCosmosAccountName string

@description('Principal id of the posture-refresh Function App system-assigned managed identity.')
param functionPrincipalId string

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' existing = {
  name: loomCosmosAccountName
}

// Built-in role: Cosmos DB Built-in Data Contributor (read+write+upsert+delete).
var dataContributorRoleId = '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'

resource grant 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, functionPrincipalId, '00000000-0000-0000-0000-000000000002')
  properties: {
    roleDefinitionId: dataContributorRoleId
    principalId: functionPrincipalId
    scope: cosmos.id
  }
}
