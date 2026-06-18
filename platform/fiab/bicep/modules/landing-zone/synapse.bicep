// CSA Loom DLZ — Synapse workspace (Serverless + Dedicated SQL pools)
// Per LD-2 + v2.0: Serverless is the always-on engine; Dedicated is
// provisioned + auto-paused by Loom for on-demand MPP workloads.
//
// Telemetry / DSC posture (per repo-wide standard):
//  - Diagnostic settings → standardized Loom LAW
//  - Workspace audit policy → SAME LAW (SQL audit events)
//  - Private endpoints for both Sql + SqlOnDemand on spoke PE subnet
//  - Synapse RBAC roles assigned to admin Entra group + Console UAMI
//  - Managed VNet with exfil prevention enabled
//  - All deployments idempotent (Bicep ARM declarative = DSC)

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Domain name')
param domainName string

@description('ADLS Gen2 storage account name (default Synapse data lake)')
param defaultStorageAccountName string

@description('Default file system name')
param defaultFileSystemName string = 'synapse'

@description('Admin Entra group object ID (Workspace Admin)')
param adminEntraGroupId string

@description('Loom Console UAMI principal ID — set as Synapse AAD admin so the BFF can query SQL via DefaultAzureCredential.')
param consolePrincipalId string = ''

@description('Loom Console UAMI name — used for the SQL admin login name (display label only; SQL matches on the SID, not this login).')
param consoleUamiName string = ''

@description('Loom Console UAMI APPLICATION (client) id. Used two ways, both requiring the appId (clientId), NOT the objectId/principalId: (1) the SID of the Synapse SQL Active Directory admin — SQL matches the incoming access-token appid against the admin SID; (2) the Synapse SQL Administrator grant — when an SPI grants a Synapse-RBAC role to another SPI by OBJECT id, Synapse cannot fetch the app id from Microsoft Graph and produces a BROKEN serverless login. Either way the wrong id yields ELOGIN "Login failed for user \'<token-identified principal>\'" on serverless CREATE DATABASE (Learn: resources-self-help-sql-on-demand#security, Solution 3). Empty = SQL Administrator grant skipped + admin SID falls back to consolePrincipalId (legacy callers).')
param consoleUamiAppId string = ''

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Enable OneLake Security (F7) — grants the Console UAMI Storage Blob Data Owner on the lakehouse ADLS account so the Security tab can set folder/table ACLs on behalf of role members. Off by default (least-privilege).')
param loomOnelakeSecurityEnabled bool = false

@description('Managed VNet enabled')
param managedVnet bool = true

