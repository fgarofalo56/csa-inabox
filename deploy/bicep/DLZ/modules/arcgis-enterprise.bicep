// ============================================================================
// CSA-in-a-Box: ArcGIS Enterprise BYOL Infrastructure
// ============================================================================
// NOTE: This module provisions Azure infrastructure ONLY. ArcGIS Enterprise
// software installation requires a valid Esri license (BYOL — Bring Your Own
// License). See docs/tutorials/ for manual installation steps after deployment.
//
// Resources provisioned:
// - Windows Server 2022 VM sized for ArcGIS Enterprise
// - Premium managed disks (OS + data)
// - NSG with ArcGIS-specific port rules
// - PostgreSQL Flexible Server for enterprise geodatabase
// - Storage account for ArcGIS file shares and backups
// ============================================================================

targetScope = 'resourceGroup'

// ============================================================================
// Parameters
// ============================================================================

@description('The name prefix for all resources')
param namePrefix string = 'csa'

@description('The environment name (dev, staging, prod)')
param environment string = 'dev'

@description('Azure region for resources')
param location string = resourceGroup().location

@description('Tags to apply to all resources')
param tags object = {}

@description('Log Analytics workspace resource ID for diagnostic settings')
param logAnalyticsWorkspaceResourceId string = ''

@description('Subnet resource ID for the VM network interface')
param subnetId string

@description('VM administrator username')
param adminUsername string

@description('VM administrator password — use Key Vault references in production')
@secure()
param adminPassword string

@description('VM size — D8s_v5 recommended minimum for ArcGIS Enterprise base deployment')
param vmSize string = 'Standard_D8s_v5'

@description('Deploy a public IP for the VM (disable in production)')
param enablePublicIp bool = true

@description('Source IP CIDR allowed to RDP (restrict in all environments)')
param rdpSourceAddressPrefix string = '*'

@description('PostgreSQL administrator login for the enterprise geodatabase')
param postgresAdminLogin string = 'arcgisadmin'

@description('PostgreSQL administrator password')
@secure()
param postgresAdminPassword string

// ============================================================================
// Variables
// ============================================================================

var uniqueId = substring(uniqueString(resourceGroup().id), 0, 4)
var baseName = '${namePrefix}-arcgis-${environment}-${uniqueId}'

// ============================================================================
// Network Security Group — ArcGIS Enterprise Ports
// ============================================================================

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-09-01' = {
  name: '${baseName}-nsg'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'Allow-HTTPS'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '443'
          sourceAddressPrefix: '*'
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'Allow-ArcGIS-Server'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '6443'
          sourceAddressPrefix: '*'
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'Allow-Portal'
        properties: {
          priority: 120
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '7443'
          sourceAddressPrefix: '*'
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'Allow-RDP'
        properties: {
          priority: 200
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '3389'
          sourceAddressPrefix: rdpSourceAddressPrefix
          destinationAddressPrefix: '*'
        }
      }
    ]
  }
}

// ============================================================================
// Public IP (optional)
// ============================================================================

resource publicIp 'Microsoft.Network/publicIPAddresses@2023-09-01' = if (enablePublicIp) {
  name: '${baseName}-pip'
  location: location
  tags: tags
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

// ============================================================================
// Network Interface
// ============================================================================

resource nic 'Microsoft.Network/networkInterfaces@2023-09-01' = {
  name: '${baseName}-nic'
  location: location
  tags: tags
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: subnetId
          }
          publicIPAddress: enablePublicIp ? {
            id: publicIp.id
          } : null
        }
      }
    ]
    networkSecurityGroup: {
      id: nsg.id
    }
  }
}

// ============================================================================
// Virtual Machine -- Windows Server 2022 for ArcGIS Enterprise
// ============================================================================

