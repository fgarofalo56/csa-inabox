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

@description('''Console UAMI resource id — identity for the private-endpoint-connection
approval deployment script. MUST hold Network Contributor (or Contributor) on the
RG that owns the Container Apps managed environment (the admin-plane RG grants the
Console UAMI Network Contributor on itself — see network.bicep F15). Leave empty to
skip the auto-approval script (operator then approves the PE connection manually in
the portal: ACA env -> Networking -> Private endpoint connections).''')
param scriptIdentityId string = ''

@description('Region for the approval deployment script (kept distinct so it can run where ACI quota exists).')
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

// ── Auto-approve the Front Door -> ACA env Private Link connection ────────────
// When FD creates the sharedPrivateLinkResource above, a private-endpoint
// connection lands on the Container Apps managed environment in *Pending* state.
// Until it is approved, FD cannot reach the origin and the public endpoint 504s
// (verified live: clean deploy with frontDoorEnabled -> portal "Approve" was the
// only thing standing between a 504 and a working console). This script runs
// `az network private-endpoint-connection approve` for that connection so a clean
// deploy is end-to-end functional with no manual portal step.
//
// Identity: the Console UAMI (scriptIdentityId) holds Network Contributor on the
// admin-plane RG that owns the CAE (network.bicep F15), which is sufficient to
// approve a PE connection on the managed environment.
//
// FD has a known issue where it may create MULTIPLE pending connections; the
// script approves EVERY pending connection on the env (idempotent — already-
// approved connections are skipped), which also covers that case.
//
// Staging-storage caveat: this AzureCLI deploymentScript lets ARM auto-provision
// its ephemeral staging storage account (same as the other admin-plane scripts —
// entra-app-registration, ai-search). If the subscription enforces an Azure Policy
// that DENIES storage accounts with shared-key access (allowSharedKeyAccess=false),
// ARM's auto-provisioned SA is blocked and this script fails to start. In that case
// either (a) exempt the deploymentScripts-created SA from the policy, or (b) leave
// scriptIdentityId empty and approve the PE connection manually in the portal
// (ACA env -> Networking -> Private endpoint connections -> Approve). The FD wiring
// itself does not depend on this script succeeding.
resource approvePeScript 'Microsoft.Resources/deploymentScripts@2023-08-01' = if (!empty(scriptIdentityId)) {
  name: 'script-loom-fd-aca-pe-approve'
  location: scriptLocation
  tags: complianceTags
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${scriptIdentityId}': {}
    }
  }
  // Approve only AFTER both the ACA env (caeId) and the FD origin (which raises
  // the PE request) exist. fdOrigin implicitly depends on caeId via the
  // sharedPrivateLinkResource.privateLink.id reference.
  dependsOn: [
    fdOrigin
  ]
  properties: {
    azCliVersion: '2.61.0'
    retentionInterval: 'PT1H'
    timeout: 'PT20M'
    forceUpdateTag: forceUpdateTag
    cleanupPreference: 'OnSuccess'
    environmentVariables: [
      { name: 'CAE_ID', value: caeId }
    ]
    scriptContent: '''
set -euo pipefail
echo "Resolving pending private-endpoint connections on Container Apps env: $CAE_ID"

# FD may take a moment to raise the PE request after the origin is created, and
# may create more than one. Poll for up to ~10 min, approving any Pending ones.
deadline=$(( $(date +%s) + 600 ))
approved_any=0
while :; do
  # List PE connections on the managed environment that are Pending.
  PENDING=$(az network private-endpoint-connection list \
    --id "$CAE_ID" \
    --query "[?properties.privateLinkServiceConnectionState.status=='Pending'].id" \
    -o tsv 2>/dev/null || true)

  if [ -n "${PENDING:-}" ]; then
    while IFS= read -r conn; do
      [ -z "$conn" ] && continue
      echo "Approving pending PE connection: $conn"
      az network private-endpoint-connection approve \
        --id "$conn" \
        --description "Auto-approved by CSA Loom deploy (Front Door to ACA env)" \
        >/dev/null
      approved_any=1
    done <<< "$PENDING"
  fi

  # Already approved at least one AND nothing left pending -> done.
  STILL_PENDING=$(az network private-endpoint-connection list \
    --id "$CAE_ID" \
    --query "length([?properties.privateLinkServiceConnectionState.status=='Pending'])" \
    -o tsv 2>/dev/null || echo 0)
  if [ "$approved_any" = "1" ] && [ "${STILL_PENDING:-0}" = "0" ]; then
    echo "All Front Door PE connections approved."
    break
  fi

  if [ "$(date +%s)" -ge "$deadline" ]; then
    if [ "$approved_any" = "1" ]; then
      echo "Approved connection(s); some may still be settling. Continuing."
      break
    fi
    echo "Timed out waiting for a pending Front Door PE connection to appear." >&2
    echo "If this persists, approve manually: ACA env -> Networking -> Private endpoint connections." >&2
    exit 1
  fi
  sleep 20
done
'''
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
