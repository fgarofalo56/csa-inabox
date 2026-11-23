// CSA Loom Health Data Services (LHDS) - subscription-level deployment unit.
//
// WHY A SEPARATE ENTRYPOINT (decision recorded 2026-10-25, PR #5126). LHDS is its
// own deployment unit with its own ARM template and its own 4 MiB inline budget,
// not a section of main.bicep. Embedding the stamp (W1-1) and the control plane
// (W1-3) in main.bicep grew apps/fiab-console/deploy-templates/main.json from
// 3,994,502 bytes (before W1-1) to 4,186,680 (W1-1) and 4,239,225 (W1-3), over the
// 4,194,304-byte limit that redis-retirement-2642.test.ts pins and that
// lib/setup/user-arm-deploy.ts breaks above. With the stamp moved out, main.json
// is back to 3,994,502. LHDS has no reason to share main.bicep's budget: it is
// default-off, deploys into its own resource group, and is not part of the Loom
// install the console submits inline.
//
// Deployed by .github/workflows/deploy-health.yml (Commercial and GCC-High; IL5 and
// DoD are supported in code through health-params/il5-health.bicepparam and have never been
// exercised; GCC is not claimed). The workflow discovers the hub's registry and
// Container Apps environment and passes them in `controlPlaneConfig`.
//
//   az deployment sub create --location <region> -f platform/fiab/bicep/health.bicep \
//     -p platform/fiab/bicep/health-params/<boundary>-health.bicepparam \
//     healthEnabled=true adminEntraGroupId=<group> controlPlaneConfig=@cp.json
//
// One stamp = one resource group (ADR-005): rg-csa-loom-health-<stamp>-<region>.
// healthConfig keys (all optional): stampName, profile (dev|S|M|L), location,
//   pairedLocation, adminEntraGroupId, vnetAddressPrefix, egressMode
//   ('firewall'|'loadBalancer'), postgresHa, useAvailabilityZones, kubernetesVersion,
//   acrLoginServer, extraAllowedFqdns, extraDnsLinkVnetIds, tlsCertificateSecretUri,
//     selfSignedTls (default true; false = no TLS listener unless tlsCertificateSecretUri is set),
//     wafClientRateLimitPerMinute (default 6000; 0 drops the WAF per-address rule, the documented
//     Gov escape if the rule type is rejected there - UNVERIFIED in Gov),
//   auditRetentionDays, logRetentionDays, postgres ('enabled'|'disabled': per-stamp
//   override of postgresQuotaAvailable).
// controlPlaneConfig keys:
//   audiences (array, REQUIRED for the control plane: it refuses to start without an
//     accepted token audience; empty = control plane not deployed),
//   controlPlane ('containerApps'|'aks'; default aks at IL5 else containerApps, and
//     independent of the admin-plane containerPlatform, which is containerApps in every
//     param file including il5),
//   environmentId (containerApps path), acrName + acrResourceGroup + acrLoginServer,
//   imageTag (default v0.1), allowedCallerAppIds, privateEndpointSubnetId,
//   cosmosPrivateDnsZoneId,
//   hubVaultPeSubnetId, hubVaultZoneId, hubResourceGroup (optional overrides of the hub-side stamp-vault
//     private endpoint inputs, #5345; derived from environmentId and the hub naming convention by default),
//   pdpBundleVerificationPublicKeyPem (PUBLIC key; the per-stamp OPA PDP deploys only when
//     this is set and the control plane deploys), pdpImage is NOT a parameter: the PDP image is modules/health/pdp-image.json (tag for display + the sha256 digest deployed AND imported by deploy-health; image
//     <acr>/opa@<digest>), pdpControlPlaneBaseUrl (https; default = the Front Door issuer endpoint, which serves
//     /api/health/pdp/*; required when there is no frontDoor profile), pdpReplicas (default 2), pdpApplyPrincipalId (object id of the service principal that
//     applies the PDP manifest; gets the Kubernetes data role Azure Kubernetes Service RBAC Cluster Admin, #5422),
//   frontDoor ({profileName, resourceGroup?, subscriptionId?}; the EXISTING Front Door Premium
//     profile that serves the issuer on a /auth/*-only route, #5410; deploy-health.yml resolves it from the hub
//     resource group. Absent = no Front Door on this boundary: the issuer default stays the stamp ingress URL,
//     which has no path to the control plane, and healthIssuerState says so),
//   authIssuerUrl, authFhirBaseUrl (optional overrides: authIssuerUrl defaults to https://<Front Door issuer
//     endpoint host>/auth when frontDoor is set, else https://<stamp ingress fqdn>/auth; authFhirBaseUrl
//     defaults to https://<stamp ingress fqdn>), authAsClientId (the Entra app loom-health-cp-as; supplied by
//     deploy-health.yml; reported in healthControlPlaneState.authServerMissing when empty), authGraphConsentUrl
//     (optional), authSigningKeyId (optional; default = a key created in the stamp vault),
//   apim (object; publishes the lhds-tenant-routing fragment and grants the APIM identity
//     Reader on the control plane; keys documented at the APIM section below).
// Gov boundaries default to usgovarizona (primary, zone-redundant PostgreSQL HA) paired
// with usgovtexas: usgovvirginia is offer-restricted for PostgreSQL on the measured
// subscription (PRPs/active/loom-health-data-services/W0-RECEIPT.md s4.1b).

