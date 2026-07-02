// CSA Loom — scale-to-zero GitHub Actions self-hosted runner (Container Apps Job)
//
// Durable IaC mirror of scripts/csa-loom/provision-gh-runner.sh. Declares an
// EVENT-driven Microsoft.App/jobs that registers an EPHEMERAL self-hosted
// GitHub Actions runner whenever a workflow targeting the `loom-aca` label is
// queued, then scales back to zero (minExecutions 0) when CI is idle.
//
// WHY: the runner executes inside the console's VNet-integrated Container Apps
// environment (peered to the DLZ), so CI build/roll/UAT can reach PE-only Azure
// resources (lake, Purview, ADF, Synapse, the private ACR/KV) that a cloud
// GitHub runner cannot. It reuses the CONSOLE UAMI for ACR pull + az login, so
// CI authenticates as the same identity the console runs as.
//
// Azure-native only (Container Apps Jobs + KEDA `github-runner` scaler). No
// Microsoft Fabric / Power BI dependency. Does NOT reduce Anthropic API spend —
// it only moves GitHub Actions COMPUTE in-VNet and to scale-to-zero ACA.
//
// Secret: the GitHub PAT is supplied either as a @secure() param value or as a
// Key Vault secret URI (resolved by the console UAMI). It is NEVER hardcoded.
//
// ---------------------------------------------------------------------------
// TODO — wire into platform/fiab/bicep/modules/admin-plane/main.bicep:
//   Add (do NOT edit main.bicep from this module; a sibling workflow owns it):
//
//     module ghRunnerJob 'gh-runner-job.bicep' = if (deployGitHubRunner) {
//       name: 'gh-runner-job'
//       params: {
//         location: location
//         environmentId: containerPlatform.outputs.environmentId  // the CAE id
//         consoleUamiId: identity.outputs.consoleUamiId           // uami-loom-console
//         acrLoginServer: registry.outputs.loginServer            // acr...azurecr.io
//         runnerImage: '${registry.outputs.loginServer}/gh-aca-runner:latest'
//         ghOwner: 'fgarofalo56'
//         ghRepo: 'csa-inabox'
//         // Pass the PAT from a pipeline @secure() var OR a KV secret URI:
//         githubPatSecretValue: githubRunnerPat            // @secure() top-level param
//         // githubPatKeyVaultSecretUri: '${kv.outputs.uri}secrets/gh-actions-pat'
//         complianceTags: complianceTags
//       }
//     }
//
//   And a top-level: @secure() param githubRunnerPat string = ''
//                    param deployGitHubRunner bool = false
// ---------------------------------------------------------------------------

targetScope = 'resourceGroup'

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param environmentId string

@description('uami-loom-console resource id — used for ACR pull + the runner image az login.')
param consoleUamiId string

@description('ACR login server, e.g. acrloomk6mvh5sm6z7do.azurecr.io.')
param acrLoginServer string

@description('Runner container image reference (toolchain image built by provision-gh-runner.sh).')
param runnerImage string = '${acrLoginServer}/gh-aca-runner:latest'

@description('GitHub repo owner (runner scope = repo).')
param ghOwner string = 'fgarofalo56'

@description('GitHub repo name.')
param ghRepo string = 'csa-inabox'

@description('GitHub REST API base. Commercial: https://api.github.com. GitHub Enterprise (incl. Gov-hosted GHE): set to that instance API URL.')
param githubAPIURL string = 'https://api.github.com'

@description('Runner labels applied at registration (comma list) — used by workflows in runs-on.')
param runnerLabels string = 'loom-aca,linux,x64'

@description('Label(s) the KEDA scaler counts queued runs for (comma list).')
param scalerLabels string = 'loom-aca'

@description('Runner name prefix; the runner appends -$(hostname) per execution.')
param runnerNamePrefix string = 'loom-aca'

@description('Pending-run count that maps to one job execution.')
param targetWorkflowQueueLength int = 1

@description('Max concurrent job executions per polling interval.')
param maxExecutions int = 5

@description('Min executions. 0 = scale-to-zero.')
@minValue(0)
param minExecutions int = 0

@description('Scaler polling interval (seconds).')
param pollingInterval int = 30

@description('Max seconds a runner replica may execute before it is terminated.')
param replicaTimeout int = 1800

@description('vCPU per runner replica.')
param cpu string = '1.0'

@description('Memory per runner replica (e.g. 2.0Gi).')
param memory string = '2.0Gi'

@description('GitHub PAT value (repo-scoped). Supply via a pipeline @secure() variable. Leave empty when using githubPatKeyVaultSecretUri.')
@secure()
param githubPatSecretValue string = ''

@description('Key Vault secret URI holding the GitHub PAT (resolved by consoleUamiId). Takes precedence over githubPatSecretValue when set.')
param githubPatKeyVaultSecretUri string = ''

@description('Compliance/cost tags.')
param complianceTags object = {}

// Either a literal @secure() secret OR a Key Vault-backed secret (UAMI-resolved).
var patSecret = empty(githubPatKeyVaultSecretUri)
  ? [
      {
        name: 'github-pat'
        value: githubPatSecretValue
      }
    ]
  : [
      {
        name: 'github-pat'
        keyVaultUrl: githubPatKeyVaultSecretUri
        identity: consoleUamiId
      }
    ]

// Pinned to the same Container Apps api-version the runtime deploy client +
// sibling ACA modules use (mcp-catalog-app.bicep) — bicep/runtime sync.
resource runnerJob 'Microsoft.App/jobs@2025-02-02-preview' = {
  name: 'gh-aca-runner'
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
      triggerType: 'Event'
      replicaTimeout: replicaTimeout
      replicaRetryLimit: 1
      eventTriggerConfig: {
        replicaCompletionCount: 1
        parallelism: 1
        scale: {
          minExecutions: minExecutions
          maxExecutions: maxExecutions
          pollingInterval: pollingInterval
          rules: [
            {
              name: 'github-runner'
              type: 'github-runner'
              metadata: {
                githubAPIURL: githubAPIURL
                owner: ghOwner
                runnerScope: 'repo'
                repos: ghRepo
                labels: scalerLabels
                targetWorkflowQueueLength: string(targetWorkflowQueueLength)
              }
              auth: [
                {
                  secretRef: 'github-pat'
                  triggerParameter: 'personalAccessToken'
                }
              ]
            }
          ]
        }
      }
      registries: [
        {
          server: acrLoginServer
          identity: consoleUamiId
        }
      ]
      secrets: patSecret
    }
    template: {
      containers: [
        {
          name: 'runner'
          image: runnerImage
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: [
            {
              name: 'GH_OWNER'
              value: ghOwner
            }
            {
              name: 'GH_REPO'
              value: ghRepo
            }
            {
              name: 'GITHUB_API_URL'
              value: githubAPIURL
            }
            {
              name: 'RUNNER_LABELS'
              value: runnerLabels
            }
            {
              name: 'RUNNER_NAME_PREFIX'
              value: runnerNamePrefix
            }
            {
              name: 'GITHUB_PAT'
              secretRef: 'github-pat'
            }
          ]
        }
      ]
    }
  }
}

@description('The runner Job resource id.')
output jobId string = runnerJob.id

@description('The runner Job name.')
output jobName string = runnerJob.name
