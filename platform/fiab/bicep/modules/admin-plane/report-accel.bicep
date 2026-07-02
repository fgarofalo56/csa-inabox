// CSA Loom — report-accel Container App (DuckDB-over-Delta query accelerator).
//
// The opt-in fast path behind LOOM_REPORT_ACCEL_URL: a scale-to-zero Container App
// running DuckDB with the delta + azure extensions that reads the lakehouse Delta
// files DIRECTLY from ADLS Gen2 and answers aggregating report visuals at
// interactive speed — Loom's Azure-native, no-Fabric equivalent of Fabric
// "Direct Lake" (import-mode speed on Delta, no Fabric capacity / OneLake).
// Image built from platform/report-accel/ (Dockerfile + server.py).
//
// Internal ingress only (reachable from loom-console on the CAE VNet, never
// public). Reads ADLS via its assigned managed identity + "Storage Blob Data
// Reader" (credential_chain in server.py). Azure-native — no Fabric dependency
// (no-fabric-dependency.md); the report query route always falls back to Synapse
// Serverless when this host is absent (no-vaporware.md), so this is purely a
// latency accelerator.
//
// ─────────────────────────────────────────────────────────────────────────────
// TODO wire report-accel into admin-plane apps[] env: LOOM_REPORT_ACCEL_URL
//   The integration pass (main-loop) adds this module to admin-plane/main.bicep,
//   passes the CAE + Console UAMI + lake storage account, and sets the console's
//   `LOOM_REPORT_ACCEL_URL` env to `https://<this.outputs.fqdn>` (+ optionally
//   LOOM_REPORT_ACCEL_AUDIENCE / LOOM_ADLS_ACCOUNT). This module is intentionally
//   standalone and does NOT edit main.bicep or the orchestrator.
// ─────────────────────────────────────────────────────────────────────────────

targetScope = 'resourceGroup'

@description('Master switch — when false, nothing is deployed (report-accel stays opt-in).')
param reportAccelEnabled bool = true

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string = 'report-accel-loom'

@description('Deployment region.')
param location string = resourceGroup().location

@description('Container Apps managed-environment (CAE) resource id.')
param environmentId string

@description('User-assigned managed identity resource id assigned to the app (the Console UAMI, or a dedicated accel UAMI). Reads ADLS Delta.')
param accelUamiId string

@description('Container image reference (built from platform/report-accel/). e.g. <registry>.azurecr.io/csa-loom/report-accel:latest')
param image string

@description('Internal ingress target port the server listens on.')
param targetPort int = 8080

@description('Optional: scope the DuckDB azure secret to a single ADLS account name (LOOM_ADLS_ACCOUNT). Empty ⇒ ambient credential-chain over any readable account.')
param adlsAccountName string = ''

@description('When true (and lakeStorageAccountName is set + in this RG), assign "Storage Blob Data Reader" on that account to accelUamiId. For a cross-sub DLZ lake, grant out-of-band per docs/fiab/v3-tenant-bootstrap.md instead.')
param grantStorageReader bool = true

@description('Lakehouse ADLS Gen2 storage account name (in THIS resource group) to grant read on. Empty ⇒ skip the in-module role assignment.')
param lakeStorageAccountName string = ''

@description('Min replicas — 0 = scale-to-zero (default; costs nothing idle).')
@minValue(0)
param minReplicas int = 0

@description('Max replicas under concurrent report load.')
@minValue(1)
param maxReplicas int = 3

@description('Compliance tags.')
param complianceTags object = {}

// Azure built-in role: Storage Blob Data Reader.
var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

// Pinned to the same Container Apps api-version the other admin-plane ACA modules use.
resource app 'Microsoft.App/containerApps@2025-02-02-preview' = if (reportAccelEnabled) {
  name: name
  location: location
  tags: complianceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${accelUamiId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: targetPort
        transport: 'auto'
      }
    }
    template: {
      containers: [
        {
          name: name
          image: image
          env: concat(
            [
              {
                name: 'PORT'
                value: string(targetPort)
              }
            ],
            empty(adlsAccountName)
              ? []
              : [
                  {
                    name: 'LOOM_ADLS_ACCOUNT'
                    value: adlsAccountName
                  }
                ]
          )
          resources: {
            // DuckDB is columnar/vectorized — give it real memory for aggregations.
            cpu: json('1.0')
            memory: '2Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: targetPort
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: targetPort
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 15
              failureThreshold: 6
            }
          ]
        }
      ]
      scale: {
        // Scale-to-zero: an HTTP scale rule wakes it on the first report query.
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '20'
              }
            }
          }
        ]
      }
    }
  }
}

// Optional in-module role grant (same-RG lake only). Cross-sub DLZ lakes are
// granted out-of-band — see docs/fiab/v3-tenant-bootstrap.md.
resource lakeStorage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = if (reportAccelEnabled && grantStorageReader && !empty(lakeStorageAccountName)) {
  name: lakeStorageAccountName
}

resource blobReaderGrant 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (reportAccelEnabled && grantStorageReader && !empty(lakeStorageAccountName)) {
  name: guid(resourceGroup().id, name, storageBlobDataReaderRoleId, accelUamiId)
  scope: lakeStorage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    principalId: reference(accelUamiId, '2023-01-31').principalId
    principalType: 'ServicePrincipal'
  }
}

@description('Internal FQDN of the deployed report-accel service (set LOOM_REPORT_ACCEL_URL = https://<fqdn>).')
output fqdn string = reportAccelEnabled ? app.properties.configuration.ingress.fqdn : ''

@description('The value to wire into the console as LOOM_REPORT_ACCEL_URL.')
output accelUrl string = reportAccelEnabled ? 'https://${app.properties.configuration.ingress.fqdn}' : ''

@description('Container App resource id.')
output appId string = reportAccelEnabled ? app.id : ''
