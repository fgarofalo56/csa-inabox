// CSA Loom Health Data Services (LHDS) - engines: PDP workload only (W1-5).
//
// One OPA (policy decision point, ADR-011) per stamp, as a Deployment on the stamp
// cluster. It pulls the stamp's ES256-signed Rego bundle from the control plane
// (GET /api/health/pdp/stamps/{stamp}/bundle.tar.gz) and verifies the signature
// itself; an unverifiable bundle is never activated and persist:true keeps the last
// good one through a control-plane outage. The FHIR / DICOM / terminology engines
// join this file in later items; this module deliberately contains the PDP only.
//
// Authentication to the control plane is AKS workload identity (client assertion
// from the projected service-account token): no secret exists. The only value
// embedded is the bundle-verification PUBLIC key.
//
// NOT wired into health.bicep (outside this item's file ownership) and not deployed:
// supported-in-code only, no deploy receipt (cloud-parity.md). Decision latency
// p95 < 10 ms is UNMEASURED.
//
// Follow-up that is NOT done here and is a real gate until done: the PDP identity
// (output identityPrincipalId) must hold the `HealthCP.Reader` app role on the
// control-plane app registration. That is an Entra app-role assignment (Graph),
// not an ARM resource, so it belongs in post-deploy bootstrap.

targetScope = 'resourceGroup'

@description('Workload name (Kubernetes Deployment / Service / ServiceAccount), DNS-label safe.')
@maxLength(32)
param name string = 'loom-health-pdp'

@description('Primary region.')
param location string = resourceGroup().location

@description('OPA image reference in the ACR (pin an explicit tag or digest, never :latest). Must be the static build of OPA v1.9.0 or later.')
param image string

@description('Name of the ACR holding the image; it may live in another resource group of this subscription.')
param acrName string

@description('Resource group of that ACR.')
param acrResourceGroup string

@description('Stamp id (slug) this PDP serves. Selects the bundle resource.')
@minLength(2)
@maxLength(40)
param stampId string

@description('Base URL of the control plane, no trailing slash, https only (for example https://loom-health-cp.internal.example). The bundle is fetched from <this>/api/health/pdp/stamps/<stampId>/bundle.tar.gz.')
param controlPlaneBaseUrl string

@description('Audience (app id URI) of the control plane; the token scope requested is <this>/.default.')
param controlPlaneAudience string

@description('Entra tenant id that issues the PDP identity token.')
param entraTenantId string = tenant().tenantId

@description('PEM PUBLIC key that verifies bundle signatures (ES256). Public material only; the private key stays in Key Vault.')
param bundleVerificationPublicKeyPem string

@description('Name of the stamp cluster (same resource group as this module).')
param aksClusterName string

@description('OIDC issuer URL of that cluster, for the workload-identity federated credential.')
param aksOidcIssuerUrl string

@description('Kubernetes namespace.')
param aksNamespace string = 'loom-health'

@description('PDP replicas.')
@minValue(1)
param replicas int = 2

@description('Skip role assignments (re-deploys where the deployer cannot write RBAC).')
param skipRoleGrants bool = false

@description('Tags.')
param tags object = {}

var authorityHost = replace(replace(environment().authentication.loginEndpoint, 'https://', ''), '/', '')
var opaPort = 8181
var aksClusterAdminRoleId = '0ab0b1a8-8aac-4efd-b8c2-3ee1fb270be8'
var aksRbacClusterAdminRoleId = 'b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b'

resource pdpIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'uami-${name}-${location}'
  location: location
  tags: tags
}

resource cluster 'Microsoft.ContainerService/managedClusters@2025-04-01' existing = {
  name: aksClusterName
}

module kubeletAcrPull 'acr-pull.bicep' = {
  name: 'lhds-pdp-acrpull-kubelet'
  scope: resourceGroup(acrResourceGroup)
  params: {
    acrName: acrName
    principalId: cluster.properties.identityProfile.kubeletidentity.objectId
    skipRoleGrants: skipRoleGrants
  }
}

