// CSA Loom — Application Gateway v2 + WAF v2
//
// Public-IP path to the Console for users who don't have VPN. Sits in
// the hub VNet, terminates TLS on the public IP, applies WAF rules,
// then forwards to the Console's private IP (the ACA env LB at
// staticIp). Cheaper than Front Door Premium for single-region.
//
// Cost: ~$250/mo for WAF_v2 small + traffic.
// Provisioning time: ~15-20 min.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('App Gateway subnet ID (snet-appgw, /24 recommended)')
param appGatewaySubnetId string

@description('Backend FQDN — the Console internal-ingress FQDN (or external; AGW resolves either)')
param consoleFqdn string

@description('ACA env static IP — used as the backend pool address')
param consoleBackendIp string

@description('Log Analytics workspace ID for diagnostic settings')
param workspaceId string

@description('Compliance tags')
param complianceTags object

resource wafPolicy 'Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies@2024-05-01' = {
  name: 'wafpol-loom-${location}'
  location: location
  tags: complianceTags
  properties: {
    policySettings: {
      mode: 'Prevention'
      state: 'Enabled'
      requestBodyCheck: true
      maxRequestBodySizeInKb: 128
      fileUploadLimitInMb: 100
    }
    managedRules: {
      managedRuleSets: [
        {
          ruleSetType: 'OWASP'
          ruleSetVersion: '3.2'
        }
        {
          ruleSetType: 'Microsoft_BotManagerRuleSet'
          ruleSetVersion: '1.0'
        }
      ]
    }
  }
}

resource agwPip 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: 'pip-agw-loom-${location}'
  location: location
  tags: complianceTags
  sku: { name: 'Standard' }
  zones: ['1', '2', '3']
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    dnsSettings: {
      domainNameLabel: 'loom-${uniqueString(resourceGroup().id)}'
    }
  }
}

resource appGateway 'Microsoft.Network/applicationGateways@2024-05-01' = {
  name: 'agw-loom-${location}'
  location: location
  tags: complianceTags
  zones: ['1', '2', '3']
  properties: {
    sku: {
      name: 'WAF_v2'
      tier: 'WAF_v2'
    }
    autoscaleConfiguration: {
      minCapacity: 1
      maxCapacity: 3
    }
    firewallPolicy: { id: wafPolicy.id }
    gatewayIPConfigurations: [
      {
        name: 'agw-ipconfig'
        properties: { subnet: { id: appGatewaySubnetId } }
      }
    ]
    frontendIPConfigurations: [
      {
        name: 'agw-frontend-pub'
        properties: { publicIPAddress: { id: agwPip.id } }
      }
    ]
    frontendPorts: [
      { name: 'port80', properties: { port: 80 } }
      { name: 'port443', properties: { port: 443 } }
    ]
    backendAddressPools: [
      {
        name: 'console-backend'
        // IP is the ACA env LB private IP. AGW will set the Host
        // header from the listener override below so ACA routes to
        // the Console app.
        properties: { backendAddresses: [{ ipAddress: consoleBackendIp }] }
      }
    ]
    backendHttpSettingsCollection: [
      {
        name: 'console-https-settings'
        properties: {
          port: 443
          protocol: 'Https'
          cookieBasedAffinity: 'Disabled'
          pickHostNameFromBackendAddress: false
          hostName: consoleFqdn
          requestTimeout: 30
          probe: { id: resourceId('Microsoft.Network/applicationGateways/probes', 'agw-loom-${location}', 'console-probe') }
        }
      }
    ]
    probes: [
      {
        name: 'console-probe'
        properties: {
          protocol: 'Https'
          host: consoleFqdn
          path: '/'
          interval: 30
          timeout: 30
          unhealthyThreshold: 3
          pickHostNameFromBackendHttpSettings: false
          match: { statusCodes: ['200-399'] }
        }
      }
    ]
    httpListeners: [
      {
        name: 'console-listener-http'
        properties: {
          frontendIPConfiguration: { id: resourceId('Microsoft.Network/applicationGateways/frontendIPConfigurations', 'agw-loom-${location}', 'agw-frontend-pub') }
          frontendPort: { id: resourceId('Microsoft.Network/applicationGateways/frontendPorts', 'agw-loom-${location}', 'port80') }
          protocol: 'Http'
        }
      }
    ]
    requestRoutingRules: [
      {
        name: 'console-route-http'
        properties: {
          priority: 100
          ruleType: 'Basic'
          httpListener: { id: resourceId('Microsoft.Network/applicationGateways/httpListeners', 'agw-loom-${location}', 'console-listener-http') }
          backendAddressPool: { id: resourceId('Microsoft.Network/applicationGateways/backendAddressPools', 'agw-loom-${location}', 'console-backend') }
          backendHttpSettings: { id: resourceId('Microsoft.Network/applicationGateways/backendHttpSettingsCollection', 'agw-loom-${location}', 'console-https-settings') }
        }
      }
    ]
  }
}

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: appGateway
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output appGatewayId string = appGateway.id
output appGatewayName string = appGateway.name
output publicIp string = agwPip.properties.ipAddress
output publicFqdn string = agwPip.properties.dnsSettings.fqdn
