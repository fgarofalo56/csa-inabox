// CSA Loom — Front Door Premium + Private Link to ACA
//
// Best UX for the SaaS-feel: global edge, managed cert, WAF, and a
// private-link tunnel into the internal Container Apps env. End users
// hit a public *.azurefd.net (or custom) hostname; traffic exits FD
// edge into the env's internal LB without traversing the public
// internet between FD and ACA.
//
// Cost: ~$330/mo base + traffic + WAF rules.
// Provisioning time: ~5-10 min, but PE approval on ACA env is manual
// the first time (operator clicks Approve in the portal).

targetScope = 'resourceGroup'

@description('Primary region')
param location string = resourceGroup().location

@description('Container Apps env resource ID (for the Private Link origin)')
param caeId string

@description('Container Apps env default domain (used as the origin host header)')
param caeDefaultDomain string

@description('Console FQDN to route to — must be the external-ingress hostname')
param consoleFqdn string

@description('Compliance tags')
param complianceTags object

resource wafPolicy 'Microsoft.Network/FrontDoorWebApplicationFirewallPolicies@2024-02-01' = {
  name: 'wafloomfd${uniqueString(resourceGroup().id)}'
  location: 'global'
  tags: complianceTags
  sku: { name: 'Premium_AzureFrontDoor' }
  properties: {
    policySettings: {
      enabledState: 'Enabled'
      mode: 'Prevention'
      // Request-body inspection is DISABLED by design. The console's BFF (`/api/*`)
      // is a session-gated (Entra) backend-for-frontend that legitimately carries
      // SQL / KQL / OData / Gremlin / GraphQL query text in request bodies (Cosmos
      // Data Explorer, AI Search, ADX, Azure SQL, Gremlin, GraphQL editors). The
      // OWASP SQLI/RCE managed rules (Microsoft_DefaultRuleSet 2.1) inspect both the
      // parsed JSON args AND the raw `InitialBodyContents` (which exclusions cannot
      // cover), so they BLOCK every non-trivial query through Front Door in
      // Prevention mode (verified live 2026-06-01: `SELECT … WHERE … ORDER BY` → 403).
      // A custom Allow rule on `/api/*` did NOT bypass the managed body rules in
      // practice, and per-arg exclusions miss InitialBodyContents — so the only
      // reliable fix is to stop inspecting request bodies. URL / query-string /
      // header / cookie inspection + the Bot Manager rule set all remain ACTIVE, so
      // the public / login / static surface keeps WAF protection; only the request
      // *body* (which the app parses safely and forwards as parameterized data-plane
      // calls) is no longer scanned. Acceptable for an authenticated analytics BFF.
      requestBodyCheck: 'Disabled'
    }
    managedRules: {
      managedRuleSets: [
        {
          ruleSetType: 'Microsoft_DefaultRuleSet'
          ruleSetVersion: '2.1'
          ruleSetAction: 'Block'
        }
        {
          ruleSetType: 'Microsoft_BotManagerRuleSet'
          ruleSetVersion: '1.0'
        }
      ]
    }
  }
}

resource fdProfile 'Microsoft.Cdn/profiles@2024-02-01' = {
  name: 'fd-loom-${uniqueString(resourceGroup().id)}'
  location: 'global'
  tags: complianceTags
  sku: { name: 'Premium_AzureFrontDoor' }
}

resource fdEndpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' = {
  parent: fdProfile
  name: 'loom-console'
  location: 'global'
  tags: complianceTags
  properties: {
    enabledState: 'Enabled'
  }
}

resource fdOriginGroup 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = {
  parent: fdProfile
  name: 'aca-console'
  properties: {
    loadBalancingSettings: {
      sampleSize: 4
      successfulSamplesRequired: 3
      additionalLatencyInMilliseconds: 50
    }
    healthProbeSettings: {
      probePath: '/'
      probeRequestType: 'GET'
      probeProtocol: 'Https'
      probeIntervalInSeconds: 30
    }
    sessionAffinityState: 'Disabled'
  }
}

// Private Link origin into the Container Apps env. The PE request
// shows up on the env's "Network → Private endpoint connections"
// blade and must be approved manually the first time.
resource fdOrigin 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = {
  parent: fdOriginGroup
  name: 'aca-console-origin'
  properties: {
    hostName: consoleFqdn
    httpPort: 80
    httpsPort: 443
    originHostHeader: consoleFqdn
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
    enforceCertificateNameCheck: true
    sharedPrivateLinkResource: {
      privateLink: { id: caeId }
      privateLinkLocation: location
      groupId: 'managedEnvironments'
      requestMessage: 'Front Door Premium → ACA env (CSA Loom Console)'
    }
  }
}

// ── Optional vanity custom domain (e.g. csa-loom.contoso.ai) ──────────────────
// When the admin supplies a vanity URL at deploy time, create a Front Door
// managed-cert custom domain. The deploy then surfaces the CNAME + _dnsauth TXT
// (outputs below) to add at the DNS provider; once those validate, the domain is
// associated to the route (post-deploy bootstrap, or auto when the DNS zone is
// Azure-managed). Empty vanityDomain → no-op (the *.azurefd.net host still works).
@description('Optional vanity hostname for the console (e.g. csa-loom.contoso.ai). Empty = use the generated Front Door host.')
param vanityDomain string = ''

var vanityName = empty(vanityDomain) ? 'unused-vanity' : replace(replace(vanityDomain, '.', '-'), '*', 'wild')

resource fdCustomDomain 'Microsoft.Cdn/profiles/customDomains@2024-02-01' = if (!empty(vanityDomain)) {
  parent: fdProfile
  name: vanityName
  properties: {
    hostName: vanityDomain
    tlsSettings: {
      certificateType: 'ManagedCertificate'
      minimumTlsVersion: 'TLS12'
    }
  }
}

resource fdRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = {
  parent: fdEndpoint
  name: 'console-route'
  properties: {
    customDomains: []
    originGroup: { id: fdOriginGroup.id }
    supportedProtocols: ['Http', 'Https']
    patternsToMatch: ['/*']
    forwardingProtocol: 'HttpsOnly'
    linkToDefaultDomain: 'Enabled'
    httpsRedirect: 'Enabled'
  }
  dependsOn: [fdOrigin]
}

resource fdSecurityPolicy 'Microsoft.Cdn/profiles/securityPolicies@2024-02-01' = {
  parent: fdProfile
  name: 'console-waf-policy'
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: { id: wafPolicy.id }
      associations: [
        {
          domains: [{ id: fdEndpoint.id }]
          patternsToMatch: ['/*']
        }
      ]
    }
  }
}

output frontDoorProfileId string = fdProfile.id
output frontDoorEndpointHostName string = fdEndpoint.properties.hostName
output frontDoorPublicUrl string = 'https://${fdEndpoint.properties.hostName}'
// Vanity-domain wiring — the deploy surfaces these so the admin can add DNS.
output vanityDomain string = vanityDomain
output vanityPublicUrl string = empty(vanityDomain) ? '' : 'https://${vanityDomain}'
output vanityCnameTarget string = fdEndpoint.properties.hostName
output vanityDnsTxtName string = empty(vanityDomain) ? '' : '_dnsauth.${vanityDomain}'
output vanityValidationToken string = empty(vanityDomain) ? '' : fdCustomDomain.properties.validationProperties.validationToken
output frontDoorOriginGroupId string = fdOriginGroup.id
output wafPolicyId string = wafPolicy.id
output caeDefaultDomainEcho string = caeDefaultDomain
