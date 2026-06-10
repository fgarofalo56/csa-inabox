# real-time-hub — parity with Fabric Real-Time hub

Source UI: Fabric portal → left nav **Real-Time** → Real-Time hub page (All data streams + task cards), the **Data sources / Get events** wizard, and the **Fabric events** / **Azure events** pages.

Grounded in Microsoft Learn:
- https://learn.microsoft.com/fabric/real-time-hub/real-time-hub-overview
- https://learn.microsoft.com/fabric/real-time-hub/get-started-real-time-hub
- https://learn.microsoft.com/fabric/real-time-hub/supported-sources
- https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/eventstream-rest-api
- https://learn.microsoft.com/fabric/real-time-hub/preview-data-streams

Backend service: **Fabric REST** (`https://api.fabric.microsoft.com/v1`, scope `https://api.fabric.microsoft.com/.default`) via the Console UAMI (`LOOM_UAMI_CLIENT_ID`, `ChainedTokenCredential`) for stream discovery + source connection; **Kusto/ADX** (`LOOM_KUSTO_CLUSTER_URI`) via the same UAMI for the data-in-motion preview.

There is **no separate "Real-Time hub REST API"** — the Fabric hub is composed on top of (1) the Eventstream definition REST API (create item whose topology carries the chosen source) and (2) per-workspace item listing (eventstreams + KQL databases). Loom mirrors that composition exactly.

## The problem this fixes

The old `/realtime-hub` page was a thin wrapper around `ItemsByTypePane` listing Cosmos items by type (`eventstream`, `eventhouse`, `kql-database`, …). It did **not** call any Fabric Real-Time hub surface: no tenant-wide data-stream discovery, no Get-events / Connect-source flow, no Microsoft/Fabric/Azure source connectors, no preview, no endpoints. Operator verdict: "doesn't really work at all… looks more like vaporware." This rebuild wires the page to real Fabric + Kusto REST.

## Fabric Real-Time hub feature inventory → Loom coverage

| Fabric capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| **Discovered Azure sources** — every real Event Hubs namespace / Event Hub entity / IoT Hub / ADX cluster across subscriptions (Azure-native, no Fabric) | ✅ built — "Discovered Azure sources" table on the live page; per-row **Subscribe** (pre-fills the Connect-source dialog with the source) + **Create activator** (real activator item) | `GET /api/rti-hub` (Azure Resource Graph + ARM) → `LoomDataTable`; Subscribe → `POST /api/realtime-hub/connect-source`; Create activator → `POST /api/items/activator`. Honest `MessageBar` infra-gate naming `LOOM_SUBSCRIPTION_ID` when discovery isn't configured. |
| **All data streams** — tenant-wide list of every eventstream output (stream) + KQL table (table) you can access | ✅ built — streams table aggregated across **all** Fabric workspaces | `GET /workspaces` → per-ws `GET /workspaces/{ws}/eventstreams` + `GET /workspaces/{ws}/kqlDatabases` (404 → `eventhouses` fallback) via `/api/realtime-hub/streams` |
| Columns: Data, Source item, Workspace, (Item owner, Endorsement, Sensitivity) | ✅ built — Data / Type / Source item / Workspace columns | same route (owner/endorsement/sensitivity not in the slim list payload — see Gaps) |
| Filters: Data type (stream/table), Workspace, search | ✅ built — type Dropdown + workspace Dropdown + free-text search | client-side over the real list |
| Row action: **Preview data** ("Explore data in motion") | ✅ built — Preview drawer; pick DB+table → recent rows | `POST /api/realtime-hub/preview` → `executeQuery(db, '["table"] | take N')` (real Kusto) |
| Row action: **Open eventstream / Open KQL database** | ✅ built — menu links to `/items/eventstream/{id}` and `/items/kql-database/{id}` (existing working editors) | navigates to live editor routes |
| Stream **endpoints** (Event Hub-compatible / custom-endpoint / source connection info) | ✅ built — Endpoints drawer (sources/destinations/streams from the live definition) | `GET /api/realtime-hub/endpoints` → `getEventstreamDefinition` (real Fabric `getDefinition`) |
| **Get events / Connect data source** wizard | ✅ built — ConnectSourceDialog (category list + connector grid + dynamic connection form) | `POST /api/realtime-hub/connect-source` → `connectEventstreamSource` (real `POST /workspaces/{ws}/eventstreams` with Base64 `eventstream.json`) |
| **Microsoft sources**: Azure Event Hubs, IoT Hub, Service Bus (preview) | ✅ built — `AzureEventHub` / `AzureIoTHub` / `AzureServiceBus` connectors | eventstream source `type` enum |
| **Database CDC**: Azure SQL DB / SQL MI / Cosmos DB / PostgreSQL / MySQL CDC | ✅ built — `AzureSQLDBCDC` / `AzureSQLMIDBCDC` / `AzureCosmosDBCDC` / `PostgreSQLCDC` / `MySQLCDC` | eventstream source `type` enum |
| **External streams**: Apache Kafka, Confluent, Amazon MSK, Kinesis, Google Pub/Sub | ✅ built — `ApacheKafka` / `ConfluentCloud` / `AmazonMSKKafka` / `AmazonKinesis` / `GooglePubSub` | eventstream source `type` enum |
| **Fabric events**: Workspace item events, Job events, OneLake events | ✅ built — `FabricWorkspaceItemEvents` / `FabricJobEvents` / `FabricOneLakeEvents` connectors + dedicated "Subscribe to Fabric/Azure events" task card | creates a real eventstream with the Fabric-event source `type` |
| **Azure events**: Azure Blob Storage events | ✅ built — `AzureBlobStorageEvents` connector | eventstream source `type` enum |
| **Sample data** quick-start | ✅ built — `SampleData` connector (no connection required) | eventstream source `type` enum |
| Task cards: Get events, Subscribe to events, Explore data in motion | ✅ built — three task cards at the top of the page | wired to the dialogs/drawers above |
| Honest infra-gate when the UAMI isn't authorized in Fabric | ⚠️ honest-gate — `MessageBar intent="warning"` naming the SP-toggle + `LOOM_UAMI_CLIENT_ID` workspace-role requirement; **full hub UI still renders** | 401/403 `FabricError` passed through verbatim with `hint` |

