# dashboard-tiles — parity with Power BI dashboards + Fabric Real-Time dashboard tiles

Source UI:
- Power BI dashboards (pin a visual, Q&A, streaming tiles):
  https://learn.microsoft.com/power-bi/create-reports/service-dashboards
- Pin a tile / Q&A tile: https://learn.microsoft.com/power-bi/create-reports/service-dashboard-pin-tile-from-q-and-a
- Real-time streaming tile: https://learn.microsoft.com/power-bi/connect-data/service-real-time-streaming
- Tiles - Clone Tile (REST): https://learn.microsoft.com/rest/api/power-bi/dashboards/clone-tile-in-group
- Datasets - Execute Queries (DAX, REST): https://learn.microsoft.com/rest/api/power-bi/datasets/execute-queries
- Azure Analysis Services XMLA / connect: https://learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-connect

## Azure / Fabric feature inventory (every capability)

| # | Capability (Power BI dashboard) | Notes |
|---|----------------------------------|-------|
| 1 | View a dashboard as a grid of tiles | 12-col responsive grid |
| 2 | Pin a visual from a report to a dashboard → tile | authoring in PBI Web |
| 3 | Pin/clone an existing tile to another dashboard | REST Clone Tile |
| 4 | Q&A tile — natural-language question answered over the model | NL → DAX |
| 5 | Streaming / real-time tile (push/streaming dataset) refreshing live | live data |
| 6 | Tile drill — click a tile to open the underlying report | drill-through |
| 7 | Tile fullscreen / focus mode | per-tile maximize |
| 8 | Re-arrange tiles (drag) + resize, save layout | grid persistence |
| 9 | Mobile layout (single column) | responsive |
| 10 | Refresh tiles / dashboard | manual + auto |
| 11 | Open dashboard in Power BI Web | external authoring |

## Loom coverage

| # | Capability | Status | How |
|---|-----------|--------|-----|
| 1 | Tile grid | ✅ built | `DashboardEditor` "Tiles" tab — CSS `grid` 12 cols, `gridColumn: span w` |
| 2 | Pin a visual from a report | ⚠️ honest-gate | New-pin happens in PBI Web (REST has no "pin arbitrary visual" verb); `PinTileDialog` MessageBar + "Open in Power BI" CTA, then Refresh |
| 3 | Pin/clone an existing tile | ✅ built | `PinTileDialog` → `POST .../[id]/pin` → `cloneDashboardTile` (REST Clone Tile) |
| 4 | Q&A tile (Copilot → DAX) | ✅ built | `QaTileDialog` → `POST .../tile-query` `{kind:'dax', nlPrompt}` → AOAI generates DAX → executes; editable DAX + visual picker |
| 5 | Streaming tile | ✅ built | `StreamingTileDialog` → ADX/KQL query → `tile-query` `{kind:'streaming-adx'}`; client `setInterval` auto-refresh (5–300 s) |
| 6 | Tile drill | ✅ built | pinned PBI tile header "drill to report"; Loom tiles use `TileVisual` drill-through to report params |
| 7 | Fullscreen | ✅ built | `ArrowMaximize` per tile → `Dialog` (92vw) `LoomTileBody large` |
| 8 | Re-arrange + save layout | ✅ built | `layout` map + "Auto-arrange"; "Save layout" → `PUT .../[id]` → Cosmos `pbi-dashboard-overlays` |
| 9 | Mobile single-column | ✅ built | `narrow` (window < 720px) → `gridTemplateColumns: 1fr`, every tile spans full width |
| 10 | Refresh | ✅ built | ribbon Refresh + per-tile Refresh; streaming auto-refresh |
| 11 | Open in Power BI | ✅ built | ribbon "Open in Power BI" → `webUrl` |

