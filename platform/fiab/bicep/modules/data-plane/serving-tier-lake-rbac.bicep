// CSA Loom — least-privilege lake grant for the READ-ONLY serving tiers
// (N2b/N3 loom-duckdb + N1 iceberg-catalog).
//
// Grants **Storage Blob Data Reader** — and nothing else — on the ADLS Gen2
// account both tiers read, to the identity they run as.
//
//   * loom-duckdb      reads Delta / Iceberg / Parquet IN PLACE to answer
//                      queries. app/sqlguard.py refuses every write verb, and
//                      READER makes that structural rather than advisory.
//   * iceberg-catalog  reads table metadata + data files to answer catalog
//                      requests and vend scoped credentials. Loom's Spark jobs
//                      own the writes, so it never needs more than READ.
//
// Both modules said exactly that in their own headers before this module
// existed. The role is preserved verbatim — the point of moving the grant is
// the SCOPE, not the privilege, and nobody is silently upgraded to Contributor.
//
// WHY IT IS A SEPARATE MODULE — the same reason spelled out in
// s3-gateway-lake-rbac.bicep and transform-runner-lake-rbac.bicep: the lake
// almost never lives in the admin RG.
//   * single-sub  — the lake is in the DLZ RG (`loomDlzRg`), same subscription.
//   * dlz-attach  — the lake is in a DIFFERENT SUBSCRIPTION entirely.
// A `resource … existing` declared inside the APP module resolves in the app's
// own resource group, so on any real estate it fails with ResourceNotFound.
// That is not hypothetical: transform-runner-aca.bicep declared exactly such a
// reference and failed two full Commercial deploys on 2026-08-13 the moment the
// runner was activated (#3333, fixed by #3329). duckdb-aca.bicep and
// iceberg-catalog-aca.bicep carried the identical shape, dormant only because
// every call site passed `assignLakeRole: false` — one boolean from the same
// outage (#3357). The dereference is gone from both; the grant lives here, and
// the orchestrator — the only place that knows the lake's coordinates —
// invokes this with an explicit `scope: resourceGroup(<lakeRg>)`.
//
// ONE MODULE, ONE INVOCATION, BOTH TIERS. Both apps run as the SAME identity
// (the Console UAMI) and need the SAME role on the SAME account, so the
// role-assignment name — `guid(lake.id, principalId, readerRoleId)` — is
// IDENTICAL for both. Two per-app invocations would race to PUT the same
// assignment. The orchestrator therefore calls this once, gated on either tier
// being active.
//
// TODAY THIS IS A CONFIRMING NO-OP, BY DESIGN. On every current topology the
// Console UAMI already holds Storage Blob Data Contributor on this account via
// `azureConnectionsRbac` (admin-plane/azure-connections-rbac.bicep), which
// subsumes Reader — so the two tiers work with or without this module. It
// exists so the requirement is DECLARED rather than inherited by luck: if that
// blanket Contributor grant is ever narrowed toward least privilege, or these
// tiers move to dedicated identities, the read access they actually need is
// already stated at the right scope and survives the change.

targetScope = 'resourceGroup'

@description('ADLS Gen2 account the serving tiers read. MUST exist in THIS module\'s resource group / subscription — the caller supplies that via `scope:`.')
param storageAccountName string

@description('PRINCIPAL (object) id of the identity the serving tiers run as. Today that is the Console UAMI; a future dedicated serving identity drops in here unchanged.')
param principalId string

@description('Set false to skip the grant when an estate assigns lake roles out-of-band (a PIM-managed grant process). The tiers then serve 403s on lake-backed reads until that grant lands — fail-closed, by design, never a silent downgrade.')
param assignRole bool = true

// Storage Blob Data Reader — READ only. The built-in role id is cloud-invariant,
// so the same guid resolves in Commercial and in every Gov boundary.
var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

var active = assignRole && !empty(storageAccountName) && !empty(principalId)

resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = if (active) {
  name: empty(storageAccountName) ? 'placeholderaccount' : storageAccountName
}

// Deterministic guid over (scope, principal, role): a redeploy is idempotent and
// collapses onto the SAME assignment, and it also collapses onto an equivalent
// grant already made for this pair elsewhere rather than erroring on a duplicate.
resource lakeReadRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (active) {
  name: guid(lake.id, principalId, storageBlobDataReaderRoleId)
  scope: lake
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

@description('TRUE when the Storage Blob Data Reader grant was actually applied.')
output granted bool = active

@description('Role the serving-tier identity holds on the lake. READER — never Contributor.')
output roleDefinitionId string = storageBlobDataReaderRoleId