@description('Allow-list firewall rules. Defaults to VNet-only (deny all internet).')
param firewallRules array = [
  {
    name: 'allow-vnet-only'
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
]

@description('Allow Azure services to access (when public endpoint is up)')
param allowAzureServices bool = false

@description('Log Analytics workspace ID for diagnostic + audit + telemetry. Empty (dlz-attach with no hub LAW coordinate) skips the diagnostic settings.')
param workspaceId string = ''

@description('Audit log retention days (Synapse SQL audit)')
@minValue(7)
@maxValue(3285)
param auditRetentionDays int = 90

@description('Compliance tags')
param complianceTags object

// =====================================================================
// v2.0 — Dedicated SQL pool params
// =====================================================================

@description('Deploy a Dedicated SQL pool on the workspace. Default true so the Loom Dedicated editor works out of the box.')
param deployDedicatedPool bool = true

// Spark pool — required for Notebook editor (Loom-native notebook execution
// dispatches to either this Spark pool via Livy or to a Databricks cluster).
// Also powers the Lakehouse "Load to Table" wizard (F6): it submits a PySpark
// Livy job that reads a CSV/Parquet/JSON file and writes a managed Delta table
// under the container's Tables/ folder. That job runs under the Synapse
// workspace MSI, which the synapseStorageRbac module below grants Storage Blob
// Data Contributor on the default ADLS (the Hive metastore warehouse path).
// Keep deploySparkPool=true for the wizard to have a compute target.
// Auto-pause keeps idle cost low.
@description('Deploy the loompool Spark pool used by notebook + spark-job editors.')
param deploySparkPool bool = true
@description('Name of the Spark pool.')
param sparkPoolName string = 'loompool'
@description('Spark pool node size family — Small/Medium/Large/XLarge/XXLarge.')
param sparkPoolNodeSize string = 'Small'
@description('Spark pool node count (min 3, max 200).')
@minValue(3)
@maxValue(200)
param sparkPoolNodeCount int = 3
@description('Spark version — 3.4 is current GA at time of writing.')
param sparkPoolSparkVersion string = '3.4'
@description('Idle minutes before the Spark pool auto-pauses (5-10080).')
@minValue(5)
@maxValue(10080)
param sparkPoolAutoPauseDelay int = 15

@description('Enable compute isolation on the Spark pool. Required for IL5 (dedicated physical hosts); incurs additional cost. Leave false for Commercial/GCC.')
param sparkPoolIsolatedCompute bool = false

@description('Dedicated SQL pool name (must match a SQL identifier; no dashes).')
param dedicatedPoolName string = 'loompool'

@description('Dedicated SQL pool SKU. DW100c = ~$1.20/hr running, storage only when paused.')
@allowed(['DW100c', 'DW200c', 'DW300c', 'DW400c', 'DW500c', 'DW1000c', 'DW1500c'])
param dedicatedPoolSku string = 'DW100c'

@description('Collation for the Dedicated pool.')
param dedicatedPoolCollation string = 'SQL_Latin1_General_CP1_CI_AS'

@description('Provision the Dedicated pool paused on creation (recommended — Loom resumes on demand from the editor).')
param dedicatedPoolStartPaused bool = true

@description('Dedicated pool backup storage redundancy. Some subscriptions block GRS via policy (Azure SQL Database Block Geo-redundant Backup Storage); LRS works everywhere.')
@allowed(['LRS', 'ZRS', 'GRS'])
param dedicatedPoolStorageRedundancy string = 'LRS'

// =====================================================================
// v2.0 — Private endpoint params
// =====================================================================

@description('Spoke private-endpoint subnet ID (snet-private-endpoints).')
param privateEndpointSubnetId string = ''

@description('Private DNS zone resource ID for privatelink.sql.azuresynapse.net. Must be linked to both spoke + hub VNets.')
param synapseSqlPrivateDnsZoneId string = ''

@description('Private DNS zone resource ID for privatelink.dev.azuresynapse.net (used by Synapse Studio embed). Optional.')
param synapseDevPrivateDnsZoneId string = ''

// =====================================================================
// Workspace
// =====================================================================

resource synapseWs 'Microsoft.Synapse/workspaces@2021-06-01' = {
  name: 'syn-loom-${domainName}-${location}'
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    defaultDataLakeStorage: {
      accountUrl: 'https://${defaultStorageAccountName}.dfs.${environment().suffixes.storage}'
      filesystem: defaultFileSystemName
    }
    managedVirtualNetwork: managedVnet ? 'default' : ''
    publicNetworkAccess: 'Disabled'
    managedVirtualNetworkSettings: managedVnet ? {
      preventDataExfiltration: true
      allowedAadTenantIdsForLinking: [subscription().tenantId]
    } : null
  }
}

// =====================================================================
// Spark pool — backs the Notebook + Spark job definition editors.
// Auto-pause + autoscale keep cost low; first cold-start ≈ 60-90s.
// =====================================================================

resource sparkPool 'Microsoft.Synapse/workspaces/bigDataPools@2021-06-01' = if (deploySparkPool) {
  parent: synapseWs
  name: sparkPoolName
  location: location
  tags: complianceTags
  properties: {
    nodeSizeFamily: 'MemoryOptimized'
    nodeSize: sparkPoolNodeSize
    nodeCount: sparkPoolNodeCount
    autoScale: {
      enabled: true
      minNodeCount: 3
      maxNodeCount: 10
    }
    autoPause: {
      enabled: true
      delayInMinutes: sparkPoolAutoPauseDelay
    }
    sparkVersion: sparkPoolSparkVersion
    isComputeIsolationEnabled: sparkPoolIsolatedCompute
    // Session-level packages MUST be enabled so the spark-environment item
    // (F18) can install pip/conda packages at session scope and bake
    // libraryRequirements onto the pool on publish. The Loom console flips
    // this on publish too, but enabling it here avoids a first-publish race.
    sessionLevelPackagesEnabled: true
    dynamicExecutorAllocation: {
      enabled: true
      minExecutors: 1
      maxExecutors: 9
    }
  }
}

// =====================================================================
// Dedicated SQL pool (v2.0)
// =====================================================================

resource dedicatedPool 'Microsoft.Synapse/workspaces/sqlPools@2021-06-01' = if (deployDedicatedPool) {
  parent: synapseWs
  name: dedicatedPoolName
  location: location
  tags: complianceTags
  sku: {
    name: dedicatedPoolSku
  }
  properties: {
    collation: dedicatedPoolCollation
    createMode: 'Default'
    storageAccountType: dedicatedPoolStorageRedundancy
  }
}

