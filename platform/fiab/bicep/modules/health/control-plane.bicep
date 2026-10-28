// CSA Loom Health Data Services (LHDS) - control plane deployment (ADR-005, W1-3 bicep follow-up).
//
// Deploys apps/loom-health-cp: its own Cosmos account (registries, jobs, routing
// map, SLO), a user-assigned identity holding the Cosmos data-plane role and the
// image pull, and the workload itself.
//
// Two hosting paths with their OWN selector (`platform`), because the admin-plane
// `containerPlatform` is `containerApps` in every param file including
// il5.bicepparam (W0-RECEIPT.md s7) and so cannot say "AKS at IL5":
//   containerApps - Container App on the hub environment (Commercial, GCC, GCC-High).
//   aks           - Deployment on the stamp cluster (IL5, where Container Apps is not
//                   audit-scoped in this PRP set). Applied with `az aks command invoke`
//                   from a deployment script because the cluster is private and
//                   local accounts are disabled.
//
// Invoked by platform/fiab/bicep/health.bicep, NOT by main.bicep: LHDS is its own
// subscription-level deployment unit with its own 4 MiB ARM budget (embedding it in
// main.bicep pushed deploy-templates/main.json over 4,194,304 bytes). Deployed by
// .github/workflows/deploy-health.yml.
//
// Scope: the stamp resource group (created by health.bicep behind `healthEnabled`).
//
// Not measured: a live deploy of either path (estate paused, Gov ADX stopped, #5123).
// Supported-in-code only (cloud-parity.md); neither path has produced a deploy receipt.

targetScope = 'resourceGroup'

@description('Workload name (Container App name / Kubernetes Deployment name), DNS-label safe.')
@maxLength(32)
param name string = 'loom-health-cp'

@description('Primary region.')
param location string = resourceGroup().location

@description('Cloud boundary. Selects the LOOM_HEALTH_CP_CLOUD value, hence the Entra authority host the service validates tokens against.')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('Hosting path. containerApps = Container App on `environmentId`; aks = Deployment on the stamp cluster. Independent of the admin-plane containerPlatform.')
@allowed(['containerApps', 'aks'])
param platform string

@description('Container image reference (pin an explicit tag, never :latest).')
param image string

@description('Login server of the ACR holding the image, for example acrloomxxxx.azurecr.io or .azurecr.us.')
param acrLoginServer string

@description('Name of that ACR. It may live in another resource group (the hub), in this subscription.')
param acrName string

@description('Resource group of that ACR.')
param acrResourceGroup string

@description('Entra tenant id whose tokens the service accepts (pins the issuer).')
param entraTenantId string = tenant().tenantId

@description('Accepted token audiences (app id URI and/or client id). At least one: the service refuses to start without one.')
@minLength(1)
param audiences array

@description('Optional allow-list of caller app ids (token azp/appid). Empty = any caller with a valid role.')
param allowedCallerAppIds array = []

@description('SLO availability target, a fraction strictly between 0 and 1.')
param sloAvailabilityTarget string = '0.999'

@description('containerApps path: resource id of the Container Apps managed environment. Ignored on aks.')
param environmentId string = ''

@description('aks path: name of the stamp cluster (same resource group as this module). Ignored on containerApps.')
param aksClusterName string = ''

@description('aks path: OIDC issuer URL of that cluster, for the workload-identity federated credential. Ignored on containerApps.')
param aksOidcIssuerUrl string = ''

@description('aks path: Kubernetes namespace for the control plane.')
param aksNamespace string = 'loom-health'

@description('Private endpoint subnet for the Cosmos account. Empty = no private endpoint and the account keeps public network access (AAD-only, local auth disabled). A deployment that needs the private posture must supply this and cosmosPrivateDnsZoneId.')
param privateEndpointSubnetId string = ''

@description('Private DNS zone id (privatelink.documents.azure.<com|us>) for the Cosmos private endpoint. Empty skips the DNS zone group.')
param cosmosPrivateDnsZoneId string = ''

@description('Cosmos database autoscale ceiling in RU/s (shared by the eight containers). Autoscale scales to 10 percent of this.')
@minValue(1000)
param cosmosMaxThroughput int = 1000

@description('Spread the Cosmos account over availability zones. Off by default: not every region has zonal Cosmos capacity.')
param cosmosZoneRedundant bool = false

