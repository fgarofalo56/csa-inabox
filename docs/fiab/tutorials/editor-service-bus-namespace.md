# Tutorial: Service Bus namespace editor

> CSA Loom `service-bus-namespace` editor — a navigator over a real **Azure
> Service Bus** namespace: enterprise queues (point-to-point) and topics
> (publish-subscribe) with the full portal setting surface. Real ARM REST, **no
> Microsoft Fabric required.**

## What it is

A Service Bus namespace (`Microsoft.ServiceBus/namespaces`) is Azure's enterprise
message broker — reliable **queues** for point-to-point delivery and
**topics/subscriptions** for pub-sub, with ordering, sessions, dead-lettering,
and duplicate detection. In Loom the editor is a navigator over the
**deployment-pinned namespace**: it lists properties, queues, and topics; creates
/ deletes them with the **full portal setting surface**; drills a topic into its
**subscriptions** and each subscription's **SQL / correlation filter rules**;
manages **shared access policies**; and shows a read-only **networking** view.
Real ARM REST via `lib/azure/servicebus-client.ts` — no mocks.

## When to use it

- You need guaranteed, ordered delivery between a producer and a consumer
  (a queue) with sessions or dead-lettering.
- You need pub-sub fan-out where each subscriber gets its own copy of every
  message, optionally filtered (a topic + subscription filter rules).
- You need reliable command/event messaging behind an Activator-style automation.

## Step-by-step in Loom

1. **Open the editor.** Choose **+ New item → Service Bus namespace** (Real-Time
   Intelligence). It targets `LOOM_SERVICEBUS_NAMESPACE`; if unset, an honest gate
   names the env var and the Contributor role the Console UAMI needs.
2. **Create a queue.** Name a queue and set **max size**, **TTL**, **lock
   duration**, **max delivery count**, **requires-session**, **dead-letter on
   expiration**, and **duplicate detection**; Loom PUTs `.../queues/{name}`.
3. **Create a topic.** Create a topic for pub-sub (max size, TTL, duplicate
   detection, partitioning, support-ordering).
4. **Add subscriptions + filter rules.** Drill into the topic, add a
   **subscription**, then add **SQL** or **correlation filter** rules (with an
   optional SQL action) so each subscriber receives only matching messages.
5. **Send + peek in Explorer.** The **Explorer** tab sends a test message to a
   queue or topic over the real HTTPS data plane and **peeks**
   (non-destructively — real peek-lock + unlock, no messages consumed) recent
   messages from a queue or a topic subscription. A missing **Data
   Sender/Receiver** role surfaces as an honest gate.
6. **Monitor with Metrics.** The **Metrics** tab charts live **Azure Monitor**
   platform metrics for the namespace — incoming/outgoing messages, active
   connections, dead-lettered messages.
7. **Manage access + networking.** List / create / regenerate **shared access
   policies** (suppressed honestly when local auth is disabled), and review the
   IP / VNet firewall + private-endpoint **networking** view.
8. **Connect producers + consumers.** Apps authenticate with **Entra ID** (local
   auth disabled by default) and send / receive against the queue or topic.

## The Azure backend it rides on

- **Service:** Azure **Service Bus Standard** namespace (Standard required for
  topics), Entra-only auth by default.
- **RBAC:** the Console UAMI holds **Azure Service Bus Data Owner** (data plane) +
  **Contributor** (control plane) on the namespace.
- **Bicep:** `platform/fiab/bicep/modules/landing-zone/servicebus.bicep`
  (private-endpoint-locked, diag → Loom Log Analytics), wired into the DLZ
  orchestrator behind `deployServiceBus` (default on).

## No Fabric required

The editor calls only Service Bus ARM REST. No Fabric capacity, workspace, or
OneLake is involved; when `deployServiceBus=false` the name is blank and the
editor honest-gates instead of erroring.

## Learn more

- Parity notes: `../parity/service-bus-namespace.md`
- Service Bus:
  <https://learn.microsoft.com/azure/service-bus-messaging/service-bus-messaging-overview>
