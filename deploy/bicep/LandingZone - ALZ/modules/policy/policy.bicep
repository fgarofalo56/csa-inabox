targetScope = 'subscription'

metadata name = 'ALZ Bicep - Policy Settings'
metadata description = 'Module used to set up Policies at the subscription level'

@sys.description('List of Built In Policy Initiative Names to Assign')
param initiatives array

@sys.description('Log Analytics Workspace Resource Name')
param parmLogAnalytics string 

@sys.description('Managed Identity')
param userAssignedIdentity object

@sys.description('Policy Resource Location.')
param location string = 'eastus'

@sys.description('Policy Assignment Non-Compliance Message.')
param nonComplianceMessage string

param parmLoggingRG string

param prefix string
param environment string

param tags object = {}

// Parameters for Policy Assignment Configuration when parameter values are required
param parLogAnalyticsDiagonsticConfig string = '{"logAnalytics": {"value": "${parmLogAnalytics}"}, "diagnosticSettingName": {"value": "${prefix}-${environment}-[replaceString]"}}'
param parLogAnalyticsOnlyConfig string = '{"logAnalytics": {"value": "${parmLogAnalytics}"}}'

param parDCRResourceId string = resourceId('Microsoft.Insights/dataCollectionRules', '${prefix}-change-tracking-dcr')
// param parUMID string = resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', '${userAssignedIdentity.outputs.userAssignedIdentityId}')
param parChangeTrackingInventoryConfing object = {
  bringYourOwnUserAssignedManagedIdentity: {value: true}
  userAssignedIdentityResourceId: {value: '${userAssignedIdentity.outputs.userAssignedIdentityId.value}'}
  dcrResourceId: {value: parDCRResourceId}
}
param parSecurityBenchmarkCFG object = json('{"networkWatcherShouldBeEnabledResourceGroupName": {"value": "${parmLoggingRG}"}}')
param parSQLSecurityCenter object = json('{"userWorkspaceResourceId": {"value": "${parmLogAnalytics}"}}') 


// Variables for Policy Assignment Configuration when parameter values are required
var varFedRampModerateConfig = json('{"resourceGroupName-b6e2945c-0b7b-40f5-9233-7a5323b5cdc6": {"value": "${parmLoggingRG}"}}')

// Function to replace [replaceString] in the diagnostic setting name for loops 
@sys.description('Function to replace [replaceString] in the diagnostic setting name for loops')
func replaceString(inputValue string, replaceValue string) string => '${replace(inputValue, '[replaceString]', '${replaceValue}')}'



//Resource policyAssignment Deployment
resource policyAssignment 'Microsoft.Authorization/policyAssignments@2024-04-01' = [for initiative in initiatives: {
  name: toLower(take('${prefix}-${initiative.displayName}-${initiative.id}',64))
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedIdentity.outputs.userAssignedIdentityId.value}': {}
    }
  }  
  properties: {
    displayName: '${prefix} ${initiative.displayName} for ${environment}'
    policyDefinitionId: '/providers/Microsoft.Authorization/policySetDefinitions/${initiative.id}'
    // policySetDefinitionId: '${resourceId('Microsoft.Authorization/policySetDefinitions/','${initiative.id}')}'
    metadata: tags
    nonComplianceMessages:[ 
      {
      message: nonComplianceMessage
    }
  ] 
  parameters: (empty(initiative.?parameters) ?? true ) ? {} 
  : (initiative.parameters.?varWinMonitorAgent ?? false) ? json('{"dcrResourceId": {"value": "${parDCRResourceId}"},"bringYourOwnUserAssignedManagedIdentity": {"value": true},"userAssignedManagedIdentityName": {"value": "${userAssignedIdentity.outputs.userAssignedIdentityName}"}}')   
  : (initiative.parameters.?varCISBenchmarkEnabled ?? false) ? json('{"maximumDaysToRotate-d8cf8476-a2ec-4916-896e-992351803c44": {"value": 365}, "resourceGroupName-b6e2945c-0b7b-40f5-9233-7a5323b5cdc6": {"value": "${parmLoggingRG}"}}')
  : (initiative.parameters.?varInventoryArcVM ?? false) ? json('{"dcrResourceId": {"value": "${parDCRResourceId}"}}')      
  : ((initiative.parameters.?varCosmosDBThroughput ?? 0) > 0) ? json('{"throughputMax": {"value": ${initiative.parameters.varCosmosDBThroughput}}}') 
  : (initiative.parameters.?varSecurityBenchmarkEnabled  ?? false) ? parSecurityBenchmarkCFG
  : (initiative.parameters.?varChangeTrackingEnabled ?? false) ? parChangeTrackingInventoryConfing
  : (initiative.parameters.?varSQLSecurityCenterEnabled ?? false) ? parSQLSecurityCenter
  : (initiative.parameters.varLogAnalyticsEnabled) && (!initiative.parameters.varDiagnosticSettingEnabled) && (!initiative.parameters.varFedRampModerateEnabled) ? json(parLogAnalyticsOnlyConfig) 
  : (initiative.parameters.varLogAnalyticsEnabled) && (initiative.parameters.varDiagnosticSettingEnabled) && (contains(initiative.displayName, '*Logs*')) && (!initiative.parameters.varFedRampModerateEnabled) ?  json(replaceString(parLogAnalyticsDiagonsticConfig, 'Logs-${initiative.displayName}-${initiative.id}'))
  : (initiative.parameters.varLogAnalyticsEnabled) && (initiative.parameters.varDiagnosticSettingEnabled) && (contains(initiative.displayName, '*Audit*')) && (!initiative.parameters.varFedRampModerateEnabled) ?  json(replaceString(parLogAnalyticsDiagonsticConfig, 'Audit-${initiative.displayName}-${initiative.id}'))  
  : (initiative.parameters.varLogAnalyticsEnabled) && (initiative.parameters.varDiagnosticSettingEnabled) && (!initiative.parameters.varFedRampModerateEnabled) ?  json(replaceString(parLogAnalyticsDiagonsticConfig, '${initiative.displayName}-${initiative.id}'))
  : (!initiative.parameters.varLogAnalyticsEnabled) && (!initiative.parameters.varDiagnosticSettingEnabled) && (initiative.parameters.varFedRampModerateEnabled) ? varFedRampModerateConfig 
  : (initiative.parameters.varLogAnalyticsEnabled) && (!initiative.parameters.varDiagnosticSettingEnabled) && (initiative.parameters.varFedRampModerateEnabled) ? union(json(parLogAnalyticsOnlyConfig), varFedRampModerateConfig) 
  : (initiative.parameters.varLogAnalyticsEnabled) && (initiative.parameters.varDiagnosticSettingEnabled) && (initiative.parameters.varFedRampModerateEnabled) ? union(json(replaceString(parLogAnalyticsDiagonsticConfig, '${initiative.displayName}-${initiative.id}')), varFedRampModerateConfig) : {} 
}
}
]

var policyAssignmentCount = length(initiatives)
output policySetAssignments array = [for i in range(0, policyAssignmentCount):{
  policyAssignmentId: policyAssignment[i].id
  policyAssignmentName: policyAssignment[i].name

}]
