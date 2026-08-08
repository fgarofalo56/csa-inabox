// Resource-group-scoped role assignment — Government deployment module.
//
// WHY THIS MODULE EXISTS (deploy-gov compile break, FINISHLINE G3)
// ---------------------------------------------------------------
// `deploy/bicep/gov/main.bicep` targetScope is 'subscription'. It previously
// declared three `Microsoft.Authorization/roleAssignments` resources INLINE
// with `scope: rgData`, naming each one
// `guid(rgData.id, <module>.outputs.principalId, <roleId>)`.
//
// That construction cannot compile, for two independent reasons, and the
// template therefore never built once — which is exactly why deploy-gov.yml
// had never had a green run:
//
//   BCP139  A resource's scope must match the scope of the Bicep file. A
//           subscription-scoped file cannot declare a resource-group-scoped
//           resource directly; crossing a scope requires a MODULE.
//   BCP120  A roleAssignment `name` must be computable at the START of the
//           deployment. `<module>.outputs.principalId` is only known once that
//           module has finished, so the name is not resolvable up front.
//
// Deploying the assignment from inside an RG-scoped module fixes both: the
// module carries the scope (BCP139), and `principalId` arrives as a PARAMETER,
// which is known when this module begins (BCP120).
//
// Idempotence: the name is a deterministic guid() over
// (resourceGroup id, principalId, roleDefinitionId) — the standard triple — so
// re-deploying reconciles the same assignment instead of creating a duplicate
// or failing on RoleAssignmentExists.

targetScope = 'resourceGroup'

@description('Object id of the principal receiving the role (a managed identity principalId).')
param principalId string

@description('Role definition GUID (not the full resource id) to grant at this resource group.')
param roleDefinitionId string

@description('Principal type. ServicePrincipal covers managed identities and is required so ARM does not have to resolve a not-yet-replicated principal.')
@allowed(['ServicePrincipal', 'User', 'Group'])
param principalType string = 'ServicePrincipal'

@description('Human-readable reason this grant exists — surfaced in the portal and in audit exports.')
param roleDescription string = ''

resource assignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  // Deterministic across redeploys: same principal + same role + same RG
  // always yields the same assignment name, so this is a reconcile.
  name: guid(resourceGroup().id, principalId, roleDefinitionId)
  properties: {
    principalId: principalId
    principalType: principalType
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleDefinitionId)
    description: roleDescription
  }
}

@description('Resource id of the created (or reconciled) role assignment.')
output assignmentId string = assignment.id
