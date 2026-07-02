# Tutorial: Event Hubs namespace editor

> CSA Loom `event-hubs-namespace` editor — a navigator over a real **Azure Event
> Hubs** namespace: the Kafka-compatible streaming backbone behind Eventstreams.
> Real ARM REST, **no Microsoft Fabric required.**

## What it is

An Event Hubs namespace (`Microsoft.EventHub/namespaces`) is the standalone Azure
resource that big-data streaming rides on. In Loom the editor is a navigator over
the **deployment-pinned namespace**: it shows namespace properties (SKU, TLS,
capture) and lets you **create, list, and delete event hubs** and **consumer
groups** against the real ARM REST via `lib/azure/eventhubs-client.ts` — no
mocks. Event Hubs is the 1:1 Azure parity for the Fabric Eventstream / RTI
transport surface.

## When to use it

- You need a durable, high-throughput ingestion point for telemetry, logs, or
  Kafka producers.
- You are wiring an **Eventstream**, **Stream Analytics** job, or **KQL / ADX**
  ingestion and need the source hub + consumer groups it reads from.
- You want independent readers that each track their own offset (one consumer
  group per reader).

## Step-by-step in Loom

1. **Open the editor.** Choose **+ New item → Event Hubs namespace** (Real-Time
   Intelligence). It targets the deployment namespace `LOOM_EVENTHUB_NAMESPACE`;
   if that is unset the editor shows an honest gate naming the env var and the
   Contributor role the Console UAMI needs.
2. **Review namespace properties.** Confirm SKU/tier, TLS, and status pulled from
   `GET .../namespaces/{ns}`.
3. **Create an event hub.** Name a hub and pick a **partition count** + **message
   retention**; Loom PUTs `.../namespaces/{ns}/eventhubs/{name}` over real ARM.
4. **Add consumer groups.** Under a hub, create one or more **consumer groups** so
   each downstream reader tracks its own position.
5. **Send + peek in Data Explorer.** The **Data Explorer** tab sends test events
   to a hub over the real HTTPS data plane (Entra auth) and peeks recent events,
   so you can verify the stream end-to-end without leaving Loom. A missing
   data-plane role surfaces as an honest gate naming the exact grant.
6. **Monitor with Metrics.** The **Metrics** tab charts live **Azure Monitor**
   platform metrics for the namespace — incoming/outgoing messages, requests,
   throttling — the same `Microsoft.Insights/metrics` REST the Monitor hub uses.
7. **Wire it downstream.** Point an **Eventstream**, **Stream Analytics** job, or
   **KQL ingestion** at the hub — the namespace is the source.

## The Azure backend it rides on

- **Service:** Azure **Event Hubs Standard** namespace (Kafka surface enabled,
  auto-inflate, zone-redundant), Entra-only auth by default.
- **RBAC:** the Console UAMI holds **Azure Event Hubs Data Owner** +
  **Contributor** (and **Data Receiver** for the receive path) on the namespace.
- **Bicep:** `platform/fiab/bicep/modules/landing-zone/eventhubs.bicep`
  (private-endpoint-locked, diag → Loom Log Analytics), wired into the DLZ
  orchestrator behind `loomEventHubEnabled` (default on).

## No Fabric required

Event Hubs is a first-class Azure service; the editor calls only ARM. No Fabric
capacity, workspace, or OneLake is involved. When the namespace name is blank the
editor honest-gates instead of erroring.

## Learn more

- Parity notes: `../parity/event-hubs-namespace.md`
- Event Hubs: <https://learn.microsoft.com/azure/event-hubs/event-hubs-about>
