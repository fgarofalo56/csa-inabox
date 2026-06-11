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

`/realtime-hub` is the Fabric-RTH parity surface (Loom eventstream + KQL item catalog + connect-source gallery). `/rti-hub` is the **cross-subscription Azure stream catalog**: it enumerates the *real Azure resources* (Event Hub namespaces, IoT Hubs, ADX clusters) the Console can see via Resource Graph — the thing the Fabric "Microsoft sources" / "Azure events" browse does — and lets you Subscribe each into a real Loom eventstream. The two are complementary; both ship.

## Fabric/Azure feature inventory → Loom coverage

| Capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| **All data streams** across the tenant | ✅ built — Data streams tab: Loom eventstream/KQL/Eventhouse items + every discovered EH namespace, IoT Hub, ADX cluster | `GET /api/rti-hub` → `listStreamingResourcesViaGraph(subs)` (Resource Graph) + `listAllOwnedItems` (Cosmos) |
| Cross-**subscription** browse | ✅ built — `LOOM_SUBSCRIPTION_ID` + `LOOM_EXTRA_SUBSCRIPTIONS`, paged via `$skipToken` | Resource Graph KQL `where type in~ (eventhub/namespaces, devices/iothubs, kusto/clusters)` |
| Event Hub **entity** granularity (per event hub, not just namespace) | ✅ built — the env-pinned Loom namespace expands into one row per event hub | `listEventHubs()` (real EH ARM `…/eventhubs`) |
| Columns: Name, Type, Source, Resource group, Location | ✅ built — sortable / filterable / resizable `LoomDataTable` | same route payload |
| Row action: **Subscribe** (connect source → create eventstream) | ✅ built — opens the ConnectSourceDialog **pre-filled** with the row's source type + properties (e.g. `eventHubName`, `consumerGroupName`); on success surfaces an **"Open eventstream editor"** button (dialog) + toast deep-link to the new item | `POST /api/realtime-hub/connect-source` → `createOwnedItem('eventstream', …)` (real Cosmos item, EH-backed); receipt `link:/items/eventstream/{id}` |
| Row action: **Create activator** (Reflex on a stream) | ✅ built — creates an `activator` Loom item carrying the stream `source` ref | `POST /api/items/activator` (Azure-native: Cosmos item + Azure Monitor rules) |
| Row action: **Open item** (Loom items) | ✅ built — deep-links to the live editor | `/items/{type}/{id}` |
| **Azure events** tab (Blob Storage events / Event Grid) | ✅ built — Blob Storage Events connector → pre-filled `AzureBlobStorageEvents` eventstream | connect-source route |
| **Fabric events** tab (Workspace item / Job / OneLake / Capacity events) | ⚠️ opt-in only — tab hidden unless `LOOM_EVENTSTREAM_BACKEND=fabric`; honest MessageBar otherwise | gated; never on the default path |
| Honest infra-gate when no subscription configured | ⚠️ honest-gate — `503 code:not_configured` naming `LOOM_SUBSCRIPTION_ID` + the Reader RBAC + the bicep module; Loom-item rows still render | `eventhubsConfigGate` pattern |
| Partial-result resilience | ✅ built — a Resource Graph / ARM failure records `warnings[]` and returns `200` with whatever discovered | per-source try/catch |

## Gaps (tracked, not stubbed)

