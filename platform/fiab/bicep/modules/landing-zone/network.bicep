// CSA Loom DLZ — spoke VNet
// Peered to Admin Plane hub. Subnets sized for Databricks private +
// public + private endpoints.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Domain name (suffix)')
param domainName string

@description('Spoke VNet CIDR')
param spokeVnetCidr string = '10.100.0.0/16'

@description('Admin Plane hub VNet ID for peering')
param adminPlaneHubVnetId string

@description('Compliance tags')
param complianceTags object

var firstOctets = take(split(spokeVnetCidr, '.'), 2)
var prefix = '${firstOctets[0]}.${firstOctets[1]}'

resource spokeVnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-csa-loom-dlz-${domainName}-${location}'
  location: location
  tags: complianceTags
  properties: {
    addressSpace: { addressPrefixes: [spokeVnetCidr] }
    subnets: [
      {
        name: 'snet-databricks-public'
        properties: {
          addressPrefix: '${prefix}.0.0/22'
          delegations: [
            {
              name: 'databricks-del-public'
              properties: { serviceName: 'Microsoft.Databricks/workspaces' }
            }
          ]
          networkSecurityGroup: { id: nsgDbx.id }
        }
      }
      {
        name: 'snet-databricks-private'
        properties: {
          addressPrefix: '${prefix}.4.0/22'
          delegations: [
            {
              name: 'databricks-del-private'
              properties: { serviceName: 'Microsoft.Databricks/workspaces' }
            }
          ]
          networkSecurityGroup: { id: nsgDbx.id }
        }
      }
      {
        name: 'snet-private-endpoints'
        properties: {
          addressPrefix: '${prefix}.8.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
      {
        name: 'snet-synapse'
        properties: {
          addressPrefix: '${prefix}.9.0/24'
        }
      }
      {
        name: 'snet-workloads'
        properties: {
          addressPrefix: '${prefix}.10.0/24'
        }
      }
    ]
  }
}

// Databricks-required NSG (intra-cluster rules added by ADB platform)
resource nsgDbx 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-databricks-${domainName}-${location}'
  location: location
  tags: complianceTags
  properties: {
    // Databricks Network Intent Policy requires these specific
    // outbound rules — without them, vnet-injected workspaces fail
    // with ConflictWithNetworkIntentPolicy on the worker subnets.
    // Source: https://learn.microsoft.com/azure/databricks/security/network/secure-cluster/dbcc/network
    securityRules: [
      {
        name: 'databricks-worker-to-sql'
        properties: {
          priority: 100
          access: 'Allow'
          direction: 'Outbound'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'Sql'
          destinationPortRange: '3306'
        }
      }
      {
        name: 'databricks-worker-to-storage'
        properties: {
          priority: 101
          access: 'Allow'
          direction: 'Outbound'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'Storage'
          destinationPortRange: '443'
        }
      }
      {
        name: 'databricks-worker-to-eventhub'
        properties: {
          priority: 102
          access: 'Allow'
          direction: 'Outbound'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'EventHub'
          destinationPortRange: '9093'
        }
      }
      // Required intra-worker SSH (host→worker) per ADB docs
      {
        name: 'databricks-workers-inbound'
        properties: {
          priority: 100
          access: 'Allow'
          direction: 'Inbound'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'VirtualNetwork'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

// Peering DLZ → Hub
resource peerToHub 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-05-01' = {
  parent: spokeVnet
  name: 'peer-to-admin-hub'
  properties: {
    remoteVirtualNetwork: { id: adminPlaneHubVnetId }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: true
    allowGatewayTransit: false
    useRemoteGateways: false
  }
}

output spokeVnetId string = spokeVnet.id
output spokeVnetName string = spokeVnet.name
output databricksPublicSubnetName string = 'snet-databricks-public'
output databricksPrivateSubnetName string = 'snet-databricks-private'
output privateEndpointSubnetId string = '${spokeVnet.id}/subnets/snet-private-endpoints'
output synapseSubnetId string = '${spokeVnet.id}/subnets/snet-synapse'
output workloadsSubnetId string = '${spokeVnet.id}/subnets/snet-workloads'