targetScope = 'subscription'

@description('Hub region. The control plane Container App must share its environment region, so on the containerApps path it deploys here; the stamp and the aks path use the stamp region.')
param location string

@description('Cloud boundary.')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5', 'DoD'])
param boundary string

// D3 (LHDS W1-8): 'DoD' is SUPPORTED-IN-CODE ONLY, never exercised; it resolves as IL5 (same
// Azure Government DoD cloud) so the health modules never see 'DoD'.
var effectiveBoundary = (boundary == 'DoD' || boundary == 'IL5') ? 'IL5' : (boundary == 'GCC-High' ? 'GCC-High' : (boundary == 'GCC' ? 'GCC' : 'Commercial'))

@description('Deploy an LHDS stamp (private AKS, PostgreSQL Flexible Server, Blob, Event Hubs, Key Vault, WAF v2 ingress) into its own resource group. Default false: with false nothing is created.')
param healthEnabled bool = false

@description('LHDS stamp settings (see the header). Ignored while healthEnabled is false.')
param healthConfig object = {}

@description('LHDS control-plane settings (see the header). The control plane deploys only when audiences is non-empty.')
param controlPlaneConfig object = {}

@description('Entra group that administers the vault, the PostgreSQL server and the cluster. Empty = the operator grants roles after the deploy.')
param adminEntraGroupId string = ''

@description('Whether PostgreSQL Flexible Server is available in the target subscription and region. The stamp consults it through healthConfig.postgres, which Gov param files set because their false is an Airflow posture hold, not a PostgreSQL fact.')
param postgresQuotaAvailable bool = true

@description('Phase 2 of the ingress TLS ordering (#5345): the VERSIONLESS Key Vault secret URI of the certificate the control plane issued. deploy-health.yml passes it only after confirming, through the ARM management plane, that the secret exists. Empty = phase 1: no TLS listener yet.')
param issuedTlsSecretUri string = ''

@description('Skip role assignments (re-deploys where the deployer cannot write RBAC).')
param skipRoleGrants bool = false

@description('Tags applied to every resource.')
param tags object = {}

var healthIsGov = effectiveBoundary == 'GCC-High' || effectiveBoundary == 'IL5'
var healthStampName = string(healthConfig.?stampName ?? 'dev01')
var healthLocation = string(healthConfig.?location ?? (healthIsGov ? 'usgovarizona' : location))
var healthPairedLocation = string(healthConfig.?pairedLocation ?? (healthIsGov ? 'usgovtexas' : ''))
// PostgreSQL gate (3449d): the engines cannot run without it.
var healthPgOverride = toLower(string(healthConfig.?postgres ?? ''))
var healthPgAllowed = healthPgOverride == 'enabled' ? true : (healthPgOverride == 'disabled' ? false : postgresQuotaAvailable)
var healthDeploy = healthEnabled && healthPgAllowed

resource healthRg 'Microsoft.Resources/resourceGroups@2024-03-01' = if (healthDeploy) {
  name: 'rg-csa-loom-health-${healthStampName}-${healthLocation}'
  location: healthLocation
  tags: tags
}

