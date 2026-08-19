// CSA Loom — Admin Plane ACR (Premium with private link)

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Private endpoints subnet ID')
param privateEndpointSubnetId string

@description('Private DNS zone ID for ACR')
param privateDnsZoneAcrId string

@description('Log Analytics workspace ID for diagnostic settings')
param workspaceId string

@description('Compliance tags')
param complianceTags object

var acrName = take('acrloom${uniqueString(resourceGroup().id)}', 50)

// #3681 / #3676 (parent P0) — this resource deliberately does NOT declare
// `tags:`. ARM PUTs a resource's top-level `tags` as an absolute replace on
// EVERY apply (confirmed: Microsoft Learn, "Apply tags with Bicep" — "The
// tags you apply through a Bicep file will replace any existing tags on the
// resource"), and `scripts/csa-loom/acr-firewall-lease.sh` records its
// firewall-lease mutex as out-of-band ARM tags on THIS registry
// (`loomAcrFwOwner` / `loomAcrFwExpiresEpoch` / `loomAcrFwSinceUtc` /
// `loomAcrFwHolderUrl`, merge-patched via `az tag update --operation Merge`
// so they never touch the registry body). A `tags: complianceTags` here
// silently erased those on every deploy — measured in #3676 landing mid-apply
// (~8 minutes into a ~15-minute apply) and denying an in-flight `az acr
// build` push. Compliance tags are still applied to this registry — see the
// #3714 block below `acr` for where, why it cannot be done declaratively at
// all, and what happens if that step is skipped.
resource acr 'Microsoft.ContainerRegistry/registries@2025-04-01' = {
  name: acrName
  location: location
  sku: { name: 'Premium' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Disabled'
    networkRuleBypassOptions: 'AzureServices'
    zoneRedundancy: 'Enabled'
    policies: {
      retentionPolicy: {
        status: 'enabled'
        days: 30
      }
      // quarantinePolicy + trustPolicy disabled for v1 — operator
      // enables once content-signing pipeline (Notary v2 + SBOM
      // scanning) is in place. Enabling these blocks read of any
      // unsigned/unscanned image.
      quarantinePolicy: { status: 'disabled' }
      trustPolicy: {
        type: 'Notary'
        status: 'disabled'
      }
    }
  }
}

// #3714 — COMPLIANCE TAGS FOR THIS REGISTRY ARE APPLIED OUT-OF-BAND, NOT HERE.
//
// There is deliberately NO `Microsoft.Resources/tags` resource in this module,
// and re-adding one is a P0 regression. #3691 added exactly that:
//
//   var existingAcrTags = reference(
//     extensionResourceId(acr.id, 'Microsoft.Resources/tags', 'default'), …)
//   resource acrComplianceTags 'Microsoft.Resources/tags@2021-04-01' = {
//     name: 'default'  scope: acr
//     properties: { tags: union(existingAcrTags…, complianceTags) } }
//
// `extensionResourceId(acr.id, 'Microsoft.Resources/tags', 'default')` is the
// resource id OF THE RESOURCE BEING DECLARED. ARM read it as a dependency of
// that resource on itself and refused the whole template:
//
//   InvalidTemplate → Circular dependency detected on resource:
//   …/registries/<acr>/providers/Microsoft.Resources/tags/default
//
// The cycle is STRUCTURAL, not a naming accident. `acr` is DECLARED here (not
// `existing`), so reading its live tag state inside the same deployment that
// writes it is read-then-write on one resource in one template — which ARM
// cannot order. Renaming symbols, splitting modules, or adding `dependsOn`
// does not break it; only NOT reading-and-writing the same resource does.
//
// It also could not be caught before it shipped: `az bicep build` compiles it
// (the cycle is an ARM runtime expression, not a bicep symbol cycle), and
// BOTH `az deployment sub what-if` AND `az deployment sub validate` returned
// Succeeded on it — this module reaches ARM inside the `admin-plane` nested
// deployment, which carries `expressionEvaluationOptions: {scope: 'inner'}`,
// and ARM does not expand an inner-scoped nested template during preflight.
// Only the real apply expands it. Measured 2026-08-18; run 32115429033 shows
// what-if green and Provision failing on this exact resource, and #3691 never
// completed a single successful deploy in the ~13 hours it was on main.
// `scripts/ci/check-arm-self-referential-resource.mjs` is the guard that now
// catches this class statically, since no ARM preflight will.
//
// Why not `tags: complianceTags` on the ACR above — the ORIGINAL defect
// (#3676/#3681) — is explained in the comment on that resource: ARM PUTs
// top-level `tags` as an absolute replace, which erased the `loomAcrFw*`
// firewall-lease mutex mid-apply and denied an in-flight `az acr build`.
//
// So both declarative options are ruled out, and compliance tags are applied
// the way the lease itself is written — a server-side PATCH-Merge with the
// deploy identity, after the apply:
//
//     scripts/csa-loom/apply-acr-compliance-tags.sh
//
// invoked by every deploy lane (Commercial, GCC, GCC-High, IL5, Gov) in the
// step named "Apply ACR compliance tags (merge-patch, out-of-band — #3714)".
// `az tag update --operation Merge` adds keys without rewriting the dictionary,
// so it can never clobber a concurrently-held lease — a strictly stronger
// guarantee than the read-then-write race #3691's comment openly conceded.
//
// IF THAT STEP IS SKIPPED: this registry keeps whatever tags it already has
// (nothing in this module removes tags any more), so an existing estate does
// not lose its compliance tags — but a NEWLY created registry comes up with
// NONE, and stays untagged until a deploy runs that step. That is a real,
// disclosed gap, not a silent one: the script is fail-closed and the lanes do
// not `|| true` it, so a failure to tag fails the deploy loudly.
//
// A `Microsoft.Resources/deploymentScripts` resource would also give true
// PATCH-Merge atomicity, and is deliberately NOT used: `front-door.bicep`
// removed one after `KeyBasedAuthenticationNotPermitted` (MCAPS policy denying
// `allowSharedKeyAccess` on the auto-provisioned staging storage account)
// failed the WHOLE apply on Commercial, and it was worse on GCC-High/IL5 where
// it had to be special-cased off — a cloud-parity violation. The post-deploy
// script is the shape that fix landed on, and this follows it.

resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${acrName}'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'acr-link'
        properties: {
          privateLinkServiceId: acr.id
          groupIds: ['registry']
        }
      }
    ]
  }
}

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'acr-zone'
        properties: { privateDnsZoneId: privateDnsZoneAcrId }
      }
    ]
  }
}

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: acr
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'ContainerRegistryRepositoryEvents', enabled: true }
      { category: 'ContainerRegistryLoginEvents', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output acrId string = acr.id
output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
