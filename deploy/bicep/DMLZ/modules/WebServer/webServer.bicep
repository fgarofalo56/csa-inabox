// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// This template is used to create a Windows VMSS-based IIS web server
// for DMLZ legacy workloads — internal load balancer, auto-scale, no public IP.
targetScope = 'resourceGroup'

// Parameters
@description('Name prefix for the VMSS and related resources.')
param vmssName string

@description('Azure region.')
param location string

@description('Tags to apply to resources.')
param tags object = {}

@description('VM size for VMSS instances.')
param vmSize string = 'Standard_DS2_v2'

@description('Admin username for VMSS instances.')
param adminUsername string

@description('Admin password for VMSS instances. Use Key Vault reference in production.')
@secure()
param adminPassword string

@description('Subnet ID for the VMSS instances.')
param subnetId string

@description('Subnet ID for the internal load balancer frontend. Typically the same as subnetId.')
param lbSubnetId string = ''

@description('Minimum number of VMSS instances.')
@minValue(1)
@maxValue(100)
param minInstanceCount int = 2

@description('Maximum number of VMSS instances.')
@minValue(1)
@maxValue(100)
param maxInstanceCount int = 10

@description('Default number of VMSS instances.')
@minValue(1)
@maxValue(100)
param defaultInstanceCount int = 2

@description('CPU percentage threshold for scale-out.')
param scaleOutCpuThreshold int = 75

@description('CPU percentage threshold for scale-in.')
param scaleInCpuThreshold int = 25

@description('OS disk type.')
@allowed([
  'Premium_LRS'
  'StandardSSD_LRS'
  'Standard_LRS'
])
param osDiskType string = 'Premium_LRS'

@description('Windows Server image reference.')
param imageReference object = {
  publisher: 'MicrosoftWindowsServer'
  offer: 'WindowsServer'
  sku: '2022-datacenter-azure-edition'
  version: 'latest'
}

@description('Health probe path for the load balancer.')
param healthProbePath string = '/'

@description('Health probe port.')
param healthProbePort int = 80

@description('Resource ID of the Log Analytics workspace for diagnostics.')
param logAnalyticsWorkspaceId string = ''

@description('Attach a CanNotDelete resource lock. Default true for production safety.')
param enableResourceLock bool = true

// Variables
var lbName = '${vmssName}-lb'
var lbFrontendName = '${vmssName}-lb-frontend'
var lbBackendPoolName = '${vmssName}-lb-backend'
var lbProbeName = '${vmssName}-lb-probe'
var lbRuleName = '${vmssName}-lb-rule-http'
var autoscaleSettingName = '${vmssName}-autoscale'
var effectiveLbSubnetId = !empty(lbSubnetId) ? lbSubnetId : subnetId

// IIS setup script — installs IIS via DISM, enables default site.
var iisSetupScript = 'powershell -ExecutionPolicy Unrestricted -Command "Install-WindowsFeature -Name Web-Server -IncludeManagementTools; Set-Content -Path C:\\inetpub\\wwwroot\\index.html -Value \'DMLZ Web Server Ready\'"'

// Resources

// Internal Load Balancer — no public IP, accessible only within the VNet.
resource lb 'Microsoft.Network/loadBalancers@2023-11-01' = {
  name: lbName
  location: location
  tags: tags
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    frontendIPConfigurations: [
      {
        name: lbFrontendName
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: effectiveLbSubnetId
          }
        }
      }
    ]
    backendAddressPools: [
      {
        name: lbBackendPoolName
      }
    ]
    probes: [
      {
        name: lbProbeName
        properties: {
          protocol: 'Http'
          port: healthProbePort
          requestPath: healthProbePath
          intervalInSeconds: 15
          numberOfProbes: 2
          probeThreshold: 1
        }
      }
    ]
    loadBalancingRules: [
      {
        name: lbRuleName
        properties: {
          frontendIPConfiguration: {
            id: resourceId('Microsoft.Network/loadBalancers/frontendIPConfigurations', lbName, lbFrontendName)
          }
          backendAddressPool: {
            id: resourceId('Microsoft.Network/loadBalancers/backendAddressPools', lbName, lbBackendPoolName)
          }
          probe: {
            id: resourceId('Microsoft.Network/loadBalancers/probes', lbName, lbProbeName)
          }
          protocol: 'Tcp'
          frontendPort: 80
          backendPort: 80
          enableFloatingIP: false
          idleTimeoutInMinutes: 4
          disableOutboundSnat: true
        }
      }
    ]
  }
}

