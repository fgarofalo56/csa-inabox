// CSA Loom Health Data Services (LHDS) - stamp AKS cluster.
//
// ADR-009: the stamp runs on AKS in every cloud (Container Apps in Azure
// Government is audit-scoped to IL2 only, AKS reaches IL5). Private cluster,
// Azure CNI overlay, availability zones, system + user node pools, workload
// identity, Azure Policy and Defender for Containers. Image admission (cosign)
// and the KEDA Helm install in clouds without the add-on are cluster content,
// installed by the W1-3 control-plane job, not by ARM.
//
// Pools:
//   system  - the AKS system pool. In the dev profile it is the ONLY pool with
//             nodes (one D8s_v5), so it also runs the engines.
//   engines - user pool for the FHIR, DICOM, terminology and PDP pods (S/M/L).
//   egress  - user pool for workloads that must reach the internet through the
//             egress firewall allow-list. Scales from zero (0 nodes in dev),
//             tainted so nothing else lands on it.

targetScope = 'resourceGroup'

@description('Region of the cluster.')
param location string

@description('Stamp short name; folded into resource names.')
param stampName string

@description('Cloud boundary. KEDA is enabled as the AKS add-on outside Azure Government only; Gov availability of the add-on is unconfirmed (ADR-009), so Gov installs KEDA by Helm.')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('Kubernetes version. W0 read 1.31 through 1.37 as offered in all three Gov regions.')
param kubernetesVersion string = '1.34'

@description('Node subnet id.')
param aksSubnetId string

@description('Name of the stamp VNet in this resource group. The cluster identity is granted Network Contributor on it.')
param vnetName string

@description('Route table id when egress goes through the firewall; empty otherwise. The cluster identity needs Network Contributor on it.')
param routeTableId string = ''

@description('Outbound model. userDefinedRouting requires the route table from network.bicep.')
@allowed(['loadBalancer', 'userDefinedRouting'])
param outboundType string = 'userDefinedRouting'

@description('Pod CIDR for Azure CNI overlay. Must not overlap the VNet or service CIDR.')
param podCidr string = '10.244.0.0/16'

@description('Service CIDR.')
param serviceCidr string = '10.250.0.0/16'

@description('DNS service IP inside the service CIDR.')
param dnsServiceIp string = '10.250.0.10'

@description('Spread node pools across availability zones. Set false for a region without zones.')
param useAvailabilityZones bool = true

@description('System pool shape.')
param systemPool object = {
  vmSize: 'Standard_D4s_v5'
  count: 3
  minCount: 3
  maxCount: 5
}

@description('Engines pool shape. Set count to 0 and maxCount to 0 to omit the pool (dev profile).')
param enginesPool object = {
  vmSize: 'Standard_D8s_v5'
  count: 6
  minCount: 6
  maxCount: 12
}

@description('Egress pool shape. Scales from zero.')
param egressPool object = {
  vmSize: 'Standard_D4s_v5'
  count: 0
  minCount: 0
  maxCount: 3
}

@description('Taint the system pool with CriticalAddonsOnly so only add-ons schedule on it. False in the dev profile, where the single node must also run the engines.')
param isolateSystemPool bool = true

@description('Object ids of Entra groups granted cluster-admin through Azure RBAC for Kubernetes. Empty = none; the control plane grants roles after creation.')
param adminGroupObjectIds array = []

@description('Log Analytics workspace resource id (container insights + Defender). Empty = both off.')
param workspaceId string = ''

@description('Tags applied to every resource.')
param tags object = {}

var isGov = boundary == 'GCC-High' || boundary == 'IL5'
var zones = useAvailabilityZones ? ['1', '2', '3'] : null
var hasEngines = enginesPool.maxCount > 0

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: vnetName
}

// Cluster control-plane identity. A user-assigned identity is required: with a
// system-assigned one the role on the BYO VNet can only be granted after the
// cluster exists, which is after AKS has already tried to use it.
resource clusterIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-lhds-${stampName}-aks'
  location: location
  tags: tags
}

// Network Contributor, a built-in role with a global GUID.
resource vnetRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vnet
  name: guid(vnet.id, clusterIdentity.id, '4d97b98b-1d4f-4787-a291-c67834d212e7')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4d97b98b-1d4f-4787-a291-c67834d212e7')
    principalId: clusterIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

var routeTableName = empty(routeTableId) ? 'unused' : last(split(routeTableId, '/'))

