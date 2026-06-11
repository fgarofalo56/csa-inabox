// CSA Loom — SHARED admin-zone Self-Hosted Integration Runtime (SHIR) for
// Microsoft Purview, on a scale-to-zero VMSS.
//
// WHY THIS IS A SEPARATE MODULE FROM landing-zone/shir.bicep (load-bearing):
//   A Microsoft Purview self-hosted IR CANNOT be the same runtime as an
//   ADF/Synapse SHIR. Per Microsoft Learn:
//     - "the self-hosted integration runtime must be only registered for
//        Microsoft Purview and can't be used for Azure Data Factory or Azure
//        Synapse at the same time."
//       https://learn.microsoft.com/purview/legacy/concept-best-practices-network
//     - "The Microsoft Purview Integration Runtime can't be shared with an
//        Azure Synapse Analytics or Azure Data Factory Integration Runtime on
//        the same machine. It needs to be installed on a separated machine."
//       https://learn.microsoft.com/purview/data-map-integration-runtime-self-hosted
//   So "shared" here means ONE Purview SHIR VM cluster that scans MANY Purview
//   data sources ("You can use a single self-hosted integration runtime for
//   scanning multiple data sources") — NOT a re-use of the DLZ ADF SHIR.
//
// WHY THE AUTH KEY IS A PARAM (not listAuthKeys() like the ADF SHIR):
//   A Purview SHIR is registered through the Purview SCANNING data-plane
//   (PUT {account}.purview.azure.{com|us}/scan/integrationruntimes/{name}) and
//   its node auth key is read from that data-plane — there is NO ARM
//   listAuthKeys() on Microsoft.Purview/accounts analogous to ADF's. The key
//   therefore cannot be resolved inside Bicep. The operator (or the post-deploy
//   bootstrap) creates the Purview SHIR via the scanning API and supplies its
//   key as the @secure() `purviewIrAuthKey` param. An empty key is the HONEST
//   GATE: the module is simply not deployed (same shape as shirAdminPassword on
//   the DLZ SHIR). See docs/fiab/purview-setup.md.
//
// DESIGN (mirrors landing-zone/shir.bicep's cost model):
//   - Windows 2022 VMSS in the admin hub `snet-reserved` subnet, created at
//     capacity 0 (scale-to-0 → no VM cost while idle). Loom's BFF scales it up
//     to `maxNodes` before a Purview scan that uses the SHIR, then the idle-stop
//     workflow scales it back to 0.
//   - Each node, on scale-up, runs a CustomScript extension that silently
//     installs the IR MSI and registers the node with the Purview auth key
//     (passed through encrypted protectedSettings — never in template output).
//   - The Loom Console UAMI is granted Virtual Machine Contributor on the VMSS
//     so the BFF can scale it 0↔maxNodes.
//
// NOTE (no-vaporware): the node bootstrap (MSI install + dmgcmd register) is the
// Microsoft-documented unattended SHIR install. Verified in the deployment roll,
// not locally — this module is `az bicep build`-clean only.
//   https://learn.microsoft.com/azure/data-factory/self-hosted-integration-runtime-automation-scripts

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Domain name (used for resource naming).')
param domainName string = 'default'

@description('Admin-hub subnet resource ID the Purview SHIR VMSS nodes join (private only — typically snet-reserved).')
param subnetId string

@description('Local admin username for the VMSS nodes.')
param adminUsername string = 'loompvwshir'

@description('Local admin password for the VMSS nodes (supply from Key Vault at deploy). Empty = honest gate (module not deployed).')
@secure()
param adminPassword string

@description('Target node count the scan-trigger start/stop automation scales TO. The VMSS is created at 0 (scale-to-0); this is the documented maximum cluster size.')
@minValue(1)
@maxValue(8)
param maxNodes int = 4

@description('VM size for each Purview SHIR node.')
param vmSize string = 'Standard_D4s_v5'

@description('Self-Hosted IR MSI download URL. Override at deploy to pin a version; the default points at the Microsoft Download Center current build.')
param shirMsiUrl string = 'https://download.microsoft.com/download/E/4/7/E4771905-1079-445B-8BF9-8A1A075D8A10/IntegrationRuntime_5.50.9171.1.msi'

@description('Purview self-hosted IR node auth key (authKey1) from the Purview scanning data plane. Read it from the Purview governance portal (Data Map → Source management → Integration runtimes) or the scanning API, then pass it (or store in Key Vault). Empty = honest gate (module not deployed).')
@secure()
param purviewIrAuthKey string

@description('Loom Console UAMI principal ID — granted Virtual Machine Contributor on the VMSS so Loom can scale it 0↔maxNodes.')
param consolePrincipalId string

@description('Skip role-assignment grants (avoid RoleAssignmentExists on re-provision).')
param skipRoleGrants bool = false

@description('Log Analytics workspace ID for diagnostic settings.')
param workspaceId string

@description('Compliance tags applied to every resource.')
param complianceTags object

// Node bootstrap: install the IR MSI silently, then register this node with the
// Purview auth key. Runs per-instance on scale-up. The key lives only in
// encrypted protectedSettings. Up to maxNodes register against the Purview IR
// for high availability. dmgcmd -RegisterNewNode is the SAME unattended command
// the ADF SHIR uses; only the key differs (a Purview-issued key, not ADF's).
var bootstrapPs = 'powershell -ExecutionPolicy Unrestricted -Command "$ErrorActionPreference=\'Stop\'; $msi=\\"$env:TEMP\\IntegrationRuntime.msi\\"; Invoke-WebRequest -Uri \'${shirMsiUrl}\' -OutFile $msi -UseBasicParsing; Start-Process msiexec.exe -ArgumentList \'/i\',$msi,\'/quiet\',\'/norestart\' -Wait; $dmg=\'C:\\Program Files\\Microsoft Integration Runtime\\5.0\\Shared\\dmgcmd.exe\'; & $dmg -RegisterNewNode \'${purviewIrAuthKey}\'"'

// =====================================================================
// VMSS — scale-to-0 Purview SHIR cluster
// =====================================================================

resource vmss 'Microsoft.Compute/virtualMachineScaleSets@2024-07-01' = {
  name: 'vmss-loom-pvw-shir-${domainName}'
  location: location
  tags: complianceTags
  sku: {
    name: vmSize
    tier: 'Standard'
    capacity: 0 // scale-to-0: no VM cost while idle. Loom scales up to maxNodes before a scan.
  }
  identity: { type: 'SystemAssigned' }
  properties: {
    overprovision: false
    singlePlacementGroup: false
    upgradePolicy: { mode: 'Manual' }
    virtualMachineProfile: {
      osProfile: {
        computerNamePrefix: 'pvwshir'
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
            name: 'nic-pvwshir'
            properties: {
              primary: true
              // Private only — the SHIR reaches Purview over the hub; no public IP.
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
            name: 'install-purview-shir'
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

resource consoleVmssContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(consolePrincipalId)) {
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

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: vmss
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output vmssId string = vmss.id
output vmssName string = vmss.name
output maxNodes int = maxNodes
