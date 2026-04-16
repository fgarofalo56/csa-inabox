metadata name = 'Azure Security Center (Defender for Cloud)'
metadata description = 'This module deploys an Azure Security Center (Defender for Cloud) Configuration.'
metadata owner = 'Azure/module-maintainers'

targetScope = 'subscription'

@description('Required. The full resource Id of the Log Analytics workspace to save the data in.')
param workspaceResourceId string

@description('Required. All the VMs in this scope will send their security data to the mentioned workspace unless overridden by a setting with more specific scope.')
param scope string

@description('Optional. Describes what kind of security agent provisioning action to take. - On or Off.')
@allowed([
  'On'
  'Off'
])
param autoProvision string = 'On'

@description('Optional. Device Security group data.')
param deviceSecurityGroupProperties object = {}

@description('Optional. Security Solution data.')
param ioTSecuritySolutionProperties object = {}

@description('Optional. The pricing tier value for VMs. Azure Security Center is provided in two pricing tiers: free and standard, with the standard tier available with a trial period. The standard tier offers advanced security capabilities, while the free tier offers basic security features. - Free or Standard.')
@allowed([
  'Free'
  'Standard'
])
param virtualMachinesPricingTier string = 'Standard'

@description('Optional. The pricing tier value for SqlServers. Azure Security Center is provided in two pricing tiers: free and standard, with the standard tier available with a trial period. The standard tier offers advanced security capabilities, while the free tier offers basic security features. - Free or Standard.')
@allowed([
  'Free'
  'Standard'
])
param sqlServersPricingTier string = 'Standard'

@description('Optional. The pricing tier value for AppServices. Azure Security Center is provided in two pricing tiers: free and standard, with the standard tier available with a trial period. The standard tier offers advanced security capabilities, while the free tier offers basic security features. - Free or Standard.')
@allowed([
  'Free'
  'Standard'
])
param appServicesPricingTier string = 'Standard'

@description('Optional. The pricing tier value for StorageAccounts. Azure Security Center is provided in two pricing tiers: free and standard, with the standard tier available with a trial period. The standard tier offers advanced security capabilities, while the free tier offers basic security features. - Free or Standard.')
@allowed([
  'Free'
  'Standard'
])
param storageAccountsPricingTier string = 'Standard'

@description('Optional. The pricing tier value for SqlServerVirtualMachines. Azure Security Center is provided in two pricing tiers: free and standard, with the standard tier available with a trial period. The standard tier offers advanced security capabilities, while the free tier offers basic security features. - Free or Standard.')
@allowed([
  'Free'
  'Standard'
])
param sqlServerVirtualMachinesPricingTier string = 'Standard'

@description('Optional. The pricing tier value for KubernetesService. Azure Security Center is provided in two pricing tiers: free and standard, with the standard tier available with a trial period. The standard tier offers advanced security capabilities, while the free tier offers basic security features. - Free or Standard.')
@allowed([
  'Free'
  'Standard'
])
param kubernetesServicePricingTier string = 'Standard'

@description('Optional. The pricing tier value for ContainerRegistry. Azure Security Center is provided in two pricing tiers: free and standard, with the standard tier available with a trial period. The standard tier offers advanced security capabilities, while the free tier offers basic security features. - Free or Standard.')
@allowed([
  'Free'
  'Standard'
])
param containerRegistryPricingTier string = 'Standard'

@description('Optional. The pricing tier value for KeyVaults. Azure Security Center is provided in two pricing tiers: free and standard, with the standard tier available with a trial period. The standard tier offers advanced security capabilities, while the free tier offers basic security features. - Free or Standard.')
@allowed([
  'Free'
  'Standard'
])
param keyVaultsPricingTier string = 'Standard'

@description('Optional. The pricing tier value for DNS. Azure Security Center is provided in two pricing tiers: free and standard, with the standard tier available with a trial period. The standard tier offers advanced security capabilities, while the free tier offers basic security features. - Free or Standard.')
@allowed([
  'Free'
  'Standard'
])
param dnsPricingTier string = 'Standard'