// Diagnostic settings on the Dedicated pool — separate from workspace
// because pool-level diagnostic categories differ from workspace.
resource dedicatedPoolDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (deployDedicatedPool && !empty(workspaceId)) {
  scope: dedicatedPool
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'SqlRequests', enabled: true }
      { category: 'RequestSteps', enabled: true }
      { category: 'ExecRequests', enabled: true }
      { category: 'DmsWorkers', enabled: true }
      { category: 'Waits', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// =====================================================================
// Firewall rules
// =====================================================================

resource fwAllowAzure 'Microsoft.Synapse/workspaces/firewallRules@2021-06-01' = if (allowAzureServices) {
  parent: synapseWs
  name: 'AllowAllWindowsAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// Firewall rules — only when public network access is enabled.
// publicNetworkAccess=Disabled (the default here) blocks the
// firewall-rules API entirely; VNet does the isolation instead.
@batchSize(1)
resource fw 'Microsoft.Synapse/workspaces/firewallRules@2021-06-01' = [for rule in firewallRules: if (managedVnet == false) {
  parent: synapseWs
  name: rule.name
  properties: {
    startIpAddress: rule.startIpAddress
    endIpAddress: rule.endIpAddress
  }
}]

// =====================================================================
// AAD admin assignment
//   - Entra admin group (browser/portal access)
//   - OR Loom Console UAMI (so the BFF can authenticate via
//     DefaultAzureCredential). Workspace-level `administrators` resource
//     only supports ONE entry, so we pick the Console UAMI when set
//     (BFF requires it for v2.0) and fall back to the admin group.
// =====================================================================

// SID for a managed-identity SQL AAD admin MUST be the UAMI's CLIENT (application)
// id, not its objectId/principalId. SQL authenticates the BFF by matching the
// access-token appid against this SID; using the principalId makes serverless
// CREATE DATABASE fail with ELOGIN ("Login failed for user
// '<token-identified principal>'"). Prefer consoleUamiAppId; fall back to the
// principalId only for legacy callers that don't thread the appId yet.
var consoleAadAdminSid = !empty(consoleUamiAppId) ? consoleUamiAppId : consolePrincipalId

resource consoleAadAdmin 'Microsoft.Synapse/workspaces/administrators@2021-06-01' = if (!empty(consolePrincipalId) && !empty(consoleUamiName)) {
  parent: synapseWs
  name: 'activeDirectory'
  properties: {
    administratorType: 'ServicePrincipal'
    login: consoleUamiName
    sid: consoleAadAdminSid
    tenantId: subscription().tenantId
  }
}

// The Console UAMI being the workspace Microsoft Entra admin (above) gives the
// SQL granular-security wizards (F11 — object/column GRANT, RLS, DDM) the
// server-level admin they need. To execute the per-database security DDL the
// UAMI must also be a db_owner contained user in each user database — run the
// one-time bootstrap: platform/fiab/bootstrap/sql-security-bootstrap.sql
// (pass LOOM_CONSOLE_UAMI_NAME = consoleUamiName). No new ARM resource is
// required; this is an honest in-database grant per .claude/rules/no-vaporware.md.

resource groupAadAdmin 'Microsoft.Synapse/workspaces/administrators@2021-06-01' = if (empty(consolePrincipalId) && !empty(adminEntraGroupId)) {
  parent: synapseWs
  name: 'activeDirectory'
  properties: {
    administratorType: 'Group'
    login: 'admins'
    sid: adminEntraGroupId
    tenantId: subscription().tenantId
  }
}

// Console UAMI needs ARM Contributor on the workspace so the BFF can
// call /sqlPools/<pool>/pause and /resume (and read pool state) for
// the resume-on-demand UX from the Dedicated editor.
resource consoleArmContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: synapseWs
  name: guid(synapseWs.id, consolePrincipalId, 'b24988ac-6180-42a0-ab88-20f7382dd24c')
  properties: {
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
    // Contributor — covers sqlPools/pause + /resume + read
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
  }
}

// Synapse workspace MSI needs "Storage Blob Data Contributor" on its DEFAULT
// ADLS Gen2 storage account, or Spark fails to init the Hive metastore
// (HiveExternalCatalog.createDatabase → InvalidAbfsRestOperationException). The
// grant is scoped to the storage account's RG (may differ from the workspace's).
@description('Resource group of the default Synapse storage account (defaults to this RG).')
param defaultStorageResourceGroup string = resourceGroup().name

@description('Grant the Synapse workspace MSI Storage Blob Data Contributor on the default SA (needed for Spark Hive metastore). Disable only if granted out-of-band.')
param grantSynapseStorageRole bool = true

@description('Shared ADX cluster system-assigned MI principal id. When set, granted Storage Blob Data Reader on the lakehouse storage account so the Eventhouse Delta-endpoint (.create external table kind=delta) can read this lakehouse over managed identity. Empty = skip.')
param adxClusterPrincipalId string = ''

@description('OPTIONAL — separate ADLS Gen2 account hosting the mirror Bronze container (split-DLZ topology). When set, the Synapse workspace MSI is granted Storage Blob Data Reader on it so the mirror-paired Serverless SQL analytics endpoint can OPENROWSET mirrored CSV. Empty = skip (mirror Bronze == default SA is already Contributor-granted).')
param mirrorBronzeStorageAccountName string = ''

@description('Grant the Console UAMI Storage Blob Data Contributor on the lakehouse SA so the built-in mirrored-database engine can write Bronze snapshot CSV (no-Fabric default). Defaults true.')
param consolePrincipalNeedsContributor bool = true

module synapseStorageRbac 'synapse-storage-rbac.bicep' = if (grantSynapseStorageRole && !skipRoleGrants) {
  name: 'synapse-storage-rbac-${domainName}'
  scope: resourceGroup(defaultStorageResourceGroup)
  params: {
    defaultStorageAccountName: defaultStorageAccountName
    synapseManagedIdentityPrincipalId: synapseWs.identity.principalId
    // Console UAMI gets Storage Blob Data Reader on the lakehouse SA so the BFF
    // live Tables catalog scan can read _delta_log without Contributor.
    consolePrincipalId: skipRoleGrants ? '' : consolePrincipalId
    // Shared ADX cluster MI gets Storage Blob Data Reader so the Eventhouse
    // Delta endpoint (external table kind=delta) can read this lakehouse.
    adxClusterPrincipalId: skipRoleGrants ? '' : adxClusterPrincipalId
    // F7 — when OneLake Security is enabled, the Console UAMI also gets Storage
    // Blob Data Owner so the Security tab can set ACLs on behalf of role members.
    consolePrincipalNeedsOwner: loomOnelakeSecurityEnabled
    // Mirror-paired SQL analytics endpoint — only needed in the split-DLZ
    // topology (separate mirror Bronze account); empty = skip (common topology
    // is already covered by the default-SA Contributor grant above).
    mirrorBronzeStorageAccountName: mirrorBronzeStorageAccountName
    // Mirrored-database engine writes Bronze snapshot CSV as the Console UAMI
    // (no-Fabric default backend) → needs Storage Blob Data Contributor.
    consolePrincipalNeedsContributor: skipRoleGrants ? false : consolePrincipalNeedsContributor
  }
}

// =====================================================================
// Synapse RBAC roles (data plane) — Workspace Admin + SQL Admin
// =====================================================================

@description('Synapse data-plane RBAC role assignments to apply post-deploy via deployment-script. Requires synapseRoleAssignmentUamiId to be a valid UAMI resource ID.')
param synapseDataPlaneRoles array = []

@description('UAMI resource ID with Synapse Administrator role pre-assigned, used by the role-assignment deployment script. When empty, the script is skipped.')
param synapseRoleAssignmentUamiId string = ''

// =====================================================================
// Deployment-script staging storage account
//   Azure deploymentScripts stage their script + outputs on a storage
//   account that the backing Azure Container Instance mounts as a FILE
//   SHARE — and the ONLY way ACI can mount a file share is via a SHARED
//   KEY. A DLZ subscription commonly enforces `allowSharedKeyAccess=false`
//   (Azure Policy), so the script service's auto-created SA (or any data
//   SA) rejects key auth and the script fails on a clean dlz-attach deploy
//   with `KeyBasedAuthenticationNotPermitted (403)`.
//
//   Fix: stand up a small DEDICATED staging SA that explicitly ALLOWS
//   shared-key access (it only ever holds the throwaway script file share
//   + log blobs, never data) and point each deploymentScript at it via the
//   `storageAccountSettings` property. Per Learn
//   (deployment-script-template#use-existing-storage-account):
//     - kind must be Storage/StorageV2 (StorageV2 here)
//     - allowSharedKeyAccess MUST be true
//     - storage firewall rules are NOT supported → public network access on
//     - the deploying principal needs listKeys on the SA (it has Contributor
//       on this RG via the deployment), which is how storageAccountKey below
//       is supplied. The script UAMI mounts via that key, so it needs no
//       extra RBAC on this SA — keeping the grant minimal.
// =====================================================================

// True when ANY of the three role-grant deployment scripts in this module will
// be created — only then do we need (and pay for) the staging SA. The
// artifact-publisher + spark-submit scripts both gate on consolePrincipalId;
// the role-assignment script gates on data-plane-roles + admin group.
var anyConsoleScript = !empty(consolePrincipalId)
var anyRolesScript = length(synapseDataPlaneRoles) > 0 && !empty(adminEntraGroupId)
var anyDeploymentScript = !empty(synapseRoleAssignmentUamiId) && !skipRoleGrants && (anyConsoleScript || anyRolesScript)

var scriptStagingSaName = take('sadsloom${replace(domainName, '-', '')}${uniqueString(resourceGroup().id, 'synapse-script-staging')}', 24)

resource scriptStagingStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = if (anyDeploymentScript) {
  name: scriptStagingSaName
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    // REQUIRED for deploymentScripts — ACI mounts the staging file share via a
    // shared key. This SA holds only ephemeral script staging (never data), so
    // allowing shared-key access here does NOT weaken the data-plane posture.
    allowSharedKeyAccess: true
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    // deploymentScripts do not support storage firewall rules (Learn), so the
    // staging SA keeps default public network access; it carries no data.
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

// storageAccountSettings block reused by all three deployment scripts below.
// storageAccountKey is only dereferenced when the SA exists (anyDeploymentScript),
// which is exactly the condition under which the consuming scripts deploy — so
// the BCP422 "resource may not exist" advisory is a false positive here.
var scriptStorageSettings = {
  storageAccountName: scriptStagingSaName
  #disable-next-line BCP422
  storageAccountKey: anyDeploymentScript ? scriptStagingStorage.listKeys().keys[0].value : ''
}

resource roleAssignmentScript 'Microsoft.Resources/deploymentScripts@2023-08-01' = if (length(synapseDataPlaneRoles) > 0 && !empty(synapseRoleAssignmentUamiId) && !empty(adminEntraGroupId)) {
  name: 'apply-synapse-roles-${domainName}'
  location: location
  tags: complianceTags
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${synapseRoleAssignmentUamiId}': {}
    }
  }
  properties: {
    azCliVersion: '2.64.0'
    retentionInterval: 'PT1H'
    timeout: 'PT30M'
    // Stage on the dedicated shared-key-enabled SA so this does not hit
    // KeyBasedAuthenticationNotPermitted on a DLZ that denies shared-key access.
    storageAccountSettings: scriptStorageSettings
    arguments: '${synapseWs.name} ${adminEntraGroupId} "${join(synapseDataPlaneRoles, ',')}"'
    scriptContent: '''
WORKSPACE=$1
PRINCIPAL=$2
ROLES_CSV=$3
IFS=',' read -ra ROLES <<< "$ROLES_CSV"
for role in "${ROLES[@]}"; do
  echo "Assigning Synapse role '$role' to $PRINCIPAL on $WORKSPACE..."
  az synapse role assignment create \
    --workspace-name "$WORKSPACE" \
    --role "$role" \
    --assignee-object-id "$PRINCIPAL" \
    --assignee-principal-type Group \
    || echo "  (already assigned or insufficient permissions; review the deployment-script output)"
done
'''
  }
}

