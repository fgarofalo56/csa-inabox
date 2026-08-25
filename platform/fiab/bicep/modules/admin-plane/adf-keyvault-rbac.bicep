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
//
// ## TWO ways to name the factory, because the factory is not always local
//
// The original call sites hand this module a principalId straight out of a
// landing-zone module output — available only when THIS deployment created the
// factory. That covers `useSingleDlz` and the multi-sub DLZ fan-out and nothing
// else, and BOTH of those are false on every shipped `.bicepparam` (they all pin
// `topology='tenant'`, which makes `deployLandingZones` false — see the measured
// reachability block in main.bicep). So on the estates that actually run, this
// module had no reachable call site at all.
//
// The estates that run bind the Console to a factory that already exists, in the
// LANDING-ZONE resource group of a DIFFERENT SUBSCRIPTION from the vault — either
// adopted (`adopt.adf` → LOOM_ADF_NAME/RG/SUB) or stamped by a `dlz-attach` pass.
// So this module also accepts the factory's COORDINATES and resolves the
// system-assigned principal itself, cross-subscription. `dataFactoryPrincipalId`
// still wins when supplied, so the existing call sites are byte-identical.
//
// ## RoleAssignmentExists is a REAL hazard here — read this before adding a caller
//
// ARM enforces uniqueness on the (scope, principalId, roleDefinitionId) TRIPLE,
// not on the assignment NAME. A factory this deployment did NOT mint is a
// long-lived identity, so an assignment for the same triple may already exist
// under an Azure-minted v4 name — created by an operator unblocking themselves,
// or by any `az role assignment create` without `--name`. That blocks the
// template's deterministic v5 name FOREVER, and the failure takes the whole
// deployment with it.
//
// `scripts/csa-loom/converge-role-assignment.mjs` is the estate's remediation for
// exactly this and runs automatically on every cloud lane (deploy-retry.mjs
// --remediate) — but it REFUSES a principal that is not a user-assigned managed
// identity in the deployment subscription, and a factory's identity is
// SYSTEM-assigned. So for this triple the stray must be removed once, by hand,
// and the converger extended to cover system-assigned MIs. Stated here rather
// than discovered in a failed deploy (deploy-integrity.md R6/R7).

targetScope = 'resourceGroup'

@description('Name of the Loom Key Vault in this resource group (holds Loom Connection secrets). Empty skips the grant.')
param keyVaultName string

@description('Data Factory SYSTEM-ASSIGNED identity principalId — landing-zone/adf.bicep output `factoryPrincipalId`. Supply this when THIS deployment created the factory. Empty falls back to resolving the principal from `dataFactoryName`/`dataFactoryRg`/`dataFactorySub`; empty with no name either skips the grant (no factory in this estate).')
param dataFactoryPrincipalId string = ''

@description('Name of an EXISTING Data Factory whose system-assigned principal should be resolved and granted — the adopted/attached factory the Console is bound to (LOOM_ADF_NAME). Ignored when `dataFactoryPrincipalId` is supplied. Empty + empty principalId = no grant.')
param dataFactoryName string = ''

@description('Resource group holding `dataFactoryName`. Empty = this module\'s own resource group.')
param dataFactoryRg string = ''

@description('Subscription holding `dataFactoryName`. Empty = the deployment subscription. The factory routinely lives in a DIFFERENT subscription from the vault, which is why this is a first-class input rather than an assumption.')
param dataFactorySub string = ''

@description('When true, skip the grant (re-deploy where RBAC already exists, or the deployer lacks User Access Administrator).')
param skipRoleGrants bool = false

// Key Vault Secrets User — built-in, global GUID (identical in Commercial, GCC,
// GCC-High, IL5 and DoD, so this module is cloud-parity clean).
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

// Coordinates default to LOCAL, never to a guess: an empty RG/sub means "the
// factory is here", which is the only thing a missing coordinate can honestly
// mean. Both are start-of-deployment computable, so they may appear in a
// resource NAME (a reference() may not).
var effAdfRg = !empty(dataFactoryRg) ? dataFactoryRg : resourceGroup().name
var effAdfSub = !empty(dataFactorySub) ? dataFactorySub : subscription().subscriptionId

// Resolve-from-coordinates is the FALLBACK, so a caller that already holds the
// principal never pays for a cross-subscription read.
var resolveFromFactory = empty(dataFactoryPrincipalId) && !empty(dataFactoryName)

var grantActive = !empty(keyVaultName) && (!empty(dataFactoryPrincipalId) || resolveFromFactory) && !skipRoleGrants

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = if (!empty(keyVaultName)) {
  name: keyVaultName
}

// Cross-subscription read of an EXISTING factory. Declared conditionally so the
// reference() is only emitted on the branch that uses it — same shape as
// `container-platform.bicep`'s cross-sub subnet read. The deployment identity
// needs Reader on the factory; without it the read fails LOUDLY rather than
// silently skipping a grant the mirror depends on.
resource adfFactory 'Microsoft.DataFactory/factories@2018-06-01' existing = if (resolveFromFactory) {
  name: dataFactoryName
  scope: resourceGroup(effAdfSub, effAdfRg)
}

// The assignment name must be computable BEFORE the deployment runs, so the
// resolve-from-coordinates branch keys the guid off the factory's identity as an
// ADDRESS rather than its principalId. When the caller supplied a principalId
// the seed IS that principalId, so the name is byte-identical to the one this
// module has always produced for the single-sub / multi-sub call sites — a
// changed name would be a SECOND assignment for the same triple, i.e. a
// guaranteed RoleAssignmentExists on every estate that already has one.
var assignmentSeed = !empty(dataFactoryPrincipalId) ? dataFactoryPrincipalId : '${effAdfSub}/${effAdfRg}/${dataFactoryName}'

resource adfKvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantActive) {
  scope: keyVault
  name: guid(resourceGroup().id, keyVaultName, assignmentSeed, keyVaultSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUser)
    // `!` is a deliberate assertion, not a silencer: `adfFactory` is declared
    // `= if (resolveFromFactory)` and this branch is only taken when that same
    // flag is true — and the whole resource is `= if (grantActive)`, which
    // requires it too. ARM's `if()` returns only the branch it selects, so the
    // reference() below is never evaluated on the principalId-supplied path.
    principalId: !empty(dataFactoryPrincipalId) ? dataFactoryPrincipalId : (resolveFromFactory ? adfFactory!.identity.principalId : '')
    principalType: 'ServicePrincipal'
    description: 'Data Factory MI: read Loom Connection secrets BY REFERENCE for auto-bound mirroring linked services (Snowflake password / private key).'
  }
}

@description('True when the grant was actually made — false when skipped for a missing factory, missing vault, or skipRoleGrants.')
output granted bool = grantActive

@description('True when the principal was resolved from the factory\'s coordinates rather than handed in — i.e. an adopted/attached factory that this deployment did not mint. The RoleAssignmentExists hazard in this module\'s header applies to exactly this case.')
output resolvedFromFactory bool = resolveFromFactory
