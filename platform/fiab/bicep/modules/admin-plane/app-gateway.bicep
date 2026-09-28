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

// EDGE TIMEOUT (#4431). Until this change `requestTimeout` was the literal 30
// below, with no param, no bounds and no override path — the ONLY occurrence of
// the property in the bicep tree. That is below what 64 of the console's 81
// `maxDuration`-declaring API routes allow themselves to run for, so the edge
// gave up on the origin before the origin was out of budget.
//
// THOSE COUNTS ARE RE-MEASURED AT THIS HEAD, not copied from #4431. The issue
// says "54 of 71", measured 2026-09-09; the population has since grown to 81
// (the 60s bucket went 21 -> 31). Distribution today, from
// `git grep -h "export const maxDuration" -- 'apps/fiab-console/app/api/**/*.ts'`:
//   25s x1  30s x16  45s x2  55s x1  60s x31  90s x11  120s x7  300s x12
// If you cite these numbers again, re-run that grep — they drift with the app.
//
// WHY THIS IS NOT CLOSED BY #4373. That PR pinned `originResponseTimeoutSeconds
// = 120` on front-door.bicep. This module is a DIFFERENT edge and is not
// instantiated by that one; front-door.bicep's "RESIDUAL GAP #2" note recorded
// this exact gap, and is CORRECTED in the same PR as this change so it does not
// keep asserting a hardcode that no longer exists. Four shipped params files
// stand this gateway up (commercial-full, gcc-high, il5, tenant-dmlz), and on
// IL5 it is the ONLY edge — il5.bicepparam sets frontDoorEnabled=false because
// Front Door is not IL5-certified — so on IL5 nothing else was going to raise it.
//
// WHY THE CEILING IS 86400 AND NOT 240. Azure documents TWO ranges for
// backendHttpSettings.requestTimeout: 1–86,400s for a PRIVATE backend and
// 1–240s for an EXTERNAL one
// (learn.microsoft.com/azure/application-gateway/configuration-http-settings,
// "Request timeout"). This gateway's backend pool is `consoleBackendIp`, which
// admin-plane/main.bicep binds to the Container Apps environment's staticIp,
// and that environment is created with `vnetConfiguration.internal: true`
// unconditionally (container-platform.bicep:88) — i.e. a VNet-private address.
// So the private-backend range is the one that applies here. If that CAE is
// ever made external, this ceiling becomes wrong (too permissive) and must drop
// to 240; the `internal: true` literal is the thing to re-read before changing
// it, not this comment.
//
// The default of 120 matches the Front Door pin so the two edges agree rather
// than silently differing by boundary. It covers 69 of the 81 declaring routes;
// the 12 that declare `maxDuration = 300` still exceed BOTH edges and must stay
// async-and-pollable, exactly as front-door.bicep says of its own pin.
//
// ONE DEFAULT, AND IT IS NOT HERE. This param is REQUIRED — like the six above
// it — deliberately. admin-plane/main.bicep always passes a value, so a default
// on this line could never be read: it would be a dead literal that a later
// edit could "change" with no effect on any deployment. The single live default
// lives at the deployment entry point, platform/fiab/bicep/main.bicep, which is
// also where a .bicepparam binds and therefore where an out-of-range value has
// to be caught. The bounds are repeated here because this module can also be
// called directly, and a bound stated in only one of two places is the half-
// enforced shape front-door.bicep was pulled up on in #4373 review §5.
@description('Seconds the Application Gateway waits on the Console origin before giving up. ARM default is 20; this template used to hardcode 30. Supported range for a PRIVATE backend (which this is — the ACA env is internal) is 1-86400; an EXTERNAL backend would cap at 240. The deployment default of 120 matches the Front Door pin in front-door.bicep. On IL5 this is the only edge (frontDoorEnabled=false), see #4431.')
@minValue(1)
@maxValue(86400)
param consoleRequestTimeoutSeconds int

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
          requestTimeout: consoleRequestTimeoutSeconds
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