// Grant the Loom Console UAMI the Synapse data-plane role "Synapse Compute
// Operator" scoped to the loompool Spark pool so it can submit Livy interactive
// sessions + notebook statements (F16 — per-cell execution). This is a Synapse
// RBAC role (data plane), NOT an ARM IAM role — it must be applied via
// `az synapse role assignment create`, not Microsoft.Authorization/roleAssignments.
//
// Synapse Compute Operator allows the UAMI to: submit + cancel Spark jobs /
// notebooks and view pool logs. It does NOT grant artifact publish/delete or
// SQL pool access (those stay with Synapse Administrator / SQL admin).
//
// Requires synapseRoleAssignmentUamiId to already hold Synapse Administrator
// (the same prerequisite as roleAssignmentScript above).
resource consoleSparkSubmitRoleScript 'Microsoft.Resources/deploymentScripts@2023-08-01' = if (!empty(consolePrincipalId) && deploySparkPool && !empty(synapseRoleAssignmentUamiId) && !skipRoleGrants) {
  name: 'assign-console-spark-submit-${domainName}'
  location: location
  tags: complianceTags
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${synapseRoleAssignmentUamiId}': {}
    }
  }
  properties: {
    azCliVersion: '2.64.0'
    retentionInterval: 'PT1H'
    timeout: 'PT15M'
    // Stage on the dedicated shared-key-enabled SA (DLZ may deny shared-key on data SAs).
    storageAccountSettings: scriptStorageSettings
    arguments: '${synapseWs.name} ${consolePrincipalId} ${sparkPoolName}'
    scriptContent: '''
WORKSPACE=$1
PRINCIPAL=$2
POOL=$3
echo "Assigning 'Synapse Compute Operator' to SP $PRINCIPAL on $WORKSPACE/bigDataPools/$POOL..."
az synapse role assignment create \
  --workspace-name "$WORKSPACE" \
  --role "Synapse Compute Operator" \
  --assignee-object-id "$PRINCIPAL" \
  --assignee-principal-type ServicePrincipal \
  --scope "workspaces/${WORKSPACE}/bigDataPools/${POOL}" \
  || echo "  (already assigned or insufficient permissions — verify manually)"
'''
  }
  dependsOn: [ sparkPool ]
}

