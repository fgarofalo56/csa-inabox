// CSA Loom — Loom Capacity Broker Container App (HYP-9, Hyperscale band).
//
// Backs LOOM_CAPACITY_BROKER_URL for the unified compute admission-control
// service (apps/loom-capacity-broker). A stateful, low-latency `POST /admit`
// choke-point over a 2,880 x 30-second Redis timepoint ledger implementing the
// LCU smoothing / bursting / four-stage-throttle model. Azure-native only — it
// NEVER contacts api.fabric.microsoft.com / api.powerbi.com (no-fabric-dependency.md).
//
// HA-critical control plane: minReplicas = 2 (admission control cannot
// scale-to-zero — a cold start on the submit hot path would stall every job).
//
// LEAST-PRIVILEGE identity (PRP §7.3): the broker gates the caller, it never
// proxies the backend call, so its UAMI holds AcrPull ONLY and ZERO data-plane
// roles. It reaches Redis via a Key-Vault-style connection-string SECRET (not
// RBAC) and Event Grid via the topic key — nothing that needs a data-plane role
// assignment. Reusing the broadly-permissioned Console UAMI here would be an
// unnecessary privilege grant; use a dedicated uami-loom-capacity-broker.
//
// Ledger backend is HONEST + default-ON: when redisConnectionString is empty the
// service runs its in-process timepoint ledger (single-replica) so the core
// /admit path still EXECUTES (no-vaporware.md); set it (Azure Cache for Redis
// Premium, shared with HYP-5/HYP-6) for cross-replica coherence.
//
// ---------------------------------------------------------------------------
// TODO — wire into platform/fiab/bicep/modules/admin-plane/main.bicep
//   (a sibling workflow owns main.bicep — which is at the 256-param ceiling — so
//   this module is currently a standalone entrypoint on ORPHAN_ALLOWLIST; deploy
//   it out-of-band, then set the console env below):
//
//     module capacityBroker 'compute/loom-capacity-broker-app.bicep' = if (capacityBrokerActive) {
//       name: 'loom-capacity-broker'
//       params: {
//         name: 'loom-capacity-broker'
//         location: location
//         environmentId: containerPlatform_env.outputs.environmentId
//         brokerUamiId: capacityBrokerUami.outputs.id          // uami-loom-capacity-broker (AcrPull only)
//         acrLoginServer: registry.outputs.acrLoginServer
//         image: '${registry.outputs.acrLoginServer}/loom-capacity-broker:${appImageTags.capacityBroker}'
//         redisConnectionString: redisPremium.outputs.primaryConnectionString  // shared Azure Cache for Redis
//         complianceTags: complianceTags
//       }
//     }
//
//   And add to the console env array in admin-plane/main.bicep apps[]:
//     { name: 'LOOM_CAPACITY_BROKER_URL', value: capacityBrokerActive ? 'https://${capacityBroker!.outputs.fqdn}' : '' }
//   (LOOM_CAPACITY_BROKER_URL is the console-read var; LOOM_BROKER_REDIS +
//    LOOM_CAPACITY_BROKER_EVENTGRID below are the broker's OWN container env.)
// ---------------------------------------------------------------------------

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string = 'loom-capacity-broker'

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param environmentId string

@description('UserAssigned UAMI resource id — assigned to the app for ACR pull AND the app identity. MUST be a dedicated, least-privilege AcrPull-ONLY identity (uami-loom-capacity-broker) with ZERO data-plane roles: the broker gates callers, it never proxies backend calls.')
param brokerUamiId string

@description('ACR login server, e.g. acrloomk6mvh5sm6z7do.azurecr.io.')
param acrLoginServer string

@description('Container image reference (the loom-capacity-broker image in ACR — pin an explicit tag, never :latest).')
param image string

@description('Internal ingress target port the broker listens on (matches PORT env / main.go).')
param targetPort int = 8080

@description('Azure Cache for Redis connection string for the timepoint ledger (LOOM_BROKER_REDIS). Empty = in-process single-replica ledger (honest default-ON fallback). Injected as a secret — never a plain env literal.')
@secure()
param redisConnectionString string = ''

@description('Optional Event Grid custom-topic endpoint for throttle-state-change events (HYP-13). Empty until the topic is deployed.')
param eventGridEndpoint string = ''

@description('Compliance/cost tags.')
param complianceTags object = {}

// Redis conn string is a secret when provided; the ledger falls back to
// in-process when empty (the core /admit path still executes).
var hasRedis = !empty(redisConnectionString)
var secrets = hasRedis
  ? [
      {
        name: 'redis-conn'
        value: redisConnectionString
      }
    ]
  : []
var redisEnv = hasRedis
  ? {
      name: 'LOOM_BROKER_REDIS'
      secretRef: 'redis-conn'
    }
  : {
      name: 'LOOM_BROKER_REDIS'
      value: ''
    }

// Pinned to the same Container Apps api-version the sibling ACA modules use
// (script-runner-app.bicep, mcp-catalog-app.bicep) — bicep/runtime sync.
resource app 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: name
  location: location
  tags: complianceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${brokerUamiId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: secrets
      ingress: {
        // INTERNAL only — reached by the Console BFF over the CAE network, never public.
        external: false
        targetPort: targetPort
        transport: 'auto'
      }
      registries: [
        {
          server: acrLoginServer
          identity: brokerUamiId
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
            redisEnv
            {
              name: 'LOOM_CAPACITY_BROKER_EVENTGRID'
              value: eventGridEndpoint
            }
          ]
          // Small, predictable admission loop — 0.5 vCPU / 1Gi is ample; the
          // timepoint math is O(window) in-memory and one Redis round trip.
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: targetPort
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
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
              initialDelaySeconds: 3
              periodSeconds: 10
              failureThreshold: 6
            }
          ]
        }
      ]
      // HA control plane — admission control CANNOT scale-to-zero (PRP §7.3):
      // a cold start on the job-submit hot path would stall every submission.
      scale: {
        minReplicas: 2
        maxReplicas: 5
      }
    }
  }
}

@description('Internal FQDN of the deployed capacity broker (Console reads it as LOOM_CAPACITY_BROKER_URL, prefixed https://).')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('Container App resource id.')
output appId string = app.id
