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
// Deployed at the DLZ resource group scope, so the parent invokes this module
// with `scope: resourceGroup(loomDlzRg)`. Delegated to its own module so the
// principalId (a module OUTPUT in main.bicep) is start-time-known here (BCP177).
//
// NOTE that `loomDlzRg` FALLS BACK to the admin-plane RG whenever the estate is
// not single-DLZ (main.bicep: `loomDlzRg: useSingleDlz ? singleDlzRg.name :
// adminPlaneRgName`), so "commonly a different RG than the admin plane" is NOT
// true in the tenant / multi-DLZ topologies — this grant very often lands on the
// admin-plane RG itself. That is why this module owns the union condition for
// every RBAC-Admin consumer at that scope (see below).

targetScope = 'resourceGroup'

@description('Console UAMI principalId — granted constrained RBAC Admin on this RG. Empty string skips the grant.')
param consolePrincipalId string

@description('When true, skip the role grant (e.g. re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Built-in role definition GUIDs (global across every tenant/cloud).
var rbacAdminRoleId = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168' // Role Based Access Control Administrator
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
// SQL DB Contributor — included so this single RBAC-Admin grant ALSO covers the
// per-Azure-SQL-database Share dialog when its RG is the SAME RG as this one
// (the common single-RG / hub-only deploy where loomSqlServerRg defaults to
// loomDlzRg). Azure rejects a second RBAC-Admin assignment to the same principal
// at the same scope (RoleAssignmentExists, by principal+role+scope — name is
// irrelevant), so the parent skips the separate sql-database-share-rbac grant
// when the RGs coincide and relies on this broadened condition instead.
var sqlDbContribRoleId = '9b7fa17d-e63e-47b0-bb0a-15c516ac86ec'

// APPS-W2 (Loom Apps "Resources" tab) data-plane roles — folded into THIS
// condition for exactly the same reason as SQL DB Contributor above, and
// discovered the same way: app-resources-rbac.bicep grants RBAC-Admin to the
// SAME principal for the SAME role, and its parent scopes it at the admin-plane
// RG — which IS this RG whenever the estate is not single-DLZ. ARM enforces
// uniqueness on the (scope, principalId, roleDefinitionId) TRIPLE, so the two
// modules could never both exist: from 2026-07-18 until 2026-08-07 the
// app-resources leaf failed RoleAssignmentExists on EVERY deploy, masked only by
// the grant having been created imperatively that day. Deleting the "stray" did
// not help — this module simply recreated it and the sibling failed again.
// The five roles must match the kind registry in
// apps/fiab-console/lib/apps/app-resources.ts.
var storageBlobDataContribRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var eventHubsDataOwnerRoleId = 'f526a384-b230-433a-b45c-95f59c4a2dec'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var searchIndexDataReaderRoleId = '1407120a-92aa-4202-b7e9-c0e197c71c8f'
var cognitiveServicesOpenAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

// The full allow-list this single RBAC-Admin grant delegates. This is a
// CONSOLIDATION, not a privilege increase: every role here was already intended
// to be assignable by the Console UAMI at this scope — the set was just split
// across modules that ARM would not let coexist.
var allowedRoleIds = '{${contributorRoleId}, ${readerRoleId}, ${sqlDbContribRoleId}, ${storageBlobDataContribRoleId}, ${eventHubsDataOwnerRoleId}, ${keyVaultSecretsUserRoleId}, ${searchIndexDataReaderRoleId}, ${cognitiveServicesOpenAiUserRoleId}}'

// ABAC condition (v2.0): permit roleAssignments write AND delete ONLY when the
// targeted RoleDefinitionId is one of `allowedRoleIds`. All other roles (Owner,
// User Access Administrator, etc.) are blocked even though the UAMI holds
// RBAC-Admin. Guards both the create (Request) and remove (Resource) actions.
var rbacCondition = '((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals ${allowedRoleIds})) AND ((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/delete\'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals ${allowedRoleIds}))'

resource wsRbacAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  // guid() is deterministic — re-running after the grant exists is a no-op.
  name: guid(resourceGroup().id, consolePrincipalId, 'loom-ws-roles-rbac-admin-v1')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', rbacAdminRoleId)
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    condition: rbacCondition
    conditionVersion: '2.0'
    description: 'Loom Console UAMI: create/delete Contributor + Reader workspace role assignments (F5 Manage Access), Reader/Contributor/SQL DB Contributor per-database Share assignments, and the APPS-W2 Resources-tab data-plane roles (Storage Blob Data Contributor, Event Hubs Data Owner, Key Vault Secrets User, Search Index Data Reader, Cognitive Services OpenAI User). Constrained to those built-in roles via ABAC.'
  }
}
