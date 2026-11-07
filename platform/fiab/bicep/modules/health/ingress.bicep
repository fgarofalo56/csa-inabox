// CSA Loom Health Data Services (LHDS) - stamp ingress: Application Gateway WAF v2.
//
// The only public surface of a stamp (SECURITY-AND-COMPLIANCE.md s5). This is the
// BASE gateway: WAF v2 with the OWASP 3.2 managed rule set, a TLS listener when a
// certificate is supplied, and a backend pool that targets the internal load
// balancer of the in-cluster ingress controller at a fixed address reserved by
// network.bicep. The FHIR/DICOMweb-specific exclusions and per-tenant rate limits
// are W1-6 and live on the WAF policy this module creates (output wafPolicyId):
// FHIR/DICOMweb exclusions, a per-client-address volumetric rate limit, and
// (optionally) the APIM tenant-routing fragment. The PER-TENANT quota cannot be a
// WAF rule (Application Gateway rate-limit rules group by client address, geo or
// nothing, never by a token claim), so it is enforced in the APIM fragment, which
// answers 429 + Retry-After per tenant key. The WAF rate limit is the backstop
// against one address flooding the stamp.
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

@description('Per-client-address requests per minute at the WAF (volumetric backstop; tenant quotas are enforced in APIM). 0 disables the rule. UNVERIFIED in Azure Government: set 0 there if the WAF rate-limit rule type is rejected.')
@minValue(0)
@maxValue(1000000)
param wafClientRateLimitPerMinute int = 6000

@description('Max request body the WAF accepts, in KB (DICOM STOW-RS multipart bodies are large).')
@minValue(8)
@maxValue(4000000)
param wafMaxRequestBodyKb int = 2000000

@description('Max file upload in MB (STOW-RS instances). Application Gateway WAF v2 caps this at 4000.')
@minValue(1)
@maxValue(4000)
param wafFileUploadLimitMb int = 4000

@description('Name of an EXISTING API Management service to publish the lhds-tenant-routing policy fragment to. Empty = no fragment (single-stamp deployments route at the stamp ingress).')
param apimServiceName string = ''

@description('Resource group of the APIM service. Empty = this resource group.')
param apimResourceGroupName string = ''

@description('Subscription of the APIM service. Empty = this subscription.')
param apimSubscriptionId string = ''

@description('OpenID configuration URL of the LHDS authorization server (needs issuer + jwks_uri). Required when apimServiceName is set.')
param authServerOpenIdConfigUrl string = ''

@description('Issuer of LHDS access tokens. Required when apimServiceName is set.')
param authServerIssuer string = ''

@description('Control plane base URL (no trailing slash). Required when apimServiceName is set.')
param controlPlaneBaseUrl string = ''

@description('Entra audience of the control plane. Required when apimServiceName is set.')
param controlPlaneAudience string = ''

@description('Requests per minute for a tenant whose routing entry carries no quota.')
@minValue(1)
param defaultTenantRequestsPerMinute int = 600

@description('Log Analytics workspace id for diagnostics. Empty skips the diagnostic setting.')
param workspaceId string = ''

@description('Tags applied to every resource.')
param tags object = {}

var gwName = 'agw-lhds-${stampName}'
var hasTls = !empty(tlsCertificateSecretUri)
var zones = useAvailabilityZones ? ['1', '2', '3'] : null
var apimFragmentRequested = !empty(apimServiceName)
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

// FHIR / DICOMweb exclusions. CRS 3.2 blocks traffic these APIs legitimately send:
//  - 920420 rejects any Content-Type outside its allow-list; FHIR (application/fhir+json,
//    application/json-patch+json) and DICOMweb (multipart/related; type="application/dicom",
//    application/dicom+json) are not on it. Disabled for that one rule only.
//  - The Prefer (respond-async, return=minimal), Accept and Content-Type header VALUES
//    trip the protocol/SQLi groups; exclusions are by header NAME, limited to these
//    three. Cookies, args and the body stay inspected.
var wafExclusions = [
  { matchVariable: 'RequestHeaderNames', selectorMatchOperator: 'Equals', selector: 'Prefer' }
  { matchVariable: 'RequestHeaderNames', selectorMatchOperator: 'Equals', selector: 'Accept' }
  { matchVariable: 'RequestHeaderNames', selectorMatchOperator: 'Equals', selector: 'Content-Type' }
]

var wafRateLimitRules = wafClientRateLimitPerMinute > 0 ? [
  {
    name: 'RateLimitPerClientAddress'
    priority: 10
    ruleType: 'RateLimitRule'
    action: 'Block'
    rateLimitDuration: 'OneMin'
    rateLimitThreshold: wafClientRateLimitPerMinute
    groupByUserSession: [
      { groupByVariables: [{ variableName: 'ClientAddr' }] }
    ]
    matchConditions: [
      {
        matchVariables: [{ variableName: 'RequestUri' }]
        operator: 'Contains'
        negationConditon: false
        matchValues: ['/']
      }
    ]
  }
] : []

resource wafPolicy 'Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies@2024-05-01' = {
  name: 'wafpol-lhds-${stampName}'
  location: location
  tags: tags
  properties: {
    policySettings: {
      mode: 'Prevention'
      state: 'Enabled'
      requestBodyCheck: true
      maxRequestBodySizeInKb: wafMaxRequestBodyKb
      fileUploadLimitInMb: wafFileUploadLimitMb
    }
    customRules: wafRateLimitRules
    managedRules: {
      exclusions: wafExclusions
      managedRuleSets: [
        {
          ruleSetType: 'OWASP'
          ruleSetVersion: '3.2'
          ruleGroupOverrides: [
            {
              ruleGroupName: 'REQUEST-920-PROTOCOL-ENFORCEMENT'
              rules: [
                { ruleId: '920420', state: 'Disabled' }
              ]
            }
          ]
        }
        {
          ruleSetType: 'Microsoft_BotManagerRuleSet'
          ruleSetVersion: '1.0'
        }
      ]
    }
  }
}

// APIM tenant-routing fragment (own module: the APIM service may live in another
// resource group or subscription).
module apimFragment 'apim-fragment.bicep' = if (apimFragmentRequested) {
  name: 'lhds-${stampName}-apim-fragment'
  scope: resourceGroup(empty(apimSubscriptionId) ? subscription().subscriptionId : apimSubscriptionId, empty(apimResourceGroupName) ? resourceGroup().name : apimResourceGroupName)
  params: {
    apimServiceName: apimServiceName
    authServerOpenIdConfigUrl: authServerOpenIdConfigUrl
    authServerIssuer: authServerIssuer
    controlPlaneBaseUrl: controlPlaneBaseUrl
    controlPlaneAudience: controlPlaneAudience
    defaultRequestsPerMinute: defaultTenantRequestsPerMinute
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
output apimFragmentName string = apimFragmentRequested ? apimFragment!.outputs.fragmentName : ''
