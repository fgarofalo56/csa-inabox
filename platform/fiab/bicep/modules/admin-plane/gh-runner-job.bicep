// CSA Loom — scale-to-zero GitHub Actions self-hosted runner (Container Apps Job)
//
// Durable IaC mirror of scripts/csa-loom/provision-gh-runner.sh. Declares a
// Microsoft.App/jobs that registers an EPHEMERAL self-hosted GitHub Actions
// runner, in one of two trigger modes:
//
//   Manual (DEFAULT) — one execution per `az containerapp job start`. This is
//     the mode that proves registration works with NO dependency on KEDA. It is
//     the default deliberately: whether the KEDA `github-runner` scaler type is
//     supported in Azure Government Container Apps is UNVERIFIED, and a first
//     receipt must not be blocked behind an unverified dependency.
//   Event — the KEDA `github-runner` scaler: a replica per queued workflow run
//     carrying the scaler label, scaling back to zero (minExecutions 0) when CI
//     is idle. This is an ADDITION on top of Manual, not a prerequisite. Select
//     it only once the scaler is confirmed present in the target boundary.
//
// WHY: the runner executes inside the console's VNet-integrated Container Apps
// environment (peered to the DLZ), so CI build/roll/UAT can reach PE-only Azure
// resources (lake, Purview, ADF, Synapse, the private ACR/KV) that a cloud
// GitHub runner cannot. In Azure Government it is stronger than a convenience:
// there is no local Gov `az`, so an in-boundary runner is the ONLY way to
// produce the per-cloud receipt cloud-parity.md requires. It reuses the CONSOLE
// UAMI for ACR pull + az login, so CI authenticates as the same identity the
// console runs as.
//
// Azure-native only (Container Apps Jobs, + KEDA only in Event mode). No
// Microsoft Fabric / Power BI dependency. Does NOT reduce Anthropic API spend —
// it only moves GitHub Actions COMPUTE in-VNet and to scale-to-zero ACA.
//
// SECRET HANDLING: the GitHub PAT reaches the container as an ACA secret and
// nothing else. Preferred (and what admin-plane/main.bicep passes) is
// githubPatKeyVaultSecretUri — a Key Vault secret reference resolved by the
// console UAMI at runtime, so the value never enters bicep, a param file, a
// deployment history, or a log. githubPatSecretValue exists only for a pipeline
// that injects a @secure() value directly. It is NEVER hardcoded, never echoed,
// and never written to a file; the entrypoint uses it in an Authorization
// header only, and de-registers the runner on exit.
//
// WIRED FROM: platform/fiab/bicep/modules/admin-plane/main.bicep, behind
//   observabilityConfig.ghRunnerEnabled (default FALSE) — the R0 settable-bag
//   idiom. It is NOT a new top-level param: the top-level orchestrator sits at
//   251/256 ARM params, so riding the existing observabilityConfig bag is the
//   sanctioned lever (see the note in platform/fiab/bicep/main.bicep). The
//   activation ALSO requires observabilityConfig.ghRunnerPatSecretUri to be
//   non-empty, because Container Apps validates a Key Vault secret reference at
//   DEPLOY time — deploying this against an absent secret would fail the whole
//   admin-plane deployment obscurely. When the URI is missing, main.bicep
//   deploys nothing and emits the `ghRunnerGate` output naming exactly which
//   secret to create and where to point it.

targetScope = 'resourceGroup'

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param environmentId string

@description('uami-loom-console resource id — used for ACR pull + the runner image az login.')
param consoleUamiId string

@description('uami-loom-console PRINCIPAL id — granted Contributor on THIS job only, which is what lets an on-demand `az containerapp job start` (or the Console) begin an execution. Empty skips the grant.')
param consoleUamiPrincipalId string = ''

@description('Skip role assignments (re-deploys / least-privilege deployment identities that cannot grant).')
param skipRoleGrants bool = false

@description('Trigger mode. Manual (default) = on-demand executions only, NO KEDA dependency — the mode that can produce a first in-boundary receipt even if the KEDA github-runner scaler turns out to be unavailable in this cloud. Event = KEDA github-runner scaler autoscale.')
@allowed([
  'Manual'
  'Event'
])
param triggerMode string = 'Manual'

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

// Trigger configuration, one shape per mode. Manual carries NO scale rules and
// therefore no KEDA scaler type at all — which is the point: an unverified
// scaler cannot break the mode used for the first receipt.
var manualTriggerBlock = {
  triggerType: 'Manual'
  manualTriggerConfig: {
    replicaCompletionCount: 1
    parallelism: 1
  }
}

var eventTriggerBlock = {
  triggerType: 'Event'
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
}

var triggerBlock = triggerMode == 'Event' ? eventTriggerBlock : manualTriggerBlock

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
    configuration: union(triggerBlock, {
      replicaTimeout: replicaTimeout
      replicaRetryLimit: 1
      registries: [
        {
          server: acrLoginServer
          identity: consoleUamiId
        }
      ]
      secrets: patSecret
    })
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

// Contributor, scoped to THIS job only (not the RG) — the least scope that
// permits `az containerapp job start`. Without it, Manual mode is deployed but
// nobody can trigger it, which would make the default mode useless.
var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'

resource jobStartContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants && !empty(consoleUamiPrincipalId)) {
  name: guid(runnerJob.id, consoleUamiPrincipalId, contributorRoleId)
  scope: runnerJob
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
    principalId: consoleUamiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('The runner Job resource id.')
output jobId string = runnerJob.id

@description('Trigger mode actually deployed. Manual = on-demand only (no KEDA); Event = KEDA github-runner scaler.')
output triggerModeDeployed string = triggerMode

@description('TRUE only if the job-scoped Contributor grant was actually emitted. When false, `az containerapp job start` must be run by an identity that already holds an equivalent grant.')
output jobStartGrantApplied bool = !skipRoleGrants && !empty(consoleUamiPrincipalId)

@description('The runner Job name.')
output jobName string = runnerJob.name
