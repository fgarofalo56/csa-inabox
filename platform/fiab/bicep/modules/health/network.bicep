// CSA Loom Health Data Services (LHDS) - stamp network.
//
// Owns the stamp VNet, its subnets, the private DNS zones every stamp service
// resolves through, and (optionally) the egress firewall + route table that
// make the private AKS cluster's outbound traffic an explicit allow-list
// (SECURITY-AND-COMPLIANCE.md s5). One VNet per stamp: a stamp is a cell and
// shares no network with another stamp (ADR-005).
//
// Cloud parity: every suffix comes from environment() (or the same boundary
// ternary admin-plane/network.bicep uses where ARM exposes no suffix), so the
// module builds and resolves in Commercial, GCC-High and IL5.

targetScope = 'resourceGroup'

@description('Region of the stamp.')
param location string

@description('Stamp short name (lowercase letters/digits/hyphen); folded into resource names.')
param stampName string

@description('Cloud boundary. Drives the Key Vault / Service Bus private-link zone suffixes and the monitor FQDNs on the egress allow-list.')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('Stamp VNet address space. Must not overlap the AKS pod CIDR, the AKS service CIDR, or any network the stamp is peered with.')
param vnetAddressPrefix string = '10.60.0.0/16'

@description('Outbound model for the AKS node subnet. firewall = user-defined routing through an Azure Firewall with an FQDN allow-list (class S/M/L default). loadBalancer = the cluster load balancer SNAT (dev profile only; no allow-list).')
@allowed(['firewall', 'loadBalancer'])
param egressMode string = 'firewall'

@description('Azure Firewall policy tier.')
@allowed(['Standard', 'Premium'])
param firewallSku string = 'Standard'

@description('Login server of the shared ACR the stamp pulls images from (for example myacr.azurecr.io). Empty = no ACR rule. The matching data endpoint wildcard is added automatically.')
param acrLoginServer string = ''

@description('Extra FQDNs to allow outbound. Adding one is a reviewed change (SECURITY-AND-COMPLIANCE.md s5).')
param extraAllowedFqdns array = []

@description('Resource ids of additional VNets (for example the hub that hosts the control plane) to link to every private DNS zone so they resolve stamp endpoints privately.')
param extraDnsLinkVnetIds array = []

@description('Tags applied to every resource.')
param tags object = {}

var isGov = boundary == 'GCC-High' || boundary == 'IL5'
var useFirewall = egressMode == 'firewall'

// Subnet plan, derived from the VNet prefix so a stamp can be re-addressed with
// one parameter. /22 nodes, /24 for private endpoints, PostgreSQL, App Gateway,
// and a /26 for the firewall.
var aksPrefix = cidrSubnet(vnetAddressPrefix, 22, 0)
var pePrefix = cidrSubnet(vnetAddressPrefix, 24, 4)
var pgPrefix = cidrSubnet(vnetAddressPrefix, 24, 5)
var agwPrefix = cidrSubnet(vnetAddressPrefix, 24, 6)
var fwPrefix = cidrSubnet(vnetAddressPrefix, 26, 28)

// Fixed address inside the node subnet for the ingress controller's internal
// load balancer; the App Gateway backend pool targets it. High host index so it
// never collides with node/pod-less dynamic allocation from the low end.
var ingressIlbIp = cidrHost(aksPrefix, 1000)

// ── Private DNS zone names (per cloud) ───────────────────────────────────────
// PostgreSQL's data-plane suffix differs from the SQL suffix in Commercial
// ('.database.azure.com' vs '.database.windows.net'); in Gov they coincide.
// '.database.windows.net' below is a COMPARISON key, not an endpoint.
#disable-next-line no-hardcoded-env-urls
var pgHostSuffix = environment().suffixes.sqlServerHostname == '.database.windows.net' ? '.database.azure.com' : environment().suffixes.sqlServerHostname
// VNet-integrated (delegated subnet) PostgreSQL needs a zone whose name ends in
// postgres.database.<suffix>; postgres.bicep creates and links this zone. A distinct stamp-scoped name avoids colliding with
// any privatelink.postgres zone already linked to the same VNet.
var postgresZoneName = 'lhds-${stampName}.private.postgres${pgHostSuffix}'
// keyvaultDns is '.vault.azure.net' / '.vault.usgovcloudapi.net'; dropping the leading '.vault' leaves the cloud suffix.
var vaultZoneName = 'privatelink.vaultcore${substring(environment().suffixes.keyvaultDns, length('.vault'))}'
var blobZoneName = 'privatelink.blob.${environment().suffixes.storage}'
var serviceBusZoneName = 'privatelink.servicebus.${isGov ? 'usgovcloudapi.net' : 'windows.net'}'

