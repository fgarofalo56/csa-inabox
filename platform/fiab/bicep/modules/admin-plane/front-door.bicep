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

@description('''DEPRECATED and IGNORED since #3203. The Front Door -> ACA env
private-endpoint approval moved out of an ARM deploymentScript and into the deploy
itself (scripts/csa-loom/approve-cae-private-endpoints.sh), because the script
could not run under a policy denying shared-key storage and its az command did not
support managedEnvironments anyway. Retained so existing callers do not break.''')
param scriptIdentityId string = ''

@description('DEPRECATED and IGNORED since #3203 — there is no longer an approval deployment script to place.')
param scriptLocation string = location

@description('Cache-busting tag so the approval script re-runs on each deploy (idempotent — approve is a no-op once Approved).')
param forceUpdateTag string = utcNow()

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
    // ── Custom rules (evaluated BEFORE managed rules) ────────────────────────
    // F12 Git integration: the console's BFF exposes session-gated admin routes
    // under `/api/admin/workspaces/{id}/git/**` (connect / sync / status / meta).
    // Front Door's Microsoft_DefaultRuleSet has a `.git`-exposure rule that 403s
    // any request whose URL path carries the `git` segment — which would block
    // the real ADO/GitHub commit flow. A narrow Allow custom rule, matched on the
    // request URI carrying BOTH `/api/admin/workspaces/` AND `/git`, short-circuits
    // managed-rule evaluation for exactly that admin path family (and nothing
    // else). These routes are Entra-session-gated in the app, body inspection is
    // already disabled (above), and URL/header/cookie + Bot Manager protection
    // still apply to every other path — so this is scoped, not a blanket bypass.
    customRules: {
      rules: [
        // ── Block the VNet-internal service-to-service surface at the edge ────
        // (rel-T10/B3) The `/api/internal/**` routes (copilot tool-dispatch,
        // topology register-domain) are token-gated callbacks the MAF app +
        // setup-orchestrator invoke over the Container Apps INTERNAL network
        // (http://loom-console) — they never traverse Front Door in the
        // legitimate flow. So any request for `/api/internal/` arriving at the
        // PUBLIC edge is illegitimate: block it (403) before it reaches the
        // origin, defense-in-depth on top of the app's shared-token gate. Lowest
        // priority number ⇒ evaluated first. Note this does NOT touch the
        // INTENTIONALLY external `/api/iq/mcp` or `/api/deployment-pipelines/**`
        // Bearer paths — only the `/api/internal/` prefix.
        {
          name: 'BlockInternalApiAtEdge'
          priority: 90
          enabledState: 'Enabled'
          ruleType: 'MatchRule'
          action: 'Block'
          matchConditions: [
            {
              matchVariable: 'RequestUri'
              operator: 'Contains'
              negateCondition: false
              transforms: ['Lowercase']
              matchValue: ['/api/internal/']
            }
          ]
        }
        {
          name: 'AllowAdminWorkspaceGitApi'
          priority: 100
          enabledState: 'Enabled'
          ruleType: 'MatchRule'
          action: 'Allow'
          matchConditions: [
            {
              matchVariable: 'RequestUri'
              operator: 'Contains'
              negateCondition: false
              transforms: ['Lowercase']
              matchValue: ['/api/admin/workspaces/']
            }
            {
              matchVariable: 'RequestUri'
              operator: 'Contains'
              negateCondition: false
              transforms: ['Lowercase']
              matchValue: ['/git']
            }
          ]
        }
      ]
    }
    managedRules: {
      // Exclude Loom's OWN encrypted session cookie from DRS inspection. The
      // `loom_session` value is an AES-256-GCM base64url blob; to the OWASP
      // SQLI/RCE rules that opaque ciphertext looks like an attack payload, so
      // an AUTHENTICATED browser (which always sends it) gets 403'd at Front Door
      // ("The request is blocked") while an anonymous curl (no cookie) passes —
      // exactly the signed-in-only block seen on the Gov console 2026-07-14.
      // Scoped to just this cookie NAME (RequestCookieNames), so every other
      // request part is still fully inspected. Applies to Commercial + Gov.
      exclusions: [
        {
          matchVariable: 'RequestCookieNames'
          selectorMatchOperator: 'StartsWith'
          selector: 'loom_session'
        }
      ]
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

// AFD Standard/Premium derives the endpoint's public hostname deterministically
// from the endpoint NAME (loom-console-<hash>.z01.azurefd.net). A bare
// 'loom-console' therefore collides globally with any OTHER hub's endpoint of the
// same name ("That resource name isn't available." — hit live on the centralus
// clean-rebuild while the old eastus2 hub's 'loom-console' endpoint was still up).
// Suffixing with uniqueString(rg.id) makes the name unique per admin-plane RG so a
// new hub can stand up alongside an old one during a migration. Cosmetic only —
// end users reach the console via the vanity custom domain, not this host.
resource fdEndpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' = {
  parent: fdProfile
  name: 'loom-console-${uniqueString(resourceGroup().id)}'
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
      // Probe the cheap liveness endpoint (no SSR render) rather than '/'.
      probePath: '/api/health'
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

// ── Front Door -> ACA env Private Link: APPROVED BY THE DEPLOY, NOT BY ARM ────
//
// This was a `Microsoft.Resources/deploymentScripts` (AzureCLI) that approved the
// pending private-endpoint connection the FD origin raises. It is gone, for two
// independent reasons — both measured, neither hypothetical (#3203).
//
// 1. IT COULD NOT RUN. ARM auto-provisions an ephemeral SHARED-KEY staging
//    storage account for a deploymentScript. Any subscription with a policy
//    denying `allowSharedKeyAccess` blocks it:
//        DeploymentScriptOperationFailed  script-loom-fd-aca-pe-approve
//        ErrorCode: KeyBasedAuthenticationNotPermitted
//    deploy-fiab-commercial run 31435481880 — one of four ARM leaves that failed
//    the WHOLE apply, for a step Front Door does not depend on. The mitigation in
//    place was to pass an empty scriptIdentityId on GCC-High/IL5 and tell the
//    operator to click Approve in the portal, which violates
//    auto-bind-by-default.md (a remediation the platform could perform itself)
//    and cloud-parity.md (the sovereign boundaries got the lesser path). MCAPS
//    policy has since reached Commercial too, so the split stopped holding there.
//
// 2. ITS az COMMAND DID NOT WORK EITHER. It called
//    `az network private-endpoint-connection list --id <caeId>`, which answers
//    "Resource ID is invalid. Please check it." for
//    Microsoft.App/managedEnvironments — verified live 2026-08-11. That read was
//    wrapped in `2>/dev/null || true`, so the error became an empty list and the
//    empty list became "nothing pending". The script could only ever time out.
//
// The deploy now runs scripts/csa-loom/approve-cae-private-endpoints.sh with the
// deploy identity: no staging storage, the ARM child path with a probed
// api-version, every failure classified, and idempotent — so a deleted or
// re-raised connection is re-approved on the next deploy instead of erroring.

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
    // ASSOCIATE THE VANITY DOMAIN. This was a hard-coded `[]`, which meant the
    // route served ONLY the default *.azurefd.net host: Front Door had no route
    // bound to the custom hostname, so the edge answered it with a fallback
    // `CN=*.azureedge.net` certificate and every browser reported
    // ERR_CERT_COMMON_NAME_INVALID. Measured live on csa-loom.limitlessdata.ai
    // 2026-08-11 — the custom domain itself was Approved/Succeeded with a
    // ManagedCertificate the whole time; nothing was expired. It simply was not
    // attached to a route.
    //
    // Because the association had to be made out-of-band, it was also invisible
    // to this template and therefore DELETED by any apply that reached this
    // module — the same "a bicep re-render drops whatever is not in the
    // template" class that blanked the bootstrap admin OID and LOOM_ADLS_ACCOUNT.
    //
    // `linkToDefaultDomain` stays Enabled, so the generated *.azurefd.net host
    // keeps working alongside the vanity name (the roll gates and the in-VNet
    // UAT both target it).
    customDomains: empty(vanityDomain) ? [] : [ { id: fdCustomDomain!.id } ]
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

@description('The Container Apps managed environment whose Front Door private-endpoint connection the deploy must approve (scripts/csa-loom/approve-cae-private-endpoints.sh --cae-id).')
output caeIdForPeApproval string = caeId
