// CSA Loom — Power BI R/Python script-visual executor Container App (Wave 4)
//
// Backs LOOM_SCRIPT_RUNNER_URL for the report-designer's R/Python script visual.
// The report designer's script visual is Power BI's R/Python visual built 1:1 on
// Azure: the Values well becomes a `dataset` DataFrame (column names == field
// names, rows grouped + deduped), the user's R/Python script plots to the default
// device, and the ACTIVE figure is captured as a static PNG — exactly the Power BI
// contract (learn.microsoft.com/power-bi/connect-data/desktop-python-visuals).
// The BFF /query route POSTs { language, script, dataset.csv } here; this app runs
// the script and returns out.png. No Microsoft Fabric / Power BI service is
// touched — Azure-native ACA executor + the existing Synapse /query Path-3 only.
//
// REAL executor (no-vaporware): app.py runs the user script in a resource-limited
// subprocess and returns a real PNG. When this module is not deployed, the BFF
// returns an honest 503 naming LOOM_SCRIPT_RUNNER_URL + this bicep module rather
// than faking an image.
//
// SANDBOX THREAT MODEL (documented honestly here + in app.py + README):
// The CONTAINER is the security boundary — exactly like Power BI's locked
// container, arbitrary user code DOES execute inside it. Isolation is layered:
//   (1) non-root `runner` user,
//   (2) INTERNAL ingress only (external:false — never public),
//   (3) per-request ephemeral mkdtemp under /tmp chmod 700, rmtree in finally,
//   (4) scrubbed minimal env (fresh dict: PATH/HOME/MPLBACKEND=Agg/LANG — NO
//       os.environ passthrough, NO inherited secrets),
//   (5) POSIX rlimits via preexec_fn (RLIMIT_CPU ~25s, RLIMIT_AS ~1.5GB,
//       RLIMIT_FSIZE ~50MB, RLIMIT_NPROC),
//   (6) start_new_session=True + wall-clock timeout (~30s) that os.killpg(SIGKILL)s
//       the whole process group,
//   (7) script-size cap (200KB), row/cell caps, PNG size cap.
//
// CRITICAL identity caveat (carried from the threat model into IaC): a Container
// App exposes its assigned UAMI to in-container code via IMDS, so arbitrary user
// script code could request a token for whatever the runner's identity can reach.
// The runner MUST therefore use a LEAST-PRIVILEGE identity — a dedicated
// `uami-loom-script-runner` holding AcrPull ONLY and ZERO data-plane roles.
// Reusing the broadly-permissioned Console UAMI is a genuine sandbox hole; any
// interim Console-UAMI reuse is a KNOWN weakness to tighten, never silent.
//
// Azure-native only (Container Apps). No Microsoft Fabric / Power BI dependency.
//
// ---------------------------------------------------------------------------
// TODO — wire into platform/fiab/bicep/modules/admin-plane/main.bicep
//   (a sibling workflow owns main.bicep; do NOT edit it from this module):
//
//     var scriptRunnerActive = scriptRunnerEnabled
//       && containerPlatform == 'containerApps' && deployAppsEnabled
//
//     module scriptRunner 'script-runner-app.bicep' = if (scriptRunnerActive) {
//       name: 'script-runner'
//       params: {
//         name: 'loom-script-runner'
//         location: location
//         environmentId: containerPlatform_env.outputs.environmentId   // the CAE id
//         // Prefer a dedicated AcrPull-only identity over the Console UAMI:
//         scriptRunnerUamiId: scriptRunnerUami.outputs.id              // uami-loom-script-runner
//         acrLoginServer: registry.outputs.acrLoginServer
//         image: '${registry.outputs.acrLoginServer}/loom-script-runner:${appImageTags.scriptRunner}'
//         complianceTags: complianceTags
//       }
//     }
//
//   And add to the console env array (near LOOM_DBT_RUNNER_URL, ~line 2688):
//     { name: 'LOOM_SCRIPT_RUNNER_URL', value: scriptRunnerActive ? scriptRunner!.outputs.fqdn != '' ? 'https://${scriptRunner!.outputs.fqdn}' : '' : '' }
// ---------------------------------------------------------------------------

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string

@description('Deployment region (e.g. centralus / usgovvirginia).')
param location string

@description('Container Apps managed-environment (CAE) resource id — the console VNet-integrated env.')
param environmentId string

@description('UserAssigned UAMI resource id — assigned to the app for BOTH ACR pull AND the app identity. It MUST be a least-privilege, AcrPull-ONLY identity (a dedicated uami-loom-script-runner with ZERO data-plane roles): the ACA app exposes this identity to arbitrary in-container user script code via IMDS, so reusing a broadly-permissioned identity (e.g. the Console UAMI) is a real sandbox hole.')
param scriptRunnerUamiId string

@description('ACR login server, e.g. acrloomk6mvh5sm6z7do.azurecr.io.')
param acrLoginServer string

@description('Container image reference (the loom-script-runner image in ACR — pin an explicit tag, never :latest).')
param image string

@description('Internal ingress target port the executor listens on (matches PORT env / app.py).')
param targetPort int = 8080

@description('Compliance/cost tags.')
param complianceTags object = {}

// Pinned to the same Container Apps api-version the sibling ACA modules use
// (mcp-catalog-app.bicep, dbt-runner.bicep, gh-runner-job.bicep) — bicep/runtime sync.
resource app 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: name
  location: location
  tags: complianceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${scriptRunnerUamiId}': {}
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
      // ACR pull via the UAMI. (mcp-catalog-app.bicep omitted this because its
      // image was a public ghcr image; ours is a private ACR image, so the
      // registries block resolving by the UAMI is REQUIRED.)
      registries: [
        {
          server: acrLoginServer
          identity: scriptRunnerUamiId
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
          // 1 vCPU / 2Gi — the rlimits inside app.py (RLIMIT_AS ~1.5GB,
          // RLIMIT_CPU ~25s) cap a single script run below this envelope.
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
          // Probe the dedicated health path, never the executor endpoint.
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
      // Scale-to-zero between renders (matches the threat-model + README design):
      // the executor is only hit on-demand by the Console BFF /query route when a
      // user runs the script visual, so there is NO standing warm replica and NO
      // standing cost. The CAE's default HTTP scale rule (ingress is enabled)
      // scales this app up from 0 on the first inbound request; idle renders cost
      // nothing. maxReplicas caps concurrent renders at 3.
      scale: {
        minReplicas: 0
        maxReplicas: 3
      }
    }
  }
}

@description('Internal FQDN of the deployed script-runner executor (Console reads it as LOOM_SCRIPT_RUNNER_URL, prefixed https://).')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('Container App resource id.')
output appId string = app.id
