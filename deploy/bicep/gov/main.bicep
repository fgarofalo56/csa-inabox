// Azure Government - Platform Deployment Orchestrator
// Deploys CSA-in-a-Box platform to Azure Government (MAG) regions
// All services validated for FedRAMP High / IL4 / IL5 compliance

targetScope = 'subscription'

metadata name = 'CSA-in-a-Box Government Deployment'
metadata description = 'Deploys the complete Fabric-in-a-Box platform to Azure Government'

// ─── Parameters ───────────────────────────────────────────────────────────────

@allowed([
  'usgovvirginia'
  'usgovarizona'
  'usgovtexas'
  'usgoviowa'
])
@description('Azure Government region for deployment.')
param location string

@allowed(['dev', 'tst', 'stg', 'prod'])
@description('Deployment environment.')
param environment string = 'dev'

@minLength(2)
@maxLength(10)
@description('Resource naming prefix.')
param prefix string = 'csa'

@description('Enable FedRAMP High compliance controls.')
param enableFedRAMPHigh bool = true

@allowed(['CUI', 'FOUO', 'PII', 'PHI', 'Public'])
@description('Default data classification level.')
param dataClassification string = 'CUI'

@allowed(['IL2', 'IL4', 'IL5'])
@description('Impact level for DoD workloads.')
param impactLevel string = 'IL4'

@description('Deploy DLZ (Data Landing Zone) resources.')
param deployDLZ bool = true

@description('Deploy DMLZ (Data Management Landing Zone) resources.')
param deployDMLZ bool = true

@description('Deploy open-source alternatives on AKS.')
param deployOSSAlternatives bool = false

@description('Deploy AI integration services (Azure OpenAI, AI Search).')
param deployAIServices bool = true

@description('Deploy streaming infrastructure (Event Hubs, ADX).')
param deployStreaming bool = true

@description('Enable Customer-Managed Key (CMK) encryption across all supported services. Defaults to true for FedRAMP compliance.')
param enableCmk bool = true

@description('Enable HIPAA compliance controls (for health workloads).')
param enableHIPAA bool = false

@description('Tags applied to all resources.')
param tags object = {}

// ─── Adopt-or-create: the operator's per-service decision ────────────────────
//
// SAME CONVENTION AS COMMERCIAL, DELIBERATELY. `platform/fiab/bicep/main.bicep`
// has carried this exact bag — one object keyed by the service key in
// `apps/fiab-console/lib/deploy/adoption-catalog.ts`, transported as
// LOOM_ADOPT_JSON — since the adoption work landed. This orchestrator spoke
// none of it, which is why brownfield support that already existed for
// Commercial could not be reached from Gov at all. A second, Gov-only
// convention (`existingPurviewAccountId`, say) would have made the wizard,
// scripts/csa-loom/*, and this file disagree about the same question a fourth
// time; adopting the established shape means a plan the console already emits
// is understood here with no translation.
//
// SHAPE — per service key; every field optional; an ABSENT key means create-new:
//   { '<serviceKey>': { mode: 'adopt'|'create'|'skip',
//                       target: { name: '<name>', rg: '<rg>', sub: '<subId>' } } }
@description('Adopt-or-create plan keyed by adoption-catalog service key. Per key: { mode: "adopt"|"create"|"skip", target: { name, rg, sub } }. An absent key means create new, so a greenfield deploy is unaffected by this parameter existing. Emitted by scripts/csa-loom/discover-purview-adopt-plan.sh and by lib/deploy/plan-to-arm.ts (LOOM_ADOPT_JSON).')
param adopt object = {}

// Safe accessors. An absent key, an absent target, or an absent field all
// degrade to the create-new default rather than erroring — a partial plan is
// always a valid plan.
func adoptMode(a object, k string) string => a[?k].?mode ?? 'create'