resource routeTable 'Microsoft.Network/routeTables@2024-05-01' existing = if (!empty(routeTableId)) {
  name: routeTableName
}

resource routeTableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(routeTableId)) {
  scope: routeTable
  name: guid(routeTableId, clusterIdentity.id, '4d97b98b-1d4f-4787-a291-c67834d212e7')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4d97b98b-1d4f-4787-a291-c67834d212e7')
    principalId: clusterIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

var systemPoolProfile = {
  name: 'system'
  mode: 'System'
  osType: 'Linux'
  osSKU: 'AzureLinux'
  vmSize: systemPool.vmSize
  count: systemPool.count
  minCount: systemPool.minCount
  maxCount: systemPool.maxCount
  enableAutoScaling: true
  vnetSubnetID: aksSubnetId
  availabilityZones: zones
  nodeTaints: isolateSystemPool ? ['CriticalAddonsOnly=true:NoSchedule'] : []
}

var enginesPoolProfile = [
  {
    name: 'engines'
    mode: 'User'
    osType: 'Linux'
    osSKU: 'AzureLinux'
    vmSize: enginesPool.vmSize
    count: enginesPool.count
    minCount: enginesPool.minCount
    maxCount: enginesPool.maxCount
    enableAutoScaling: true
    vnetSubnetID: aksSubnetId
    availabilityZones: zones
    nodeLabels: { workload: 'engines' }
  }
]

var egressPoolProfile = {
  name: 'egress'
  mode: 'User'
  osType: 'Linux'
  osSKU: 'AzureLinux'
  vmSize: egressPool.vmSize
  count: egressPool.count
  minCount: egressPool.minCount
  maxCount: egressPool.maxCount
  enableAutoScaling: true
  vnetSubnetID: aksSubnetId
  availabilityZones: zones
  nodeLabels: { workload: 'egress' }
  nodeTaints: ['workload=egress:NoSchedule']
}

resource aks 'Microsoft.ContainerService/managedClusters@2025-04-01' = {
  name: 'aks-lhds-${stampName}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${clusterIdentity.id}': {}
    }
  }
  sku: {
    name: 'Base'
    tier: 'Standard'
  }
  properties: {
    dnsPrefix: 'lhds-${stampName}'
    kubernetesVersion: kubernetesVersion
    enableRBAC: true
    disableLocalAccounts: true
    aadProfile: {
      managed: true
      enableAzureRBAC: true
      adminGroupObjectIDs: adminGroupObjectIds
    }
    apiServerAccessProfile: {
      enablePrivateCluster: true
      privateDNSZone: 'system'
      enablePrivateClusterPublicFQDN: false
    }
    agentPoolProfiles: concat([systemPoolProfile], hasEngines ? enginesPoolProfile : [], [egressPoolProfile])
    networkProfile: {
      networkPlugin: 'azure'
      networkPluginMode: 'overlay'
      networkPolicy: 'cilium'
      networkDataplane: 'cilium'
      loadBalancerSku: 'standard'
      outboundType: outboundType
      podCidr: podCidr
      serviceCidr: serviceCidr
      dnsServiceIP: dnsServiceIp
    }
    autoUpgradeProfile: {
      upgradeChannel: 'patch'
      nodeOSUpgradeChannel: 'NodeImage'
    }
    oidcIssuerProfile: { enabled: true }
    securityProfile: {
      workloadIdentity: { enabled: true }
      imageCleaner: {
        enabled: true
        intervalHours: 24
      }
      defender: empty(workspaceId) ? null : {
        logAnalyticsWorkspaceResourceId: workspaceId
        securityMonitoring: { enabled: true }
      }
    }
    workloadAutoScalerProfile: {
      keda: { enabled: !isGov }
    }
    azureMonitorProfile: {
      metrics: { enabled: true }
    }
    addonProfiles: union({
      azurepolicy: { enabled: true }
    }, empty(workspaceId) ? {} : {
      omsagent: {
        enabled: true
        config: { logAnalyticsWorkspaceResourceID: workspaceId }
      }
    })
  }
  dependsOn: [
    vnetRole
    routeTableRole
  ]
}

output clusterId string = aks.id
output clusterName string = aks.name
output oidcIssuerUrl string = aks.properties.oidcIssuerProfile.issuerURL
output clusterIdentityPrincipalId string = clusterIdentity.properties.principalId
output kubeletIdentityObjectId string = aks.properties.identityProfile.kubeletidentity.objectId
output kedaAddon bool = !isGov