resource federation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2024-11-30' = {
  parent: pdpIdentity
  name: name
  properties: {
    issuer: aksOidcIssuerUrl
    subject: 'system:serviceaccount:${aksNamespace}:${name}'
    audiences: ['api://AzureADTokenExchange']
  }
}

resource scriptIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'uami-${name}-deploy-${location}'
  location: location
  tags: tags
}

resource scriptClusterAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  scope: cluster
  name: guid(cluster.id, scriptIdentity.id, aksClusterAdminRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', aksClusterAdminRoleId)
    principalId: scriptIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource scriptRbacAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  scope: cluster
  name: guid(cluster.id, scriptIdentity.id, aksRbacClusterAdminRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', aksRbacClusterAdminRoleId)
    principalId: scriptIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// OPA config (mirrors apps/loom-health-pdp/config/opa-config.yaml). The workload
// identity webhook injects AZURE_CLIENT_ID and AZURE_FEDERATED_TOKEN_FILE; OPA
// substitutes ${VAR} in its config file. Decision logs go to the console until W8.
var opaConfig = join([
  'persistence_directory: /var/opa'
  'services:'
  '  health-cp:'
  '    url: ${controlPlaneBaseUrl}/api/health/pdp'
  '    credentials:'
  '      oauth2:'
  '        grant_type: client_credentials'
  '        token_url: https://${authorityHost}/${entraTenantId}/oauth2/v2.0/token'
  '        client_id: "\${AZURE_CLIENT_ID}"'
  '        client_assertion_path: "\${AZURE_FEDERATED_TOKEN_FILE}"'
  '        scopes: ["${controlPlaneAudience}/.default"]'
  'bundles:'
  '  lhds:'
  '    service: health-cp'
  '    resource: stamps/${stampId}/bundle.tar.gz'
  '    persist: true'
  '    signing:'
  '      keyid: global'
  '    polling:'
  '      min_delay_seconds: 30'
  '      max_delay_seconds: 60'
  'keys:'
  '  global:'
  '    algorithm: ES256'
  '    key: |'
  '      ${replace(trim(bundleVerificationPublicKeyPem), '\n', '\n      ')}'
  'decision_logs:'
  '  console: true'
], '\n')

// Restricted pod security: non-root, no privilege escalation, read-only root fs,
// all capabilities dropped, seccomp RuntimeDefault. Readiness is /health?bundles:
// the pod takes no traffic until a SIGNED bundle is active, so an unconfigured or
// unverifiable PDP is not Ready and its callers fail closed (503, ADR-011).
var manifest = join([
  'apiVersion: v1'
  'kind: Namespace'
  'metadata:'
  '  name: ${aksNamespace}'
  '---'
  'apiVersion: v1'
  'kind: ServiceAccount'
  'metadata:'
  '  name: ${name}'
  '  namespace: ${aksNamespace}'
  '  annotations:'
  '    azure.workload.identity/client-id: "${pdpIdentity.properties.clientId}"'
  '---'
  'apiVersion: v1'
  'kind: ConfigMap'
  'metadata:'
  '  name: ${name}-config'
  '  namespace: ${aksNamespace}'
  'data:'
  '  opa-config.yaml: |'
  '    ${replace(opaConfig, '\n', '\n    ')}'
  '---'
  'apiVersion: apps/v1'
  'kind: Deployment'
  'metadata:'
  '  name: ${name}'
  '  namespace: ${aksNamespace}'
  'spec:'
  '  replicas: ${replicas}'
  '  selector:'
  '    matchLabels:'
  '      app: ${name}'
  '  template:'
  '    metadata:'
  '      labels:'
  '        app: ${name}'
  '        azure.workload.identity/use: "true"'
  '    spec:'
  '      serviceAccountName: ${name}'
  '      securityContext:'
  '        runAsNonRoot: true'
  '        runAsUser: 1000'
  '        seccompProfile:'
  '          type: RuntimeDefault'
  '      containers:'
  '        - name: opa'
  '          image: ${image}'
  '          args:'
  '            - run'
  '            - --server'
  '            - --addr=:${opaPort}'
  '            - --config-file=/config/opa-config.yaml'
  '            - --log-level=info'
  '          ports:'
  '            - containerPort: ${opaPort}'
  '          resources:'
  '            requests: { cpu: 250m, memory: 256Mi }'
  '            limits: { cpu: 500m, memory: 512Mi }'
  '          securityContext:'
  '            allowPrivilegeEscalation: false'
  '            readOnlyRootFilesystem: true'
  '            capabilities: { drop: ["ALL"] }'
  '          volumeMounts:'
  '            - { name: config, mountPath: /config, readOnly: true }'
  '            - { name: state, mountPath: /var/opa }'
  '          livenessProbe:'
  '            httpGet: { path: /health, port: ${opaPort} }'
  '            initialDelaySeconds: 5'
  '            periodSeconds: 15'
  '          readinessProbe:'
  '            httpGet: { path: "/health?bundles", port: ${opaPort} }'
  '            initialDelaySeconds: 5'
  '            periodSeconds: 10'
  '      volumes:'
  '        - name: config'
  '          configMap: { name: ${name}-config }'
  '        - name: state'
  '          emptyDir: {}'
  '---'
  'apiVersion: v1'
  'kind: Service'
  'metadata:'
  '  name: ${name}'
  '  namespace: ${aksNamespace}'
  'spec:'
  '  type: ClusterIP'
  '  selector:'
  '    app: ${name}'
  '  ports:'
  '    - port: 80'
  '      targetPort: ${opaPort}'
], '\n')

// Fails closed: `set -e`, and `rollout status` must succeed before the script exits 0.
// With no signed bundle the pod never becomes Ready, so this FAILS the deployment
// rather than reporting success over an unverified outcome (deploy-integrity R6).
resource applyManifest 'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  name: 'apply-${name}'
  location: location
  kind: 'AzureCLI'
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${scriptIdentity.id}': {}
    }
  }
  properties: {
    azCliVersion: '2.67.0'
    retentionInterval: 'PT1H'
    timeout: 'PT20M'
    cleanupPreference: 'OnSuccess'
    forceUpdateTag: uniqueString(manifest)
    environmentVariables: [
      { name: 'MANIFEST_B64', value: base64(manifest) }
      { name: 'CLUSTER_RG', value: resourceGroup().name }
      { name: 'CLUSTER_NAME', value: aksClusterName }
      { name: 'NAMESPACE', value: aksNamespace }
      { name: 'DEPLOYMENT', value: name }
    ]
    scriptContent: '''
      set -euo pipefail
      echo "$MANIFEST_B64" | base64 -d > manifest.yaml
      az aks command invoke -g "$CLUSTER_RG" -n "$CLUSTER_NAME" --file manifest.yaml \
        --command "kubectl apply -f manifest.yaml"
      az aks command invoke -g "$CLUSTER_RG" -n "$CLUSTER_NAME" \
        --command "kubectl -n $NAMESPACE rollout status deployment/$DEPLOYMENT --timeout=300s"
    '''
  }
  dependsOn: [
    scriptClusterAdmin
    scriptRbacAdmin
    kubeletAcrPull
    federation
  ]
}

@description('In-cluster decision API address interceptors call: POST /v1/data/lhds/authz/decision.')
output decisionEndpoint string = 'http://${name}.${aksNamespace}.svc.cluster.local/v1/data/lhds/authz/decision'

@description('PDP identity client id (workload identity).')
output identityClientId string = pdpIdentity.properties.clientId

@description('PDP identity principal id. Needs the HealthCP.Reader app role on the control-plane registration (post-deploy bootstrap, not done by this module).')
output identityPrincipalId string = pdpIdentity.properties.principalId
