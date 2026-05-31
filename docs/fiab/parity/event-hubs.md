# event-hubs — parity with Azure Event Hubs (namespace + entity + Data Explorer)

> **Brutally honest audit, 2026-05-31.** Graded conservatively per
> `.claude/rules/no-vaporware.md` and `.claude/rules/ui-parity.md`. This doc
> supersedes the optimistic framing in `eventhubs-namespace.md`, which scoped
> the inventory to only the six ARM groups the navigator already lists and
> declared "zero ❌". The **real** Azure Event Hubs portal surface is far
> larger; measured against it, Loom covers a thin slice.

## Source UI

Azure portal → **Event Hubs namespace** blade
(`portal.azure.com` → `Microsoft.EventHub/namespaces/{ns}`) **plus** the
per-entity **Event Hubs Instance** blade and the **Data Explorer** tool.
Grounded in Microsoft Learn (not memory):

- What is Event Hubs / features: <https://learn.microsoft.com/azure/event-hubs/event-hubs-about>, <https://learn.microsoft.com/azure/event-hubs/event-hubs-features>
- Create namespace + event hub (portal): <https://learn.microsoft.com/azure/event-hubs/event-hubs-create>
- Scale (throughput units) + Auto-inflate: <https://learn.microsoft.com/azure/event-hubs/event-hubs-scalability>, <https://learn.microsoft.com/azure/event-hubs/enable-auto-inflate>
- Capture (portal): <https://learn.microsoft.com/azure/event-hubs/event-hubs-capture-enable-through-portal>
- Data Explorer (send/view events): <https://learn.microsoft.com/azure/event-hubs/event-hubs-data-explorer>
- SAS / shared access policies: <https://learn.microsoft.com/azure/event-hubs/authorize-access-shared-access-signature>
- Schema Registry / schema groups: <https://learn.microsoft.com/azure/event-hubs/schema-registry-overview>
- Networking (Private Link / IP firewall): <https://learn.microsoft.com/azure/event-hubs/private-link-service>, <https://learn.microsoft.com/azure/event-hubs/event-hubs-ip-filtering>
- Geo-DR (metadata): <https://learn.microsoft.com/azure/event-hubs/event-hubs-geo-dr>, <https://learn.microsoft.com/azure/event-hubs/configure-geo-disaster-recovery>
- Geo-replication (data): <https://learn.microsoft.com/azure/event-hubs/geo-replication>
- Customer-managed keys / encryption: <https://learn.microsoft.com/azure/event-hubs/configure-customer-managed-key>
- Application groups (resource governance): <https://learn.microsoft.com/azure/event-hubs/resource-governance-overview>
- Monitoring (diagnostic settings / metrics): <https://learn.microsoft.com/azure/event-hubs/monitor-event-hubs>
- ARM templates (all child resource types): <https://learn.microsoft.com/azure/templates/microsoft.eventhub/namespaces>

## Loom surface

`lib/components/eventhubs/eventhubs-tree.tsx` (`EventHubsNamespaceTree`),
mounted as the **left navigator of the Fabric Eventstream editor**
(`lib/editors/phase3-editors.tsx` → `EventstreamEditor`, `leftPanel={…}`).
There is **no standalone Event Hubs portal blade** in Loom — the navigator
exists only as a source-picker sidecar to the Eventstream topology canvas.
Picking an event-hub leaf copies its name to the clipboard for use as an
Eventstream source. Backend client: `lib/azure/eventhubs-client.ts`. BFF
routes under `app/api/eventhubs/{hubs,consumergroups,authrules,schemagroups,
network,geodr}/route.ts`.

Auth: `ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID),
DefaultAzureCredential)` → ARM scope, api-version `2024-01-01`. Namespace
pinned by `LOOM_EVENTHUB_NAMESPACE` + sub + RG env. UAMI needs **Azure Event
Hubs Data Owner** + **Contributor** on the namespace. When env is unset every
route 503s `code: 'not_configured'` and the whole tree shows one honest
infra-gate MessageBar (good gate behavior).

> **Important framing caveat:** the Loom bicep
> (`platform/fiab/bicep/modules/landing-zone/eventhubs.bicep`) provisions the
> namespace with `publicNetworkAccess: 'Disabled'` **and** `disableLocalAuth:
> true`. That means in the real deployment (a) the navigator can only reach
> ARM from inside the VNet/private-endpoint path, and (b) **SAS auth is
> disabled at the namespace** — so the "Authorization rules" list will be
> empty/irrelevant and Data Explorer-style data-plane send/receive over SAS
> won't work. The current Loom surface does not reflect either reality.

