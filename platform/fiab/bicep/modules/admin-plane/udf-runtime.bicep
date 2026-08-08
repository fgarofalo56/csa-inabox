// =====================================================================
// CSA Loom — User Data Functions (UDF) execution runtime
// =====================================================================
// Deploys the Azure-native execution host for Loom User Data Functions as a
// Container App in the admin-plane environment. The UDF editor
// (lib/editors/phase4/user-data-function-editor.tsx) invoke path resolves this
// host via LOOM_UDF_FUNCTION_BASE and POSTs {base}/api/<functionName>; see
// apps/fiab-console/app/api/items/user-data-function/[id]/invoke/route.ts.
// Without this host that invoke path is permanently 409-gated on a fresh
// deploy because nothing emits LOOM_UDF_FUNCTION_BASE — this module fixes that.
//
// Mirrors ./dab-runtime.bicep EXACTLY in host kind and delivery mechanism:
//   * Host kind = Azure Container Apps (Microsoft.App/containerApps). Chosen for
//     the same reasons as DAB: broadly available across clouds incl. Gov/IL5,
//     no Fabric/Power BI dependency (per no-fabric-dependency.md), scales, and
//     runs a stock image with NO custom image build / NO ACR dependency.
//   * A busybox INIT container materialises code delivered as base64 secrets
//     onto a shared EmptyDir volume; the MAIN container is a stock python image
//     that runs the materialised host. (DAB does the same for its config file.)
//
// The one intentional deviation from dab-runtime: DAB preserves its image
// entrypoint and passes only `args`; here we set `command` to run our own host
// (python3 /app/app.py) because the base python image has no relevant
// entrypoint. The host itself (udf-runtime/app.py) runs REAL Python — it imports
// the published UDF source through the fabric.functions shim and returns the
// function's actual return value, so the editor Test panel shows a real result
// (no stub, per no-vaporware.md).
//
// Auth: the Console UAMI is assigned to the app (as DAB assigns it) so UDF code
// can reach Azure data as that managed identity once RBAC is granted. The host
// ingress is reachable by the console BFF; no extra role is needed to INVOKE it
// (the BFF proxies), mirroring DAB which creates no in-module roleAssignment.
//
// INTEGRATION: wire udf-runtime into admin-plane/main.bicep — module invocation
// gated by udfRuntimeEnabled, emit { name:'LOOM_UDF_FUNCTION_BASE', value:
// udfRuntime.outputs.hostUrl } into console apps[] env, surface udfRuntimeEnabled
// + host params from root main.bicep.
// =====================================================================

@description('Container Apps managed environment resource id.')
param managedEnvironmentId string

@description('Azure region.')
param location string = resourceGroup().location

@description('Console UAMI resource id (UDF code runs as this identity for Azure data access).')
param uamiResourceId string

@description('Deploy the UDF runtime host. When false the module deploys nothing and hostUrl is empty (invoke path stays honestly 409-gated).')
param udfRuntimeEnabled bool = true

// Both images below are DIGEST-PINNED (FINISHLINE C18). Neither floated `:latest`,
// but `4-python3.11` and `2.0` are ROLLING tags — MCR republishes them in place on
// every runtime/CVE rebase — so without a digest two deploys of the same commit can
// still land different bytes. Registry of record + bump procedure:
// platform/fiab/images/mcr-images.json; enforced by scripts/ci/check-mcr-image-pins.mjs.
@description('Stock container image that provides python3 + a POSIX shell. Default is an MCR image available in Commercial and Gov/IL5; override if a different registry is required. Digest-pinned.')
param udfImage string = 'mcr.microsoft.com/azure-functions/python:4-python3.11@sha256:ebc5ba1fc20f7809b2676872a016ba6ede2c43d2feab4c22164b6f2a07d75733'

@description('Busybox image used by the init container to materialise host code from secrets (matches dab-runtime). Digest-pinned.')
param initImage string = 'mcr.microsoft.com/cbl-mariner/busybox:2.0@sha256:e4fb4d51fc9b70d6cdc1ce66a0af02ab40554d2ca632e1d188fabc760e432fdd'

@description('HTTP port the host listens on and ACA ingress targets.')
param hostPort int = 8080

@description('CORS origin allowed to call the host directly (the Loom console origin). The BFF proxy path does not require this.')
param corsOrigin string = '*'

@description('CIDR ranges allowed to reach this app on top of internal-ingress isolation — normally ONLY the Container Apps environment infrastructure subnet the Console runs in. Empty => no IP rules, meaning ANY workload on the CAE VNet can reach a host that executes caller-supplied Python (the py/code-injection finding, #2653). ACA supports Allow-only or Deny-only rule sets; these are emitted as Allow rules, so anything outside them is denied. Mirrors loom-unity-app.bicep consoleAllowedCidrs.')
param consoleAllowedCidrs array = []

