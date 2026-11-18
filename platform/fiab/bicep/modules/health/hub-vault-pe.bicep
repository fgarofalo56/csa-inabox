// CSA Loom Health Data Services (LHDS) - hub-side private endpoint for the stamp vault (#5345).
//
// WHY. The control plane (loom-health-cp) runs in the HUB Container Apps environment, not in the
// stamp. The stamp vault is private-only with one private endpoint in the stamp VNet, and the stamp's
// privatelink.vaultcore zone is linked only to the stamp VNet, so the hub VNet resolved the vault
// name through the HUB's own vaultcore zone, which had no record for it: the control plane's
// certificate issuance failed with `fetch failed` (deploy-health run 44236097017).
//
// WHAT. A second private endpoint on the stamp vault, in the hub PE subnet, whose privateDnsZoneGroup
// writes its A record into the HUB's existing privatelink.vaultcore zone (the zone the hub VNet
// already resolves through). The stamp zone is NOT linked to the hub VNet: a VNet cannot link two
// zones with the same name, and the hub already has one.
//
// APPROVAL. The deployer creates the connection against a vault in the same tenant and holds write
// rights on the vault, so the connection is auto-approved; no manual approval step.
//
// Deployed into the HUB resource group (the PE must share the hub VNet region; the stamp may be in
// another region on Gov). Re-deploying is the self-heal: the PE and its DNS group are recreated if
// deleted out of band.

targetScope = 'resourceGroup'

@description('Region of the hub VNet (the private endpoint must be created in the VNet region).')
param location string

@description('Resource id of the stamp Key Vault.')
param vaultId string

@description('Name of the stamp Key Vault; folded into the endpoint name.')
param vaultName string

@description('Resource id of the HUB private-endpoint subnet (snet-private-endpoints in the hub VNet).')
param hubPeSubnetId string

@description('Resource id of the HUB privatelink.vaultcore private DNS zone (the one the hub VNet resolves through).')
param hubVaultZoneId string

@description('Tags applied to every resource.')
param tags object = {}

resource pe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pe-hub-${vaultName}'
  location: location
  tags: tags
  properties: {
    subnet: { id: hubPeSubnetId }
    privateLinkServiceConnections: [
      {
        name: 'kv-hub-link'
        properties: {
          privateLinkServiceId: vaultId
          groupIds: ['vault']
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
        name: 'vault'
        properties: { privateDnsZoneId: hubVaultZoneId }
      }
    ]
  }
}

output privateEndpointId string = pe.id
