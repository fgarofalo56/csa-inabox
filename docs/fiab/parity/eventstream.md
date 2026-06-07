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
| Per-node config edit | ✅ built | inline inspector forms (no raw JSON required) |
| JSON view (advanced) | ✅ built | Monaco JSON editor, two-way synced with the canvas |
| Save topology (Cosmos) | ✅ built | `PUT /api/items/eventstream/[id]` → Cosmos state (now persists multi `sources`/`sinks` arrays too) |
| **Create on /new** | ✅ built (NEW) | `NewItemCreateGate` mints the Cosmos item so Save works (previously 404'd) |
| **Provision to Azure (canvas → real EH + ASA)** | ✅ built (NEW) | `POST /api/items/eventstream/[id]/provision` — Azure-native DEFAULT, no Fabric. source→transform→destination maps to a real Event Hub (transport) + Stream Analytics job (transform). Receipt = ARM resource IDs for both. |
| Publish to Fabric (create/update real item) | ✅ built | `POST /api/items/eventstream/[id]/publish` → `publishEventstream` (definition REST) — opt-in Fabric backend |
| **Pull live topology from Fabric** | ✅ built (NEW) | `GET /api/items/eventstream/[id]/definition` → `getEventstreamDefinition`, decodes Base64 → designer |
| Node Activate/Deactivate | ⚠️ honest-gate | ASA path: start/stop in the Stream Analytics editor. Fabric path: portal-only toggle, not in public Fabric REST |

## Backend per control

| Control | Backend |
| --- | --- |
| Create (/new) | `POST /api/cosmos-items/eventstream` (Cosmos) |
| Save | `PUT /api/items/eventstream/[id]` → `saveItemState` (Cosmos) |
| **Provision to Azure** | `POST /api/items/eventstream/[id]/provision` → `eventhubs-client` (`createEventHub`, `createConsumerGroup`, `listNamespaceKeys`) + `stream-analytics-client` (`createOrUpdateJob`, `createOrUpdateInput`, `createOrUpdateOutput`, `saveTransformation`). SAQL is compiled from the canvas transform nodes (filter → WHERE; aggregate/group-by → windowed GROUP BY). |
| Publish to Fabric (opt-in) | `publishEventstream` → `POST /v1/workspaces/{ws}/eventstreams` or `.../updateDefinition` |
| Pull from Fabric | `getEventstreamDefinition` → `POST /v1/workspaces/{ws}/eventstreams/{id}/getDefinition` |

Azure-native default (no Fabric required): the "Provision to Azure" action is
the DEFAULT realization path per `.claude/rules/no-fabric-dependency.md`. Honest
Azure infra-gates: Event Hubs namespace unset → 503 naming `LOOM_EVENTHUB_NAMESPACE`;
Stream Analytics unset → `partial:true` with the Event Hub still provisioned and
a hint naming `LOOM_ASA_RG`; DoD/IL5 regions (no ASA) → `partial:true` disclosing
the transform must run on an alternative processor. Bicep:
`platform/fiab/bicep/modules/landing-zone/eventhubs.bicep` (namespace + UAMI
Contributor/Data Owner) and `stream-analytics.bicep` (UAMI Stream Analytics
Contributor on the RG); new env `LOOM_ASA_LOCATION` wired in `admin-plane/main.bicep`.

Honest infra-gate (Fabric path): when the Console UAMI is not authorized in
Fabric, the publish/pull route surfaces the verbatim 401/403 + remediation hint
("enable Service principals can use Fabric APIs"; add UAMI to the workspace).
