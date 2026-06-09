// CSA Loom — Azure SQL database per-item Share RBAC grant
//
// Grants the Console UAMI the "Role Based Access Control Administrator" role on
// the SQL server's resource group so the per-database Share dialog (item-level
// Access control / IAM) can create/delete Azure RBAC role assignments scoped to
// a single Microsoft.Sql/servers/databases/{db}.
//
// LEAST PRIVILEGE: instead of Owner / User Access Administrator (which can grant
// ANY role, including Owner), this is the dedicated RBAC-Admin role AND is
// CONSTRAINED via an ABAC condition so the UAMI may only write/delete role
// assignments for the three roles the Share dialog offers — Reader (acdd72a7-…),
// Contributor (b24988ac-…), and SQL DB Contributor (9b7fa17d-…). Any attempt to
// assign a different role (Owner, User Access Administrator, etc.) is denied by
// Azure even though the UAMI holds RBAC-Admin. (Delegate-with-conditions
// pattern, per Learn:
//   https://learn.microsoft.com/azure/role-based-access-control/delegate-role-assignments-overview )
//
// Role Based Access Control Administrator: f58310d9-a9f6-439a-9e8d-f62e7b41a168
//
// Deployed at the SQL server resource group scope; the parent invokes this
// module with `scope: resourceGroup(sqlServerRg)`. Delegated to its own module
// so the principalId (a module OUTPUT in main.bicep) is start-time-known here
// (BCP177), matching the workspace-rbac.bicep pattern.

targetScope = 'resourceGroup'

@description('Console UAMI principalId — granted constrained RBAC Admin on this RG. Empty string skips the grant.')
param consolePrincipalId string

@description('When true, skip the role grant (e.g. re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Built-in role definition GUIDs (global across every tenant/cloud).
var rbacAdminRoleId = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168' // Role Based Access Control Administrator
var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
var sqlDbContribRoleId = '9b7fa17d-e63e-47b0-bb0a-15c516ac86ec' // SQL DB Contributor

// ABAC condition (v2.0): permit roleAssignments write AND delete ONLY when the
// targeted RoleDefinitionId is Reader, Contributor, or SQL DB Contributor. All
// other roles are blocked even though the UAMI holds RBAC-Admin. Guards both
// the create (Request) and remove (Resource) actions.
var rbacCondition = '((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${readerRoleId}, ${contributorRoleId}, ${sqlDbContribRoleId}})) AND ((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/delete\'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${readerRoleId}, ${contributorRoleId}, ${sqlDbContribRoleId}}))'

resource sqlShareRbacAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  // guid() is deterministic — re-running after the grant exists is a no-op.
  name: guid(resourceGroup().id, consolePrincipalId, 'loom-sql-share-rbac-admin-v1')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', rbacAdminRoleId)
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    condition: rbacCondition
    conditionVersion: '2.0'
    description: 'Loom Console UAMI: assign Reader/Contributor/SQL DB Contributor on Azure SQL databases for the per-item Share dialog. ABAC-constrained to those three roles.'
  }
}
