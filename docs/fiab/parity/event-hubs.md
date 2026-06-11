# event-hubs — parity with Azure Event Hubs (namespace + entity + Data Explorer)

> **rev.3 — re-audited against Wave-8→11 code (2026-06-10), audit-T31.** A full
> **`EventHubsNamespaceEditor` blade** (`lib/components/eventhubs/eventhubs-namespace-editor.tsx`)
> shipped in **PR #1075** (audit-T21) and is mounted from the navigator
> (`eventhubs-tree.tsx:914`, opened by per-hub + per-rule buttons). It adds four
> portal-parity tabs, each wired to a real ARM route:
> - **Capture** (per hub) → `PUT /api/eventhubs/capture` → real
>   `PUT …/eventhubs/{eh}` `captureDescription` (On/Off, Avro, ADLS/Blob
>   destination + container + naming). **Flips B3 ⚠️→✅.**
> - **Geo-recovery** → `POST /api/eventhubs/geodr-actions` → real
>   `PUT/DELETE …/disasterRecoveryConfigs/{alias}` + `…/failover` (create
>   pairing / break / failover, with confirm dialogs). **Flips A9 actions ⚠️→✅.**
> - **SAS keys** (namespace + per-hub) → `POST …/authrules/{rule}/keys` (reveal,
>   `listKeys`) + `…/keys/regenerate` (rotate primary/secondary,
>   `regenerateKeys`). **Flips A7 view/regenerate ❌/⚠️→✅** — *connection
>   strings remain an honest ⚠️ gate*: the namespace is provisioned
>   `disableLocalAuth:true`, so the client returns `primaryConnectionString:
>   undefined` and the panel shows a "local auth disabled" notice rather than a
>   copyable string (correct, secure-by-default posture across all four clouds).
> - **Private endpoints** → `POST /api/eventhubs/private-endpoints`
>   (approve/reject pending connections). **Flips A13 PE ⚠️→✅.**
>
> Still genuinely missing (kept ❌ honestly): namespace **Overview** blade +
> metrics charts, **Scale/Auto-inflate**, **Encryption/Identity (CMK)**,
> **IP/VNet rule editing**, **IAM/Tags/Locks/Diagnostics**, namespace
> create/delete, **Data Explorer View/receive** (still the honest AMQP
> dependency-gate). **Grade C → B−.** Rows + backend table + verdict updated below.