// Grant the Loom Console UAMI the Synapse data-plane role "Synapse Artifact
// Publisher" scoped to the WHOLE workspace so it can create / edit / delete
// workspace artifacts — specifically KQL scripts
// (Microsoft.Synapse/workspaces/kqlScripts/write,delete) and Spark job
// definitions (.../sparkJobDefinitions/write,delete), which back the workspace
// tree's KQL + SJD create/open/delete affordances. This is a Synapse RBAC role
// (data plane), NOT an ARM IAM role — it must be applied via
// `az synapse role assignment create`, not Microsoft.Authorization/roleAssignments.
//
// Without this grant the artifact CRUD path (synapse-artifacts-client upsert /
// delete, run from the console UAMI) 403s even though the UI renders — the
// SQL-AAD-admin assignment (workspaces/administrators) and ARM Contributor do
// NOT confer Synapse-RBAC artifact publish rights. Synapse Administrator would
// also work but is broader than needed; Artifact Publisher is the least-privilege
// role for KQL/SJD authoring (Learn: synapse-workspace-synapse-rbac-roles).
//
// Requires synapseRoleAssignmentUamiId to already hold Synapse Administrator
// (same prerequisite as the role scripts above).
resource consoleArtifactPublisherRoleScript 'Microsoft.Resources/deploymentScripts@2023-08-01' = if (!empty(consolePrincipalId) && !empty(synapseRoleAssignmentUamiId) && !skipRoleGrants) {
  name: 'assign-console-artifact-publisher-${domainName}'
  location: location
  tags: complianceTags
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${synapseRoleAssignmentUamiId}': {}
    }
  }
  properties: {
    azCliVersion: '2.64.0'
    retentionInterval: 'PT1H'
    timeout: 'PT15M'
    // Stage on the dedicated shared-key-enabled SA (DLZ may deny shared-key on data SAs).
    storageAccountSettings: scriptStorageSettings
    arguments: '${synapseWs.name} ${consolePrincipalId}'
    scriptContent: '''
WORKSPACE=$1
PRINCIPAL=$2
echo "Assigning 'Synapse Artifact Publisher' to SP $PRINCIPAL on $WORKSPACE (workspace scope)..."
az synapse role assignment create \
  --workspace-name "$WORKSPACE" \
  --role "Synapse Artifact Publisher" \
  --assignee-object-id "$PRINCIPAL" \
  --assignee-principal-type ServicePrincipal \
  || echo "  (already assigned or insufficient permissions — verify manually)"
'''
  }
}

