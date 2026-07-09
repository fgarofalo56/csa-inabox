// CSA Loom — Admin-plane performance-benchmark export (PSR-1, OPTIONAL)
//
// Provisions the Azure Monitor Logs-Ingestion pipeline that carries every
// benchmark metric row (Spark attach, warehouse/ADX query, dashboard tile TTI,
// Copilot turn, page TTI) into the LoomPerf_CL custom table on the Loom Log
// Analytics workspace, so perf trends can be queried in KQL alongside platform
// telemetry (Sentinel / workbooks) and correlated with load.
//
// This is STRICTLY ADDITIVE. The authoritative trend store is the Cosmos
// `perf-benchmarks` container (created lazily by the console — no ARM step),
// which the /admin/performance page reads. The app-side exporter
// (lib/perf/perf-export.ts) honest-gates to a silent no-op until this module's
// outputs (LOOM_PERF_DCR_ENDPOINT / LOOM_PERF_DCR_ID) are set on the Console
// app, so nothing is ever blocked when the pipeline is absent.
//
// Mirrors platform/fiab/bicep/modules/admin-plane/audit-stream.bicep (the
// BR-SIEM LoomAudit_CL pipeline). Grounded in Microsoft Learn — "Logs Ingestion
// API in Azure Monitor" + "Tutorial: Send data to Azure Monitor Logs (ARM)".
//
// Not wired into an orchestrator (opt-in + admin-plane/main.bicep is at the
// 256-param ceiling); deploy out-of-band:
//   az deployment group create -g <admin-rg> \
//     -f platform/fiab/bicep/modules/admin-plane/perf-benchmarks-dcr.bicep \
//     -p location=<loc> complianceTags='{}' lawName=<law> consolePrincipalId=<uami-principal>
// then set the two outputs on the Console app env.

targetScope = 'resourceGroup'

@description('Primary region — also used to name the DCE/DCR.')
param location string

@description('Compliance tags applied to every resource.')
param complianceTags object

@description('Name of the existing Log Analytics workspace (monitoring.bicep output lawName).')
param lawName string

@description('Console UAMI principalId — granted Monitoring Metrics Publisher on the DCR so it can POST perf rows. Empty string skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('LoomPerf_CL retention (days).')
@minValue(4)
@maxValue(730)
param retentionDays int = 180

// Columns for the custom table + the DCR input stream. TimeGenerated is the
// required Azure-Monitor timestamp; the rest map 1:1 to the LoomPerfRow shape
// emitted by lib/perf/perf-export.ts.
var perfColumns = [
  { name: 'TimeGenerated', type: 'datetime' }
  { name: 'RunId', type: 'string' }
  { name: 'GitSha', type: 'string' }
  { name: 'Rev', type: 'string' }
  { name: 'Metric', type: 'string' }
  { name: 'Backend', type: 'string' }
  { name: 'P50', type: 'real' }
  { name: 'P95', type: 'real' }
  { name: 'P99', type: 'real' }
  { name: 'ColdMs', type: 'real' }
  { name: 'WarmMs', type: 'real' }
  { name: 'Gated', type: 'boolean' }
  { name: 'TenantId', type: 'string' }
]

// Existing Loom Log Analytics workspace (deployed by monitoring.bicep).
resource law 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = {
  name: lawName
}

// ── 1. LoomPerf_CL custom table ─────────────────────────────────────────────
resource perfTable 'Microsoft.OperationalInsights/workspaces/tables@2022-10-01' = {
  parent: law
  name: 'LoomPerf_CL'
  properties: {
    totalRetentionInDays: retentionDays
    retentionInDays: retentionDays
    schema: {
      name: 'LoomPerf_CL'
      description: 'CSA Loom performance-benchmark trend rows (PSR-1).'
      columns: perfColumns
    }
  }
}

// ── 2. Data Collection Endpoint ─────────────────────────────────────────────
resource dce 'Microsoft.Insights/dataCollectionEndpoints@2023-03-11' = {
  name: 'dce-loom-perf-${location}'
  location: location
  tags: complianceTags
  properties: {
    networkAcls: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

// ── 3. Data Collection Rule ─────────────────────────────────────────────────
resource dcr 'Microsoft.Insights/dataCollectionRules@2023-03-11' = {
  name: 'dcr-loom-perf-${location}'
  location: location
  tags: complianceTags
  properties: {
    dataCollectionEndpointId: dce.id
    streamDeclarations: {
      'Custom-LoomPerf_CL': {
        columns: perfColumns
      }
    }
    destinations: {
      logAnalytics: [
        {
          workspaceResourceId: law.id
          name: 'loomPerfLaDest'
        }
      ]
    }
    dataFlows: [
      {
        streams: [ 'Custom-LoomPerf_CL' ]
        destinations: [ 'loomPerfLaDest' ]
        transformKql: 'source'
        outputStream: 'Custom-LoomPerf_CL'
      }
    ]
  }
  dependsOn: [
    perfTable
  ]
}

// ── 4. Monitoring Metrics Publisher on the DCR for the Console UAMI ──────────
// Role id 3913510d-42f4-4e42-8a64-420c390055eb — the Logs Ingestion API RBAC
// requirement (grant Monitoring Metrics Publisher on the DCR to the posting
// identity).
resource consoleDcrPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(dcr.id, consolePrincipalId, '3913510d-42f4-4e42-8a64-420c390055eb')
  scope: dcr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('DCE logs-ingestion endpoint → LOOM_PERF_DCR_ENDPOINT on the Console.')
output dceLogsIngestionEndpoint string = dce.properties.logsIngestion.endpoint

@description('DCR immutable id → LOOM_PERF_DCR_ID on the Console.')
output dcrImmutableId string = dcr.properties.immutableId

output dcrId string = dcr.id
output dceId string = dce.id
output perfTableName string = 'LoomPerf_CL'