module healthStamp 'modules/health/stamp.bicep' = if (healthDeploy) {
  name: 'lhds-stamp-${healthStampName}'
  scope: healthRg
  params: {
    location: healthLocation
    pairedLocation: healthPairedLocation
    stampName: healthStampName
    boundary: effectiveBoundary
    postgresQuotaAvailable: healthPgAllowed
    profile: healthConfig.?profile ?? 'dev'
    adminEntraGroupId: string(healthConfig.?adminEntraGroupId ?? adminEntraGroupId)
    vnetAddressPrefix: string(healthConfig.?vnetAddressPrefix ?? '10.60.0.0/16')
    egressModeOverride: healthConfig.?egressMode ?? ''
    postgresHaOverride: healthConfig.?postgresHa ?? ''
    useAvailabilityZones: bool(healthConfig.?useAvailabilityZones ?? true)
    kubernetesVersion: string(healthConfig.?kubernetesVersion ?? '1.34')
    acrLoginServer: string(healthConfig.?acrLoginServer ?? '')
    // #5422 decision 8: the hub registry is public-access Disabled; the stamp gets a private endpoint to it (acr-pe.bicep) plus a
    // stamp-scoped privatelink.azurecr zone. Same subscription as the deployment (acr-pull.bicep shares that assumption). Empty = neither.
    acrResourceId: cpAcrKnown ? resourceId(subscription().subscriptionId, cpAcrResourceGroup, 'Microsoft.ContainerRegistry/registries', cpAcrName) : ''
    // #5422: in firewall mode the PDP reaches its bundle through the Front Door endpoint, which therefore must be on the egress
    // allow-list (login.microsoftonline is already there). In loadBalancer mode no rule is deployed, so appending it is inert.
    extraAllowedFqdns: concat(healthConfig.?extraAllowedFqdns ?? [], fdIssuerDeploy ? [healthAuthEndpoint!.outputs.endpointHostName] : [])
    extraDnsLinkVnetIds: healthConfig.?extraDnsLinkVnetIds ?? []
    tlsCertificateSecretUri: string(healthConfig.?tlsCertificateSecretUri ?? '')
    selfSignedTlsEnabled: bool(healthConfig.?selfSignedTls ?? true)
    issuedTlsSecretUri: issuedTlsSecretUri
    wafClientRateLimitPerMinute: int(healthConfig.?wafClientRateLimitPerMinute ?? 6000)
    auditRetentionDays: int(healthConfig.?auditRetentionDays ?? 2190)
    logRetentionDays: int(healthConfig.?logRetentionDays ?? 90)
    tags: tags
  }
}

// ── Control plane (apps/loom-health-cp) ───────────────────────────────────────
// cpPlatformInput keeps the caller value for messages; cpPlatformRaw is its lowercase form and
// must only be compared against lowercase literals (a lowered value never equals 'containerApps').
var cpPlatformInput = string(controlPlaneConfig.?controlPlane ?? (effectiveBoundary == 'IL5' ? 'aks' : 'containerApps'))
var cpPlatformRaw = toLower(cpPlatformInput)
var cpValidPlatform = contains(['containerapps', 'aks'], cpPlatformRaw)
// An unrecognised value is NOT coerced into a deployment: cpDeploy requires cpValidPlatform
// and the skip reason names the value.
var cpPlatform = cpPlatformRaw == 'aks' ? 'aks' : 'containerApps'
var cpAudiences = controlPlaneConfig.?audiences ?? []
var cpAcrName = string(controlPlaneConfig.?acrName ?? '')
var cpAcrLoginServer = string(controlPlaneConfig.?acrLoginServer ?? '')
var cpAcrResourceGroup = string(controlPlaneConfig.?acrResourceGroup ?? '')
var cpEnvironmentId = string(controlPlaneConfig.?environmentId ?? '')
var cpAcrKnown = !empty(cpAcrName) && !empty(cpAcrLoginServer) && !empty(cpAcrResourceGroup)
var cpHostable = cpPlatform == 'aks' || !empty(cpEnvironmentId)
var cpDeploy = healthDeploy && !empty(cpAudiences) && cpValidPlatform && cpAcrKnown && cpHostable
var cpSkipReason = !healthEnabled ? 'healthEnabled is false' : (!healthPgAllowed ? 'stamp not deployed: PostgreSQL unavailable in this region (healthConfig.postgres)' : (empty(cpAudiences) ? 'controlPlaneConfig.audiences is empty: the service refuses to start without an accepted token audience' : (!cpValidPlatform ? 'controlPlaneConfig.controlPlane must be containerApps or aks, got ${cpPlatformInput}' : (!cpAcrKnown ? 'controlPlaneConfig needs acrName, acrLoginServer and acrResourceGroup' : (!cpHostable ? 'containerApps path needs controlPlaneConfig.environmentId; set controlPlane=aks to use the stamp cluster' : '')))))

