// CSA Loom deploy-planner — Azure Container Instances
//
// Wired by the deploy-planner catalog (key: containerInstances → containerInstancesEnabled).
// Self-contained: a single container group running a small public image so the
// Container Instances navigator has a real group to list/start/stop. Restart
// policy OnFailure; Linux; system-assigned identity. The Loom Console UAMI is
// granted Contributor on the group for start/stop/restart.
//
// Grounded in Microsoft Learn:
//   Microsoft.ContainerInstance/containerGroups  (Bicep)
//   https://learn.microsoft.com/azure/templates/microsoft.containerinstance/containergroups

targetScope = 'resourceGroup'

@description('Primary region')
param location string

@description('Container image to run. Default is the standard Microsoft sample image.')
param image string = 'mcr.microsoft.com/azuredocs/aci-helloworld:latest'

@description('CPU cores for the container.')
param cpuCores int = 1

@description('Memory in GB for the container.')
param memoryInGB int = 1

@description('Loom Console UAMI principal ID — granted Contributor on the group so the BFF can start/stop/restart. Empty skips the grant.')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Compliance tags applied to every resource.')
param complianceTags object

var groupName = take('aci-loom-${uniqueString(resourceGroup().id)}', 63)

resource group 'Microsoft.ContainerInstance/containerGroups@2023-05-01' = {
  name: groupName
  location: location
  tags: complianceTags
  identity: { type: 'SystemAssigned' }
  properties: {
    osType: 'Linux'
    restartPolicy: 'OnFailure'
    sku: 'Standard'
    containers: [
      {
        name: 'loom-sample'
        properties: {
          image: image
          ports: [ { port: 80, protocol: 'TCP' } ]
          resources: {
            requests: {
              cpu: cpuCores
              memoryInGB: memoryInGB
            }
          }
        }
      }
    ]
    ipAddress: {
      type: 'Public'
      ports: [ { port: 80, protocol: 'TCP' } ]
    }
  }
}

// Contributor — ARM management (start/stop/restart) of the container group
// (role b24988ac-6180-42a0-ab88-20f7382dd24c).
resource aciContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: group
  name: guid(group.id, consolePrincipalId, 'b24988ac-6180-42a0-ab88-20f7382dd24c')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output groupId string = group.id
output groupName string = group.name
output publicIp string = group.properties.ipAddress.ip
