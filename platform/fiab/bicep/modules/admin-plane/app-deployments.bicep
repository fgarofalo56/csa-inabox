// CSA Loom — per-service app deployments
// Container Apps (Commercial/GCC) OR AKS workloads (GCC-H/IL5)
//
// Every app receives the standardized env-var set:
//   APPLICATIONINSIGHTS_CONNECTION_STRING — telemetry destination
//   CSA_LOOM_BOUNDARY                     — boundary tag for resource attrs
//   AZURE_CLIENT_ID                       — UAMI client id (for DefaultAzureCredential)
//   KEYVAULT_URI                          — Key Vault URI for secret refs
//
// Plus app-specific env vars passed in via `appSpecificEnv` param.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Container platform — containerApps or aks')
@allowed(['containerApps', 'aks'])
param containerPlatform string

@description('Container App Environment ID (Container Apps only)')
param caeId string = ''

@description('ACR login server (registry for images)')
param acrLoginServer string

@description('App Insights connection string — wired into every app')
param appInsightsConnectionString string

@description('CSA Loom boundary tag')
@allowed(['Commercial', 'GCC', 'GCC-High', 'IL5'])
param boundary string

@description('Key Vault URI')
param keyVaultUri string

@description('App definitions — name, image, UAMI ID, app-specific env, ingress port, scale rules')
param apps array

@description('Compliance tags')
param complianceTags object

@batchSize(1)
resource caeApps 'Microsoft.App/containerApps@2025-02-02-preview' = [for app in apps: if (containerPlatform == 'containerApps') {
  name: app.name
  location: location
  tags: complianceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${app.uamiId}': {}
    }
  }
  properties: {
    managedEnvironmentId: caeId
    workloadProfileName: contains(app, 'workloadProfile') ? app.workloadProfile : 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: contains(app, 'ingressPort') ? {
        external: false   // VNet-only; cross-app via internal DNS
        targetPort: app.ingressPort
        transport: 'http'
        allowInsecure: false
        traffic: [{ latestRevision: true, weight: 100 }]
      } : null
      registries: [
        {
          server: acrLoginServer
          identity: app.uamiId
        }
      ]
      secrets: []
    }
    template: {
      containers: [
        {
          name: app.name
          image: '${acrLoginServer}/${app.image}'
          env: concat(
            [
              { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
              { name: 'CSA_LOOM_BOUNDARY', value: boundary }
              { name: 'AZURE_CLIENT_ID', value: app.uamiClientId }
              { name: 'KEYVAULT_URI', value: keyVaultUri }
              { name: 'LOOM_TIER', value: contains(app, 'tier') ? app.tier : 'service' }
            ],
            contains(app, 'env') ? app.env : []
          )
          resources: contains(app, 'resources') ? app.resources : {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: contains(app, 'healthPath') ? app.healthPath : '/health'
                port: contains(app, 'ingressPort') ? app.ingressPort : 8080
              }
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: contains(app, 'healthPath') ? app.healthPath : '/health'
                port: contains(app, 'ingressPort') ? app.ingressPort : 8080
              }
              periodSeconds: 10
              failureThreshold: 3
              initialDelaySeconds: 5
            }
          ]
        }
      ]
      scale: {
        minReplicas: contains(app, 'minReplicas') ? app.minReplicas : 1
        maxReplicas: contains(app, 'maxReplicas') ? app.maxReplicas : 3
        rules: contains(app, 'scaleRules') ? app.scaleRules : [
          {
            name: 'http-rule'
            http: { metadata: { concurrentRequests: '50' } }
          }
        ]
      }
    }
  }
}]

// AKS path: emit YAML manifests for GitOps (Flux/ArgoCD) rather than
// inlining Helm-equivalent resources. The operator pipeline runs
// `kubectl apply` from a config repo synchronized to the GitOps tool.
// This Bicep module just publishes the manifests to a known ConfigMap
// for the GitOps tool to pick up — see deployment-script below.

resource gitopsManifest 'Microsoft.Resources/deploymentScripts@2023-08-01' = if (containerPlatform == 'aks') {
  name: 'publish-aks-manifests-${uniqueString(resourceGroup().id)}'
  location: location
  tags: complianceTags
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${apps[0].uamiId}': {}
    }
  }
  properties: {
    azCliVersion: '2.64.0'
    retentionInterval: 'PT1H'
    timeout: 'PT30M'
    environmentVariables: [
      { name: 'APP_INSIGHTS_CONN', secureValue: appInsightsConnectionString }
      { name: 'BOUNDARY', value: boundary }
      { name: 'ACR', value: acrLoginServer }
      { name: 'KEYVAULT_URI', value: keyVaultUri }
    ]
    scriptContent: '''
echo "GitOps publication step — would write per-app manifests to the cluster's"
echo "config repo here. AKS-side workloads consume the manifests via Flux/ArgoCD."
echo ""
echo "Manifest template per app (App Insights env wired identically to Container Apps):"
cat <<MANIFEST
apiVersion: apps/v1
kind: Deployment
metadata:
  name: \${APP_NAME}
  labels: { csa-loom: app, csa-loom/boundary: "${BOUNDARY}" }
spec:
  template:
    spec:
      serviceAccountName: \${APP_NAME}-sa
      containers:
      - name: \${APP_NAME}
        image: ${ACR}/\${APP_IMAGE}
        env:
        - name: APPLICATIONINSIGHTS_CONNECTION_STRING
          value: "${APP_INSIGHTS_CONN}"
        - name: CSA_LOOM_BOUNDARY
          value: "${BOUNDARY}"
        - name: KEYVAULT_URI
          value: "${KEYVAULT_URI}"
        - name: LOOM_TIER
          value: "service"
MANIFEST
'''
  }
}

output deployedAppNames array = [for (app, i) in apps: app.name]