// Authorization server settings (W1-4). The signing key is created in the stamp vault unless
// authSigningKeyId is supplied. The three values below have no deploy-time source (the public
// W1b-1 auto-bind: the issuer URL and the FHIR edge base are DERIVED from the stamp ingress public
// FQDN (the Application Gateway public IP DNS label, produced by ingress.bicep), not supplied by an
// operator. controlPlaneConfig.authIssuerUrl / authFhirBaseUrl still win when set (a custom domain).
//   issuer        = https://<ingress fqdn>/auth     (the AS serves {issuerPath}/jwks.json, /{tenant}/token, ...)
//   fhir edge base = https://<ingress fqdn>         (the AS appends /{tenant}/fhir per tenant)
// The AS Entra app client id is an Entra object with no ARM source, so it cannot be derived here:
// deploy-health.yml resolves it (input, repo variable, or an exactly-one Entra lookup) and passes
// controlPlaneConfig.authAsClientId. If it is still empty it is reported in
// healthControlPlaneState.authServerMissing, and the workflow fails the run on a non-empty list.
// TLS: with healthConfig.tlsCertificateSecretUri empty (the default) the CONTROL PLANE issues a Key
// Vault SELF-SIGNED certificate for the ingress FQDN (operator decision 2026-11-17, #5345; apps/
// loom-health-cp src/tls/ingress-cert.ts; a deploymentScript cannot run where policy forces storage
// shared-key access off), so the https listener exists on every boundary. Two phases: phase 1 (this
// template, issuedTlsSecretUri empty) deploys the stamp WITHOUT a TLS listener and the control plane
// with the Key Vault Certificates Officer grant; deploy-health.yml then waits for the secret to exist
// (ARM management plane) and re-deploys with issuedTlsSecretUri set (phase 2), which builds the
// listener on the VERSIONLESS secret URI so renewals roll without a redeploy. Set
// tlsCertificateSecretUri to a CA certificate to override; healthConfig.selfSignedTls=false restores
// the no-listener behaviour. The stamp manifest carries ingressTlsMode, ingressTlsCertificateName
// and ingressTlsExpectedIssuedSecretUri.
var cpIssuesIngressCert = empty(string(healthConfig.?tlsCertificateSecretUri ?? '')) && bool(healthConfig.?selfSignedTls ?? true)
var cpIngressFqdn = healthDeploy ? string(healthStamp!.outputs.stamp.ingressPublicFqdn) : ''
// #5410 issuer via Front Door. The control plane runs in the INTERNAL hub environment, which the stamp
// Application Gateway cannot reach (0 VNet peerings, measured 2026-11-21), so https://<stamp ingress>/auth
// answered 502. When controlPlaneConfig.frontDoor names the existing profile, the issuer default is the host of
// a dedicated Front Door endpoint (route /auth/* only). The endpoint is created by a first invocation of
// afd-issuer.bicep BEFORE the control plane (which needs the issuer at creation); the origin and route are
// created by a second invocation AFTER it (they need the control plane FQDN).
var fdCfg = controlPlaneConfig.?frontDoor ?? {}
var fdProfileName = string(fdCfg.?profileName ?? '')
var fdSubscriptionId = string(fdCfg.?subscriptionId ?? hubSubscriptionId)
var fdResourceGroup = string(fdCfg.?resourceGroup ?? hubResourceGroup)
var fdIssuerDeploy = cpDeploy && cpPlatform == 'containerApps' && !empty(fdProfileName)
var cpStampIssuerUrl = empty(cpIngressFqdn) ? '' : 'https://${cpIngressFqdn}/auth'
var cpAuthIssuerUrl = string(controlPlaneConfig.?authIssuerUrl ?? (fdIssuerDeploy ? healthAuthEndpoint!.outputs.issuerUrl : cpStampIssuerUrl))
var cpAuthFhirBaseUrl = string(controlPlaneConfig.?authFhirBaseUrl ?? (empty(cpIngressFqdn) ? '' : 'https://${cpIngressFqdn}'))
var cpAuthAsClientId = string(controlPlaneConfig.?authAsClientId ?? '')
var cpAuthMissing = concat(
  empty(cpAuthIssuerUrl) ? ['authIssuerUrl'] : [],
  empty(cpAuthFhirBaseUrl) ? ['authFhirBaseUrl'] : [],
  empty(cpAuthAsClientId) ? ['authAsClientId'] : []
)

// ── Hub-side private endpoint for the stamp vault (#5345) ─────────────────────
// The containerApps control plane runs in the HUB environment, which cannot resolve the private-only
// stamp vault (the stamp privatelink.vaultcore zone is linked to the stamp VNet only). A second PE on
// the vault, in the hub PE subnet, with its zone group in the HUB vaultcore zone, fixes that. Hub facts
// are derived from controlPlaneConfig.environmentId (hub subscription + resource group) and the Loom
// hub conventions (vnet-csa-loom-hub-<hub region>/snet-private-endpoints; the zone is named from
// environment() so GCC-High / IL5 resolve privatelink.vaultcore.usgovcloudapi.net). Each is overridable
// through controlPlaneConfig.hubVaultPeSubnetId / hubVaultZoneId / hubResourceGroup. The aks control
// plane runs inside the stamp VNet and needs none of this.
var hubEnvIdParts = split(cpEnvironmentId, '/')
var hubEnvIdValid = length(hubEnvIdParts) > 4
var hubSubscriptionId = hubEnvIdValid ? hubEnvIdParts[2] : subscription().subscriptionId
var hubResourceGroup = string(controlPlaneConfig.?hubResourceGroup ?? (hubEnvIdValid ? hubEnvIdParts[4] : ''))
var hubVaultZoneName = 'privatelink.vaultcore${substring(environment().suffixes.keyvaultDns, length('.vault'))}'
var hubVaultPeSubnetId = string(controlPlaneConfig.?hubVaultPeSubnetId ?? '/subscriptions/${hubSubscriptionId}/resourceGroups/${hubResourceGroup}/providers/Microsoft.Network/virtualNetworks/vnet-csa-loom-hub-${location}/subnets/snet-private-endpoints')
var hubVaultZoneId = string(controlPlaneConfig.?hubVaultZoneId ?? '/subscriptions/${hubSubscriptionId}/resourceGroups/${hubResourceGroup}/providers/Microsoft.Network/privateDnsZones/${hubVaultZoneName}')
var hubVaultPeDeploy = cpDeploy && cpPlatform == 'containerApps' && !empty(hubResourceGroup)

