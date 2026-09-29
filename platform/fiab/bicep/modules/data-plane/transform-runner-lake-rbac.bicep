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

// Deterministic guid over (scope, principal, role): a redeploy by THIS template
// re-submits the SAME assignment NAME, so it is idempotent. That is the whole of
// what the deterministic name buys, and the sentence that used to follow it here
// claimed more than that (#4387).
//
// WHAT THE RETRACTED CLAIM SAID, AND WHY IT IS FALSE. Until 2026-09-28 this note
// also asserted that the deterministic guid "collapses onto an equivalent grant
// already made for this pair elsewhere rather than erroring on a duplicate", and
// concluded that on the live Commercial estate this module is "a confirming
// no-op". Both halves are wrong, and the second is the dangerous one: it reads as
// a safety guarantee on exactly the estate where it does not hold.
//
// ARM enforces uniqueness on the (scope, principalId, roleDefinitionId) TUPLE,
// not on the assignment NAME. A second assignment for a tuple that already has
// one fails with RoleAssignmentExists even under a different name. guid()
// idempotency therefore requires the EXISTING assignment to carry the SAME name,
// which is true only when this template created it — an out-of-band
// `az role assignment create` mints a RANDOM name and permanently occupies the
// tuple. This is a Microsoft.Authorization property, so it does not vary by the
// resource provider that owns the scope.
//
// MEASURED IN THIS REPO, both boundaries, cited by SYMBOL because line numbers
// rot. Neither receipt is this module's own role or scope — they are the same
// ARM constraint observed elsewhere, and that is stated rather than glossed:
//   * admin-plane/swa-publish-rbac.bicep's header — COMMERCIAL centralus
//     2026-08-07, runs 31194622139 / 31196922481. A hand-made assignment created
//     2026-07-07 (`az role assignment create`, random name) held the triple, and
//     that module's deterministic guid() name "could never be created beside it".
//   * the same file's `sovereignRedundant` note — usgovvirginia 2026-07-10
//     round 2, RoleAssignmentExists, which is why GCC-High / IL5 skip the
//     assignment outright.
//   * main.bicep's `adminAppResourcesRbac` gating note — the app-resources leaf
//     "failed RoleAssignmentExists on EVERY deploy in BOTH topologies; it only
//     ever 'worked' because the grant was created imperatively".
//
// WHAT THAT MEANS HERE, CONCRETELY. This module's tuple is (the DLZ lake account,
// the Console UAMI, Storage Blob Data Contributor). data-plane/dlz-lake-grant-pass
// .bicep records that EXACT tuple as already assigned out-of-band on the live
// Commercial lake — created 2026-06-18, measured 2026-08-13 — and refuses #3338
// on precisely that ground: re-creating it under a guid()-derived name would fail
// the whole deployment. So on that estate this module is NOT a confirming no-op;
// it is the same hazard that file exists to avoid.
//
// WHY IT HAS NOT FIRED YET. The caller gates this on `loomStorageGrantable`
// (= lake bound AND same-subscription), which is false on every cross-sub estate,
// and the live Commercial estate carrying that out-of-band grant is cross-sub. A
// SAME-SUB estate holding an equivalent Console-UAMI grant on its lake would hit
// it. Per the caller's note this grant also has no consumer yet — nothing in
// apps/loom-transform-runner writes to ADLS — so it is kept, not armed harder.
//
// NOT ESTABLISHED, and deliberately not asserted: no one has run the isolated
// experiment #4387 describes (imperative grant, then a guid()-named bicep grant
// for the same tuple, in a scratch RG) against this role and this scope. The
// receipts above are what the repo has observed; this note claims only those.
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
