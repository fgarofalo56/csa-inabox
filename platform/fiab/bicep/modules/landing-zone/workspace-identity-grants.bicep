// CSA Loom DLZ — I2 bulk/IaC sibling of the runtime workspace-grant matrix
// (apps/fiab-console/lib/azure/workspace-grants.ts).
//
// Extends landing-zone/workspace-identity.bicep (which creates uami-ws-<id> +
// its ONE-container lake grant) with the OPTIONAL per-backend grants of the I2
// matrix that are expressible as ARM resources:
//   - Event Hubs Data Receiver + Data Sender at NAMESPACE scope (the day-one
//     resolvable scope; the eventstream provisioner tightens to entity scope
//     when a per-workspace hub exists — runbook §event-hubs).
//   - Cosmos DB Built-in Data Contributor as a DATA-PLANE sqlRoleAssignment
//     (account scope — Cosmos data-plane RBAC has no container scope; does NOT
//     count against the 4,000-ARM-role-assignment subscription cap).
//
// DELIBERATELY NOT HERE (data-plane scripts, runbook-executed — per the PRP's
// I2 "data-plane grants stay as deploymentScript or runbook, not ARM RBAC"):
//   - Synapse dedicated SQL:  CREATE USER [uami-ws-<id>] FROM EXTERNAL
//     PROVIDER + db_datareader/db_datawriter (T-SQL, Console UAMI executes).
//   - ADX:                    .add database <db> users ('aadapp=<clientId>;<tenant>').
//   Both are in docs/fiab/runbooks/workspace-identity-grants.md and applied
//   automatically by the runtime path (ensureWorkspaceGrants) on workspace
//   create when the backends are configured.
//
// Deploy this module INTO the resource group that hosts the target backend
// resources (Event Hubs namespace / Cosmos account). Every grant is guarded:
// an empty name = no-op, and skipRoleGrants=true skips re-deploys cleanly.

targetScope = 'resourceGroup'

@description('The workspace UAMI principalId (workspace-identity.bicep output uamiPrincipalId).')
param principalId string

@description('Event Hubs namespace (in THIS resource group) to grant Data Receiver + Data Sender on. Empty → no Event Hubs grants.')
param eventHubNamespaceName string = ''

@description('Cosmos DB account (in THIS resource group) to grant the Built-in Data Contributor DATA-PLANE role on. Empty → no Cosmos grant.')
param cosmosAccountName string = ''

@description('Skip every role grant — set true on re-deploy to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

// Built-in role GUIDs (cloud-invariant, all sovereign boundaries).
var eventHubsDataReceiverGuid = 'a638d3c7-ab3a-418d-83e6-5f17a39d4fde'
var eventHubsDataSenderGuid = '2b629674-e913-4c01-ae53-ef4638d8f975'
// Cosmos DB Built-in Data Contributor — DATA-PLANE sqlRoleDefinition id.
var cosmosDataContributorGuid = '00000000-0000-0000-0000-000000000002'

var grantEventHubs = !empty(eventHubNamespaceName) && !empty(principalId) && !skipRoleGrants
var grantCosmos = !empty(cosmosAccountName) && !empty(principalId) && !skipRoleGrants

resource ehNamespace 'Microsoft.EventHub/namespaces@2024-01-01' existing = if (grantEventHubs) {
  name: eventHubNamespaceName
}

resource ehReceiver 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantEventHubs) {
  scope: ehNamespace
  name: guid(eventHubNamespaceName, principalId, eventHubsDataReceiverGuid)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', eventHubsDataReceiverGuid)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

resource ehSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantEventHubs) {
  scope: ehNamespace
  name: guid(eventHubNamespaceName, principalId, eventHubsDataSenderGuid)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', eventHubsDataSenderGuid)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' existing = if (grantCosmos) {
  name: cosmosAccountName
}

// DATA-PLANE role assignment (sqlRoleAssignments) — account scope; partition
// isolation is logical (enforced in query), per the I2 matrix.
resource cosmosDataGrant 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = if (grantCosmos) {
  parent: cosmosAccount
  name: guid(cosmosAccountName, principalId, cosmosDataContributorGuid)
  properties: {
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/${cosmosDataContributorGuid}'
    principalId: principalId
    scope: cosmosAccount.id
  }
}

output eventHubsGranted bool = grantEventHubs
output cosmosGranted bool = grantCosmos
