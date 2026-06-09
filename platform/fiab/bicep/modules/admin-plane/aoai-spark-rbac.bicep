// CSA Loom — Cognitive Services OpenAI User grant for Spark notebook AI functions
//
// The notebook AI-functions library (apps/copilot/ai_functions/, dist
// `loom-ai-functions`) lets an analyst call Azure OpenAI from a PySpark/pandas
// cell — ai.summarize / classify / sentiment / extract / translate. The HTTP
// call goes out from the Spark executor under the Spark pool's managed
// identity, so that identity needs **inference** rights on the AOAI account.
//
// We grant **Cognitive Services OpenAI User** (5e0bd9bd-...), the inference-only
// least-privilege role (the same role the Console UAMI gets in ai-foundry.bicep
// for the SQL-editor AI-functions surface). It does NOT allow model deploys or
// key reads — only chat/completions.
//
// Deploy ordering note: the AOAI account is created in the Admin Plane (which
// deploys BEFORE the Data Landing Zone), so the Synapse workspace / Databricks
// Access Connector identities do not exist yet at admin-plane time. This module
// therefore lives at the orchestrator level (platform/fiab/bicep/main.bicep),
// scoped to the Admin Plane RG, and is fed the Spark identities from the DLZ
// outputs — mirroring how access-policy-rbac.bicep grants the (admin-plane)
// Console UAMI a role on a (DLZ) storage account in reverse.

targetScope = 'resourceGroup'

@description('Name of the AOAI (AIServices) account the Spark identities call for inference — aoai-csa-loom-<region>, deployed by admin-plane/ai-foundry.bicep. Empty skips all grants.')
param aiServicesAccountName string

@description('Synapse workspace system-assigned MI principal ID — granted Cognitive Services OpenAI User so %%pyspark / %%pyspark-pandas notebook cells can call AOAI. Empty skips this grant.')
param synapseWorkspacePrincipalId string = ''

@description('Databricks Access Connector MI principal ID — same grant for UC-enabled Databricks clusters. Empty (GCC-High / IL5, where UC is unsupported) skips this grant.')
param databricksAccessConnectorPrincipalId string = ''

@description('When true, skip all role grants (re-deploy where RBAC already exists or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Cognitive Services OpenAI User — inference-only (chat/completions); same GUID
// used for the Console UAMI grant in ai-foundry.bicep.
var openAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource aiServices 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: aiServicesAccountName
}

resource synapseSparkOpenAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(aiServicesAccountName) && !empty(synapseWorkspacePrincipalId) && !skipRoleGrants) {
  scope: aiServices
  name: guid(aiServices.id, synapseWorkspacePrincipalId, openAiUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', openAiUserRoleId)
    principalId: synapseWorkspacePrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource databricksSparkOpenAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(aiServicesAccountName) && !empty(databricksAccessConnectorPrincipalId) && !skipRoleGrants) {
  scope: aiServices
  name: guid(aiServices.id, databricksAccessConnectorPrincipalId, openAiUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', openAiUserRoleId)
    principalId: databricksAccessConnectorPrincipalId
    principalType: 'ServicePrincipal'
  }
}