// Host code delivered as base64 secrets and materialised by the init container.
// Source of truth is udf-runtime/*.py — reviewable, testable, real (see README).
var appPyB64 = base64(loadTextContent('udf-runtime/app.py'))
var fabricFuncsB64 = base64(loadTextContent('udf-runtime/fabric_functions.py'))
var defaultSrcB64 = base64(loadTextContent('udf-runtime/default_function_app.py'))

// INTERNAL ingress: (a) the runtime executes caller-supplied code and must never
// be publicly reachable; (b) on an internal ACA environment only the
// `<app>.internal.<env-domain>` FQDN resolves from sibling apps — with
// external:true the console's server-side fetch to the apex-form FQDN failed DNS
// (live-caught, rel-T05). hostUrl output stays correct.
//
// #2653: internal ingress alone means "anything on the CAE VNet" can POST
// arbitrary Python to this host and have it executed, because the host holds no
// credential to check (deliberately — main.bicep records that this host executes
// the item's own Python and must therefore never receive one, since that Python
// could read it back out of the environment). With no secret available, the
// boundary has to be the network. These Allow rules narrow it from the whole
// VNet to the Console's subnet, matching loom-unity-app.bicep.
var ingressIpRules = [for (cidr, i) in consoleAllowedCidrs: {
  name: 'allow-loom-console-${i}'
  description: 'Only the Loom Console subnet may reach the UDF execution host (#2653).'
  ipAddressRange: cidr
  action: 'Allow'
}]
var ingressBase = {
  external: false
  targetPort: hostPort
  transport: 'auto'
  allowInsecure: false
}
var ingressConfig = empty(consoleAllowedCidrs) ? ingressBase : union(ingressBase, {
  ipSecurityRestrictions: ingressIpRules
})

resource udf 'Microsoft.App/containerApps@2024-03-01' = if (udfRuntimeEnabled) {
  name: 'loom-udf-runtime'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${uamiResourceId}': {} }
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: ingressConfig
      secrets: [
        { name: 'app-py-b64', value: appPyB64 }
        { name: 'fabric-funcs-b64', value: fabricFuncsB64 }
        { name: 'default-src-b64', value: defaultSrcB64 }
      ]
    }
    template: {
      // Init container materialises the host, the fabric.functions shim, and the
      // default function bundle onto a shared EmptyDir volume; the main python
      // container then runs the host from that volume.
      initContainers: [
        {
          name: 'code-writer'
          image: initImage
          command: [ '/bin/sh', '-c' ]
          args: [
            'set -e; mkdir -p /app/fabric /app/udf; echo "$APP_PY_B64" | base64 -d > /app/app.py; echo "$FABRIC_FUNCS_B64" | base64 -d > /app/fabric/functions.py; : > /app/fabric/__init__.py; echo "$DEFAULT_SRC_B64" | base64 -d > /app/udf/function_app.py; echo "wrote UDF host to /app"'
          ]
          env: [
            { name: 'APP_PY_B64', secretRef: 'app-py-b64' }
            { name: 'FABRIC_FUNCS_B64', secretRef: 'fabric-funcs-b64' }
            { name: 'DEFAULT_SRC_B64', secretRef: 'default-src-b64' }
          ]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          volumeMounts: [ { volumeName: 'udf-app', mountPath: '/app' } ]
        }
      ]
      containers: [
        {
          name: 'udf'
          image: udfImage
          // Replace the base image entrypoint with our stdlib host (intentional
          // deviation from dab-runtime — see module header).
          command: [ 'python3', '/app/app.py' ]
          env: [
            { name: 'PORT', value: string(hostPort) }
            { name: 'LOOM_UDF_CORS_ORIGIN', value: corsOrigin }
            // #2653 — tells the host whether the network control it depends on is
            // actually in place, so an unpinned deployment logs a SECURITY WARNING
            // on every boot instead of looking identical to a pinned one. The host
            // cannot discover this for itself: IP rules are enforced by ACA in
            // front of the container and are invisible from inside it.
            { name: 'LOOM_UDF_INGRESS_IP_RESTRICTED', value: empty(consoleAllowedCidrs) ? '' : '1' }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          volumeMounts: [ { volumeName: 'udf-app', mountPath: '/app' } ]
          probes: [
            { type: 'Liveness', httpGet: { path: '/health', port: hostPort }, initialDelaySeconds: 15, periodSeconds: 30 }
          ]
        }
      ]
      volumes: [ { name: 'udf-app', storageType: 'EmptyDir' } ]
      scale: { minReplicas: 1, maxReplicas: 2 }
    }
  }
}

@description('Wire this into LOOM_UDF_FUNCTION_BASE on the loom-console app. Empty when udfRuntimeEnabled is false.')
output hostUrl string = udfRuntimeEnabled ? 'https://${udf.properties.configuration.ingress.fqdn}' : ''
output udfFqdn string = udfRuntimeEnabled ? udf.properties.configuration.ingress.fqdn : ''

@description('True when ingress carries an IP allow-list on top of internal-only isolation (#2653). False means any workload on the CAE VNet can reach a host that executes caller-supplied Python.')
output ingressIpRestricted bool = !empty(consoleAllowedCidrs)
