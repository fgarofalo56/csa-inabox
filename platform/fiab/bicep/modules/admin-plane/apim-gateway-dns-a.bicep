// CSA Loom — guarded A record for the internal APIM gateway hostname (D4b).
//
// WHY THIS IS A CHILD MODULE. An ARM resource condition cannot contain
// reference(), so apim.bicep cannot write
//   `resource a … = if (!empty(apim.properties.privateIPAddresses))`.
// It CAN pass the runtime-resolved value into a module parameter, and a child
// deployment's condition CAN read its own parameters. So the parent resolves
// `first(apim.properties.?privateIPAddresses ?? []) ?? ''` and this module
// authors the record only when a private IP actually exists.
//
// WHY THE GUARD EXISTS AT ALL (run 31100384405, ARM leaf): the live centralus
// APIM — PremiumV2, virtualNetworkType Internal, provisioningState Succeeded —
// reports privateIPAddresses = null, so the parent's former inline `[0]` index
// failed the deploy at RUNTIME with
//   InvalidTemplate: … 'The language expression property '0' can't be
//   evaluated.'  [Microsoft.Network/privateDnsZones/A 'azure-api.net/apim-…']
//
// WHY SKIP RATHER THAN PUT-EMPTY. A record set PUT with `aRecords: []` would
// SUCCEED — and erase the record's existing IPs. The live zone carries a
// hand-created A record (10.0.4.4) that the console's Try-it path depends on;
// a reconcile pass that cannot resolve the IP must leave it alone, not wipe
// it. Skipping the PUT entirely is the only non-destructive option.
targetScope = 'resourceGroup'

@description('Private DNS zone name (azure-api.net).')
param zoneName string

@description('A-record name — the APIM service name, so <name>.azure-api.net resolves to the internal gateway.')
param recordName string

@description('The gateway private IPv4 address. EMPTY => the record is NOT touched this pass (see header); any existing record survives and the next reconcile authors it once the service reports an IP.')
param ipv4Address string

@description('Record TTL in seconds.')
param ttl int = 3600

resource zone 'Microsoft.Network/privateDnsZones@2020-06-01' existing = {
  name: zoneName
}

resource gatewayA 'Microsoft.Network/privateDnsZones/A@2020-06-01' = if (!empty(ipv4Address)) {
  parent: zone
  name: recordName
  properties: {
    ttl: ttl
    aRecords: [ { ipv4Address: ipv4Address } ]
  }
}

@description('TRUE when the record was authored this pass; FALSE means the service reported no private IP and the record was deliberately left untouched (not an error — see header).')
output recordAuthored bool = !empty(ipv4Address)
