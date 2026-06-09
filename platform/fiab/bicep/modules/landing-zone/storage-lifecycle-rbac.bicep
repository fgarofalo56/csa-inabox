// Grants the Console UAMI "Storage Account Contributor" on the DLZ ADLS Gen2
// storage account so the BFF can read and write blob lifecycle management
// policies via the ARM management plane (PUT/GET managementPolicies/default)
// AND bind customer-managed keys (PATCH encryption.keyVaultProperties — F14).
//
// Why this exists (OneLake Lifecycle Management rules editor + F14 CMK):
//   The lifecycle editor calls setLifecyclePolicy / getLifecyclePolicy
//   (lib/azure/adls-client.ts) → ARM
//   GET/PUT .../managementPolicies/default?api-version=2023-05-01.
//   The CMK pane calls bindStorageCmk (lib/clients/cmk-client.ts) → ARM
//   PATCH .../storageAccounts/{name}?api-version=2023-05-01 on encryption.*.
//   BOTH require Microsoft.Storage/storageAccounts/write, which the Console
//   UAMI's data-plane roles (Storage Blob Data Reader/Owner) do NOT include, so
//   every write returns HTTP 403. This module closes that gap; when the role is
//   absent each editor falls back to an honest MessageBar naming this role.
//
//   The SAME role + principal + scope tuple covers both features, so a single
//   assignment is emitted when EITHER feature is enabled (a second assignment
//   with the same tuple would fail with RoleAssignmentExists).
//
// Role: Storage Account Contributor (17d1049b-9a84-46fb-8f53-869881c3d3ab)
//   Required actions: Microsoft.Storage/storageAccounts/managementPolicies/write
//   and Microsoft.Storage/storageAccounts/write (encryption settings).
//   NOTE: this built-in role also grants account-key listing (listKeys/action).
//   For least-privilege IL5 deployments, evaluate a custom role limited to
//   managementPolicies + encryption read/write; documented in the runbook.
//
// No Microsoft Fabric / Power BI dependency — pure Azure ARM (per
// no-fabric-dependency.md). The role GUID is global across Commercial, GCC,
// GCC-High and IL5; only the ARM endpoint differs and that is handled by the
// deployment cloud, not this template.

targetScope = 'resourceGroup'

@description('DLZ ADLS Gen2 storage account name backing the OneLake lifecycle policies / CMK bind.')
param storageAccountName string

@description('Console UAMI principal (object) id. Empty = skip the grant.')
param consolePrincipalId string = ''

@description('Enable the lifecycle-write grant. Set true when the OneLake Lifecycle Management feature is in use.')
param consolePrincipalNeedsLifecycleWrite bool = false

@description('Enable the CMK-bind grant (F14). Set true when Customer-Managed Keys are in use. Shares the same Storage Account Contributor role as the lifecycle grant — one assignment covers both.')
param consolePrincipalNeedsCmkBind bool = false

@description('When true, skip the role grant (re-deploy / deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Storage Account Contributor — built-in, global GUID (all Azure clouds).
var storageAccountContributorRoleId = '17d1049b-9a84-46fb-8f53-869881c3d3ab'

resource sa 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName
}

resource lifecyclePolicyGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && (consolePrincipalNeedsLifecycleWrite || consolePrincipalNeedsCmkBind) && !skipRoleGrants) {
  name: guid(sa.id, consolePrincipalId, storageAccountContributorRoleId, 'lifecycle-policy-v1')
  scope: sa
  properties: {
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageAccountContributorRoleId)
    description: 'Console UAMI: read/write ADLS Gen2 lifecycle management policies (managementPolicies/default) and PATCH encryption.keyVaultProperties for customer-managed keys (F14).'
  }
}