@description('Resource id of the stamp Key Vault (same resource group as this module). The control-plane identity is granted Key Vault Crypto Officer on it so tenant.destroy can disable and delete tenant keys (crypto-shred). Empty = no grant and tenant.destroy cannot shred. Scoped to the vault, the narrowest static scope: tenant keys are created at runtime, so a per-key scope cannot be written here.')
param keyVaultId string = ''

@description('Authorization server: public issuer URL (https, with its path, no trailing slash). The AS is not optional in the service image, so leaving this empty means the control plane will not start on an image that includes it; health.bicep reports the gap in healthControlPlaneState.authServerMissing.')
param authIssuerUrl string = ''

@description('Authorization server: public FHIR edge base URL (https); a tenant FHIR base is {base}/{tenant}/fhir.')
param authFhirBaseUrl string = ''

@description('Authorization server: client id of its Entra app registration. The app must carry a federated identity credential trusting the control-plane identity (see output authFederatedCredential); that Entra object is not an ARM resource and is created by the post-deploy bootstrap, not here.')
param authAsClientId string = ''

@description('Authorization server: optional admin-consent URL surfaced by the Graph-consent readiness gate Fix-it.')
param authGraphConsentUrl string = ''

@description('Authorization server: versioned Key Vault key id to sign tokens with. Empty = this module creates an EC P-384 signing key in keyVaultId and uses it.')
param authSigningKeyId string = ''

@description('Skip role assignments (re-deploys where the deployer cannot write RBAC).')
param skipRoleGrants bool = false

@description('Log Analytics workspace id for Cosmos diagnostics. Empty = none.')
param workspaceId string = ''

@description('Tags.')
param tags object = {}

var isGov = boundary == 'GCC-High' || boundary == 'IL5'
var cloudName = boundary == 'Commercial' ? 'commercial' : (boundary == 'GCC' ? 'gcc' : (boundary == 'GCC-High' ? 'gcc-high' : 'il5'))
var cosmosSuffix = isGov ? 'azure.us' : 'azure.com'
var accountName = take('cosmos-lhds-cp-${uniqueString(resourceGroup().id)}', 44)
var databaseName = 'loom-health-cp'
// defaultTtl -1 = TTL enabled with no default expiry, so each item's own `ttl` is honoured
// (the authorization server writes a per-item ttl on replay ids and grants). 0 = TTL off.
var containerDefs = [
  { name: 'health-stamps', defaultTtl: 0 }
  { name: 'health-tenants', defaultTtl: 0 }
  { name: 'health-routing', defaultTtl: 0 }
  { name: 'health-jobs', defaultTtl: 0 }
  { name: 'health-slo', defaultTtl: 0 }
  { name: 'health-auth-config', defaultTtl: 0 }
  { name: 'health-auth-replay', defaultTtl: -1 }
  { name: 'health-auth-grants', defaultTtl: -1 }
]
var onAks = platform == 'aks'
var servicePort = 8080

var cosmosDataContributorId = '00000000-0000-0000-0000-000000000002'
var aksClusterAdminRoleId = '0ab0b1a8-8aac-4efd-b8c2-3ee1fb270be8'
var aksRbacClusterAdminRoleId = 'b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b'
var cosmosEndpointUrl = 'https://${accountName}.documents.${cosmosSuffix}:443/'

// ── Identity ──────────────────────────────────────────────────────────────────
resource cpIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: 'uami-${name}-${location}'
  location: location
  tags: tags
}

// ── Cosmos (AAD-only; the service never sees a key) ───────────────────────────
resource account 'Microsoft.DocumentDB/databaseAccounts@2024-12-01-preview' = {
  name: accountName
  location: location
  kind: 'GlobalDocumentDB'
  tags: tags
  properties: {
    databaseAccountOfferType: 'Standard'
    disableLocalAuth: true
    minimalTlsVersion: 'Tls12'
    publicNetworkAccess: empty(privateEndpointSubnetId) ? 'Enabled' : 'Disabled'
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: cosmosZoneRedundant
      }
    ]
    backupPolicy: {
      type: 'Continuous'
      continuousModeProperties: { tier: 'Continuous7Days' }
    }
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-12-01-preview' = {
  parent: account
  name: databaseName
  properties: {
    resource: { id: databaseName }
    options: { autoscaleSettings: { maxThroughput: cosmosMaxThroughput } }
  }
}

