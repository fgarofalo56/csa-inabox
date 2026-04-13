// =============================================================================
// CSA-in-a-Box: Predefined NSG Rule Sets
// Returns well-known rule arrays for common subnet types.  Feed the output
// into nsg.bicep's parSecurityRules parameter.
//
// Usage in a parent template:
//   module rules 'nsgRules.bicep' = { params: { parSubnetType: 'data' } }
//   module nsg   'nsg.bicep'      = { params: { parSecurityRules: rules.outputs.rules } }
// =============================================================================
targetScope = 'resourceGroup'

@description('Subnet type.  Determines which predefined rule set is returned.')
@allowed([
  'data'        // ADLS, Synapse, Cosmos private endpoints
  'compute'     // Databricks, Spark, ML workloads
  'management'  // Bastion, jump-boxes, admin tools
  'integration' // Data Factory, Event Hub, Functions
])
param parSubnetType string

@description('Optional CIDR of the hub VNet for management traffic rules.  Leave empty to use VirtualNetwork tag.')
param parHubAddressPrefix string = ''

// Common deny-all at the bottom of every rule set
var denyAllInbound = {
  name: 'DenyAllInbound'
  priority: 4096
  direction: 'Inbound'
  access: 'Deny'
  protocol: '*'
  sourceAddressPrefix: '*'
  sourcePortRange: '*'
  destinationAddressPrefix: '*'
  destinationPortRange: '*'
  description: 'Default deny — all inbound traffic not explicitly allowed is dropped.'
}

// Common outbound rules — allow essential Azure services, deny everything else
var outboundAllowAzureCloud = {
  name: 'AllowAzureCloudOutbound'
  priority: 100
  direction: 'Outbound'
  access: 'Allow'
  protocol: 'Tcp'
  sourceAddressPrefix: 'VirtualNetwork'
  destinationAddressPrefix: 'AzureCloud'
  destinationPortRange: '443'
  description: 'Allow HTTPS outbound to Azure Cloud services.'
}

var outboundAllowAAD = {
  name: 'AllowAADOutbound'
  priority: 110
  direction: 'Outbound'
  access: 'Allow'
  protocol: 'Tcp'
  sourceAddressPrefix: 'VirtualNetwork'
  destinationAddressPrefix: 'AzureActiveDirectory'
  destinationPortRange: '443'
  description: 'Allow HTTPS outbound to Azure Active Directory.'
}

var outboundAllowMonitor = {
  name: 'AllowAzureMonitorOutbound'
  priority: 120
  direction: 'Outbound'
  access: 'Allow'
  protocol: 'Tcp'
  sourceAddressPrefix: 'VirtualNetwork'
  destinationAddressPrefix: 'AzureMonitor'
  destinationPortRange: '443'
  description: 'Allow HTTPS outbound to Azure Monitor.'
}

var denyAllOutbound = {
  name: 'DenyAllOutbound'
  priority: 4096
  direction: 'Outbound'
  access: 'Deny'
  protocol: '*'
  sourceAddressPrefix: '*'
  sourcePortRange: '*'
  destinationAddressPrefix: '*'
  destinationPortRange: '*'
  description: 'Default deny — all outbound traffic not explicitly allowed is dropped.'
}

var hubSource = !empty(parHubAddressPrefix) ? parHubAddressPrefix : 'VirtualNetwork'

// Data subnet rules — allow private endpoint traffic from VNet, deny internet
var dataRules = [
  {
    name: 'AllowVNetInbound'
    priority: 100
    direction: 'Inbound'
    access: 'Allow'
    protocol: '*'
    sourceAddressPrefix: 'VirtualNetwork'
    destinationAddressPrefix: 'VirtualNetwork'
    description: 'Allow VNet traffic for private endpoint access.'
  }
  {
    name: 'AllowAzureLoadBalancer'
    priority: 110
    direction: 'Inbound'
    access: 'Allow'
    protocol: '*'
    sourceAddressPrefix: 'AzureLoadBalancer'
    destinationAddressPrefix: '*'
    description: 'Required for Azure health probes.'
  }
  {
    name: 'DenyInternetInbound'
    priority: 4000
    direction: 'Inbound'
    access: 'Deny'
    protocol: '*'
    sourceAddressPrefix: 'Internet'
    destinationAddressPrefix: '*'
    description: 'Block all internet inbound.'
  }
  denyAllInbound
  outboundAllowAzureCloud
  outboundAllowAAD
  outboundAllowMonitor
  denyAllOutbound
]

