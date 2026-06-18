// CSA Loom DLZ — scaled Self-Hosted Integration Runtime (SHIR) on a VMSS.
//
// The operator wants a shared, scaled-out self-hosted IR that costs nothing when
// idle: a 4-node cluster that sits at ZERO instances by default and is spun up
// only when a (scheduled) pipeline needs it, then scaled back to zero.
//
// Design:
//   - A SelfHosted integration runtime is registered on the DLZ Data Factory
//     (Microsoft.DataFactory/factories/integrationRuntimes, type 'SelfHosted').
//   - A Windows VMSS in the DLZ workloads subnet hosts the IR nodes. It is
//     created at capacity 0 (scale-to-0 → no VM cost while idle). `maxNodes`
//     (default 4) is the target the Loom start/stop automation scales TO when a
//     pipeline runs; this module only stamps the infrastructure.
//   - Each node, when created (i.e. on scale-up), runs a CustomScript extension
//     that silently installs the IR MSI and registers the node with the IR auth
//     key (fetched here via listAuthKeys() and passed through protectedSettings,
//     so the key is encrypted and never appears in template output).
//   - The Loom Console UAMI is granted Virtual Machine Contributor on the VMSS
//     so the BFF / pipeline start-activity can scale it 0↔maxNodes.
//
// NOTE (no-vaporware): the VMSS node bootstrap (MSI install + dmgcmd register)
// is the Microsoft-documented unattended SHIR install. It is verified in the
// deployment roll, not locally — this module is `az bicep build`-clean only.
//   https://learn.microsoft.com/azure/data-factory/self-hosted-integration-runtime-automation-scripts

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Domain name (used for resource naming).')
param domainName string = 'default'

@description('Name of the existing DLZ Data Factory to register the IR on.')
param dataFactoryName string

@description('DLZ workloads subnet resource ID the VMSS nodes join.')
param subnetId string

@description('Local admin username for the VMSS nodes.')
param adminUsername string = 'loomshir'

@description('Local admin password for the VMSS nodes (supply from Key Vault at deploy).')
@secure()
param adminPassword string

@description('Target node count the start/stop automation scales TO. The VMSS is created at 0 (scale-to-0); this is the documented maximum cluster size.')
@minValue(1)
@maxValue(8)
param maxNodes int = 4

@description('VM size for each SHIR node.')
param vmSize string = 'Standard_D4s_v5'

@description('Self-Hosted IR MSI download URL. Override at deploy to pin a version; the default points at the Microsoft Download Center current build.')
param shirMsiUrl string = 'https://download.microsoft.com/download/E/4/7/E4771905-1079-445B-8BF9-8A1A075D8A10/IntegrationRuntime_5.50.9171.1.msi'

@description('Loom Console UAMI principal ID — granted Virtual Machine Contributor on the VMSS so Loom can scale it 0↔maxNodes.')
param consolePrincipalId string

@description('Skip role-assignment grants (avoid RoleAssignmentExists on re-provision).')
param skipRoleGrants bool = false

@description('Log Analytics workspace ID for diagnostic settings. Empty (dlz-attach with no hub LAW coordinate) skips the diagnostic settings.')
param workspaceId string = ''

@description('Compliance tags applied to every resource.')
param complianceTags object

// =====================================================================
// Self-Hosted IR on the existing Data Factory
// =====================================================================

resource adf 'Microsoft.DataFactory/factories@2018-06-01' existing = {
  name: dataFactoryName
}

resource shir 'Microsoft.DataFactory/factories/integrationRuntimes@2018-06-01' = {
  parent: adf
  name: 'shir-loom-${domainName}'
  properties: {
    type: 'SelfHosted'
    description: 'CSA Loom scaled self-hosted IR — VMSS-backed, scale-to-0. Target ${maxNodes} nodes.'
  }
}

// Node bootstrap: install the IR MSI silently, then register this node with the
// auth key. Runs per-instance on scale-up. The key lives only in encrypted
// protectedSettings. High-availability: up to maxNodes register against the IR.
var registerKey = shir.listAuthKeys().authKey1
var bootstrapPs = 'powershell -ExecutionPolicy Unrestricted -Command "$ErrorActionPreference=\'Stop\'; $msi=\\"$env:TEMP\\IntegrationRuntime.msi\\"; Invoke-WebRequest -Uri \'${shirMsiUrl}\' -OutFile $msi -UseBasicParsing; Start-Process msiexec.exe -ArgumentList \'/i\',$msi,\'/quiet\',\'/norestart\' -Wait; $dmg=\'C:\\Program Files\\Microsoft Integration Runtime\\5.0\\Shared\\dmgcmd.exe\'; & $dmg -RegisterNewNode \'${registerKey}\'"'

// =====================================================================
// VMSS — scale-to-0 SHIR cluster
// =====================================================================

resource vmss 'Microsoft.Compute/virtualMachineScaleSets@2024-07-01' = {
  name: 'vmss-loom-shir-${domainName}'
  location: location
  tags: complianceTags
  sku: {
    name: vmSize
    tier: 'Standard'
    capacity: 0 // scale-to-0: no VM cost while idle. Loom scales up to maxNodes on demand.
  }
  identity: { type: 'SystemAssigned' }
  properties: {
    overprovision: false
    singlePlacementGroup: false
    upgradePolicy: { mode: 'Manual' }
    virtualMachineProfile: {
      osProfile: {
        computerNamePrefix: 'loomshir'
        adminUsername: adminUsername
        adminPassword: adminPassword
        windowsConfiguration: {
          enableAutomaticUpdates: true
          provisionVMAgent: true
        }
      }
      storageProfile: {
        imageReference: {
          publisher: 'MicrosoftWindowsServer'
          offer: 'WindowsServer'
          sku: '2022-datacenter-azure-edition'
          version: 'latest'
        }
        osDisk: {
          createOption: 'FromImage'
          caching: 'ReadWrite'
          managedDisk: { storageAccountType: 'Premium_LRS' }
        }
      }
      networkProfile: {
        networkInterfaceConfigurations: [
          {
            name: 'nic-loomshir'
            properties: {
              primary: true
              // Private only — the SHIR reaches Azure over the spoke; no public IP.
              ipConfigurations: [
                {
                  name: 'ipconfig'
                  properties: {
                    subnet: { id: subnetId }
                  }
                }
              ]
            }
          }
        ]
      }
      extensionProfile: {
        extensions: [
          {
            name: 'install-shir'
            properties: {
              publisher: 'Microsoft.Compute'
              type: 'CustomScriptExtension'
              typeHandlerVersion: '1.10'
              autoUpgradeMinorVersion: true
              // Whole command (including the auth key) is encrypted in transit + at rest.
              protectedSettings: {
                commandToExecute: bootstrapPs
              }
            }
          }
        ]
      }
    }
  }
}

// =====================================================================
// RBAC — Loom Console UAMI → Virtual Machine Contributor on the VMSS
// (built-in role: 9980e02c-c2be-4d73-94e8-173b1dc7cf3c) so Loom can scale it.
// =====================================================================

resource consoleVmssContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  scope: vmss
  name: guid(vmss.id, consolePrincipalId, '9980e02c-c2be-4d73-94e8-173b1dc7cf3c')
  properties: {
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '9980e02c-c2be-4d73-94e8-173b1dc7cf3c')
  }
}

// =====================================================================
// Diagnostic settings → standardized Loom LAW
// =====================================================================

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: vmss
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output integrationRuntimeName string = shir.name
output vmssId string = vmss.id
output vmssName string = vmss.name
output maxNodes int = maxNodes