// Grant the Loom Console UAMI the Synapse data-plane role "Synapse SQL
// Administrator" (roleDefinition 7af0c69a-a548-47d6-aea3-d00e69bd83aa) so it can
// run CREATE DATABASE / DDL against the Serverless SQL (-ondemand) endpoint —
// the operation the lakehouse provisioner's `synapse-serverless-sql-pool` step
// performs. Without it that step fails LIVE with:
//   "Synapse Serverless rejected CREATE DATABASE: Login failed for user
//    '<token-identified principal>'."
//
// WHY the other grants are NOT enough:
//   - Setting the workspace AAD admin via ARM (workspaces/administrators,
//     sid = objectId OR appId) does NOT create a working serverless login for a
//     managed identity. Synapse cannot fetch the application id from Microsoft
//     Graph when it provisions a login for another SPI/app — a documented known
//     limitation. (Learn: resources-self-help-sql-on-demand#security —
//     "Microsoft Entra service principal sign-in failures when SPI creates a
//     role assignment".)
//   - Synapse Artifact Publisher + Compute Operator are artifact/compute roles;
//     neither confers SQL CONTROL SERVER on the serverless endpoint.
//
// WHY THIS MECHANISM (Learn Solution 3, not Solution 1 or 2):
//   - Solution 1 (portal/Studio "Access control") relies on a *user's* delegated
//     Graph permissions to resolve the app id — not available to this script,
//     which runs AS an SPI (synapseRoleAssignmentUamiId).
//   - Solution 2 (CREATE LOGIN ... FROM EXTERNAL PROVIDER on the -ondemand
//     endpoint) resolves the app id server-side, but the serverless SQL endpoint
//     is publicNetworkAccess=Disabled behind the managed VNet here, so a
//     deploymentScript container cannot reach it without VNet injection.
//   - Solution 3 — `New-AzSynapseRoleAssignment -RoleDefinitionName
//     "Synapse SQL Administrator" -ObjectId <APP/client id>` — passes the
//     APPLICATION id in -ObjectId, which is exactly what makes the serverless
//     login resolvable (it sidesteps the Graph fetch). It targets the Synapse
//     MANAGEMENT/dev endpoint (reachable from the container, like the existing
//     `az synapse role assignment create` scripts above), so it works with the
//     SQL data-plane endpoints locked down. NOTE: `az synapse role assignment
//     create --assignee-object-id <appId>` rejects an app id as
//     InvalidPrincipalId, so the CLI object-id path CANNOT be used for the app-id
//     workaround — Az PowerShell is required.
//
// Per the Learn Note we also add the grant by OBJECT id so the Synapse Studio
// "Access control" UI displays the assignment (the app-id grant is the one that
// makes the serverless login work, but it is not surfaced in the UI).
//
// Requires consoleUamiAppId (the APP/client id) and synapseRoleAssignmentUamiId
// (already holding Synapse Administrator, same prerequisite as the scripts above).
// PROVEN LIVE: granting Synapse SQL Administrator to the console UAMI made
// serverless CREATE DATABASE succeed on the DLZ Synapse workspace.
resource consoleSqlAdminRoleScript 'Microsoft.Resources/deploymentScripts@2023-08-01' = if (!empty(consolePrincipalId) && !empty(consoleUamiAppId) && !empty(synapseRoleAssignmentUamiId) && !skipRoleGrants) {
  name: 'assign-console-sql-admin-${domainName}'
  location: location
  tags: complianceTags
  kind: 'AzurePowerShell'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${synapseRoleAssignmentUamiId}': {}
    }
  }
  properties: {
    azPowerShellVersion: '11.5'
    retentionInterval: 'PT1H'
    timeout: 'PT15M'
    arguments: '-Workspace ${synapseWs.name} -ConsoleAppId ${consoleUamiAppId} -ConsoleObjectId ${consolePrincipalId}'
    scriptContent: '''
param([string]$Workspace, [string]$ConsoleAppId, [string]$ConsoleObjectId)
$ErrorActionPreference = 'Continue'
$role = 'Synapse SQL Administrator'

# Primary grant — by APPLICATION (client) id. This is what makes the serverless
# login resolvable; granting by object id alone yields a broken login because
# Synapse can't fetch the app id from Graph when an SPI grants to another SPI.
Write-Host "Granting '$role' to console UAMI by APP id $ConsoleAppId on $Workspace (functional serverless login)..."
try {
  New-AzSynapseRoleAssignment -WorkspaceName $Workspace -RoleDefinitionName $role -ObjectId $ConsoleAppId -ErrorAction Stop | Out-Null
  Write-Host "  OK (app id)"
} catch {
  if ($_.Exception.Message -match 'Conflict|already exists|RoleAssignmentAlreadyExists') {
    Write-Host "  Already assigned (app id) — no-op"
  } else {
    Write-Warning "  app-id grant failed: $($_.Exception.Message)"
  }
}

# Secondary grant — by OBJECT id, so Synapse Studio Access control UI shows it.
Write-Host "Granting '$role' to console UAMI by OBJECT id $ConsoleObjectId on $Workspace (UI visibility)..."
try {
  New-AzSynapseRoleAssignment -WorkspaceName $Workspace -RoleDefinitionName $role -ObjectId $ConsoleObjectId -ErrorAction Stop | Out-Null
  Write-Host "  OK (object id)"
} catch {
  if ($_.Exception.Message -match 'Conflict|already exists|RoleAssignmentAlreadyExists') {
    Write-Host "  Already assigned (object id) — no-op"
  } else {
    Write-Warning "  object-id grant failed (non-fatal): $($_.Exception.Message)"
  }
}

$DeploymentScriptOutputs = @{ role = $role; appId = $ConsoleAppId }
'''
  }
}

