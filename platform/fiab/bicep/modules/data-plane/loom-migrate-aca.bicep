// CSA Loom — M1 loom-migrate: the inbound-migration estate-assessment reader.
//
// Backs LOOM_MIGRATE_URL. An internal-ingress FastAPI Container App the Console
// BFF (/api/migrate/assess) calls to ENUMERATE a source estate (Snowflake /
// Databricks Unity Catalog / Microsoft Fabric / Power BI) into a canonical
// inventory the console assessment engine turns into a migration-readiness
// report.
//
// Azure-native / in-boundary. NO-FABRIC-DEPENDENCY: a Fabric / Power BI estate
// is ONLY ever an inbound migration SOURCE — Loom itself needs no Fabric. The
// reader reaches a source ONLY when the operator explicitly points it at one
// (per-request connection + a Key-Vault-resolved bearer); with no source
// connection it does nothing but health + capabilities, so it runs DISCONNECTED
// in an IL5 / air-gapped enclave.
//
// SECURITY POSTURE
//   - INTERNAL ingress only. The Console BFF is the sole door; it authenticates
//     the caller and writes a data-access audit row per assessment.
//   - The reader holds NO standing source credentials and NO storage keys /
//     secrets in app settings. Each request carries the source connection the
//     BFF resolved from Key Vault; the reader keeps nothing.
//   - Its user-assigned managed identity is used ONLY for ACR pull. It needs no
//     data-plane role on the lake (it never touches the lake).
//
// R0 PARAM-CAP RULE: admin-plane/main.bicep is at the ARM 256-parameter
// ceiling, so this module takes a single typed CONFIG-OBJECT bag and deploys
// OUT OF BAND (standalone entrypoint, orphan-allowlisted in
// scripts/ci/check-bicep-sync.mjs) exactly like the sibling
// data-plane/duckdb-aca.bicep.
//
//   az deployment group create -g <admin-rg> \
//     -f platform/fiab/bicep/modules/data-plane/loom-migrate-aca.bicep \
//     -p location=<region> \
//        migrateConfig='{ "environmentId": "<cae-id>", "uamiId": "<uami-id>", \
//                         "acrLoginServer": "<acr>.azurecr.io", \
//                         "image": "<acr>.azurecr.io/loom-migrate:<tag>" }'
//   # then: az containerapp update -n <console> -g <admin-rg> --set-env-vars \
//   #         LOOM_MIGRATE_URL=https://<this-app-fqdn>

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string = 'loom-migrate'

@description('Deployment region (e.g. usgovvirginia / centralus).')
param location string = resourceGroup().location

@description('''R0 config bag — every setting for the estate-assessment reader in ONE typed object (admin-plane/main.bicep is at the ARM 256-param cap, so no new top-level params are added anywhere).

Required keys:
  environmentId   Container Apps managed-environment resource id (in-VNet).
  uamiId          User-assigned managed identity RESOURCE id (ACR pull).
  acrLoginServer  ACR login server, e.g. acrloom.azurecr.io.
  image           loom-migrate container image (pin an explicit tag, never :latest).

Optional keys:
  targetPort      Internal HTTP ingress port (default 8080).
  minReplicas     Default 0 — the reader is called only during an assessment, so
                  scale-to-zero is fine (a cold start adds seconds to a manual,
                  non-interactive action).
  maxReplicas     Default 2.
  cpu / memory    Container resources (default 0.5 vCPU / 1Gi).''')
param migrateConfig object

@description('Compliance/cost tags. The loom-next-level tag is unioned in.')
param complianceTags object = {}

// ── Config-bag unpacking (typed locals; every optional key has a real default) ─
var environmentId = migrateConfig.environmentId
var uamiId = migrateConfig.uamiId
var acrLoginServer = migrateConfig.acrLoginServer
var image = migrateConfig.image
var targetPort = int(migrateConfig.?targetPort ?? 8080)
var minReplicas = int(migrateConfig.?minReplicas ?? 0)
var maxReplicas = int(migrateConfig.?maxReplicas ?? 2)
var cpu = string(migrateConfig.?cpu ?? '0.5')
var memory = string(migrateConfig.?memory ?? '1Gi')

var tags = union(complianceTags, { 'loom-next-level': 'true' })

// Pinned to the same Container Apps api-version the sibling ACA modules use.
resource app 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uamiId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      // No secrets: the reader holds no standing source credentials — every
      // source token arrives per-request (resolved from Key Vault by the BFF).
      secrets: []
      ingress: {
        // INTERNAL only — the Console BFF is the sole door.
        external: false
        targetPort: targetPort
        transport: 'auto'
      }
      registries: [
        {
          server: acrLoginServer
          identity: uamiId
        }
      ]
    }
    template: {
      containers: [
        {
          name: name
          image: image
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: targetPort }
              initialDelaySeconds: 10
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health', port: targetPort }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 6
            }
          ]
        }
      ]
      // Scale-to-zero is fine — the reader is only hit during a manual,
      // non-interactive assessment, so a cold start costs seconds, not latency
      // on an interactive path. Cost ~$0 idle.
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: { metadata: { concurrentRequests: '10' } }
          }
        ]
      }
    }
  }
}

@description('Internal FQDN — set on the Console app as LOOM_MIGRATE_URL (prefix https://).')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('Container App resource id.')
output appId string = app.id
