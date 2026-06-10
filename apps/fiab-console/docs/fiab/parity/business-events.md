# business-events — parity with Microsoft Fabric Activator "business events" / Real-Time hub structured signals

Source UI:
- Fabric Real-Time hub — Get events / publish structured signals:
  https://learn.microsoft.com/fabric/real-time-hub/get-started-real-time-hub
- Fabric Activator (Reflex) — react to events / business events:
  https://learn.microsoft.com/fabric/real-time-intelligence/data-activator/activator-introduction
- Azure-native backends (the DEFAULT, no Fabric):
  - Event Grid custom topics + CloudEvents v1.0:
    https://learn.microsoft.com/azure/event-grid/custom-topics
    https://learn.microsoft.com/azure/event-grid/post-to-custom-topic
    https://learn.microsoft.com/azure/event-grid/cloud-event-schema
  - Event Hubs data-plane send:
    https://learn.microsoft.com/rest/api/eventhub/send-event

## Why Azure-native (no Fabric dependency)

Per `.claude/rules/no-fabric-dependency.md`, Fabric "business events" /
Activator structured signals are achieved 1:1 on Azure with an **Event Grid
custom topic** (the governed publish endpoint, CloudEvents v1.0) plus an
**Event Hub** (the durable stream), routed to **Activator** (Azure Monitor
scheduled-query alerts / Logic Apps) downstream. No Fabric capacity or
workspace is required; the surface is 100% functional with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory → Loom coverage

| Capability (Fabric/Azure) | Loom coverage | Backend per control |
|---|---|---|
| Define a governed event type / schema | ✅ Register-event-type dialog (typed field builder, required flags, category, owner) | `POST /api/business-events/types` → Cosmos `business-event-types` (`business-events-store.ts`) |
| List / browse governed event types | ✅ Governed-types card grid | `GET /api/business-events/types` → Cosmos query |
| Delete a governed event type | ✅ Per-card delete | `DELETE /api/business-events/types?id=` → Cosmos delete |
| Publish a structured event (validated) | ✅ Publish dialog — form generated from the governed schema; validates before send | `POST /api/business-events/publish` → `validatePayload()` then Event Grid + Event Hubs data planes |
| CloudEvents v1.0 envelope | ✅ default schema; EventGridSchema selectable per topic | `publishBusinessEvents()` (`eventgrid-topics-client.ts`) |
| Fan-out router channel (Event Grid) | ✅ topic channel | Event Grid custom-topic data plane (`…/api/events`), Entra auth (`eventgrid.azure.net/.default`) |
| Durable stream channel (Event Hubs) | ✅ Event Hub channel | `sendEvents()` HTTPS data plane (`eventhubs-data-client.ts`) |
| Create a custom topic | ✅ New-topic dialog (name + input schema) | `POST /api/business-events/topics` → ARM `Microsoft.EventGrid/topics` PUT |
| List custom topics + event subscriptions (routes) | ✅ Channels section + `subscriptionsFor` query | `GET /api/business-events/topics` → ARM list |
| Capacity metering / throughput | ✅ live PublishSuccess/Fail (Event Grid) + IncomingMessages (Event Hubs), 24h | `GET /api/business-events/channels` → `fetchMetrics()` (Azure Monitor) |
| Discoverable in the Real-Time hub | ✅ each business topic surfaced as an `azure-event` source with subscribe pre-fill | `GET /api/rti-hub` (Event Grid topic enumeration) |
| Drives Activator rules | ✅ documented link + the Event Hub/topic feed the Activator surface reads | `/activator` (existing surface) |
| Route to Event Hub at deploy time | ✅ bicep wires a `to-eventhub` event subscription | `eventgrid-business.bicep` |
| Entra-only secure publish (IL5/GCC-High) | ✅ `disableLocalAuth: true` default; SAS opt-in only | `eventgrid-topics-client.ts` + bicep |

Zero ❌, zero stub banners. Honest infra-gates (⚠️) only when
`LOOM_EVENTGRID_SUB/RG`, `LOOM_EVENTHUB_NAMESPACE`, or `LOOM_COSMOS_ENDPOINT`
are unset — and the full UI still renders.

## Bicep sync

- `platform/fiab/bicep/modules/landing-zone/eventgrid-business.bicep` — custom
  topic + EventGrid Data Sender / Contributor grants for the Console UAMI +
  optional `to-eventhub` route + diagnostics → LAW.
- Wired into `landing-zone/main.bicep` (`module eventgridBusiness`).
- Env vars added to `admin-plane/main.bicep` apps env list:
  `LOOM_EVENTGRID_RG`, `LOOM_EVENTGRID_SUB`, `LOOM_EVENTGRID_BUSINESS_TOPIC`,
  `LOOM_EVENTHUB_BUSINESS_HUB`, `LOOM_BUSINESS_EVENTS_CONTAINER`.
- Governed event-type Cosmos container is created on first write
  (`createIfNotExists`) — no extra ARM step beyond the Cosmos account.

## Validation

- `npx tsc --noEmit` — clean for all touched files.
- `lib/azure/__tests__/business-events-store.test.ts` — unit tests the pure
  governance gate (slugging + payload validation).
- Live E2E receipt (real publish to the Event Grid topic + Event Hub) attached
  to the PR per `no-vaporware.md` once deployed.