// ── Hub-side private endpoint for the control-plane registry Cosmos (#5370) ───
// The tenant policy MCAPSGovDeployPolicies/CosmosDB_PublicNetwork_Modify (effect modify) forces
// publicNetworkAccess=Disabled on every Cosmos account regardless of the template, so a CP account with
// no private endpoint is reachable from nowhere. control-plane.bicep already carries a PE + DNS zone
// group; this defaults its inputs to the hub PE subnet and the hub privatelink.documents zone (zone
// suffix per boundary, as network.bicep names it: .us on GCC-High/IL5). Explicit
// controlPlaneConfig.privateEndpointSubnetId / cosmosPrivateDnsZoneId (including an explicit empty
// string) win. A private endpoint must be in the same region AND subscription as its VNet (Learn:
// private-link/private-endpoint-overview), so the default applies only when the hub subscription is
// the health deployment subscription; otherwise it stays empty (no PE, unchanged behaviour) and the
// operator supplies both values. The aks path (CP inside the stamp VNet) is not defaulted.
var hubCosmosZoneName = 'privatelink.documents.azure.${healthIsGov ? 'us' : 'com'}'
var hubCosmosPeDefault = cpPlatform == 'containerApps' && hubEnvIdValid && !empty(hubResourceGroup) && hubSubscriptionId == subscription().subscriptionId
var cpCosmosPeSubnetId = string(controlPlaneConfig.?privateEndpointSubnetId ?? (hubCosmosPeDefault ? hubVaultPeSubnetId : ''))
var cpCosmosZoneId = string(controlPlaneConfig.?cosmosPrivateDnsZoneId ?? (hubCosmosPeDefault ? '/subscriptions/${hubSubscriptionId}/resourceGroups/${hubResourceGroup}/providers/Microsoft.Network/privateDnsZones/${hubCosmosZoneName}' : ''))

module healthHubVaultPe 'modules/health/hub-vault-pe.bicep' = if (hubVaultPeDeploy) {
  name: 'lhds-hub-vault-pe-${healthStampName}'
  scope: resourceGroup(hubSubscriptionId, hubResourceGroup)
  params: {
    location: location
    vaultId: healthStamp!.outputs.stamp.keyVaultId
    vaultName: last(split(healthStamp!.outputs.stamp.keyVaultId, '/'))
    hubPeSubnetId: hubVaultPeSubnetId
    hubVaultZoneId: hubVaultZoneId
    tags: tags
  }
}

module healthAuthEndpoint 'modules/health/afd-issuer.bicep' = if (fdIssuerDeploy) {
  name: 'lhds-afd-issuer-endpoint-${healthStampName}'
  scope: resourceGroup(fdSubscriptionId, fdResourceGroup)
  params: {
    profileName: fdProfileName
    stampName: healthStampName
    cpFqdn: ''
    caeId: cpEnvironmentId
    caeLocation: location
    tags: tags
  }
}

// The one tag the control plane image and the FHIR engine image are both pulled at (one build, one release).
var cpImageTag = string(controlPlaneConfig.?imageTag ?? 'v0.1')

