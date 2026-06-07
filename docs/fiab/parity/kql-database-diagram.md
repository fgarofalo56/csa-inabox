# kql-database-diagram — parity with Fabric RTI "KQL Database schema" / ADX schema graph

Source UI:
- Microsoft Fabric Real-Time Intelligence — KQL Database item, **Database** schema view
  (entity graph of tables / materialized views / functions / shortcuts).
- Azure Data Explorer web UI (dataexplorer.azure.com) — cluster/database schema tree.
- Grounding: `.show database schema as json` —
  https://learn.microsoft.com/kusto/management/show-schema-database

Azure-native default backend: **Azure Data Explorer (ADX) cluster** via the
existing `kusto-client` (raw Kusto REST `/v1/rest/mgmt`). No Fabric / OneLake
dependency — the Diagram tab works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset;
the only requirement is `LOOM_KUSTO_CLUSTER_URI`.

## Azure/Fabric feature inventory

| Capability (real schema view) | Source UI behaviour |
|---|---|
| Tables drawn as entities with their columns + types | Fabric/ADX schema graph lists every table with ordered columns |
| Materialized views drawn as entities | shown with their source table |
| Functions drawn as entities with parameter signature | stored functions in the schema |
| Shortcuts / external tables drawn as entities | OneLake shortcut (Fabric) ≈ ADX external table (Azure-native) |
| Dependency edges: materialized-view → source table | MV depends on its base table |
| Dependency edges: function → referenced entity | function body references tables/MVs |
| Pan / zoom / fit / minimap / dot grid | standard graph canvas affordances |
| Inline entity action — query the entity | "Query table" context action |
| Inline entity action — delete the entity | "Delete" context action |
| Auto-layout | re-arrange the graph |

## Loom coverage

| Inventory row | Status | Notes |
|---|---|---|
| Tables as nodes (columns + types) | ✅ | From `.show database schema as json` → `Tables[].OrderedColumns` |
| Materialized views as nodes | ✅ | From `.show materialized-views` (reliable `Name`+`SourceTable`) |
| Functions as nodes (parameters) | ✅ | Schema-json `Functions` + `.show functions` for the signature |
| Shortcuts / external tables as nodes | ✅ | Schema-json `ExternalTables` (Azure-native parity of OneLake shortcuts) |
| MV → source-table edges | ✅ | Derived from real `SourceTable` metadata |
| Function → referenced-entity edges | ✅ | Static scan of the real function `Body` for known entity refs |
| Pan / zoom / fit / minimap / grid | ✅ | `@xyflow/react` Controls + MiniMap + Background |
| Inline "Query" action | ✅ | Loads `["Name"] | take 100` (or `fn()`) into the Query tab |
| Inline "Delete" action | ✅ | Confirm dialog → `.drop <kind> ["Name"] ifexists` via `/query` route (real ADX) |
| Auto-layout / Fit | ✅ | Panel buttons call `fitView()`; deterministic columnar layout |

Zero ❌. No stub banners. Empty database renders an honest empty-state (no fabricated nodes).

## Backend per control

| Control | Backend call |
|---|---|
| Diagram tab load | `GET /api/items/kql-database/[id]/schema-graph` → `getDatabaseSchemaJson` + `listMaterializedViews` + `listFunctions` (Kusto `/v1/rest/mgmt`) |
| Node "Query" | client-side: seeds KQL into the Query tab editor (runs via `POST /query` → `/v1/rest/query`) |
| Node "Delete" | `POST /api/items/kql-database/[id]/query` with `.drop table|materialized-view|function|external table ["Name"] ifexists` → `/v1/rest/mgmt` |
| Auto-layout / Fit | client-side React Flow `fitView()` |

## Verification (real-data E2E)

- `GET /api/items/kql-database/<id>/schema-graph` returns
  `{ ok, database, nodes:[{kind:'table'|'materialized-view'|'function'|'shortcut', …}], edges:[{type:'mv-source'|'function-ref'}], counts }`.
- Diagram tab renders one node per live entity with dependency arrows; clicking a
  node's Delete runs the `.drop` against ADX and the graph re-fetches.
- Per-cloud: behaviour is driven only by `LOOM_KUSTO_CLUSTER_URI` +
  `AZURE_AUTHORITY_HOST`; no code change per Commercial / GCC / GCC-High / IL5.
