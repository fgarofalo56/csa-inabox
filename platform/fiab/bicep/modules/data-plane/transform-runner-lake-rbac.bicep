// CSA Loom — lake grant for the transform runner (dbt-core / SQLMesh, N4).
//
// Grants the transform runner's identity **Storage Blob Data Contributor** on
// the ADLS Gen2 account that holds its artifacts container — the runner WRITES
// target/manifest.json, run_results.json and SQLMesh plan snapshots there so L6
// lineage and plan history outlive the ephemeral container. Contributor (not
// Reader, unlike the S3 gateway's least-privilege read grant) because writing
// those artifacts IS the point.
//
// WHY IT IS A SEPARATE MODULE — the same reason spelled out in
// s3-gateway-lake-rbac.bicep, which this is modelled on: the lake almost never
// lives in the admin RG.
//   * single-sub  — the lake is in the DLZ RG (`loomDlzRg`), same subscription.
//   * dlz-attach  — the lake is in a DIFFERENT SUBSCRIPTION entirely.
// A `resource … existing` declared inside the APP module resolves in the app's
// own resource group, so on any real estate it fails with ResourceNotFound.
//
// That is not hypothetical. transform-runner-aca.bicep declared exactly such an
// `existing` reference, and on 2026-08-13 it took down the whole Commercial
// deploy the moment the runner was activated:
//
//   transform-runner | DeploymentFailed
//     -> ResourceNotFound: Microsoft.Storage/storageAccounts/saloomdefault…
//        under resource group 'rg-csa-loom-admin-centralus' was not found
//
// …while the account was alive and healthy in rg-csa-loom-dlz-default-centralus
// in another subscription. Six of the seven lake consumers in admin-plane
// already used this scoped-module pattern; the runner was the one that did not.
// This module closes that gap, and the orchestrator — the only place that knows
// the lake's coordinates — invokes it with an explicit
// `scope: resourceGroup(<lakeRg>)`.

targetScope = 'resourceGroup'

@description('ADLS Gen2 account holding the transform artifacts container. MUST exist in THIS module\'s resource group / subscription — the caller supplies that via `scope:`.')
param storageAccountName string

@description('PRINCIPAL (object) id of the identity the transform runner runs as. Today that is the Console UAMI; a future dedicated runner identity drops in here unchanged.')
param principalId string

@description('Set false to skip the grant when an estate assigns lake roles out-of-band (a PIM-managed grant process). Artifact writes then 403 until that grant lands — fail-closed, by design, never a silent downgrade to local-only artifacts.')
param assignRole bool = true

// Storage Blob Data Contributor — the built-in role id is cloud-invariant, so
// the same guid resolves in Commercial and in every Gov boundary.
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

var active = assignRole && !empty(storageAccountName) && !empty(principalId)

resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = if (active) {
  name: empty(storageAccountName) ? 'placeholderaccount' : storageAccountName
}

// Deterministic guid over (scope, principal, role): a redeploy is idempotent and
// collapses onto the SAME assignment, and it also collapses onto an equivalent
// grant already made for this pair elsewhere rather than erroring on a duplicate.
// On the live Commercial estate the Console UAMI ALREADY holds this role on the
// lake (measured 2026-08-13), so on that estate this is a confirming no-op — the
// module exists so the grant is guaranteed rather than inherited by luck.
resource lakeWriteRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (active) {
  name: guid(lake.id, principalId, storageBlobDataContributorRoleId)
  scope: lake
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

@description('TRUE when the Storage Blob Data Contributor grant was actually applied.')
output granted bool = active

@description('Role the transform runner identity holds on the lake.')
output roleDefinitionId string = storageBlobDataContributorRoleId