module healthControlPlane 'modules/health/control-plane.bicep' = if (cpDeploy) {
  name: 'lhds-control-plane-${healthStampName}'
  scope: healthRg
  params: {
    location: cpPlatform == 'aks' ? healthLocation : location
    boundary: effectiveBoundary
    platform: cpPlatform
    image: '${cpAcrLoginServer}/loom-health-cp:${cpImageTag}'
    acrLoginServer: cpAcrLoginServer
    acrName: cpAcrName
    acrResourceGroup: cpAcrResourceGroup
    audiences: cpAudiences
    allowedCallerAppIds: controlPlaneConfig.?allowedCallerAppIds ?? []
    environmentId: cpEnvironmentId
    aksClusterName: cpPlatform == 'aks' ? healthStamp!.outputs.stamp.aksClusterName : ''
    aksOidcIssuerUrl: cpPlatform == 'aks' ? healthStamp!.outputs.stamp.aksOidcIssuerUrl : ''
    privateEndpointSubnetId: cpCosmosPeSubnetId
    cosmosPrivateDnsZoneId: cpCosmosZoneId
    keyVaultId: healthStamp!.outputs.stamp.keyVaultId
    tlsFqdn: cpIssuesIngressCert ? cpIngressFqdn : ''
    tlsVaultUrl: healthStamp!.outputs.stamp.keyVaultUri
    authIssuerUrl: cpAuthIssuerUrl
    authFhirBaseUrl: cpAuthFhirBaseUrl
    authAsClientId: cpAuthAsClientId
    authGraphConsentUrl: string(controlPlaneConfig.?authGraphConsentUrl ?? '')
    authSigningKeyId: string(controlPlaneConfig.?authSigningKeyId ?? '')
    skipRoleGrants: skipRoleGrants
    // #5377: the control plane registers this stamp itself. The id and region are the stamp resource
    // group's (rg-csa-loom-health-<id>-<region>); the dev profile registers as class S.
    stampId: healthStampName
    stampRegion: healthLocation
    stampClass: toUpper(string(healthConfig.?profile ?? 'dev')) == 'DEV' ? 'S' : toUpper(string(healthConfig.?profile ?? 'dev'))
    stampBaseUrl: empty(cpIngressFqdn) ? '' : 'https://${cpIngressFqdn}'
    // #5422: the in-cluster PDP address the control plane writes into tenant engine config. It is computed from inputs
    // (pdpName/pdpNamespace), not read from the healthPdp module, which consumes this module's principal id: reading
    // its output here would be a cycle. It is the BASE url: the engine plugin (HttpPdpClient.DECISION_PATH) appends
    // /v1/data/lhds/authz/decision itself. The full endpoint here doubled the path, OPA answered an undefined document
    // (200, no result), and every token-bearing FHIR request was a 503 (B3 probe run 45201088369).
    pdpUrl: pdpDeploy ? pdpBaseUrl : ''
    // #5422 B2d: the images the control plane's fhir-tenant.* jobs deliver, emitted only with the PDP (an engine without a
    // PDP answers 503, and main.ts registers the jobs only when both images AND the PDP url are set). The FHIR image is
    // TAG-pinned: build-fiab-images-acr-tasks.yml pushes loom-health-fhir under the same tag as loom-health-cp, so the
    // two are one release. The PG client image is DIGEST-pinned from pg-client-image.json, the file deploy-health imports.
    fhirImage: pdpDeploy ? '${cpAcrLoginServer}/loom-health-fhir:${cpImageTag}' : ''
    pgClientImage: pdpDeploy ? '${cpAcrLoginServer}/${pgClientImageSpec.acrRepository}@${pgClientImageSpec.digest}' : ''
    workspaceId: healthStamp!.outputs.stamp.lawId
    tags: tags
  }
  // The control plane issues the ingress certificate into the stamp vault on start: the hub PE must exist first.
  dependsOn: [
    healthHubVaultPe
  ]
}

// Second invocation (#5410): the origin group, origin, /auth/* route and WAF, now that the control plane FQDN exists.
module healthAuthRoute 'modules/health/afd-issuer.bicep' = if (fdIssuerDeploy) {
  name: 'lhds-afd-issuer-route-${healthStampName}'
  scope: resourceGroup(fdSubscriptionId, fdResourceGroup)
  params: {
    profileName: fdProfileName
    stampName: healthStampName
    cpFqdn: healthControlPlane!.outputs.fqdn
    caeId: cpEnvironmentId
    caeLocation: location
    tags: tags
  }
}

// ── PDP (apps/loom-health-pdp): one OPA per stamp, bundle pulled from the control plane ──
var pdpPublicKey = string(controlPlaneConfig.?pdpBundleVerificationPublicKeyPem ?? '')
var pdpCpBaseUrlOverride = string(controlPlaneConfig.?pdpControlPlaneBaseUrl ?? '')
// The condition may not read module outputs, so it is decided on inputs only. The stamp PDP can neither resolve nor
// reach the internal control plane FQDN (load-balancer egress, 0 peerings, internal environment), so the default
// bundle URL is the Front Door endpoint that serves /api/health/pdp/* (#5422); with no Front Door profile and no
// explicit override there is no URL the PDP could use, and it is NOT deployed.
var pdpUrlKnown = startsWith(pdpCpBaseUrlOverride, 'https://') || fdIssuerDeploy
var pdpDeploy = cpDeploy && !empty(pdpPublicKey) && pdpUrlKnown
// ONE place for the PDP image: tag (display) + digest (what is deployed and what deploy-health imports). #5422 decision 8.
var pdpImageSpec = loadJsonContent('modules/health/pdp-image.json')
// Same for the PG client image the FHIR engine's role job runs (B2d): digest deployed AND imported by deploy-health.
var pgClientImageSpec = loadJsonContent('modules/health/pg-client-image.json')
var pdpName = 'loom-health-pdp'
var pdpNamespace = 'loom-health'
// The base the CP hands engines (LOOM_HEALTH_CP_PDP_URL). base + the plugin's DECISION_PATH MUST equal engines.bicep
// output decisionEndpoint (pinned by scripts/ci/__tests__/lhds-engine-delivery.test.mjs).
var pdpBaseUrl = 'http://${pdpName}.${pdpNamespace}.svc.cluster.local'
// Object id of the service principal that runs the apply (deploy-health.yml resolves it); empty = no data-role grant.
var pdpApplyPrincipalId = string(controlPlaneConfig.?pdpApplyPrincipalId ?? '')