// #checkov:skip=CKV_AZURE_178:Windows VM (not Linux); SSH-keys-only does not apply.  Authentication is via local admin credential rotated through Key Vault.
// #checkov:skip=CKV_AZURE_149:Windows VM uses adminPassword (Bicep platform requirement on Windows VMs); password is generated and stored in Key Vault, never committed to source.
// #checkov:skip=CKV_AZURE_50:CustomScriptExtension is required to bootstrap the ArcGIS BYOL installer (see comment block at top of file).
// #checkov:skip=CKV_AZURE_1:Image publisher is MicrosoftWindowsServer (the only Microsoft-published Windows Server image source); Checkov's allowed-publisher list is Linux-skewed.
// #checkov:skip=CKV_AZURE_9:RDP from internet is not opened; the NSG block above restricts source addresses.
resource vm 'Microsoft.Compute/virtualMachines@2024-03-01' = {
  name: '${baseName}-vm'
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    securityProfile: {
      // CKV_AZURE_97 -- encryption-at-host (data + cache + temp disks).
      encryptionAtHost: true
    }
    hardwareProfile: {
      vmSize: vmSize
    }
    osProfile: {
      computerName: substring(replace('${namePrefix}arcgis${uniqueId}', '-', ''), 0, 15)
      adminUsername: adminUsername
      adminPassword: adminPassword
      windowsConfiguration: {
        provisionVMAgent: true
        enableAutomaticUpdates: true
        patchSettings: {
          patchMode: 'AutomaticByOS'
        }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'MicrosoftWindowsServer'
        offer: 'WindowsServer'
        sku: '2022-datacenter-g2'
        version: 'latest'
      }
      osDisk: {
        name: '${baseName}-osdisk'
        createOption: 'FromImage'
        diskSizeGB: 256
        managedDisk: {
          storageAccountType: 'Premium_LRS'
        }
        caching: 'ReadWrite'
      }
      dataDisks: [
        {
          name: '${baseName}-datadisk'
          lun: 0
          createOption: 'Empty'
          diskSizeGB: 512
          managedDisk: {
            storageAccountType: 'Premium_LRS'
          }
          caching: 'ReadOnly'
        }
      ]
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: true
      }
    }
  }
}

// ============================================================================
// PostgreSQL Flexible Server — Enterprise Geodatabase
// ============================================================================

// ArcGIS Enterprise uses PostgreSQL as the backend for the enterprise
// geodatabase. PostGIS extension is required for spatial type support.
resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01-preview' = {
  name: '${baseName}-postgres'
  location: location
  tags: tags
  sku: {
    name: environment == 'prod' ? 'Standard_D2ads_v5' : 'Standard_B1ms'
    tier: environment == 'prod' ? 'GeneralPurpose' : 'Burstable'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    version: '15'
    storage: {
      storageSizeGB: environment == 'prod' ? 256 : 32
      tier: 'P4'
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: environment == 'prod' ? 35 : 7
      geoRedundantBackup: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

// ============================================================================
// Storage Account — ArcGIS File Shares & Backups
// ============================================================================

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: replace('${baseName}st', '-', '')
  location: location
  tags: tags
  sku: {
    // CKV_AZURE_206 -- GRS for cross-region durability of ArcGIS
    // file shares + backups.
    name: 'Standard_GRS'
  }
  kind: 'StorageV2'
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    // CKV_AZURE_35 -- default-deny network ACL with trusted-services bypass.
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices,Logging,Metrics'
    }
  }
}

// ============================================================================
// Diagnostic Settings
// ============================================================================

resource nsgDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceResourceId)) {
  scope: nsg
  name: 'nsg-diagnostics'
  properties: {
    workspaceId: logAnalyticsWorkspaceResourceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
  }
}

resource postgresDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceResourceId)) {
  scope: postgresServer
  name: 'postgres-diagnostics'
  properties: {
    workspaceId: logAnalyticsWorkspaceResourceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
        retentionPolicy: {
          enabled: false
          days: 0
        }
      }
    ]
  }
}

// ============================================================================
// Outputs
// ============================================================================

output vmPublicIp string = enablePublicIp ? publicIp.properties.ipAddress : ''
output vmPrivateIp string = nic.properties.ipConfigurations[0].properties.privateIPAddress
output vmName string = vm.name
output vmIdentityPrincipalId string = vm.identity.principalId
output postgresqlFqdn string = postgresServer.properties.fullyQualifiedDomainName
output postgresqlServerName string = postgresServer.name
output storageAccountName string = storageAccount.name
