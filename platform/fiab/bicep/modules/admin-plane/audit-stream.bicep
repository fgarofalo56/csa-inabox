// CSA Loom — Admin-plane SIEM audit stream (Wave-1 BR-SIEM)
//
// Provisions the Azure Monitor Logs-Ingestion pipeline that carries every
// admin-plane mutation (role/permission changes, workspace + domain deletes,
// tenant-settings + env-config writes, MCP-server deploy/teardown, platform
// update-apply) into the LoomAudit_CL custom table on the Loom Log Analytics
// workspace, where Microsoft Sentinel (or any workspace-connected SIEM) alerts
// on it continuously — see docs/fiab/operations/siem-audit-stream.md.
//
// Components (grounded in Microsoft Learn — "Logs Ingestion API in Azure
// Monitor" + "Tutorial: Send data … (Resource Manager templates)"):
//   1. LoomAudit_CL custom table on the existing LAW (9 typed columns).
//   2. Data Collection Endpoint (DCE) — the ingestion host the Console POSTs to.
//   3. Data Collection Rule (DCR) — declares the Custom-LoomAudit_CL input stream
//      and routes it (transformKql `source`) to the LAW table.
//   4. "Monitoring Metrics Publisher" on the DCR for the Console UAMI so its
//      managed identity can POST events (the ingestion-API RBAC requirement).
//
// Default-ON posture (WAVES.md global principle): the pipeline deploys with the
// rest of the monitoring stack — no enablement param. The app-side emitter still
// honest-gates to a silent no-op until LOOM_AUDIT_DCR_ENDPOINT / LOOM_AUDIT_DCR_ID
// are set (this module's outputs), so there is never a hard block. No new
// admin-plane/main.bicep param is introduced (it is at the 256-param ceiling):
// names derive from `location` and the RBAC reuses the shared `skipRoleGrants`.

targetScope = 'resourceGroup'

@description('Primary region — also used to name the DCE/DCR.')
param location string

@description('Compliance tags applied to every resource.')
param complianceTags object

@description('Name of the existing Log Analytics workspace (monitoring.bicep output lawName).')
param lawName string

@description('Console UAMI principalId — granted Monitoring Metrics Publisher on the DCR so it can POST audit events. Empty string skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('LoomAudit_CL retention (days).')
@minValue(4)
@maxValue(730)
param retentionDays int = 90

// The 9 columns shared by the custom table + the DCR input stream. TimeGenerated
// is the required Azure-Monitor timestamp column; the rest map 1:1 to the
// AdminAuditEvent fields emitted by lib/admin/audit-stream.ts.
var auditColumns = [
  { name: 'TimeGenerated', type: 'datetime' }
  { name: 'ActorOid', type: 'string' }
  { name: 'ActorUpn', type: 'string' }
  { name: 'Action', type: 'string' }
  { name: 'TargetType', type: 'string' }
  { name: 'TargetId', type: 'string' }
  { name: 'Outcome', type: 'string' }
  { name: 'Detail', type: 'string' }
  { name: 'TenantId', type: 'string' }
]

// Existing Loom Log Analytics workspace (deployed by monitoring.bicep).
resource law 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = {
  name: lawName
}

// ── 1. LoomAudit_CL custom table ────────────────────────────────────────────
resource auditTable 'Microsoft.OperationalInsights/workspaces/tables@2022-10-01' = {
  parent: law
  name: 'LoomAudit_CL'
  properties: {
    totalRetentionInDays: retentionDays
    retentionInDays: retentionDays
    schema: {
      name: 'LoomAudit_CL'
      description: 'CSA Loom admin-plane mutation audit stream (BR-SIEM).'
      columns: auditColumns
    }
  }
}

// ── 2. Data Collection Endpoint ─────────────────────────────────────────────
resource dce 'Microsoft.Insights/dataCollectionEndpoints@2023-03-11' = {
  name: 'dce-loom-audit-${location}'
  location: location
  tags: complianceTags
  properties: {
    // Public ingestion by default; a private-link boundary can front this with
    // an Azure Monitor Private Link Scope (AMPLS) + private endpoint.
    networkAcls: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

// ── 3. Data Collection Rule ─────────────────────────────────────────────────
resource dcr 'Microsoft.Insights/dataCollectionRules@2023-03-11' = {
  name: 'dcr-loom-audit-${location}'
  location: location
  tags: complianceTags
  properties: {
    dataCollectionEndpointId: dce.id
    streamDeclarations: {
      'Custom-LoomAudit_CL': {
        columns: auditColumns
      }
    }
    destinations: {
      logAnalytics: [
        {
          workspaceResourceId: law.id
          name: 'loomAuditLaDest'
        }
      ]
    }
    dataFlows: [
      {
        streams: [ 'Custom-LoomAudit_CL' ]
        destinations: [ 'loomAuditLaDest' ]
        // The incoming JSON already matches the table shape — pass through.
        transformKql: 'source'
        outputStream: 'Custom-LoomAudit_CL'
      }
    ]
  }
  dependsOn: [
    auditTable
  ]
}

// ── 4. Monitoring Metrics Publisher on the DCR for the Console UAMI ──────────
// Role id 3913510d-42f4-4e42-8a64-420c390055eb — the Logs Ingestion API RBAC
// requirement (Learn: grant Monitoring Metrics Publisher on the DCR to the
// posting identity).
resource consoleDcrPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  name: guid(dcr.id, consolePrincipalId, '3913510d-42f4-4e42-8a64-420c390055eb')
  scope: dcr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('DCE logs-ingestion endpoint → LOOM_AUDIT_DCR_ENDPOINT on the Console.')
output dceLogsIngestionEndpoint string = dce.properties.logsIngestion.endpoint

@description('DCR immutable id → LOOM_AUDIT_DCR_ID on the Console.')
output dcrImmutableId string = dcr.properties.immutableId

output dcrId string = dcr.id
output dceId string = dce.id
output auditTableName string = 'LoomAudit_CL'
