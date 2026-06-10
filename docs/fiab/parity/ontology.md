# ontology — parity with Fabric IQ Ontology / digital twin builder semantic canvas

Source UI: Fabric IQ → Ontology (preview) + digital twin builder semantic canvas ·
https://learn.microsoft.com/fabric/iq/ontology/overview ·
https://learn.microsoft.com/fabric/real-time-intelligence/digital-twin-builder/concept-semantic-canvas

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | Create entity types | semantic canvas |
| 2 | Create relationship types (incl. IS_A hierarchy) | semantic canvas |
| 3 | Class/entity hierarchy view | canvas tree |
| 4 | Graph visualization of the ontology | semantic canvas (node-link) |
| 5 | Property/description authoring | entity detail |
| 6 | Materialize / project to graph / Eventhouse | project to KQL |
| 7 | Save | save |
| 8 | Bind entity types to physical data (Lakehouse/Warehouse tables) | semantic canvas → data binding |
| 9 | Activator triggers on entity changes | Fabric Activator on ontology events |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | Add entity dialog (name, parent, description) appends to the ontology DSL |
| 2 | ✅ built | Add relationship dialog sets the IS_A parent in place |
| 3 | ✅ built | parsed class `Tree` (right panel) |
| 4 | ✅ built | `OntologyHierarchyViz` → `ForceDirectedGraph` of class → parent IS_A edges |
| 5 | ✅ built | description carried through the DSL + dialog |
| 6 | ✅ built | Materialize → creates a graph-model item (node per class, IS_A edge) which then ADX-materializes |
| 7 | ✅ built | SaveBar + Ctrl+S → Cosmos item state |
| 8 | ✅ built | "Bind to data source" dialog (Lakehouse/Warehouse picker + multi-select entity types); bindings persist on `state.entityBindings[]` and render as removable badges |
| 9 | ✅ built | "Activator triggers" panel → creates a real Azure Monitor scheduledQueryRule that fires on INSERT/UPDATE/DELETE of a bound entity type (no Fabric required) |

## Backend per control
- Save / Add → PATCH `/api/items/ontology/[id]` (Cosmos), eager-save for existing items.
- Materialize → `POST /api/items/graph-model` creating a derived graph-model; that item's `/materialize` pushes real ADX tables.
- Parsing + viz: client-side `parseOntologyHierarchy` (vitest-covered).
- Entity binding → `GET/POST /api/items/ontology/[id]/bind` (Cosmos): lists Lakehouse/Warehouse items in the ontology's workspace (workspaceId resolved server-side) and persists the binding onto `state.entityBindings[]`. Azure-native; no `api.fabric` host.
- Activator triggers → `GET/POST /api/items/ontology/[id]/activator`: lazily creates a backing Cosmos `activator` item, then a real `Microsoft.Insights/scheduledQueryRule` via `createMonitorActivatorRule` over the Log Analytics workspace. The KQL (`buildEntityChangeQuery`, vitest-covered) targets `LOOM_ACTIVATOR_DEFAULT_TABLE` (default `AppEvents_CL`) and fires on entity write operations. Honest Azure infra-gate (set `LOOM_LOG_ANALYTICS_RESOURCE_ID` / `LOOM_ALERT_RG`, grant Monitoring Contributor) when Monitor is unconfigured — never a Fabric gate.

## Per-cloud matrix
| Feature | Commercial | GCC | GCC-High | IL5 |
|---------|-----------|-----|----------|-----|
| Entity binding (Cosmos only) | ✅ | ✅ | ✅ | ✅ |
| Activator trigger (Azure Monitor scheduledQueryRule) | ✅ | ✅ | ✅ (`management.usgovcloudapi.net`) | ✅ |
| Fabric Activator opt-in (`LOOM_ACTIVATOR_BACKEND=fabric`) | ✅ when set | ✅ when set | ❌ not authorized — Azure Monitor only | ❌ Azure Monitor only |