var zoneNames = [
  { key: 'vault', name: vaultZoneName }
  { key: 'blob', name: blobZoneName }
  { key: 'eventhubs', name: serviceBusZoneName }
]

// ── Egress allow-list hosts, derived from environment() ──────────────────────
var loginHost = replace(replace(environment().authentication.loginEndpoint, 'https://', ''), '/', '')
var armHost = replace(replace(environment().resourceManager, 'https://', ''), '/', '')
var monitorDomain = isGov ? 'azure.us' : 'azure.com'
var acrDataFqdn = empty(acrLoginServer) ? [] : [
  acrLoginServer
  '*.data.${substring(acrLoginServer, indexOf(acrLoginServer, '.') + 1)}'
]
var allowedFqdns = union([
  loginHost
  armHost
  '*.ods.opinsights.${monitorDomain}'
  '*.oms.opinsights.${monitorDomain}'
  '*.monitoring.${monitorDomain}'
], acrDataFqdn, extraAllowedFqdns)

// ── NSG for the App Gateway subnet (v2 mandatory rules) ──────────────────────
resource agwNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-lhds-${stampName}-agw'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'allow-gateway-manager'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'GatewayManager'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '65200-65535'
        }
      }
      {
        name: 'allow-https-http-inbound'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRanges: ['80', '443']
        }
      }
      {
        name: 'allow-azure-load-balancer'
        properties: {
          priority: 120
          direction: 'Inbound'
          access: 'Allow'
          protocol: '*'
          sourceAddressPrefix: 'AzureLoadBalancer'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

// ── Egress firewall (class S/M/L) ────────────────────────────────────────────
resource fwPip 'Microsoft.Network/publicIPAddresses@2024-05-01' = if (useFirewall) {
  name: 'pip-fw-lhds-${stampName}'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  zones: ['1', '2', '3']
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
  }
}

resource fwPolicy 'Microsoft.Network/firewallPolicies@2024-05-01' = if (useFirewall) {
  name: 'fwp-lhds-${stampName}'
  location: location
  tags: tags
  properties: {
    sku: { tier: firewallSku }
    threatIntelMode: 'Deny'
  }
}

resource fwRules 'Microsoft.Network/firewallPolicies/ruleCollectionGroups@2024-05-01' = if (useFirewall) {
  parent: fwPolicy
  name: 'lhds-egress'
  properties: {
    priority: 200
    ruleCollections: [
      {
        ruleCollectionType: 'FirewallPolicyFilterRuleCollection'
        name: 'aks-required'
        priority: 100
        action: { type: 'Allow' }
        rules: [
          {
            ruleType: 'ApplicationRule'
            name: 'aks-fqdn-tag'
            sourceAddresses: [aksPrefix]
            protocols: [
              { protocolType: 'Https', port: 443 }
            ]
            fqdnTags: ['AzureKubernetesService']
          }
          {
            ruleType: 'ApplicationRule'
            name: 'stamp-allow-list'
            sourceAddresses: [aksPrefix]
            protocols: [
              { protocolType: 'Https', port: 443 }
            ]
            targetFqdns: allowedFqdns
          }
        ]
      }
    ]
  }
}

resource firewall 'Microsoft.Network/azureFirewalls@2024-05-01' = if (useFirewall) {
  name: 'fw-lhds-${stampName}'
  location: location
  tags: tags
  zones: ['1', '2', '3']
  properties: {
    sku: { name: 'AZFW_VNet', tier: firewallSku }
    firewallPolicy: { id: fwPolicy.id }
    ipConfigurations: [
      {
        name: 'fw-ipconfig'
        properties: {
          subnet: { id: snetFirewall.id }
          publicIPAddress: { id: fwPip.id }
        }
      }
    ]
  }
  dependsOn: [
    fwRules
  ]
}

resource routeTable 'Microsoft.Network/routeTables@2024-05-01' = if (useFirewall) {
  name: 'rt-lhds-${stampName}-aks'
  location: location
  tags: tags
  properties: {
    disableBgpRoutePropagation: true
    routes: [
      {
        name: 'default-via-firewall'
        properties: {
          addressPrefix: '0.0.0.0/0'
          nextHopType: 'VirtualAppliance'
          nextHopIpAddress: firewall!.properties.ipConfigurations[0].properties.privateIPAddress
        }
      }
    ]
  }
}

// ── VNet + subnets ───────────────────────────────────────────────────────────
// Subnets are child resources, not inline, because the node subnet carries the
// route table whose next hop is the firewall's private IP, and the firewall
// needs its own subnet to exist first. Inline subnets would make that a cycle.
// They are chained with dependsOn: concurrent subnet PUTs on one VNet race in ARM.
resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-lhds-${stampName}'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [vnetAddressPrefix] }
  }
}

