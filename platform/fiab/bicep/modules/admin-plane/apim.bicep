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

@description('Loom Console UAMI principal id. When set (and !skipRoleGrants), the UAMI is granted "API Management Service Contributor" at this APIM scope so the Admin → API Management panes can read the service + scale the SKU + manage APIs/products/subscriptions/named-values/backends/policies via ARM. Folds scripts/csa-loom/grant-apim-rbac.sh into the deployment so APIM is configured by default — no manual post-deploy grant.')
param consolePrincipalId string = ''

@description('Skip RBAC role assignments (set in environments where the deployer lacks Owner/User Access Administrator; grant out-of-band via scripts/csa-loom/grant-apim-rbac.sh).')
param skipRoleGrants bool = false

@description('Seed a self-contained sample API (mocked 200) + product + active subscription so the API Marketplace Try console and curl samples work end-to-end out of the box. The mock returns 200 at the gateway with no backend dependency — proving the subscription-key flow. BYO-APIM deployments skip this module entirely, so the sample is only seeded on Loom-provisioned APIM.')
param seedSampleApi bool = true

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
    // Do NOT set publicNetworkAccess:'Disabled' here. With
    // virtualNetworkType:'Internal' the gateway is already private (VNet-only),
    // and Azure REJECTS publicNetworkAccess:'Disabled' DURING service creation
    // (ActivateServiceWithPrivateEndpointAccessNotAllowed). Internal VNet mode
    // makes the data plane private without this property; setting it at create
    // breaks a clean greenfield deploy.
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
    <set-header name="X-Loom-Request-Id" exists-action="override">
      <value>@(context.RequestId.ToString())</value>
    </set-header>
    <set-header name="X-Loom-Tenant" exists-action="override">
      <value>@(context.Request.Headers.GetValueOrDefault("X-Loom-Tenant", "unknown"))</value>
    </set-header>
    <rate-limit-by-key calls="100" renewal-period="60" counter-key="@(context.Subscription?.Id ?? context.Request.IpAddress)" />
    <cors allow-credentials="false">
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
    <forward-request />
  </backend>
  <outbound>
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

// ---- Console UAMI → API Management Service Contributor at the APIM scope ----
// Required for the Admin → API Management surface (apim-client.ts): reading the
// service (GET /api/apim/service), scaling the SKU (PATCH), and managing APIs /
// products / subscriptions / named values / backends / policies — all real ARM
// REST on Microsoft.ApiManagement/service. Without this grant the panes surface
// an honest gate / 403. This replaces the manual scripts/csa-loom/grant-apim-rbac.sh
// step for the provisioned-APIM path so APIM works by default after deploy.
// Role: "API Management Service Contributor" (312a565d-c81f-4fd8-895a-4e21e48d571c).
resource consoleApimContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: apim
  name: guid(apim.id, consolePrincipalId, '312a565d-c81f-4fd8-895a-4e21e48d571c')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '312a565d-c81f-4fd8-895a-4e21e48d571c')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Sample API — self-contained, mocked 200. Lets the API Marketplace prove the
// subscribe → key → Try/curl flow without any backend dependency. The single
// operation is answered by a mock-response policy at the gateway, so it returns
// 200 even though the APIM service is internal-VNet with no public backend.
// ---------------------------------------------------------------------------
resource sampleApi 'Microsoft.ApiManagement/service/apis@2024-06-01-preview' = if (seedSampleApi) {
  parent: apim
  name: 'loom-sample-api'
  properties: {
    displayName: 'Loom Sample API'
    description: 'Self-contained sample API for the API Marketplace. GET /status returns a mocked 200 from the gateway with no backend — use it to validate the subscription-key + Try-console flow end-to-end.'
    path: 'loom-sample'
    protocols: [ 'https' ]
    subscriptionRequired: true
    serviceUrl: 'https://loom-sample.invalid'   // never called — the operation is mocked
  }
}

resource sampleOp 'Microsoft.ApiManagement/service/apis/operations@2024-06-01-preview' = if (seedSampleApi) {
  parent: sampleApi
  name: 'get-status'
  properties: {
    displayName: 'Get status'
    method: 'GET'
    urlTemplate: '/status'
    responses: [
      {
        statusCode: 200
        description: 'OK'
        representations: [
          {
            contentType: 'application/json'
            examples: {
              default: {
                value: '{"status":"ok","service":"loom-sample-api"}'
              }
            }
          }
        ]
      }
    ]
  }
}

resource sampleOpPolicy 'Microsoft.ApiManagement/service/apis/operations/policies@2024-06-01-preview' = if (seedSampleApi) {
  parent: sampleOp
  name: 'policy'
  properties: {
    format: 'xml'
    value: '<policies><inbound><base /><mock-response status-code="200" content-type="application/json" /></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>'
  }
}

resource sampleProduct 'Microsoft.ApiManagement/service/products@2024-06-01-preview' = if (seedSampleApi) {
  parent: apim
  name: 'loom-sample'
  properties: {
    displayName: 'Loom Sample'
    description: 'Sample product for the API Marketplace. Subscriptions are auto-approved and active immediately — use it to try the Loom Sample API.'
    subscriptionRequired: true
    approvalRequired: false
    state: 'published'
  }
}

resource sampleProductApiLink 'Microsoft.ApiManagement/service/products/apis@2024-06-01-preview' = if (seedSampleApi) {
  parent: sampleProduct
  name: 'loom-sample-api'
  dependsOn: [ sampleApi ]
}

// An active subscription scoped to the sample product, so the marketplace shows
// a working key from the first load (key revealed via listSecrets on demand).
resource sampleSubscription 'Microsoft.ApiManagement/service/subscriptions@2024-06-01-preview' = if (seedSampleApi) {
  parent: apim
  name: 'loom-sample-sub'
  properties: {
    displayName: 'Loom Sample subscription'
    scope: '${apim.id}/products/loom-sample'
    state: 'active'
  }
  dependsOn: [ sampleProductApiLink ]
}

output apimId string = apim.id
output apimName string = apim.name
output apimGatewayUrl string = apim.properties.gatewayUrl
output apimManagedIdentityPrincipalId string = apim.identity.principalId
