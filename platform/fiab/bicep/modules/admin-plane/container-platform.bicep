// CSA Loom — Admin Plane container platform dispatcher
// Container Apps Environment (Commercial / GCC) OR AKS (GCC-H / IL5)

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Container platform — containerApps or aks')
@allowed(['containerApps', 'aks'])
param containerPlatform string

@description('Container platform subnet ID')
param containerSubnetId string

@description('Log Analytics workspace ID')
param lawId string

@description('Log Analytics customer ID')
param lawCustomerId string

@description('Compliance tags')
param complianceTags object

// =====================================================================
// Container Apps Environment (Commercial / GCC)
// =====================================================================

resource cae 'Microsoft.App/managedEnvironments@2025-02-02-preview' = if (containerPlatform == 'containerApps') {
  name: 'cae-csa-loom-${location}'
  location: location
  tags: complianceTags
  properties: {
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
      {
        name: 'D8'
        workloadProfileType: 'D8'
        minimumCount: 1
        maximumCount: 10
      }
    ]
    vnetConfiguration: {
      internal: true
      infrastructureSubnetId: containerSubnetId
    }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: lawCustomerId
      }
    }
    zoneRedundant: true
  }
}

// =====================================================================
// AKS (GCC-H / IL5) — private cluster with API server VNet integration
// =====================================================================

resource aks 'Microsoft.ContainerService/managedClusters@2025-04-01' = if (containerPlatform == 'aks') {
  name: 'aks-csa-loom-${location}'
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    dnsPrefix: 'aks-csa-loom'
    enableRBAC: true
    aadProfile: {
      managed: true
      enableAzureRBAC: true
    }
    apiServerAccessProfile: {
      enablePrivateCluster: true
      enableVnetIntegration: true
      subnetId: containerSubnetId
    }
    agentPoolProfiles: [
      {
        name: 'system'
        count: 3
        vmSize: 'Standard_D4ds_v5'
        mode: 'System'
        osType: 'Linux'
        osSKU: 'AzureLinux'
        vnetSubnetId: containerSubnetId
        availabilityZones: ['1', '2', '3']
        enableAutoScaling: true
        minCount: 3
        maxCount: 5
      }
      {
        name: 'apps'
        count: 3
        vmSize: 'Standard_D8ds_v5'
        mode: 'User'
        osType: 'Linux'
        osSKU: 'AzureLinux'
        vnetSubnetId: containerSubnetId
        availabilityZones: ['1', '2', '3']
        enableAutoScaling: true
        minCount: 3
        maxCount: 12
      }
    ]
    networkProfile: {
      networkPlugin: 'azure'
      networkPolicy: 'cilium'
      networkDataplane: 'cilium'
      loadBalancerSku: 'standard'
      outboundType: 'userDefinedRouting'
    }
    azureMonitorProfile: {
      metrics: { enabled: true }
      containerInsights: {
        enabled: true
        logAnalyticsWorkspaceResourceId: lawId
      }
    }
    securityProfile: {
      defender: {
        logAnalyticsWorkspaceResourceId: lawId
        securityMonitoring: { enabled: true }
      }
      workloadIdentity: { enabled: true }
      imageCleaner: {
        enabled: true
        intervalHours: 24
      }
    }
    oidcIssuerProfile: { enabled: true }
  }
}

// =====================================================================
// Outputs (one of two; caller picks based on containerPlatform)
// =====================================================================

output caeId string = containerPlatform == 'containerApps' ? cae.id : ''
output caeName string = containerPlatform == 'containerApps' ? cae.name : ''
output caeDefaultDomain string = containerPlatform == 'containerApps' ? cae.properties.defaultDomain : ''
output caeStaticIp string = containerPlatform == 'containerApps' ? cae.properties.staticIp : ''

output aksId string = containerPlatform == 'aks' ? aks.id : ''
output aksName string = containerPlatform == 'aks' ? aks.name : ''
output aksOidcIssuer string = containerPlatform == 'aks' ? aks.properties.oidcIssuerProfile.issuerURL : ''
