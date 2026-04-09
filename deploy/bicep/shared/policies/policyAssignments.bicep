// Azure Policy Assignments for Data Platform Security
// Enforces zero-trust networking and governance standards

targetScope = 'subscription'

@description('Environment name used for naming and tagging')
param environment string

@description('Allowed Azure regions for data platform resources')
param allowedLocations array = [
  'eastus'
  'eastus2'
  'westus2'
]

@description('Enable enforcement or audit-only mode')
param enforcementMode string = 'Default' // 'Default' = enforce, 'DoNotEnforce' = audit

// ---------------------------------------------------------------------------
// Built-in Policy Definitions
// ---------------------------------------------------------------------------

// Deny public network access on storage accounts
resource denyStoragePublicAccess 'Microsoft.Authorization/policyAssignments@2022-06-01' = {
  name: 'csa-deny-storage-public-${environment}'
  properties: {
    displayName: 'CSA: Deny public access on storage accounts'
    description: 'Storage accounts must disable public network access for data platform security.'
    policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/b2982f36-99f2-4db5-8efa-04529a570b2a' // Deny public access
    enforcementMode: enforcementMode
    parameters: {}
  }
}

// Require private endpoints on storage accounts
resource requireStoragePE 'Microsoft.Authorization/policyAssignments@2022-06-01' = {
  name: 'csa-require-storage-pe-${environment}'
  properties: {
    displayName: 'CSA: Require private endpoints on storage accounts'
    description: 'Storage accounts must use private endpoints.'
    policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/6edd7eda-6dd8-40f7-810d-67160c639cd9'
    enforcementMode: enforcementMode
    parameters: {}
  }
}

// Require diagnostic settings on all resources
resource requireDiagnosticSettings 'Microsoft.Authorization/policyAssignments@2022-06-01' = {
  name: 'csa-require-diag-${environment}'
  properties: {
    displayName: 'CSA: Audit resources without diagnostic settings'
    description: 'All data platform resources must have diagnostic settings configured.'
    policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/7f89b1eb-583c-429a-8828-af049802c1d9'
    enforcementMode: enforcementMode
    parameters: {}
  }
}

// Deny Key Vault without purge protection
resource requireKVPurgeProtection 'Microsoft.Authorization/policyAssignments@2022-06-01' = {
  name: 'csa-kv-purge-protect-${environment}'
  properties: {
    displayName: 'CSA: Key Vault must have purge protection enabled'
    description: 'Key Vaults must enable purge protection for data platform security.'
    policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/0b60c0b2-2dc2-4e1c-b5c9-abbed971de53'
    enforcementMode: enforcementMode
    parameters: {}
  }
}

// Require managed identity on Data Factory
resource requireADFManagedIdentity 'Microsoft.Authorization/policyAssignments@2022-06-01' = {
  name: 'csa-adf-mi-${environment}'
  properties: {
    displayName: 'CSA: Azure Data Factory must use managed identity'
    description: 'Data Factory instances must use system-assigned managed identity.'
    policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/f78ccdb4-7bf4-4106-8647-270491d2978a'
    enforcementMode: enforcementMode
    parameters: {}
  }
}

// Restrict resource locations
resource allowedLocationPolicy 'Microsoft.Authorization/policyAssignments@2022-06-01' = {
  name: 'csa-allowed-locations-${environment}'
  properties: {
    displayName: 'CSA: Restrict resource locations'
    description: 'Data platform resources must be deployed in approved regions only.'
    policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/e56962a6-4747-49cd-b67b-bf8b01975c4c'
    enforcementMode: enforcementMode
    parameters: {
      listOfAllowedLocations: {
        value: allowedLocations
      }
    }
  }
}

// Require encryption in transit (HTTPS only)
resource requireHTTPS 'Microsoft.Authorization/policyAssignments@2022-06-01' = {
  name: 'csa-require-https-${environment}'
  properties: {
    displayName: 'CSA: Require secure transfer (HTTPS) for storage'
    description: 'Storage accounts must require HTTPS for all requests.'
    policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/404c3081-a854-4457-ae30-26a93ef643f9'
    enforcementMode: enforcementMode
    parameters: {}
  }
}

// Require TLS 1.2 minimum
resource requireTLS12 'Microsoft.Authorization/policyAssignments@2022-06-01' = {
  name: 'csa-require-tls12-${environment}'
  properties: {
    displayName: 'CSA: Require minimum TLS 1.2 for storage'
    description: 'Storage accounts must use TLS 1.2 or higher.'
    policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/fe83a0eb-a853-422d-aeb7-7a4c3bfedcba'
    enforcementMode: enforcementMode
    parameters: {
      minimumTlsVersion: {
        value: 'TLS1_2'
      }
    }
  }
}

// Require tags on resource groups
resource requireTags 'Microsoft.Authorization/policyAssignments@2022-06-01' = {
  name: 'csa-require-tags-${environment}'
  properties: {
    displayName: 'CSA: Require Environment tag on resource groups'
    description: 'All resource groups must have an Environment tag for cost tracking.'
    policyDefinitionId: '/providers/Microsoft.Authorization/policyDefinitions/96670d01-0a4d-4649-9c89-2d3abc0a5025'
    enforcementMode: enforcementMode
    parameters: {
      tagName: {
        value: 'Environment'
      }
    }
  }
}
