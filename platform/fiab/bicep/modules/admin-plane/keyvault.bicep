// CSA Loom — Admin Plane Key Vault Premium
// IL5: HSM-isolated (managed HSM); otherwise Premium with RBAC.
//
// FOUNDATIONAL — ALWAYS PROVISIONED (no opt-out flag, no BYO reuse).
// This vault is a hard dependency of the admin plane: it stores the MSAL
// confidential-client secret, the stable SESSION_SECRET, the Azure Maps
// subscription key, and the Loom Connections data-source credential store
// (LOOM_KEY_VAULT_URI, consumed by kv-secrets-client.ts). Because so much of
// the console signs in / encrypts sessions / resolves secrets against it, the
// deploy-readiness scan-and-choose surfaces Key Vault as "new (recommended)"
// with the disable + reuse choices intentionally NOT offered — it is never a
// `not_configured` gate on a fresh deploy. (Per .claude/rules/no-vaporware.md
// the scan only offers choices it can fully wire; cross-sub BYO-vault reuse
// would leave the secret-write child resources unwireable, so it is omitted.)

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('HSM isolated mode (IL5 only)')
param hsmIsolated bool

@description('Tenant ID')
param tenantId string = subscription().tenantId

@description('Admin Entra group object ID')
param adminEntraGroupId string

@description('Console UAMI principalId — granted Key Vault Secrets Officer so Loom Connections can write source-credential secrets. Empty skips the grant.')
param consolePrincipalId string = ''

@description('MCP UAMI principalId (uami-loom-mcp) — granted Key Vault Secrets User (read) so catalog-deployed MCP server Container Apps can resolve their per-field secrets at runtime. Empty skips the grant.')
param mcpPrincipalId string = ''

@description('Grant the Console UAMI "Key Vault Crypto Service Encryption User" so it can list keys and act as the storage account encryption identity for Customer-Managed Keys (F14). Off by default.')
param consolePrincipalNeedsCmkRole bool = false

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Private endpoints subnet ID')
param privateEndpointSubnetId string

@description('Private DNS zone ID for vault')
param privateDnsZoneVaultId string

@description('Log Analytics workspace ID for diagnostic settings')
param workspaceId string

@description('Compliance tags')
param complianceTags object

var kvName = take('kv-loom-${uniqueString(resourceGroup().id)}', 24)

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: kvName
  location: location
  tags: complianceTags
  properties: {
    sku: {
      family: 'A'
      name: 'premium'
    }
    tenantId: tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
    }
  }
}

// Admin group gets Key Vault Administrator role
var keyVaultAdministratorRoleId = '00482a5a-887f-4fb3-b363-3b7fe8e74483'

// Role assignment skipped when adminEntraGroupId not configured —
// operator runs `scripts/csa-loom/grant-admin-kv-access.sh` post-
// deploy once they've identified the admin group.
resource adminKvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(adminEntraGroupId) && !skipRoleGrants) {
  scope: keyVault
  name: guid(keyVault.id, adminEntraGroupId, keyVaultAdministratorRoleId)
  properties: {
    roleDefinitionId: resourceId('Microsoft.Authorization/roleDefinitions', keyVaultAdministratorRoleId)
    principalId: adminEntraGroupId
    principalType: 'Group'
  }
}

