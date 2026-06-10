// CSA Loom DLZ — Synapse Dedicated SQL pool auto-pause
// A Consumption Logic App with a Recurrence trigger that calls the
// ARM REST /pause endpoint on a schedule. Cost: ~$0/month (pennies for
// one execution per day at Consumption pricing).
//
// Default schedule: pause every day at 04:00 UTC (~midnight ET).
// Pool resumes on demand from the Loom Dedicated editor.

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Domain name (matches synapse.bicep)')
param domainName string

@description('Synapse workspace name')
param synapseWorkspaceName string

@description('Synapse Dedicated SQL pool name')
param dedicatedPoolName string

@description('Pause schedule cron — default 04:00 UTC daily.')
param scheduleHour int = 4

@description('Pause schedule minute.')
param scheduleMinute int = 0

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grants, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags')
param complianceTags object

@description('ARM management endpoint (no trailing slash). Empty defaults to the Commercial host; set to https://management.usgovcloudapi.net for GCC-High / IL5. Sovereign-cloud aware so the auto-pause Logic App calls the correct ARM plane.')
param loomArmEndpoint string = ''

// Resolve the sovereign-cloud ARM host once. The Logic App HTTP actions + MSI
// audience all hang off this so a Gov deployment never calls the Commercial
// management plane (which would 401/403 at the boundary).
var armHost = empty(loomArmEndpoint) ? 'https://management.azure.com' : loomArmEndpoint
var armAudience = '${armHost}/'

var pauseUri = '${armHost}/subscriptions/${subscription().subscriptionId}/resourceGroups/${resourceGroup().name}/providers/Microsoft.Synapse/workspaces/${synapseWorkspaceName}/sqlPools/${dedicatedPoolName}/pause?api-version=2021-06-01'

resource autoPauseLogicApp 'Microsoft.Logic/workflows@2019-05-01' = {
  name: 'la-loom-synapse-autopause-${domainName}'
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    state: 'Enabled'
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      triggers: {
        DailyPause: {
          type: 'Recurrence'
          recurrence: {
            frequency: 'Day'
            interval: 1
            schedule: {
              hours: [ string(scheduleHour) ]
              minutes: [ scheduleMinute ]
            }
            timeZone: 'UTC'
          }
        }
      }
      actions: {
        GetPoolState: {
          type: 'Http'
          inputs: {
            method: 'GET'
            uri: '${armHost}/subscriptions/${subscription().subscriptionId}/resourceGroups/${resourceGroup().name}/providers/Microsoft.Synapse/workspaces/${synapseWorkspaceName}/sqlPools/${dedicatedPoolName}?api-version=2021-06-01'
            authentication: {
              type: 'ManagedServiceIdentity'
              audience: armAudience
            }
          }
        }
        ConditionPauseIfOnline: {
          type: 'If'
          runAfter: { GetPoolState: [ 'Succeeded' ] }
          expression: {
            and: [
              {
                equals: [
                  '@body(\'GetPoolState\')?[\'properties\']?[\'status\']'
                  'Online'
                ]
              }
            ]
          }
          actions: {
            PausePool: {
              type: 'Http'
              inputs: {
                method: 'POST'
                uri: pauseUri
                authentication: {
                  type: 'ManagedServiceIdentity'
                  audience: armAudience
                }
              }
            }
          }
        }
      }
    }
  }
}

// Grant the Logic App MI permission to pause the pool: Contributor on
// the workspace is sufficient (covers ARM /pause + /resume + read).
// We use 'SQL DB Contributor' which is narrower if available; falling
// back to 'Contributor' on the workspace resource scope.
resource synapseWorkspace 'Microsoft.Synapse/workspaces@2021-06-01' existing = {
  name: synapseWorkspaceName
}

resource contribRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!skipRoleGrants) {
  scope: synapseWorkspace
  name: guid(synapseWorkspace.id, autoPauseLogicApp.id, 'b24988ac-6180-42a0-ab88-20f7382dd24c')
  properties: {
    principalId: autoPauseLogicApp.identity.principalId
    principalType: 'ServicePrincipal'
    // Contributor — needed for sqlPools/pause + /resume + /read
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
  }
}

output logicAppName string = autoPauseLogicApp.name
output logicAppPrincipalId string = autoPauseLogicApp.identity.principalId