// =====================================================================
// Server-level SQL audit (sends events to LAW)
// =====================================================================

resource audit 'Microsoft.Synapse/workspaces/auditingSettings@2021-06-01' = {
  parent: synapseWs
  name: 'default'
  properties: {
    state: 'Enabled'
    isAzureMonitorTargetEnabled: true
    auditActionsAndGroups: [
      'BATCH_COMPLETED_GROUP'
      'SUCCESSFUL_DATABASE_AUTHENTICATION_GROUP'
      'FAILED_DATABASE_AUTHENTICATION_GROUP'
      'DATABASE_PERMISSION_CHANGE_GROUP'
      'SCHEMA_OBJECT_CHANGE_GROUP'
    ]
    retentionDays: auditRetentionDays
    isStorageSecondaryKeyInUse: false
    queueDelayMs: 4000
  }
}

resource extendedAudit 'Microsoft.Synapse/workspaces/extendedAuditingSettings@2021-06-01' = {
  parent: synapseWs
  name: 'default'
  properties: {
    state: 'Enabled'
    isAzureMonitorTargetEnabled: true
    retentionDays: auditRetentionDays
  }
  dependsOn: [ audit ]
}

// =====================================================================
// Private endpoints (v2.0) — Sql (Dedicated) + SqlOnDemand (Serverless)
//   On spoke snet-private-endpoints; DNS auto-registered into the shared
//   privatelink.sql.azuresynapse.net zone (linked to hub + spoke).
//   Reachable from Loom Console via hub→spoke VNet peering.
// =====================================================================