@description('Optional. The pricing tier value for ARM. Azure Security Center is provided in two pricing tiers: free and standard, with the standard tier available with a trial period. The standard tier offers advanced security capabilities, while the free tier offers basic security features. - Free or Standard.')
@allowed([
  'Free'
  'Standard'
])
param armPricingTier string = 'Standard'

@description('Optional. The pricing tier value for OpenSourceRelationalDatabases. Azure Security Center is provided in two pricing tiers: free and standard, with the standard tier available with a trial period. The standard tier offers advanced security capabilities, while the free tier offers basic security features. - Free or Standard.')
@allowed([
  'Free'
  'Standard'
])
param openSourceRelationalDatabasesTier string = 'Standard'

@description('Optional. The pricing tier value for containers. Azure Security Center is provided in two pricing tiers: free and standard, with the standard tier available with a trial period. The standard tier offers advanced security capabilities, while the free tier offers basic security features. - Free or Standard.')
@allowed([
  'Free'
  'Standard'
])
param containersTier string = 'Standard'

@description('Optional. The pricing tier value for CosmosDbs. Azure Security Center is provided in two pricing tiers: free and standard, with the standard tier available with a trial period. The standard tier offers advanced security capabilities, while the free tier offers basic security features. - Free or Standard.')
@allowed([
  'Free'
  'Standard'
])
param cosmosDbsTier string = 'Standard'

@description('Optional. Security contact data.')
param securityContactProperties object = {}

@description('Optional. Location deployment metadata.')
param location string = deployment().location

@sys.description('Optional. Enable/Disable usage telemetry for module.')
param enableTelemetry bool = true

var pricings = [
  {
    name: 'VirtualMachines'
    pricingTier: virtualMachinesPricingTier
    USGovSupport: true
  }
  {
    name: 'SqlServers'
    pricingTier: sqlServersPricingTier
    USGovSupport: true
  }
  {
    name: 'AppServices'
    pricingTier: appServicesPricingTier
    USGovSupport: false
  }
  {
    name: 'StorageAccounts'
    pricingTier: storageAccountsPricingTier
    USGovSupport: true
  }
  {
    name: 'SqlServerVirtualMachines'
    pricingTier: sqlServerVirtualMachinesPricingTier
    USGovSupport: true
  }
  {
    name: 'KubernetesService'
    pricingTier: kubernetesServicePricingTier
    USGovSupport: true
  }
  {
    name: 'ContainerRegistry'
    pricingTier: containerRegistryPricingTier
    USGovSupport: true
  }
  {
    name: 'KeyVaults'
    pricingTier: keyVaultsPricingTier
    USGovSupport: false
  }
  {
    name: 'Dns'
    pricingTier: dnsPricingTier
    USGovSupport: true
  }
  {
    name: 'Arm'
    pricingTier: armPricingTier
    USGovSupport: true
  }
  {
    name: 'OpenSourceRelationalDatabases'
    pricingTier: openSourceRelationalDatabasesTier
    USGovSupport: true
  }
  {
    name: 'Containers'
    pricingTier: containersTier
    USGovSupport: true
  }
  {
    name: 'CosmosDbs'
    pricingTier: cosmosDbsTier
    USGovSupport: false
  }
  {
    name: 'CloudPosture'
    pricingTier: 'Standard'
    USGovSupport: false
  }
  {
    name: 'Api'
    pricingTier: 'Standard'
    USGovSupport: false
  }
]

#disable-next-line no-deployments-resources
resource avmTelemetry 'Microsoft.Resources/deployments@2024-03-01' = if (enableTelemetry) {
  name: take(
    '46d3xbcp.ptn.security-securitycenter.${replace('-..--..-', '.', '-')}.${substring(uniqueString(deployment().name, location), 0, 4)}',
    64
  )
  location: location
  properties: {
    mode: 'Incremental'
    template: {
      '$schema': 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#'
      contentVersion: '1.0.0.0'
      resources: []
      outputs: {
        telemetry: {
          type: 'String'
          value: 'For more information, see https://aka.ms/avm/TelemetryInfo'
        }
      }
    }
  }
}

