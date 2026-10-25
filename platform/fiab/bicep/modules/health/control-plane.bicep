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
// STANDALONE ENTRYPOINT. main.bicep does not invoke this module, on purpose: embedding it
// grew apps/fiab-console/deploy-templates/main.json from 4,186,680 to 4,239,225 bytes, over
// the 4,194,304-byte ARM inline-template limit that redis-retirement-2642.test.ts pins and
// that lib/setup/user-arm-deploy.ts breaks above. It is listed in check-bicep-sync.mjs
// ORPHAN_ALLOWLIST for that reason. Deploy it into the stamp resource group after the stamp:
//   az deployment group create -g rg-csa-loom-health-<stamp>-<region> \
//     -f platform/fiab/bicep/modules/health/control-plane.bicep \
//     -p boundary=<Commercial|GCC|GCC-High|IL5> platform=<containerApps|aks> \
//        image=<acr>/loom-health-cp:v0.1 acrLoginServer=<acr login server> \
//        acrName=<acr> acrResourceGroup=<rg> audiences='["api://..."]' \
//        environmentId=<CAE id>            (containerApps)
//        aksClusterName=aks-lhds-<stamp> aksOidcIssuerUrl=<stamp output>  (aks)
// The stamp manifest output (healthStamp) supplies aksClusterName, the OIDC issuer and lawId.
// Follow-up needed: a dispatch workflow so this is not an operator-run command.
//
// Scope: the stamp resource group (created by main.bicep behind `healthEnabled`).
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

@description('Cosmos database autoscale ceiling in RU/s (shared by the five containers). Autoscale scales to 10 percent of this.')
@minValue(1000)
param cosmosMaxThroughput int = 1000

@description('Spread the Cosmos account over availability zones. Off by default: not every region has zonal Cosmos capacity.')
param cosmosZoneRedundant bool = false

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
var containerNames = ['health-stamps', 'health-tenants', 'health-routing', 'health-jobs', 'health-slo']
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
resource containers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-12-01-preview' = [for c in containerNames: {
  parent: database
  name: c
  properties: {
    resource: {
      id: c
      partitionKey: {
        paths: ['/id']
        kind: 'Hash'
      }
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
var cpEnv = [
  { name: 'PORT', value: string(servicePort) }
  { name: 'LOOM_HEALTH_CP_CLOUD', value: cloudName }
  { name: 'LOOM_HEALTH_CP_TENANT_ID', value: entraTenantId }
  { name: 'LOOM_HEALTH_CP_AUDIENCE', value: join(audiences, ',') }
  { name: 'LOOM_HEALTH_CP_COSMOS_ENDPOINT', value: cosmosEndpointUrl }
  { name: 'LOOM_HEALTH_CP_COSMOS_DATABASE', value: databaseName }
  { name: 'LOOM_HEALTH_CP_ALLOWED_CALLER_APP_IDS', value: join(allowedCallerAppIds, ',') }
  { name: 'LOOM_HEALTH_CP_SLO_AVAILABILITY_TARGET', value: sloAvailabilityTarget }
  { name: 'AZURE_CLIENT_ID', value: cpIdentity.properties.clientId }
]

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