Zero ❌. The only non-built row (#2 new-pin) is an honest gate, not a stub — the
full surface renders and the documented external action is surfaced with a CTA.

## Backend per control

| Control | Backend / data-plane |
|---------|----------------------|
| Tile grid + layout persistence | Cosmos `pbi-dashboard-overlays` (`/itemId`) via `GET`/`PUT`/`DELETE /api/items/dashboard/[id]` |
| Clone tile (pin) | Power BI REST `POST /groups/{ws}/dashboards/{src}/tiles/{tile}/Clone` (`cloneDashboardTile`) via `/api/items/dashboard/[id]/pin` |
| Q&A NL→DAX | Azure OpenAI chat-completions (`resolveAoaiTarget`, `cognitiveservices.azure.com`/`.azure.us`) via `/api/items/dashboard/[id]/tile-query` |
| DAX execution (default Azure-native) | Azure Analysis Services XMLA (`*.asazure.windows.net` / `*.asazure.usgovcloudapi.net`) — `executeDax`, when `LOOM_SEMANTIC_BACKEND=analysis-services` |
| DAX execution (opt-in Fabric-family) | Power BI REST `POST /groups/{ws}/datasets/{id}/executeQueries` (`executeDatasetQueries`) |
| Streaming tile | Azure Data Explorer Kusto `POST /v1/rest/query` (`executeQuery`, `kusto.windows.net`/`.usgovcloudapi.net`) |
| Single-tile embed | Power BI REST `POST /groups/{ws}/dashboards/{id}/tiles/{tile}/GenerateToken` via `/api/items/dashboard/[id]/tile-embed-token` |
| Full dashboard embed | Power BI REST GenerateToken via `/api/items/dashboard/[id]/embed-token` |

## no-fabric-dependency.md compliance

The **Azure-native default** dashboard surface — streaming (ADX) tiles, the
Loom-native tile grid, layout persistence, fullscreen, drill, mobile layout, and
(with `LOOM_SEMANTIC_BACKEND=analysis-services`) Q&A/DAX tiles on Azure Analysis
Services — works with **`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET and no Power BI
workspace bound**. The overlay loads by the Loom item id, not by a PBI dashboard.
Power BI embed + Clone-tile + Power BI `executeQueries` are the **opt-in**
Fabric-family path, reached only when the user explicitly selects a Power BI
workspace. No Fabric host (`api.fabric.microsoft.com`, `onelake.dfs.fabric`) is
contacted on any path.

## Cloud matrix

| Feature | Commercial | GCC | GCC-High / IL5 | DoD |
|---------|-----------|-----|----------------|-----|
| Streaming (ADX/KQL) | `kusto.windows.net` | same | `kusto.usgovcloudapi.net` | same gov suffix |
| Q&A NL→DAX (AOAI) | `cognitiveservices.azure.com` | same | `cognitiveservices.azure.us` | honest gate (no Azure OpenAI in DoD) |
| DAX via AAS (default) | `asazure.windows.net` | `asazure.windows.net` | `asazure.usgovcloudapi.net` | `asazure.usgovcloudapi.net` |
| DAX via Power BI (opt-in) | `api.powerbi.com` | `api.powerbi.com` | honest gate (PBI US Gov executeQueries gap → use ADX/AAS) | gate |
| Clone tile / embed | `api.powerbi.com` | same | `api.powerbigov.us` | gate |
| Layout persist (Cosmos) | `documents.azure.com` | same | `documents.azure.us` | `documents.azure.us` |

## Bootstrap (one-time, when using the AAS DAX backend)

1. Deploy an Azure Analysis Services server + tabular model.
2. Set `loomAasServer` (= `<region>.<aasSuffix>/<server>`) + `loomAasModel` +
   `loomSemanticBackend=analysis-services` in the bicep params.
3. Add the Console UAMI as an AAS server administrator:
   `az ams server admin add --resource-group <rg> --name <server> --object-id <uami-principal-id>`.
   (Surfaced verbatim in the `aasConfigGate` MessageBar.)

## Verification

- `pnpm vitest run lib/azure/__tests__/dashboard-tiles.test.ts` (13 tests: overlay
  sanitize/clamp whitelist, AAS XMLA URL build, XMLA rowset parse + fault, AAS
  suffix/scope cloud split).
- Live walk: pin a cloned tile + add a Q&A tile + add a streaming tile → all render
  real data; Save layout → Cosmos `pbi-dashboard-overlays` doc written; reload →
  tiles re-hydrate at saved positions.