// Console UAMI gets Key Vault Secrets Officer (set/get/delete secrets) so Loom
// Connections can store data-source credentials. Role: b86a8fe4-44ce-4948-aee5-eccb2c155cd7.
resource consoleKvSecretsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: keyVault
  name: guid(keyVault.id, consolePrincipalId, 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
  properties: {
    roleDefinitionId: resourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

// MCP UAMI (uami-loom-mcp) gets "Key Vault Secrets User" (read secret values) so
// catalog-deployed MCP server Container Apps can resolve their per-field secrets
// (GITHUB_PERSONAL_ACCESS_TOKEN, GRAFANA_API_KEY, …) at runtime via the ACA
// keyVaultUrl secretRef. Role: 4633458b-17de-408a-b874-0445c86b69e6 — built-in,
// global GUID (all clouds). The Console UAMI writes those secrets (Secrets
// Officer above); this identity only reads them.
resource mcpKvSecretsUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(mcpPrincipalId) && !skipRoleGrants) {
  scope: keyVault
  name: guid(keyVault.id, mcpPrincipalId, '4633458b-17de-408a-b874-0445c86b69e6')
  properties: {
    roleDefinitionId: resourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: mcpPrincipalId
    principalType: 'ServicePrincipal'
    description: 'MCP UAMI: read per-field secrets for catalog-deployed MCP server Container Apps.'
  }
}

// Console UAMI gets "Key Vault Certificate User" (read certificate objects +
// their secret material) so the eventstream MQTT/Kafka mTLS cert pickers can
// list CA + client certificates and the connector can read them at connect/
// preview time. Role: db79e9a7-68ee-4b58-9aeb-b90e7c24fcba — built-in, global
// GUID (all clouds). Read by kv-secrets-client.listKeyVaultCertificates().
resource consoleKvCertUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: keyVault
  name: guid(keyVault.id, consolePrincipalId, 'db79e9a7-68ee-4b58-9aeb-b90e7c24fcba')
  properties: {
    roleDefinitionId: resourceId('Microsoft.Authorization/roleDefinitions', 'db79e9a7-68ee-4b58-9aeb-b90e7c24fcba')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    description: 'Console UAMI: read Key Vault certificates for eventstream MQTT/Kafka mTLS connections.'
  }
}

// Console UAMI gets "Key Vault Crypto Service Encryption User" (F14 Customer-
// Managed Keys). This single role both lets the BFF list keys/versions
// (keys/read) for the bind wizard AND lets the backing storage account use the
// key as its encryption identity (wrap/unwrap). Role:
// e147488a-f6f5-4113-8e2d-b22465e65bf6 — built-in, global GUID (all clouds).
resource consoleKvCmkRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && consolePrincipalNeedsCmkRole && !skipRoleGrants) {
  scope: keyVault
  name: guid(keyVault.id, consolePrincipalId, 'e147488a-f6f5-4113-8e2d-b22465e65bf6')
  properties: {
    roleDefinitionId: resourceId('Microsoft.Authorization/roleDefinitions', 'e147488a-f6f5-4113-8e2d-b22465e65bf6')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    description: 'Console UAMI: list keys + act as storage CMK encryption identity (F14 Customer-Managed Keys).'
  }
}

// Private endpoint
resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-${kvName}'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'kv-link'
        properties: {
          privateLinkServiceId: keyVault.id
          groupIds: ['vault']
        }
      }
    ]
  }
}

resource peDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'kv-zone'
        properties: { privateDnsZoneId: privateDnsZoneVaultId }
      }
    ]
  }
}

// =====================================================================
// HSM-isolated mode (IL5) — also deploy a managed HSM
// =====================================================================

resource hsm 'Microsoft.KeyVault/managedHSMs@2024-11-01' = if (hsmIsolated && !empty(adminEntraGroupId)) {
  name: take('hsm-loom-${uniqueString(resourceGroup().id)}', 24)
  location: location
  tags: complianceTags
  sku: {
    family: 'B'
    name: 'Standard_B1'
  }
  properties: {
    tenantId: tenantId
    initialAdminObjectIds: [adminEntraGroupId]
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Deny'
    }
  }
}

// =====================================================================
// Outputs
// =====================================================================

// Diagnostic settings → standardized Loom LAW
resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: keyVault
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
      { categoryGroup: 'audit', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

resource diagHsm 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (hsmIsolated) {
  scope: hsm
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
      { categoryGroup: 'audit', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output keyVaultId string = keyVault.id
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output managedHsmId string = hsmIsolated ? hsm.id : ''
