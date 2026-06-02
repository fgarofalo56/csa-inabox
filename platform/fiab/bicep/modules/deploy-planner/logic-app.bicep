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

// Logic App Contributor — manage/run/edit the workflow over ARM
// (role 87a39d53-fc1b-424a-814c-f7e04687dc9e).
resource logicContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: workflow
  name: guid(workflow.id, consolePrincipalId, '87a39d53-fc1b-424a-814c-f7e04687dc9e')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '87a39d53-fc1b-424a-814c-f7e04687dc9e')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output workflowId string = workflow.id
output workflowName string = workflow.name
