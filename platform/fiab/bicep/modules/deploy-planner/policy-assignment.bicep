// CSA Loom deploy-planner — Azure Policy (sample subscription assignment)
//
// Wired by the deploy-planner catalog (key: policy → policyEnabled).
// Self-contained: a single subscription-scoped policy assignment of a built-in
// audit policy so the Azure Policy navigator shows a real, working assignment
// with compliance results. Defaults to the built-in "Audit VMs that do not use
// managed disks" definition (audit effect — no deny, no managed identity
// required). This is a subscription-scoped resource, so the module is deployed
// with `scope: subscription()` from main.bicep.
//
// Grounded in Microsoft Learn:
//   Microsoft.Authorization/policyAssignments (Bicep, subscription scope)
//   https://learn.microsoft.com/azure/templates/microsoft.authorization/policyassignments

targetScope = 'subscription'

@description('Display name for the sample policy assignment.')
param displayName string = 'CSA Loom — audit VMs without managed disks'

@description('Built-in policy definition ID to assign. Default: "Audit VMs that do not use managed disks" (audit-only, no MI).')
param policyDefinitionId string = '/providers/Microsoft.Authorization/policyDefinitions/06a78e20-9358-41c9-923c-fb736d382a4d'

var assignmentName = take('loom-sample-${uniqueString(subscription().id)}', 24)

resource assignment 'Microsoft.Authorization/policyAssignments@2023-04-01' = {
  name: assignmentName
  properties: {
    displayName: displayName
    description: 'Sample audit-only assignment provisioned by CSA Loom so the Azure Policy navigator shows a real assignment with live compliance results.'
    policyDefinitionId: policyDefinitionId
    enforcementMode: 'Default'
    metadata: {
      assignedBy: 'CSA Loom deploy-planner'
      category: 'Compute'
    }
  }
}

output assignmentId string = assignment.id
output assignmentName string = assignment.name
