// CSA Loom — Cosmos DB navigator keys RBAC (external / BYO account).
//
// When LOOM_COSMOS_ACCOUNT points to a Cosmos DB account that Loom does NOT
// deploy (e.g. a customer-owned account the operator wants to navigate), the
// DLZ-account grant in landing-zone/cosmos.bicep does not cover it. The Console
// UAMI still needs key access on THAT account for the Connect panel
// (ARM listKeys / listConnectionStrings / regenerateKey, api-version 2024-11-15).
//
// Role: DocumentDB Account Contributor (5bd9cd88-fe45-4216-938b-f97437e15450).
// Its Microsoft.DocumentDB/databaseAccounts/* wildcard includes
//   …/listKeys/action  and  …/listConnectionStrings/action  and  …/regenerateKey/action.
// "Cosmos DB Operator" (230815da-be43-4aae-9cb4-875f7bd000aa) is NOT sufficient —
// it explicitly excludes key access. The built-in role ID is cloud-agnostic
// (identical in Commercial / GCC / GCC-High / IL5).
//
// Deploy at the scope of the external account's resource group:
//   module cosmosNavKeys 'modules/admin-plane/cosmos-navigator-keys-rbac.bicep' = {
//     scope: resourceGroup(loomCosmosAccountRg)
//     name: 'cosmos-nav-keys-rbac'
//     params: {
//       cosmosAccountName: loomCosmosAccount
//       consolePrincipalId: uami.outputs.principalId
//     }
//   }

targetScope = 'resourceGroup'

@description('The Cosmos DB account name that LOOM_COSMOS_ACCOUNT points to (must exist in this resource group).')
param cosmosAccountName string

@description('Console UAMI principalId — granted DocumentDB Account Contributor. Passed as a param so it is start-time-known for the role-assignment name. Empty skips the grant.')
param consolePrincipalId string = ''

@description('When true, skip the role grant (re-deploy where RBAC exists or deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' existing = {
  name: cosmosAccountName
}

resource cosmosNavKeysRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: cosmosAccount
  name: guid(cosmosAccount.id, consolePrincipalId, 'cosmos-navigator-keys-v1')
  properties: {
    // DocumentDB Account Contributor — covers listKeys / listConnectionStrings /
    // regenerateKey via the databaseAccounts/* wildcard. Cosmos DB Operator is NOT enough.
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5bd9cd88-fe45-4216-938b-f97437e15450')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    description: 'Loom Console UAMI: Cosmos DB navigator Connect panel (listKeys / listConnectionStrings / regenerateKey). DocumentDB Account Contributor required — Cosmos DB Operator is NOT sufficient.'
  }
}

output roleAssigned bool = !empty(consolePrincipalId) && !skipRoleGrants
