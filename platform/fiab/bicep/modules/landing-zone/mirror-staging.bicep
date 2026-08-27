// ============================================================================
// mirror-staging — the interim Blob SCRATCH account a Snowflake mirror unloads
// through on its way to Bronze.
//
// THIS IS NOT A DATA STORE. Nothing reads from it, nothing is retained in it,
// and no Loom surface lists it. It holds one thing: the raw output of
// Snowflake's `COPY INTO <location>` unload, for the seconds between Snowflake
// writing it and ADF copying it into ADLS Bronze. The lifecycle rule below
// deletes everything in it after 1 day, so a blob that outlives its run is
// garbage from a failed pipeline, never state anyone depends on.
//
// WHY A SEPARATE ACCOUNT AND NOT BRONZE. Two independent reasons, either alone
// sufficient:
//   1. TYPE. `SnowflakeExportCopyCommand` delegates the unload to Snowflake,
//      and Snowflake's COPY command can only write to an Azure *Blob* endpoint.
//      ADF rejects the payload up front when the staging linked service is
//      `AzureBlobFS` (the ADLS Gen2 `dfs` endpoint) with
//      "Snowflake copy command not support Connector type as 'not Azure Blob
//      Storage'" — the exact run-time failure measured on the live estate
//      (issue #4083).
//   2. REACHABILITY. Snowflake's COPY runs in SNOWFLAKE's cloud, not in Azure,
//      so the target must be reachable from outside this VNet. Bronze is
//      deliberately `publicNetworkAccess: 'Disabled'` / `defaultAction: 'Deny'`
//      / `allowSharedKeyAccess: false`, and must STAY that way. Putting an
//      externally reachable staging path on the lake would mean unlocking the
//      lake, so the scratch traffic gets its own blast radius instead.
//
// HONEST LIMITATION (deploy-integrity.md R7). Because Snowflake must reach it,
// this account runs with public network access ENABLED. That is a real, stated
// exposure and the reason for every other control here: no shared key, no
// public blob access, TLS 1.2 floor, HTTPS only, a single container, a 1-day
// purge, and access only ever through a short-lived container-scoped
// USER-DELEGATION SAS the Console mints at run time (Entra-signed — there is no
// account key to leak, and none can be used even if the policy posture changed).
//
// The SAS itself is deliberately NOT minted here: bicep can only produce one via
// `listAccountSas`/`listServiceSas`, both of which require
// `allowSharedKeyAccess: true`, which this estate's Azure Policy denies. It is
// minted in TypeScript against the Entra user-delegation key instead — see
// `lib/azure/snowflake-adf.ts:resolveMirrorStagingLinkedService`.
//   https://learn.microsoft.com/azure/data-factory/connector-snowflake
// ============================================================================

targetScope = 'resourceGroup'

@description('Azure region for the staging account. Should match the data factory region so the unload does not cross regions.')
param location string

@description('Compliance tag bag applied to every resource in this module.')
param complianceTags object

@description('Principal id of the Console UAMI. It mints the user-delegation SAS and needs data-plane write access to clean up. Empty = skip the grant.')
param consolePrincipalId string = ''

@description('Principal id of the ADF factory managed identity. ADF reads the staged files back out of this container to land them in Bronze. Empty = skip the grant.')
param adfPrincipalId string = ''

@description('Set true on estates where the deploying identity cannot create role assignments (multi-sub / dlz-attach). The account is still created; only the grants are skipped.')
param skipRoleGrants bool = false

@description('Days before staged scratch blobs are purged. A staged unload is consumed within one pipeline run, so anything older is debris from a failed run. Kept as a param so a slow-copy estate can widen it without editing the module.')
@minValue(1)
@maxValue(7)
param stagingRetentionDays int = 1

