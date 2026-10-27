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
//   pdpBundleVerificationPublicKeyPem (PUBLIC key; the per-stamp OPA PDP deploys only when
//     this is set and the control plane deploys), pdpImageTag (default 1.9.0-static, image
//     <acr>/opa), pdpControlPlaneBaseUrl (https; default https://<fqdn> on containerApps,
//     required on aks), pdpReplicas (default 2),
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
    extraAllowedFqdns: healthConfig.?extraAllowedFqdns ?? []
    extraDnsLinkVnetIds: healthConfig.?extraDnsLinkVnetIds ?? []
    tlsCertificateSecretUri: string(healthConfig.?tlsCertificateSecretUri ?? '')
    auditRetentionDays: int(healthConfig.?auditRetentionDays ?? 2190)
    logRetentionDays: int(healthConfig.?logRetentionDays ?? 90)
    tags: tags
  }
}

// ── Control plane (apps/loom-health-cp) ───────────────────────────────────────
var cpPlatformRaw = toLower(string(controlPlaneConfig.?controlPlane ?? (effectiveBoundary == 'IL5' ? 'aks' : 'containerApps')))
var cpValidPlatform = contains(['containerApps', 'aks'], cpPlatformRaw)
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
var cpSkipReason = !healthEnabled ? 'healthEnabled is false' : (!healthPgAllowed ? 'stamp not deployed: PostgreSQL unavailable in this region (healthConfig.postgres)' : (empty(cpAudiences) ? 'controlPlaneConfig.audiences is empty: the service refuses to start without an accepted token audience' : (!cpValidPlatform ? 'controlPlaneConfig.controlPlane must be containerApps or aks, got ${cpPlatformRaw}' : (!cpAcrKnown ? 'controlPlaneConfig needs acrName, acrLoginServer and acrResourceGroup' : (!cpHostable ? 'containerApps path needs controlPlaneConfig.environmentId; set controlPlane=aks to use the stamp cluster' : '')))))

module healthControlPlane 'modules/health/control-plane.bicep' = if (cpDeploy) {
  name: 'lhds-control-plane-${healthStampName}'
  scope: healthRg
  params: {
    location: cpPlatform == 'aks' ? healthLocation : location
    boundary: effectiveBoundary
    platform: cpPlatform
    image: '${cpAcrLoginServer}/loom-health-cp:${string(controlPlaneConfig.?imageTag ?? 'v0.1')}'
    acrLoginServer: cpAcrLoginServer
    acrName: cpAcrName
    acrResourceGroup: cpAcrResourceGroup
    audiences: cpAudiences
    allowedCallerAppIds: controlPlaneConfig.?allowedCallerAppIds ?? []
    environmentId: cpEnvironmentId
    aksClusterName: cpPlatform == 'aks' ? healthStamp!.outputs.stamp.aksClusterName : ''
    aksOidcIssuerUrl: cpPlatform == 'aks' ? healthStamp!.outputs.stamp.aksOidcIssuerUrl : ''
    privateEndpointSubnetId: string(controlPlaneConfig.?privateEndpointSubnetId ?? '')
    cosmosPrivateDnsZoneId: string(controlPlaneConfig.?cosmosPrivateDnsZoneId ?? '')
    keyVaultId: healthStamp!.outputs.stamp.keyVaultId
    skipRoleGrants: skipRoleGrants
    workspaceId: healthStamp!.outputs.stamp.lawId
    tags: tags
  }
}

// ── PDP (apps/loom-health-pdp): one OPA per stamp, bundle pulled from the control plane ──
var pdpPublicKey = string(controlPlaneConfig.?pdpBundleVerificationPublicKeyPem ?? '')
var pdpCpBaseUrlOverride = string(controlPlaneConfig.?pdpControlPlaneBaseUrl ?? '')
// The condition may not read module outputs, so the containerApps default is decided on inputs only.
var pdpUrlKnown = startsWith(pdpCpBaseUrlOverride, 'https://') || cpPlatform == 'containerApps'
var pdpDeploy = cpDeploy && !empty(pdpPublicKey) && pdpUrlKnown

module healthPdp 'modules/health/engines.bicep' = if (pdpDeploy) {
  name: 'lhds-pdp-${healthStampName}'
  scope: healthRg
  params: {
    location: healthLocation
    image: '${cpAcrLoginServer}/opa:${string(controlPlaneConfig.?pdpImageTag ?? '1.9.0-static')}'
    acrName: cpAcrName
    acrResourceGroup: cpAcrResourceGroup
    stampId: healthStampName
    controlPlaneBaseUrl: !empty(pdpCpBaseUrlOverride) ? pdpCpBaseUrlOverride : 'https://${healthControlPlane!.outputs.fqdn}'
    controlPlaneAudience: string(first(cpAudiences) ?? '')
    bundleVerificationPublicKeyPem: pdpPublicKey
    aksClusterName: healthStamp!.outputs.stamp.aksClusterName
    aksOidcIssuerUrl: healthStamp!.outputs.stamp.aksOidcIssuerUrl
    replicas: int(controlPlaneConfig.?pdpReplicas ?? 2)
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
//   authServerIssuer (REQUIRED: public https issuer URL of the LHDS authorization server),
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
} : {
  deployed: false
  reason: !cpDeploy ? 'control plane not deployed' : (empty(pdpPublicKey) ? 'controlPlaneConfig.pdpBundleVerificationPublicKeyPem is empty' : 'controlPlaneConfig.pdpControlPlaneBaseUrl must be an https URL (required on the aks control-plane path)')
}

@description('LHDS stamp manifest (resource ids, endpoints, region, profile). Empty while healthEnabled is false.')
output healthStamp object = healthDeploy ? healthStamp!.outputs.stamp : {}

@description('Control-plane state. deployed:true with the platform and endpoints, or deployed:false with the specific precondition that was missing. Never reports deployed over a skipped module.')
output healthControlPlaneState object = cpDeploy ? {
  deployed: true
  platform: cpPlatform
  fqdn: healthControlPlane!.outputs.fqdn
  cosmosAccountName: healthControlPlane!.outputs.cosmosAccountName
  cosmosNetworkPosture: healthControlPlane!.outputs.cosmosNetworkPosture
  identityClientId: healthControlPlane!.outputs.identityClientId
} : {
  deployed: false
  platform: cpPlatform
  reason: cpSkipReason
}
