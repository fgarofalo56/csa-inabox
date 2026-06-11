// CSA Loom — Setup Orchestrator subscription-scoped RBAC
//
// The Setup Orchestrator Container App (setup-orchestrator.bicep) runs
// `az deployment sub create` for the Setup Wizard. To deploy a Data Landing
// Zone into a subscription, its identity must hold Contributor at that
// SUBSCRIPTION scope — for multi-sub rollouts that means Contributor on EVERY
// target spoke subscription, not just the Admin Plane hub. Per Microsoft Learn
// (bicep/deploy-to-subscription#deployment-scopes) "the principal deploying the
// parent Bicep file must have the necessary permissions to initiate deployments
// at those scopes."
//
// Instantiate this module once per target subscription in main.bicep:
//   - the Admin Plane subscription (always), and
//   - each element of dlzSubscriptionIds (multi-sub mode), via
//     `scope: subscription(dlzSubscriptionIds[i])`.
//
// Split into its own subscription-scoped module so the orchestrator principalId
// — a module OUTPUT in main.bicep — arrives as a start-time-known param here
// (avoids BCP177), mirroring monitoring-reader-rbac.bicep / rti-hub-rbac.bicep.

targetScope = 'subscription'

@description('Setup Orchestrator UAMI principalId — granted Contributor so it can run az deployment sub create at this subscription scope. Empty skips the grant.')
param orchestratorPrincipalId string

@description('When true, skip the role grant (re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Contributor — b24988ac-6180-42a0-ab88-20f7382dd24c
resource orchestratorContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(orchestratorPrincipalId) && !skipRoleGrants) {
  name: guid(subscription().id, orchestratorPrincipalId, 'setup-orchestrator-contributor')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
    principalId: orchestratorPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Setup Orchestrator: run az deployment sub create (DLZ provisioning) at this subscription scope.'
  }
}
