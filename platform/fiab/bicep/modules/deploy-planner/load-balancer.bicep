// CSA Loom deploy-planner — Azure Load Balancer (internal, Standard)
//
// Wired by the deploy-planner catalog (key: loadBalancer → loadBalancerEnabled).
// Self-contained: an isolated VNet + subnet and an internal Standard Load
// Balancer with a private frontend IP, a backend address pool, a TCP health
// probe, and an LB rule — a complete, editable L4 config the Load Balancer
// navigator can open. The Loom Console UAMI is granted Network Contributor so
// the navigator can manage rules/pools/probes over ARM.
//
// Grounded in Microsoft Learn:
//   Microsoft.Network/loadBalancers (Bicep)
//   https://learn.microsoft.com/azure/templates/microsoft.network/loadbalancers

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Address space for the load-balancer VNet.')
param vnetCidr string = '10.61.0.0/24'

@description('Subnet prefix the internal frontend lives in.')
param subnetCidr string = '10.61.0.0/26'

@description('Loom Console UAMI principal ID — granted Network Contributor so the BFF can manage LB rules/pools/probes. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var suffix = uniqueString(resourceGroup().id)
var vnetName = take('vnet-lb-loom-${suffix}', 64)
var lbName = take('lb-loom-${suffix}', 80)
var subnetName = 'lb'

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  tags: complianceTags
  properties: {
    addressSpace: {
      addressPrefixes: [ vnetCidr ]
    }
    subnets: [
      {
        name: subnetName
        properties: {
          addressPrefix: subnetCidr
        }
      }
    ]
  }
}

resource lb 'Microsoft.Network/loadBalancers@2024-05-01' = {
  name: lbName
  location: location
  tags: complianceTags
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    frontendIPConfigurations: [
      {
        name: 'frontend'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: {
            id: '${vnet.id}/subnets/${subnetName}'
          }
        }
      }
    ]
    backendAddressPools: [
      {
        name: 'backendPool'
      }
    ]
    probes: [
      {
        name: 'tcpProbe'
        properties: {
          protocol: 'Tcp'
          port: 80
          intervalInSeconds: 15
          numberOfProbes: 2
        }
      }
    ]
    loadBalancingRules: [
      {
        name: 'httpRule'
        properties: {
          protocol: 'Tcp'
          frontendPort: 80
          backendPort: 80
          idleTimeoutInMinutes: 4
          frontendIPConfiguration: {
            id: resourceId('Microsoft.Network/loadBalancers/frontendIPConfigurations', lbName, 'frontend')
          }
          backendAddressPool: {
            id: resourceId('Microsoft.Network/loadBalancers/backendAddressPools', lbName, 'backendPool')
          }
          probe: {
            id: resourceId('Microsoft.Network/loadBalancers/probes', lbName, 'tcpProbe')
          }
        }
      }
    ]
  }
}

// Network Contributor — manage LB rules/pools/probes over ARM
// (role 4d97b98b-1d4f-4787-a291-c67834d212e7).
resource networkContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: lb
  name: guid(lb.id, consolePrincipalId, '4d97b98b-1d4f-4787-a291-c67834d212e7')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4d97b98b-1d4f-4787-a291-c67834d212e7')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output loadBalancerId string = lb.id
output loadBalancerName string = lb.name