module healthPdp 'modules/health/engines.bicep' = if (pdpDeploy) {
  name: 'lhds-pdp-${healthStampName}'
  scope: healthRg
  params: {
    name: pdpName
    aksNamespace: pdpNamespace
    applyPrincipalId: pdpApplyPrincipalId
    controlPlanePrincipalId: healthControlPlane!.outputs.identityPrincipalId
    location: healthLocation
    image: '${cpAcrLoginServer}/${pdpImageSpec.acrRepository}@${pdpImageSpec.digest}'
    acrName: cpAcrName
    acrResourceGroup: cpAcrResourceGroup
    stampId: healthStampName
    controlPlaneBaseUrl: !empty(pdpCpBaseUrlOverride) ? pdpCpBaseUrlOverride : healthAuthEndpoint!.outputs.pdpBaseUrl
    controlPlaneAudience: string(first(cpAudiences) ?? '')
    bundleVerificationPublicKeyPem: pdpPublicKey
    aksClusterName: healthStamp!.outputs.stamp.aksClusterName
    aksOidcIssuerUrl: healthStamp!.outputs.stamp.aksOidcIssuerUrl
    replicas: int(controlPlaneConfig.?pdpReplicas ?? 2)
    pgAdminClientId: healthStamp!.outputs.pgAdminIdentity.clientId
    skipRoleGrants: skipRoleGrants
    tags: tags
  }
}

// ── APIM tenant-routing fragment (W1-6) ───────────────────────────────────────
// Published from here, not from the stamp ingress: the fragment needs the control plane's
// base URL, and the control plane deploys AFTER the stamp (it consumes the stamp's cluster
// and workspace), so the stamp cannot hold it without a cycle. controlPlaneConfig.apim keys:
//   serviceName (EXISTING APIM service; empty = fragment not published, REQUIRED to enable),
//   resourceGroup + subscriptionId (default: the stamp group / this subscription),
//   authServerIssuer (REQUIRED: public https issuer URL of the LHDS authorization server; it gates a
//     module condition, which cannot read the stamp-derived issuer, so it is not defaulted - W1-6 routing gap #5149),
//   controlPlaneBaseUrl (https; default https://<fqdn> on containerApps, required on aks),
//   defaultRequestsPerMinute (default 600).
// The openid-config URL is derived as {issuer}/.well-known/openid-configuration: a
// TENANT-INDEPENDENT document. The per-tenant {issuer}/{tenant}/.well-known/smart-configuration
// needs a tenant slug in the URL, which a gateway-wide validate-jwt cannot supply.
var apimCfg = controlPlaneConfig.?apim ?? {}
var apimServiceName = string(apimCfg.?serviceName ?? '')
var apimSubscriptionId = string(apimCfg.?subscriptionId ?? subscription().subscriptionId)
var apimResourceGroup = string(apimCfg.?resourceGroup ?? 'rg-csa-loom-health-${healthStampName}-${healthLocation}')
var apimIssuerRaw = string(apimCfg.?authServerIssuer ?? '')
// Bicep replace() is literal, not a regex: trim one trailing slash explicitly.
var apimIssuer = endsWith(apimIssuerRaw, '/') ? take(apimIssuerRaw, max(length(apimIssuerRaw) - 1, 0)) : apimIssuerRaw
var apimCpBaseOverride = string(apimCfg.?controlPlaneBaseUrl ?? '')
var apimUrlKnown = startsWith(apimCpBaseOverride, 'https://') || cpPlatform == 'containerApps'
var apimDeploy = cpDeploy && !empty(apimServiceName) && startsWith(apimIssuer, 'https://') && apimUrlKnown
var apimSkipReason = empty(apimServiceName) ? 'controlPlaneConfig.apim.serviceName is empty' : (!cpDeploy ? 'control plane not deployed' : (!startsWith(apimIssuer, 'https://') ? 'controlPlaneConfig.apim.authServerIssuer must be an https URL' : 'controlPlaneConfig.apim.controlPlaneBaseUrl must be an https URL (required on the aks control-plane path)'))

