// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used to create a management Virtual Machine (jumpbox)
// for DMLZ — private-only access, no public IP.
targetScope = 'resourceGroup'

// Parameters
@description('Name of the virtual machine.')
param vmName string

@description('Azure region.')
param location string

@description('Tags to apply to resources.')
param tags object = {}

@description('Operating system type.')
@allowed([
  'Windows'
  'Linux'
])
param osType string = 'Windows'

@description('VM size.')
param vmSize string = 'Standard_DS2_v2'

@description('Admin username for the VM.')
param adminUsername string

@description('Admin password for the VM. Use Key Vault reference in production.')
@secure()
param adminPassword string

@description('Subnet ID for the VM NIC (private-only, no public IP).')
param subnetId string

@description('Windows Server image reference (ignored for Linux).')
param windowsImageReference object = {
  publisher: 'MicrosoftWindowsServer'
  offer: 'WindowsServer'
  sku: '2022-datacenter-azure-edition'
  version: 'latest'
}

@description('Linux image reference (ignored for Windows).')
param linuxImageReference object = {
  publisher: 'Canonical'
  offer: '0001-com-ubuntu-server-jammy'
  sku: '22_04-lts-gen2'
  version: 'latest'
}

@description('OS disk type.')
@allowed([
  'Premium_LRS'
  'StandardSSD_LRS'
  'Standard_LRS'
])
param osDiskType string = 'Premium_LRS'

@description('OS disk size in GB. 0 uses the default image size.')
param osDiskSizeGB int = 0

@description('Enable boot diagnostics with managed storage account.')
param enableBootDiagnostics bool = true

@description('Enable auto-shutdown schedule.')
param enableAutoShutdown bool = true

@description('Auto-shutdown time in HHmm format (24-hour UTC).')
param autoShutdownTime string = '1900'

@description('Time zone for auto-shutdown (IANA format).')
param autoShutdownTimeZone string = 'UTC'

@description('Resource ID of the Log Analytics workspace for diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('Attach a CanNotDelete resource lock. Default true for production safety.')
param enableResourceLock bool = true

// Variables
var nicName = '${vmName}-nic'
var imageReference = osType == 'Windows' ? windowsImageReference : linuxImageReference
var osDiskName = '${vmName}-osdisk'

// Resources
resource nic 'Microsoft.Network/networkInterfaces@2023-11-01' = {
  name: nicName
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
        }
      }
    ]
    // No public IP — access via Bastion or VPN only.
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-03-01' = {
  name: vmName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    osProfile: {
      computerName: take(vmName, 15)
      adminUsername: adminUsername
      adminPassword: adminPassword
      linuxConfiguration: osType == 'Linux' ? {
        disablePasswordAuthentication: false
      } : null
      windowsConfiguration: osType == 'Windows' ? {
        enableAutomaticUpdates: true
        patchSettings: {
          patchMode: 'AutomaticByPlatform'
          assessmentMode: 'AutomaticByPlatform'
        }
      } : null
    }
    storageProfile: {
      imageReference: imageReference
      osDisk: {
        name: osDiskName
        createOption: 'FromImage'
        diskSizeGB: osDiskSizeGB > 0 ? osDiskSizeGB : null
        managedDisk: {
          storageAccountType: osDiskType
        }
        deleteOption: 'Delete'
      }
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
          properties: {
            deleteOption: 'Delete'
          }
        }
      ]
    }
    diagnosticsProfile: {
      bootDiagnostics: {
        enabled: enableBootDiagnostics
      }
    }
    securityProfile: {
      encryptionAtHost: true
      securityType: 'TrustedLaunch'
      uefiSettings: {
        secureBootEnabled: true
        vTpmEnabled: true
      }
    }
  }
}

// Auto-shutdown schedule — reduces cost for management VMs outside business hours.
resource autoShutdownSchedule 'Microsoft.DevTestLab/schedules@2018-09-15' = if (enableAutoShutdown) {
  name: 'shutdown-computevm-${vmName}'
  location: location
  tags: tags
  properties: {
    status: 'Enabled'
    taskType: 'ComputeVmShutdownTask'
    dailyRecurrence: {
      time: autoShutdownTime
    }
    timeZoneId: autoShutdownTimeZone
    targetResourceId: vm.id
    notificationSettings: {
      status: 'Disabled'
    }
  }
}

// Diagnostic Settings — capture VM-level metrics.
resource vmDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${vmName}-diagnostics'
  scope: vm
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// Resource lock — prevents accidental deletion of the management VM.
resource vmLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: vm
  name: '${vmName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: DMLZ management VM. Delete via the rollback workflow in docs/ROLLBACK.md.'
  }
}

// Outputs
@description('Resource ID of the virtual machine.')
output vmId string = vm.id

@description('Name of the virtual machine.')
output vmName string = vm.name

@description('Private IP address of the virtual machine.')
output privateIpAddress string = nic.properties.ipConfigurations[0].properties.privateIPAddress

@description('Managed identity principal ID.')
output managedIdentityPrincipalId string = vm.identity.principalId
