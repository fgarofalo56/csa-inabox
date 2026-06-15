# rti-hub — parity with Fabric Real-Time hub (unified stream catalog)

Source UI: Fabric portal → **Real-Time** → Real-Time hub → **All data streams** / **Get events** / **Microsoft sources** / **Azure events** / **Fabric events**, plus the Azure portal cross-resource browse for Event Hubs / IoT Hub / ADX.

Grounded in Microsoft Learn:
- https://learn.microsoft.com/fabric/real-time-hub/real-time-hub-overview
- https://learn.microsoft.com/fabric/real-time-hub/supported-sources
- https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/eventstream-rest-api
- https://learn.microsoft.com/azure/governance/resource-graph/first-query-rest-api
- https://learn.microsoft.com/azure/governance/resource-graph/concepts/paging-results

Backend service: **Azure Resource Graph** (`POST …/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`, scope `https://management.azure.com/.default`) via the Console UAMI (`LOOM_UAMI_CLIENT_ID`, `ChainedTokenCredential`) for cross-subscription discovery; **Event Hubs ARM** (`listEventHubs`) for entity expansion; **Cosmos** (Loom item index) for eventstream / KQL / Eventhouse items. **No Microsoft Fabric on the default path** — Fabric events are strictly opt-in (`LOOM_EVENTSTREAM_BACKEND=fabric`), per `.claude/rules/no-fabric-dependency.md`.

## How this differs from `/realtime-hub`

`/rti-hub` (this surface) is the **discover-and-connect catalog**: it enumerates the *real Azure resources* (Event Hub namespaces, IoT Hubs, ADX clusters) the Console can see via Resource Graph across every subscription — the thing the Fabric "Microsoft sources" / "Azure events" browse does — and lets you **Subscribe** each into a real Loom eventstream. It also lists your deployed Loom items (eventstream / KQL / Eventhouse) with inline preview/test/query/open actions.

`/realtime-hub` is the **deployed-streams catalog** (Fabric-RTH parity): every Loom eventstream + KQL table with Preview/Endpoints/Open, plus the Connect-source gallery. The two are complementary and cross-linked in both directions; both ship.

## Fabric/Azure feature inventory → Loom coverage

| Capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| **All data streams** across the tenant | ✅ built — Data streams tab: Loom eventstream/KQL/Eventhouse items + every discovered EH namespace, IoT Hub, ADX cluster | `GET /api/rti-hub` → `listStreamingResourcesViaGraph(subs)` (Resource Graph) + `listAllOwnedItems` (Cosmos) |
| Cross-**subscription** browse | ✅ built — `LOOM_SUBSCRIPTION_ID` + `LOOM_EXTRA_SUBSCRIPTIONS`, paged via `$skipToken` | Resource Graph KQL `where type in~ (eventhub/namespaces, devices/iothubs, kusto/clusters)` |
| Event Hub **entity** granularity (per event hub, not just namespace) | ✅ built — the env-pinned Loom namespace expands into one row per event hub | `listEventHubs()` (real EH ARM `…/eventhubs`) |
| Columns: Name, Type, Source, Resource group, Location | ✅ built — sortable / filterable / resizable `LoomDataTable` | same route payload |
| Row action: **Subscribe** (connect source → create eventstream) | ✅ built — opens the ConnectSourceDialog **pre-filled** with the row's source type + properties (e.g. `eventHubName`, `consumerGroupName`); on success surfaces an **"Open eventstream editor"** button (dialog) + toast deep-link to the new item | `POST /api/realtime-hub/connect-source` → `createOwnedItem('eventstream', …)` (real Cosmos item, EH-backed); receipt `link:/items/eventstream/{id}` |
| Row action: **Create activator** (Reflex on a stream) | ✅ built — creates an `activator` Loom item carrying the stream `source` ref | `POST /api/items/activator` (Azure-native: Cosmos item + Azure Monitor rules) |
| Row action: **Open item** (Loom items) | ✅ built — deep-links to the live editor (query / manage); labelled "Query / open KQL database / Eventhouse" for KQL kinds, "Open eventstream editor" otherwise | `/items/{type}/{id}` |
| Row action: **Preview / test events** (Loom eventstream) | ✅ built — drawer: **Send test event** over the HTTPS data-plane (works today) + **Peek recent events** (AMQP; honest 501 dependency-gate rendered as a MessageBar when receive isn't enabled, never faked events). A **newly subscribed** stream with no ingest endpoint yet returns `409`; the drawer surfaces a **"Provision ingest endpoint"** button that provisions the source in place (real Azure Event Hub) so the catalog → Subscribe → Test loop closes without leaving the surface | `POST/GET /api/items/eventstream/{id}/events` (`sendEvents` / `peekEvents`); provision: `POST /api/items/eventstream/{id}/source` `{nodeIdx, fromSaved:true}` |
| Row action: **Peek / send events** (Event Hub entity) | ✅ built — same drawer against the entity's hub (`properties.eventHubName`); send works today, peek honestly gates | `POST/GET /api/eventhubs/data-explorer` (`op=send\|peek`, `hub`) |
| Row action: **Preview data** (KQL database / Eventhouse) | ✅ built — drawer reads recent rows from the backing KQL table; the table identifier is quoted server-side (no raw KQL) | `POST /api/realtime-hub/preview` → `executeQuery` (Kusto) |
| Row action: **Preview table on this cluster** (discovered ADX cluster) | ✅ built — drawer reads recent rows from a table on the *discovered* cluster, not the env default; the row's `adxClusterUri` is threaded as a validated `clusterUri` override through to `executeQuery` | `POST /api/realtime-hub/preview {clusterUri}` → `executeQuery(db, kql, {clusterUri})` |
| Row action: **Endpoints** (Loom eventstream) | ✅ built — drawer projects the eventstream definition's sources / destinations / streams | `GET /api/realtime-hub/endpoints?workspaceId&eventstreamId` |
| Action set is **kind-aware** (per `lib/components/realtime-hub/rti-hub-actions.ts`) | ✅ built — eventstream → preview/test + endpoints + open; KQL/Eventhouse → preview + query/open; EH entity → peek/send; ADX cluster → preview-on-cluster + subscribe + activator; namespace/IoT → subscribe + activator only (no fake preview) | `streamRowActions(kind)` (unit-tested) |
| **Azure events** tab (Blob Storage events / Event Grid) | ✅ built — Blob Storage Events → pre-filled `AzureBlobStorageEvents` eventstream; governed **business-event** Event Grid topics → pre-filled `CustomEndpoint` eventstream (dedicated ingest Event Hub receives the topic's CloudEvents). Every row's `sourceType` is a valid RTH source so **Connect is always live** (regression-pinned) | connect-source route |
| **Fabric events** tab (Workspace item / Job / OneLake / Capacity events) | ⚠️ opt-in only — tab hidden unless `LOOM_EVENTSTREAM_BACKEND=fabric`; honest MessageBar otherwise | gated; never on the default path |
| Honest infra-gate when no subscription configured | ⚠️ honest-gate — `503 code:not_configured` naming `LOOM_SUBSCRIPTION_ID` + the Reader RBAC + the bicep module; Loom-item rows still render | `eventhubsConfigGate` pattern |
| Partial-result resilience | ✅ built — a Resource Graph / ARM failure records `warnings[]` and returns `200` with whatever discovered | per-source try/catch |

## Gaps (tracked, not stubbed)

| Capability | Status | Why / next |
| --- | --- | --- |
| Per-storage-account **Event Grid System Topic** enumeration | ➡️ phase-2 (`_eventGridDiscovery:'phase-2'`) | System topics are per-resource; needs a second `Microsoft.EventGrid/systemTopics` graph query. The Blob Storage Events connect action is real today. |
| Entity expansion for **non-pinned** EH namespaces | ➡️ deferred | Avoids per-namespace ARM fan-out across unknown namespaces; each appears as one subscribable namespace row. Tracked, not faked. |
| **Live peek** for Event Hub / IoT Hub / eventstream sources | ➡️ honest-gate today | Receiving is AMQP-only — no HTTPS REST receive. Until `@azure/event-hubs` is bundled + `LOOM_EVENTHUB_RECEIVE_ENABLED` is set the peek route returns an honest `501 code:receive_unavailable`, which the Preview/test drawer renders as a MessageBar. **Send** test events works today over the HTTPS data-plane. |
| Raw query against an **arbitrary discovered ADX cluster** | ✅ built | ADX-cluster rows expose **Preview table on this cluster** — the `StreamPreviewDrawer` carries the row's `adxClusterUri` as a validated `clusterUri` override (`normalizeClusterUri` accepts only a bare `https://<kusto-host>` origin) threaded through `executeQuery(db, kql, {clusterUri})`, so the query targets the discovered cluster, not the env default. Subscribe + Create activator still available. |
| **Endorse** (governance endorsement) + **Explore data / real-time dashboard via Copilot** (Fabric KQL-table actions) | ➡️ not built | Listed honestly; the KQL/Eventhouse rows offer Preview data + Query/Open editor today. Not faked. |
| IoT Hub provisioning bicep | ➡️ discovery-only | Existing IoT Hubs are discovered automatically; a `landing-zone/iot-hub.bicep` opt-in module is noted for provisioning. |
| **Sub-100 ms transactional object store (Palantir Phonograph) + live ontology writeback** | ➡️ out-of-scope (by design) — `audit-T35` (PMF-GAP-1/4/5) | Loom's real-time path is an Azure-native **analytics** pipeline — Event Hubs single-digit-ms ingestion → Stream Analytics (`100ms–2s` processing) / Real-Time Intelligence over ADX (sub-second query), per `../../migrations/palantir-foundry/benchmarks.md`. That is **not** a Phonograph-style sub-100 ms **OLTP** object backbone serving editable ontology objects, and there is **no live object writeback round-trip** — analyst edits go through a *separate* Power Apps form + SQL-endpoint / Fabric-notebook path (`../../migrations/palantir-foundry/analytics-migration.md` §7). For a low-latency OLTP object store, pair the analytics pipeline with **Cosmos DB / Azure SQL**. Disclosed live via a persistent `intent="info"` MessageBar ("Real-time scope") in `apps/fiab-console/lib/components/realtime-hub/rti-hub-view.tsx`. No vaporware claim is implied. |
| **IL6 / classified-SCI** real-time workloads | ➡️ out-of-scope (by design) — `audit-T35` | csa-inabox is not authorized to IL6 / Azure Government Secret; sponsor-specific deploys only (`../adr/0001-fabric-feature-scope.md`). The Azure-native path runs on Commercial / GCC / GCC-High / IL5; IL6 is explicitly excluded. |

## Backend per control

- `GET /api/rti-hub` — `getSession` (401) → `rtiSubscriptionScope()` (503 honest-gate when empty) → `Promise`-merge `listAllOwnedItems` + `listStreamingResourcesViaGraph` + env-pinned `listEventHubs` expansion → tabs `{ dataStreams, azureEvents, fabricEvents }`; each row carries `subscribePreFill {sourceType, sourceName, properties}`.
- `GET /api/real-time-hub/sources` — stable hyphenated **alias** that re-exports the same handler as `GET /api/rti-hub` (identical payload, no divergent logic).
- **Subscribe** → existing `POST /api/realtime-hub/connect-source` with the pre-fill body → real Loom eventstream item (receipt: `{ ok, eventstreamId, link }`); the dialog and the parent toast both deep-link to `link` ("Open eventstream editor").
- **Create activator** → `POST /api/items/activator?workspaceId=…` with `source` ref → real Cosmos activator item.
- **Preview / test events** (eventstream rows) → `EventTestDrawer` → `POST/GET /api/items/eventstream/{id}/events` (real `sendEvents` over HTTPS; `peekEvents` AMQP-gated). A `409` (no provisioned ingest endpoint) surfaces a **Provision ingest endpoint** button → `POST /api/items/eventstream/{id}/source {nodeIdx, fromSaved:true}` which maps the saved source `type` → a real Azure ingest endpoint (eventhub / iothub / custom-app), then the operator retries send/peek. CDC + Blob-storage sources return an honest `422 needs_editor` (configure in the editor first).
- **Peek / send events** (Event Hub entity rows) → `EventTestDrawer` → `POST/GET /api/eventhubs/data-explorer` (`op=send|peek`, `hub` = `properties.eventHubName`).
- **Preview data** (KQL / Eventhouse rows) → `StreamPreviewDrawer` → `POST /api/realtime-hub/preview` (server-quoted `["table"] | take N`).
- **Preview table on this cluster** (discovered ADX-cluster rows) → `StreamPreviewDrawer` with a `clusterUri` override → `POST /api/realtime-hub/preview {clusterUri}` → `executeQuery(db, kql, {clusterUri})`; `normalizeClusterUri` validates the override to a bare `https` Kusto host before any data-plane call.
- **Endpoints** (eventstream rows) → `StreamEndpointsDrawer` → `GET /api/realtime-hub/endpoints`.
- **Query / Open editor** (Loom item rows) → deep-link `/items/{type}/{id}` (the editor exposes the KQL query grid + lifecycle/manage).
- The `StreamPreviewDrawer`, `StreamEndpointsDrawer`, and the kind-aware `streamRowActions()` matrix are **shared one implementation** with `/realtime-hub` so the two surfaces never diverge.

## Per-cloud

- **Commercial** (default): `management.azure.com`; Fabric tab available when opted in.
- **GCC**: `LOOM_ARG_URL=…usgovcloudapi.net…`, `LOOM_ARM_SCOPE=…usgovcloudapi.net/.default`; Fabric unavailable → tab gated with the sovereign reason.
- **GCC-High / IL5**: `LOOM_ARG_URL=…azure.us…`, `LOOM_ARM_SCOPE=…azure.us/.default`; EH namespaces `publicNetworkAccess:Disabled` (mgmt plane still reachable from the console VNET); Fabric unavailable.

## RBAC + bicep sync

- **Subscription-scoped Reader** for the Console UAMI — `platform/fiab/bicep/main.bicep` (`rtiHubArgReader`, role `acdd72a7-…`). Without it Resource Graph returns `[]`.
- **Event Hubs data-plane (peek / send test events)** — the Console UAMI already holds **Azure Event Hubs Data Owner** (`f526a384-…`, send + receive) on the DLZ namespace via `platform/fiab/bicep/modules/landing-zone/eventhubs.bicep` (`ehDataOwnerRole`). No new grant is needed for the Peek/Send drawer; `send` works today over HTTPS, `peek` lights up once `@azure/event-hubs` + `LOOM_EVENTHUB_RECEIVE_ENABLED` are present.
- **Env** — `LOOM_EXTRA_SUBSCRIPTIONS` added to the console app env in `platform/fiab/bicep/modules/admin-plane/main.bicep` (`LOOM_SUBSCRIPTION_ID` already wired); `LOOM_ARG_URL` / `LOOM_ARM_SCOPE` are optional sovereign overrides; `LOOM_EVENTHUB_RECEIVE_ENABLED` gates the AMQP peek path.
- **Cross-cluster ADX preview** (Preview table on this cluster) — no new env (the `clusterUri` is a request param). Querying a *discovered* cluster requires the Console UAMI to hold an ADX data-plane role (**AllDatabasesViewer** / **Viewer**) on that cluster; it already holds this on the env-pinned Loom cluster via `landing-zone/adx.bicep`. For an arbitrary discovered cluster the role is an out-of-band grant on that cluster — until then the preview surfaces the real Kusto `403` verbatim (honest gate, never faked rows), and the discovered cluster's subscription must be in `LOOM_EXTRA_SUBSCRIPTIONS` for it to appear at all.

## Verification

- Backend contract tests: `app/api/rti-hub/__tests__/route.test.ts` (10) — 401, 503 honest-gate, dataStreams (graph EH namespace + Loom eventstream), azureEvents static connector, Fabric opt-in gate, EH-entity `AzureEventHub` pre-fill, IoT-Hub `AzureIoTHub` pre-fill, Resource-Graph-failure → `warnings[]` + 200, **every emitted `subscribePreFill.sourceType` is a valid RTH source** (connectable), and **business-event topics → `CustomEndpoint`** (GAP-1 regression). Plus `app/api/real-time-hub/sources/__tests__/route.test.ts` (3) — pins the alias to the same handler.
- Action-matrix unit test: `lib/components/realtime-hub/__tests__/rti-hub-actions.test.ts` — pins `streamRowActions(kind)` for each row kind (eventstream → preview/test + endpoints + open; KQL/Eventhouse → preview + query/open; EH entity → peek/send; **ADX cluster → preview-on-cluster + subscribe + activator**; namespace/IoT → subscribe + activator only) and the universality of Subscribe + Create activator. Pure logic so it runs without the env-gated render harness.
- ADX cluster-URI override guard: `lib/azure/__tests__/kusto-cluster-uri.test.ts` — `normalizeClusterUri` accepts bare https Kusto / sovereign / Fabric-Eventhouse / Azure-Monitor-ADX hosts and strips path/query; rejects http, malformed, and non-Kusto hosts (e.g. `api.fabric.microsoft.com`).
- The per-row drawers reuse already-tested routes: `/api/items/eventstream/{id}/events`, `/api/eventhubs/data-explorer`, `/api/realtime-hub/preview`, `/api/realtime-hub/endpoints` — each with its own contract tests; the `StreamPreviewDrawer` / `StreamEndpointsDrawer` are shared one-implementation with `/realtime-hub`.
- `tsc --noEmit` clean across the touched files (the project's ~pre-existing griffel `:hover`/`:focus-visible` typing backlog is unrelated and untouched here).
- Live browser probe + minted-session E2E: not available in this worktree (no provisioned subscription Reader / UAMI). Per `no-vaporware.md` the honest 503 infra-gate and the 501 receive-gate render when discovery / AMQP-receive are unconfigured; `send` test events and KQL preview/query run against real Azure once the backends are provisioned.
