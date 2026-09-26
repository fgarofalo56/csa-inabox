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
// GitHub runner cannot.
//
// IT DOES NOT REUSE THE CONSOLE UAMI. That sentence was here until 2026-09-25
// and had been false since the identity swap on 2026-09-13: the job now carries
// uami-loom-ci (AcrPull only) and nothing else. Anything that relied on CI
// authenticating as the console identity -- a `az login --identity`, a
// ManagedIdentityCredential keyed to LOOM_UAMI_CLIENT_ID -- no longer works on
// this fleet and needs its own least-privilege grant, recorded at runnerUamiId.
//
// Azure-native only (Container Apps Jobs + KEDA `github-runner` scaler). No
// Microsoft Fabric / Power BI dependency. Does NOT reduce Anthropic API spend --
// it only moves GitHub Actions COMPUTE in-VNet and to scale-to-zero ACA. It does
// not reduce a GitHub bill either: this repo is PUBLIC, so hosted standard
// runners were already free and unmetered, and this is a cost INCREASE taken
// deliberately for in-VNet reachability.
//
// Secret: the GitHub PAT is supplied as a @secure() param value. The Key Vault
// alternative is refused -- see githubPatKeyVaultSecretUri.
//
// ===========================================================================
// SOVEREIGN BOUNDARY EXPOSURE -- THIS FLEET IS COMMERCIAL-ONLY AND THE SWITCH
// THAT SELECTS IT CANNOT SAY OTHERWISE
// ===========================================================================
//
// RECORDED, NOT SOLVED. Per cloud-parity.md an unexercised or unsafe boundary
// is DECLARED rather than implied, and this is the declaration.
//
// This job is deployed once, into the Commercial DMLZ subscription's
// cae-csa-loom-centralus environment, under uami-loom-ci -- a Commercial
// managed identity in a Commercial tenant, on a VNet peered to the Commercial
// DLZ. There is no Gov, GCC, GCC-High, IL5 or DoD instance of it.
//
// `vars.CI_RUNNER` has NO BOUNDARY DIMENSION -- there is no value of it that
// says "sovereign jobs go elsewhere". It DOES have a SCOPE dimension, and an
// earlier revision of this block denied that by calling it "a SINGLE
// repository-wide variable": GitHub resolves `vars.*` with ENVIRONMENT
// PRECEDENCE inside a job that declares an `environment:`, and 19 converted
// jobs do -- `deploy-fiab-il5.yml:deploy-validate` on `il5-deploy`,
// `deploy-fiab-gcch.yml:deploy-validate` on `gcc-high-deploy`. A value set on
// one of those environments routes that boundary's deploy onto this Commercial
// fleet while repository scope stays empty and any repository-scope-only guard
// stays green. That form is checked, at all nine environments, by
// .github/workflows/ci-runner-var-guard.yml (scripts/ci/check-ci-runner-scopes.sh,
// whose 32-arm selftest pins the il5-deploy case). Every converted job that
// declares no environment reads the repository value:
//
//     runs-on: ${{ fromJSON(startsWith(vars.CI_RUNNER, '[')
//                  && vars.CI_RUNNER || '["ubuntu-latest"]') }}
//
// and .github/actionlint.yaml declares exactly ONE self-hosted label,
// `loom-aca`, which is this Commercial fleet. So setting the variable does not
// route "CI" to "a runner"; it routes EVERY converted job, in every boundary,
// to THIS Commercial fleet.
//
// MEASURED 2026-09-25, re-measured 2026-09-26 at efda6b114, by a PyYAML walk
// over .github/workflows that classifies a workflow as boundary-touching only
// when it TAKES a sovereign action (`az cloud set --name AzureUSGovernment`, a
// secrets.AZURE_GOV_*/AZURE_GCC_* reference, a .usgovcloudapi endpoint, or a
// gov-* filename) -- not merely because it mentions "IL5" somewhere:
//
//     converted jobs, all workflows        171   re-derived at efda6b114
//     in Gov-touching workflows             54   re-derived at efda6b114
//                                                 in 36 files
//     mentions a boundary token only        13   NOT re-derived -- the
//                                                 mention-needle set was never
//                                                 written down, so this row is
//                                                 carried, not confirmed
//
// QUOTE THE SCOPE WITH THE 54. It is the count when the needles classify the
// WORKFLOW -- the wording above -- and the converted jobs inside it are then
// counted. Applying the same needles to each JOB's own subtree gives 43 jobs in
// the SAME 36 files. The file count reproduces either way; the job count does
// not, and the figure did not previously say which reading produced it.
//
// The 54 include deploy-gov (4), deploy-fiab-gcch (3), deploy-fiab-il5 (2),
// deploy-fiab-gcc (2), dr-drill (7), loom-roll-and-validate (4),
// loom-drift-check (3), and the whole gov-provision-* family.
//
// WHAT THAT MEANS IF THE VARIABLE IS SET: a GCC-High or IL5 deploy lane would
// execute its `az cloud set --name AzureUSGovernment` and its sovereign
// credentials ON A HOST INSIDE THE COMMERCIAL HUB VNET, carrying a Commercial
// managed identity. That is a boundary-crossing execution context, and no
// value of CI_RUNNER can avoid it, because the variable cannot express "Gov
// jobs stay hosted" or "Gov jobs use a Gov fleet". One variable, one answer,
// every boundary.
//
// NO PER-BOUNDARY FIX IS ATTEMPTED HERE, deliberately. It needs either a
// per-boundary variable (CI_RUNNER_COMMERCIAL / CI_RUNNER_GOV / ...) read by a
// boundary-aware expression, or a Gov-resident fleet with its own label
// declared in actionlint.yaml, or an explicit decision that the 54 stay
// hosted. All three are design changes, none belongs in this PR, and the
// exposure is recorded so the decision is taken knowingly.
//
// UNTIL THEN: `vars.CI_RUNNER` is unset (measured 2026-09-25: 11 repository
// variables, none named CI_RUNNER), so all 171 jobs -- the 54 included --
// route to ubuntu-latest and nothing crosses a boundary. Setting it is the
// act that creates the exposure.
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
//         // Pass the PAT from a pipeline @secure() var. The Key Vault URI
//         // parameter is refused at validation time; see its description.
//         githubPatSecretValue: githubRunnerPat            // @secure() top-level param
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

