// CSA Loom — MCP catalog deploy RBAC
//
// The Admin → External MCP Tools "Deploy" wizard provisions a catalog MCP server
// as an INTERNAL Azure Container App AS THE CONSOLE UAMI (real ARM PUT). Creating
// a Container App that carries a user-assigned identity (uami-loom-mcp, which
// resolves the app's Key Vault secrets) requires the Console UAMI to hold the
// "Managed Identity Operator" role on that identity — Contributor (granted by
// scaling-rbac.bicep) covers Microsoft.App/containerApps/write but NOT the
// Microsoft.ManagedIdentity/userAssignedIdentities/*/assign/action needed to
// attach the identity. Without it the create returns 403 "LinkedAuthorization
// Failed" / "does not have authorization to perform action … assign/action".
//
// Scoped to the RG (where uami-loom-mcp lives) so it covers the assign action
// for that identity. Split into its own module so the principalId — a module
// OUTPUT in main.bicep — is a start-time-known param here (avoids BCP177).

targetScope = 'resourceGroup'

@description('Console UAMI principalId — granted Managed Identity Operator so the MCP deploy wizard can assign uami-loom-mcp to new Container Apps. Empty skips the grant.')
param consolePrincipalId string

@description('When true, skip all role grants (re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Managed Identity Operator — f1a07417-d97a-45cb-824c-7a7467783830
resource consoleMiOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(resourceGroup().id, consolePrincipalId, 'mcp-catalog-mi-operator')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'f1a07417-d97a-45cb-824c-7a7467783830')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    description: 'Console UAMI: assign uami-loom-mcp to catalog-deployed MCP server Container Apps.'
  }
}
