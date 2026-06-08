// CSA Loom — Console UAMI → Role Based Access Control Administrator on the
// DLZ ADLS Gen2 storage account.
//
// Required so the F21 label→RBAC enforcement (enforceLabelRbac →
// enforceAccessGrant → grantContainerRole) can CREATE / REVOKE Azure RBAC role
// assignments on the backing storage container when a protected sensitivity
// label is applied or changed. Without this role the ARM PUT to
// Microsoft.Authorization/roleAssignments returns 403 and the editor shows an
// honest gate naming this module.
//
// Role: Role Based Access Control Administrator
//       (f58310d9-a9f6-439a-9e8d-f62e7b41a168) — a constrained role that can
//       only assign the Storage Blob Data Reader/Contributor/Owner roles used
//       by label enforcement (its conditions are managed by the platform; this
//       built-in role id is cloud-agnostic across Commercial / GCC / GCC-High /
//       IL5). Scoped to the single DLZ storage account, not the subscription.
//
// Cross-RG constraint: the DLZ ADLS account commonly lives in a different RG
// from the admin plane, so this is a dedicated RG-scoped module invoked with
// scope: resourceGroup(loomDlzRg) — same pattern as adx-mi-storage-rbac.bicep
// and scaling-rbac.bicep (avoids BCP139/BCP120).

targetScope = 'resourceGroup'

@description('DLZ ADLS Gen2 storage account name in this resource group. Empty = skip.')
param storageAccountName string

@description('Console UAMI principal ID (start-time-known param for the role-assignment name). Empty = skip.')
param consolePrincipalId string

@description('When true, skip the role grant (re-deploy where RBAC exists or deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

var rbacAdminRoleId = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'

resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {
  name: storageAccountName
}

resource labelRbacAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(storageAccountName) && !empty(consolePrincipalId) && !skipRoleGrants) {
  scope: sa
  name: guid(sa.id, consolePrincipalId, rbacAdminRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', rbacAdminRoleId)
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}
