// CSA Loom — admin-plane/uat-results-storage.bicep  (V1 synthetic-monitor store)
//
// The blob store the V1 synthetic-journey monitor and the in-VNet UAT runner
// write run artifacts to, and the Health & Reliability hub's Journeys tab reads
// back. It lives in the ADMIN RG and is created BY THIS MODULE — account,
// blob service, the `uat-results` CONTAINER, and its 30-day lifecycle rule.
//
// WHY THIS MODULE EXISTS (round-2 fix, PR #2641)
// ----------------------------------------------
// LOOM_UAT_RESULTS_ACCOUNT used to be wired from `loomStorageAccount` — the DLZ
// lake account. That account is EMPTY on every shipped parameter file, because
// all of them pin `topology = 'tenant'` and main.bicep only derives a DLZ
// account name when `useSingleDlz` (i.e. topology == 'single-sub'). So on the
// canonical push-button install the env var was blank, the `uat-results`
// container was never created (landing-zone/storage.bicep is not deployed in
// tenant topology at all), and the svc-synthetic-monitor gate was RED on every
// from-scratch deploy in BOTH clouds.
//
// A dedicated admin-plane account fixes that at the root: the admin plane
// deploys in EVERY topology except dlz-attach (where the admin plane already
// exists), so the store — and the container — exist unconditionally. Nothing
// about the results path depends on whether a landing zone was deployed.
//
// COST — the honest figure, not a rounded-to-zero one:
//   * storage itself: a Standard_LRS StorageV2 account holding NDJSON verdicts
//     + PNG screenshots, aged out at 30 days by the in-module lifecycle rule.
//     At the default */15 cadence that is single-digit GB steady-state —
//     cents/month. It is NOT a second lake.
//   * the blob PRIVATE ENDPOINT below is the real line item: an Azure Private
//     Endpoint bills per hour whether or not anything talks to it — on the
//     order of $7-8/month per endpoint per cloud, plus per-GB data processing.
//     That is the price of publicNetworkAccess=Disabled, and it is charged
//     even while the synthetic runner is blocked by Conditional Access.
//     Pass privateEndpointSubnetId='' to skip it (and then reach the account
//     another way) if that trade is not worth it in a given estate.
//
// SECURITY POSTURE
//   - publicNetworkAccess Disabled + a blob PRIVATE ENDPOINT on the hub's
//     privatelink.blob.<storage suffix> zone. The Console and the scheduled job
//     both run in the CAE's VNet, so they reach it privately; nothing else can.
//   - allowSharedKeyAccess FALSE. Both writers (e2e/run-uat-unattended.mjs) and
//     the reader (lib/admin/synthetic-runs-reader.ts) authenticate with the
//     Console UAMI's managed-identity token — there is no key to leak, and no
//     key path to fall back to.
//   - The single role grant is Storage Blob Data Contributor for the Console
//     UAMI, scoped to THIS account only (the job writes, the console reads).
//     It is created in the admin RG where the account lives, so there is no
//     cross-RG assignment to get wrong.
//
// Azure-native only. No Microsoft Fabric / OneLake dependency on any path
// (.claude/rules/no-fabric-dependency.md).
//
// ── Rollback ───────────────────────────────────────────────────────────────
// Disable with observabilityConfig.syntheticMonitorEnabled=false and redeploy:
// the job, this store and the env vars all go away together, and the Journeys
// tab returns to its honest "not configured" state. Artifacts are ephemeral
// (30-day lifecycle) so there is no state to migrate either way.

targetScope = 'resourceGroup'

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string

@description('Blob container the UAT/synthetic runners upload run artifacts to (LOOM_UAT_RESULTS_CONTAINER).')
param containerName string = 'uat-results'