// The coordinate accessors are GATED ON MODE, exactly as in the Commercial
// orchestrator. `union()` deep-merges, so a plan that says {purview:{mode:
// 'create'}} layered over an older document can keep a stale `target`; handing
// that name back would bind Loom to the customer's account WHILE ALSO creating
// a new one. A coordinate is only ever surfaced for a decision that is actually
// 'adopt'.
func adoptName(a object, k string) string => adoptMode(a, k) == 'adopt' ? (a[?k].?target.?name ?? '') : ''
func adoptRg(a object, k string) string => adoptMode(a, k) == 'adopt' ? (a[?k].?target.?rg ?? '') : ''
func adoptSub(a object, k string) string => adoptMode(a, k) == 'adopt' ? (a[?k].?target.?sub ?? '') : ''

// ─── Variables ────────────────────────────────────────────────────────────────

var baseName = toLower('${prefix}-${environment}')

var govEndpoints = {
  activeDirectory: 'https://login.microsoftonline.us'
  resourceManager: 'https://management.usgovcloudapi.net'
  storage: 'core.usgovcloudapi.net'
  sql: 'database.usgovcloudapi.net'
  databricks: 'databricks.azure.us'
  keyVault: 'vault.usgovcloudapi.net'
  monitor: 'monitor.azure.us'
  purview: 'purview.azure.us'
}

var complianceTags = union(tags, {
  FedRAMP_Level: enableFedRAMPHigh ? 'High' : 'Moderate'
  FISMA_Impact: 'High'
  Data_Classification: dataClassification
  Impact_Level: impactLevel
  Compliance_Framework: 'NIST-800-53-Rev5'
  Cloud_Environment: 'AzureUSGovernment'
  Deployed_By: 'CSA-in-a-Box'
  HIPAA_Compliant: enableHIPAA ? 'Yes' : 'No'
})

// ─── Resource Groups ──────────────────────────────────────────────────────────

resource rgPlatform 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${baseName}-platform-${location}'
  location: location
  tags: complianceTags
}

resource rgData 'Microsoft.Resources/resourceGroups@2024-03-01' = if (deployDLZ) {
  name: 'rg-${baseName}-dlz-${location}'
  location: location
  tags: complianceTags
}

resource rgManagement 'Microsoft.Resources/resourceGroups@2024-03-01' = if (deployDMLZ) {
  name: 'rg-${baseName}-dmlz-${location}'
  location: location
  tags: complianceTags
}

resource rgStreaming 'Microsoft.Resources/resourceGroups@2024-03-01' = if (deployStreaming) {
  name: 'rg-${baseName}-streaming-${location}'
  location: location
  tags: complianceTags
}

resource rgAI 'Microsoft.Resources/resourceGroups@2024-03-01' = if (deployAIServices) {
  name: 'rg-${baseName}-ai-${location}'
  location: location
  tags: complianceTags
}

resource rgOSS 'Microsoft.Resources/resourceGroups@2024-03-01' = if (deployOSSAlternatives) {
  name: 'rg-${baseName}-oss-${location}'
  location: location
  tags: complianceTags
}

// ─── Core Platform ───────────────────────────────────────────────────────────

