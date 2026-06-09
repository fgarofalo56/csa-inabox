# report-visual-designer — parity with the Power BI report canvas

Source UI: Power BI Desktop / Power BI service report editor — Visualizations
gallery + Fields pane + Format pane + Filters pane.
- https://learn.microsoft.com/power-bi/visuals/power-bi-report-visualizations
- https://learn.microsoft.com/power-bi/create-reports/power-bi-report-filters
- https://learn.microsoft.com/rest/api/power-bi/datasets/execute-queries
- https://learn.microsoft.com/dax/summarizecolumns-function-dax

Surface: `lib/editors/components/report-visual-designer.tsx`, compiler
`lib/editors/dax-visual-compiler.ts`, BFF `app/api/items/report/[id]/query/route.ts`,
wired into `ReportLikeEditor` (phase3-editors.tsx) as the **Visual designer** tab.

No Fabric/Power BI workspace is required for the editor to *render* (Power BI is
opt-in per no-fabric-dependency.md). When a Power BI workspace + dataset are
bound, every control calls the real `executeQueries` REST. The query engine works
against any Power BI dataset regardless of its `loomSemanticBackend`.

## Power BI feature inventory

| Capability | Power BI behaviour |
|---|---|
| Visualizations gallery | 19+ visual types selectable by icon tile |
| bar / column | category axis + value(s) + legend |
| line / area | category axis + value(s) + legend |
| combo (line + column) | shared axis, column values + line values |
| pie / donut | legend + single value |
| card | single measure scalar |
| multi-row card | several measures, one row each |
| KPI | indicator + target + trend axis |
| table | columns (group-by) + values |
| matrix | rows + columns + values, subtotals |
| map / filled map | geographic location + size/saturation |
| scatter | X measure + Y measure + details |
| gauge | value + target arc |
| funnel | stage group + value |
| treemap | group + value + details |
| slicer | distinct values of a field |
| Fields pane | per-visual field wells; pick column/measure |
| aggregation | SUM/AVG/MIN/MAX/COUNT/DISTINCTCOUNT on a column field |
| Format pane | title, data labels, legend position, axis titles, series colors |
| Filters pane | Visual / Page / Report filters (basic IN-list) |
| query under the hood | each visual compiles to a DAX SUMMARIZECOLUMNS / ROW / VALUES query |
| Performance Analyzer "Copy query" | shows the generated DAX |

## Loom coverage

| Inventory row | Status | Notes |
|---|---|---|
| Visualizations gallery (19 types) | built | `VISUAL_CATALOG`, icon tiles, keyboard-selectable |
| bar / column / line / area | built | category+value+legend wells -> SUMMARIZECOLUMNS; live SVG chart |
| combo | built | column values + line values wells -> both in SUMMARIZECOLUMNS |
| pie / donut | built | legend + value -> SUMMARIZECOLUMNS; pie SVG |
| card | built | single measure -> EVALUATE ROW(...); scalar card |
| multi-row card | built | several measures -> one ROW; card grid |
| KPI | built | indicator + target + trend axis (scalar or trend series) |
| table | built | columns + values -> SUMMARIZECOLUMNS; raw tables TOPN-capped; grid |
| matrix | built | rows + columns group-bys -> SUMMARIZECOLUMNS; flat grid (client pivots) |
| scatter | built | X + Y measures -> SUMMARIZECOLUMNS; scatter SVG |
| gauge | built | value + target -> ROW; SVG arc with target marker |
| funnel | built | group + value -> SUMMARIZECOLUMNS; SVG funnel |
| treemap | built | group + value -> SUMMARIZECOLUMNS; SVG striped treemap |
| slicer | built | field -> EVALUATE VALUES(...) ORDER BY; distinct values |
| map / filled-map | honest-gate | query runs + returns real location aggregates (shown as grid); drawing on a basemap needs LOOM_BING_MAPS_KEY (MessageBar) |
| Fields pane wells | built | per-visual wells, column+measure pickers (no freeform) |
| aggregation picker | built | SUM/AVG/MIN/MAX/COUNT/DISTINCTCOUNT on column fields |
| Format pane | built | title, data labels, legend position, X/Y axis titles, series colors |
| Filters pane (Visual/Page/Report) | built | IN-list filters -> KEEPFILTERS(TREATAS({...}, 'T'[Col])) |
| per-visual DAX (Copy query) | built | collapsible DAX disclosure + Copy query button (the receipt) |

Zero MISSING. The single honest-gate (map basemap tiles) still executes the
location query and returns real rows.

## Backend per control

| Control | Backend |
|---|---|
| Field list (wells, filters) | GET /api/items/semantic-model/{datasetId} -> listDatasetTables (Power BI REST) |
| Visual render | POST /api/items/report/{id}/query -> executeDatasetQueries (executeQueries REST, JSON) |
| Compiled DAX | compileDaxQuery() (pure TS) -> SUMMARIZECOLUMNS / ROW / VALUES |
| Format changes | client-side only (restyle existing rows; no new query) |
| Filter changes | recompiles DAX -> new executeQueries call |

## Per-cloud

| Boundary | LOOM_POWERBI_BASE | executeQueries |
|---|---|---|
| Commercial / GCC | api.powerbi.com/v1.0/myorg | yes |
| GCC-High / IL5 | api.powerbigov.us/v1.0/myorg | yes (tenant must enable "Dataset Execute Queries REST API") |

Bicep wires LOOM_POWERBI_BASE per boundary in
platform/fiab/bicep/modules/admin-plane/main.bicep; the client also resolves it
via getPbiGovHost() when the env var is unset.

## Verification

- dax-visual-compiler.test.ts — 14 unit tests (SUMMARIZECOLUMNS, ROW, VALUES,
  TREATAS filters, TOPN cap, matrix group-by, placeholder for empty visual).
- Live receipt (per visual): the Show DAX disclosure renders the exact generated
  query; the canvas renders the executeQueries rows.