@description('''UNUSED, and deliberately so - kept only so an existing caller does not break. The runner MUST NOT carry the console identity; see runnerUamiId.

It used to be referenced by the githubPatKeyVaultSecretUri branch below, on the reasoning that a Key Vault-backed ACA secret is resolved by the PLATFORM at deploy time and therefore "never reaches a job". The first half of that is true and the second half does not follow, which is why that branch is now disabled - see githubPatKeyVaultSecretUri.''')
param consoleUamiId string

@description('''uami-loom-ci - the runner's OWN least-privilege identity, and the boundary this module depends on.

MEASURED 2026-09-13, which is why this parameter exists. The runner used to carry `uami-loom-console-centralus`: 53 role assignments including **Contributor at SUBSCRIPTION scope**, **Role Based Access Control Administrator** on this resource group, and **Key Vault Secrets Officer** on kv-loom. Container Apps injects IDENTITY_ENDPOINT/IDENTITY_HEADER into the job, so ANY job step could assume that identity. Contributor grants Microsoft.App/jobs/listSecrets/action - which hands back this job's own `github-pat` secret - and RBAC Administrator grants exactly the roleAssignments/write that Contributor notActions deny, i.e. self-promotion to Owner.

TENSE, because the sentence here previously read "On a PUBLIC repo, where an approved fork PR runs arbitrary code here" in the present tense and that is not true at this head. The repo IS public. What is NOT true today is that PR-authored code reaches this job: `vars.CI_RUNNER` is unset, so every converted job routes to ubuntu-latest. The exposure becomes live WHEN that variable is set, and it is stated in that conditional form so nobody discharges it by re-reading the sentence.

Removing the PAT from the process environment did NOT fix that; it closed the smaller door. Two independent reviewers demonstrated the recovery path separately.

uami-loom-ci holds ONE role assignment: AcrPull on this registry, which is the only thing the runner needs to start. Add a grant only when a specific job proves it needs one, and record why here.''')
param runnerUamiId string

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

