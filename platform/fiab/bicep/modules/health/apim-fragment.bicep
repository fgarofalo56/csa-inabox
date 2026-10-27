// CSA Loom Health Data Services (LHDS) - APIM policy fragment for tenant routing.
//
// Publishes policies/lhds-tenant-routing.fragment.xml into an EXISTING API
// Management service (the Loom admin-plane APIM or a customer one) as the policy
// fragment `lhds-tenant-routing`. It is its own module only because the APIM
// service can sit in a different resource group than the stamp; ingress.bicep
// invokes it with that group as the module scope. Policy fragments are available
// on every classic tier (Developer, Basic, Standard, Premium), so nothing here
// assumes Premium, v2 or a Commercial-only feature.

targetScope = 'resourceGroup'

@description('Name of the existing API Management service.')
param apimServiceName string

@description('OpenID configuration document the gateway validates LHDS tokens against (must expose issuer and jwks_uri; tenant-independent, health.bicep derives {issuer}/.well-known/openid-configuration, which the authorization server must serve at its root; the per-tenant {issuer}/{tenant}/.well-known/smart-configuration is not usable here).')
param authServerOpenIdConfigUrl string

@description('Issuer claim of LHDS access tokens (the authorization server issuer URL).')
param authServerIssuer string

@description('Control plane base URL, no trailing slash. The fragment reads GET /api/health/routing-map from it.')
param controlPlaneBaseUrl string

@description('Entra audience (Application ID URI) of the control plane, requested with the APIM managed identity.')
param controlPlaneAudience string

@description('Requests per minute applied to a tenant whose routing entry carries no quota.')
@minValue(1)
param defaultRequestsPerMinute int = 600

var fragmentXml = replace(replace(replace(replace(replace(
  loadTextContent('policies/lhds-tenant-routing.fragment.xml'),
  '__AS_OPENID_CONFIG_URL__', authServerOpenIdConfigUrl),
  '__AS_ISSUER__', authServerIssuer),
  '__CP_BASE_URL__', controlPlaneBaseUrl),
  '__CP_AUDIENCE__', controlPlaneAudience),
  '__DEFAULT_RPM__', string(defaultRequestsPerMinute))

resource apim 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimServiceName
}

resource fragment 'Microsoft.ApiManagement/service/policyFragments@2024-05-01' = {
  parent: apim
  name: 'lhds-tenant-routing'
  properties: {
    description: 'LHDS: tenant from path, token tenant claim must match (403), routing-map lookup with last-known-good, per-tenant rate limit (429 + Retry-After), route to the tenant stamp.'
    format: 'xml'
    value: fragmentXml
  }
}

output fragmentId string = fragment.id
output fragmentName string = fragment.name