// All containers are partitioned on /id (apps/loom-health-cp/README.md). Data-plane
// RBAC cannot create containers, so they are created here, not by the service.
resource containers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-12-01-preview' = [for c in containerDefs: {
  parent: database
  name: c.name
  properties: {
    resource: {
      id: c.name
      partitionKey: {
        paths: ['/id']
        kind: 'Hash'
      }
      defaultTtl: c.defaultTtl == 0 ? null : c.defaultTtl
    }
  }
}]

resource cosmosDataRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-12-01-preview' = if (!skipRoleGrants) {
  parent: account
  name: guid(account.id, cpIdentity.id, cosmosDataContributorId)
  properties: {
    roleDefinitionId: '${account.id}/sqlRoleDefinitions/${cosmosDataContributorId}'
    principalId: cpIdentity.properties.principalId
    scope: '${account.id}/dbs/${databaseName}'
  }
  dependsOn: [
    database
  ]
}

// ── Key Vault: crypto-shred (tenant.destroy disables, then deletes, tenant keys) ──
// Key Vault Crypto Officer = key create/disable/delete/purge, NO secrets or certificates and no
// role management. Assigned on the stamp vault only (not the resource group).
var kvCryptoOfficerRoleId = '14b46e9e-c2b7-41b4-b07b-48a6ebf60603'

resource stampVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = if (!empty(keyVaultId)) {
  name: last(split(keyVaultId, '/'))
}

resource cpKeyOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(keyVaultId) && !skipRoleGrants) {
  scope: stampVault
  name: guid(keyVaultId, cpIdentity.id, kvCryptoOfficerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvCryptoOfficerRoleId)
    principalId: cpIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'LHDS control plane: disable and delete tenant keys on tenant.destroy (crypto-shred).'
  }
}

// ── Authorization server signing key (W1-4) ───────────────────────────────────
// ES384 tokens (apps/loom-health-cp src/auth/signer.ts) are signed by Key Vault: the private key
// never leaves the vault. Created through the ARM control plane (works with public network access
// off, needs no data-plane role for the deployer). No rotation policy: the service publishes a
// single JWKS key from the versioned id in LOOM_HEALTH_CP_SIGNING_KEY_ID, so an automatic new
// version would leave tokens signed by a version the JWKS does not publish. Rotate by redeploying
// with a new key name and rolling the app.
var kvCryptoUserRoleId = '12338af0-0e69-4776-bea7-57ae8d297424'
var createSigningKey = !empty(keyVaultId) && empty(authSigningKeyId)

resource signingKey 'Microsoft.KeyVault/vaults/keys@2024-11-01' = if (createSigningKey) {
  parent: stampVault
  name: 'lhds-as-signing'
  properties: {
    kty: 'EC-HSM'
    curveName: 'P-384'
    keyOps: ['sign', 'verify']
    attributes: { enabled: true }
  }
}

// Crypto User on the signing key only (sign + get), so the AS can sign without the broader grant.
resource cpSigningKeyUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (createSigningKey && !skipRoleGrants) {
  scope: signingKey
  name: guid(keyVaultId, 'lhds-as-signing', cpIdentity.id, kvCryptoUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvCryptoUserRoleId)
    principalId: cpIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'LHDS control plane: sign LHDS access tokens with the authorization server key.'
  }
}

var signingKeyIdEffective = !empty(authSigningKeyId) ? authSigningKeyId : (createSigningKey ? signingKey!.properties.keyUriWithVersion : '')

resource cosmosPe 'Microsoft.Network/privateEndpoints@2024-05-01' = if (!empty(privateEndpointSubnetId)) {
  name: 'pe-${accountName}'
  location: location
  tags: tags
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'cosmos-sql'
        properties: {
          privateLinkServiceId: account.id
          groupIds: ['Sql']
        }
      }
    ]
  }
}

resource cosmosPeDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (!empty(privateEndpointSubnetId) && !empty(cosmosPrivateDnsZoneId)) {
  parent: cosmosPe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'cosmos'
        properties: { privateDnsZoneId: cosmosPrivateDnsZoneId }
      }
    ]
  }
}

resource cosmosDiag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: account
  name: 'to-law'
  properties: {
    workspaceId: workspaceId
    logs: [
      {
        category: 'DataPlaneRequests'
        enabled: true
      }
    ]
  }
}

