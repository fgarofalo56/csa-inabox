// CSA Loom deploy-planner — Azure Logic Apps (Consumption)
//
// Wired by the deploy-planner catalog (key: logicApps → logicAppsEnabled).
// Self-contained: a single Consumption Logic App (Microsoft.Logic/workflows)
// with an empty-but-valid workflow definition the Logic Apps designer/navigator
// can open and edit, plus a system-assigned identity. The Loom Console UAMI is
// granted Logic App Contributor so the BFF can manage the workflow over ARM.
//
// Grounded in Microsoft Learn:
//   Microsoft.Logic/workflows (Bicep) — "Create a Consumption logic app"
//   https://learn.microsoft.com/azure/templates/microsoft.logic/workflows

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Loom Console UAMI principal ID — granted Logic App Contributor so the BFF can manage the workflow. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var workflowName = take('logic-loom-${uniqueString(resourceGroup().id)}', 80)

resource workflow 'Microsoft.Logic/workflows@2019-05-01' = {
  name: workflowName
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    state: 'Enabled'
    // Empty-but-valid Consumption workflow: no triggers/actions yet, ready to
    // edit in the designer. Matches the official "empty logic app" quickstart.
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      parameters: {}
      triggers: {}
      actions: {}
      outputs: {}
    }
    parameters: {}
  }
}

// Logic App Contributor — manage/run/edit Logic Apps over ARM
// (role 87a39d53-fc1b-424a-814c-f7e04687dc9e).
//
// Scoped to the RESOURCE GROUP, not just the seeded `workflow` above. The Loom
// Console logic-app provisioner (lib/install/provisioners/logic-app.ts) PUTs
// NEW workflows by name into LOOM_LOGIC_RG (== this DLZ RG) when a user installs
// a Logic Apps-backed app or creates a logic-app item — a workflow-scoped grant
// only let the UAMI edit the one pre-created workflow and returned 403 on every
// new-workflow PUT. RG scope lets the BFF create/manage sibling workflows day
// one (the navigator's primary action) without a manual grant. Day-one gap
// closure plan §D3. Idempotent (stable guid name); skipped when re-provisioning.
resource logicContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(resourceGroup().id, consolePrincipalId, '87a39d53-fc1b-424a-814c-f7e04687dc9e')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '87a39d53-fc1b-424a-814c-f7e04687dc9e')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output workflowId string = workflow.id
output workflowName string = workflow.name
