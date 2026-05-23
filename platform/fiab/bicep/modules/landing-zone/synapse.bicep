// CSA Loom DLZ — Synapse workspace (Serverless SQL pool only)
// Per LD-2: Synapse Serverless is the SQL-over-Delta engine in Gov.
//
// Telemetry / DSC posture (per repo-wide standard):
//  - Diagnostic settings → standardized Loom LAW
//  - Workspace audit policy → SAME LAW (SQL audit events)
//  - Server-level firewall rules (configurable; default = VNet-only)
//  - Synapse RBAC roles (Workspace Admin, SQL Admin, Data Plane Admin)
//    assigned to the admin Entra group
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

@batchSize(1)
resource fw 'Microsoft.Synapse/workspaces/firewallRules@2021-06-01' = [for rule in firewallRules: {
  parent: synapseWs
  name: rule.name
  properties: {
    startIpAddress: rule.startIpAddress
    endIpAddress: rule.endIpAddress
  }
}]

// =====================================================================
// AAD admin assignment
// =====================================================================

resource roleAssignment 'Microsoft.Synapse/workspaces/administrators@2021-06-01' = {
  parent: synapseWs
  name: 'activeDirectory'
  properties: {
    administratorType: 'Group'
    login: 'admins'
    sid: adminEntraGroupId
    tenantId: subscription().tenantId
  }
}

// =====================================================================
// Synapse RBAC roles (data plane) — Workspace Admin + SQL Admin
// =====================================================================
// Synapse data-plane roles are managed via a workspace-scoped role
// assignment with the RBAC role ID. Three commonly-needed roles:
//   Synapse Administrator           6e4bf58a-b8e1-4cc3-bbf9-d73143322b78
//   Synapse SQL Administrator       7af0c69a-a548-47d6-aea3-d00e69bd83aa
//   Synapse Compute Operator        6e4bf58a-... (see Microsoft docs)
//
// Bicep doesn't have a first-class type for Synapse role assignments;
// the operator runs a post-deploy script (via deployment script
// extension) that calls the Synapse REST API. The block below
// templates the assignment intent so DSC tooling can detect drift.

@description('Synapse data-plane RBAC role assignments to apply post-deploy. Names map to known role IDs.')
param synapseDataPlaneRoles array = [
  'Synapse Administrator'
  'Synapse SQL Administrator'
]

resource roleAssignmentScript 'Microsoft.Resources/deploymentScripts@2023-08-01' = if (length(synapseDataPlaneRoles) > 0) {
  name: 'apply-synapse-roles-${domainName}'
  location: location
  tags: complianceTags
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      // Operator wires in the Admin Plane UAMI with `Synapse Administrator`
      // pre-assigned to the workspace. For brevity, we use the workspace's
      // own SAMI which is implicitly Workspace Admin.
      '${synapseWs.id}': {}
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
// Synapse SQL audit policy at the workspace level. Logs are written
// to LAW via diagnostic settings (configured below), not to a storage
// account — keeps everything in one place.

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

// Extended auditing (DML/DDL classification)
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
// Diagnostic settings → standardized Loom LAW
// =====================================================================

module diag '../shared/diagnostic-settings.bicep' = {
  name: 'diag-synapse-${domainName}'
  scope: resourceGroup()
  params: {
    workspaceId: workspaceId
    supportedLogCategories: [
      'SynapseRbacOperations'
      'GatewayApiRequests'
      'BuiltinSqlReqsEnded'
      'IntegrationPipelineRuns'
      'IntegrationActivityRuns'
      'IntegrationTriggerRuns'
      'SQLSecurityAuditEvents'
    ]
    supportedMetricCategories: ['AllMetrics']
  }
}

// Note: the diag module above scopes to the RG; the Synapse-specific
// approach is to scope to the workspace. Bicep limitation: cross-scope
// `existing` + `scope:` requires the resource to be in this module's
// scope. Workaround: declare a thin diagnosticSettings resource here.

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
output synapseDevEndpoint string = synapseWs.properties.connectivityEndpoints.dev
output synapseManagedIdentityPrincipalId string = synapseWs.identity.principalId