// Compute subnet rules — allow SSH/RDP from hub, allow VNet, deny internet
var computeRules = [
  {
    name: 'AllowSshFromHub'
    priority: 100
    direction: 'Inbound'
    access: 'Allow'
    protocol: 'Tcp'
    sourceAddressPrefix: hubSource
    destinationPortRange: '22'
    description: 'Allow SSH from hub/management subnet.'
  }
  {
    name: 'AllowDatabricksWorkerIntra'
    priority: 110
    direction: 'Inbound'
    access: 'Allow'
    protocol: '*'
    sourceAddressPrefix: 'VirtualNetwork'
    destinationAddressPrefix: 'VirtualNetwork'
    description: 'Allow Databricks worker node communication within the VNet.'
  }
  {
    name: 'AllowAzureLoadBalancer'
    priority: 120
    direction: 'Inbound'
    access: 'Allow'
    protocol: '*'
    sourceAddressPrefix: 'AzureLoadBalancer'
    destinationAddressPrefix: '*'
    description: 'Required for Azure health probes.'
  }
  {
    name: 'DenyInternetInbound'
    priority: 4000
    direction: 'Inbound'
    access: 'Deny'
    protocol: '*'
    sourceAddressPrefix: 'Internet'
    destinationAddressPrefix: '*'
    description: 'Block all internet inbound.'
  }
  denyAllInbound
  outboundAllowAzureCloud
  outboundAllowAAD
  outboundAllowMonitor
  denyAllOutbound
]

// Management subnet rules — allow HTTPS + RDP from hub, Bastion
var managementRules = [
  {
    name: 'AllowHttpsFromHub'
    priority: 100
    direction: 'Inbound'
    access: 'Allow'
    protocol: 'Tcp'
    sourceAddressPrefix: hubSource
    destinationPortRange: '443'
    description: 'Allow HTTPS management traffic from hub.'
  }
  {
    name: 'AllowRdpFromHub'
    priority: 110
    direction: 'Inbound'
    access: 'Allow'
    protocol: 'Tcp'
    sourceAddressPrefix: hubSource
    destinationPortRange: '3389'
    description: 'Allow RDP from hub for jump-box access.'
  }
  {
    name: 'AllowBastionInbound'
    priority: 120
    direction: 'Inbound'
    access: 'Allow'
    protocol: 'Tcp'
    sourceAddressPrefix: hubSource
    destinationPortRange: '8080'
    description: 'Allow Bastion traffic.'
  }
  {
    name: 'AllowAzureLoadBalancer'
    priority: 130
    direction: 'Inbound'
    access: 'Allow'
    protocol: '*'
    sourceAddressPrefix: 'AzureLoadBalancer'
    destinationAddressPrefix: '*'
    description: 'Required for Azure health probes.'
  }
  {
    name: 'DenyInternetInbound'
    priority: 4000
    direction: 'Inbound'
    access: 'Deny'
    protocol: '*'
    sourceAddressPrefix: 'Internet'
    destinationAddressPrefix: '*'
    description: 'Block all internet inbound.'
  }
  denyAllInbound
  outboundAllowAzureCloud
  outboundAllowAAD
  outboundAllowMonitor
  denyAllOutbound
]

// Integration subnet rules — allow HTTPS + AMQP from VNet, deny internet
var integrationRules = [
  {
    name: 'AllowHttpsFromVNet'
    priority: 100
    direction: 'Inbound'
    access: 'Allow'
    protocol: 'Tcp'
    sourceAddressPrefix: 'VirtualNetwork'
    destinationPortRange: '443'
    description: 'Allow HTTPS from VNet for Azure Functions / ADF integration.'
  }
  {
    name: 'AllowAmqpFromVNet'
    priority: 110
    direction: 'Inbound'
    access: 'Allow'
    protocol: 'Tcp'
    sourceAddressPrefix: 'VirtualNetwork'
    destinationPortRange: '5671-5672'
    description: 'Allow AMQP for Event Hub integration.'
  }
  {
    name: 'AllowAzureLoadBalancer'
    priority: 120
    direction: 'Inbound'
    access: 'Allow'
    protocol: '*'
    sourceAddressPrefix: 'AzureLoadBalancer'
    destinationAddressPrefix: '*'
    description: 'Required for Azure health probes.'
  }
  {
    name: 'DenyInternetInbound'
    priority: 4000
    direction: 'Inbound'
    access: 'Deny'
    protocol: '*'
    sourceAddressPrefix: 'Internet'
    destinationAddressPrefix: '*'
    description: 'Block all internet inbound.'
  }
  denyAllInbound
  outboundAllowAzureCloud
  outboundAllowAAD
  outboundAllowMonitor
  denyAllOutbound
]

// Select the rule set based on subnet type
output rules array = parSubnetType == 'data' ? dataRules
  : parSubnetType == 'compute' ? computeRules
  : parSubnetType == 'management' ? managementRules
  : integrationRules
