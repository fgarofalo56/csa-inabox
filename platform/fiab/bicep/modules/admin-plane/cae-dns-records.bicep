// In-VNet DNS records for an INTERNAL Container Apps Environment.
//
// Every hosted app's public FQDN CNAMEs to
// <envLabel>.privatelink.<location>.azurecontainerapps.<suffix>; the linked
// privatelink zone answers authoritatively inside the VNet, so with no record
// the whole default domain is ENOTFOUND in-VNet (empty-zone-shadows-public-DNS
// class — live incident 2026-07-19: hosted Loom-app probes failed until the
// env-label + wildcard A records were added by hand).
//
// Child module because the record NAME derives from the CAE's runtime
// defaultDomain (BCP120 forbids that on a resource name in the parent scope;
// module params may carry runtime values).

targetScope = 'resourceGroup'

@description('The privatelink zone name (privatelink.<location>.azurecontainerapps.<suffix>).')
param zoneName string

@description('The CAE default domain (e.g. calmglacier-81a7635c.centralus.azurecontainerapps.io).')
param defaultDomain string

@description('The CAE static (internal load balancer) IP.')
param staticIp string

var envLabel = split(defaultDomain, '.')[0]

resource zone 'Microsoft.Network/privateDnsZones@2024-06-01' existing = {
  name: zoneName
}

resource envA 'Microsoft.Network/privateDnsZones/A@2024-06-01' = {
  parent: zone
  name: envLabel
  properties: {
    ttl: 300
    aRecords: [{ ipv4Address: staticIp }]
  }
}

resource wildcardA 'Microsoft.Network/privateDnsZones/A@2024-06-01' = {
  parent: zone
  name: '*.${envLabel}'
  properties: {
    ttl: 300
    aRecords: [{ ipv4Address: staticIp }]
  }
}