module healthApimFragment 'modules/health/apim-fragment.bicep' = if (apimDeploy) {
  name: 'lhds-apim-fragment-${healthStampName}'
  scope: resourceGroup(apimSubscriptionId, apimResourceGroup)
  params: {
    apimServiceName: apimServiceName
    authServerOpenIdConfigUrl: '${apimIssuer}/.well-known/openid-configuration'
    authServerIssuer: apimIssuer
    controlPlaneBaseUrl: !empty(apimCpBaseOverride) ? apimCpBaseOverride : 'https://${healthControlPlane!.outputs.fqdn}'
    controlPlaneAudience: string(first(cpAudiences) ?? '')
    defaultRequestsPerMinute: int(apimCfg.?defaultRequestsPerMinute ?? 600)
  }
}

module healthApimAccess 'modules/health/apim-access.bicep' = if (apimDeploy) {
  name: 'lhds-apim-access-${healthStampName}'
  scope: healthRg
  params: {
    apimServiceName: apimServiceName
    apimResourceGroupName: apimResourceGroup
    apimSubscriptionId: apimSubscriptionId
    platform: cpPlatform
    aksClusterName: cpPlatform == 'aks' ? healthStamp!.outputs.stamp.aksClusterName : ''
    skipRoleGrants: skipRoleGrants
  }
  dependsOn: [
    healthControlPlane
  ]
}

@description('APIM fragment state. deployed:true with the fragment name, or deployed:false with the precondition that was missing.')
output healthApimState object = apimDeploy ? {
  deployed: true
  fragmentName: healthApimFragment!.outputs.fragmentName
  openIdConfigUrl: '${apimIssuer}/.well-known/openid-configuration'
} : {
  deployed: false
  reason: apimSkipReason
}

@description('PDP state. deployed:true with the in-cluster decision endpoint and identity, or deployed:false with the precondition that was missing.')
output healthPdpState object = pdpDeploy ? {
  deployed: true
  decisionEndpoint: healthPdp!.outputs.decisionEndpoint
  identityPrincipalId: healthPdp!.outputs.identityPrincipalId
  // Applied by deploy-health.yml through scripts/csa-loom/aks-apply-manifest.sh. No private material.
  manifest: healthPdp!.outputs.manifest
  namespace: healthPdp!.outputs.namespace
  deploymentName: healthPdp!.outputs.deploymentName
  aksClusterName: healthStamp!.outputs.stamp.aksClusterName
  resourceGroup: healthRg.name
} : {
  deployed: false
  reason: !cpDeploy ? 'control plane not deployed' : (empty(pdpPublicKey) ? 'controlPlaneConfig.pdpBundleVerificationPublicKeyPem is empty' : 'no URL the stamp can pull bundles from: set controlPlaneConfig.frontDoor (default; serves /api/health/pdp/*) or controlPlaneConfig.pdpControlPlaneBaseUrl (https)')
}

@description('LHDS stamp manifest (resource ids, endpoints, region, profile). Empty while healthEnabled is false.')
output healthStamp object = healthDeploy ? healthStamp!.outputs.stamp : {}

@description('Issuer edge state (#5410). viaFrontDoor:true with the issuer URL and the Front Door host, or viaFrontDoor:false with the gap stated. Never reports a reachable issuer it did not deploy.')
output healthIssuerState object = fdIssuerDeploy ? {
  viaFrontDoor: true
  issuerUrl: cpAuthIssuerUrl
  frontDoorEndpointHost: healthAuthRoute!.outputs.endpointHostName
  routePatterns: ['/auth/*']
  wafAttached: healthAuthRoute!.outputs.wafAttached
  privateLinkApproval: 'not done by ARM: deploy-health.yml approves the Pending connection on the environment'
} : {
  viaFrontDoor: false
  issuerUrl: cpAuthIssuerUrl
  reason: !cpDeploy ? 'control plane not deployed' : (cpPlatform != 'containerApps' ? 'control plane runs on aks: the issuer is not served through Front Door' : 'controlPlaneConfig.frontDoor.profileName is empty: no Front Door profile on this boundary, so the issuer URL has no path to the control plane (supported-in-code, follow-up)')
}

@description('Control-plane state. deployed:true with the platform and endpoints, or deployed:false with the specific precondition that was missing. Never reports deployed over a skipped module.')
output healthControlPlaneState object = cpDeploy ? {
  deployed: true
  platform: cpPlatform
  fqdn: healthControlPlane!.outputs.fqdn
  cosmosAccountName: healthControlPlane!.outputs.cosmosAccountName
  cosmosNetworkPosture: healthControlPlane!.outputs.cosmosNetworkPosture
  identityClientId: healthControlPlane!.outputs.identityClientId
  authServerMissing: cpAuthMissing
  authFederatedCredential: healthControlPlane!.outputs.authFederatedCredential
} : {
  deployed: false
  platform: cpPlatform
  reason: cpSkipReason
}
