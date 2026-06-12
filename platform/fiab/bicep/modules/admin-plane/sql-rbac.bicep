// CSA Loom — Azure SQL DB Contributor RBAC for the Compute & Storage scale tab
//
// The unified SQL database editor's "Compute & Storage" tab issues an ARM PATCH
// on Microsoft.Sql/servers/databases to change a database's compute SKU
// (DTU ↔ vCore ↔ serverless), capacity, max storage, and serverless auto-pause.
// That control-plane write (Microsoft.Sql/servers/databases/write) requires, at
// minimum, the "SQL DB Contributor" role on the resource group containing the
// SQL logical server — performed AS THE CONSOLE UAMI.
//
//   SQL DB Contributor — 9b7fa17d-e63e-47b0-bb0a-15c516ac86ec
//     Manage SQL databases (create / scale / configure) but NOT access to them.
//     It does NOT grant the database data-plane: TDS queries continue to use the
//     Microsoft Entra admin / db_owner path unchanged.
//
// Data-plane reads (the Query tab AND the Azure SQL server editor's schema/table
// object browser, which issues sys.* catalog reads over TDS) deliberately do NOT
// ride this control-plane role. They require the console UAMI to be the server's
// Microsoft Entra admin (Microsoft.Sql/servers/administrators) — settable from
// the editor's "AAD admin" ribbon button — or a contained user with
// db_datareader + VIEW DEFINITION. That grant is a data-plane act that cannot be
// expressed in ARM/bicep; see docs/fiab/v3-tenant-bootstrap.md
// (#azure-sql-server-schema-browser). The navigator shows the real TDS auth
// error honestly until it is in place (no-vaporware.md).
//
// Without this grant, every scale PATCH returns 403 and the editor renders an
// honest MessageBar naming this exact role (per no-vaporware.md).
//
// Split into its own module (vs. inlined in main.bicep) so the consolePrincipalId
// — a module OUTPUT in main.bicep — is a plain start-time-known param here,
// satisfying the role-assignment name/if requirement (avoids BCP177). Same
// pattern as scaling-rbac.bicep / workspace-rbac.bicep.

targetScope = 'resourceGroup'

@description('Console UAMI principalId — granted SQL DB Contributor on this RG so the Compute & Storage tab can PATCH database SKUs. Empty string skips the grant.')
param consolePrincipalId string

@description('When true, skip all role grants (re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// SQL DB Contributor — 9b7fa17d-e63e-47b0-bb0a-15c516ac86ec
// Verified: https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#databases
resource sqlDbContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(resourceGroup().id, consolePrincipalId, 'loom-sql-db-contributor-scale-v1')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '9b7fa17d-e63e-47b0-bb0a-15c516ac86ec')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    description: 'Loom Console UAMI: scale Azure SQL Database compute SKUs (DTU/vCore/serverless PATCH) from the Compute & Storage tab. Does not grant data-plane access.'
  }
}