// VM Scale Set — Windows Server with IIS
resource vmss 'Microsoft.Compute/virtualMachineScaleSets@2024-03-01' = {
  name: vmssName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: vmSize
    tier: 'Standard'
    capacity: defaultInstanceCount
  }
  properties: {
    overprovision: true
    upgradePolicy: {
      mode: 'Automatic'
    }
    automaticRepairsPolicy: {
      enabled: true
      gracePeriod: 'PT30M'
    }
    virtualMachineProfile: {
      osProfile: {
        computerNamePrefix: take(vmssName, 9)
        adminUsername: adminUsername
        adminPassword: adminPassword
        windowsConfiguration: {
          enableAutomaticUpdates: true
          patchSettings: {
            patchMode: 'AutomaticByPlatform'
            assessmentMode: 'AutomaticByPlatform'
          }
        }
      }
      storageProfile: {
        imageReference: imageReference
        osDisk: {
          createOption: 'FromImage'
          caching: 'ReadWrite'
          managedDisk: {
            storageAccountType: osDiskType
          }
        }
      }
      networkProfile: {
        networkInterfaceConfigurations: [
          {
            name: '${vmssName}-nic'
            properties: {
              primary: true
              ipConfigurations: [
                {
                  name: '${vmssName}-ipconfig'
                  properties: {
                    primary: true
                    subnet: {
                      id: subnetId
                    }
                    loadBalancerBackendAddressPools: [
                      {
                        id: resourceId('Microsoft.Network/loadBalancers/backendAddressPools', lbName, lbBackendPoolName)
                      }
                    ]
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
            name: '${vmssName}-iis-setup'
            properties: {
              publisher: 'Microsoft.Compute'
              type: 'CustomScriptExtension'
              typeHandlerVersion: '1.10'
              autoUpgradeMinorVersion: true
              settings: {
                commandToExecute: iisSetupScript
              }
            }
          }
        ]
      }
      securityProfile: {
        encryptionAtHost: true
        securityType: 'TrustedLaunch'
        uefiSettings: {
          secureBootEnabled: true
          vTpmEnabled: true
        }
      }
      diagnosticsProfile: {
        bootDiagnostics: {
          enabled: true
        }
      }
    }
  }
  dependsOn: [
    lb
  ]
}

// Auto-scale settings — CPU-based, 2-10 instances by default.
resource autoscaleSetting 'Microsoft.Insights/autoscalesettings@2022-10-01' = {
  name: autoscaleSettingName
  location: location
  tags: tags
  properties: {
    enabled: true
    targetResourceUri: vmss.id
    profiles: [
      {
        name: 'cpu-autoscale'
        capacity: {
          minimum: string(minInstanceCount)
          maximum: string(maxInstanceCount)
          default: string(defaultInstanceCount)
        }
        rules: [
          // Scale out when CPU > threshold
          {
            metricTrigger: {
              metricName: 'Percentage CPU'
              metricResourceUri: vmss.id
              operator: 'GreaterThan'
              statistic: 'Average'
              threshold: scaleOutCpuThreshold
              timeAggregation: 'Average'
              timeGrain: 'PT1M'
              timeWindow: 'PT5M'
            }
            scaleAction: {
              direction: 'Increase'
              type: 'ChangeCount'
              value: '1'
              cooldown: 'PT5M'
            }
          }
          // Scale in when CPU < threshold
          {
            metricTrigger: {
              metricName: 'Percentage CPU'
              metricResourceUri: vmss.id
              operator: 'LessThan'
              statistic: 'Average'
              threshold: scaleInCpuThreshold
              timeAggregation: 'Average'
              timeGrain: 'PT1M'
              timeWindow: 'PT5M'
            }
            scaleAction: {
              direction: 'Decrease'
              type: 'ChangeCount'
              value: '1'
              cooldown: 'PT10M'
            }
          }
        ]
      }
    ]
  }
}

// Diagnostic Settings — capture VMSS metrics for operational monitoring.
resource vmssDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsWorkspaceId)) {
  name: '${vmssName}-diagnostics'
  scope: vmss
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// Resource lock — protects the VMSS and its load balancer from accidental deletion.
resource vmssLock 'Microsoft.Authorization/locks@2020-05-01' = if (enableResourceLock) {
  scope: vmss
  name: '${vmssName}-no-delete'
  properties: {
    level: 'CanNotDelete'
    notes: 'CSA-in-a-Box: DMLZ IIS web server VMSS. Delete via the rollback workflow in docs/ROLLBACK.md.'
  }
}

// Outputs
@description('Resource ID of the VMSS.')
output vmssId string = vmss.id

@description('Name of the VMSS.')
output vmssName string = vmss.name

@description('Load balancer frontend private IP address.')
output lbPrivateIp string = lb.properties.frontendIPConfigurations[0].properties.privateIPAddress

@description('Managed identity principal ID.')
output managedIdentityPrincipalId string = vmss.identity.principalId

@description('Load balancer resource ID.')
output loadBalancerId string = lb.id