> **rev.2 — corrected against current code (2026-05-31).** The B6 Data Explorer
> rows below already reflect PR #548: **Send events** is real (data-plane
> `POST https://{ns}.servicebus.windows.net/{hub}/messages` with an Entra Bearer
> token via `lib/azure/eventhubs-data-client.ts` → `/api/eventhubs/data-explorer`
> op=send; honors `disableLocalAuth:true`), verified no-mock. **View/receive**
> stays an honest dependency-gate ⚠️ (Event Hubs has no HTTPS REST receive;
> AMQP needs `@azure/event-hubs` + `LOOM_EVENTHUB_RECEIVE_ENABLED`) — allowed
> per `no-vaporware.md`. Verdict + gap list updated below to credit Send.

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
| A7 | …**view keys / connection strings** | ✅ built (conn-string ⚠️) | rev.3: SAS keys tab → `POST …/authrules/{rule}/keys` (`listKeys`) reveals primary/secondary keys with `CopyButton`. Connection strings are an honest ⚠️ gate — `disableLocalAuth:true` makes ARM return none, panel shows the "local auth disabled" notice. |
| A7 | …**regenerate** keys | ✅ built | rev.3: "Rotate primary/secondary" → `…/keys/regenerate?keyType=` (`regenerateKeys`), namespace + per-hub scopes. (Create/delete policy still ❌.) |
| A8 | Scale — throughput units / Auto-inflate | ❌ MISSING | Not even a gate row. No TU slider, no auto-inflate toggle. (Bicep sets TUs + auto-inflate; UI never exposes it.) |
| A9 | Geo-recovery — **configs list** | 🟡 partial | `Geo-recovery` group lists alias/role/state via real `GET …/disasterRecoveryConfigs`. Read-only. |
| A9 | …pairing / break / **failover** | ✅ built | rev.3: Geo-recovery tab → `POST /api/eventhubs/geodr-actions` → real `PUT/DELETE …/disasterRecoveryConfigs/{alias}` + `…/failover`, with create-pairing form + break/failover confirm dialogs. |
| A10 | Geo-replication (data) | ❌ MISSING | Not represented. |
| A11 | Encryption (CMK / double encryption) | ❌ MISSING | — |
| A12 | Identity (managed identity) | ❌ MISSING | — |
| A13 | Networking — **firewall summary** | 🟡 partial | `Networking` group shows default action + public access + IP/VNet **counts** via real `GET …/networkRuleSets/default`. Read-only summary only — no rule list, no add/remove, no private-endpoint list/approve. |
| A13 | …IP rules add/remove, VNet rules, **private endpoints** add/approve/reject | ✅ (PE) / ❌ (IP/VNet edit) | rev.3: Private endpoints tab → `POST /api/eventhubs/private-endpoints` approves/rejects pending PE connections (real ARM). IP/VNet rule **editing** still ❌ (only the count is shown). |
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
| B3 | **Capture** configuration | ✅ built | rev.3: Capture tab (per hub) → `PUT /api/eventhubs/capture` → real `PUT …/eventhubs/{eh}` `captureDescription`: On/Off Switch, Avro encoding, ADLS Gen2 / Blob destination + container + naming format. Names the Storage Blob Data Contributor role the UAMI needs as an honest note. |
| B4 | Per-hub Shared access policies | ✅ built (conn-string ⚠️) | rev.3: SAS keys tab has a per-hub segment (`{hub} rules`) listing the hub's auth rules with reveal (`?scope=eventhub&hub=`) + rotate. Connection strings gated by `disableLocalAuth:true` (same honest gate as namespace scope). |
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
| SAS keys (reveal) / connection strings | `/api/eventhubs/authrules/{rule}/keys` (`?scope=namespace\|eventhub`) | `POST …/authorizationRules/{rule}/listKeys` | ✅ real ARM (keys revealed; conn-string ⚠️ gated by `disableLocalAuth:true`) |
| SAS keys (rotate) | `/api/eventhubs/authrules/{rule}/keys/regenerate?keyType=` | `POST …/authorizationRules/{rule}/regenerateKeys` | ✅ real ARM |
| Scale / Auto-inflate | — | `PATCH …/namespaces/{ns}` (sku.capacity, isAutoInflateEnabled) | ❌ not wired |
| Capture config | `/api/eventhubs/capture` | `PUT …/eventhubs/{eh}` captureDescription | ✅ real ARM |
| Geo-DR pairing / failover | `/api/eventhubs/geodr-actions` | `PUT/DELETE …/disasterRecoveryConfigs/{alias}` + `…/failover` | ✅ real ARM |
| Networking IP/VNet edit | — | `PUT …/networkRuleSets/default` | ❌ not wired |
| Private endpoint approve/reject | `/api/eventhubs/private-endpoints` | `PUT …/privateEndpointConnections/{c}` (approve/reject) | ✅ real ARM |
| Encryption / Identity | — | `PATCH …/namespaces/{ns}` (encryption, identity) | ❌ not wired |
| Data Explorer **send** | `/api/eventhubs/data-explorer` (op=send) | `POST https://{ns}.servicebus.windows.net/{hub}/messages` (Entra Bearer, single=atom-entry / batch=servicebus-json, PartitionKey via BrokerProperties header) | ✅ real data-plane REST |
| Data Explorer **view/peek** | `/api/eventhubs/data-explorer` (op=peek) | AMQP receive (`@azure/event-hubs`) — not bundled | ⚠️ honest dependency-gate (501 `receive_unavailable`; full View UI renders) |
| IAM / Tags / Locks / Metrics / Alerts / Diagnostics | — | ARM `roleAssignments`, `tags`, `locks`, Azure Monitor | ❌ not wired |

Every route is session-guarded (`getSession()` → 401), 503s via
`eventhubsConfigGate()` with the exact missing env var, returns `{ ok, … }`
JSON, and issues real ARM calls only (no mocks). That part is clean — the
problem is **coverage**, not honesty of what's there.

## Verdict (conservative)

**Grade: B− (rev.3 — up from C).** rev.3 adds the `EventHubsNamespaceEditor`
blade (PR #1075), which wires the four authoring surfaces that were the doc's
highest-value gaps — **Capture**, **Geo-DR pairing/break/failover**, **SAS-key
reveal/rotate** (connection strings honestly gated by `disableLocalAuth:true`),
and **Private-endpoint approve/reject** — all to real ARM. What exists is honest
and real-backed
(ARM CRUD for event hubs / consumer groups / schema groups; read-only lists for
SAS rules, networking, Geo-DR) **plus a real Data Explorer Send path** (Entra
data-plane `POST …/messages`, PR #548) with an honest dependency-gate on the
receive/View side. That closes half of the single biggest missing surface. Still
measured against the **real** Azure Event Hubs UI, Loom implements roughly the
namespace entity tree + the send half of Data Explorer, and **zero** of the
namespace management/monitoring blades. No Overview, no Scale, no IAM, no
Metrics, no Capture authoring, no SAS key/connection-string copy, and the Data
Explorer **View/receive** side is still gated (AMQP dep). The prior
`eventhubs-namespace.md` "zero ❌" claim remains **inaccurate** because it scoped
the inventory to only the rows the navigator already had.

This is a competent **Eventstream source-picker sidecar**, not a
one-for-one Event Hubs portal. Per `ui-parity.md` it is **not A-grade** —
many ❌ rows and the absence of whole blades.

## Highest-value gaps to build first

> rev.2: Data Explorer **Send** is now built (PR #548, Entra data-plane,
> honors `disableLocalAuth:true`). The remaining Data Explorer gap is the
> **View/receive** side, which is an honest AMQP dependency-gate (allowed).

1. **Data Explorer — View/receive events** — the receive half (AMQP via
   `@azure/event-hubs` + `LOOM_EVENTHUB_RECEIVE_ENABLED`); today an honest
   dependency-gate. (Send is done.)
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
