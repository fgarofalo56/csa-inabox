# Tutorial: Event Grid topic editor

> CSA Loom `event-grid-topic` editor — a navigator over **Azure Event Grid**
> custom topics: reactive, push-based event routing with the **CloudEvents**
> schema. Real ARM control-plane + real data-plane publish, **no Microsoft Fabric
> required.**

## What it is

An Event Grid custom topic (`Microsoft.EventGrid/topics`) is a reactive event
router: publishers POST events to the topic endpoint and **event subscriptions**
fan them out to handlers (Functions, webhooks, Event Hubs, Service Bus) with
filtering and retry. In Loom the editor is a **resource-group-scoped navigator**:
it lists / creates / reads / deletes custom topics, lists each topic's **event
subscriptions** and **access keys**, and **publishes governed CloudEvents** to a
topic's data-plane endpoint. Real ARM REST + real data-plane POST via
`lib/azure/eventgrid-topics-client.ts` — no mocks. Event Grid custom topics are
the 1:1 parity for Fabric "business events" / Activator structured-signal routing.

## When to use it

- You want a lightweight, push-based way to broadcast discrete events (an object
  changed, a job finished) to many independent handlers.
- You need CloudEvents-schema routing with per-subscription filters and automatic
  retry.
- You are emitting "business events" from Loom that downstream Functions or
  webhooks react to.

## Step-by-step in Loom

1. **Open the editor.** Choose **+ New item → Event Grid topic** (Real-Time
   Intelligence). It targets the deployment Event Grid scope
   (`LOOM_EVENTGRID_SUB` / `LOOM_EVENTGRID_RG`); if unset, an honest gate names
   the env vars and the EventGrid Contributor role.
2. **List / create a custom topic.** The navigator lists every topic in the
   resource group. **Create** a topic — Loom PUTs `.../topics/{name}` with the
   **CloudEvents v1.0** input schema (idempotent) over real ARM.
3. **Inspect endpoint + keys.** Open a topic to see its **endpoint** and **access
   keys** (SAS path) that publishers use to POST events.
4. **Review subscriptions.** List the topic's **event subscriptions** — the
   handlers its events route to, with their filters and delivery destinations.
5. **Publish a CloudEvent.** Send a governed CloudEvent to the topic's data-plane
   endpoint (`POST {endpoint}/api/events`) to test the route. Publish uses Entra
   auth by default; `aeg-sas-key` is used only when `LOOM_EVENTGRID_SAS_AUTH=1`.

## The Azure backend it rides on

- **Service:** Azure **Event Grid custom topic**, Entra-only publish
  (`https://eventgrid.azure.net/.default`) by default.
- **RBAC:** the Console UAMI holds **EventGrid Data Sender** (publish) +
  **EventGrid Contributor** (CRUD).
- **Bicep:** `platform/fiab/bicep/modules/landing-zone/eventgrid.bicep` deploys a
  dedicated, private-endpoint-locked topic (`loom-events`), wired behind
  `deployEventGrid` (default on); the always-on `loom-business-events` topic
  shares the same RG and navigator.

## No Fabric required

The editor calls only Event Grid ARM + data-plane REST. No Fabric capacity,
workspace, or OneLake is involved; an empty topic scope makes the navigator
honest-gate (503 naming `LOOM_EVENTGRID_SUB` / `LOOM_EVENTGRID_RG`) rather than
erroring.

## Learn more

- Parity notes: `../parity/event-grid-topic.md`
- Custom topics: <https://learn.microsoft.com/azure/event-grid/custom-topics>
- CloudEvents schema:
  <https://learn.microsoft.com/azure/event-grid/cloud-event-schema>
