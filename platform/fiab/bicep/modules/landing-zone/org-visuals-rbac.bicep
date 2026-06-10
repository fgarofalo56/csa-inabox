// CSA Loom — Console UAMI data-plane grants for the org-visuals Blob container
// (F22 embed codes + F23 organizational visuals).
//
// Two least-privilege grants on the DLZ ADLS Gen2 storage account:
//
//   1. Storage Blob Data Contributor — SCOPED TO THE org-visuals CONTAINER.
//      Lets the Console BFF upload / read / delete custom-visual bundles and
//      embed-manifest blobs (lib/clients/org-visuals-client.ts +
//      embed-codes-client.ts → adls-client.uploadBlob / deletePath). Container
//      scope, not account scope, so the grant cannot touch bronze/silver/gold.
//
//   2. Storage Blob Delegator — SCOPED TO THE STORAGE ACCOUNT.
//      Required so getUserDelegationKey() succeeds when minting the read-only
//      user-delegation SAS embed URL (adls-client.generateReadSasUrl). Per
//      Microsoft Learn, generateUserDelegationKey acts at account level and a
//      data role scoped to a container is NOT sufficient on its own; the
//      least-privileged role that adds it at account scope is Storage Blob
//      Delegator. It grants NO data access — only the delegation-key action.
//
// No Microsoft Fabric / Power BI dependency — pure Azure Blob Storage. Sovereign
// clouds (GCC / GCC-High / IL5) use the SAME built-in role GUIDs; only the ARM
// endpoint differs and that is handled by the deployment cloud, not this
// template. Mirrors databricks-storage-rbac.bicep / label-rbac-grants.bicep.

targetScope = 'resourceGroup'

@description('DLZ ADLS Gen2 storage account name backing the org-visuals container.')
param storageAccountName string

@description('Console UAMI principal (object) id. Empty = skip the grants.')
param consolePrincipalId string = ''

@description('When true, skip the role grants (re-deploy / deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

@description('Blob container holding org-visuals bundles + embed manifests.')
param containerName string = 'org-visuals'

// Built-in role GUIDs (global / cloud-agnostic).
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var storageBlobDelegatorRoleId = 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'

resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {
  name: storageAccountName
}

resource orgVisualsContainerRes 'Microsoft.Storage/storageAccounts/blobServices/containers@2024-01-01' existing = {
  name: '${storageAccountName}/default/${containerName}'
}

// 1. Storage Blob Data Contributor — scoped to the org-visuals container.
resource consoleBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(sa.id, consolePrincipalId, storageBlobDataContributorRoleId, containerName)
  scope: orgVisualsContainerRes
  properties: {
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    description: 'Console UAMI — upload/read/delete org-visuals bundles + embed manifests (F22/F23).'
  }
}

// 2. Storage Blob Delegator — account scope (getUserDelegationKey for SAS).
resource consoleBlobDelegator 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(sa.id, consolePrincipalId, storageBlobDelegatorRoleId)
  scope: sa
  properties: {
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDelegatorRoleId)
    description: 'Console UAMI — getUserDelegationKey to mint read-only embed-code SAS URLs (F22).'
  }
}