@description('''Max concurrent job executions. Operator decision 2026-09-13: capped at 8 (not 30) to bound fleet cost. Raise it together with the environment's D8 `maximumCount` if PRs start queueing - the node ceiling, not this number, is what actually bills.

THIS TEXT IS A RECORD, NOT A CONTROL, and it is labelled that way because the previous version read "DO NOT RAISE THIS ABOVE 0 UNTIL THE TWO ITEMS BELOW ARE DISCHARGED" on a parameter whose default is 8. A comment that forbids a value the file itself ships is not enforcing anything - it is the same "a comment is not a control" failure this module's sibling script has a `case` statement to avoid, committed in the paragraph claiming the discipline. Measured 2026-09-25 on the live job `gh-aca-runner` in rg-csa-loom-admin-centralus: `maxExecutions` is 5. So neither 0 nor 8 describes the estate.

WHAT ACTUALLY HOLDS THE FLEET CLOSED is `vars.CI_RUNNER` being unset - measured the same day, 11 repository variables and no CI_RUNNER. Until it is set, no converted job routes here regardless of this parameter. The two preconditions below are conditions on SETTING THAT VARIABLE, not on this number.

1. THE NETWORK AXIS IS UNMEASURED. runnerUamiId closes the IDENTITY axis - what the job CARRIES. It says nothing about where the job SITS, which is what moving 171 jobs here changes. Measured on cae-csa-loom-centralus 2026-09-13: 14 Container Apps carry uami-loom-console-centralus (subscription Contributor, RBAC Administrator, Key Vault Secrets Officer) and 12 of those have INTERNAL ACA ingress, among them loom-trino, loom-duckdb, loom-dbt-runner, loom-transform-runner, loom-udf-runtime and loom-airflow - by design code/SQL execution services. Internal ingress is reachable from any workload in the same environment, including this job. `az containerapp auth show` returned {} on every one sampled; the environment has peerAuthentication.mtls.enabled = false and peerTrafficConfiguration.encryption.enabled = false; no ingress sets clientCertificateMode. nsg-snet-container-platform has ZERO outbound security rules and the subnet has no route table, so nothing transits the AzureFirewallSubnet in the same VNet. No exploit chain was demonstrated - deliberately, since probing production internal services from a review is itself a state change - and none is needed: the claim is only that the privileged identity is one unauthenticated hop away and nothing in this module establishes otherwise. DISCHARGED BY either a per-app measurement that every internal-ingress app enforces its own authn, or a control on the network axis: mTLS or EasyAuth on internal ingress, or a dedicated environment/subnet for the runner with an egress NSG and a UDR through the firewall.

2. AT LEAST ONE FLEET-PINNED LANE IS BROKEN BY THE IDENTITY SWAP. Twelve workflow jobs are pinned unconditionally to [self-hosted, loom-aca]. Of those, loom-brain-scan.yml `commercial` obtains its ARM and Cosmos tokens from DefaultAzureCredential({managedIdentityClientId: LOOM_UAMI_CLIENT_ID}) - the CONSOLE identity - and lib/brain/run/azure/scan-credential.ts refuses the service-principal fallback by design (assertTokenIdentity compares the token appid and throws on mismatch). loom-console-cosmos.bicep grants the deploy SP a data-plane role only when isAzureUSGovernment, on the stated assumption that this runner carries the console UAMI. So on Commercial there is no fallback to fall back to. It FAILS CLOSED and loud - ScanIdentityError propagates and the job exits 1 - which is the good version of this bug and still a broken lane. The mirror applies to Gov: its job is now CI_RUNNER-routed, so switching the variable on moves Gov onto a runner whose identity is uami-loom-ci and makes its Gov-only SP grant unreachable for the same chain-order reason. DISCHARGED BY a deliberate least-privilege grant to uami-loom-ci, recorded at runnerUamiId, for each lane that proves it needs one - NOT by re-attaching the console identity.

3. THE VARIABLE CANNOT EXPRESS A PER-BOUNDARY CONFIGURATION. See the SOVEREIGN BOUNDARY EXPOSURE block at the head of this file.''')
param maxExecutions int = 8

@description('Min executions. 0 = scale-to-zero.')
@minValue(0)
param minExecutions int = 0

@description('Scaler polling interval (seconds).')
param pollingInterval int = 30

@description('Max seconds a runner replica may execute before it is terminated. MUST exceed the longest `timeout-minutes` of any job that targets this fleet, or ACA kills the replica mid-job and the check reports CANCELLED - indistinguishable from a human cancel. Measured 2026-09-13: 40 job definitions declare 40-150 minutes, the longest being deploy-fiab-il5 and dr-drill at 150. 9600s = 160 minutes leaves headroom over that maximum.')
param replicaTimeout int = 9600

