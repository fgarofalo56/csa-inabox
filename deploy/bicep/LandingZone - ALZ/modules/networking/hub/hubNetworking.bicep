metadata name = 'ALZ Bicep - Hub Networking Module'
metadata description = 'ALZ Bicep Module used to set up Hub Networking'

type subnetOptionsType = ({
  @description('Name of subnet.')
  name: string?

  @description('IP-address range for subnet.')
  ipAddressRange: string

  @description('Id of Network Security Group to associate with subnet.')
  networkSecurityGroupId: string?

  @description('Id of Route Table to associate with subnet.')
  routeTableId: string?

  @description('Name of the delegation to create for the subnet.')
  delegation: string?
})[]

type lockType = {
  @description('Optional. Specify the name of lock.')
  name: string?

  @description('Optional. The lock settings of the service.')
  kind: ('CanNotDelete' | 'ReadOnly' | 'None')

  @description('Optional. Notes about this lock.')
  notes: string?
}

@sys.description('Array to hold all vaules for hub networking module.')
param hubNetwork object

@sys.description('RG for Private DNS Zones')
param parPrivateDnsZonesResourceGroup string

@sys.description('Name of the hub network.')
param parHubNetworkName string
// Variables used for the module

@sys.description('Tags to apply to all resources.')
param parTags object

param parSubnets subnetOptionsType = array(hubNetwork.parSubnets.value)

var varSubnetMap = map(range(0, length(parSubnets)), i => {
  name: parSubnets[i].name
  ipAddressRange: parSubnets[i].ipAddressRange
  networkSecurityGroupId: contains(parSubnets[i], 'networkSecurityGroupId') ? parSubnets[i].networkSecurityGroupId : ''
  routeTableId: contains(parSubnets[i], 'routeTableId')
    ? parSubnets[i].routeTableId
    : resourceId(
        subscription().subscriptionId,
        resourceGroup().name,
        'Microsoft.Network/routeTables',
        hubNetwork.parHubRouteTableName.value
      )
  delegation: contains(parSubnets[i], 'delegation') ? parSubnets[i].delegation : ''
})

var varSubnetProperties = [
  for subnet in varSubnetMap: {
    name: subnet.name
    properties: {
      addressPrefix: subnet.ipAddressRange
      delegations: (empty(subnet.delegation))
        ? null
        : [
            {
              name: subnet.delegation
              properties: {
                serviceName: subnet.delegation
              }
            }
          ]

      networkSecurityGroup: (subnet.name == 'AzureBastionSubnet' && hubNetwork.parAzBastionEnabled.value)
        ? {
            id: '${resourceGroup().id}/providers/Microsoft.Network/networkSecurityGroups/${hubNetwork.parAzBastionNsgName.value}'
          }
        : (empty(subnet.networkSecurityGroupId))
            ? null
            : {
                id: subnet.networkSecurityGroupId
              }

      routeTable: (empty(subnet.routeTableId))
        ? null
        : {
            id: subnet.routeTableId
          }
    }
  }
]

// param parVpnGatewayConfig object = json('${hubNetwork.parVpnGatewayConfig.value}')
var varVpnGwConfig = ((hubNetwork.parVpnGatewayEnabled.value) && (!empty(hubNetwork.parVpnGatewayConfig.value))
  ? hubNetwork.parVpnGatewayConfig.value
  : json('{"name": "noconfigVpn"}'))

// param parExpressRouteGatewayConfig object = json('${hubNetwork.parExpressRouteGatewayConfig.value}')
var varErGwConfig = ((hubNetwork.parExpressRouteGatewayEnabled.value) && !empty(hubNetwork.parExpressRouteGatewayConfig.value)
  ? hubNetwork.parExpressRouteGatewayConfig.value
  : json('{"name": "noconfigEr"}'))

var varGwConfig = [
  varVpnGwConfig
  varErGwConfig
]

var varZtnP1Trigger = (hubNetwork.parDdosEnabled.value && hubNetwork.parAzFirewallEnabled.value && (hubNetwork.parAzFirewallTier.value == 'Premium'))
  ? true
  : false

