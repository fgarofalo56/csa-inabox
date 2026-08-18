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
// build` push. See `acrComplianceTags` below for how compliance tags are
// still applied without that clobber.
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

// Read the registry's CURRENT tags (whatever they are right now, including
// any `loomAcrFw*` lease markers a concurrent build/roll holds) and union in
// `complianceTags`, instead of the ACR resource replacing the whole dict.
//
// This is not a server-side atomic merge — ARM's declarative
// `Microsoft.Resources/tags` resource type only supports PUT/replace, not the
// `operation: Merge` PATCH that `az tag update --operation Merge` uses — so a
// read-then-write race in principle still exists. But it shrinks that window
// from the ACR's own ~15-minute apply down to the single read+write ARM
// performs for THIS resource (low seconds), several orders of magnitude
// smaller than the defect being fixed.
//
// A `Microsoft.Resources/deploymentScripts` resource would get true
// PATCH-Merge atomicity, but that primitive is a known landmine in this repo:
// `front-door.bicep` removed one after `KeyBasedAuthenticationNotPermitted`
// (MCAPS policy denying `allowSharedKeyAccess` on the auto-provisioned
// staging storage account) failed the WHOLE apply on Commercial, and was
// worse on GCC-High/IL5 where it had to be special-cased off — a
// cloud-parity violation. Deliberately not used here; if true atomicity is
// ever required, do it the way that fix did — a post-deploy script run with
// the deploy identity (`scripts/csa-loom/...`), not a bicep deploymentScript.
// That is outside this module's ownership and is not implemented here.
var existingAcrTags = reference(extensionResourceId(acr.id, 'Microsoft.Resources/tags', 'default'), '2021-04-01', 'Full')

resource acrComplianceTags 'Microsoft.Resources/tags@2021-04-01' = {
  name: 'default'
  scope: acr
  properties: {
    tags: union(existingAcrTags.?properties.?tags ?? {}, complianceTags)
  }
}

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
