// CSA Loom DLZ — Azure Maps account (Microsoft.Maps/accounts, Gen2 / G2)
//
// Backs the report-designer Map visual (map-visual.tsx) + maps-client.ts + the
// GET /api/items/report/[id]/map-token route (Wave 5). The Map visual plots a REAL
// aggregate produced by the existing /query well-fold (lat/long → bubbles, or a
// Location name geocoded via the Azure Maps Search Fuzzy data plane, or a Location
// key joined to an OSS TopoJSON feature set for filled/choropleth). Azure-native,
// no Microsoft Fabric / Power BI dependency (no-fabric-dependency.md) — the map tile
// renders against atlas.microsoft.com, never api.fabric / api.powerbi. ArcGIS / Esri
// Shape-map stay OUT (3rd-party); filled maps use a locally-bundled OSS TopoJSON asset.
//
// This module is bicep-synced per no-vaporware: the Map visual either draws real
// bubbles/polygons from real rows once a token is issued, OR shows an honest
// LOOM_MAPS_BACKEND MessageBar gate (the full UI + the real aggregate rows still
// render — never a dead control). The gate is satisfied by deploying this account and
// wiring the three env vars below.
//
// HONEST POSTURE NOTES (no-vaporware — stated plainly, no hidden caveats):
//   - Azure Maps G2 has NO private endpoint / VNet injection. The data plane is the
//     GLOBAL PUBLIC endpoint https://atlas.microsoft.com — there is no privatelink
//     zone for Maps, so (unlike the sibling eventgrid/servicebus DLZ modules) this
//     module intentionally provisions NO PE and NO private DNS zone group. Access is
//     governed by Entra (AAD) auth + the account's data-plane client id, not by
//     network isolation.
//   - Azure Maps account creation is restricted to a fixed REGION ALLOW-LIST
//     (eastus / westus2 / westcentralus / westeurope / northeurope / usgovvirginia /
//     usgovarizona) — NOT every Azure region — and is INDEPENDENT of the DLZ region,
//     because the data plane is global. `mapsAccountLocation` is therefore its own
//     param (defaulting per cloud) and must NOT be wired to the DLZ `location`.
//   - Gov availability is LIMITED (Azure Government: usgovvirginia / usgovarizona
//     only, and some Maps APIs are not present in Gov). Deployments where Maps is not
//     available simply leave LOOM_MAPS_BACKEND unset and the Map visual honest-gates.
//   - Microsoft.Maps/accounts exposes ONLY platform metrics (Availability / Usage /
//     CreatorUsage) and NO resource-log categories, so the diagnostic setting is
//     metrics-only (an empty `logs` array is correct, not an omission).
//
// admin-plane/main.bicep consumes the outputs into the Console app env (wired there,
// not here — this file is the landing-zone resource only):
//   - LOOM_MAPS_BACKEND          → set to 'azure-maps' to light up the visual; unset
//                                  (default) = honest gate. resolveMapsBackend() reads it.
//   - LOOM_AZURE_MAPS_CLIENT_ID  → output `mapsClientId` (account uniqueId): the
//                                  data-plane AAD x-ms-client-id for the preferred,
//                                  gov-safe AAD token path.
//   - LOOM_AZURE_MAPS_KEY        → Commercial-only opt-in shared-key fallback; requires
//                                  disableLocalAuth=false (see param). Empty by default.
//
// Posture mirrors eventgrid.bicep / servicebus.bicep for the parts that DO apply:
// compliance tags, an honest workspace-gated diagnostic setting, and a Console-UAMI
// RBAC grant gated behind consolePrincipalId + skipRoleGrants.

targetScope = 'resourceGroup'

@description('DLZ primary region — used ONLY for resource tags / co-location metadata, NOT for the Maps account location (Maps has its own restricted region allow-list; see mapsAccountLocation).')
param location string

@description('Domain name (used for resource naming).')
param domainName string = 'default'