@description('Console UAMI PRINCIPAL (object) id — granted Storage Blob Data Contributor on this account (job writes + console reads). Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip the in-module role grant (estate policy grants it out-of-band, or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

@description('Private-endpoint subnet resource id (admin-plane network.bicep privateEndpointsSubnetId). Empty skips the PE — only for estates that reach the account another way.')
param privateEndpointSubnetId string = ''

@description('privatelink.blob.<storage suffix> private DNS zone resource id (admin-plane network.bicep privateDnsZoneIds.blob). Empty skips the DNS group.')
param privateDnsZoneBlobId string = ''

@description('Days before a run artifact under uat-runs/ is deleted by the lifecycle rule.')
param retentionDays int = 30

@description('Compliance/cost tags. The loom-next-level tag is unioned in.')
param complianceTags object = {}

// Deterministic per-RG name (<= 24 chars, lowercase alphanumeric).
var saName = take('sauat${uniqueString(resourceGroup().id)}', 24)

// Storage Blob Data Contributor — the job writes verdicts/screenshots, the
// console lists + reads them. Built-in role id is cloud-invariant.
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var grantConsole = !empty(consolePrincipalId) && !skipRoleGrants

// COST0 tag convention — the V1 program's resources carry the program tag so
// program-budget.bicep's tag-filtered budget sees this account's run-rate.
var tags = union(complianceTags, { 'loom-next-level': 'true' })

resource sa 'Microsoft.Storage/storageAccounts@2025-01-01' = {
  name: saName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    // Identity-only. Both the runner and the console hold managed-identity
    // tokens; disabling shared keys removes the only credential that could be
    // exfiltrated from an env var or a Key Vault secret.
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    // Reached exclusively over the blob private endpoint below.
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

resource bs 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' = {
  parent: sa
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 7 }
    containerDeleteRetentionPolicy: { enabled: true, days: 7 }
  }
}

// THE CONTAINER. This is the half the round-1 wiring was missing: pointing
// LOOM_UAT_RESULTS_CONTAINER at a name is not the same as the name existing.
resource results 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' = {
  parent: bs
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}

// Run artifacts accumulate at up to 4 runs/hr per cloud — age them out.
// Scoped to this container's uat-runs/ prefix only.
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2025-01-01' = {
  parent: sa
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'uat-results-retention'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['${containerName}/uat-runs/']
            }
            actions: {
              baseBlob: {
                delete: { daysAfterModificationGreaterThan: retentionDays }
              }
            }
          }
        }
      ]
    }
  }
}

resource consoleBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantConsole) {
  name: guid(sa.id, consolePrincipalId, storageBlobDataContributorRoleId)
  scope: sa
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource peBlob 'Microsoft.Network/privateEndpoints@2024-05-01' = if (!empty(privateEndpointSubnetId)) {
  name: 'pe-${saName}-blob'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'blob-link'
        properties: {
          privateLinkServiceId: sa.id
          groupIds: ['blob']
        }
      }
    ]
  }
}

resource peBlobDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (!empty(privateEndpointSubnetId) && !empty(privateDnsZoneBlobId)) {
  parent: peBlob
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'blob-zone', properties: { privateDnsZoneId: privateDnsZoneBlobId } }
    ]
  }
}

@description('Storage account name — LOOM_UAT_RESULTS_ACCOUNT.')
output accountName string = sa.name

@description('Results container name — LOOM_UAT_RESULTS_CONTAINER. Emitted from the container resource so the output cannot be produced without the container being created.')
output resultsContainerName string = last(split(results.name, '/'))

@description('Blob data-plane host for this account in THIS cloud (e.g. sauat….blob.core.usgovcloudapi.net) — derived per-cloud, never a hard-coded commercial suffix.')
output blobHost string = '${sa.name}.blob.${environment().suffixes.storage}'

@description('Blob endpoint suffix for this cloud (blob.core.windows.net | blob.core.usgovcloudapi.net) — passed to the runner so its uploader targets the right sovereign host.')
output blobSuffix string = 'blob.${environment().suffixes.storage}'
