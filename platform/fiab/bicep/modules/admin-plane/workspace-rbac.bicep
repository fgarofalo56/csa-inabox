// CSA Loom — Workspace RBAC (F5 Manage Access)
//
// Grants the Console UAMI the "Role Based Access Control Administrator" role on
// the DLZ resource group so the Manage Access pane can create/delete Azure RBAC
// role assignments that mirror each workspace membership row in Cosmos
// (Admin/Member → Contributor; Contributor/Viewer → Reader).
//
// LEAST PRIVILEGE: instead of Owner / User Access Administrator (which can grant
// ANY role, including Owner), this grant is the dedicated RBAC-Admin role AND is
// CONSTRAINED via an ABAC condition so the UAMI may only write/delete role
// assignments for the two built-in roles the feature uses — Contributor
// (b24988ac-…) and Reader (acdd72a7-…). Any attempt to assign a different role
// is denied by Azure. (Delegate-with-conditions pattern, per Learn:
//   https://learn.microsoft.com/azure/role-based-access-control/delegate-role-assignments-overview )
//
// Role Based Access Control Administrator: f58310d9-a9f6-439a-9e8d-f62e7b41a168
//
// Deployed at the DLZ resource group scope (commonly a different RG than the
// admin plane), so the parent invokes this module with
// `scope: resourceGroup(loomDlzRg)`. Delegated to its own module so the
// principalId (a module OUTPUT in main.bicep) is start-time-known here (BCP177).

targetScope = 'resourceGroup'

@description('Console UAMI principalId — granted constrained RBAC Admin on this RG. Empty string skips the grant.')
param consolePrincipalId string

@description('When true, skip the role grant (e.g. re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Built-in role definition GUIDs (global across every tenant/cloud).
var rbacAdminRoleId = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168' // Role Based Access Control Administrator
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'

// ABAC condition (v2.0): permit roleAssignments write AND delete ONLY when the
// targeted RoleDefinitionId is Contributor or Reader. All other roles (Owner,
// User Access Administrator, etc.) are blocked even though the UAMI holds
// RBAC-Admin. Guards both the create (Request) and remove (Resource) actions.
var rbacCondition = '((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${contributorRoleId}, ${readerRoleId}})) AND ((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/delete\'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${contributorRoleId}, ${readerRoleId}}))'

resource wsRbacAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  // guid() is deterministic — re-running after the grant exists is a no-op.
  name: guid(resourceGroup().id, consolePrincipalId, 'loom-ws-roles-rbac-admin-v1')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', rbacAdminRoleId)
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    condition: rbacCondition
    conditionVersion: '2.0'
    description: 'Loom Console UAMI: create/delete Contributor + Reader workspace role assignments (F5 Manage Access). Constrained to those two built-in roles via ABAC.'
  }
}
