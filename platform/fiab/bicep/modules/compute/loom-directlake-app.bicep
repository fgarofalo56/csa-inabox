// CSA Loom — Loom Direct Lake columnar cache/scan service (HYP-5)
//
// Backs LOOM_DIRECTLAKE_URL for the semantic-model / report layer's
// import-class scan path. This ACA app is the Azure-native, OSS
// outcome-equivalent of Microsoft Fabric's Direct Lake: a Rust/axum service
// (apps/loom-directlake) that FRAMES a Delta/Parquet source (metadata-only
// version pin via delta-rs) and TRANSCODES scanned columns to an Arrow IPC
// stream via Apache DataFusion. It contacts NO Fabric / OneLake / Power BI
// service (.claude/rules/no-fabric-dependency.md) — the abfss:// Delta path
// reads the customer's OWN ADLS Gen2 via Managed Identity.
//
// REAL service (no-vaporware): apps/loom-directlake/src/scan.rs runs a real
// DataFusion scan and returns a real Arrow IPC stream; the bundled fixture makes
// the core path executable with zero Azure. When this module is not deployed the
// console BFF /api/directlake/scan returns an honest 503 naming
// LOOM_DIRECTLAKE_URL + THIS module, and the semantic layer falls back silently
// to its existing backend (AAS fast-path / Synapse-Serverless) — never a Fabric
// gate (.claude/rules/no-fabric-dependency.md).
//
// KEY DIFFERENCE FROM script-runner-app.bicep: this app is NOT scale-to-zero.
// Warm-cache retention (keeping framed columns resident) is the ENTIRE point of
// a Direct-Lake-equivalent, so minReplicas defaults to 1 (per the PRP §6.3 —
// "minReplicas tuned per-tenant, NOT scale-to-zero"). Idle cost is the honest
// trade for import-class latency; it is bounded by this minReplicas knob + idle
// eviction inside the service.
//
// IDENTITY: the app's UAMI needs Storage Blob Data Reader on the DLZ lake (to
// read Delta+Parquet) and AcrPull on the admin-plane ACR (to pull its image) —
// and NOTHING ELSE (least privilege). Unlike script-runner, this container does
// NOT execute arbitrary user code, so IMDS token exposure is not a user-code
// sandbox hole; the least-privilege posture is still enforced because the app
// only ever needs to READ lake data.
//
// Redis wiring (the shared cross-replica segment-residency index) is HYP-6 and
// is intentionally NOT built here.
//
// ---------------------------------------------------------------------------
// STANDALONE ENTRYPOINT (bicep-sync): admin-plane/main.bicep is at the hard ARM
// 256-parameter ceiling, so — like event-grid-webhooks.bicep / gh-runner-job
// .bicep / adt-instance.bicep — this module is deployed OUT-OF-BAND and is
// allowlisted in scripts/ci/check-bicep-sync.mjs (ORPHAN_ALLOWLIST). After
// deploy, set LOOM_DIRECTLAKE_URL on the console app to this app's internal
// FQDN (prefixed https://). Example wiring when admin-plane frees param budget:
//
//   module loomDirectLake 'compute/loom-directlake-app.bicep' = if (directLakeActive) {
//     name: 'loom-directlake'
//     params: {
//       name: 'loom-directlake'
//       location: location
//       environmentId: containerPlatformModule.outputs.caeId
//       directLakeUamiId: loomDirectLakeUami.outputs.id      // Storage Blob Data Reader + AcrPull
//       acrLoginServer: registry.outputs.acrLoginServer
//       image: '${registry.outputs.acrLoginServer}/loom-directlake:${appImageTags.directLake}'
//       storageAccountName: dlzStorageAccountName
//       complianceTags: complianceTags
//     }
//   }
//   // console env:
//   { name: 'LOOM_DIRECTLAKE_URL', value: directLakeActive ? 'https://${loomDirectLake!.outputs.fqdn}' : '' }
// ---------------------------------------------------------------------------

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string = 'loom-directlake'

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string = resourceGroup().location

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param environmentId string

@description('UserAssigned UAMI resource id — assigned to the app for ACR pull AND the app identity. Least-privilege: Storage Blob Data Reader on the DLZ lake + AcrPull on the admin-plane ACR, and NOTHING else.')
param directLakeUamiId string

@description('ACR login server, e.g. acrloomk6mvh5sm6z7do.azurecr.io.')
param acrLoginServer string

@description('Container image reference (the loom-directlake image in ACR — pin an explicit tag, never :latest).')
param image string

@description('The DLZ ADLS Gen2 storage-account NAME the service reads Delta/Parquet from (sets LOOM_DIRECTLAKE_STORAGE_ACCOUNT). Empty ⇒ only the fixture:// / file:// scan paths run; abfss:// scans honest-gate (503) until set.')
param storageAccountName string = ''

@description('The UAMI client-id to pin for object_store when more than one identity is bound (sets LOOM_DIRECTLAKE_UAMI_CLIENT_ID). Empty ⇒ object_store resolves the sole assigned identity.')
param uamiClientId string = ''

@description('Internal ingress target port the service listens on (matches PORT env / main.rs).')
param targetPort int = 8080

@description('Minimum replicas. NOT scale-to-zero — warm-cache retention is the point of a Direct-Lake-equivalent (PRP §6.3). Tune per-tenant.')
@minValue(1)
param minReplicas int = 1

@description('Maximum replicas — caps concurrent scan fan-out + warm-cache memory footprint.')
param maxReplicas int = 3

@description('vCPU for the columnar working set. Direct-Lake-equivalent scans are memory-bound; default 2 vCPU / 4Gi.')
param cpu string = '2.0'

@description('Memory for the columnar working set.')
param memory string = '4Gi'

@description('Compliance/cost tags.')
param complianceTags object = {}

// Pinned to the same Container Apps api-version the sibling ACA modules use
// (script-runner-app.bicep, mcp-catalog-app.bicep) — bicep/runtime sync.
resource app 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: name
  location: location
  tags: complianceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${directLakeUamiId}': {}
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
      // Private ACR image pulled via the app UAMI (AcrPull granted out-of-band).
      registries: [
        {
          server: acrLoginServer
          identity: directLakeUamiId
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
            {
              // Empty ⇒ the abfss:// Delta path honest-gates (503) inside the
              // service; the fixture:// / file:// scan paths still run.
              name: 'LOOM_DIRECTLAKE_STORAGE_ACCOUNT'
              value: storageAccountName
            }
            {
              name: 'LOOM_DIRECTLAKE_UAMI_CLIENT_ID'
              value: uamiClientId
            }
            {
              name: 'RUST_LOG'
              value: 'loom_directlake=info'
            }
          ]
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          // Probe the dedicated health path, never the scan endpoint.
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
      // NOT scale-to-zero: minReplicas >= 1 keeps framed columns warm between
      // scans (the Direct-Lake-equivalent contract). maxReplicas caps concurrent
      // scan fan-out + the aggregate warm-cache memory footprint.
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

@description('Internal FQDN of the deployed loom-directlake service (Console reads it as LOOM_DIRECTLAKE_URL, prefixed https://).')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('Container App resource id.')
output appId string = app.id