## Azure feature inventory (every capability, grounded in Learn)

### A. Namespace-level blades (left menu of the namespace)

| # | Capability (real Azure portal) | Notes |
|---|--------------------------------|-------|
| A1 | **Overview** — essentials (RG, region, status, pricing tier, namespace FQDN), throughput-unit gauge, the inline event-hubs grid, **+ Event hub** command, **+ Consumer group**, Delete-namespace, Move, charts | the landing blade |
| A2 | **Activity log** | ARM activity events for the namespace |
| A3 | **Access control (IAM)** — role assignments, check-access, roles, deny assignments | RBAC blade (Event Hubs Data Owner/Sender/Receiver etc.) |
| A4 | **Tags** | resource tags edit |
| A5 | **Diagnose and solve problems** | self-help |
| A6 | **Events** (Event Grid) | namespace → Event Grid subscriptions |
| A7 | **Settings → Shared access policies** (namespace SAS) — list, **create** policy (Manage/Send/Listen), view primary/secondary keys + **connection strings**, **regenerate** keys, delete | data via `listKeys`/`regenerateKeys` |
| A8 | **Settings → Scale** — throughput units slider, **Auto-inflate** enable + max TU; (Premium) processing units; pricing-tier migration | `event-hubs-scalability`, `enable-auto-inflate` |
| A9 | **Settings → Geo-recovery** — **Initiate pairing** (alias, secondary ns), **Break pairing**, **Failover**, view role/partner/alias | `configure-geo-disaster-recovery` |
| A10 | **Settings → Geo-replication** (Premium/Dedicated, data replication) — configure secondary regions | `geo-replication` |
| A11 | **Settings → Encryption** — Microsoft-managed vs **customer-managed key** (Key Vault key picker, up to 3 keys, identity), **infrastructure (double) encryption** | `configure-customer-managed-key` |
| A12 | **Settings → Identity** — system-assigned + user-assigned managed identity toggle | needed for CMK |
| A13 | **Settings → Networking** — Public access (All / Selected / Disabled), **IP firewall rules** (add CIDR), **VNet/service-endpoint rules**, **Private endpoint connections** (add/approve/reject), Trusted Microsoft services toggle | `private-link-service`, `event-hubs-ip-filtering` |
| A14 | **Settings → Schema Registry** — **schema groups** list + create (type Avro/Json/Protobuf, compatibility None/Backward/Forward) + delete; **register/view schemas** within a group (data plane) | `schema-registry-overview` |
| A15 | **Settings → Application groups** (resource governance) — create/edit groups keyed by SAS or Entra app id, throttling policies | `resource-governance-overview` |
| A16 | **Settings → Properties** | read-only resource JSON essentials, resource ID copy |
| A17 | **Settings → Locks** | ReadOnly / Delete management locks |
| A18 | **Monitoring → Alerts** | metric alert rules |
| A19 | **Monitoring → Metrics** | Azure Monitor metrics explorer (incoming/outgoing msgs, throttled, TU usage…) |
| A20 | **Monitoring → Diagnostic settings** | route logs/metrics to LAW / storage / event hub |
| A21 | **Monitoring → Logs** | Log Analytics KQL over namespace logs |
| A22 | **Automation → Tasks / Export template** | ARM export, automation tasks |
| A23 | **Data Explorer** (namespace level) — pick an event hub, then send/view events | `event-hubs-data-explorer` |
| A24 | **+ Create namespace** wizard (Basics: tier Basic/Standard/Premium/Dedicated, TUs, location; Advanced: minimum TLS, local-auth; Networking; Tags; Review+create) | `event-hubs-create` |
| A25 | **Delete namespace** | lifecycle |

### B. Per-event-hub (Event Hubs Instance) blades

| # | Capability (real Azure portal) | Notes |
|---|--------------------------------|-------|
| B1 | **Event hub Overview** — partition count, status, retention, message/throughput charts | |
| B2 | **Consumer groups** — list / create / delete (`$Default` undeletable) | |
| B3 | **Capture** — On/Off, time window (1–15 min), size window (10–500 MB), Avro/Parquet, emit-empty-files, storage account + container + naming format | `event-hubs-capture-enable-through-portal` |
| B4 | **Shared access policies** (per-hub SAS) — create/list/keys/connection-string/regenerate/delete | |
| B5 | **Schema Registry** (view from hub) | |
| B6 | **Data Explorer** (per-hub) — **Send events** (custom payload or pre-canned datasets, repeat/interval, properties), **View events** (PartitionID, consumer group, position oldest/newest/custom offset/seqno/timestamp, max batch size, max wait, grid, **download payload**) | `event-hubs-data-explorer` |
| B7 | **Properties / partition IDs view** | per-partition info |
| B8 | **Delete event hub** | |
| B9 | Edit retention / cleanup policy (Delete vs Compact), dynamic partition add (Premium/Dedicated) | retention via `retentionDescription` |