resource peSql 'Microsoft.Network/privateEndpoints@2024-03-01' = if (!empty(privateEndpointSubnetId)) {
  name: 'pe-syn-loom-${domainName}-sql'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'syn-sql'
        properties: {
          privateLinkServiceId: synapseWs.id
          groupIds: [ 'Sql' ]
        }
      }
    ]
  }
}

resource peSqlOnDemand 'Microsoft.Network/privateEndpoints@2024-03-01' = if (!empty(privateEndpointSubnetId)) {
  name: 'pe-syn-loom-${domainName}-sqlondemand'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'syn-sql-ondemand'
        properties: {
          privateLinkServiceId: synapseWs.id
          groupIds: [ 'SqlOnDemand' ]
        }
      }
    ]
  }
}

resource peDev 'Microsoft.Network/privateEndpoints@2024-03-01' = if (!empty(privateEndpointSubnetId) && !empty(synapseDevPrivateDnsZoneId)) {
  name: 'pe-syn-loom-${domainName}-dev'
  location: location
  tags: complianceTags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'syn-dev'
        properties: {
          privateLinkServiceId: synapseWs.id
          groupIds: [ 'Dev' ]
        }
      }
    ]
  }
}

resource peSqlDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-03-01' = if (!empty(privateEndpointSubnetId) && !empty(synapseSqlPrivateDnsZoneId)) {
  parent: peSql
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'privatelink-sql-azuresynapse-net'
        properties: { privateDnsZoneId: synapseSqlPrivateDnsZoneId }
      }
    ]
  }
}

resource peSqlOnDemandDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-03-01' = if (!empty(privateEndpointSubnetId) && !empty(synapseSqlPrivateDnsZoneId)) {
  parent: peSqlOnDemand
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'privatelink-sql-azuresynapse-net'
        properties: { privateDnsZoneId: synapseSqlPrivateDnsZoneId }
      }
    ]
  }
}

resource peDevDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-03-01' = if (!empty(privateEndpointSubnetId) && !empty(synapseDevPrivateDnsZoneId)) {
  parent: peDev
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'privatelink-dev-azuresynapse-net'
        properties: { privateDnsZoneId: synapseDevPrivateDnsZoneId }
      }
    ]
  }
}

// =====================================================================
// Diagnostic settings → standardized Loom LAW
// =====================================================================

resource diagInner 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: synapseWs
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'SynapseRbacOperations', enabled: true }
      { category: 'GatewayApiRequests', enabled: true }
      { category: 'BuiltinSqlReqsEnded', enabled: true }
      { category: 'IntegrationPipelineRuns', enabled: true }
      { category: 'IntegrationActivityRuns', enabled: true }
      { category: 'IntegrationTriggerRuns', enabled: true }
      { category: 'SQLSecurityAuditEvents', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

output synapseWorkspaceId string = synapseWs.id
output synapseWorkspaceName string = synapseWs.name
output synapseServerlessSqlEndpoint string = synapseWs.properties.connectivityEndpoints.sqlOnDemand
output synapseSqlEndpoint string = synapseWs.properties.connectivityEndpoints.sql
output synapseDevEndpoint string = synapseWs.properties.connectivityEndpoints.dev
output synapseManagedIdentityPrincipalId string = synapseWs.identity.principalId
output dedicatedPoolName string = deployDedicatedPool ? dedicatedPool.name : ''
output dedicatedPoolId string = deployDedicatedPool ? dedicatedPool.id : ''
output sparkPoolName string = deploySparkPool ? sparkPool.name : ''
output sparkPoolId string = deploySparkPool ? sparkPool.id : ''
output consoleSparkSubmitRoleAssigned bool = !empty(consolePrincipalId) && deploySparkPool && !empty(synapseRoleAssignmentUamiId) && !skipRoleGrants
output consoleArtifactPublisherRoleAssigned bool = !empty(consolePrincipalId) && !empty(synapseRoleAssignmentUamiId) && !skipRoleGrants
output consoleSqlAdminRoleAssigned bool = !empty(consolePrincipalId) && !empty(consoleUamiAppId) && !empty(synapseRoleAssignmentUamiId) && !skipRoleGrants