var varAzFirewallUseCustomPublicIps = length(hubNetwork.parAzFirewallCustomPublicIps.value) > 0

// Resources for the module

//DDos Protection plan will only be enabled if parDdosEnabled is true.
resource resDdosProtectionPlan 'Microsoft.Network/ddosProtectionPlans@2024-05-01' = if (bool(hubNetwork.parDdosEnabled.value)) {
  name: hubNetwork.parDdosPlanName.value
  location: hubNetwork.parLocation
  tags: parTags
}

// Create resource lock if parDdosEnabled is true and parGlobalResourceLock.kind != 'None' or if parDdosLock.kind != 'None'
resource resDDoSProtectionPlanLock 'Microsoft.Authorization/locks@2020-05-01' = if (hubNetwork.parDdosEnabled.value && (hubNetwork.parDdosLock.value.kind != 'None' || hubNetwork.parGlobalResourceLock.value.kind != 'None')) {
  scope: resDdosProtectionPlan
  name: hubNetwork.parDdosLock.value.?name ?? '${resDdosProtectionPlan.name}-lock'
  properties: {
    level: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value.kind
      : hubNetwork.parDdosLock.value.kind
    notes: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value.?notes
      : hubNetwork.parDdosLock.value.?notes
  }
}

resource resHubVnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  dependsOn: [
    resBastionNsg
  ]
  name: parHubNetworkName
  location: hubNetwork.parLocation
  tags: parTags
  properties: {
    addressSpace: {
      addressPrefixes: [
        hubNetwork.parHubNetworkAddressPrefix.value
      ]
    }
    dhcpOptions: {
      dnsServers: hubNetwork.parDnsServerIps.value
    }
    subnets: varSubnetProperties
    enableDdosProtection: hubNetwork.parDdosEnabled.value
    ddosProtectionPlan: (hubNetwork.parDdosEnabled.value)
      ? {
          id: resDdosProtectionPlan.id
        }
      : null
  }
}

// Create a virtual network resource lock if parGlobalResourceLock.kind != 'None' or if parVirtualNetworkLock.kind != 'None'
resource resVirtualNetworkLock 'Microsoft.Authorization/locks@2020-05-01' = if (hubNetwork.parVirtualNetworkLock.value.kind != 'None' || hubNetwork.parGlobalResourceLock.value.kind != 'None') {
  scope: resHubVnet
  name: hubNetwork.parVirtualNetworkLock.value.?name ?? '${resHubVnet.name}-lock'
  properties: {
    level: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value.kind
      : hubNetwork.parVirtualNetworkLock.value.kind
    notes: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value.?notes
      : hubNetwork.parVirtualNetworkLock.value.?notes
  }
}

module modBastionPublicIp '../publicIp/publicIp.bicep' = if (hubNetwork.parAzBastionEnabled.value) {
  name: 'deploy-Bastion-Public-IP'
  params: {
    parLocation: hubNetwork.parLocation
    parPublicIpName: '${hubNetwork.parPublicIpPrefix.value}${hubNetwork.parAzBastionName.value}${hubNetwork.parPublicIpSuffix.value}'
    parPublicIpSku: {
      name: hubNetwork.parPublicIpSku.value
    }
    parPublicIpProperties: {
      publicIpAddressVersion: 'IPv4'
      publicIpAllocationMethod: 'Static'
    }
    parResourceLockConfig: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value
      : hubNetwork.parBastionLock.value
    parTags: parTags
  }
}

resource resBastionSubnetRef 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = if (hubNetwork.parAzBastionEnabled.value) {
  parent: resHubVnet
  name: 'AzureBastionSubnet'
}

