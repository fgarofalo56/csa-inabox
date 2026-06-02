// CSA Loom deploy-planner — Azure Firewall (Standard, AZFW_VNet)
//
// Wired by the deploy-planner catalog (key: firewall → firewallEnabled).
// Self-contained: an isolated VNet with the required `AzureFirewallSubnet`, a
// Standard static public IP, and a Standard AZFW_VNet Azure Firewall with
// threat-intel set to Alert. The firewall is its own self-contained landing
// zone so it provisions without depending on the admin-plane hub VNet (which
// lives in a different RG). The Loom Console UAMI is granted Network
// Contributor so the firewall navigator can manage rule collections over ARM.
//
// Grounded in Microsoft Learn:
//   Microsoft.Network/azureFirewalls (Bicep) — AZFW_VNet sku + AzureFirewallSubnet
//   https://learn.microsoft.com/azure/templates/microsoft.network/azurefirewalls

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Azure Firewall tier.')
@allowed(['Standard', 'Premium'])
param firewallTier string = 'Standard'

@description('Address space for the firewall VNet.')
param vnetCidr string = '10.62.0.0/24'

@description('Prefix for the required AzureFirewallSubnet (must be at least /26).')
param firewallSubnetCidr string = '10.62.0.0/26'

@description('Loom Console UAMI principal ID — granted Network Contributor so the BFF can manage firewall rule collections. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var suffix = uniqueString(resourceGroup().id)
var vnetName = take('vnet-fw-loom-${suffix}', 64)
var pipName = take('pip-fw-loom-${suffix}', 80)
var fwName = take('afw-loom-${suffix}', 56)

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
        // Azure Firewall requires a subnet named exactly 'AzureFirewallSubnet'.
        name: 'AzureFirewallSubnet'
        properties: {
          addressPrefix: firewallSubnetCidr
        }
      }
    ]
  }
}

resource pip 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: pipName
  location: location
  tags: complianceTags
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

resource firewall 'Microsoft.Network/azureFirewalls@2024-05-01' = {
  name: fwName
  location: location
  tags: complianceTags
  properties: {
    sku: {
      name: 'AZFW_VNet'
      tier: firewallTier
    }
    threatIntelMode: 'Alert'
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          subnet: {
            id: '${vnet.id}/subnets/AzureFirewallSubnet'
          }
          publicIPAddress: {
            id: pip.id
          }
        }
      }
    ]
  }
}

// Network Contributor — manage firewall rule collections over ARM
// (role 4d97b98b-1d4f-4787-a291-c67834d212e7).
resource networkContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: firewall
  name: guid(firewall.id, consolePrincipalId, '4d97b98b-1d4f-4787-a291-c67834d212e7')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4d97b98b-1d4f-4787-a291-c67834d212e7')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output firewallId string = firewall.id
output firewallName string = firewall.name
output firewallPublicIp string = pip.properties.ipAddress
