# business-events — parity with Fabric Real-Time hub "Business events"

Source UI: https://learn.microsoft.com/fabric/real-time-hub/business-events/
- Use Activator as a business events publisher: https://learn.microsoft.com/fabric/real-time-hub/business-events/business-events-activator
- Create and manage business events: https://learn.microsoft.com/fabric/real-time-hub/business-events/create-business-events

## What this is

In Microsoft Fabric, a **business event** is a named, schema-typed governed signal
defined in the Real-Time hub. **Publishers** (Activator rules, eventstreams, apps)
emit the event when a condition is met; the event is stored, made **discoverable**
in the Real-Time hub (Publishers / Consumers / Data preview tabs), and any
**consumer** can subscribe and react in real time.

## Azure-native backend (DEFAULT — no Microsoft Fabric required)

Per `.claude/rules/no-fabric-dependency.md` the default backend is 100% Azure:

| Concern | Fabric (opt-in only) | **Azure-native DEFAULT** |
|---|---|---|
| Definition / governance | Real-Time hub schema set | **Cosmos `business-events` container** (PK `/tenantId`) — name, typed schema, transport binding, publisher/consumer registry |
| Transport (durable, capacity-metered) | Eventhouse | **Azure Event Hubs** (`LOOM_EVENTHUB_NAMESPACE`, hub `LOOM_BUSINESS_EVENTS_HUB`) — CloudEvents-1.0 envelope via the HTTPS data plane |
| Consumer fan-out / routing | Real-Time hub subscribe | **Azure Event Grid custom topic** (`LOOM_BUSINESS_EVENTS_EGTOPIC`, optional) — routes on `eventType` to webhooks / Logic Apps / Functions / Service Bus |
| Discoverability | Real-Time hub Business events page | **Real-Time hub → Business events tab** (this surface) |

Fabric is strictly opt-in (`LOOM_BUSINESS_EVENTS_BACKEND=fabric`); the default path
never touches `api.fabric.microsoft.com`.

## Fabric feature inventory → Loom coverage

| # | Fabric capability | Loom coverage | Backend per control |
|---|---|---|---|
| 1 | Business events catalog (list) | ✅ Real-Time hub → Business events tab; sortable/filterable table | `GET /api/business-events` → Cosmos |
| 2 | + New business event (name, description, schema set) | ✅ Create wizard | `POST /api/business-events` |
| 3 | Define typed event schema (property name + type + required) | ✅ Structured schema builder (no raw JSON, per loom-no-freeform-config) | `validateSchema` in client |
| 4 | Schema set grouping | ✅ Schema-set field on create/edit | Cosmos `schemaSet` |
| 5 | Publishers tab (who publishes + last published + count) | ✅ Detail drawer → Publishers tab | publisher registry on the definition |
| 6 | Consumers tab (subscribe / unsubscribe) | ✅ Detail drawer → Consumers tab (add/remove) | `POST/DELETE /api/business-events/:id/consumers` |
| 7 | Data preview (verify published events) | ✅ Detail drawer → Data preview tab — publish a structured test event | `POST /api/business-events/:id/publish` → Event Hubs send |
| 8 | Publish action (Activator "Publish a business event") | ✅ Publish endpoint (callable by Activator webhook action, apps, or the Data-preview UI) | `POST /api/business-events/:id/publish` |
| 9 | Schema-validated payloads (governed) | ✅ Strict validation: required fields, type coercion, unknown-field rejection | `validatePayload` |
| 10 | Edit / delete business event | ✅ PATCH (schema/description/topic) + Delete | `PATCH/DELETE /api/business-events/:id` |
| 11 | Honest infra gate when transport missing | ⚠️ MessageBar names `LOOM_EVENTHUB_NAMESPACE`; full UI still renders | `transportConfigGate()` |

Zero ❌ — every inventory row is built ✅ or honest-gate ⚠️.

## Capacity metering

"Capacity-metered" is satisfied because all business-event transport rides the
deployment's metered **Event Hubs namespace** (the same namespace billing surface
the rest of Loom's Real-Time experiences use). The business-events hub is
provisioned with 7-day retention so late consumers can catch up.

## Bicep sync

- `platform/fiab/bicep/modules/landing-zone/eventhubs.bicep` — adds the
  `businessEventsHub` (`loom-business-events`, 4 partitions, 7-day retention) +
  `businessEventsHubName` output. The existing Event Hubs Data Owner grant on the
  Console UAMI already covers send.
- `platform/fiab/bicep/modules/admin-plane/main.bicep` — adds
  `LOOM_BUSINESS_EVENTS_HUB` and `LOOM_BUSINESS_EVENTS_EGTOPIC` to the console
  app env, sourced from params `loomBusinessEventsHub` / `loomBusinessEventsEgTopic`.
- Cosmos `business-events` container is created lazily by `cosmos-client.ts`
  (`businessEventsContainer`), no extra ARM step.

## Real-data E2E

- `POST /api/business-events` → creates a Cosmos definition (real Cosmos write).
- `POST /api/business-events/:id/publish` with a schema-conforming payload →
  validates, wraps in CloudEvents-1.0, sends to the bound Event Hub via the real
  HTTPS data plane (`eventhubs-data-client.sendEvents`), returns the minted
  `eventId` + delivery detail. Non-conforming payloads are rejected with a precise
  field error (governed). With `LOOM_EVENTHUB_NAMESPACE` unset the publish path
  returns an honest 503 naming the env var; the definition surface still works.
- Unit tests: `lib/azure/__tests__/business-events-client.test.ts` (13 tests, green).
