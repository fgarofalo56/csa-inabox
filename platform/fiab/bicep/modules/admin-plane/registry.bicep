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
// IF THAT STEP IS SKIPPED, THIS REGISTRY ENDS THE APPLY WITH NO COMPLIANCE TAGS
// AT ALL — including on an estate that had them a minute earlier (#4448).
//
// An earlier revision of this comment said the opposite: "this registry keeps
// whatever tags it already has (nothing in this module removes tags any more),
// so an existing estate does not lose its compliance tags". That was asserted,
// never measured, and it is FALSE. An ARM PUT writes the tag dictionary the
// template body hands it, and a body that hands it none writes NONE. Omitting
// `tags:` does not preserve a resource's tags; it clears them.
//
// MEASURED 2026-09-17 against the live Commercial estate, with the private
// endpoint below as the positive control — same module, same apply, the only
// difference being that it DOES declare `tags:`:
//
//   acrloomk6mvh5sm6z7do      (no `tags:`)  -> loomAcrFwExpiresEpoch,
//     loomAcrFwHolderUrl, loomAcrFwOwner, loomAcrFwSinceUtc. All four written
//     back AFTER the apply by the next lane to take the firewall lease. ZERO
//     compliance tags.
//   pe-acrloomk6mvh5sm6z7do   (`tags: complianceTags`) -> CSA_Loom,
//     Data_Classification, Environment, FedRAMP_Level, loom-estate-id.
//
// Two consequences, both real:
//
//   1. Compliance tags on THIS registry survive only until the next apply and
//      are restored by the post-apply step named above. If that step does not
//      run — and it does not run when an earlier step in the job has already
//      failed — the registry stays untagged until one does.
//   2. NO CROSS-LANE MUTEX MAY BE STORED ON THIS RESOURCE. The apply destroys
//      it. #4448 moved the estate image-write lease to the registry's
//      SUBSCRIPTION, which a subscription-scope deployment never PUTs. The
//      `loomAcrFw*` firewall lease in scripts/csa-loom/acr-firewall-lease.sh is
//      STILL stored here and is still erased by every apply — measured on run
//      35215007789, where build-fiab-images-acr-tasks read it as free and
//      opened the firewall 2 minutes before this lane's apply finished, with 26
//      minutes still on the claim. That is tracked separately; do not read this
//      module's lack of `tags:` as protecting it.
//
// Re-adding `tags:` here is still forbidden, for the ORIGINAL #3676/#3681
// reason and not for the one the old comment gave: a declared `tags:` would
// stamp complianceTags over a CONCURRENTLY-HELD firewall lease mid-apply and
// deny an in-flight `az acr build` push. Erasing the dictionary and replacing
// the dictionary are both fatal to a lease stored in it; only the second also
// writes a plausible-looking wrong value.
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
