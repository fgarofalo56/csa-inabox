# Outbound webhooks & event subscriptions (BR-WEBHOOK)

CSA Loom can push a signed JSON event to any HTTPS endpoint you register, so
external systems (PagerDuty, ServiceNow, a Logic App, your own service) react to
what happens in Loom without polling. Tenant admins manage subscriptions under
**Admin → Event subscriptions** (`/admin/webhooks`).

## Event catalog

Every event type below has a real emitter wired into a live choke point — there
are no placeholder types.

| Group | Event types | Emitted from |
| --- | --- | --- |
| Item lifecycle | `item.created`, `item.updated`, `item.deleted` | the shared per-type item CRUD chokepoint (`app/api/items/_lib/item-crud.ts`) — fires for every editor |
| Workspace | `workspace.created`, `workspace.updated`, `workspace.deleted` | admin workspace routes (via the BR-SIEM audit fan-out) |
| Pipeline runs | `pipeline.run.completed`, `pipeline.run.failed` | the deployment-pipeline deploy receipt |
| Marketplace | `marketplace.listing.subscribed`, `marketplace.sla.breached` | data-product subscribe path + the SLA-check route (W18) |
| Admin plane | `permission.granted/revoked`, `mcp-server.deployed/removed`, `tenant-settings.updated`, `config.updated`, `domain.deleted`, `platform.updated`, `admin.mutation` | fanned out from the same admin-plane mutation choke points the BR-SIEM audit stream instruments |

A hook subscribing to `admin.mutation` receives every admin change; the specific
types let you narrow. Subscribe to the wildcard (**All events**) to receive
everything.

## Delivery & signing

The **default** transport is a direct HTTPS `POST` — zero infrastructure. Each
request carries:

| Header | Meaning |
| --- | --- |
| `X-Loom-Event` | the event type |
| `X-Loom-Timestamp` | unix seconds, bound into the signature |
| `X-Loom-Signature` | `sha256=<hex>` = `HMAC_SHA256(secret, "${timestamp}.${rawBody}")` |
| `X-Loom-Delivery-Id` | unique per delivery attempt |

**Verify a delivery** by recomputing the HMAC over `` `${X-Loom-Timestamp}.${rawBody}` ``
with your registered secret and constant-time comparing it to the header. Reject
timestamps outside a ~5-minute window to prevent replay. Failed deliveries
(`5xx`, `408`, `429`, or a network error) retry with exponential backoff; a
permanent `4xx` (e.g. signature rejected) does not retry. The last 100 delivery
attempts per hook are retained and shown in the **History** drawer.

Use the **Test** button to fire a real signed `webhook.test` event and see the
live delivery receipt (status, transport, attempts).

## Optional: Azure Event Grid transport

To fan events through an Azure Event Grid custom topic instead of direct
delivery (durable retry + dead-lettering + downstream Event Grid subscriptions),
deploy the standalone module and set two env vars on the console app:

```bash
az deployment group create \
  -g <console-rg> \
  -f platform/fiab/bicep/modules/admin-plane/event-grid-webhooks.bicep \
  -p location=<region>

# then, from the module outputs:
LOOM_EVENTGRID_TOPIC_ENDPOINT=<topicEndpoint>
LOOM_EVENTGRID_TOPIC_KEY=<topicKey>   # store as an ACA secret
```

The module is intentionally **not** wired into `admin-plane/main.bicep` (which is
at the 256-parameter ceiling). Until both vars are present, Loom silently uses
direct HTTPS delivery — there is never a hard block. The admin UI shows which
transport is active.

## W18 — marketplace listing analytics

The data-product **Analytics** surface (`GET /api/data-products/[id]/analytics`,
owner-only) reports real counters incremented on the existing paths:

- **Views** — consumer detail-page reads (the owner's own views are excluded).
- **Subscribes** — access-requests raised against the listing, with distinct
  subscriber count.
- **Freshness** — evaluated from the product's declared update cadence vs its
  last refresh.

`POST /api/data-products/[id]/sla-check` evaluates freshness and, when breached,
fires a `marketplace.sla.breached` event to the owner's subscribed webhooks.
