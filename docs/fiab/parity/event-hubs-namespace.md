# event-hubs-namespace — parity with the Azure Event Hubs namespace (hubs + consumer groups)

> **rev-94 item.** Azure-native streaming navigator. No Microsoft Fabric
> dependency (`no-fabric-dependency.md`) — Event Hubs is the 1:1 Azure parity for
> the Fabric Eventstream / RTI transport surface. **Infra ALREADY wired** — the
> Event Hubs module + console env predate rev-94; this doc records the existing
> wiring so the navigator is not duplicated.

Source UI: **Azure portal → Event Hubs namespace** (Entities → Event Hubs →
Consumer groups)
- Event Hubs: <https://learn.microsoft.com/azure/event-hubs/event-hubs-about>
- REST: <https://learn.microsoft.com/rest/api/eventhub/>

## What it is

A navigator over the deployment-pinned Event Hubs namespace
(`Microsoft.EventHub/namespaces`). Lists namespace properties + event hubs;
creates / deletes hubs and consumer groups. Real ARM REST via
`lib/azure/eventhubs-client.ts` — no mocks.

| Capability | Loom | Backend (real REST) |
| --- | --- | --- |
| Namespace properties + list hubs | ✅ | `GET .../namespaces/{ns}` + `.../eventhubs` |
| Create / delete hub (partitions, retention) | ✅ | `PUT/DELETE .../eventhubs/{name}` |
| List / create / delete consumer groups | ✅ | `.../eventhubs/{hub}/consumergroups` |

## Azure-native backend

Azure Event Hubs **Standard** namespace (Kafka surface enabled, auto-inflate,
zone-redundant). Entra-only auth by default.

## Env vars / role to provision

| Env var | Purpose |
| --- | --- |
| `LOOM_EVENTHUB_NAMESPACE` | Namespace name (required — empty ⇒ honest 503 gate) |
| `LOOM_EVENTHUB_SUB` (or `LOOM_SUBSCRIPTION_ID`) | Subscription id |
| `LOOM_EVENTHUB_RG` (or `LOOM_DLZ_RG`) | Resource group |

RBAC: the Console UAMI holds **Azure Event Hubs Data Owner** + **Contributor**
(+ **Data Receiver** for the Data Explorer receive path) on the namespace.

## Bicep module that deploys it (already wired — confirm, do not duplicate)

`platform/fiab/bicep/modules/landing-zone/eventhubs.bicep` — system-assigned MI,
`publicNetworkAccess: Disabled`, PE on `snet-private-endpoints` (groupId
`namespace`), `privatelink.servicebus.windows.net` DNS, Console UAMI RBAC,
diag → Loom LAW, plus the `loom-telemetry` hub + `loom-receiver` consumer group
+ `loom-schemas` schema group. Wired into `landing-zone/main.bicep` (section 5)
behind `loomEventHubEnabled` (default **true**, opt-out) with
`existingEventHubNamespaceName` reuse. Env emitted by `admin-plane/main.bicep`
(`LOOM_EVENTHUB_NAMESPACE/RG/SUB`) and re-pointed cross-sub by the
`EVENTHUB_NS` block (`SET_ARGS` ~line 239) in `hub-console-dlz-env.bicep`. The Service Bus +
Event Grid rev-94 modules mirror exactly this posture.
