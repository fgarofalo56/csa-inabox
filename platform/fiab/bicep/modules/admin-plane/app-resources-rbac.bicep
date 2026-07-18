// CSA Loom — Loom Apps "Resources" RBAC-Administrator grant (APPS-W2)
//
// The Resources tab on a loom-app-runtime item performs one-click
// grant-and-inject: the Console BFF (lib/apps/app-resources.ts →
// attachAppResource / attachLakehouseItemResource) does a real ARM
//   PUT Microsoft.Authorization/roleAssignments/{guid}
// assigning the SHARED APPS UAMI a data-plane role on the picked backend
// (lake storage / Event Hubs namespace / Key Vault / AI Search / AOAI). The
// Console UAMI's Contributor grants do NOT include
// `Microsoft.Authorization/roleAssignments/write`, so without this module
// every attach honest-gates to pending-grants (live receipt 2026-07-18 —
// shipped imperatively that day; this module encodes it for a from-scratch
// deploy per the no-vaporware bicep-sync rule).
//
// Grants **Role Based Access Control Administrator** at THIS resource group,
// CONSTRAINED by an ARM ABAC condition to the five data-plane roles the
// Resources tab assigns — the UAMI cannot hand out Owner / Contributor /
// RBAC-Admin, preventing privilege escalation (same least-privilege shape as
// access-policy-rbac.bicep). ADX principal-assignments and Cosmos
// sqlRoleAssignments are separate resource types already covered by the
// UAMI's Contributor and are NOT classic role assignments.
//
// Wire at: the Admin Plane RG (Key Vault / AI Search / AOAI live there) AND
// each DLZ RG (lake storage + Event Hubs namespaces live there).

targetScope = 'resourceGroup'

@description('Console UAMI principalId — granted constrained RBAC Administrator on this RG so Loom-app resource attaches can assign data-plane roles to the apps UAMI. Empty string skips the grant.')
param consolePrincipalId string

@description('When true, skip the grant (re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Data-plane role GUIDs the Resources tab assigns — must match the kind
// registry in apps/fiab-console/lib/apps/app-resources.ts.
var storageBlobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var eventHubsDataOwner = 'f526a384-b230-433a-b45c-95f59c4a2dec'
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
var searchIndexDataReader = '1407120a-92aa-4202-b7e9-c0e197c71c8f'
var cognitiveServicesOpenAiUser = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

var allowedRoles = '{${storageBlobDataContributor}, ${eventHubsDataOwner}, ${keyVaultSecretsUser}, ${searchIndexDataReader}, ${cognitiveServicesOpenAiUser}}'

resource consoleAppResourcesRbacAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(resourceGroup().id, consolePrincipalId, 'app-resources-rbac-admin')
  properties: {
    // Role Based Access Control Administrator
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'f58310d9-a9f6-439a-9e8d-f62e7b41a168')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals ${allowedRoles})) AND ((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/delete\'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals ${allowedRoles}))'
  }
}
