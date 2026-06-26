# service-bus-namespace — parity with the Azure Service Bus namespace (queues + topics)

> **rev-94 item.** Azure-native messaging navigator. No Microsoft Fabric
> dependency (`no-fabric-dependency.md`) — Service Bus is a first-class Azure
> service and is the 1:1 parity for the Fabric/Activator "reliable queue /
> pub-sub" surface.

Source UI: **Azure portal → Service Bus namespace** (Entities → Queues / Topics)
- Queues: <https://learn.microsoft.com/azure/service-bus-messaging/service-bus-queues-topics-subscriptions>
- REST: <https://learn.microsoft.com/rest/api/servicebus/>

## What it is

A navigator over the deployment-pinned Service Bus namespace
(`Microsoft.ServiceBus/namespaces`). Lists the namespace properties, queues, and
topics; creates / deletes queues and topics. Real ARM REST via the shared
sovereign-cloud-aware fetcher (`lib/azure/servicebus-client.ts`) — no mocks.

| Capability | Loom | Backend (real REST, api `2021-11-01`) |
| --- | --- | --- |
| Namespace properties (SKU/tier/status/endpoint/TLS/localAuth) | ✅ | `GET .../namespaces/{ns}` |
| List queues | ✅ | `GET .../namespaces/{ns}/queues` |
| Create / delete queue (maxSize, requiresSession) | ✅ | `PUT/DELETE .../queues/{name}` |
| List topics | ✅ | `GET .../namespaces/{ns}/topics` |
| Create / delete topic (maxSize) | ✅ | `PUT/DELETE .../topics/{name}` |

## Azure-native backend

Azure Service Bus **Standard** namespace (Standard is required for topics; Basic
supports queues only). Entra-only auth (SAS disabled) by default.

## Env vars / role to provision

| Env var | Purpose |
| --- | --- |
| `LOOM_SERVICEBUS_NAMESPACE` | Namespace name (required — empty ⇒ honest 503 gate) |
| `LOOM_SERVICEBUS_SUB` (or `LOOM_SUBSCRIPTION_ID`) | Subscription id |
| `LOOM_SERVICEBUS_RG` (or `LOOM_DLZ_RG`) | Resource group |

RBAC: the Console UAMI is granted **Azure Service Bus Data Owner** (data plane)
+ **Contributor** (ARM control plane) on the namespace.

## Bicep module that deploys it

`platform/fiab/bicep/modules/landing-zone/servicebus.bicep` — system-assigned MI,
`publicNetworkAccess: Disabled`, private endpoint on `snet-private-endpoints`
(groupId `namespace`, shares the `privatelink.servicebus.windows.net` zone with
Event Hubs), Console UAMI RBAC (skippable via `skipRoleGrants`), diag → Loom LAW.
Wired into the DLZ orchestrator (`landing-zone/main.bicep`, section 5b) behind
`deployServiceBus` (default **true**, opt-out). The env vars are emitted by
`admin-plane/main.bicep` (single-sub, via the `byoExisting.serviceBusNamespace`
key → `LOOM_SERVICEBUS_NAMESPACE/RG/SUB`) and re-pointed cross-sub by
`landing-zone/hub-console-dlz-env.bicep`. When `deployServiceBus=false` the name
is blank, so the editor honest-gates instead of 502-ing (`no-vaporware.md`).
