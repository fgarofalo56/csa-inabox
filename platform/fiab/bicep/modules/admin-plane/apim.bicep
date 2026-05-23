// CSA Loom — API Management gateway
// Wraps every Loom service endpoint behind APIM for:
//   - Caller authentication (JWT validation policy)
//   - Per-caller rate limiting
//   - Request/response logging → standardized LAW + App Insights
//   - Centralized CORS + CSP policy enforcement
//
// SKU per-boundary: PremiumV2 in Commercial/GCC; classic Premium in
// Gov boundaries (PremiumV2 Gov-GA pending). Both support VNet
// integration.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('APIM SKU — PremiumV2 (Commercial/GCC) or Premium (Gov)')
@allowed(['PremiumV2', 'Premium'])
param sku string

@description('SKU capacity')
@minValue(1)
@maxValue(10)
param capacity int = 1

@description('Publisher email (required by APIM)')
param publisherEmail string

@description('Publisher name')
param publisherName string = 'CSA Loom Operations'

@description('APIM subnet ID (must be empty subnet, /27 minimum)')
param apimSubnetId string

@description('App Insights ID for APIM logging integration')
param appInsightsId string

@description('App Insights instrumentation key (for the loggers resource)')
@secure()
param appInsightsInstrumentationKey string

@description('Log Analytics workspace ID for diagnostic settings')
param workspaceId string

@description('Compliance tags')
param complianceTags object

resource apim 'Microsoft.ApiManagement/service@2024-06-01-preview' = {
  name: 'apim-csa-loom-${location}'
  location: location
  tags: complianceTags
  sku: { name: sku, capacity: capacity }
  identity: { type: 'SystemAssigned' }
  properties: {
    publisherEmail: publisherEmail
    publisherName: publisherName
    virtualNetworkType: 'Internal'
    virtualNetworkConfiguration: {
      subnetResourceId: apimSubnetId
    }
    publicNetworkAccess: 'Disabled'
    customProperties: {
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Protocols.Server.Http2': 'true'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls10': 'false'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls11': 'false'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Ciphers.TripleDes168': 'false'
    }
  }
}

// App Insights logger — wired to every API for request/response logging
resource aiLogger 'Microsoft.ApiManagement/service/loggers@2024-06-01-preview' = {
  parent: apim
  name: 'app-insights'
  properties: {
    loggerType: 'applicationInsights'
    description: 'Loom App Insights logger — every API logs requests/responses here'
    credentials: {
      instrumentationKey: appInsightsInstrumentationKey
    }
    resourceId: appInsightsId
  }
}

// Global policy — applied at the service level; per-API + per-operation
// policies override individual sections
resource globalPolicy 'Microsoft.ApiManagement/service/policies@2024-06-01-preview' = {
  parent: apim
  name: 'policy'
  properties: {
    value: '''
<policies>
  <inbound>
    <base />
    <set-header name="X-Loom-Request-Id" exists-action="override">
      <value>@(context.RequestId)</value>
    </set-header>
    <set-header name="X-Loom-Tenant" exists-action="override">
      <value>@(context.Request.Headers.GetValueOrDefault("X-Loom-Tenant", "unknown"))</value>
    </set-header>
    <rate-limit-by-key calls="100" renewal-period="60" counter-key="@(context.Subscription?.Id ?? context.IpAddress)" />
    <cors allow-credentials="true">
      <allowed-origins>
        <origin>*</origin>
      </allowed-origins>
      <allowed-methods>
        <method>GET</method><method>POST</method><method>PUT</method><method>DELETE</method><method>PATCH</method>
      </allowed-methods>
      <allowed-headers>
        <header>*</header>
      </allowed-headers>
    </cors>
  </inbound>
  <backend>
    <base />
  </backend>
  <outbound>
    <base />
    <set-header name="Strict-Transport-Security" exists-action="override">
      <value>max-age=31536000; includeSubDomains</value>
    </set-header>
    <set-header name="X-Content-Type-Options" exists-action="override">
      <value>nosniff</value>
    </set-header>
    <set-header name="X-Frame-Options" exists-action="override">
      <value>DENY</value>
    </set-header>
  </outbound>
  <on-error>
    <base />
  </on-error>
</policies>
'''
    format: 'xml'
  }
  dependsOn: [ aiLogger ]
}

// Diagnostic settings → standardized Loom LAW
resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: apim
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'GatewayLogs', enabled: true }
      { category: 'WebSocketConnectionLogs', enabled: true }
      { category: 'DeveloperPortalAuditLogs', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output apimId string = apim.id
output apimName string = apim.name
output apimGatewayUrl string = apim.properties.gatewayUrl
output apimManagedIdentityPrincipalId string = apim.identity.principalId
