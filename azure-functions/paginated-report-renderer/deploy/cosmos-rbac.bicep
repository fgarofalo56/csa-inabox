// CSA Loom — paginated-report-renderer Function → Loom Cosmos data-plane RBAC.
//
// OPTIONAL. The default render path reads the report definition + sampleRows
// from the request body and needs NO Cosmos access. This grant exists only for
// the future live-query render path (the Function re-running each dataset's SQL
// at render time), which would read the `paginated-report-definitions`
// container. Deployed as a module scoped to the Loom Cosmos account's resource
// group (which may differ from the Function App's RG). AAD-only — no keys.

@description('Loom Cosmos DB account name (the account that holds the loom database).')
param loomCosmosAccountName string

@description('Principal id of the paginated-report-renderer Function App system-assigned managed identity.')
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
