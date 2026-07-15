# Event subscriptions (webhooks) admin page

> **Surface:** `/admin/webhooks`
> **BFF:** `apps/fiab-console/app/api/admin/webhooks/route.ts` + `.../[id]/route.ts`
> **Store:** Cosmos `webhook-subscriptions` (PK `/tenantId`) + `webhook-deliveries` (PK `/webhookId`, last 100/hook)

The **Event subscriptions** page (BR-WEBHOOK) registers outbound webhook
endpoints that receive Loom events — item lifecycle, workspace changes, pipeline
runs, marketplace subscribe / SLA breach, and admin changes. Delivery is
**HMAC-SHA256-signed direct HTTPS POST by default** (Azure-native, no Fabric
dependency), or **Azure Event Grid** when `LOOM_EVENTGRID_TOPIC_ENDPOINT` is set.

## What you can do

- **Register an endpoint** — URL + the event types it subscribes to; Loom mints a
  signing secret so the receiver can verify the `X-Loom-Signature` HMAC.
- **Test-fire** — send a sample event to confirm the endpoint is reachable and
  the signature verifies, before relying on it.
- **Delivery history** — per-hook, the last 100 delivery attempts with status,
  response code and timing (`webhook-deliveries`, capped).
- **Pause / delete** — disable a hook without losing its config, or remove it.

## Backend

| Control | Backend |
|---|---|
| Registrations | Cosmos `webhook-subscriptions` (PK `/tenantId`) |
| Delivery (default) | Direct HTTPS POST with an HMAC-SHA256 signature header |
| Delivery (opt-in) | Azure Event Grid topic when `LOOM_EVENTGRID_TOPIC_ENDPOINT` / `_KEY` are set |
| Delivery log | Cosmos `webhook-deliveries` (PK `/webhookId`, last 100) |

## RBAC & honest gates

Tenant-admin only. The direct-HTTPS path needs no extra Azure resource; the Event
Grid path honest-gates to direct delivery until the topic endpoint + key are
present (the emitter never silently drops events).

## Related

- Opt-in Event Grid transport module: `platform/fiab/bicep/modules/admin-plane/event-grid-webhooks.bicep`
- [Runtime configuration](env-config.md) — set `LOOM_EVENTGRID_TOPIC_ENDPOINT`.
