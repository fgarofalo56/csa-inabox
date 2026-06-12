// CSA Loom — DLZ-attach item-create RBAC grant (audit-t159 / domain-aware routing)
//
// Domain-aware resource routing lands each domain-scoped item-create
// (lakehouse / warehouse / eventhouse / kql-database / notebook / mirroring / …)
// in the DLZ subscription that OWNS the workspace's domain — resolved by
// apps/fiab-console/lib/azure/topology.ts → resolveDeployTarget, which reads
// the governance-domain registry's `subscriptionIds[0]` + the DLZ resource
// group `rg-csa-loom-dlz-{domain}-{location}`.
//
// Azure RBAC is ADDITIVE per scope (MS Learn: a role assignment at a resource
// group lets the principal manage resources in THAT RG only). The Console UAMI
// is created in the admin plane; in multi-sub mode the domain DLZ RG is in a
// DIFFERENT subscription, where the UAMI has no rights by default. So the
// Microsoft.Synapse / Microsoft.Kusto / Microsoft.Storage / Microsoft.EventHub /
// Microsoft.Databricks PUT that an item-create issues returns 403 unless the
// UAMI holds Contributor at that DLZ RG scope. THIS module grants exactly that.
//
// The matching honest gate lives in topology.ts (`assertItemCreateReachable` →
// `buildItemCreateGate`): when this grant is missing the console surfaces a
// MessageBar naming this module + a copy-paste `az role assignment create`
// (per no-vaporware.md — no faked success).
//
// Modeled on access-policy-rbac.bicep + workspace-rbac.bicep. Deployed at the
// DLZ resource-group scope; main.bicep invokes it per-DLZ via
// `scope: resourceGroup(subId, 'rg-csa-loom-dlz-${dlzDomainNames[i]}-${location}')`.
// Split into its own module so consolePrincipalId (a module OUTPUT in
// main.bicep) is a start-time-known param here (avoids BCP177).

targetScope = 'resourceGroup'

@description('Console UAMI principalId — granted Contributor on this domain DLZ resource group so domain-scoped item-create ARM PUTs succeed. Empty string skips the grant.')
param consolePrincipalId string

@description('When true, skip the role grant (re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Built-in Contributor role definition GUID (global across every tenant/cloud).
// Matches CONTRIBUTOR_ROLE_ID in apps/fiab-console/lib/azure/topology.ts.
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'

resource itemCreateContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  // guid() is deterministic — re-running after the grant exists is a no-op.
  name: guid(resourceGroup().id, consolePrincipalId, 'loom-itemcreate-contributor-v1')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    description: 'Loom Console UAMI: create domain-scoped items (lakehouse/warehouse/eventhouse/notebook/mirroring) in this domain DLZ resource group. Wired by audit-t159 domain-aware resource routing.'
  }
}
