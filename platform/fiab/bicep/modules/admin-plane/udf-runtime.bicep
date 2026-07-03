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

@description('Stock container image that provides python3 + a POSIX shell. Default is an MCR image available in Commercial and Gov/IL5; override if a different registry is required.')
param udfImage string = 'mcr.microsoft.com/azure-functions/python:4-python3.11'

@description('Busybox image used by the init container to materialise host code from secrets (matches dab-runtime).')
param initImage string = 'mcr.microsoft.com/cbl-mariner/busybox:2.0'

@description('HTTP port the host listens on and ACA ingress targets.')
param hostPort int = 8080

@description('CORS origin allowed to call the host directly (the Loom console origin). The BFF proxy path does not require this.')
param corsOrigin string = '*'

// Host code delivered as base64 secrets and materialised by the init container.
// Source of truth is udf-runtime/*.py — reviewable, testable, real (see README).
var appPyB64 = base64(loadTextContent('udf-runtime/app.py'))
var fabricFuncsB64 = base64(loadTextContent('udf-runtime/fabric_functions.py'))
var defaultSrcB64 = base64(loadTextContent('udf-runtime/default_function_app.py'))

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
      ingress: {
        // INTERNAL ingress: (a) the runtime executes author-owned code and must
        // never be publicly reachable; (b) on an internal ACA environment only
        // the `<app>.internal.<env-domain>` FQDN resolves from sibling apps —
        // with external:true the console's server-side fetch to the apex-form
        // FQDN failed DNS (live-caught, rel-T05). hostUrl output stays correct.
        external: false
        targetPort: hostPort
        transport: 'auto'
        allowInsecure: false
      }
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