module keyVault 'modules/keyVault.bicep' = {
  name: '${baseName}-keyvault'
  scope: rgPlatform
  params: {
    name: '${baseName}-kv'
    location: location
    tags: complianceTags
    enablePurgeProtection: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enableRbacAuthorization: true
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

module logAnalytics 'modules/logAnalytics.bicep' = {
  name: '${baseName}-logs'
  scope: rgPlatform
  params: {
    name: '${baseName}-logs'
    location: location
    tags: complianceTags
    retentionInDays: enableFedRAMPHigh ? 365 : 90
    dailyQuotaGb: -1
  }
}

// ─── Data Landing Zone ───────────────────────────────────────────────────────

module storage 'modules/storage.bicep' = if (deployDLZ) {
  name: '${baseName}-storage'
  scope: rgData
  params: {
    name: replace('${baseName}stor', '-', '')
    location: location
    tags: complianceTags
    // FedRAMP / IL5 require GEO-redundant replication for primary data stores,
    // which is why modules/storage.bicep restricts `sku` to GRS variants only
    // (CKV_AZURE_206). This caller previously asked for 'Standard_LRS' in
    // non-prod — a value the module does not allow, so the template did not
    // compile (BCP036) AND, had it compiled, it would have silently dropped
    // non-prod gov data out of the geo-redundancy baseline. The control is
    // correct; the caller was wrong. Non-prod gets GRS (geo-redundant, the
    // cheapest compliant option) and prod gets GZRS (geo + zone redundant).
    sku: environment == 'prod' ? 'Standard_GZRS' : 'Standard_GRS'
    kind: 'StorageV2'
    isHnsEnabled: true  // Hierarchical namespace for ADLS Gen2
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    containers: [
      'bronze'
      'silver'
      'gold'
      'sandbox'
      'staging'
    ]
    enableCustomerManagedKey: enableCmk
    keyVaultId: keyVault.outputs.keyVaultId
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

module databricks 'modules/databricks.bicep' = if (deployDLZ) {
  name: '${baseName}-dbx'
  scope: rgData
  params: {
    name: '${baseName}-dbx'
    location: location
    tags: complianceTags
    pricingTier: 'premium'  // Required for Unity Catalog
    enableNoPublicIp: true
    requireInfrastructureEncryption: enableCmk
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

module synapse 'modules/synapse.bicep' = if (deployDLZ) {
  name: '${baseName}-syn'
  scope: rgData
  params: {
    name: '${baseName}-syn'
    location: location
    tags: complianceTags
    storageAccountId: (deployDLZ && storage != null) ? storage!.outputs.storageAccountId : ''
    managedVirtualNetwork: 'default'
    preventDataExfiltration: true
    publicNetworkAccess: 'Disabled'
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

module dataFactory 'modules/dataFactory.bicep' = if (deployDLZ) {
  name: '${baseName}-adf'
  scope: rgData
  params: {
    name: '${baseName}-adf'
    location: location
    tags: complianceTags
    managedVirtualNetworkEnabled: true
    publicNetworkAccess: 'Disabled'
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

// ─── Data Management Landing Zone ────────────────────────────────────────────
//
// PURVIEW IS ADOPT-OR-CREATE, NOT CREATE (deploy-integrity.md R5, #3577).
//
// This module used to read `= if (deployDMLZ)`, i.e. "whenever the DMLZ is
// requested, make a new Purview account". Purview account quota is per-TENANT
// per-REGION and is 5, so on a tenant that already runs Purview — the normal
// case in a sovereign boundary — that is not a preference, it is a wall:
// deploy-gov.yml run 31917112453 was refused at preflight with
// "The Tenant *** with 5 resources has surpassed its resource quota 5 for
// resource type Account in usgovvirginia location."
//
// Both halves of R5's prohibition were live in that one line: had quota
// allowed, it would have deployed a SIXTH account beside the customer's five;
// because quota did not allow, it failed because one exists.
//
// `provisionPurview` is the suppression half of adopt-or-create and is byte-
// identical in shape to the Commercial orchestrator's, so a reader who knows
// one knows the other. `adoptPurview` is the binding half.
var existingPurviewAccount = adoptName(adopt, 'purview')
var existingPurviewRg = adoptRg(adopt, 'purview')
var existingPurviewSub = adoptSub(adopt, 'purview')

var provisionPurview = deployDMLZ && adoptMode(adopt, 'purview') == 'create'

// An adopt decision needs BOTH coordinates to be actionable: `resourceGroup(sub,
// '')` is a deployment that cannot be submitted, so an adopt plan carrying a
// name but no resource group must not reach ARM as a malformed scope. The
// preflight (scripts/csa-loom/discover-purview-adopt-plan.sh) refuses to emit
// such a plan; this condition is the template-side backstop, and its failure
// mode is the pre-existing create path, never a broken deployment.
var adoptPurview = deployDMLZ && adoptMode(adopt, 'purview') == 'adopt' && !empty(existingPurviewAccount) && !empty(existingPurviewRg)

// The plan's `sub` is optional — an adopted account in THIS subscription is the
// common case and omitting the field is how the plan says so.
var existingPurviewSubEff = empty(existingPurviewSub) ? subscription().subscriptionId : existingPurviewSub

module purview 'modules/purview.bicep' = if (provisionPurview) {
  name: '${baseName}-prv'
  scope: rgManagement
  params: {
    name: '${baseName}-prv'
    location: location
    tags: complianceTags
    publicNetworkAccess: 'Disabled'
    managedResourceGroupName: 'rg-${baseName}-prv-managed'
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

// BIND to the account the tenant already owns. Read-only: see the module header
// for why it deliberately writes nothing to a resource Loom does not own.
module purviewAdopted 'modules/purview-existing.bicep' = if (adoptPurview) {
  name: '${baseName}-prv-adopt'
  scope: resourceGroup(existingPurviewSubEff, existingPurviewRg)
  params: {
    name: existingPurviewAccount
    expectedLocation: location
  }
}

// ─── Streaming Infrastructure ────────────────────────────────────────────────

module eventHub 'modules/eventHub.bicep' = if (deployStreaming) {
  name: '${baseName}-eh'
  scope: rgStreaming
  params: {
    name: '${baseName}-eh'
    location: location
    tags: complianceTags
    sku: 'Standard'
    capacity: environment == 'prod' ? 4 : 1
    autoInflateEnabled: true
    maximumThroughputUnits: environment == 'prod' ? 20 : 4
    kafkaEnabled: true
    zoneRedundant: environment == 'prod'
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

module adx 'modules/dataExplorer.bicep' = if (deployStreaming) {
  name: '${baseName}-adx'
  scope: rgStreaming
  params: {
    name: '${baseName}-adx'
    location: location
    tags: complianceTags
    sku: environment == 'prod' ? 'Standard_E8as_v5+1TB_PS' : 'Dev(No SLA)_Standard_E2a_v4'
    enableDiskEncryption: true
    enableDoubleEncryption: enableFedRAMPHigh
    enableStreamingIngest: true
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

// ─── AI Services ─────────────────────────────────────────────────────────────

module openAI 'modules/openAI.bicep' = if (deployAIServices) {
  name: '${baseName}-aoai'
  scope: rgAI
  params: {
    name: '${baseName}-aoai'
    location: location
    tags: complianceTags
    sku: 'S0'
    publicNetworkAccess: 'Disabled'
    deployments: [
      {
        name: 'gpt-4o'
        model: 'gpt-4o'
        version: '2024-11-20'
        capacity: 30
      }
      {
        name: 'text-embedding-3-small'
        model: 'text-embedding-3-small'
        version: '1'
        capacity: 30
      }
    ]
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

module mlWorkspace 'modules/machineLearning.bicep' = if (deployAIServices) {
  name: '${baseName}-ml'
  scope: rgAI
  params: {
    name: '${baseName}-ml'
    location: location
    tags: complianceTags
    keyVaultId: keyVault.outputs.keyVaultId
    storageAccountId: (deployDLZ && storage != null) ? storage!.outputs.storageAccountId : ''
    applicationInsightsId: ''
    publicNetworkAccess: 'Disabled'
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

// ─── OSS Alternatives (AKS-hosted) ──────────────────────────────────────────

module aks 'modules/aks.bicep' = if (deployOSSAlternatives) {
  name: '${baseName}-aks'
  scope: rgOSS
  params: {
    name: '${baseName}-aks'
    location: location
    tags: complianceTags
    kubernetesVersion: '1.31'
    enableAzurePolicy: true
    enableDefender: true
    networkPlugin: 'azure'
    networkPolicy: 'calico'
    enablePrivateCluster: true
    systemNodePoolVmSize: 'Standard_D4s_v5'
    systemNodePoolCount: 3
    logAnalyticsId: logAnalytics.outputs.workspaceId
  }
}

// ─── RBAC — Service-to-Service Identity Wiring ─────────────────────────────
// Storage Blob Data Contributor: ba92f5b4-2d11-453d-a403-e96b0029c9fe
//
// These three grants are deployed through modules/roleAssignment.bicep rather
// than declared inline. A subscription-scoped file cannot declare an
// RG-scoped resource (BCP139), and a roleAssignment `name` must be computable
// at the start of the deployment, which `<module>.outputs.principalId` is not
// (BCP120). Both errors were live in this file and are the reason
// deploy-gov.yml's "Bicep Build" step had never once passed. See the module
// header for the full explanation.

var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

// ADF managed identity → Storage Blob Data Contributor on storage
module roleAdfToStorage 'modules/roleAssignment.bicep' = if (deployDLZ) {
  name: '${baseName}-rbac-adf-storage'
  scope: rgData
  params: {
    principalId: dataFactory.outputs.principalId
    roleDefinitionId: blobDataContributorRoleId
    roleDescription: 'ADF managed identity → Storage Blob Data Contributor on gov storage'
  }
}

// Databricks managed identity → Storage Blob Data Contributor on storage
module roleDatabricksToStorage 'modules/roleAssignment.bicep' = if (deployDLZ) {
  name: '${baseName}-rbac-dbx-storage'
  scope: rgData
  params: {
    principalId: databricks.outputs.principalId
    roleDefinitionId: blobDataContributorRoleId
    roleDescription: 'Databricks managed identity → Storage Blob Data Contributor on gov storage'
  }
}

// Synapse managed identity → Storage Blob Data Contributor on storage
module roleSynapseToStorage 'modules/roleAssignment.bicep' = if (deployDLZ) {
  name: '${baseName}-rbac-synapse-storage'
  scope: rgData
  params: {
    principalId: synapse.outputs.principalId
    roleDefinitionId: blobDataContributorRoleId
    roleDescription: 'Synapse managed identity → Storage Blob Data Contributor on gov storage'
  }
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

output platformResourceGroup string = rgPlatform.name
output keyVaultName string = keyVault.outputs.keyVaultName
output logAnalyticsWorkspaceId string = logAnalytics.outputs.workspaceId
output govEndpoints object = govEndpoints
output complianceTags object = complianceTags
output dlzStorageAccountName string = (deployDLZ && storage != null) ? storage!.outputs.storageAccountName : ''
output databricksWorkspaceUrl string = (deployDLZ && databricks != null) ? databricks!.outputs.workspaceUrl : ''
output synapseWorkspaceUrl string = (deployDLZ && synapse != null) ? synapse!.outputs.workspaceUrl : ''
output eventHubNamespace string = (deployStreaming && eventHub != null) ? eventHub!.outputs.namespaceName : ''
output adxClusterUri string = (deployStreaming && adx != null) ? adx!.outputs.clusterUri : ''

// ─── Purview binding — WHICH account, and HOW it got there ───────────────────
// The MODE is emitted next to the name deliberately. An operator reading these
// outputs can then tell an account Loom created from one it adopted, instead of
// inferring it from a name that looks conventional — the mapping is recorded
// and inspectable rather than guessed (auto-bind-by-default.md §2).
output purviewAccountName string = (provisionPurview && purview != null)
  ? purview!.outputs.accountName
  : ((adoptPurview && purviewAdopted != null) ? purviewAdopted!.outputs.accountName : '')

output purviewAccountId string = (provisionPurview && purview != null)
  ? purview!.outputs.accountId
  : ((adoptPurview && purviewAdopted != null) ? purviewAdopted!.outputs.accountId : '')

@description('created | adopted | none. `none` means the DMLZ was requested but no account was created OR bound — read the deploy log, do not assume Purview is wired.')
output purviewBindingMode string = provisionPurview ? 'created' : (adoptPurview ? 'adopted' : 'none')

@description('The adopted account\'s ACTUAL region, read from ARM — not the region that was asked for. Empty when nothing was bound. A value different from the deployment location is a cross-region binding: workable (the Data Map is reached by account host) and disclosed rather than silently normalised.')
output purviewAccountLocation string = (provisionPurview && purview != null)
  ? location
  : ((adoptPurview && purviewAdopted != null) ? purviewAdopted!.outputs.accountLocation : '')