| Capability | Status | Why / next |
| --- | --- | --- |
| Per-storage-account **Event Grid System Topic** enumeration | ➡️ phase-2 (`_eventGridDiscovery:'phase-2'`) | System topics are per-resource; needs a second `Microsoft.EventGrid/systemTopics` graph query. The Blob Storage Events connect action is real today. |
| Entity expansion for **non-pinned** EH namespaces | ➡️ deferred | Avoids per-namespace ARM fan-out across unknown namespaces; each appears as one subscribable namespace row. Tracked, not faked. |
| IoT Hub provisioning bicep | ➡️ discovery-only | Existing IoT Hubs are discovered automatically; a `landing-zone/iot-hub.bicep` opt-in module is noted for provisioning. |
| **Sub-100 ms transactional object store (Palantir Phonograph) + live ontology writeback** | ➡️ out-of-scope (by design) — `audit-T35` (PMF-GAP-1/4/5) | Loom's real-time path is an Azure-native **analytics** pipeline — Event Hubs single-digit-ms ingestion → Stream Analytics (`100ms–2s` processing) / Real-Time Intelligence over ADX (sub-second query), per `../../migrations/palantir-foundry/benchmarks.md`. That is **not** a Phonograph-style sub-100 ms **OLTP** object backbone serving editable ontology objects, and there is **no live object writeback round-trip** — analyst edits go through a *separate* Power Apps form + SQL-endpoint / Fabric-notebook path (`../../migrations/palantir-foundry/analytics-migration.md` §7). For a low-latency OLTP object store, pair the analytics pipeline with **Cosmos DB / Azure SQL**. Disclosed live via a persistent `intent="info"` MessageBar ("Real-time scope") in `apps/fiab-console/lib/components/realtime-hub/rti-hub-view.tsx`. No vaporware claim is implied. |
| **IL6 / classified-SCI** real-time workloads | ➡️ out-of-scope (by design) — `audit-T35` | csa-inabox is not authorized to IL6 / Azure Government Secret; sponsor-specific deploys only (`../adr/0001-fabric-feature-scope.md`). The Azure-native path runs on Commercial / GCC / GCC-High / IL5; IL6 is explicitly excluded. |

## Backend per control

- `GET /api/rti-hub` — `getSession` (401) → `rtiSubscriptionScope()` (503 honest-gate when empty) → `Promise`-merge `listAllOwnedItems` + `listStreamingResourcesViaGraph` + env-pinned `listEventHubs` expansion → tabs `{ dataStreams, azureEvents, fabricEvents }`; each row carries `subscribePreFill {sourceType, sourceName, properties}`.
- `GET /api/real-time-hub/sources` — stable hyphenated **alias** that re-exports the same handler as `GET /api/rti-hub` (identical payload, no divergent logic).
- **Subscribe** → existing `POST /api/realtime-hub/connect-source` with the pre-fill body → real Loom eventstream item (receipt: `{ ok, eventstreamId, link }`); the dialog and the parent toast both deep-link to `link` ("Open eventstream editor").
- **Create activator** → `POST /api/items/activator?workspaceId=…` with `source` ref → real Cosmos activator item.

## Per-cloud

- **Commercial** (default): `management.azure.com`; Fabric tab available when opted in.
- **GCC**: `LOOM_ARG_URL=…usgovcloudapi.net…`, `LOOM_ARM_SCOPE=…usgovcloudapi.net/.default`; Fabric unavailable → tab gated with the sovereign reason.
- **GCC-High / IL5**: `LOOM_ARG_URL=…azure.us…`, `LOOM_ARM_SCOPE=…azure.us/.default`; EH namespaces `publicNetworkAccess:Disabled` (mgmt plane still reachable from the console VNET); Fabric unavailable.

## RBAC + bicep sync

- **Subscription-scoped Reader** for the Console UAMI — `platform/fiab/bicep/main.bicep` (`rtiHubArgReader`, role `acdd72a7-…`). Without it Resource Graph returns `[]`.
- **Env** — `LOOM_EXTRA_SUBSCRIPTIONS` added to the console app env in `platform/fiab/bicep/modules/admin-plane/main.bicep` (`LOOM_SUBSCRIPTION_ID` already wired); `LOOM_ARG_URL` / `LOOM_ARM_SCOPE` are optional sovereign overrides.

## Verification

- Backend contract tests: `app/api/rti-hub/__tests__/route.test.ts` (8) — 401, 503 honest-gate, dataStreams (graph EH namespace + Loom eventstream), azureEvents static connector, Fabric opt-in gate, EH-entity `AzureEventHub` pre-fill, IoT-Hub `AzureIoTHub` pre-fill, Resource-Graph-failure → `warnings[]` + 200. Plus `app/api/real-time-hub/sources/__tests__/route.test.ts` (3) — pins the alias to the same handler + 401 + Azure-native data-streams contract. All 11 passing.
- The legacy static `lib/panes/real-time-hub.tsx` (hard-coded `SOURCES` array of dead cards, orphaned/unimported) is removed; the pane now re-exports the live `RtiHubView`.
- `tsc --noEmit` clean across the project (0 errors).
- Live browser probe + minted-session E2E: not available in this worktree (no provisioned subscription Reader / UAMI). Per `no-vaporware.md` the honest 503 infra-gate renders when discovery is unconfigured.
