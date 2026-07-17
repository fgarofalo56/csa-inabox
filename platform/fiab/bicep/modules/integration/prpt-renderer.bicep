// CSA Loom — integration/prpt-renderer.bicep
// Paginated-report (RDL) renderer — ACA host for PDF / Excel / Word export.
//
// A Flask + ReportLab/openpyxl/python-docx Container App that backs
// LOOM_PAGINATED_RENDER_URL for the paginated-report editor's export action
// (source: apps/fiab-prpt-renderer, same HTTP contract as the Azure Functions
// variant in azure-functions/paginated-report-renderer). Deploy THIS module in
// estates where Azure Policy forces publicNetworkAccess=Disabled on storage —
// a Y1 consumption Function has no VNet integration, so its host cannot reach
// its own AzureWebJobsStorage and never starts (diagnosed live 2026-07-15).
// The renderer is stateless (definition arrives in the request body): no
// storage, no data-plane roles, internal ingress only, scales to zero.
//
// Azure-native only. No Microsoft Fabric / Power BI dependency.

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string = 'loom-prpt-renderer'

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param environmentId string

@description('UserAssigned UAMI resource id — assigned to the app for BOTH ACR pull AND the app identity. It MUST be a least-privilege, AcrPull-ONLY identity (a dedicated uami-loom-wrangler with ZERO data-plane roles): the ACA app exposes this identity to in-container code via IMDS.')
param wranglerUamiId string

@description('ACR login server, e.g. acrloomk6mvh5sm6z7do.azurecr.io.')
param acrLoginServer string

@description('Container image reference (the loom-wrangler-host image in ACR — pin an explicit tag, never :latest).')
param image string

@description('Internal ingress target port the host listens on (matches PORT env / app.main).')
param targetPort int = 8080

@description('Compliance/cost tags.')
param complianceTags object = {}

// Pinned to the same Container Apps api-version the sibling ACA modules use
// (script-runner-app.bicep, dbt-runner.bicep, mcp-catalog-app.bicep) — bicep/runtime sync.
resource app 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: name
  location: location
  tags: complianceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${wranglerUamiId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        // INTERNAL only — reached by the Console BFF over the CAE network, never public.
        external: false
        targetPort: targetPort
        transport: 'auto'
      }
      // ACR pull via the UAMI (the image is a private ACR image).
      registries: [
        {
          server: acrLoginServer
          identity: wranglerUamiId
        }
      ]
    }
    template: {
      containers: [
        {
          name: name
          image: image
          env: [
            {
              name: 'PORT'
              value: string(targetPort)
            }
          ]
          // 1 vCPU / 2Gi — the wrangler only processes a BOUNDED sample
          // (MAX_ROWS=5000 in app.main), so this envelope is generous.
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          // Probe the dedicated health path.
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
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
                path: '/healthz'
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
      // Scale-to-zero between data-prep sessions: the host is only hit on-demand
      // by the Console BFF when a user opens the Data Wrangler panel and applies
      // a step. No standing warm replica, no standing cost. The CAE default HTTP
      // scale rule scales it up from 0 on the first inbound request.
      scale: {
        minReplicas: 0
        maxReplicas: 3
      }
    }
  }
}

@description('Internal FQDN of the deployed wrangler host (Console reads it as LOOM_WRANGLER_ENDPOINT, prefixed https://).')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('Container App resource id.')
output appId string = app.id
