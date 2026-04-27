// Fabric Capacity for the retail-sales E2E example.
//
// Provisions just the capacity (an Azure resource). The Fabric workspace,
// lakehouse, shortcut, and semantic model are tenant-level Fabric resources
// not exposed in Bicep — those are provisioned by deploy/fabric/deploy.sh
// using the Fabric REST API.

@description('Environment short name.')
@allowed(['dev', 'test', 'prod'])
param env string = 'dev'

@description('Region for the Fabric capacity. Must be a Fabric-supported region.')
param location string = resourceGroup().location

@description('Capacity SKU. F2 dev, F8 test, F64 prod (Copilot in PBI requires F64+).')
param capacitySku string = env == 'prod' ? 'F64' : env == 'test' ? 'F8' : 'F2'

@description('UPN of the user/group to assign as capacity admin.')
param capacityAdminUpn string

@description('Tags applied to the capacity.')
param tags object = {
  workload: 'csa-fabric-e2e'
  environment: env
  managed_by: 'bicep'
}

var capacityName = 'csafabe${env}${take(uniqueString(resourceGroup().id), 6)}'

resource capacity 'Microsoft.Fabric/capacities@2023-11-01' = {
  name: capacityName
  location: location
  tags: tags
  sku: {
    name: capacitySku
    tier: 'Fabric'
  }
  properties: {
    administration: {
      members: [ capacityAdminUpn ]
    }
  }
}

output capacityName string = capacity.name
output capacityResourceId string = capacity.id
output capacitySku string = capacitySku
output capacityState string = capacity.properties.state
