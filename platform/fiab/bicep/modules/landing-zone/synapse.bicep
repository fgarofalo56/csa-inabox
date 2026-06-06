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

@description('Loom Console UAMI client ID — used for the SQL admin login name (must be valid AAD object).')
param consoleUamiName string = ''

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

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

@description('Log Analytics workspace ID for diagnostic + audit + telemetry')
param workspaceId string

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
    isComputeIsolationEnabled: false
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
resource dedicatedPoolDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (deployDedicatedPool) {
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

resource consoleAadAdmin 'Microsoft.Synapse/workspaces/administrators@2021-06-01' = if (!empty(consolePrincipalId) && !empty(consoleUamiName)) {
  parent: synapseWs
  name: 'activeDirectory'
  properties: {
    administratorType: 'ServicePrincipal'
    login: consoleUamiName
    sid: consolePrincipalId
    tenantId: subscription().tenantId
  }
}

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

module synapseStorageRbac 'synapse-storage-rbac.bicep' = if (grantSynapseStorageRole && !skipRoleGrants) {
  name: 'synapse-storage-rbac-${domainName}'
  scope: resourceGroup(defaultStorageResourceGroup)
  params: {
    defaultStorageAccountName: defaultStorageAccountName
    synapseManagedIdentityPrincipalId: synapseWs.identity.principalId
  }
}

// =====================================================================
// Synapse RBAC roles (data plane) — Workspace Admin + SQL Admin
// =====================================================================

@description('Synapse data-plane RBAC role assignments to apply post-deploy via deployment-script. Requires synapseRoleAssignmentUamiId to be a valid UAMI resource ID.')
param synapseDataPlaneRoles array = []

@description('UAMI resource ID with Synapse Administrator role pre-assigned, used by the role-assignment deployment script. When empty, the script is skipped.')
param synapseRoleAssignmentUamiId string = ''

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

resource diagInner 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
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