// Deterministic, and computed the SAME way in platform/fiab/bicep/main.bicep so
// the console can be told the account name in the pass BEFORE this module runs
// (the DLZ module is deployed after admin-plane, so its outputs are not
// available to the console env block). The `'loom-mirror-staging'` salt is what
// stops this colliding with the lake's own `uniqueString(resourceGroup().id)`.
// The prefix is kept to 9 chars so the full 13-char hash survives the take(24)
// — a truncated hash is a global-namespace collision risk, not a cosmetic one.
// KEEP THE TWO EXPRESSIONS IN SYNC — see main.bicep `loomMirrorStagingAccount`.
var stagingAccountName = take('saloomstg${uniqueString(resourceGroup().id, 'loom-mirror-staging')}', 24)

// Must match STAGING_PATH_ROOT in apps/fiab-console/lib/azure/mirror-adf-copy.ts.
// ADF only auto-creates a staging container when NO path is supplied, and
// Learn rules that case out for a SAS-authed staging linked service — so this
// container has to exist before the first run, not after it.
var stagingContainerName = 'loom-mirror-staging'

var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var storageBlobDelegatorRoleId = 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'

resource sa 'Microsoft.Storage/storageAccounts@2025-01-01' = {
  name: stagingAccountName
  location: location
  tags: union(complianceTags, {
    'loom-purpose': 'snowflake-mirror-staging-scratch'
    'loom-not-a-data-store': 'true'
  })
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    accessTier: 'Hot'
    // No account key, ever. The only credential that works against this account
    // is a short-lived Entra user-delegation SAS.
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    // REQUIRED, and the one control that is deliberately open: Snowflake's COPY
    // unload originates in Snowflake's cloud and cannot reach a private
    // endpoint in this VNet. See the honest-limitation note in the header.
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource bs 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' = {
  parent: sa
  name: 'default'
  properties: {
    // Short windows: this is scratch, and a long soft-delete tail would keep
    // customer rows recoverable in a public-facing account long after the run.
    deleteRetentionPolicy: { enabled: true, days: 1 }
    containerDeleteRetentionPolicy: { enabled: true, days: 1 }
  }
}

resource stagingContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' = {
  parent: bs
  name: stagingContainerName
  properties: {
    publicAccess: 'None'
  }
}

// Staged unloads are consumed within a single pipeline run. Purge daily so a
// failed run cannot leave source rows sitting in a publicly reachable account.
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2025-01-01' = {
  parent: sa
  name: 'default'
  dependsOn: [stagingContainer]
  properties: {
    policy: {
      rules: [
        {
          name: 'purge-mirror-staging-scratch'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['${stagingContainerName}/']
            }
            actions: {
              baseBlob: {
                delete: { daysAfterModificationGreaterThan: stagingRetentionDays }
              }
            }
          }
        }
      ]
    }
  }
}

// The Console mints the SAS (Delegator) and manages the container's contents
// (Data Contributor). Both are needed: getUserDelegationKey is an account-scope
// operation that Data Contributor alone does not confer.
resource consoleBlobDelegator 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(sa.id, consolePrincipalId, storageBlobDelegatorRoleId)
  scope: sa
  properties: {
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDelegatorRoleId)
    description: 'Console UAMI — getUserDelegationKey to mint the short-lived staging SAS for Snowflake mirror unloads (#4083).'
  }
}

resource consoleBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(sa.id, consolePrincipalId, storageBlobDataContributorRoleId)
  scope: sa
  properties: {
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    description: 'Console UAMI — manage staged Snowflake unload scratch in the mirror staging container.'
  }
}

// ADF reads the staged files back out to land them in Bronze. Without this the
// staged copy fails on the SECOND leg, after Snowflake has already written.
resource adfBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(adfPrincipalId) && !skipRoleGrants) {
  name: guid(sa.id, adfPrincipalId, storageBlobDataContributorRoleId)
  scope: sa
  properties: {
    principalId: adfPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    description: 'ADF factory MSI — read staged Snowflake unloads and copy them into ADLS Bronze (#4083).'
  }
}

output stagingAccountName string = sa.name
output stagingContainerName string = stagingContainerName
output stagingBlobEndpoint string = sa.properties.primaryEndpoints.blob
