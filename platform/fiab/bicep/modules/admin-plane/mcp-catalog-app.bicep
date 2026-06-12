// CSA Loom — Catalog MCP server Container App (deploy-from-scratch)
//
// Reproduces what the Admin → External MCP Tools "Deploy" wizard does at runtime
// (POST /api/admin/mcp-servers/deploy → createMcpContainerApp), so the
// no-vaporware "1-button redeploy" acceptance test can stand up a catalog MCP
// server purely from bicep. The wizard is the primary path; this module is the
// IaC mirror for reproducible / GitOps deployments.
//
// Internal ingress only (reachable from the console + copilot on the CAE VNet,
// never public). Per-field secrets are Key Vault-backed and resolved by the MCP
// UAMI (which holds "Key Vault Secrets User" — see keyvault.bicep mcpPrincipalId).
// Azure-native (Container Apps + Key Vault) — no Microsoft Fabric dependency.

targetScope = 'resourceGroup'

@description('Container App name (DNS-label safe, <= 32 chars).')
@maxLength(32)
param name string

@description('Deployment region.')
param location string

@description('Container Apps managed-environment (CAE) resource id.')
param environmentId string

@description('uami-loom-mcp resource id — assigned to the app; resolves KV secrets + pulls the image.')
param mcpUamiId string

@description('Container image reference (e.g. ghcr.io/github/github-mcp-server:latest).')
param image string

@description('Internal ingress target port the server listens on.')
param targetPort int

@description('Health probe path (separate from the MCP endpoint, e.g. /health or /healthz).')
param healthPath string = '/health'

@description('Optional entrypoint override (argv[0]).')
param command array = []

@description('Optional container args (e.g. ["--transport","streamable-http"]).')
param args array = []

@description('Plain (non-secret) env vars: [{ name, value }].')
param envVars array = []

@description('Key Vault-backed secrets: [{ name, keyVaultUrl }]. Resolved by mcpUamiId.')
param kvSecrets array = []

@description('Secret-ref env vars: [{ name, secretRef }] mapping container env → a kvSecrets name.')
param secretEnvVars array = []

@description('Compliance tags.')
param complianceTags object = {}

// Pinned to the same Container Apps api-version the runtime deploy client uses
// (lib/azure/mcp-deploy-client.ts) and mcp-storage.bicep — bicep+bootstrap sync.
resource app 'Microsoft.App/containerApps@2025-02-02-preview' = {
  name: name
  location: location
  tags: complianceTags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${mcpUamiId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: targetPort
        transport: 'auto'
      }
      secrets: [
        for s in kvSecrets: {
          name: s.name
          keyVaultUrl: s.keyVaultUrl
          identity: mcpUamiId
        }
      ]
    }
    template: {
      containers: [
        {
          name: name
          image: image
          command: empty(command) ? null : command
          args: empty(args) ? null : args
          env: concat(envVars, secretEnvVars)
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          // Probe the dedicated health path, never the MCP JSON-RPC endpoint
          // (learn.microsoft.com/azure/container-apps/mcp-overview).
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: healthPath
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
                path: healthPath
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
      scale: {
        minReplicas: 1
        maxReplicas: 2
      }
    }
  }
}

@description('Internal FQDN of the deployed MCP server.')
output fqdn string = app.properties.configuration.ingress.fqdn

@description('Container App resource id.')
output appId string = app.id
