// CSA Loom — Admin Plane managed identities
// User-Assigned Managed Identities for each app + Setup Orchestrator.
// All apps use UAMI; no client secrets stored anywhere.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Compliance tags')
param complianceTags object

// =====================================================================
// One UAMI per app component
// =====================================================================

resource uamiConsole 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'uami-loom-console-${location}'
  location: location
  tags: complianceTags
}

resource uamiMcp 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'uami-loom-mcp-${location}'
  location: location
  tags: complianceTags
}

resource uamiOrchestrator 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'uami-loom-orchestrator-${location}'
  location: location
  tags: complianceTags
}

resource uamiCopilot 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'uami-loom-copilot-${location}'
  location: location
  tags: complianceTags
}

resource uamiActivator 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'uami-loom-activator-${location}'
  location: location
  tags: complianceTags
}

resource uamiMirroring 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'uami-loom-mirroring-${location}'
  location: location
  tags: complianceTags
}

resource uamiDirectLake 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'uami-loom-direct-lake-${location}'
  location: location
  tags: complianceTags
}

// MAF orchestration tier (GCC-High / IL5). Calls Gov AOAI direct; needs
// Cognitive Services OpenAI User on the AOAI account (granted in main.bicep)
// + ACR pull. Distinct identity so the AOAI grant is scoped to the MAF tier.
resource uamiMaf 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'uami-loom-maf-${location}'
  location: location
  tags: complianceTags
}

// =====================================================================
// Outputs
// =====================================================================

output uamiConsoleId string = uamiConsole.id
output uamiConsoleClientId string = uamiConsole.properties.clientId
output uamiConsolePrincipalId string = uamiConsole.properties.principalId
output uamiConsoleName string = uamiConsole.name

output uamiMcpId string = uamiMcp.id
output uamiMcpClientId string = uamiMcp.properties.clientId
output uamiMcpPrincipalId string = uamiMcp.properties.principalId

output uamiOrchestratorId string = uamiOrchestrator.id
output uamiOrchestratorClientId string = uamiOrchestrator.properties.clientId
output uamiOrchestratorPrincipalId string = uamiOrchestrator.properties.principalId

output uamiCopilotId string = uamiCopilot.id
output uamiCopilotClientId string = uamiCopilot.properties.clientId
output uamiCopilotPrincipalId string = uamiCopilot.properties.principalId

output uamiActivatorId string = uamiActivator.id
output uamiActivatorClientId string = uamiActivator.properties.clientId
output uamiActivatorPrincipalId string = uamiActivator.properties.principalId

output uamiMirroringId string = uamiMirroring.id
output uamiMirroringClientId string = uamiMirroring.properties.clientId
output uamiMirroringPrincipalId string = uamiMirroring.properties.principalId

output uamiDirectLakeId string = uamiDirectLake.id
output uamiDirectLakeClientId string = uamiDirectLake.properties.clientId
output uamiDirectLakePrincipalId string = uamiDirectLake.properties.principalId

output uamiMafId string = uamiMaf.id
output uamiMafClientId string = uamiMaf.properties.clientId
output uamiMafPrincipalId string = uamiMaf.properties.principalId
