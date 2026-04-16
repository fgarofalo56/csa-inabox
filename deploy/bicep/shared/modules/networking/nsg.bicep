// =============================================================================
// CSA-in-a-Box: Network Security Group Module
// Reusable NSG with typed security rules and optional flow-log diagnostics.
// =============================================================================
targetScope = 'resourceGroup'

// Parameters
@description('Azure region for deployment')
param parLocation string

@description('Name of the NSG resource')
param parNsgName string

@description('Tags for resource organisation')
param parTags object = {}

@description('Security rules to apply.  Priority must be unique within the array.')
param parSecurityRules array = []

@description('Log Analytics workspace resource ID for NSG diagnostics.  Leave empty to skip.')
param parLogAnalyticsWorkspaceId string = ''

// NSG
resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: parNsgName
  location: parLocation
  tags: parTags
  properties: {
    // CKV_AZURE_9/10/160: sourceAddressPrefix must be explicitly provided per
    // rule — no wildcard default — so that RDP (3389), SSH (22), and HTTP (80)
    // are never accidentally opened to the internet.
    securityRules: [
      for rule in parSecurityRules: {
        name: rule.name
        properties: {
          priority: rule.priority
          direction: rule.direction
          access: rule.access
          protocol: rule.protocol
          sourceAddressPrefix: rule.sourceAddressPrefix
          sourcePortRange: rule.?sourcePortRange ?? '*'
          destinationAddressPrefix: rule.?destinationAddressPrefix ?? '*'
          destinationPortRange: rule.?destinationPortRange ?? '*'
          description: rule.?description ?? ''
        }
      }
    ]
  }
}

// Diagnostic settings — NSG-level logs to Log Analytics
resource nsgDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(parLogAnalyticsWorkspaceId)) {
  name: '${parNsgName}-diagnostics'
  scope: nsg
  properties: {
    workspaceId: parLogAnalyticsWorkspaceId
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
    ]
  }
}

// Outputs
output nsgId string = nsg.id
output nsgName string = nsg.name