## Tracked follow-ups (honest, not faked)

| Fabric capability | Status | Why / next |
| --- | --- | --- |
| Per-row **Item owner / Endorsement / Sensitivity** columns | ⚠️ tracked | Fabric item list payload doesn't include owner/endorsement; needs the admin `scanResult` / endorsement APIs. Tracked — not faked. |
| **Visualize data** (create Real-Time dashboard from a KQL table) | ➡️ delegated | Handled by the existing KQL-dashboard editor (`/items/kql-dashboard/new`); not duplicated on the hub. |
| Per-stream-node **Activate / Deactivate** | ⚠️ disclosed | Not in the public Eventstream REST surface (portal-only toggle) — disclosed honestly per `no-vaporware.md`, consistent with the Eventstream editor. |
| **Business events** (preview) | ⚠️ tracked | Preview-only Fabric feature; tracked follow-up for the preview pass. |

## Backend per control

| Control | Backend |
| --- | --- |
| All data streams | `GET /api/realtime-hub/streams` — `listFabricWorkspaces()` → fan-out `listEventstreams` + `listKqlDatabases` (`listEventhouses` fallback). Auth 401, Fabric gate 401/403 verbatim. |
| Connect data source | `POST /api/realtime-hub/connect-source` — content-type guard (415) → validate `sourceType` against `RTH_SOURCE_TYPES` (400) → `connectEventstreamSource(ws, {sourceType, properties})` → real `POST /workspaces/{ws}/eventstreams`. |
| Preview data | `POST /api/realtime-hub/preview` — content-type guard (415) → `executeQuery(db, '["table"] \| take N')` (N clamped ≤ 200, real ADX/Kusto). Kusto errors → 502. |
| Stream endpoints | `GET /api/realtime-hub/endpoints` — `getEventstreamDefinition(ws, id)` → decode Base64 `eventstream.json` → project sources/destinations/streams. |

## Verification

- Backend contract tests: `lib/azure/__tests__/fabric-realtime-hub.test.ts` (7) + `app/api/realtime-hub/__tests__/routes.test.ts` (18) — 25 passing. Cover URL/method/payload against the real Fabric REST surface, source-enum guard, content-type 415 guard, preview KQL shaping + limit clamp, endpoints decode, and the honest 401/403/502 pass-through.
- `pnpm build` clean (`/realtime-hub` + 4 routes compile; only third-party `@protobufjs` warning).
- Live browser probe + minted-session E2E: **not available in this worktree** (no provisioned Fabric tenant / UAMI). Per `no-vaporware.md` the honest infra-gate renders when the UAMI isn't authorized.
