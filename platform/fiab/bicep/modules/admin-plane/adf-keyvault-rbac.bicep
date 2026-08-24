// CSA Loom — Data Factory → Key Vault "Secrets User" grant (mirrored-database
// auto-bind).
//
// ## Why this module exists
//
// Creating a Snowflake mirrored database used to require the operator to
// hand-build an ADF Snowflake linked service and pin its name into
// `LOOM_MIRROR_SNOWFLAKE_LINKED_SERVICE`. `auto-bind-by-default.md` §5 forbids
// that: infra prerequisites are DEPLOYED, not requested. The Console now builds
// the linked service itself from the Loom Connection
// (apps/fiab-console/lib/azure/snowflake-adf.ts → `ensureSnowflakeBinding`).
//
// That auto-bound linked service references the source credential as an
// `AzureKeyVaultSecret` — a secret NAME — through a `loom_key_vault` linked
// service authenticated with the factory's own managed identity. The credential
// therefore never leaves Key Vault and never lands in a linked-service
// definition ARM would store. That indirection only works if the FACTORY can
// read the secret, which is this role assignment. Without it the Copy activity
// fails at run time with a Key Vault authorization error.
//
// ## Why it is a separate module rather than a param on keyvault.bicep
//
// The Key Vault is deployed by the ADMIN PLANE, which runs BEFORE the landing
// zone that creates the factory — so `adf.outputs.factoryPrincipalId` does not
// exist yet when `keyvault.bicep` is evaluated. Same shape and same reason as
// `aoai-spark-rbac.bicep`, which grants DLZ Spark identities on the admin-plane
// AOAI account from the orchestrator after the DLZ has been deployed.
//
// Wire at: the Admin Plane RG (where the Key Vault lives), after the DLZ.

targetScope = 'resourceGroup'

@description('Name of the Loom Key Vault in this resource group (holds Loom Connection secrets). Empty skips the grant.')
param keyVaultName string

@description('Data Factory SYSTEM-ASSIGNED identity principalId — landing-zone/adf.bicep output `factoryPrincipalId`. Empty skips the grant (no factory deployed in this estate).')
param dataFactoryPrincipalId string = ''

@description('When true, skip the grant (re-deploy where RBAC already exists, or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Key Vault Secrets User — built-in, global GUID (identical in Commercial, GCC,
// GCC-High, IL5 and DoD, so this module is cloud-parity clean).
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

var grantActive = !empty(keyVaultName) && !empty(dataFactoryPrincipalId) && !skipRoleGrants

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = if (!empty(keyVaultName)) {
  name: keyVaultName
}

resource adfKvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantActive) {
  scope: keyVault
  name: guid(resourceGroup().id, keyVaultName, dataFactoryPrincipalId, keyVaultSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUser)
    principalId: dataFactoryPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Data Factory MI: read Loom Connection secrets BY REFERENCE for auto-bound mirroring linked services (Snowflake password / private key).'
  }
}

@description('True when the grant was actually made — false when skipped for a missing factory, missing vault, or skipRoleGrants.')
output granted bool = grantActive
