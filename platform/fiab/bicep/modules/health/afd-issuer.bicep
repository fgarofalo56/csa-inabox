// LHDS authorization-server issuer through the EXISTING Azure Front Door Premium profile (#5410, W1b-2 L1).
//
// WHY. The SMART authorization server runs in the control plane Container App loom-health-cp, in the
// INTERNAL hub Container Apps environment (public network access Disabled). The stamp Application
// Gateway sits in the stamp VNet, which has no peering to the hub, so https://<stamp ingress>/auth
// answered 502 on every path (measured 2026-11-21, Commercial dev01). Operator decision 2026-11-21:
// serve the issuer through the Front Door profile that is already private-linked to the hub
// environment for the console, on a route that matches ONLY /auth/*. #5422 adds one more path to the
// same route: /api/health/pdp/*, the bundle the stamp PDP pulls (the stamp has no network path to the
// internal control plane, and its dev profile egresses through a load balancer with 0 peerings).
//
// WHAT. A DEDICATED endpoint (the console endpoint and its route are untouched), an origin group that
// probes the issuer metadata document, one origin = the control plane FQDN with a Private Link
// connection to the environment, a route whose patternsToMatch is exactly ['/auth/*', '/api/health/pdp/*'], a DEDICATED WAF
// policy, and a NEW security policy attaching that WAF to the new endpoint only (the console's
// securityPolicy, its WAF policy and its domain list are not touched).
//
// OWN WAF POLICY. Front Door allows a WAF policy in ONE security policy per profile. The first cut
// referenced the console's policy and failed live: "BadRequest: Web Application Firewall Policy is
// already attached to AFDX profile." (deploy-health run 44937726049, 2026-11-21).
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
    // ONLY the authorization server and the PDP bundle path. Every other path on this endpoint (including
    // /api/health/tenants and the rest of /api/health/*) gets Front Door's own 404, so the rest of the control
    // plane API is never published here. /api/health/pdp/* (#5422) is how the stamp PDP, which cannot resolve or
    // reach the internal control plane FQDN, pulls its signed bundle; the control plane still enforces the Entra
    // token, the HealthCP role and the caller allowlist on it (src/middleware/auth.ts).
    patternsToMatch: ['/auth/*', '/api/health/pdp/*']
    forwardingProtocol: 'HttpsOnly'
    linkToDefaultDomain: 'Enabled'
    httpsRedirect: 'Enabled'
  }
  dependsOn: [origin]
}

