// CSA Loom — CTS-13 nightly memory-consolidation job (Container Apps cron Job).
//
// Durable IaC mirror of .github/workflows/csa-loom-memory-consolidate.yml. Declares
// a SCHEDULE-driven Microsoft.App/jobs that, once per night, POSTs the internal-
// token-gated consolidation endpoint on the console — the SAME pattern as the
// spark keep-warm heartbeat, but in-VNet (the job runs inside the console's
// Container Apps environment, so it reaches the console over its internal FQDN and
// the console reaches Cosmos + AI Search privately).
//
// The consolidation LOGIC lives in the console (lib/azure/memory-consolidate.ts);
// this job only TRIGGERS it, so there is exactly one implementation. Merges near-
// duplicate memories, flags contradictions, promotes topics.
//
// Azure-native only (Container Apps Jobs + cron trigger). No Microsoft Fabric /
// Power BI dependency. The internal token is a Key Vault secret resolved by the
// console UAMI — never hardcoded.
//
// ---------------------------------------------------------------------------
// TODO — wire into platform/fiab/bicep/modules/admin-plane/main.bicep (a sibling
// workflow owns main.bicep; do NOT edit it from this module):
//
//     module memoryConsolidateJob 'modules/compute/loom-memory-consolidate-job.bicep' = if (deployMemoryConsolidate) {
//       name: 'loom-memory-consolidate-job'
//       params: {
//         location: location
//         environmentId: containerPlatform.outputs.environmentId
//         consoleUamiId: identity.outputs.consoleUamiId
//         consoleInternalUrl: 'https://loom-console.internal.${env}'    // in-VNet FQDN
//         internalTokenKeyVaultSecretUri: '${kv.outputs.uri}secrets/loom-internal-token'
//         complianceTags: complianceTags
//       }
//     }
//   And top-level: param deployMemoryConsolidate bool = true
// ---------------------------------------------------------------------------

targetScope = 'resourceGroup'

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param environmentId string

@description('uami-loom-console resource id — resolves the Key Vault internal-token secret.')
param consoleUamiId string

@description('Console base URL reachable from inside the CAE (internal FQDN preferred).')
param consoleInternalUrl string

@description('Key Vault secret URI holding LOOM_INTERNAL_TOKEN (resolved by consoleUamiId).')
param internalTokenKeyVaultSecretUri string

@description('Cron schedule (UTC). Default 07:17 nightly — off-peak, matching the GitHub workflow.')
param cronExpression string = '17 7 * * *'

@description('Small utility image with curl (busybox/curl). Default a public curl image.')
param jobImage string = 'curlimages/curl:8.10.1'

@description('Max seconds one run may execute before termination.')
param replicaTimeout int = 600

@description('vCPU per run.')
param cpu string = '0.25'

@description('Memory per run.')
param memory string = '0.5Gi'

@description('Compliance/cost tags.')
param complianceTags object = {}

// Pinned to the same Container Apps api-version the runtime deploy client + the
// sibling ACA job modules use (gh-runner-job.bicep) — bicep/runtime sync.
resource consolidateJob 'Microsoft.App/jobs@2025-02-02-preview' = {
  name: 'loom-memory-consolidate'
  location: location
  tags: complianceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${consoleUamiId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: replicaTimeout
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: cronExpression
        parallelism: 1
        replicaCompletionCount: 1
      }
      secrets: [
        {
          name: 'internal-token'
          keyVaultUrl: internalTokenKeyVaultSecretUri
          identity: consoleUamiId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'consolidate'
          image: jobImage
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: [
            {
              name: 'CONSOLE_URL'
              value: consoleInternalUrl
            }
            {
              name: 'INTERNAL_TOKEN'
              secretRef: 'internal-token'
            }
          ]
          command: [
            '/bin/sh'
            '-c'
            'curl -sS -X POST -H "Authorization: Bearer $INTERNAL_TOKEN" -H "Content-Type: application/json" --max-time 540 "$CONSOLE_URL/api/internal/copilot/memory/consolidate"'
          ]
        }
      ]
    }
  }
}

@description('The consolidation Job resource id.')
output jobId string = consolidateJob.id

@description('The consolidation Job name.')
output jobName string = consolidateJob.name