resource resBastionNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = if (hubNetwork.parAzBastionEnabled.value) {
  name: hubNetwork.parAzBastionNsgName.value
  location: hubNetwork.parLocation
  tags: parTags

  properties: {
    securityRules: [
      // Inbound Rules
      {
        name: 'AllowHttpsInbound'
        properties: {
          access: 'Allow'
          direction: 'Inbound'
          priority: 120
          sourceAddressPrefix: 'Internet'
          destinationAddressPrefix: '*'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '443'
        }
      }
      {
        name: 'AllowGatewayManagerInbound'
        properties: {
          access: 'Allow'
          direction: 'Inbound'
          priority: 130
          sourceAddressPrefix: 'GatewayManager'
          destinationAddressPrefix: '*'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '443'
        }
      }
      {
        name: 'AllowAzureLoadBalancerInbound'
        properties: {
          access: 'Allow'
          direction: 'Inbound'
          priority: 140
          sourceAddressPrefix: 'AzureLoadBalancer'
          destinationAddressPrefix: '*'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '443'
        }
      }
      {
        name: 'AllowBastionHostCommunication'
        properties: {
          access: 'Allow'
          direction: 'Inbound'
          priority: 150
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: 'VirtualNetwork'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRanges: [
            '8080'
            '5701'
          ]
        }
      }
      {
        name: 'DenyAllInbound'
        properties: {
          access: 'Deny'
          direction: 'Inbound'
          priority: 4096
          sourceAddressPrefix: '*'
          destinationAddressPrefix: '*'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
        }
      }
      // Outbound Rules
      {
        name: 'AllowSshRdpOutbound'
        properties: {
          access: 'Allow'
          direction: 'Outbound'
          priority: 100
          sourceAddressPrefix: '*'
          destinationAddressPrefix: 'VirtualNetwork'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRanges: hubNetwork.parBastionOutboundSshRdpPorts.value
        }
      }
      {
        name: 'AllowAzureCloudOutbound'
        properties: {
          access: 'Allow'
          direction: 'Outbound'
          priority: 110
          sourceAddressPrefix: '*'
          destinationAddressPrefix: 'AzureCloud'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '443'
        }
      }
      {
        name: 'AllowBastionCommunication'
        properties: {
          access: 'Allow'
          direction: 'Outbound'
          priority: 120
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: 'VirtualNetwork'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRanges: [
            '8080'
            '5701'
          ]
        }
      }
      {
        name: 'AllowGetSessionInformation'
        properties: {
          access: 'Allow'
          direction: 'Outbound'
          priority: 130
          sourceAddressPrefix: '*'
          destinationAddressPrefix: 'Internet'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '80'
        }
      }
      {
        name: 'DenyAllOutbound'
        properties: {
          access: 'Deny'
          direction: 'Outbound'
          priority: 4096
          sourceAddressPrefix: '*'
          destinationAddressPrefix: '*'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

// Create bastion nsg resource lock if parAzBastionEnbled is true and parGlobalResourceLock.kind != 'None' or if parBastionLock.kind != 'None'
resource resBastionNsgLock 'Microsoft.Authorization/locks@2020-05-01' = if (hubNetwork.parAzBastionEnabled.value && (hubNetwork.parBastionLock.value.kind != 'None' || hubNetwork.parGlobalResourceLock.value.kind != 'None')) {
  scope: resBastionNsg
  name: hubNetwork.parBastionLock.value.?name ?? '${resBastionNsg.name}-lock'
  properties: {
    level: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value.kind
      : hubNetwork.parBastionLock.value.kind
    notes: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value.?notes
      : hubNetwork.parBastionLock.value.?notes
  }
}

// AzureBastionSubnet is required to deploy Bastion service. This subnet must exist in the parsubnets array if you enable Bastion Service.
// There is a minimum subnet requirement of /27 prefix.
// If you are deploying standard this needs to be larger. https://docs.microsoft.com/en-us/azure/bastion/configuration-settings#subnet
resource resBastion 'Microsoft.Network/bastionHosts@2024-05-01' = if (hubNetwork.parAzBastionEnabled.value) {
  location: hubNetwork.parLocation
  name: hubNetwork.parAzBastionName.value
  tags: parTags
  sku: {
    name: hubNetwork.parAzBastionSku.value
  }
  properties: {
    dnsName: uniqueString(resourceGroup().id)
    enableTunneling: (hubNetwork.parAzBastionSku.value == 'Standard' && hubNetwork.parAzBastionTunneling.value)
      ? hubNetwork.parAzBastionTunneling.value
      : false
    ipConfigurations: [
      {
        name: 'IpConf'
        properties: {
          subnet: {
            id: resBastionSubnetRef.id
          }
          publicIPAddress: {
            id: hubNetwork.parAzBastionEnabled.value ? modBastionPublicIp.outputs.outPublicIpId : ''
          }
        }
      }
    ]
  }
}

// Create Bastion resource lock if parAzBastionEnabled is true and parGlobalResourceLock.kind != 'None' or if parBastionLock.kind != 'None'
resource resBastionLock 'Microsoft.Authorization/locks@2020-05-01' = if (hubNetwork.parAzBastionEnabled.value && (hubNetwork.parBastionLock.value.kind != 'None' || hubNetwork.parGlobalResourceLock.value.kind != 'None')) {
  scope: resBastion
  name: hubNetwork.parBastionLock.value.?name ?? '${resBastion.name}-lock'
  properties: {
    level: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value.kind
      : hubNetwork.parBastionLock.value.kind
    notes: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value.?notes
      : hubNetwork.parBastionLock.value.?notes
  }
}

resource resGatewaySubnetRef 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = if (hubNetwork.parVpnGatewayEnabled.value || hubNetwork.parExpressRouteGatewayEnabled.value) {
  parent: resHubVnet
  name: 'GatewaySubnet'
}

module modGatewayPublicIp '../publicIp/publicIp.bicep' = [
  for (gateway, i) in varGwConfig: if ((gateway.name != 'noconfigVpn') && (gateway.name != 'noconfigEr')) {
    name: 'deploy-Gateway-Public-IP-${i}'
    params: {
      parLocation: hubNetwork.parLocation
      parAvailabilityZones: toLower(gateway.gatewayType) == 'expressroute'
        ? hubNetwork.parAzErGatewayAvailabilityZones.value
        : toLower(gateway.gatewayType) == 'vpn' ? hubNetwork.parAzVpnGatewayAvailabilityZones.value : []
      parPublicIpName: '${hubNetwork.parPublicIpPrefix.value}${gateway.name}${hubNetwork.parPublicIpSuffix.value}'
      parPublicIpProperties: {
        publicIpAddressVersion: 'IPv4'
        publicIpAllocationMethod: 'Static'
      }
      parPublicIpSku: {
        name: hubNetwork.parPublicIpSku.value
      }
      parResourceLockConfig: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
        ? hubNetwork.parGlobalResourceLock.value
        : hubNetwork.parVirtualNetworkGatewayLock.value
      parTags: parTags
    }
  }
]

//Minumum subnet size is /27 supporting documentation https://docs.microsoft.com/en-us/azure/vpn-gateway/vpn-gateway-about-vpn-gateway-settings#gwsub
resource resGateway 'Microsoft.Network/virtualNetworkGateways@2024-05-01' = [
  for (gateway, i) in varGwConfig: if ((gateway.name != 'noconfigVpn') && (gateway.name != 'noconfigEr')) {
    name: gateway.name
    location: hubNetwork.parLocation
    tags: parTags
    properties: {
      activeActive: gateway.activeActive
      enableBgp: gateway.enableBgp
      enableBgpRouteTranslationForNat: gateway.enableBgpRouteTranslationForNat
      enableDnsForwarding: gateway.enableDnsForwarding
      bgpSettings: (gateway.enableBgp) ? gateway.bgpSettings : null
      gatewayType: gateway.gatewayType
      vpnGatewayGeneration: (toLower(gateway.gatewayType) == 'vpn') ? gateway.generation : 'None'
      vpnType: gateway.vpnType
      sku: {
        name: gateway.sku
        tier: gateway.sku
      }
      vpnClientConfiguration: (toLower(gateway.gatewayType) == 'vpn')
        ? {
            vpnClientAddressPool: contains(gateway.vpnClientConfiguration, 'vpnClientAddressPool')
              ? gateway.vpnClientConfiguration.vpnClientAddressPool
              : ''
            vpnClientProtocols: contains(gateway.vpnClientConfiguration, 'vpnClientProtocols')
              ? gateway.vpnClientConfiguration.vpnClientProtocols
              : ''
            vpnAuthenticationTypes: contains(gateway.vpnClientConfiguration, 'vpnAuthenticationTypes')
              ? gateway.vpnClientConfiguration.vpnAuthenticationTypes
              : ''
            aadTenant: contains(gateway.vpnClientConfiguration, 'aadTenant')
              ? gateway.vpnClientConfiguration.aadTenant
              : ''
            aadAudience: contains(gateway.vpnClientConfiguration, 'aadAudience')
              ? gateway.vpnClientConfiguration.aadAudience
              : ''
            aadIssuer: contains(gateway.vpnClientConfiguration, 'aadIssuer')
              ? gateway.vpnClientConfiguration.aadIssuer
              : ''
            vpnClientRootCertificates: contains(gateway.vpnClientConfiguration, 'vpnClientRootCertificates')
              ? gateway.vpnClientConfiguration.vpnClientRootCertificates
              : ''
            radiusServerAddress: contains(gateway.vpnClientConfiguration, 'radiusServerAddress')
              ? gateway.vpnClientConfiguration.radiusServerAddress
              : ''
            radiusServerSecret: contains(gateway.vpnClientConfiguration, 'radiusServerSecret')
              ? gateway.vpnClientConfiguration.radiusServerSecret
              : ''
          }
        : null
      ipConfigurations: [
        {
          id: resHubVnet.id
          name: 'vnetGatewayConfig'
          properties: {
            publicIPAddress: {
              id: (((gateway.name != 'noconfigVpn') && (gateway.name != 'noconfigEr'))
                ? modGatewayPublicIp[i].outputs.outPublicIpId
                : 'na')
            }
            subnet: {
              id: resGatewaySubnetRef.id
            }
          }
        }
      ]
    }
  }
]

// Create a Virtual Network Gateway resource lock if gateway.name is not equal to noconfigVpn or noconfigEr and parGlobalResourceLock.kind != 'None' or if parVirtualNetworkGatewayLock.kind != 'None'
resource resVirtualNetworkGatewayLock 'Microsoft.Authorization/locks@2020-05-01' = [
  for (gateway, i) in varGwConfig: if ((gateway.name != 'noconfigVpn') && (gateway.name != 'noconfigEr') && (hubNetwork.parVirtualNetworkGatewayLock.value.kind != 'None' || hubNetwork.parGlobalResourceLock.value.kind != 'None')) {
    scope: resGateway[i]
    name: hubNetwork.parVirtualNetworkGatewayLock.value.?name ?? '${resGateway[i].name}-lock'
    properties: {
      level: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
        ? hubNetwork.parGlobalResourceLock.value.kind
        : hubNetwork.parVirtualNetworkGatewayLock.value.kind
      notes: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
        ? hubNetwork.parGlobalResourceLock.value.?notes
        : hubNetwork.parVirtualNetworkGatewayLock.value.?notes
    }
  }
]

resource resAzureFirewallSubnetRef 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = if (hubNetwork.parAzFirewallEnabled.value) {
  parent: resHubVnet
  name: 'AzureFirewallSubnet'
}

resource resAzureFirewallMgmtSubnetRef 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = if (hubNetwork.parAzFirewallEnabled.value && (contains(
  map(parSubnets, subnets => subnets.name),
  'AzureFirewallManagementSubnet'
))) {
  parent: resHubVnet
  name: 'AzureFirewallManagementSubnet'
}

module modAzureFirewallPublicIp '../publicIp/publicIp.bicep' = if (hubNetwork.parAzFirewallEnabled.value) {
  name: 'deploy-Firewall-Public-IP'
  params: {
    parLocation: hubNetwork.parLocation
    parAvailabilityZones: hubNetwork.parAzFirewallAvailabilityZones.value
    parPublicIpName: '${hubNetwork.parPublicIpPrefix.value}${hubNetwork.parAzFirewallName.value}${hubNetwork.parPublicIpSuffix.value}'
    parPublicIpProperties: {
      publicIpAddressVersion: 'IPv4'
      publicIpAllocationMethod: 'Static'
    }
    parPublicIpSku: {
      name: hubNetwork.parPublicIpSku.value
    }
    parResourceLockConfig: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value
      : hubNetwork.parAzureFirewallLock.value
    parTags: parTags
  }
}

module modAzureFirewallMgmtPublicIp '../publicIp/publicIp.bicep' = if (hubNetwork.parAzFirewallEnabled.value && (contains(
  map(parSubnets, subnets => subnets.name),
  'AzureFirewallManagementSubnet'
))) {
  name: 'deploy-Firewall-mgmt-Public-IP'
  params: {
    parLocation: hubNetwork.parLocation
    parAvailabilityZones: hubNetwork.parAzFirewallAvailabilityZones.value
    parPublicIpName: '${hubNetwork.parPublicIpPrefix.value}${hubNetwork.parAzFirewallName.value}-mgmt${hubNetwork.parPublicIpSuffix.value}'
    parPublicIpProperties: {
      publicIpAddressVersion: 'IPv4'
      publicIpAllocationMethod: 'Static'
    }
    parPublicIpSku: {
      name: 'Standard'
    }
    parResourceLockConfig: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value
      : hubNetwork.parAzureFirewallLock.value
    parTags: parTags
  }
}

resource resFirewallPolicies 'Microsoft.Network/firewallPolicies@2024-03-01' = if (hubNetwork.parAzFirewallEnabled.value && hubNetwork.parAzFirewallPoliciesEnabled.value) {
  name: hubNetwork.parAzFirewallPoliciesName.value
  location: hubNetwork.parLocation
  tags: parTags
  properties: (hubNetwork.parAzFirewallTier.value == 'Basic')
    ? {
        sku: {
          tier: hubNetwork.parAzFirewallTier.value
        }
        threatIntelMode: 'Alert'
      }
    : {
        dnsSettings: {
          enableProxy: hubNetwork.parAzFirewallDnsProxyEnabled.value
          servers: hubNetwork.parAzFirewallDnsServers.value
        }
        sku: {
          tier: hubNetwork.parAzFirewallTier.value
        }
        threatIntelMode: hubNetwork.parAzFirewallIntelMode.value
      }
}

// Create Azure Firewall Policy resource lock if parAzFirewallEnabled is true and parGlobalResourceLock.kind != 'None' or if parAzureFirewallLock.kind != 'None'
resource resFirewallPoliciesLock 'Microsoft.Authorization/locks@2020-05-01' = if (hubNetwork.parAzFirewallEnabled.value && (hubNetwork.parAzureFirewallLock.value.kind != 'None' || hubNetwork.parGlobalResourceLock.value.kind != 'None')) {
  scope: resFirewallPolicies
  name: hubNetwork.parAzureFirewallLock.?name ?? '${resFirewallPolicies.name}-lock'
  properties: {
    level: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value.kind
      : hubNetwork.parAzureFirewallLock.value.kind
    notes: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value.?notes
      : hubNetwork.parAzureFirewallLock.value.?notes
  }
}

// AzureFirewallSubnet is required to deploy Azure Firewall . This subnet must exist in the parsubnets array if you deploy.
// There is a minimum subnet requirement of /26 prefix.
resource resAzureFirewall 'Microsoft.Network/azureFirewalls@2024-03-01' = if (hubNetwork.parAzFirewallEnabled.value) {
  dependsOn: [
    resGateway
  ]
  name: hubNetwork.parAzFirewallName.value
  location: hubNetwork.parLocation
  tags: parTags
  zones: (!empty(hubNetwork.parAzFirewallAvailabilityZones.value) ? hubNetwork.parAzFirewallAvailabilityZones.value : [])
  properties: hubNetwork.parAzFirewallTier.value == 'Basic'
    ? {
        ipConfigurations: varAzFirewallUseCustomPublicIps
          ? map(hubNetwork.parAzFirewallCustomPublicIps, ip => {
              name: 'ipconfig${uniqueString(ip)}'
              properties: ip == hubNetwork.parAzFirewallCustomPublicIps.value[0]
                ? {
                    subnet: {
                      id: resAzureFirewallSubnetRef.id
                    }
                    publicIPAddress: {
                      id: hubNetwork.parAzFirewallEnabled.value ? ip : ''
                    }
                  }
                : {
                    publicIPAddress: {
                      id: hubNetwork.parAzFirewallEnabled.value ? ip : ''
                    }
                  }
            })
          : [
              {
                name: 'ipconfig1'
                properties: {
                  subnet: {
                    id: resAzureFirewallSubnetRef.id
                  }
                  publicIPAddress: {
                    id: hubNetwork.parAzFirewallEnabled.value ? modAzureFirewallPublicIp.outputs.outPublicIpId : ''
                  }
                }
              }
            ]
        managementIpConfiguration: {
          name: 'mgmtIpConfig'
          properties: {
            publicIPAddress: {
              id: hubNetwork.parAzFirewallEnabled.value ? modAzureFirewallMgmtPublicIp.outputs.outPublicIpId : ''
            }
            subnet: {
              id: resAzureFirewallMgmtSubnetRef.id
            }
          }
        }
        sku: {
          name: 'AZFW_VNet'
          tier: hubNetwork.parAzFirewallTier.value
        }
        firewallPolicy: {
          id: resFirewallPolicies.id
        }
      }
    : {
        ipConfigurations: varAzFirewallUseCustomPublicIps
          ? map(hubNetwork.parAzFirewallCustomPublicIps.value, ip => {
              name: 'ipconfig${uniqueString(ip)}'
              properties: ip == hubNetwork.parAzFirewallCustomPublicIps.value[0]
                ? {
                    subnet: {
                      id: resAzureFirewallSubnetRef.id
                    }
                    publicIPAddress: {
                      id: hubNetwork.parAzFirewallEnabled.value ? ip : ''
                    }
                  }
                : {
                    publicIPAddress: {
                      id: hubNetwork.parAzFirewallEnabled.value ? ip : ''
                    }
                  }
            })
          : [
              {
                name: 'ipconfig1'
                properties: {
                  subnet: {
                    id: resAzureFirewallSubnetRef.id
                  }
                  publicIPAddress: {
                    id: hubNetwork.parAzFirewallEnabled.value ? modAzureFirewallPublicIp.outputs.outPublicIpId : ''
                  }
                }
              }
            ]
        sku: {
          name: 'AZFW_VNet'
          tier: hubNetwork.parAzFirewallTier.value
        }
        firewallPolicy: {
          id: resFirewallPolicies.id
        }
      }
}

// Create Azure Firewall resource lock if parAzFirewallEnabled is true and parGlobalResourceLock.kind != 'None' or if parAzureFirewallLock.kind != 'None'
resource resAzureFirewallLock 'Microsoft.Authorization/locks@2020-05-01' = if (hubNetwork.parAzFirewallEnabled.value && (hubNetwork.parAzureFirewallLock.value.kind != 'None' || hubNetwork.parGlobalResourceLock.value.kind != 'None')) {
  scope: resAzureFirewall
  name: hubNetwork.parAzureFirewallLock.value.?name ?? '${resAzureFirewall.name}-lock'
  properties: {
    level: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value.kind
      : hubNetwork.parAzureFirewallLock.value.kind
    notes: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value.?notes
      : hubNetwork.parAzureFirewallLock.value.?notes
  }
}

//If Azure Firewall is enabled we will deploy a RouteTable to redirect Traffic to the Firewall.
resource resHubRouteTable 'Microsoft.Network/routeTables@2024-05-01' = if (hubNetwork.parAzFirewallEnabled.value) {
  name: '${hubNetwork.parHubRouteTableName.value}'
  location: hubNetwork.parLocation
  tags: parTags
  properties: {
    routes: [
      {
        name: 'udr-default-azfw'
        properties: {
          addressPrefix: '0.0.0.0/0'
          nextHopType: 'VirtualAppliance'
          nextHopIpAddress: hubNetwork.parAzFirewallEnabled.value
            ? resAzureFirewall.properties.ipConfigurations[0].properties.privateIPAddress
            : ''
        }
      }
    ]
    disableBgpRoutePropagation: hubNetwork.parDisableBgpRoutePropagation.value
  }
}

// Create a Route Table if parAzFirewallEnabled is true and parGlobalResourceLock.kind != 'None' or if parHubRouteTableLock.kind != 'None'
resource resHubRouteTableLock 'Microsoft.Authorization/locks@2020-05-01' = if (hubNetwork.parAzFirewallEnabled.value && (hubNetwork.parHubRouteTableLock.value.kind != 'None' || hubNetwork.parGlobalResourceLock.value.kind != 'None')) {
  scope: resHubRouteTable
  name: hubNetwork.parHubRouteTableLock.value.?name ?? '${resHubRouteTable.name}-lock'
  properties: {
    level: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value.kind
      : hubNetwork.parHubRouteTableLock.value.kind
    notes: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value.?notes
      : hubNetwork.parHubRouteTableLock.value.?notes
  }
}

module modPrivateDnsZones '../privateDnsZones/privateDnsZones.bicep' = if (hubNetwork.parPrivateDnsZonesEnabled.value) {
  name: 'deploy-Private-DNS-Zones'
  scope: resourceGroup(parPrivateDnsZonesResourceGroup)
  params: {
    parLocation: hubNetwork.parLocation
    parTags: parTags
    parVirtualNetworkIdToLink: resHubVnet.id
    parVirtualNetworkIdToLinkFailover: hubNetwork.parVirtualNetworkIdToLinkFailover.value
    parPrivateDnsZoneAutoMergeAzureBackupZone: hubNetwork.parPrivateDnsZoneAutoMergeAzureBackupZone.value
    parResourceLockConfig: (hubNetwork.parGlobalResourceLock.value.kind != 'None')
      ? hubNetwork.parGlobalResourceLock.value
      : hubNetwork.parPrivateDNSZonesLock.value
  }
}

//If Azure Firewall is enabled we will deploy a RouteTable to redirect Traffic to the Firewall.
output outAzFirewallPrivateIp string = hubNetwork.parAzFirewallEnabled.value
  ? resAzureFirewall.properties.ipConfigurations[0].properties.privateIPAddress
  : ''

//If Azure Firewall is enabled we will deploy a RouteTable to redirect Traffic to the Firewall.
output outAzFirewallName string = hubNetwork.parAzFirewallEnabled.value ? hubNetwork.parAzFirewallName.value : ''

output outPrivateDnsZones array = (hubNetwork.parPrivateDnsZonesEnabled.value
  ? modPrivateDnsZones.outputs.outPrivateDnsZones
  : [])
output outPrivateDnsZonesNames array = (hubNetwork.parPrivateDnsZonesEnabled.value
  ? modPrivateDnsZones.outputs.outPrivateDnsZonesNames
  : [])

output outDdosPlanResourceId string = resDdosProtectionPlan.id
output outHubVirtualNetworkName string = resHubVnet.name
output outHubVirtualNetworkId string = resHubVnet.id
output outHubRouteTableId string = hubNetwork.parAzFirewallEnabled.value ? resHubRouteTable.id : ''
output outHubRouteTableName string = hubNetwork.parAzFirewallEnabled.value ? resHubRouteTable.name : ''
output outBastionNsgId string = hubNetwork.parAzBastionEnabled.value ? resBastionNsg.id : ''
output outBastionNsgName string = hubNetwork.parAzBastionEnabled.value ? resBastionNsg.name : ''
output outHubVirtualNetworkSubscriptionId string = subscription().subscriptionId
output outHubVirtualNetworkResourceGroup string = resourceGroup().name
