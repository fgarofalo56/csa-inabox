// CSA Loom — out-of-band writer for the loom-risingwave Postgres-wire root
// credential.
//
// WHY THIS EXISTS. `admin-plane/main.bicep` writes this secret itself on a full
// deploy (via `keyvault.bicep`), so the orchestrated path needs nothing here.
// The INCREMENTAL path does: `.github/workflows/gov-provision-streaming-migrate.yml`
// stands the streaming tier up in an already-provisioned estate, and it cannot
// run `az keyvault secret set` because the Loom vault is created with
// `publicNetworkAccess: 'Disabled'` + `networkAcls.defaultAction: 'Deny'` — a
// GitHub-hosted runner has no route to its data plane. Writing the secret as an
// ARM resource is a CONTROL-plane operation and works regardless of the vault
// firewall, which is exactly why `keyvault.bicep` already writes the built-in
// MCP key the same way.
//
// WHAT IT GUARANTEES. loom-risingwave's image refuses to start without
// LOOM_RW_ROOT_PASSWORD (apps/loom-risingwave/scripts/entrypoint.sh), because
// RisingWave's built-in `root` superuser has NO password and every app in a
// Container Apps environment draws its pod IP from the SAME infrastructure
// subnet — so an unauthenticated engine is reachable as root by
// loom-script-runner and loom-udf-runtime, two services that execute
// user-supplied code. This module puts the credential where BOTH the engine and
// the Console can resolve it as a Container Apps secretRef, and grants read to
// exactly those two identities and nothing else.
//
// Idempotent: re-running writes a new VERSION of the same secret. Both consumers
// reference the versionless URI, so they converge — but roll the engine and the
// Console together (the workflow does) so they never present different values.

targetScope = 'resourceGroup'

@description('Existing Loom Key Vault name (kv-loom-<hash>). Must be in THIS resource group.')
param vaultName string

@description('Secret name. Keep it identical to admin-plane/main.bicep\'s risingwaveRootPasswordSecretName so a later full deploy reconciles the SAME secret instead of creating a second one.')
param secretName string = 'loom-risingwave-root-password'

@description('The generated root password. @secure() so ARM redacts it from deployment history, outputs and the activity log. NEVER pass this to a Container App as an env literal — both consumers bind it as a Key-Vault-backed secretRef.')
@secure()
param rootPassword string

@description('Principal (object) ids granted "Key Vault Secrets User" on the vault so they can resolve the secret at revision start. Normally exactly two: the loom-risingwave UAMI and the Console UAMI. Anything NOT in this list — including loom-script-runner and loom-udf-runtime — cannot read the credential, which is the whole isolation argument.')
param readerPrincipalIds array = []

// Key Vault Secrets User — built-in, global GUID (all clouds).
var secretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: vaultName
}

resource secret 'Microsoft.KeyVault/vaults/secrets@2024-11-01' = {
  parent: vault
  name: secretName
  properties: {
    value: rootPassword
  }
}

resource readerRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for pid in readerPrincipalIds: {
  scope: vault
  name: guid(vault.id, string(pid), secretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUserRoleId)
    principalId: string(pid)
    principalType: 'ServicePrincipal'
    description: 'Resolve the loom-risingwave Postgres-wire root password at Container Apps revision start.'
  }
}]

@description('Versionless secret URI — pass to loom-risingwave-aca.bicep as risingwaveConfig.rootPasswordSecretUri and to the Console as a keyvaultref secret.')
output secretUri string = '${vault.properties.vaultUri}secrets/${secretName}'
