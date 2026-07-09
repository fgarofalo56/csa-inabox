// CSA Loom — Admin-plane outbound-webhook Event Grid transport (Wave-6 BR-WEBHOOK)
//
// OPT-IN alternative delivery transport for the outbound webhook / event-
// subscription registry. The DEFAULT transport is direct HTTPS POST with an
// HMAC-SHA256 signature (zero infrastructure, per the default-ON principle) —
// this module is only deployed when an operator wants Loom events fanned out
// through an Azure Event Grid custom topic (durable retry + dead-lettering +
// EventGrid → downstream subscriptions).
//
// This is a STANDALONE module: it is deliberately NOT wired into
// admin-plane/main.bicep, whose parameter block is at the 256-param ceiling.
// Deploy it on its own and set the two app env vars on the console container app:
//   LOOM_EVENTGRID_TOPIC_ENDPOINT = <this module's topicEndpoint output>
//   LOOM_EVENTGRID_TOPIC_KEY      = <this module's topicKey output>  (a secret)
// The app-side emitter (lib/events/webhook-emitter.ts) honest-gates to direct
// HTTPS delivery until BOTH are present, so there is never a hard block.
//
// Grounded in Microsoft Learn — "Create custom topic (Event Grid)" +
// "Authenticate publishing clients using access keys".

targetScope = 'resourceGroup'

@description('Primary region for the Event Grid custom topic.')
param location string

@description('Custom-topic name. Defaults to a region-derived name so no new admin-plane param is required.')
param topicName string = 'egt-loom-webhooks-${location}'

@description('Compliance tags applied to the topic.')
param complianceTags object = {}

// Event Grid custom topic — accepts the EventGridSchema batch the emitter POSTs
// (deliverEventGrid) authenticated with the topic access key (aeg-sas-key).
resource topic 'Microsoft.EventGrid/topics@2025-02-15' = {
  name: topicName
  location: location
  tags: complianceTags
  properties: {
    inputSchema: 'EventGridSchema'
    publicNetworkAccess: 'Enabled'
    dataResidencyBoundary: 'WithinRegion'
  }
}

@description('Publish endpoint — set as LOOM_EVENTGRID_TOPIC_ENDPOINT on the console app.')
output topicEndpoint string = topic.properties.endpoint

@description('Topic name (for downstream event-subscription wiring).')
output topicName string = topic.name

@description('Topic resource id.')
output topicId string = topic.id

// Access key — set as LOOM_EVENTGRID_TOPIC_KEY (a secret / ACA secretRef) on the
// console app. listKeys is resolved at deploy time; treat the output as secret.
@description('Topic access key — set as the LOOM_EVENTGRID_TOPIC_KEY secret.')
output topicKey string = topic.listKeys().key1
