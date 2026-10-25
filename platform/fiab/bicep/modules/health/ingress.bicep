// CSA Loom Health Data Services (LHDS) - stamp ingress: Application Gateway WAF v2.
//
// The only public surface of a stamp (SECURITY-AND-COMPLIANCE.md s5). This is the
// BASE gateway: WAF v2 with the OWASP 3.2 managed rule set, a TLS listener when a
// certificate is supplied, and a backend pool that targets the internal load
// balancer of the in-cluster ingress controller at a fixed address reserved by
// network.bicep. The FHIR/DICOMweb-specific exclusions and per-tenant rate limits
// are W1-6 and attach to the WAF policy this module creates (output wafPolicyId);
// nothing here has to change for them.
//
// TLS: the certificate is referenced by a version-less Key Vault secret URI, so
// renewals roll without a redeploy. Until one is supplied the gateway has no TLS
// listener at all and port 80 only issues a permanent redirect to https; it never
// forwards clear-text traffic to a backend. The gateway identity holds Key Vault
// Secrets User on the stamp vault and reaches it over the vault private endpoint.

targetScope = 'resourceGroup'

@description('Region of the gateway.')
param location string

@description('Stamp short name; folded into resource names.')
param stampName string

@description('Gateway subnet id (snet-agw).')
param agwSubnetId string

@description('Fixed private address of the in-cluster ingress controller internal load balancer (network.bicep output ingressIlbIp). The ingress controller Service must request this address.')
param backendIp string

@description('Host name the in-cluster ingress routes on and the gateway sends as Host to the backend.')
param backendHostName string = 'lhds.internal'

@description('Version-less Key Vault secret URI of the TLS certificate (https://<vault>/secrets/<name>). Empty = no TLS listener yet; port 80 only redirects.')
param tlsCertificateSecretUri string = ''

@description('Resource id of the stamp Key Vault; the gateway identity is granted Key Vault Secrets User on it.')
param keyVaultId string

@description('Autoscale minimum capacity units.')
@minValue(0)
@maxValue(125)
param minCapacity int = 1

@description('Autoscale maximum capacity units.')
@minValue(2)
@maxValue(125)
param maxCapacity int = 4

@description('Spread the gateway across availability zones. Set false for a region without zones.')
param useAvailabilityZones bool = true

@description('Backend request timeout in seconds. Large DICOM STOW uploads and bulk reads need a long timeout; W1-6 tunes it per route.')
@minValue(1)
@maxValue(86400)
param requestTimeoutSeconds int = 300

@description('Log Analytics workspace id for diagnostics. Empty skips the diagnostic setting.')
param workspaceId string = ''

@description('Tags applied to every resource.')
param tags object = {}

var gwName = 'agw-lhds-${stampName}'
var hasTls = !empty(tlsCertificateSecretUri)
var zones = useAvailabilityZones ? ['1', '2', '3'] : null
var secretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource kv 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: last(split(keyVaultId, '/'))
}

resource gwIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-lhds-${stampName}-agw'
  location: location
  tags: tags
}

resource gwSecretsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, gwIdentity.id, secretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUserRoleId)
    principalId: gwIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'LHDS ingress gateway: read the TLS certificate secret.'
  }
}

resource wafPolicy 'Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies@2024-05-01' = {
  name: 'wafpol-lhds-${stampName}'
  location: location
  tags: tags
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

resource pip 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: 'pip-${gwName}'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  zones: zones
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    dnsSettings: {
      domainNameLabel: take('lhds-${stampName}-${uniqueString(resourceGroup().id)}', 63)
    }
  }
}

var feName = 'fe-public'
var gwId = resourceId('Microsoft.Network/applicationGateways', gwName)

var sslCertificates = hasTls ? [
  {
    name: 'stamp-tls'
    properties: { keyVaultSecretId: tlsCertificateSecretUri }
  }
] : []

var frontendPorts = concat([
  { name: 'port80', properties: { port: 80 } }
], hasTls ? [
  { name: 'port443', properties: { port: 443 } }
] : [])

