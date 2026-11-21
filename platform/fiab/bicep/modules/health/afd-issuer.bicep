// LHDS authorization-server issuer through the EXISTING Azure Front Door Premium profile (#5410, W1b-2 L1).
//
// WHY. The SMART authorization server runs in the control plane Container App loom-health-cp, in the
// INTERNAL hub Container Apps environment (public network access Disabled). The stamp Application
// Gateway sits in the stamp VNet, which has no peering to the hub, so https://<stamp ingress>/auth
// answered 502 on every path (measured 2026-11-21, Commercial dev01). Operator decision 2026-11-21:
// serve the issuer through the Front Door profile that is already private-linked to the hub
// environment for the console, on a route that matches ONLY /auth/*.
//
// WHAT. A DEDICATED endpoint (the console endpoint and its route are untouched), an origin group that
// probes the issuer metadata document, one origin = the control plane FQDN with a Private Link
// connection to the environment, a route whose patternsToMatch is exactly ['/auth/*'], and, when the
// caller supplies the console WAF policy id, a NEW security policy attaching that WAF to the new
// endpoint only (the console's securityPolicy and its domain list are not rewritten).
//
// TWO INVOCATIONS, ONE FILE. The control plane needs the issuer URL as an environment variable at
// creation, and the origin needs the control plane FQDN, so one deployment would be a cycle. health.bicep
// invokes this module twice: first with cpFqdn empty (endpoint only, so its host name exists), then
// after the control plane with cpFqdn set (origin group, origin, route, WAF). Both declare the same
// endpoint with the same properties, which ARM treats as idempotent.
//
// Private Link approval is NOT done here: Front Door raises a connection on the environment that is
// Pending until approved. deploy-health.yml runs scripts/csa-loom/approve-cae-private-endpoints.sh
// after the deploy (a deploymentScript cannot run where policy forces shared-key storage off, #3203).
//
// Scope: deployed at resourceGroup scope = the resource group of the existing profile.

targetScope = 'resourceGroup'

@description('Name of the EXISTING Front Door Premium profile (fd-loom-<suffix>) in this resource group.')
param profileName string

@description('Stamp name, used in the dedicated endpoint name.')
param stampName string

@description('Control plane FQDN (the Container App ingress FQDN). Empty = create only the endpoint (first invocation).')
param cpFqdn string = ''

@description('Resource id of the hub Container Apps managed environment the control plane runs in (the Private Link target).')
param caeId string

@description('Region of the Container Apps environment (Private Link location).')
param caeLocation string

@description('OPTIONAL. Resource id of the WAF policy the console security policy uses. Empty = no WAF attached to the issuer endpoint.')
param wafPolicyId string = ''

@description('Tags.')
param tags object = {}

resource profile 'Microsoft.Cdn/profiles@2024-02-01' existing = {
  name: profileName
}

// AFD derives the public host from the endpoint name plus a hash, so the name only has to be unique
// per profile + stamp. Capped at the 46-character endpoint name limit.
var endpointName = take('lhds-auth-${stampName}', 46)

resource endpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' = {
  parent: profile
  name: endpointName
  location: 'global'
  tags: tags
  properties: {
    enabledState: 'Enabled'
  }
}

var routeDeploy = !empty(cpFqdn)

resource originGroup 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = if (routeDeploy) {
  parent: profile
  name: 'lhds-auth-cp'
  properties: {
    loadBalancingSettings: {
      sampleSize: 4
      successfulSamplesRequired: 3
      additionalLatencyInMilliseconds: 50
    }
    healthProbeSettings: {
      // The issuer metadata document: served by the authorization server without a token.
      probePath: '/auth/.well-known/openid-configuration'
      probeRequestType: 'GET'
      probeProtocol: 'Https'
      probeIntervalInSeconds: 30
    }
    sessionAffinityState: 'Disabled'
  }
}

resource origin 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = if (routeDeploy) {
  parent: originGroup
  name: 'lhds-cp-origin'
  properties: {
    hostName: cpFqdn
    httpPort: 80
    httpsPort: 443
    originHostHeader: cpFqdn
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
    enforceCertificateNameCheck: true
    sharedPrivateLinkResource: {
      privateLink: { id: caeId }
      privateLinkLocation: caeLocation
      groupId: 'managedEnvironments'
      requestMessage: 'Front Door Premium -> ACA env (LHDS authorization server issuer)'
    }
  }
}

resource route 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = if (routeDeploy) {
  parent: endpoint
  name: 'lhds-auth-route'
  properties: {
    originGroup: { id: originGroup.id }
    supportedProtocols: ['Https']
    // ONLY the authorization server. Every other path on this endpoint (including /api/health/*)
    // gets Front Door's own 404, so the control plane API is never published here.
    patternsToMatch: ['/auth/*']
    forwardingProtocol: 'HttpsOnly'
    linkToDefaultDomain: 'Enabled'
    httpsRedirect: 'Enabled'
  }
  dependsOn: [origin]
}

resource securityPolicy 'Microsoft.Cdn/profiles/securityPolicies@2024-02-01' = if (routeDeploy && !empty(wafPolicyId)) {
  parent: profile
  name: 'lhds-auth-waf-policy'
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: { id: wafPolicyId }
      associations: [
        {
          domains: [ { id: endpoint.id } ]
          patternsToMatch: ['/*']
        }
      ]
    }
  }
  dependsOn: [route]
}

@description('Public host name of the dedicated issuer endpoint (<name>-<hash>.z01.azurefd.net).')
output endpointHostName string = endpoint.properties.hostName

@description('Issuer URL served by this endpoint.')
output issuerUrl string = 'https://${endpoint.properties.hostName}/auth'

@description('Whether the origin group, origin and route were declared by this invocation.')
output routeDeployed bool = routeDeploy

@description('Whether a WAF security policy was attached to the issuer endpoint.')
output wafAttached bool = routeDeploy && !empty(wafPolicyId)
