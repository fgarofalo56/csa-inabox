// CSA Loom — MCP catalog Azure Files share + Container Apps environment storage.
//
// Catalog-deployed MCP servers (the air-gap-safe filesystem/git/memory servers)
// benefit from a persistent volume. This module provisions:
//   1. A hardened StorageV2 account (HTTPS-only, TLS1.2, no public blob access).
//   2. An Azure Files share for MCP working data.
//   3. A Microsoft.App/managedEnvironments/storages child on the existing
//      Container Apps environment, exposing the share as a named env storage.
//      Deployed MCP container apps reference it via template.volumes[] +
//      volumeMounts[] at /data (see lib/azure/mcp-deploy-client.ts).
//
// The storage account KEY is read at deploy time via listKeys() and passed to
// the managedEnvironments/storages azureFile.accountKey — it is NEVER emitted as
// an output (gitleaks/checkov clean). No Microsoft Fabric dependency — plain
// Azure Files + Container Apps (no-fabric-dependency.md).
//
// Grounded in Microsoft Learn:
//   Use Azure Files storage mounts in Container Apps
//   https://learn.microsoft.com/azure/container-apps/storage-mounts-azure-files
//   Microsoft.App/managedEnvironments/storages (azureFile)
//   https://learn.microsoft.com/azure/templates/microsoft.app/managedenvironments/storages

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Name of the EXISTING Container Apps managed environment (cae-csa-loom-<region>). The storages child is attached to it.')
param caeName string

@description('Azure Files share name for MCP working data.')
param fileShareName string = 'mcp-data'

@description('Name of the managedEnvironments/storages entry MCP container apps mount (LOOM_MCP_STORAGE_NAME).')
param envStorageName string = 'mcp-data'

@description('Provisioned share quota in GiB.')
param shareQuotaGiB int = 100

@description('Compliance tags')
param complianceTags object

resource sa 'Microsoft.Storage/storageAccounts@2024-01-01' = {
  name: take('samcp${uniqueString(resourceGroup().id, 'mcp-catalog')}', 24)
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowSharedKeyAccess: true // required: Container Apps Azure Files mounts use the account key
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2024-01-01' = {
  parent: sa
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2024-01-01' = {
  parent: fileService
  name: fileShareName
  properties: {
    shareQuota: shareQuotaGiB
    enabledProtocols: 'SMB'
  }
}

// Existing Container Apps environment — the storages child hangs off it.
resource cae 'Microsoft.App/managedEnvironments@2025-02-02-preview' existing = {
  name: caeName
}

resource envStorage 'Microsoft.App/managedEnvironments/storages@2025-02-02-preview' = {
  parent: cae
  name: envStorageName
  properties: {
    azureFile: {
      accountName: sa.name
      accountKey: sa.listKeys().keys[0].value
      shareName: share.name
      accessMode: 'ReadWrite'
    }
  }
}

output storageAccountName string = sa.name
output fileShareName string = share.name
// The env-storage NAME (not the key) — wired to LOOM_MCP_STORAGE_NAME so the
// deploy route can attach it as a volume.
output envStorageName string = envStorage.name
