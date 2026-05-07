// CSA-in-a-Box Copilot Chat — Cosmos DB + RBAC IaC
//
// Provisions the Cosmos DB account that backs the Copilot analytics
// pipeline (conversations, feedback, backlog) and grants the existing
// Function App's system-assigned managed identity the role needed to
// write to it.
//
// What this Bicep does:
//
// - Creates Cosmos DB account ``cosmos-csa-inabox-copilot-fg``
//   (rename via ``cosmosAccountName`` parameter) — single-region in
//   eastus, serverless, AAD-only auth (``disableLocalAuth: true``).
// - Creates database ``copilot`` and three containers:
//     conversations  TTL 90 days, partition key ``/session_id``
//     feedback       no TTL,      partition key ``/session_id``
//     backlog        no TTL,      partition key ``/kind``
// - Creates a Cosmos SQL role assignment binding the Function App's
//   system-assigned MI to the built-in ``Cosmos DB Built-in Data
//   Contributor`` role at the account scope.
//
// What this Bicep does NOT do:
//
// - Create / modify the Function App. The function is provisioned by
//   the script in ``DEPLOYMENT.md`` Recreate-from-scratch section. We
//   only reference its principalId here.
// - Create / modify App Insights. Already provisioned in the same RG.
// - Manage the AOAI key. That migration is tracked in Archon as
//   SEC-COPILOT H-3.
//
// Apply (one-shot, after the Function App exists):
//
//   az login --tenant limitlessdata.ai
//   az account set --subscription "FedCiv ATU FFL - DLZ"
//   az deployment group create \
//     -g rg-dlz-aiml-stack-dev \
//     -f azure-functions/copilot-chat/deploy/main.bicep
//
// After apply, set these app settings on the Function App:
//
//   COSMOS_ENDPOINT=<output:cosmosEndpoint>
//   COSMOS_DATABASE=copilot
//
// Then redeploy the function code.

@description('Cosmos region. Defaults to eastus2 because eastus had AZ-redundant capacity issues during the 2026-05-06 first deploy. The Function App itself is in eastus; cross-region latency is ~5ms.')
param location string = 'eastus2'

@description('Function App that will read/write to Cosmos.')
param functionAppName string = 'func-csa-inabox-copilot-fg'

@description('Cosmos DB account name. Must be globally unique, 3-44 chars, lowercase + digits + hyphens.')
@minLength(3)
@maxLength(44)
param cosmosAccountName string = 'cosmos-csa-inabox-copilot-fg'

@description('Cosmos database name.')
param cosmosDatabaseName string = 'copilot'

@description('Conversations TTL in seconds. 90 days = 7776000.')
param conversationsTtlSeconds int = 7776000

// ── Existing Function App reference ─────────────────────────────────────

resource functionApp 'Microsoft.Web/sites@2024-04-01' existing = {
  name: functionAppName
}

// ── Cosmos DB account ───────────────────────────────────────────────────

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: cosmosAccountName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    capabilities: [
      {
        name: 'EnableServerless'
      }
    ]
    // AAD-only — drops the legacy account-key surface entirely.
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled' // tightened later via firewall + private endpoint
    minimalTlsVersion: 'Tls12'
    backupPolicy: {
      type: 'Continuous'
      continuousModeProperties: {
        tier: 'Continuous7Days'
      }
    }
  }
}

// ── Database + containers ───────────────────────────────────────────────

resource db 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: cosmosAccount
  name: cosmosDatabaseName
  properties: {
    resource: {
      id: cosmosDatabaseName
    }
  }
}

resource conversationsContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: db
  name: 'conversations'
  properties: {
    resource: {
      id: 'conversations'
      partitionKey: {
        paths: [ '/session_id' ]
        kind: 'Hash'
      }
      defaultTtl: conversationsTtlSeconds
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          { path: '/*' }
        ]
        excludedPaths: [
          { path: '/user_message/?' }
          { path: '/assistant_reply/?' }
          { path: '/grounding/*' }
          { path: '/citations/*' }
        ]
      }
    }
  }
}

resource feedbackContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: db
  name: 'feedback'
  properties: {
    resource: {
      id: 'feedback'
      partitionKey: {
        paths: [ '/session_id' ]
        kind: 'Hash'
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          { path: '/*' }
        ]
        excludedPaths: [
          { path: '/improvement/?' }
        ]
      }
    }
  }
}

resource backlogContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: db
  name: 'backlog'
  properties: {
    resource: {
      id: 'backlog'
      partitionKey: {
        paths: [ '/kind' ]
        kind: 'Hash'
      }
    }
  }
}

// ── RBAC: bind Function App MI to Cosmos data-contributor role ──────────

// Built-in role definition: Cosmos DB Built-in Data Contributor
// (read+write+upsert+delete on documents)
var cosmosDataContributorRoleId = guid('Microsoft.DocumentDB', 'sql', '00000000-0000-0000-0000-000000000002')
var cosmosDataContributorRole = '${cosmosAccount.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'

resource functionAppToCosmos 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, functionApp.id, cosmosDataContributorRoleId)
  properties: {
    roleDefinitionId: cosmosDataContributorRole
    principalId: functionApp.identity.principalId
    scope: cosmosAccount.id
  }
}

// ── Outputs ─────────────────────────────────────────────────────────────

output cosmosEndpoint string = cosmosAccount.properties.documentEndpoint
output cosmosDatabaseName string = cosmosDatabaseName
output cosmosAccountName string = cosmosAccount.name
