// Main Bicep File for setting up the landing zone

targetScope = 'subscription'

// Metadata
metadata name = 'ALZ Bicep - Subscription Policy Assignments'
metadata description = 'Module used to assign policy definitions to management groups'

// General parameters
// Specify the location for all resources.
@allowed([
  'East US'
  'East US 2'
  'West US 2'
  'West US 3'
  'Central US'
  'South Central US'
  'West Central US'
  'North Central US'
  'East US 2'
  'Central US'
  'South Central US'
  'West US'
  ])
@description('Specify the location for all resources.')
param location string

// Specify the environment of the deployment.
@allowed([
  'dev'
  'tst'
  'uat'
  'stg'
  'prod'
  ])
@description('Specify the environment of the deployment.')
param environment string = 'dev'


// Tags to add
@description('Specifies the tags that you want to apply to all resources.')
param tags object = {}

// Specify the prefix for all resources.
@description('Specify the prefix for all resources.')
param prefix string = 'alz'

// // Resource parameters
// @sys.description('Automation Account name.')
// param parAutomationAccountName string = 'alz-automation-account'


// Variables
var name = toLower('${prefix}-${environment}')
var tagsDefault = {
  Owner: 'Azure Landing Zone & Cloud Scale Analytics Scenario'
  Project: 'Azure Demo ALZ & CSA'
  environment: environment
  Toolkit: 'Bicep'
  PrimaryContact: 'frgarofa'
  CostCenter: 'FFL ATU - exp12345'
  }
var tagsJoined = union(tagsDefault, tags)

// Pre-requisite resources
// Logging
resource loggingResourceGroup 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: 'rg-${name}-logging'
  location: location
  tags: tagsJoined
  properties: {}
}


// Custom Role Definitions
module alzSubscriptionOwnerRole 'modules/customRoleDefinitions/definitions/alzSubscriptionOwnerRole.bicep' = {
  name: 'alzSubscriptionOwnerRole'
  scope: subscription()
  params: {
    parAssignableScopeSubscriptionId: subscription().id
  }
}


module alzApplicationOwnerRole 'modules/customRoleDefinitions/definitions/alzApplicationOwnerRole.bicep' = {
  name: 'alzApplicationOwnerRole'
  scope: subscription()
  params: {
    parAssignableScopeSubscriptionId: subscription().id
  }
}

module alzNetworkManagementRole 'modules/customRoleDefinitions/definitions/alzNetworkManagementRole.bicep' = {
  name: 'alzNetworkManagementRole'
  scope: subscription()
  params: {
    parAssignableScopeSubscriptionId: subscription().id
  }
}

module alzSecurityOperationsRole 'modules/customRoleDefinitions/definitions/alzSecurityOperationsRole.bicep' = {
  name: 'alzSecurityManagementRole'
  scope: subscription()
  params: {
    parAssignableScopeSubscriptionId: subscription().id
  }
}
// User Assigned Identity
module userAssignedIdentity 'modules/identity/userAssignedIdentity.bicep' = {
  name: 'userAssignedIdentity'
  scope: loggingResourceGroup
  params: {
        location: location
        prefix: prefix
        tags: tagsJoined
  }
}

// Automation Account
module resAutomationAccount 'modules/identity/automationAccount.bicep' = {
  name: 'resAutomationAccount'
  scope: loggingResourceGroup
  params: {
    location: location
    prefix: prefix
    environment: environment
    tags: tagsJoined
 }
}

// Role Assignments
module roleAssignmentUAI 'modules/customRoleDefinitions/roleAssignment/roleAssignment.bicep' = {
  name: 'roleAssignment-UserAssignedIdentity'
  params: {
    roleDefinitionId: alzSubscriptionOwnerRole.outputs.roleDefinitionId
    principalId: userAssignedIdentity.outputs.userAssignedIdentityPrincipalId
  }
}

module roleAssignmentAA 'modules/customRoleDefinitions/roleAssignment/roleAssignment.bicep' = {
  name: 'roleAssignment-AutomationAccount'
  params: {
    roleDefinitionId: alzSubscriptionOwnerRole.outputs.roleDefinitionId
    principalId: resAutomationAccount.outputs.automationAccountPrincipalId
  }
}


// Defualt Storage Account for Logging and Metrics Data 
module resStorageAccount 'modules/storage/storageAccount.bicep' = {
  name: 'resStorageAccount'
  scope: loggingResourceGroup
  params: {
    location: location
    prefix: prefix
    environment: environment
    tags: tagsJoined
    resourceGroup: loggingResourceGroup.name
    skuName: 'Standard_LRS'
    kind: 'StorageV2'
    accessTier: 'Hot'
    bypassServies: 'AzureServices'
    defaultAction: 'Allow'
    isHnsEnabled: false
    ipRules: [
       {
          value: '98.204.179.172'
          action: 'Allow'
        }
    ]
}
}

// Log Analytics Workspace
module logAnalyticsWorkspace 'modules/logging/logging.bicep' = {
  name: 'logAnalyticsWorkspace'
  scope: loggingResourceGroup
  params: {
    location: location
    automationAccountID: resAutomationAccount.outputs.automationAccountId
    storageAccountId: resStorageAccount.outputs.storageAccountId
    prefix: prefix
    environment: environment
    tags: tagsJoined
  }
}

// Diagnostic Settings
module diagSettings 'modules/logging/DiagSettings/DiagSetting.bicep' = {
  name: 'diagSettings'
  params: {
    parLogAnalyticsWorkspaceResourceId: logAnalyticsWorkspace.outputs.logAnalyticsWorkspaceId
    prefix: prefix
    environment: environment
  }
}

// Policy Assignments

module policyAssignments 'modules/policy/policy.bicep' = {
  name: 'policyAssignments'
  scope: subscription()
  params: {
    location: location
    prefix: prefix
    environment: environment
    userAssignedIdentityId: userAssignedIdentity.outputs.userAssignedIdentityId
    tags: tagsJoined
    logAnalytics: logAnalyticsWorkspace.outputs.logAnalyticsWorkspaceId
    nonComplianceMessage: 'This resource is not compliant, enable setting for Data Observability, Logging, Diagnostic Settings Azure resources'
  }
}

output policyDefinitionId array = policyAssignments.outputs.policySetDefinitions

// Remediation tasks for all policy assignments

// Get all policy assignments for the policy set
// var varpolicySetDefinitions = resource policySetDefinitions 'Microsoft.Authorization/policySetDefinitions@2023-04-01' existing = [for setid in policyAssignments: {
//   name: setid.displayName
// }]



// module policyRemediation 'modules/policyRemediation/policyRemediation.bicep' = [for assignment in policyAssignments.outputs.assignedPolicySet: {
//   name: 'policyRemediation'
//   scope: subscription()
//   params: {
//     prefix: prefix
//     environment: environment
//     parmPolicyAssignmentid: assignment.policySetId
//     parmPolicyDefinitionReferenceId: assignment.policySetPolicyDefinitionId
//   }
// }
// ]
