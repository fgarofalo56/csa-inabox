// grafana-rbac.bicep — grant the Console UAMI "Grafana Viewer" on the Managed
// Grafana instance deployed for the Govern → Admin view (F2) "View more"
// dashboard (GCC-High / IL5). Split into a module because a role-assignment
// name must be calculable at the start of the deployment, which a parent
// module output is not — but a module PARAM is.
targetScope = 'resourceGroup'

@description('Name of the deployed Managed Grafana instance.')
param grafanaName string

@description('Console UAMI principal (object) id to grant Grafana Viewer.')
param consolePrincipalId string

@description('Skip the role grant (e.g. for a least-privilege caller).')
param skipRoleGrants bool = false

// Grafana Viewer built-in role. The previous GUID (60750a24-ce75-4119-aa84-
// 5b8f3c5db3e0) is NOT a valid built-in role definition and the live centralus
// deploy failed with RoleDefinitionDoesNotExist. Correct GUID per Microsoft
// Learn (Azure built-in roles for Monitor → Grafana Viewer):
//   https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/monitor#grafana-viewer
//   (Grafana Admin = 22926164-76b3-42b3-bc55-97df8dab3e41,
//    Grafana Editor = a79a5197-3a5c-4973-a920-486035ffd60f)
var grafanaViewerRoleId = '60921a7e-fef1-4a43-9b16-a26c52ad4769'

resource grafana 'Microsoft.Dashboard/grafana@2023-09-01' existing = {
  name: grafanaName
}

resource grafanaViewer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(consolePrincipalId)) {
  scope: grafana
  name: guid(grafana.id, consolePrincipalId, grafanaViewerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', grafanaViewerRoleId)
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}
