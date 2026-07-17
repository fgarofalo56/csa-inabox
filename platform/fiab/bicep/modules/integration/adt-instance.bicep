// CSA Loom - Azure Digital Twins instance (FGC-12, STRICTLY OPT-IN)
//
// The Digital Twin Builder item's DEFAULT and only-required backend is the
// shared Azure Data Explorer cluster (entity/relationship tables + make-graph),
// which needs NONE of this module. Per .claude/rules/no-fabric-dependency.md,
// Azure Digital Twins is an OPT-IN ALTERNATE only — this module is intentionally
// NOT wired into any default orchestrator and MUST be deployed deliberately by
// an operator who wants the DTDL / twin-instance model. Nothing in Loom gates on
// it; leaving it undeployed changes nothing on the default ADX-native path.
//
// It provisions:
//   1. Microsoft.DigitalTwins/digitalTwinsInstances   — the ADT instance
//   2. "Azure Digital Twins Data Owner" role for the Console UAMI (DTDL model
//      CRUD + twin CRUD + query over the data plane)
//   3. An Event Grid system topic on the instance so twin property-change events
//      can route to the existing Eventhouse + Activator (event-route wiring is a
//      tracked FGC-12 follow-up; the topic is the Azure-native hook point).
//
// After deploying, set LOOM_ADT_ENDPOINT to `hostName` (below) on the console
// container app to light up the opt-in ADT tab; until then the editor shows an
// honest gate naming exactly this module.
//
// Grounded in Microsoft Learn:
//   ADT instance (Bicep):
//     https://learn.microsoft.com/azure/templates/microsoft.digitaltwins/digitaltwinsinstances
//   ADT built-in roles (Data Owner):
//     https://learn.microsoft.com/azure/digital-twins/concepts-security
//   ADT event routes via Event Grid:
//     https://learn.microsoft.com/azure/digital-twins/concepts-route-events
//
// Per-cloud status:
//   Commercial : GA. hostName = *.api.<region>.digitaltwins.azure.net
//   Gov        : Azure Digital Twins is FedRAMP High authorized; verify the
//                target region is in the ADT Gov region list at deploy time
//                (IL5/IL6 availability is region-gated). The ADX-native default
//                is GA in ALL clouds, so this module is never required for Gov.

@description('Deployment location. For Gov, must be an ADT-available region.')
param location string = resourceGroup().location

@description('Digital Twins instance name (3-63 chars, alphanumeric + hyphens).')
param instanceName string

@description('Resource id of the Console user-assigned managed identity to grant Data Owner.')
param consoleUamiPrincipalId string

@description('Compliance / cost tags applied to every resource.')
param tags object = {}

// 1. The Azure Digital Twins instance ---------------------------------------
resource adt 'Microsoft.DigitalTwins/digitalTwinsInstances@2023-01-31' = {
  name: instanceName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
}

// 2. Azure Digital Twins Data Owner for the Console UAMI ---------------------
// Built-in role: bcd981a7-7f74-457b-83e1-cceb9e632ffe
var adtDataOwnerRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'bcd981a7-7f74-457b-83e1-cceb9e632ffe')

resource dataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(adt.id, consoleUamiPrincipalId, 'adt-data-owner')
  scope: adt
  properties: {
    roleDefinitionId: adtDataOwnerRoleId
    principalId: consoleUamiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// 3. Twin-change event routing --------------------------------------------
// NOTE: there is NO Event Grid SYSTEM-topic type for Digital Twins —
// 'Microsoft.DigitalTwins.DigitalTwinsInstances' is rejected by ARM
// ("Unrecognized topic type", live 2026-07-15) and is absent from
// providers/Microsoft.EventGrid/topicTypes. ADT publishes twin-change events
// through its OWN endpoints + routes (Microsoft.DigitalTwins/…/endpoints →
// eventRoutes, targeting an Event Grid CUSTOM topic / Event Hub / Service
// Bus). Wire that from the digital-twin editor when event routing is enabled.

@description('The ADT data-plane hostname — set LOOM_ADT_ENDPOINT to this to enable the opt-in ADT backend.')
output hostName string = adt.properties.hostName
@description('The ADT instance resource id.')
output instanceId string = adt.id