@description('Azure Maps account name. Deterministic + idempotent so re-deploys target the same account. Must be unique within the resource group.')
param accountName string = 'maps-loom-${domainName}'

@description('Azure Maps account REGION. Azure Maps accounts deploy only to this fixed allow-list (independent of the DLZ region, since the Maps data plane is the global public endpoint atlas.microsoft.com). Default auto-selects a Commercial vs Azure Government region; override to pin. Gov supports only usgovvirginia / usgovarizona.')
@allowed([
  'eastus'
  'westus2'
  'westcentralus'
  'westeurope'
  'northeurope'
  'usgovvirginia'
  'usgovarizona'
])
param mapsAccountLocation string = (environment().suffixes.storage == 'core.usgovcloudapi.net') ? 'usgovvirginia' : 'eastus'

@description('Disable local (shared-key + SAS) auth — Entra-only, the secure default and the only allowed posture at IL5/GCC-High. Set false ONLY in Commercial deployments that explicitly opt into the LOOM_AZURE_MAPS_KEY shared-key fallback (the AAD x-ms-client-id path remains preferred and works regardless).')
param disableLocalAuth bool = true

@description('Loom Console UAMI principal ID — granted "Azure Maps Data Reader" on the account so the Console can mint atlas.microsoft.com tokens (x-ms-client-id = account uniqueId) for the Map visual / map-token route. Empty skips the grant (the visual then honest-gates).')
param consolePrincipalId string = ''

@description('Skip role-assignment grants — set true when re-provisioning an environment that already has the grant, to avoid RoleAssignmentExists.')
param skipRoleGrants bool = false

@description('Log Analytics workspace ID for diagnostic settings. Empty (dlz-attach with no hub LAW coordinate) skips the diagnostic setting.')
param workspaceId string = ''

@description('Compliance tags applied to every resource.')
param complianceTags object

// =====================================================================
// Azure Maps account (Gen2 / G2)
//
// No managed identity is required: the AAD token path authenticates the CONSUMER
// (the Console UAMI, granted Data Reader below) and passes x-ms-client-id =
// account.uniqueId — the account itself does not need an identity to be read.
// No PE / private DNS: Maps has no private-link surface (see header NOTE).
// =====================================================================

resource account 'Microsoft.Maps/accounts@2023-06-01' = {
  name: accountName
  location: mapsAccountLocation
  tags: complianceTags
  sku: {
    name: 'G2'
  }
  kind: 'Gen2'
  properties: {
    disableLocalAuth: disableLocalAuth
  }
}

// =====================================================================
// Diagnostic settings → standardized Loom LAW (metrics-only — Maps exposes
// no resource-log categories, only platform metrics).
// =====================================================================

resource diag 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (!empty(workspaceId)) {
  scope: account
  name: 'diag-loom-stdz'
  properties: {
    workspaceId: workspaceId
    logs: []
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// =====================================================================
// RBAC — Loom Console UAMI grant
// =====================================================================

// Azure Maps Data Reader (data plane) — read Maps REST APIs (render, search/geocode,
// the data-plane calls the Map visual makes) via the account's AAD client id.
// Role GUID 423170ca-a8f6-4b0f-8487-9e4eb8f49bfa.
resource mapsDataReaderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(consolePrincipalId) && !skipRoleGrants) {
  scope: account
  name: guid(account.id, consolePrincipalId, '423170ca-a8f6-4b0f-8487-9e4eb8f49bfa')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '423170ca-a8f6-4b0f-8487-9e4eb8f49bfa')
    principalId: consolePrincipalId
    principalType: 'ServicePrincipal'
  }
}

output accountId string = account.id
output accountName string = account.name
// Data-plane AAD client id (x-ms-client-id) → LOOM_AZURE_MAPS_CLIENT_ID. The unique
// GUID Azure Maps uses to bind an AAD token to this account on atlas.microsoft.com.
output mapsClientId string = account.properties.uniqueId