// Dedicated WAF policy for the issuer (alphanumeric name, deterministic per resource group + stamp).
// Mirrors the console policy in admin-plane/front-door.bicep (Premium_AzureFrontDoor, Prevention,
// Microsoft_DefaultRuleSet 2.1; that module already deploys in Commercial and GCC-High) with two
// deliberate differences: NO Bot Manager rule set, because the issuer's clients are machines (SMART
// backend services, APIM validate-jwt fetching openid-configuration) that Bot Manager would classify
// as bots; and no console-specific custom rules or cookie exclusions. Request-body inspection is off
// as on the console: the token endpoint receives form-encoded JWT client assertions, which DRS 2.1
// body rules are prone to block; URL, header and cookie inspection stay active.
//
// SMART / OAuth argument exclusions. Measured 2026-11-26 (Front Door WAF log, law-csa-loom-centralus,
// tracking ref 20261126T224811Z-165649489d9qllrghC1BL1xk1s00000017tg0000000041h0): the operator's first
// headed SMART authorize GET /auth/{tenant}/authorize reached anomaly score 15 (DRS 2.1 blocks at 5) and
// was refused by BLOCKING-EVALUATION-949110. Three rules contributed:
//  - RFI-931130 "Off-Domain Reference/Link" on QueryParamValue:redirect_uri
//    (https://192.168.2.252/custom/smart_stu2_2/redirect). Every SMART client's redirect_uri is
//    off-domain by design: it is the CLIENT's URL, never this issuer host.
//  - RFI-931100 "URL Parameter using IP Address" on QueryParamValue:redirect_uri (same value).
//  - MS-ThreatIntel-SQLI-99031002 "SQL Comment Sequence Detected" on QueryParamValue:scope
//    (launch/patient openid fhirUser offline_access patient/*.rs). The '/*' in every SMART wildcard
//    scope reads as a SQL comment opener.
// The fix is PER RULE and BY ARGUMENT NAME: each exclusion names one rule and only the OAuth arguments
// that rule is measured (or, where stated, predicted) to hit. Every other rule still inspects these
// arguments, and these rules still inspect every other argument, header and cookie. No rule set or
// rule group exclusion, no disabled rule, Prevention mode unchanged. Group names are the DRS 2.1
// ruleGroupName values from https://learn.microsoft.com/azure/web-application-firewall/afds/waf-front-door-drs
// ('RFI', 'SQLI', 'MS-ThreatIntel-SQLI'). A rule override defaults enabledState to Disabled when it is omitted,
// so each override restates Enabled + AnomalyScoring: the override must add exclusions, not switch the
// rule off.
//
// The policy covers the whole endpoint, so these exclusions also apply on /api/health/pdp/*; those
// routes (apps/loom-health-cp/src/http/app.ts, the /api/health/pdp/stamps/... handlers) read none of
// these argument names.
//
// Token endpoint (POST /auth/{tenant}/token: client_assertion, code, code_verifier, refresh_token,
// redirect_uri, scope): NO RequestBodyPostArgNames exclusions, because requestBodyCheck is Disabled and
// the body is not inspected at all. If body inspection is ever turned on, those six names need the same
// treatment first (a client_assertion JWT and a refresh token are long base64url strings).
var issuerRuleGroupOverrides = [
  {
    ruleGroupName: 'RFI'
    rules: [
      {
        // Measured: redirect_uri. Not aud: the FHIR base is a host name, never an IP literal.
        ruleId: '931100'
        enabledState: 'Enabled'
        action: 'AnomalyScoring'
        exclusions: [
          { matchVariable: 'QueryStringArgNames', selectorMatchOperator: 'Equals', selector: 'redirect_uri' }
        ]
      }
      {
        // Measured: redirect_uri. Predicted: aud, which SMART requires to be the tenant FHIR base URL
        // (https://<stamp ingress>/...), a different host from this issuer endpoint, so off-domain on
        // every authorize (server.ts rejects any other aud value).
        ruleId: '931130'
        enabledState: 'Enabled'
        action: 'AnomalyScoring'
        exclusions: [
          { matchVariable: 'QueryStringArgNames', selectorMatchOperator: 'Equals', selector: 'redirect_uri' }
          { matchVariable: 'QueryStringArgNames', selectorMatchOperator: 'Equals', selector: 'aud' }
        ]
      }
    ]
  }
  {
    ruleGroupName: 'MS-ThreatIntel-SQLI'
    rules: [
      {
        // Measured: scope. Predicted (not measured): the opaque base64url values a SMART flow carries in
        // the query string. 99031002 replaced CRS 942440, whose pattern includes '--[^-]*?-'; a random
        // base64url string contains '--' followed later by '-' often enough to refuse real sign-ins
        // at random. state and code_challenge (client-generated, authorize GET), launch (EHR launch
        // handle, authorize GET), code (Entra's authorization code on the GET /auth/.../callback
        // redirect, the longest of them), req (rand(24) base64url pick id on the standalone picker
        // redirect GET /auth/{tenant}/pick?req=..., server.ts). The MSTIC pattern is not published, so
        // this is reasoned from the rule it replaced.
        ruleId: '99031002'
        enabledState: 'Enabled'
        action: 'AnomalyScoring'
        exclusions: [
          { matchVariable: 'QueryStringArgNames', selectorMatchOperator: 'Equals', selector: 'scope' }
          { matchVariable: 'QueryStringArgNames', selectorMatchOperator: 'Equals', selector: 'state' }
          { matchVariable: 'QueryStringArgNames', selectorMatchOperator: 'Equals', selector: 'code_challenge' }
          { matchVariable: 'QueryStringArgNames', selectorMatchOperator: 'Equals', selector: 'launch' }
          { matchVariable: 'QueryStringArgNames', selectorMatchOperator: 'Equals', selector: 'code' }
          { matchVariable: 'QueryStringArgNames', selectorMatchOperator: 'Equals', selector: 'req' }
        ]
      }
    ]
  }
  {
    ruleGroupName: 'SQLI'
    rules: [
      {
        // Measured: clientdata. Entra appends &clientdata=e|||microsoftonline.com|none to the redirect
        // back to GET /auth/{tenant}/callback (#5279; the console excludes the same name in
        // admin-plane/front-door.bicep). WAF log, law-csa-loom-centralus, last 30 days as of 2026-11-26:
        // every hit whose matches include clientdata is Microsoft_DefaultRuleSet-2.1-SQLI-942120,
        // AnomalyScoring, 29 hits 2026-11-09..11, QueryParamValue:clientdata = e|||microsoftonline.com|none.
        // The callback never reads clientdata (server.ts reads only state, code and error there).
        ruleId: '942120'
        enabledState: 'Enabled'
        action: 'AnomalyScoring'
        exclusions: [
          { matchVariable: 'QueryStringArgNames', selectorMatchOperator: 'Equals', selector: 'clientdata' }
        ]
      }
    ]
  }
]

resource wafPolicy 'Microsoft.Network/FrontDoorWebApplicationFirewallPolicies@2024-02-01' = if (routeDeploy) {
  name: 'waflhdsauth${uniqueString(resourceGroup().id, stampName)}'
  location: 'global'
  tags: tags
  sku: { name: 'Premium_AzureFrontDoor' }
  properties: {
    policySettings: {
      enabledState: 'Enabled'
      mode: 'Prevention'
      requestBodyCheck: 'Disabled'
    }
    managedRules: {
      managedRuleSets: [
        {
          ruleSetType: 'Microsoft_DefaultRuleSet'
          ruleSetVersion: '2.1'
          ruleSetAction: 'Block'
          ruleGroupOverrides: issuerRuleGroupOverrides
        }
      ]
    }
  }
}

resource securityPolicy 'Microsoft.Cdn/profiles/securityPolicies@2024-02-01' = if (routeDeploy) {
  parent: profile
  name: 'lhds-auth-waf-policy'
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: { id: wafPolicy.id }
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

@description('Base URL the stamp PDP pulls its bundle from (https://<host>); OPA appends /api/health/pdp/stamps/<id>/bundle.tar.gz.')
output pdpBaseUrl string = 'https://${endpoint.properties.hostName}'

@description('Whether a WAF security policy was attached to the issuer endpoint.')
output wafAttached bool = routeDeploy
