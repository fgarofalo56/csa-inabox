// CSA Loom Health Data Services (LHDS) - stamp private endpoint to the hub container registry (#5422, decision 8).
//
// WHY. The hub ACR is publicNetworkAccess=Disabled with defaultAction=Deny and its private endpoints live in
// the hub VNet. The stamp VNet has 0 peerings and (dev profile) egresses through load-balancer SNAT, so the
// stamp AKS kubelet could not pull: ImagePullBackOff on <acr>/opa ("failed to fetch anonymous token") even
// though the kubelet identity holds AcrPull. A role grant does not open a network path.
//
// WHAT. One private endpoint (groupIds 'registry') in the stamp private-endpoint subnet, with a zone group
// into the stamp-scoped privatelink.azurecr.<cloud suffix> zone that network.bicep creates and links to the
// stamp VNet. The registry endpoint and its data endpoints resolve to the private IPs from inside the stamp.
//
// APPROVAL. The deployer creates the connection against a registry in the same tenant and holds RBAC on it,
// and Microsoft Learn states the registry then accepts the connection automatically
// (container-registry-private-link, "Disable public access" / private endpoint connection approval), so there
// is no approval step. A connection that is not auto-approved (a deployer without RBAC on the registry) stays
// Pending and the pull keeps failing: deploy-health reads the connection state back after the deploy.
//
// SAME SUBSCRIPTION. acrResourceId is built from the hub's registry name and resource group in the deploying
// subscription, matching acr-pull.bicep.

targetScope = 'resourceGroup'

@description('Region of the stamp VNet (the private endpoint must be created in the VNet region).')
param location string

@description('Stamp short name; folded into the endpoint name.')
param stampName string

@description('Resource id of the hub container registry (a different resource group).')
param acrResourceId string

@description('Resource id of the stamp private-endpoint subnet.')
param peSubnetId string

@description('Resource id of the stamp privatelink.azurecr zone created by network.bicep.')
param acrZoneId string

@description('Tags applied to every resource.')
param tags object = {}

resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-lhds-${stampName}-acr'
  location: location
  tags: tags
  properties: {
    subnet: { id: peSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'acr-link'
        properties: {
          privateLinkServiceId: acrResourceId
          groupIds: ['registry']
        }
      }
    ]
  }
}

resource peDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: pe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'acr'
        properties: { privateDnsZoneId: acrZoneId }
      }
    ]
  }
}

output privateEndpointId string = pe.id
output privateEndpointName string = pe.name
