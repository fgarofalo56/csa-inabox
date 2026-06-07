# eventstream — parity with Fabric Eventstream (Real-Time Intelligence)

Source UI: https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/eventstream-rest-api
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` → `EventstreamEditor`
Designer: `apps/fiab-console/lib/components/eventstream/visual-designer.tsx`

## Fabric feature inventory (grounded in Learn)

The Fabric Eventstream is a visual streaming topology with four component
arrays — **sources**, **operators**, **destinations**, **streams** — edited on
a node/edge canvas with a per-node config panel.

| Capability | Fabric behavior |
| --- | --- |
| Visual canvas (nodes + edges) | Drag sources → operators → destinations |
| Add source | Event Hubs, IoT Hub, Kafka/Custom endpoint, CDC, **Sample data** |
| Add operator | Filter, Aggregate, Group By, Manage-fields (project), Union, Join |
| Add destination | Eventhouse/KQL, Lakehouse, Activator (Reflex), Derived stream, Custom endpoint |
| Per-node config | Edit namespace / consumer group / table / DAX-like expression |
| Save / Publish | Persist topology; create the Eventstream item |
| Round-trip definition | `getDefinition` returns the live `eventstream.json` topology |
| Node Activate/Deactivate | Portal-only toggle (NOT in public REST) |

## Loom coverage

| Inventory row | State | Notes |
| --- | --- | --- |
| Visual canvas (sources → transforms → destinations) | ✅ built | `VisualDesigner` columns + selectable node cards + inspector |
| Add source (Event Hubs / IoT Hub / Kafka / CDC / Sample) | ✅ built | ribbon + palette; per-kind inspector fields |
| Add operator (Filter / Aggregate / Group By / Project / Union / Join) | ✅ built | ribbon + palette |
| Add destination (Kusto / Lakehouse / Event Hubs / Reflex / Derived) | ✅ built | inspector fields per sink kind |
| **Destination wizards → real ASA outputs** | ✅ built (NEW) | KQL DB/Lakehouse/Event Hub/Activator destination forms create real ASA outputs (Azure-native, no Fabric). See `## Destination → Azure Stream Analytics output`. |
| Per-node config edit | ✅ built | inline inspector forms (no raw JSON required) |
| JSON view (advanced) | ✅ built | Monaco JSON editor, two-way synced with the canvas |
| Save topology (Cosmos) | ✅ built | `PUT /api/items/eventstream/[id]` → Cosmos state |
| **Create on /new** | ✅ built (NEW) | `NewItemCreateGate` mints the Cosmos item so Save works (previously 404'd) |
| Publish to Fabric (create/update real item) | ✅ built | `POST /api/items/eventstream/[id]/publish` → `publishEventstream` (definition REST) |
| **Pull live topology from Fabric** | ✅ built (NEW) | `GET /api/items/eventstream/[id]/definition` → `getEventstreamDefinition`, decodes Base64 → designer |
| Node Activate/Deactivate | ⚠️ honest-gate | Disclosed via MessageBar — portal-only, not in public Fabric REST |

## Backend per control

| Control | Backend |
| --- | --- |
| Create (/new) | `POST /api/cosmos-items/eventstream` (Cosmos) |
| Save | `PUT /api/items/eventstream/[id]` → `saveItemState` (Cosmos) |
| Publish to Fabric | `publishEventstream` → `POST /v1/workspaces/{ws}/eventstreams` or `.../updateDefinition` |
| Pull from Fabric | `getEventstreamDefinition` → `POST /v1/workspaces/{ws}/eventstreams/{id}/getDefinition` |

Honest infra-gate: when the Console UAMI is not authorized in Fabric, the
publish/pull route surfaces the verbatim 401/403 + remediation hint
("enable Service principals can use Fabric APIs"; add UAMI to the workspace).

## Destination → Azure Stream Analytics output (Azure-native, no Fabric)

Per `no-fabric-dependency.md`, every Eventstream destination is materialized on
an **Azure-native** backend by default. The editor's "Push destinations to ASA"
control (and the per-kind Destination ribbon actions) map each saved sink node
to a real Azure Stream Analytics **output** via ARM PUT. After the ASA job is
started, transformed events land in the destination (rows in ADX, files in
ADLS, events in the Event Hub).

| Loom sink kind | ASA datasource type | Azure-native target | Auth (default) |
| --- | --- | --- | --- |
| `kusto` (KQL Database) | `Microsoft.Kusto/clusters/databases` | Azure Data Explorer cluster + table | MSI — ASA MI needs `AllDatabasesIngestor` on the cluster |
| `lakehouse` | `Microsoft.Storage/Blob` | ADLS Gen2 account + container + path pattern | MSI — ASA MI needs `Storage Blob Data Contributor` |
| `eventhub` | `Microsoft.EventHub/EventHub` | Azure Event Hubs namespace + hub | MSI (or SAS key) |
| `reflex` (Activator) | `Microsoft.EventHub/EventHub` | Event Hub that Activator/an Azure Monitor alert consumes | MSI (or SAS key) |
| `derivedStream` | — | In-stream fan-out only; no external output | n/a |

| Control | Backend |
| --- | --- |
| Push destinations to ASA | `POST /api/items/eventstream/[id]/asa-sync` → `createOrUpdateOutput` (ARM PUT `.../streamingjobs/{job}/outputs/{alias}`); persists `state.asaJobName` |
| Add output (ASA editor) | `PUT /api/items/stream-analytics-job/[name]/outputs` → `createOrUpdateOutput`; Delete via `DELETE …?outputName=` |
| ASA job name pre-fill | `NEXT_PUBLIC_LOOM_ASA_JOB_NAME` (admin-plane bicep) + `state.asaJobName` |

Bicep sync: `platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep`
(API `2021-10-01-preview` for MSI outputs; grants the ASA MI Storage Blob Data
Contributor on the DLZ ADLS account; documents the ADX ingestor Kusto-plane
grant for the bootstrap). Env var `NEXT_PUBLIC_LOOM_ASA_JOB_NAME` added to
`admin-plane/main.bicep`.

Honest infra-gate: when ASA env vars are unset, `asa-sync` returns 501 with the
bicep module + `LOOM_ASA_RG` hint (no mock writes). Missing destination fields
(table, storage account, namespace) return a precise 400 naming the field.
