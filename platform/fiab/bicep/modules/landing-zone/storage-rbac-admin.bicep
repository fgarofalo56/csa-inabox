// Grants the Console UAMI "Role Based Access Control Administrator" on the DLZ
// ADLS Gen2 storage account, CONSTRAINED by an ABAC condition so it can ONLY
// delegate the three Storage Blob Data roles (Reader / Contributor / Owner).
//
// Why this exists (F16 — access-request approval final tier):
//   When the access provider approves a request, the BFF calls
//   grantContainerRole (lib/azure/adls-client.ts), which issues an ARM PUT
//   .../roleAssignments/{guid}?api-version=2022-04-01 on the container scope.
//   The Console UAMI today holds only "Storage Blob Data Reader" (data plane);
//   it has NO Microsoft.Authorization/roleAssignments/write, so every grant
//   would fail with HTTP 403 ("does not have authorization to perform action
//   'Microsoft.Authorization/roleAssignments/write'"). This module closes that
//   gap with the LEAST privilege that still works.
//
// Least-privilege design:
//   - Role: "Role Based Access Control Administrator"
//       (f58310d9-a9f6-439a-9e8d-f62e7b41a168) — narrower than Owner /
//       User Access Administrator; built for delegated, constrained grants.
//   - ABAC condition (v2.0): the UAMI may write a roleAssignment ONLY when the
//       assigned RoleDefinitionId is one of the three Storage Blob Data roles,
//       and may delete a roleAssignment ONLY when the existing assignment uses
//       one of them. It therefore CANNOT escalate itself or anyone to Owner,
//       Contributor, RBAC Admin, etc. — it can only hand out Storage Blob Data
//       Reader/Contributor/Owner on this one storage account.
//
// No Microsoft Fabric dependency — pure Azure ARM. Sovereign clouds (GCC-High /
// IL5) use the SAME built-in role GUIDs; only the ARM endpoint differs and that
// is handled by the deployment cloud, not this template.

targetScope = 'resourceGroup'

@description('DLZ ADLS Gen2 storage account name backing lakehouse containers.')
param storageAccountName string

@description('Console UAMI principal (object) id. Empty = skip the grant.')
param consolePrincipalId string = ''

@description('When true, skip the role grant (re-deploy / deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Role Based Access Control Administrator (built-in, global GUID, all clouds).
var rbacAdminRoleId = 'f58310d9-7bc6-4b1c-aba1-92e7d7b23c8f'

// Storage Blob Data Reader / Contributor / Owner (built-in, global GUIDs).
var blobDataReaderGuid = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
var blobDataContributorGuid = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var blobDataOwnerGuid = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'

// ABAC v2.0 condition: allow roleAssignments/write ONLY for the three Blob Data
// roles, and allow roleAssignments/delete ONLY when the existing assignment
// uses one of them. Anything else is denied — the UAMI cannot self-escalate.
var blobOnlyCondition = '((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${blobDataReaderGuid}, ${blobDataContributorGuid}, ${blobDataOwnerGuid}})) AND ((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/delete\'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${blobDataReaderGuid}, ${blobDataContributorGuid}, ${blobDataOwnerGuid}}))'

resource sa 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName
}

resource consoleRbacAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(sa.id, consolePrincipalId, rbacAdminRoleId, 'storage-blob-data-only')
  scope: sa
  properties: {
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', rbacAdminRoleId)
    condition: blobOnlyCondition
    conditionVersion: '2.0'
    description: 'Console UAMI constrained RBAC Administrator — delegates Storage Blob Data Reader/Contributor/Owner only (F16 access-request approval final tier).'
  }
}