@batchSize(1)
resource pricingTiers 'Microsoft.Security/pricings@2024-01-01' = [
  for (pricing, index) in pricings: if (pricing.name != 'VirtualMachines' && pricing.name != 'CloudPosture' && pricing.name != 'Api' && pricing.USGovSupport == true) {
    name: pricing.name
    properties: {
      pricingTier: pricing.pricingTier
    }
  }
]

resource pricingTiersSubPlan 'Microsoft.Security/pricings@2024-01-01' = [
  for (pricing, index) in pricings: if (pricing.name == 'VirtualMachines' && pricing.name != 'CloudPosture' && pricing.name != 'Api' && pricing.USGovSupport == true) {
    name: pricing.name
    properties: {
      pricingTier: pricing.pricingTier
      subPlan: 'P2'
    }
  }
]
resource pricingTiersApiSubPlan 'Microsoft.Security/pricings@2024-01-01' = [
  for (pricing, index) in pricings: if (pricing.name == 'Api' && pricing.USGovSupport == true) {
    name: pricing.name
    properties: {
      pricingTier: pricing.pricingTier
      subPlan: 'P1'
    }
  }
]

resource pricingTiersCloudPosture 'Microsoft.Security/pricings@2024-01-01' = [
  for (pricing, index) in pricings: if (pricing.name == 'CloudPosture' && pricing.USGovSupport == true) {
    name: pricing.name
    properties: {
      extensions: [
        {
          isEnabled: 'true'
          name: 'SensitiveDataDiscovery'
        }
        {
          isEnabled: 'true'
          name: 'ContainerRegistriesVulnerabilityAssessments'
        }
        {
          isEnabled: 'true'
          name: 'AgentlessDiscoveryForKubernetes'
        }
        {
          isEnabled: 'true'
          name: 'AgentlessVmScanning'
        }
        {
          isEnabled: 'true'
          name: 'EntraPermissionsManagement'
        }
      ]
      pricingTier: pricing.pricingTier
    }
  }
]

resource deviceSecurityGroups 'Microsoft.Security/deviceSecurityGroups@2019-08-01' = if (!empty(deviceSecurityGroupProperties)) {
  name: 'deviceSecurityGroups'
  properties: {
    thresholdRules: deviceSecurityGroupProperties.thresholdRules
    timeWindowRules: deviceSecurityGroupProperties.timeWindowRules
    allowlistRules: deviceSecurityGroupProperties.allowlistRules
    denylistRules: deviceSecurityGroupProperties.denylistRules
  }
}

module iotSecuritySolutions 'modules/iotSecuritySolutions.bicep' = if (!empty(ioTSecuritySolutionProperties)) {
  name: '${uniqueString(deployment().name)}-ASC-IotSecuritySolutions'
  scope: resourceGroup(empty(ioTSecuritySolutionProperties) ? 'dummy' : ioTSecuritySolutionProperties.resourceGroup)
  params: {
    ioTSecuritySolutionProperties: ioTSecuritySolutionProperties
  }
}

resource securityContacts 'Microsoft.Security/securityContacts@2017-08-01-preview' = if (!empty(securityContactProperties)) {
  name: 'default'
  properties: {
    email: securityContactProperties.email
    phone: securityContactProperties.phone
    alertNotifications: securityContactProperties.alertNotifications
    alertsToAdmins: securityContactProperties.alertsToAdmins
  }
}

resource workspaceSettings 'Microsoft.Security/workspaceSettings@2017-08-01-preview' = {
  name: 'default'
  properties: {
    workspaceId: workspaceResourceId
    scope: scope
  }
  dependsOn: [
    // autoProvisioningSettings
  ]
}

@description('The resource ID of the used log analytics workspace.')
output workspaceResourceId string = workspaceResourceId

@description('The name of the security center.')
output name string = 'Security'
