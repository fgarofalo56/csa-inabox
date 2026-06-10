// Grants the Console UAMI permission to create + manage the Azure Bot Service
// registration that fronts a published Loom data agent on Microsoft 365 Copilot
// + Microsoft Teams.
//
// Build 2026 #4 "Publish to Teams and Microsoft 365 Copilot" path: the Console
// (data-agent → Publish to Microsoft 365 Copilot) issues
//   PUT Microsoft.BotService/botServices/{bot}
//   PUT Microsoft.BotService/botServices/{bot}/channels/MsTeamsChannel
// against this resource group. Microsoft.BotService/botServices/write is not
// covered by any narrowly-scoped built-in role, so the Console UAMI is granted
// Contributor scoped to THIS resource group only (least privilege that still
// allows bot create/update). The grant is gated on m365BotAppId being supplied —
// without a Microsoft Entra app id the bot registration can't be created, so the
// Console renders an honest infra-gate and no RBAC is needed.
//
// Azure-native only — no Microsoft Fabric / Power BI dependency. The bot's
// messaging endpoint targets the published Foundry Agent Service agent.
targetScope = 'resourceGroup'

@description('Console UAMI principal (object) id. Empty = skip the grant.')
param consolePrincipalId string = ''

@description('Microsoft Entra app (client) id for the M365 bot. Empty = feature gated off, no grant.')
param m365BotAppId string = ''

@description('Skip all role grants (re-deploy / restricted-RBAC environments).')
param skipRoleGrants bool = false

// Contributor — required for Microsoft.BotService/botServices/write at RG scope.
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'

var doGrant = !skipRoleGrants && !empty(consolePrincipalId) && !empty(m365BotAppId)

resource grant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (doGrant) {
  // Deterministic name → idempotent re-deploy.
  name: guid(resourceGroup().id, consolePrincipalId, contributorRoleId, 'm365-copilot-bot')
  properties: {
    principalId: consolePrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
    principalType: 'ServicePrincipal'
  }
}

@description('Whether the M365 Copilot bot RBAC grant was applied.')
output granted bool = doGrant
