# cosmos-db-gremlin-explorer — parity with Azure Cosmos DB for Apache Gremlin (Data Explorer → Graph)

Source UI: Azure portal → Cosmos DB (Gremlin) account → Data Explorer → Graph ·
https://learn.microsoft.com/azure/cosmos-db/gremlin/overview ·
https://learn.microsoft.com/azure/cosmos-db/gremlin/how-to-write-queries

This is the Gremlin graph explorer embedded as the **Graph explorer** tab of the
Cosmos account editor (`cosmos-account-editor.tsx`), backed by the dedicated
`GremlinGraphCanvas` component — a richer surface than the standalone
`cosmos-gremlin-graph` item editor (it adds zoom/pan, add-vertex/edge dialogs,
edge inspection, and a JSON toggle).

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | Gremlin query editor (free-text traversal, syntax highlight) | Data Explorer query bar |
| 2 | Run / Execute traversal | Execute Gremlin button |
| 3 | Force-directed graph visualization (node-link diagram) | Graph pane |
| 4 | Zoom + pan the canvas | Graph pane (mouse wheel + drag) |
| 5 | Click a vertex → inspect id + properties | Graph pane node detail |
| 6 | Click an edge → inspect label + endpoints | Graph pane edge detail |
| 7 | New vertex (`g.addV`) with label + properties | "New Vertex" form |
| 8 | New edge (`g.addE…to`) between two vertex ids | "New Edge" form |
| 9 | Quick `g.V().limit(25)` browse | Data Explorer presets |
| 10 | Result toggle: graph view ↔ raw JSON (GraphSON) | Graph / JSON tabs |
| 11 | Endpoint / database / graph binding | account connection |
| 12 | Honest gate when account is not Gremlin-enabled | n/a (Azure rejects) |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | `MonacoTextarea` language=`javascript`, seed `g.V().limit(25)` |
| 2 | ✅ built | Run → POST `/api/items/cosmos-db/[id]/gremlin` → `executeGremlin()` |
| 3 | ✅ built | In-component Fruchterman-Reingold layout, themed SVG nodes/edges |
| 4 | ✅ built | `onWheel` scales (0.2–4×); pointer-drag pans via `<g transform>` + zoom in/out/reset buttons |
| 5 | ✅ built | Click vertex → side panel: id + flattened Cosmos properties (`{value}` unwrapped) |
| 6 | ✅ built | Click edge → side panel: label + from/to vertex ids; edge label drawn at midpoint |
| 7 | ✅ built | "Add vertex" dialog: label + `/pk` + dynamic key/value property rows → `g.addV(...).property(...)`, then re-query `g.V().limit(25)` to confirm persistence |
| 8 | ✅ built | "Add edge" dialog (also reachable from a selected vertex): from/label/to → `g.V('from').addE('label').to(g.V('to'))`, then re-query |
| 9 | ✅ built | `g.V().limit(25)` toolbar button + on-mount initial run |
| 10 | ✅ built | "Results as JSON" `Switch` swaps the canvas for the raw `{ ok, rows, rowCount, executionMs, truncated }` response |
| 11 | ⚠️ honest-gate | Endpoint is server-bound (`LOOM_COSMOS_GREMLIN_ENDPOINT`); read-only chip in the panel header (editing a fake endpoint is forbidden by no-vaporware) |
| 12 | ⚠️ honest-gate | BFF checks ARM `capabilities` for `EnableGremlin`; a non-Gremlin account returns 422 `gate:'not_gremlin_account'`, rendered as a warning MessageBar naming the bicep module + env var to set |

Zero ❌, zero stub banners. The only non-functional states are honest infra
gates (rows 11–12), and the full UI surface still renders in both.

## Backend per control
- Run / quick `g.V()` / `addV` / `addE` → `POST /api/items/cosmos-db/[id]/gremlin`
  → `executeGremlin()` (gremlin TinkerPop npm + AAD `ChainedTokenCredential` /
  `LOOM_COSMOS_GREMLIN_KEY`). Returns the raw GraphSON rows.
- Capability gate → `getAccountInfo()` (ARM `Microsoft.DocumentDB/databaseAccounts`
  GET, `properties.capabilities`). Missing `EnableGremlin` → 422.
- Runtime gate → `executeGremlin()` raises `GremlinError(503)` naming
  `LOOM_COSMOS_GREMLIN_ENDPOINT` / `LOOM_COSMOS_GREMLIN_KEY` / Cosmos DB Built-in
  Data Contributor role when the endpoint or npm driver isn't wired.
- Graph mapping → client-side `extractGraph()` recognises GraphSON vertex/edge
  shapes; per-vertex properties flattened from `{ key: [{ value }] }`.

## Sovereign-cloud notes
- Gremlin host suffix is sovereign-aware via `gremlinSuffix()` in
  `cloud-endpoints.ts`: Commercial / GCC → `gremlin.cosmos.azure.com`;
  GCC-High / IL5 / DoD → `gremlin.cosmos.azure.us`. Mirrored in the bicep
  `gremlinEndpoint` output (boundary-conditioned). Asserted by
  `cloud-matrix.test.ts` (Commercial + Gov + DoD rows).
- 100% Azure-native — no Fabric / Power BI dependency anywhere on this path
  (per no-fabric-dependency.md).

## Bicep sync
- `platform/fiab/bicep/modules/landing-zone/cosmos-graph-vector.bicep` provisions
  the dedicated `EnableGremlin` account + `loom-graph` database + `default` graph
  + Console UAMI Cosmos DB Built-in Data Contributor grant. Now takes a
  `boundary` param so the `gremlinEndpoint` output uses the correct
  `.azure.us` suffix in Gov.
- `admin-plane/main.bicep` already wires `LOOM_COSMOS_GREMLIN_ENDPOINT` /
  `_DATABASE` / `_GRAPH` + `NEXT_PUBLIC_LOOM_COSMOS_GREMLIN_ENDPOINT` onto the
  Console Container App from those outputs.
