// CSA Loom — Access-policy RBAC-Administrator grant (F8 / T14)
//
// When an access request against a data product is APPROVED, the Console BFF
// (lib/azure/access-policy-client.ts → enforceAccessGrant → grantContainerRole
// in lib/azure/adls-client.ts) performs a real ARM
//   PUT Microsoft.Authorization/roleAssignments/{guid}
// at the ADLS container scope, assigning the requester one of the three
// Storage Blob Data roles (Reader / Contributor / Owner). The Console UAMI's
// existing grants (RG Contributor on the admin plane, Reader at sub scope) do
// NOT include `Microsoft.Authorization/roleAssignments/write`, so without this
// module every approval would fail 403.
//
// We grant **Role Based Access Control Administrator** (f58310d9-...), scoped to
// the DLZ lake storage account ONLY (not the RG), and CONSTRAINED by an ARM
// ABAC condition so the UAMI may only create/delete assignments for the three
// Storage Blob Data data-plane roles — it cannot escalate privilege by handing
// out Owner/Contributor/RBAC-Admin. This is the least-privilege shape Microsoft
// documents for delegating data-plane role management.
//
// Split into its own module (vs. inlined in main.bicep) so consolePrincipalId —
// a module OUTPUT in main.bicep — is a start-time-known param here, satisfying
// the role-assignment name/if requirements (avoids BCP177).

targetScope = 'resourceGroup'

@description('Console UAMI principalId — granted RBAC Administrator (constrained to Storage Blob Data roles) on the lake storage account so access-request approvals can assign container-scoped grants. Empty string skips the grant.')
param consolePrincipalId string

@description('Name of the DLZ lake ADLS Gen2 storage account that holds the data-product containers.')
param storageAccountName string

@description('When true, skip all role grants (re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Storage Blob Data role definition GUIDs — must match BLOB_DATA_ROLES in
// apps/fiab-console/lib/azure/adls-client.ts.
var blobDataReader = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
var blobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var blobDataOwner = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'

resource sa 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

// Role Based Access Control Administrator — f58310d9-460d-4a3a-8ad5-3a9e8e27a52d
// ABAC condition: writes/deletes of role assignments are permitted ONLY when the
// assigned role is one of the three Storage Blob Data roles. Any other role
// (Owner, Contributor, RBAC-Admin, …) is denied — preventing privilege
// escalation while still letting enforceAccessGrant provision data-plane access.
resource consoleRbacAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(sa.id, consolePrincipalId, 'access-policy-rbac-admin')
  scope: sa
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'f58310d9-460d-4a3a-8ad5-3a9e8e27a52d')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${blobDataReader}, ${blobDataContributor}, ${blobDataOwner}})) AND ((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/delete\'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${blobDataReader}, ${blobDataContributor}, ${blobDataOwner}}))'
  }
}