@description('vCPU per runner replica. Matches the 4 vCPU of a GitHub-hosted ubuntu-latest runner; the workflows are written against that and the caps assume it.')
param cpu string = '4.0'

@description('Memory per runner replica. 16Gi matches ubuntu-latest. NOT arbitrary: at 2.0Gi the console `next build` was OOM-killed after ~4.5 minutes with no error message, and fiab-console-ci.yml sets NODE_OPTIONS=--max-old-space-size=6144, which alone exceeds a 2Gi container.')
param memory string = '16.0Gi'

@description('Container Apps workload profile. The heavy jobs (next build, vitest, the Python matrix) do not fit the Consumption profile, so this fleet runs on the dedicated D8 profile that the environment already provisions and which scales to zero.')
param workloadProfileName string = 'D8'

@description('GitHub PAT value (repo-scoped). Supply via a pipeline @secure() variable. Leave empty when using githubPatKeyVaultSecretUri.')
@secure()
param githubPatSecretValue string = ''

@description('''DISABLED - must be empty. A Key Vault-backed PAT cannot be made safer than the literal one on THIS resource, so the option is refused at validation time rather than left as a path that looks available and cannot deploy.

WHY IT IS REFUSED, and it is a mechanism question, not a preference. Microsoft Learn, "Manage secrets in Azure Container Apps": to reference a secret from Key Vault "you must first enable managed identity in your container app and grant the identity access to the Key Vault secrets", and its troubleshooting table gives "Identity not found - the specified managed identity does not exist OR IS NOT ASSIGNED to the container app". The CLI example passes the same id to BOTH `--user-assigned` and `identityref:`. So the resolving identity must be assigned to this job.

This module previously named consoleUamiId as the resolving identity while assigning only runnerUamiId, so the branch could not deploy at all. The obvious repair - assign consoleUamiId too - is worse than the defect: Container Apps injects IDENTITY_ENDPOINT/IDENTITY_HEADER into the job, so EVERY assigned identity is reachable from arbitrary job code, which is the escalation runnerUamiId exists to close. Resolving with runnerUamiId instead is no better: it would need Key Vault read on the PAT secret, and job code holding that identity could then fetch the PAT straight out of Key Vault, defeating the `exec env -u GITHUB_PAT` scrub in entrypoint.sh.

Supply the PAT via githubPatSecretValue, which is the path provision-gh-runner.sh actually uses. Re-enabling this needs a resolving identity that job code CANNOT assume - an environment-scoped identity, or a separate Container Apps environment for the runner - and that is a design change, not a parameter change.''')
@allowed([
  ''
])
param githubPatKeyVaultSecretUri string = ''

@description('Compliance/cost tags.')
param complianceTags object = {}

// The PAT is supplied as a literal @secure() value. The Key Vault-backed
// alternative is refused at validation time by githubPatKeyVaultSecretUri's
// @allowed([''])  -- read that parameter's description for the mechanism.
// There is deliberately no second arm here: an arm naming an identity this
// resource does not carry is a path that cannot deploy, which is what the
// previous version of this file shipped.
var patSecret = [
  {
    name: 'github-pat'
    value: githubPatSecretValue
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
      // EXACTLY ONE, and it is NOT the console's. See runnerUamiId.
      '${runnerUamiId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: workloadProfileName
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
          // The runner's own identity, which holds AcrPull and nothing else.
          identity: runnerUamiId
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

// The two outputs below exist so the identity boundary this module depends on
// is INSPECTABLE from a deployment's outputs rather than only readable in
// source. They also keep consoleUamiId and githubPatKeyVaultSecretUri
// referenced: both are deliberately retained and deliberately not wired into
// the resource, and a bare `no-unused-params` warning does not say which of
// those two things is true.

@description('The identity actually attached to this Job. Assert this is uami-loom-ci, not the console identity: every assigned identity is reachable from job code via IDENTITY_ENDPOINT.')
output attachedIdentityId string = runnerUamiId

@description('Records that the console identity was SUPPLIED but NOT attached, and that the Key Vault PAT path is refused. Both are load-bearing negatives, so they are emitted rather than left silent.')
output patSourceDisposition object = {
  patSource: 'literal @secure() param (githubPatSecretValue)'
  keyVaultUriSupplied: !empty(githubPatKeyVaultSecretUri)
  consoleUamiSupplied: !empty(consoleUamiId)
  consoleUamiAttached: false
}