### C. Create-wizard surfaces

| # | Capability | Notes |
|---|------------|-------|
| C1 | **Create event hub** wizard — Basics (name, partition count, retention) → **Capture** tab → Review+create | multi-tab |
| C2 | **Create namespace** wizard (A24) | |

## Loom coverage

Legend: ✅ built (full 1:1 + real backend) · ⚠️ honest-gate (MessageBar/row,
no function) · 🟡 partial (exists but incomplete/rough) · ❌ MISSING.

### Namespace-level

| # | Capability | Status | Surface / why |
|---|------------|--------|---------------|
| A1 | Overview blade (essentials, TU gauge, charts, command bar) | ❌ MISSING | No overview surface at all. Navigator is a tree, not a blade. No essentials, no TU gauge, no charts. |
| A2 | Activity log | ❌ MISSING | — |
| A3 | Access control (IAM) | ❌ MISSING | — |
| A4 | Tags | ❌ MISSING | — |
| A5 | Diagnose & solve | ❌ MISSING | — |
| A6 | Events (Event Grid) | ❌ MISSING | — |
| A7 | Namespace Shared access policies — **list** | 🟡 partial | `Authorization rules` group lists name + rights badges via real `GET …/authorizationRules`. Read-only. |
| A7 | …**view keys / connection strings** | ❌ MISSING | `listKeys` not wired; comment says "surfaced behind a copy affordance later" — it is not. No key/connection-string copy anywhere. |
| A7 | …**create / regenerate / delete** policy | ⚠️ honest-gate | "Not yet wired" tree row names `PUT …/authorizationRules/{rule}` + `regenerateKeys/listKeys`. No function. |
| A8 | Scale — throughput units / Auto-inflate | ❌ MISSING | Not even a gate row. No TU slider, no auto-inflate toggle. (Bicep sets TUs + auto-inflate; UI never exposes it.) |
| A9 | Geo-recovery — **configs list** | 🟡 partial | `Geo-recovery` group lists alias/role/state via real `GET …/disasterRecoveryConfigs`. Read-only. |
| A9 | …pairing / break / **failover** | ⚠️ honest-gate | "Not yet wired" row names `PUT/DELETE …/disasterRecoveryConfigs/{alias}` + `failover`. No function. |
| A10 | Geo-replication (data) | ❌ MISSING | Not represented. |
| A11 | Encryption (CMK / double encryption) | ❌ MISSING | — |
| A12 | Identity (managed identity) | ❌ MISSING | — |
| A13 | Networking — **firewall summary** | 🟡 partial | `Networking` group shows default action + public access + IP/VNet **counts** via real `GET …/networkRuleSets/default`. Read-only summary only — no rule list, no add/remove, no private-endpoint list/approve. |
| A13 | …IP rules add/remove, VNet rules, **private endpoints** add/approve/reject | ⚠️ honest-gate (PE only) / ❌ (IP/VNet edit) | Private endpoints = "Not yet wired" row. IP/VNet rule **editing** is not even gated — only the count is shown. |
| A14 | Schema groups — list / create / delete | ✅ built | `Schema groups` group; ＋New dialog (type Avro/Json + compatibility) → real `PUT/DELETE …/schemagroups/{sg}`. **Protobuf type and actual schema register/view (data plane) are MISSING.** |
| A15 | Application groups (resource governance) | ❌ MISSING | — |
| A16 | Properties (resource JSON / ID copy) | ❌ MISSING | — |
| A17 | Locks | ❌ MISSING | — |
| A18 | Alerts | ❌ MISSING | — |
| A19 | Metrics | ❌ MISSING | No charts anywhere. |
| A20 | Diagnostic settings | ❌ MISSING | (configured in bicep, not surfaced in UI) |
| A21 | Logs (LAW KQL) | ❌ MISSING | — |
| A22 | Export template / automation tasks | ❌ MISSING | — |
| A23 | Data Explorer (namespace) | ❌ MISSING | No data-plane send/view surface at all. |
| A24 | Create-namespace wizard | ❌ MISSING | Namespace is env-pinned to one pre-provisioned ns; cannot create namespaces. |
| A25 | Delete namespace | ❌ MISSING | — |

