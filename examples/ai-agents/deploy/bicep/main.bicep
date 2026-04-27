// AI Agents — example deployment
//
// Provisions the minimum production-shaped infrastructure for the hosted-agent
// pattern: Azure OpenAI + Key Vault + Log Analytics + Application Insights +
// Container Apps environment + the agent app itself with workload identity
// and role assignments.
//
// Deploy:
//   az deployment group create \
//     --resource-group rg-csa-ai-agents \
//     --template-file main.bicep \
//     --parameters env=dev location=eastus2

@description('Environment short name (dev/test/prod)')
@allowed(['dev', 'test', 'prod'])
param env string = 'dev'

@description('Deployment region')
param location string = resourceGroup().location

@description('Container image (e.g. myacr.azurecr.io/csa-hosted-agent:v1)')
param containerImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Azure OpenAI model deployment SKU')
param aoaiSku string = 'S0'

@description('Azure OpenAI model + version')
param aoaiModelName string = 'gpt-4o-mini'
param aoaiModelVersion string = '2024-07-18'

@description('Tags applied to every resource')
param tags object = {
  workload: 'csa-ai-agents'
  environment: env
  managed_by: 'bicep'
  source_repo: 'csa-inabox/examples/ai-agents'
}

var prefix = 'csa-ai-${env}-${uniqueString(resourceGroup().id)}'
var aoaiName = take('aoai-${prefix}', 24)
var kvName = take('kv-${prefix}', 24)
var lawName = 'law-${prefix}'
var aiName = 'ai-${prefix}'
var acaEnvName = 'cae-${prefix}'
var acaAppName = 'aca-hosted-agent-${env}'
var uamiName = 'id-csa-agent-${env}'

// ============================================================================
// User-assigned managed identity (workload identity for the container app)
// ============================================================================

resource uami 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: uamiName
  location: location
  tags: tags
}

// ============================================================================
// Log Analytics + Application Insights
// ============================================================================

resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: lawName
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: aiName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: law.id
    DisableLocalAuth: true
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// ============================================================================
// Key Vault (for any non-MI secrets — defaults assume MI is sufficient)
// ============================================================================

resource kv 'Microsoft.KeyVault/vaults@2024-04-01-preview' = {
  name: kvName
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

// Grant the container app's MI 'Key Vault Secrets User' on the vault
var roleKeyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
resource kvRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(kv.id, uami.id, roleKeyVaultSecretsUser)
  properties: {
    principalId: uami.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKeyVaultSecretsUser)
  }
}

// ============================================================================
// Azure OpenAI
// ============================================================================

resource aoai 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: aoaiName
  location: location
  tags: tags
  kind: 'OpenAI'
  sku: { name: aoaiSku }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: aoaiName
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny' }
    disableLocalAuth: true   // force MI-only auth
  }
}

resource aoaiDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: aoai
  name: aoaiModelName
  sku: { name: 'Standard', capacity: 30 }
  properties: {
    model: { format: 'OpenAI', name: aoaiModelName, version: aoaiModelVersion }
    raiPolicyName: 'Microsoft.DefaultV2'
    versionUpgradeOption: 'OnceCurrentVersionExpired'
  }
}

// Grant the MI 'Cognitive Services OpenAI User' on the AOAI account
var roleAoaiUser = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
resource aoaiRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: aoai
  name: guid(aoai.id, uami.id, roleAoaiUser)
  properties: {
    principalId: uami.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAoaiUser)
  }
}

// ============================================================================
// Container Apps environment + hosted agent app
// ============================================================================

resource acaEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: acaEnvName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: law.properties.customerId
        sharedKey: listKeys(law.id, '2023-09-01').primarySharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: env == 'prod'
  }
}

resource acaApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: acaAppName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${uami.id}': {} }
  }
  properties: {
    managedEnvironmentId: acaEnv.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false   // Internal only — front with APIM/Front Door
        targetPort: 8000
        transport: 'auto'
        traffic: [{ latestRevision: true, weight: 100 }]
      }
      registries: []   // populate when using a private ACR
    }
    template: {
      containers: [
        {
          name: 'agent'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: [
            { name: 'AZURE_CLIENT_ID', value: uami.properties.clientId }
            { name: 'AZURE_OPENAI_ENDPOINT', value: aoai.properties.endpoint }
            { name: 'AZURE_OPENAI_DEPLOYMENT', value: aoaiDeployment.name }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
            { name: 'KEY_VAULT_URI', value: kv.properties.vaultUri }
            { name: 'AGENT_NAME', value: 'csa-hosted-agent' }
            { name: 'AGENT_VERSION', value: '1.0.0' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: 8000 }
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/ready', port: 8000 }
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: env == 'prod' ? 2 : 0
        maxReplicas: env == 'prod' ? 10 : 3
        rules: [
          {
            name: 'http-rule'
            http: { metadata: { concurrentRequests: '20' } }
          }
        ]
      }
    }
  }
}

// ============================================================================
// Outputs
// ============================================================================

output uamiClientId string = uami.properties.clientId
output uamiPrincipalId string = uami.properties.principalId
output aoaiEndpoint string = aoai.properties.endpoint
output aoaiDeploymentName string = aoaiDeployment.name
output keyVaultName string = kv.name
output keyVaultUri string = kv.properties.vaultUri
output appInsightsConnectionString string = appInsights.properties.ConnectionString
output containerAppFqdn string = acaApp.properties.configuration.ingress.fqdn
output logAnalyticsWorkspaceId string = law.id
