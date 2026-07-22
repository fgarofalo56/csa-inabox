// CSA Loom — Managed Identity Contributor for the Console UAMI on the
// workspace-identity resource group (loom-next-level I1).
//
// Why: the runtime provision-on-create path (lib/azure/workspace-identity-client
// createWorkspaceUami / deleteWorkspaceUami) PUTs and DELETEs
// Microsoft.ManagedIdentity/userAssignedIdentities (uami-ws-<workspaceId>) in
// the RG named by LOOM_WS_IDENTITY_RG (falling back to LOOM_DLZ_RG). The
// Console UAMI's existing grants do not include
// Microsoft.ManagedIdentity/userAssignedIdentities/write on that RG, so
// without this module every shadow-mode provision records an honest 403 in the
// workspace doc's workspaceIdentity status block. "Managed Identity
// Contributor" (e40ec5ca-96e0-45a2-b4ff-59039f2c2b59) is the narrowest
// built-in role that covers create/read/delete of UAMIs (it deliberately
// CANNOT assign identities to compute or write role assignments — the lake
// role-assignment PUTs ride the separate constrained RBAC-Administrator from
// landing-zone/storage-rbac-admin.bicep).
//
// Shape mirrors monitoring-reader-rbac.bicep: principalId arrives as a plain
// start-time-known param (avoids BCP177 on the role-assignment name/if), the
// grant is guarded by !empty(consolePrincipalId) && !skipRoleGrants, and the
// guid() name makes re-deploys idempotent. RG-scoped (the tightest scope that
// covers per-workspace UAMI CRUD).
//
// Sovereign clouds: Microsoft.ManagedIdentity + built-in role GUIDs are GA and
// cloud-invariant across Commercial / GCC-High / IL5 — only the ARM endpoint
// differs, which the deployment cloud handles, not this template.
//
// Rollback: remove the module invocation from main.bicep (or set
// skipRoleGrants=true) and delete the assignment:
//   az role assignment delete --assignee <console-uami-principalId> \
//     --role e40ec5ca-96e0-45a2-b4ff-59039f2c2b59 --resource-group <ws-identity-rg>
// Runtime degrades honestly: provisioning records ARM 403 in workspaceIdentity
// (never blocks workspace create), and mode=off disables the path entirely.

targetScope = 'resourceGroup'

@description('Console UAMI principal (object) id — granted Managed Identity Contributor on this RG. Empty string skips the grant.')
param consolePrincipalId string

@description('When true, skip the role grant (re-deploy where RBAC already exists, or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Managed Identity Contributor — e40ec5ca-96e0-45a2-b4ff-59039f2c2b59
resource consoleMiContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(resourceGroup().id, consolePrincipalId, 'mi-contributor')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'e40ec5ca-96e0-45a2-b4ff-59039f2c2b59')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}
