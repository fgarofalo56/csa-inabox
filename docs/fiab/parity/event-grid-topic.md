# event-grid-topic — parity with the Azure Event Grid custom topic

> **rev-94 item.** Azure-native event-routing navigator. No Microsoft Fabric
> dependency (`no-fabric-dependency.md`) — Event Grid custom topics are the 1:1
> Azure parity for Fabric "business events" / Activator structured-signal routing.

Source UI: **Azure portal → Event Grid Topics** (custom topic: Overview /
Subscriptions / Access keys, publish CloudEvents)
- Custom topics: <https://learn.microsoft.com/azure/event-grid/custom-topics>
- CloudEvents: <https://learn.microsoft.com/azure/event-grid/cloud-event-schema>
- REST: <https://learn.microsoft.com/rest/api/eventgrid/controlplane/topics>

## What it is

A navigator over the Event Grid custom topics in the deployment-pinned resource
group (`Microsoft.EventGrid/topics`). Lists / creates / reads / deletes topics,
lists each topic's event subscriptions + access keys, and publishes governed
CloudEvents to a topic's data-plane endpoint. Real ARM REST + real data-plane
POST via `lib/azure/eventgrid-topics-client.ts` — no mocks.

| Capability | Loom | Backend (real REST, ARM api `2024-06-01-preview`) |
| --- | --- | --- |
| List custom topics in the RG | ✅ | `GET .../resourceGroups/{rg}/providers/Microsoft.EventGrid/topics` |
| Create (idempotent) / delete topic | ✅ | `PUT/DELETE .../topics/{name}` |
| Read one topic (schema/endpoint/localAuth) | ✅ | `GET .../topics/{name}` |
| List event subscriptions on a topic | ✅ | `GET .../topics/{name}/.../eventSubscriptions` |
| List access keys (SAS path only) | ✅ | `POST .../topics/{name}/listKeys` |
| Publish governed CloudEvents | ✅ | data-plane `POST {endpoint}/api/events` (Entra; aeg-sas-key only when opted in) |

## Azure-native backend

Azure Event Grid **custom topic**. Entra-only publish
(`https://eventgrid.azure.net/.default`) by default; `aeg-sas-key` only when
`LOOM_EVENTGRID_SAS_AUTH=1`.

## Env vars / role to provision

| Env var | Purpose |
| --- | --- |
| `LOOM_EVENTGRID_SUB` (or `LOOM_SUBSCRIPTION_ID`) | Subscription id (empty ⇒ honest 503 gate) |
| `LOOM_EVENTGRID_RG` (or `LOOM_DLZ_RG`) | Resource group the navigator enumerates |
| `LOOM_EVENTGRID_BUSINESS_TOPIC` | Default topic name for the Business Events surface (optional) |

The navigator is **RG-scoped** (it lists every topic in `LOOM_EVENTGRID_RG`), so
it does not need one specific topic name. RBAC: the Console UAMI is granted
**EventGrid Data Sender** (data-plane publish) + **EventGrid Contributor**
(control-plane CRUD).

## Bicep module that deploys it

`platform/fiab/bicep/modules/landing-zone/eventgrid.bicep` deploys a **dedicated,
PE-locked** custom topic (`loom-events`, `publicNetworkAccess: Disabled`, PE on
`snet-private-endpoints` groupId `topic`, `privatelink.eventgrid.azure.net` DNS,
Console UAMI RBAC, diag → Loom LAW) so a fresh deploy lights up the navigator with
a private topic. Wired into `landing-zone/main.bicep` (section 5c) behind
`deployEventGrid` (default **true**, opt-out). The always-on
`eventgrid-business.bicep` topic (`loom-business-events`) also lives in the same RG
and surfaces in the same navigator, so `deployEventGrid=false` is a safe opt-out.
`LOOM_EVENTGRID_RG/SUB` are emitted by `admin-plane/main.bicep` (default to the DLZ
RG / deployment sub). For a cross-sub **dlz-attach** topology,
`hub-console-dlz-env.bicep` re-points both `LOOM_EVENTGRID_RG` **and**
`LOOM_EVENTGRID_SUB` at the attached DLZ whenever a dedicated topic exists (passed
as `dlzEventGridTopic`): the RG re-point alone is insufficient because
`LOOM_EVENTGRID_SUB` otherwise falls back to the hub subscription. Both names are
emitted only when the resource exists — an empty topic name skips the var set, and
the navigator honest-gates (503 naming `LOOM_EVENTGRID_SUB` / `LOOM_EVENTGRID_RG`)
rather than erroring.