### Per-event-hub

| # | Capability | Status | Surface / why |
|---|------------|--------|---------------|
| B1 | Event hub overview / charts | 🟡 partial | A hub leaf shows badges (partition count, retention days, capture, status) from the real list. No overview blade, no charts. |
| B1 | Event hubs **list** | ✅ built | `Event hubs` group, live count, real `GET …/eventhubs`. |
| C1 | **Create event hub** | 🟡 partial | ＋New dialog = name + partition SpinButton (1–32) + retention SpinButton (1–7) → real `PUT …/eventhubs/{eh}`. **No Capture tab** (Azure's create wizard has one); retention capped at 7 (no long-retention / Premium); no cleanup-policy (Delete/Compact). |
| B8 | Delete event hub | ✅ built | inline trash → real `DELETE …/eventhubs/{eh}`. |
| B2 | Consumer groups — list / create / delete | ✅ built | nested branch lazy-loaded per hub; ＋New → real `PUT`; trash (hidden for `$Default`) → real `DELETE`. `userMetadata` is accepted by the route but **not exposed in the create dialog**. |
| B3 | **Capture** configuration | ⚠️ honest-gate | "Not yet wired" row names `PUT …/eventhubs/{eh}` captureDescription. A `capture` badge shows enabled state read-only. No On/Off, no windows, no storage picker, no Avro/Parquet. |
| B4 | Per-hub Shared access policies | 🟡 partial | List supported by client (`listEventHubAuthRules`) + route (`?eventHub=`), but the **tree never renders per-hub auth rules** — only namespace-level. Create/keys = MISSING. |
| B6 | **Data Explorer — Send events** | ✅ built | Per-hub Data Explorer dialog (Data Usage button on each hub leaf) → **Send events** tab: body editor (text/JSON) + custom properties (UserProperties) + partition key + repeat-N, POSTs `op:'send'` to `/api/eventhubs/data-explorer` → real HTTPS data-plane REST `POST https://{ns}.servicebus.windows.net/{hub}/messages` with an **Entra** Bearer token (namespace has `disableLocalAuth:true`, so SAS is not used). Missing Data role → the real 401/403 is shown verbatim. |
| B6 | **Data Explorer — View events** (partition/position/grid) | ⚠️ honest-gate | Same dialog → **View events** tab: partition + max-events + latest/earliest position controls + Peek button + a results grid (seq#/offset/enqueued-time/expandable body) all render. Peek calls `op:'peek'`; Event Hubs has **no HTTPS REST receive** (receive is AMQP-only via `@azure/event-hubs`, which is not bundled), so it returns a precise warning MessageBar naming the dependency to add (`@azure/event-hubs`) + env var (`LOOM_EVENTHUB_RECEIVE_ENABLED`). Never fabricates events. |
| B7 | Partition IDs view | ❌ MISSING | `partitionIds` is fetched in the client shape but never displayed. |
| B9 | Edit retention / cleanup policy / dynamic partitions | ❌ MISSING | Retention is set only at create; no edit. |

## Backend per control

| Control | BFF route | ARM REST | Real backend? |
|---------|-----------|----------|---------------|
| List / create / delete event hub | `/api/eventhubs/hubs` | `GET/PUT/DELETE …/namespaces/{ns}/eventhubs[/{eh}]?api-version=2024-01-01` | ✅ real ARM |
| List / create / delete consumer group | `/api/eventhubs/consumergroups` | `GET/PUT/DELETE …/eventhubs/{eh}/consumergroups[/{cg}]` | ✅ real ARM |
| List / create / delete schema group | `/api/eventhubs/schemagroups` | `GET/PUT/DELETE …/schemagroups[/{sg}]` | ✅ real ARM |
| List authorization rules (ns + per-hub) | `/api/eventhubs/authrules` | `GET …/authorizationRules` (+ `?eventHub=`) | ✅ real ARM (read-only; per-hub list unused by UI) |
| Network rule set summary | `/api/eventhubs/network` | `GET …/networkRuleSets/default` (404→Allow-all) | ✅ real ARM (read-only) |
| Geo-DR configs | `/api/eventhubs/geodr` | `GET …/disasterRecoveryConfigs` | ✅ real ARM (read-only) |
| SAS keys / connection strings | — | `POST …/authorizationRules/{rule}/listKeys` / `regenerateKeys` | ❌ not wired |
| Scale / Auto-inflate | — | `PATCH …/namespaces/{ns}` (sku.capacity, isAutoInflateEnabled) | ❌ not wired |
| Capture config | — | `PUT …/eventhubs/{eh}` captureDescription | ❌ not wired |
| Geo-DR pairing / failover | — | `PUT/DELETE …/disasterRecoveryConfigs/{alias}` + `…/failover` | ❌ not wired |
| Networking IP/VNet/PE edit | — | `PUT …/networkRuleSets/default`, `Microsoft.Network/privateEndpoints` | ❌ not wired |
| Encryption / Identity | — | `PATCH …/namespaces/{ns}` (encryption, identity) | ❌ not wired |
| Data Explorer **send** | `/api/eventhubs/data-explorer` (op=send) | `POST https://{ns}.servicebus.windows.net/{hub}/messages` (Entra Bearer, single=atom-entry / batch=servicebus-json, PartitionKey via BrokerProperties header) | ✅ real data-plane REST |
| Data Explorer **view/peek** | `/api/eventhubs/data-explorer` (op=peek) | AMQP receive (`@azure/event-hubs`) — not bundled | ⚠️ honest dependency-gate (501 `receive_unavailable`; full View UI renders) |
| IAM / Tags / Locks / Metrics / Alerts / Diagnostics | — | ARM `roleAssignments`, `tags`, `locks`, Azure Monitor | ❌ not wired |

Every route is session-guarded (`getSession()` → 401), 503s via
`eventhubsConfigGate()` with the exact missing env var, returns `{ ok, … }`
JSON, and issues real ARM calls only (no mocks). That part is clean — the
problem is **coverage**, not honesty of what's there.

## Verdict (conservative)

**Grade: C− / D+.** What exists is honest and real-backed (ARM CRUD for event
hubs / consumer groups / schema groups; read-only lists for SAS rules,
networking, Geo-DR). But measured against the **real** Azure Event Hubs UI,
Loom implements roughly **one-third of one of the three major surfaces** (the
namespace entity tree) and **zero of the other two** (the namespace
management/monitoring blades and the entire **Data Explorer** data-plane
send/view tool). No Overview, no Scale, no IAM, no Metrics, no Capture
authoring, no SAS key/connection-string copy, no Data Explorer. The prior
`eventhubs-namespace.md` "zero ❌" claim is **inaccurate** because it scoped
the inventory to only the rows the navigator already had.

This is a competent **Eventstream source-picker sidecar**, not a
one-for-one Event Hubs portal. Per `ui-parity.md` it is **not A-grade** —
many ❌ rows and the absence of whole blades.

## Highest-value gaps to build first

1. **Data Explorer (Send + View events)** — the single biggest missing
   surface; it's the Event Hubs feature operators actually use day-to-day.
   (Note: requires re-enabling local-auth **or** Entra data-plane send/receive
   since bicep currently sets `disableLocalAuth:true`.)
2. **SAS shared-access-policy keys + connection strings** — `listKeys` /
   `regenerateKeys` + a copy affordance; today there is no way to get a
   connection string out of Loom. (Also gated by `disableLocalAuth:true`.)
3. **Capture configuration** authoring on an event hub (On/Off, windows,
   storage, Avro/Parquet) — currently a gate row.
4. **Scale / Auto-inflate** namespace settings (TU slider, auto-inflate max).
5. **Namespace Overview** blade (essentials + metrics charts + command bar) so
   the surface reads as an Event Hubs portal, not just a tree.
6. **Networking** full editor (IP-rule list/add/remove, VNet rules, private
   endpoint list/approve) — today only counts are shown.
7. **Geo-DR pairing / failover** actions — currently a gate row.
8. **IAM / Tags / Locks / Diagnostic settings / Metrics** management blades.
9. Per-hub **authorization rules** rendering + per-hub **partition view**;
   consumer-group **userMetadata** field in the create dialog.

## Bicep sync note

`platform/fiab/bicep/modules/landing-zone/eventhubs.bicep` provisions the
namespace (Standard, auto-inflate, zone-redundant, **private-endpoint only**,
**`disableLocalAuth:true`**, CMK-capable) + Console UAMI grants (Data Owner +
Contributor) + diagnostic settings. Two consequences the UI ignores: (a)
SAS/local-auth is disabled, so the SAS-policy and any data-plane send/receive
features are not just unbuilt but would **fail at runtime** as designed; (b)
public access is disabled, so the navigator only works from inside the private
network. Either the UI should reflect these (e.g. an Entra-only data-plane
path + a "local auth disabled" notice on the SAS rows) or the bicep posture
needs a documented dev exception.