resource snetFirewall 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = if (useFirewall) {
  parent: vnet
  name: 'AzureFirewallSubnet'
  properties: { addressPrefix: fwPrefix }
}

resource snetPe 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: 'snet-pe'
  properties: {
    addressPrefix: pePrefix
    privateEndpointNetworkPolicies: 'Enabled'
  }
  dependsOn: [snetFirewall]
}

resource snetPostgres 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: 'snet-postgres'
  properties: {
    addressPrefix: pgPrefix
    delegations: [
      {
        name: 'postgres-flexible'
        properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' }
      }
    ]
  }
  dependsOn: [snetPe]
}

resource snetAgw 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: 'snet-agw'
  properties: {
    addressPrefix: agwPrefix
    networkSecurityGroup: { id: agwNsg.id }
  }
  dependsOn: [snetPostgres]
}

resource snetAks 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: 'snet-aks'
  properties: {
    addressPrefix: aksPrefix
    routeTable: useFirewall ? { id: routeTable.id } : null
  }
  dependsOn: [snetAgw]
}

// ── Private DNS zones + links ────────────────────────────────────────────────
resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for z in zoneNames: {
  name: z.name
  location: 'global'
  tags: tags
}]

resource stampLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (z, i) in zoneNames: {
  parent: zones[i]
  name: 'link-stamp'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}]

// Extra links (hub VNets). @batchSize(1): concurrent link PUTs against one zone
// race in ARM.
@batchSize(1)
resource extraLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (pair, i) in flatten(map(range(0, length(zoneNames)), zi => map(extraDnsLinkVnetIds, v => { zoneIndex: zi, vnetId: v }))): {
  parent: zones[pair.zoneIndex]
  name: 'link-${uniqueString(pair.vnetId)}'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: pair.vnetId }
  }
}]

output postgresZoneName string = postgresZoneName
output vnetId string = vnet.id
output vnetName string = vnet.name
output aksSubnetId string = snetAks.id
output peSubnetId string = snetPe.id
output postgresSubnetId string = snetPostgres.id
output agwSubnetId string = snetAgw.id
output ingressIlbIp string = ingressIlbIp
output routeTableId string = useFirewall ? routeTable.id : ''
output firewallPrivateIp string = useFirewall ? firewall!.properties.ipConfigurations[0].properties.privateIPAddress : ''
output firewallPublicIp string = useFirewall ? fwPip!.properties.ipAddress : ''
output egressFqdns array = useFirewall ? allowedFqdns : []
output privateDnsZoneIds object = {
  vault: zones[0].id
  blob: zones[1].id
  eventhubs: zones[2].id
}