var httpListeners = concat([
  {
    name: 'listener-http'
    properties: {
      frontendIPConfiguration: { id: '${gwId}/frontendIPConfigurations/${feName}' }
      frontendPort: { id: '${gwId}/frontendPorts/port80' }
      protocol: 'Http'
    }
  }
], hasTls ? [
  {
    name: 'listener-https'
    properties: {
      frontendIPConfiguration: { id: '${gwId}/frontendIPConfigurations/${feName}' }
      frontendPort: { id: '${gwId}/frontendPorts/port443' }
      protocol: 'Https'
      sslCertificate: { id: '${gwId}/sslCertificates/stamp-tls' }
      firewallPolicy: { id: wafPolicy.id }
    }
  }
] : [])

// Port 80 never reaches a backend: it redirects to https on the public FQDN
// (or, with TLS, to the https listener).
var redirectConfigurations = [
  hasTls ? {
    name: 'http-to-https'
    properties: {
      redirectType: 'Permanent'
      targetListener: { id: '${gwId}/httpListeners/listener-https' }
      includePath: true
      includeQueryString: true
    }
  } : {
    name: 'http-to-https'
    properties: {
      redirectType: 'Permanent'
      targetUrl: 'https://${pip.properties.dnsSettings.fqdn}'
      includePath: true
      includeQueryString: true
    }
  }
]

var routingRules = concat([
  {
    name: 'rule-http-redirect'
    properties: {
      priority: 100
      ruleType: 'Basic'
      httpListener: { id: '${gwId}/httpListeners/listener-http' }
      redirectConfiguration: { id: '${gwId}/redirectConfigurations/http-to-https' }
    }
  }
], hasTls ? [
  {
    name: 'rule-https-backend'
    properties: {
      priority: 110
      ruleType: 'Basic'
      httpListener: { id: '${gwId}/httpListeners/listener-https' }
      backendAddressPool: { id: '${gwId}/backendAddressPools/ingress-ilb' }
      backendHttpSettings: { id: '${gwId}/backendHttpSettingsCollection/ingress-http' }
    }
  }
] : [])

resource gateway 'Microsoft.Network/applicationGateways@2024-05-01' = {
  name: gwName
  location: location
  tags: tags
  zones: zones
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${gwIdentity.id}': {}
    }
  }
  properties: {
    sku: {
      name: 'WAF_v2'
      tier: 'WAF_v2'
    }
    autoscaleConfiguration: {
      minCapacity: minCapacity
      maxCapacity: maxCapacity
    }
    firewallPolicy: { id: wafPolicy.id }
    gatewayIPConfigurations: [
      {
        name: 'gw-ipconfig'
        properties: { subnet: { id: agwSubnetId } }
      }
    ]
    frontendIPConfigurations: [
      {
        name: feName
        properties: { publicIPAddress: { id: pip.id } }
      }
    ]
    frontendPorts: frontendPorts
    sslCertificates: sslCertificates
    sslPolicy: {
      policyType: 'Predefined'
      policyName: 'AppGwSslPolicy20220101S'
    }
    backendAddressPools: [
      {
        name: 'ingress-ilb'
        properties: { backendAddresses: [{ ipAddress: backendIp }] }
      }
    ]
    backendHttpSettingsCollection: [
      {
        name: 'ingress-http'
        properties: {
          port: 80
          protocol: 'Http'
          cookieBasedAffinity: 'Disabled'
          pickHostNameFromBackendAddress: false
          hostName: backendHostName
          requestTimeout: requestTimeoutSeconds
          probe: { id: '${gwId}/probes/ingress-probe' }
        }
      }
    ]
    probes: [
      {
        name: 'ingress-probe'
        properties: {
          protocol: 'Http'
          host: backendHostName
          path: '/'
          interval: 30
          timeout: 30
          unhealthyThreshold: 3
          // Any HTTP answer from the ingress controller proves it is up; the
          // default backend answers 404 until a route exists.
          match: { statusCodes: ['200-499'] }
        }
      }
    ]
    httpListeners: httpListeners
    redirectConfigurations: redirectConfigurations
    requestRoutingRules: routingRules
  }
  dependsOn: [
    gwSecretsRole
  ]
}

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: gateway
  name: 'diag-lhds-agw'
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

output gatewayId string = gateway.id
output gatewayName string = gateway.name
output wafPolicyId string = wafPolicy.id
output publicIp string = pip.properties.ipAddress
output publicFqdn string = pip.properties.dnsSettings.fqdn
output gatewayIdentityPrincipalId string = gwIdentity.properties.principalId
output tlsConfigured bool = hasTls