// ── Image pull (ACR may sit in the hub resource group) ────────────────────────
// containerApps pulls with the workload identity; aks pulls with the kubelet identity.
resource cluster 'Microsoft.ContainerService/managedClusters@2025-04-01' existing = if (onAks) {
  name: aksClusterName
}

module appAcrPull 'acr-pull.bicep' = if (!onAks) {
  name: 'lhds-cp-acrpull-app'
  scope: resourceGroup(acrResourceGroup)
  params: {
    acrName: acrName
    principalId: cpIdentity.properties.principalId
    skipRoleGrants: skipRoleGrants
  }
}

module kubeletAcrPull 'acr-pull.bicep' = if (onAks) {
  name: 'lhds-cp-acrpull-kubelet'
  scope: resourceGroup(acrResourceGroup)
  params: {
    acrName: acrName
    principalId: cluster!.properties.identityProfile.kubeletidentity.objectId
    skipRoleGrants: skipRoleGrants
  }
}

// ── containerApps path ────────────────────────────────────────────────────────
// Authorization server settings (names read by src/auth/config.ts). An empty value is never
// emitted: the service names each missing variable at startup rather than reading a blank.
var authEnvSource = [
  { name: 'LOOM_HEALTH_CP_ISSUER_URL', value: authIssuerUrl }
  { name: 'LOOM_HEALTH_CP_FHIR_BASE_URL', value: authFhirBaseUrl }
  { name: 'LOOM_HEALTH_CP_AS_CLIENT_ID', value: authAsClientId }
  { name: 'LOOM_HEALTH_CP_SIGNING_KEY_ID', value: signingKeyIdEffective }
  { name: 'LOOM_HEALTH_CP_GRAPH_CONSENT_URL', value: authGraphConsentUrl }
]
var authEnv = filter(authEnvSource, e => !empty(e.value))

var cpEnv = concat(authEnv, [
  { name: 'PORT', value: string(servicePort) }
  { name: 'LOOM_HEALTH_CP_CLOUD', value: cloudName }
  { name: 'LOOM_HEALTH_CP_TENANT_ID', value: entraTenantId }
  { name: 'LOOM_HEALTH_CP_AUDIENCE', value: join(audiences, ',') }
  { name: 'LOOM_HEALTH_CP_COSMOS_ENDPOINT', value: cosmosEndpointUrl }
  { name: 'LOOM_HEALTH_CP_COSMOS_DATABASE', value: databaseName }
  { name: 'LOOM_HEALTH_CP_ALLOWED_CALLER_APP_IDS', value: join(allowedCallerAppIds, ',') }
  { name: 'LOOM_HEALTH_CP_SLO_AVAILABILITY_TARGET', value: sloAvailabilityTarget }
  { name: 'AZURE_CLIENT_ID', value: cpIdentity.properties.clientId }
])

resource app 'Microsoft.App/containerApps@2025-02-02-preview' = if (!onAks) {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${cpIdentity.id}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      // Internal only: reached by the Console and the stamps over the environment network.
      ingress: {
        external: false
        targetPort: servicePort
        transport: 'auto'
      }
      registries: [
        {
          server: acrLoginServer
          identity: cpIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: name
          image: image
          env: cpEnv
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: servicePort
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
                port: servicePort
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 15
              failureThreshold: 6
            }
          ]
        }
      ]
      // Not scale-to-zero: the job runner holds leases and the routing publisher is periodic.
      scale: {
        minReplicas: 1
        maxReplicas: 2
      }
    }
  }
  dependsOn: [
    appAcrPull
    cosmosDataRole
    containers
  ]
}

// ── aks path ──────────────────────────────────────────────────────────────────
resource federation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2024-11-30' = if (onAks) {
  parent: cpIdentity
  name: name
  properties: {
    issuer: aksOidcIssuerUrl
    subject: 'system:serviceaccount:${aksNamespace}:${name}'
    audiences: ['api://AzureADTokenExchange']
  }
}

// The deployment script's own identity. `az aks command invoke` needs
// runCommand on the cluster (Cluster Admin Role) and, because the cluster uses
// Azure RBAC for Kubernetes authorization, a Kubernetes RBAC role to apply objects.
resource scriptIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = if (onAks) {
  name: 'uami-${name}-deploy-${location}'
  location: location
  tags: tags
}

