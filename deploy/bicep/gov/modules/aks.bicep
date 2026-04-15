// Azure Kubernetes Service - Government Deployment Module
// For deploying open-source alternatives (Atlas, Ranger, Superset, Trino)

@description('AKS cluster name.')
param name string

@description('Azure Government region.')
param location string

@description('Resource tags.')
param tags object = {}

@description('Kubernetes version.')
param kubernetesVersion string = '1.29'

@description('Enable Azure Policy add-on.')
param enableAzurePolicy bool = true

@description('Enable Microsoft Defender for Containers.')
param enableDefender bool = true

@description('Network plugin.')
@allowed(['azure', 'kubenet'])
param networkPlugin string = 'azure'

@description('Network policy.')
@allowed(['azure', 'calico'])
param networkPolicy string = 'calico'

@description('Enable private cluster.')
param enablePrivateCluster bool = true

@description('System node pool VM size.')
param systemNodePoolVmSize string = 'Standard_D4s_v5'

@description('System node pool count.')
param systemNodePoolCount int = 3

@description('Log Analytics workspace ID.')
param logAnalyticsId string = ''

resource aks 'Microsoft.ContainerService/managedClusters@2024-02-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'Base'
    tier: 'Standard'
  }
  properties: {
    kubernetesVersion: kubernetesVersion
    dnsPrefix: name
    enableRBAC: true
    aadProfile: {
      managed: true
      enableAzureRBAC: true
    }
    apiServerAccessProfile: {
      enablePrivateCluster: enablePrivateCluster
    }
    networkProfile: {
      networkPlugin: networkPlugin
      networkPolicy: networkPolicy
      loadBalancerSku: 'standard'
      outboundType: 'loadBalancer'
      serviceCidr: '10.0.0.0/16'
      dnsServiceIP: '10.0.0.10'
    }
    agentPoolProfiles: [
      {
        name: 'system'
        count: systemNodePoolCount
        vmSize: systemNodePoolVmSize
        osType: 'Linux'
        osSKU: 'AzureLinux'
        mode: 'System'
        enableAutoScaling: true
        minCount: 1
        maxCount: systemNodePoolCount * 2
        enableFIPS: true  // FIPS 140-2 for Gov
        availabilityZones: ['1', '2', '3']
        nodeTaints: ['CriticalAddonsOnly=true:NoSchedule']
      }
      {
        name: 'ossworkload'
        count: 3
        vmSize: 'Standard_D8s_v5'
        osType: 'Linux'
        osSKU: 'AzureLinux'
        mode: 'User'
        enableAutoScaling: true
        minCount: 2
        maxCount: 10
        enableFIPS: true
        availabilityZones: ['1', '2', '3']
        nodeLabels: {
          workload: 'oss-data-platform'
        }
      }
    ]
    addonProfiles: {
      azurePolicy: {
        enabled: enableAzurePolicy
      }
      omsAgent: {
        enabled: !empty(logAnalyticsId)
        config: !empty(logAnalyticsId) ? {
          logAnalyticsWorkspaceResourceID: logAnalyticsId
        } : {}
      }
      azureKeyvaultSecretsProvider: {
        enabled: true
        config: {
          enableSecretRotation: 'true'
          rotationPollInterval: '2m'
        }
      }
    }
    securityProfile: {
      defender: {
        securityMonitoring: {
          enabled: enableDefender
        }
        logAnalyticsWorkspaceResourceId: !empty(logAnalyticsId) ? logAnalyticsId : null
      }
      imageCleaner: {
        enabled: true
        intervalHours: 48
      }
      workloadIdentity: {
        enabled: true
      }
    }
    oidcIssuerProfile: {
      enabled: true
    }
    autoUpgradeProfile: {
      upgradeChannel: 'stable'
    }
  }
}

// Diagnostic settings
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(logAnalyticsId)) {
  name: '${name}-diag'
  scope: aks
  properties: {
    workspaceId: logAnalyticsId
    logs: [
      { category: 'kube-apiserver', enabled: true }
      { category: 'kube-audit', enabled: true }
      { category: 'kube-audit-admin', enabled: true }
      { category: 'kube-controller-manager', enabled: true }
      { category: 'kube-scheduler', enabled: true }
      { category: 'cluster-autoscaler', enabled: true }
      { category: 'guard', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output clusterId string = aks.id
output clusterName string = aks.name
output principalId string = aks.identity.principalId
output nodeResourceGroup string = aks.properties.nodeResourceGroup
