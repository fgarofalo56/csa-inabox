// CSA Loom DLZ — per-workspace user-assigned managed identity (DORMANT / opt-in)
//
// Phase-1 §2.4 per-workspace identity. This module is ADDITIVE and DORMANT: the
// default Loom path keeps running as the SHARED Console UAMI. When a workspace
// is given its own identity (uami-ws-<workspaceId>), the BFF's
// workspace-identity-client.getWorkspaceCredential(workspaceId) picks it up; if
// it does not exist the client silently falls back to the shared UAMI, so
// behaviour is unchanged until a topology deploy provisions one.
//
// Azure-native trusted-workspace-access: instead of opening the PE-only lake to
// the public, this UAMI is granted Storage Blob Data Contributor scoped to ONE
// lake container, and a networkAcls.resourceAccessRules resource-instance rule
// admits that identity through the storage firewall — the Azure parity for
// Fabric per-workspace identity / managed private access (no Fabric dependency,
// no-fabric-dependency.md).
//
// CAP: a storage account allows AT MOST 200 resourceAccessRules. A per-workspace
// UAMI per account therefore tops out at ~200 workspaces. The 60k-workspace
// target is reached by sharding into per-DOMAIN shared lakes (200 workspaces x
// 300 domains ~= 60k), NOT one giant account — provision this against the
// per-domain lake, and bind the network rule behind addNetworkRule so re-deploys
// never clobber the shared account's existing rules.

targetScope = 'resourceGroup'

@description('Workspace id this identity belongs to. Drives the name uami-ws-<workspaceId>; the client reads the same name.')
param workspaceId string

@description('Lake (ADLS Gen2) storage account name that backs this workspace. The container grant + firewall rule scope to it.')
param lakeAccountName string

@description('Lake container this workspace can read/write. Role is scoped to this single container (least privilege).')
param container string = 'workspaces'

@description('Primary region')
param location string

@description('Compliance tags applied to the identity.')
param complianceTags object = {}

@description('Skip the Storage Blob Data Contributor grant — set true on re-deploy to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Add the firewall resource-instance rule. Default false so a dormant deploy never clobbers the shared lake networkAcls; set true only on the per-domain lake that is dedicated to per-workspace access (<=200 rules/account).')
param addNetworkRule bool = false

// Storage Blob Data Contributor (built-in, global GUID, all clouds).
var blobDataContributorGuid = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource uami 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'uami-ws-${workspaceId}'
  location: location
  tags: complianceTags
}

resource lake 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: lakeAccountName
}

resource lakeBlob 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' existing = {
  parent: lake
  name: 'default'
}

resource lakeContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' existing = {
  parent: lakeBlob
  name: container
}

// Per-workspace UAMI → Storage Blob Data Contributor on ONE container.
resource wsBlobGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  scope: lakeContainer
  name: guid(lakeContainer.id, uami.id, blobDataContributorGuid)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorGuid)
    principalId: uami.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Trusted-workspace-access: admit this identity through the storage firewall.
// CAP <=200 rules/account -> per-domain shared lakes scale to ~60k workspaces.
// kind/sku restate the lake defaults so the conditional update is firewall-only.
resource lakeFirewall 'Microsoft.Storage/storageAccounts@2023-01-01' = if (addNetworkRule) {
  name: lakeAccountName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_ZRS' }
  properties: {
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
      resourceAccessRules: [
        {
          tenantId: subscription().tenantId
          resourceId: uami.id
        }
      ]
    }
  }
}

output uamiId string = uami.id
output uamiClientId string = uami.properties.clientId
output uamiPrincipalId string = uami.properties.principalId
output uamiName string = uami.name