resource scriptClusterAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (onAks && !skipRoleGrants) {
  scope: cluster
  name: guid(cluster.id, scriptIdentity.id, aksClusterAdminRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', aksClusterAdminRoleId)
    principalId: scriptIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource scriptRbacAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (onAks && !skipRoleGrants) {
  scope: cluster
  name: guid(cluster.id, scriptIdentity.id, aksRbacClusterAdminRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', aksRbacClusterAdminRoleId)
    principalId: scriptIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Restricted pod security: non-root, no privilege escalation, read-only root fs,
// all capabilities dropped, seccomp RuntimeDefault.
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
  '    azure.workload.identity/client-id: "${cpIdentity.properties.clientId}"'
  '---'
  'apiVersion: apps/v1'
  'kind: Deployment'
  'metadata:'
  '  name: ${name}'
  '  namespace: ${aksNamespace}'
  'spec:'
  '  replicas: 2'
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
  // The image declares `USER node` (a name). Kubernetes cannot verify a non-numeric
  // user against runAsNonRoot and refuses the pod, so the node user uid is pinned.
  '        runAsUser: 1000'
  '        seccompProfile:'
  '          type: RuntimeDefault'
  '      containers:'
  '        - name: ${name}'
  '          image: ${image}'
  '          ports:'
  '            - containerPort: ${servicePort}'
  '          env:'
  join(map(cpEnv, e => '            - name: ${e.name}\n              value: "${e.value}"'), '\n')
  '          resources:'
  '            requests: { cpu: 250m, memory: 512Mi }'
  '            limits: { cpu: 500m, memory: 1Gi }'
  '          securityContext:'
  '            allowPrivilegeEscalation: false'
  '            readOnlyRootFilesystem: true'
  '            capabilities: { drop: ["ALL"] }'
  '          livenessProbe:'
  '            httpGet: { path: /healthz, port: ${servicePort} }'
  '            initialDelaySeconds: 10'
  '            periodSeconds: 30'
  '          readinessProbe:'
  '            httpGet: { path: /healthz, port: ${servicePort} }'
  '            initialDelaySeconds: 5'
  '            periodSeconds: 15'
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
  '      targetPort: ${servicePort}'
], '\n')

// Fails closed: `set -e`, and `rollout status` must succeed before the script exits 0,
// so a Deployment that never becomes available fails the deployment instead of
// reporting success over an unverified outcome (deploy-integrity R6).
resource applyManifest 'Microsoft.Resources/deploymentScripts@2023-08-01' = if (onAks) {
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
    cosmosDataRole
    containers
  ]
}

@description('Hosting path actually deployed.')
output platform string = platform

@description('Internal FQDN of the control plane (containerApps path). Empty on aks: the Deployment is exposed as a ClusterIP Service only, with no route from outside the cluster until the stamp ingress (W1-6) publishes one.')
output fqdn string = onAks ? '' : app!.properties.configuration.ingress.fqdn

@description('Control-plane identity client id (workload identity / managed identity).')
output identityClientId string = cpIdentity.properties.clientId

@description('Control-plane identity principal id.')
output identityPrincipalId string = cpIdentity.properties.principalId

@description('Cosmos account name.')
output cosmosAccountName string = account.name

@description('Cosmos endpoint the service is configured with.')
output cosmosEndpoint string = cosmosEndpointUrl

@description('Cosmos network posture, so a public account is visible in the deployment output rather than silent.')
output cosmosNetworkPosture string = empty(privateEndpointSubnetId) ? 'public-network-access-enabled-aad-only' : 'private-endpoint'

@description('Federated identity credential the authorization server Entra app (authAsClientId) must carry so the control-plane identity can mint its client assertion. An Entra object, not an ARM resource: the post-deploy bootstrap creates it from these values. Never reported as configured by this module.')
output authFederatedCredential object = {
  // loginEndpoint ends with '/' and is the deploying cloud's Entra host.
  issuer: '${environment().authentication.loginEndpoint}${entraTenantId}/v2.0'
  subject: cpIdentity.properties.principalId
  audience: isGov ? 'api://AzureADTokenExchangeUSGov' : 'api://AzureADTokenExchange'
}

@description('Authorization-server environment variable names that were set on the workload (values are not echoed).')
output authEnvNamesSet array = map(authEnv, e => e.name)
