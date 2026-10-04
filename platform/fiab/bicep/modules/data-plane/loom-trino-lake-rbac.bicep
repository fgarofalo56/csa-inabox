// CSA Loom — least-privilege lake grant for loom-trino's federated-query read
// path (external-engine federation over the ADLS Gen2 lake).
//
// Grants **Storage Blob Data Reader** — and nothing else — on the lake's ADLS
// Gen2 account to the identity loom-trino runs as. Trino answers federated
// queries by reading Delta/Iceberg/Parquet data files directly; it never
// writes to the lake, so READER is the whole requirement, not a floor.
//
// WHY IT IS A SEPARATE MODULE, DEPLOYED INTO THE LAKE'S OWN RESOURCE GROUP —
// the same reason spelled out in serving-tier-lake-rbac.bicep,
// s3-gateway-lake-rbac.bicep and transform-runner-lake-rbac.bicep: the lake
// almost never lives in the admin RG (single-sub: the DLZ RG; dlz-attach: a
// different subscription entirely). A `resource … existing` declared inside
// loom-trino-aca.bicep would resolve in the APP's own resource group, not the
// lake's, and fail with ResourceNotFound on any real estate — exactly the
// shape #3333 broke two Commercial deploys on before the fix pattern this
// module follows was established. gov-provision-trino.yml is the only caller
// and knows the lake's real coordinates ($LAKE, $LAKE_RG); it deploys this
// module with an explicit `-g "$LAKE_RG"`, never relying on admin-plane's own
// scope.
//
// Params match gov-provision-trino.yml's deployment call exactly
// (`lakeStorageAccountName`, `trinoPrincipalId`) — do not rename either
// without updating that workflow in the same change.

targetScope = 'resourceGroup'

@description('ADLS Gen2 account loom-trino reads for federated queries. MUST exist in THIS module\'s resource group — the caller supplies that via `-g` / `scope:`.')
param lakeStorageAccountName string

@description('PRINCIPAL (object) id of the identity loom-trino runs as — the Container App\'s UAMI.')
param trinoPrincipalId string

@description('Set false to skip the grant when an estate assigns lake roles out-of-band (a PIM-managed grant process). Trino then serves without lake read access until that grant lands — fail-closed, by design, never a silent downgrade.')
param assignRole bool = true

// Storage Blob Data Reader — READ only. The built-in role id is cloud-invariant,
// so the same guid resolves in Commercial and in every Gov boundary.
var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

var active = assignRole && !empty(lakeStorageAccountName) && !empty(trinoPrincipalId)

resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = if (active) {
  name: empty(lakeStorageAccountName) ? 'placeholderaccount' : lakeStorageAccountName
}

// Deterministic guid over (scope, principal, role): a redeploy is idempotent and
// collapses onto the SAME assignment, and it also collapses onto an equivalent
// grant already made for this pair elsewhere rather than erroring on a duplicate.
resource lakeReadRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (active) {
  name: guid(lake.id, trinoPrincipalId, storageBlobDataReaderRoleId)
  scope: lake
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    principalId: trinoPrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('TRUE when the Storage Blob Data Reader grant was actually applied.')
output granted bool = active

@description('Role the loom-trino identity holds on the lake. READER — never Contributor.')
output roleDefinitionId string = storageBlobDataReaderRoleId
