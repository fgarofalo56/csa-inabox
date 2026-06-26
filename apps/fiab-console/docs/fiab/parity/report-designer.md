# report-designer — parity with Power BI report authoring

Source UI: Power BI Desktop / Power BI service report editor — the full authoring
surface: the **Visualizations** gallery + field **wells**, the **Fields** (Data)
pane, the **Format** pane, the **Filters** pane, dataset/**Get data** binding +
**Model view**, canvas **move/resize**, and **Publish** to a workspace.

REST / authoring grounding (Microsoft Learn):
- Visualizations in Power BI reports: <https://learn.microsoft.com/power-bi/visuals/power-bi-report-visualizations>
- Report filters (Visual / Page / Report scope): <https://learn.microsoft.com/power-bi/create-reports/power-bi-report-filters>
- Format a visual (titles, data colors, axes, legend): <https://learn.microsoft.com/power-bi/visuals/power-bi-visualization-customize-title-background-and-legend>
- Reports bind to a dataset (semantic model): <https://learn.microsoft.com/power-bi/connect-data/service-datasets-understand>
- Dataset Execute Queries REST (DAX): <https://learn.microsoft.com/rest/api/power-bi/datasets/execute-queries>
- SUMMARIZECOLUMNS (DAX): <https://learn.microsoft.com/dax/summarizecolumns-function-dax>
- Publish reports: <https://learn.microsoft.com/power-bi/create-reports/desktop-upload-desktop-files>

Surfaces:
- Designer — `lib/editors/report-designer.tsx` (ribbon + canvas + Fields tree + right-rail tabs).
- Panels — `lib/editors/report/data-source-picker.tsx`, `lib/editors/report/format-pane.tsx`, `lib/editors/report/filters-pane.tsx`, `lib/editors/report/use-canvas-layout.ts`.
- Data-source model — `lib/editors/report/report-data-source.ts` (client union), mirrored server-side in `lib/azure/report-model-resolver.ts`.
- SQL compiler — `lib/azure/wells-to-sql.ts` (`buildSqlFromVisual` + `wrapDaxWithFilters`).
- BFF routes — `app/api/items/report/[id]/{fields,query,definition,data-source,publish}/route.ts`, `app/api/items/semantic-model/scaffold/route.ts`, `app/api/thread/build-loom-report/route.ts`, `app/api/org-reports/route.ts`.

**No Fabric / Power BI workspace is required for the designer to source, render, or publish a report.** The DEFAULT data source is a Loom `semantic-model` item backed by Synapse (dedicated pool) or a lakehouse external table (serverless), queried with compiled SQL; the DEFAULT publish target is the Azure-native Organization gallery (a Cosmos snapshot). Power BI is reached only when `NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi` (+ a bound workspace) — strictly opt-in per `no-fabric-dependency.md`. Azure Analysis Services (XMLA/DAX) remains as one advanced source kind.

## Power BI feature inventory (report authoring)

| # | Capability in the Power BI report editor | Power BI behaviour |
|---|------------------------------------------|--------------------|
| 1 | Bind the report to a dataset / **Get data** | a report renders against ONE semantic model (dataset) |
| 2 | Switch / re-point the dataset | "Transform data" / change source; reports can be re-bound |
| 3 | Build a model from a SQL query / table | Get data -> SQL -> an implicit dataset is created |
| 4 | **Fields** (Data) pane | tree of tables -> columns + measures, draggable into wells |
| 5 | **Visualizations** gallery | 15+ visual types selectable by icon tile |
| 6 | Field **wells** (Axis / Legend / Values) | drop columns/measures per visual role |
| 7 | Aggregation per value field | Sum / Avg / Count / Min / Max on a column |
| 8 | bar / column / line / area / combo | category axis + value(s) + legend |
| 9 | pie / donut | legend + single value |
| 10 | card / multi-row card / KPI | scalar measure(s) |
| 11 | table / matrix | group-by columns + values (matrix: rows x cols) |
| 12 | slicer | distinct values of a field |
| 13 | **Format** pane — title | title text + show/hide |
| 14 | **Format** pane — data colors | per-series color swatches |
| 15 | **Format** pane — axes | X/Y axis show/hide |
| 16 | **Format** pane — legend | show/hide + position |
| 17 | **Format** pane — number format | General / Whole / Decimal / Percent / Currency / Thousands |
| 18 | **Filters** pane — three scopes | Filters on this visual / this page / all pages (Report) |
| 19 | **Filters** pane — operators | =, !=, >, >=, <, <=, in, contains, between |
| 20 | **Move / resize** visuals on the canvas | drag to reposition, handle to resize |
| 21 | Performance Analyzer "Copy query" | shows the generated DAX for a visual |
| 22 | **Publish** the report | upload to a workspace so colleagues can view |
| 23 | Copilot for report authoring | natural-language visual/page generation |

## Loom coverage

| # | Capability | Status | Where / how |
|---|------------|--------|-------------|
| 1 | Bind to a data source | built | "Data source" ribbon -> DataSourcePicker; persisted to state.dataSource via PUT .../data-source. Default kind = Loom semantic-model (Azure-native) |
| 2 | Switch / re-point the source | built | picker swaps between semantic-model / direct-query / aas; bound = !!dataSource replaces the old !!(aasServer && aasDatabase) gate |
| 3 | Build a model from a query/table | built | direct-query source scaffolds a real semantic-model item via POST /api/items/semantic-model/scaffold (Azure-native, NOT the Power BI /build route) |
| 4 | Fields (Data) pane | built | Fields tree from GET .../fields -> resolveReportModel (model content, query introspection, or XMLA Discover) |
| 5 | Visualizations gallery | built | VISUAL_CATALOG icon tiles, keyboard-selectable |
| 6 | Field wells (category/legend/values) | built | per-visual wells; column + measure pickers (no freeform) |
| 7 | Aggregation per value field | built | Sum/Avg/Count/Min/Max -> SQL_AGG_FN (SQL) or DAX agg; numeric columns default to Sum |
| 8 | bar / column / line / area / combo | built | category+legend -> GROUP BY, values -> AGG(col); live LoomChart SVG |
| 9 | pie / donut | built | legend + value -> grouped aggregate |
| 10 | card / multi-row card / KPI | built | card -> single-row aggregate (no GROUP BY) |
| 11 | table / matrix | built | table -> SELECT TOP N projection; grouped visuals -> GROUP BY (client pivots matrix) |
| 12 | slicer | built | SELECT DISTINCT TOP N of the category column |
| 13 | Format — title | built | FormatPane "Format" tab -> visual.config.format.titleText/showTitle |
| 14 | Format — data colors | built | Loom brand-palette swatches -> format.dataColors, applied by LoomChart |
| 15 | Format — axes | built | X/Y show-hide toggles -> format |
| 16 | Format — legend | built | legend show-hide + position -> format |
| 17 | Format — number format | built | 6 presets (General/Whole/Decimal/Percent/Currency/Thousands) -> format; formatValue() applied client-side |
| 18 | Filters — three scopes | built | FiltersPane "Filters" tab: Report / This page / Selected visual -> reportFilters / page.filters / visual.config.filters |
| 19 | Filters — operators | built | structured {field, op, value(s)}; ops eq/ne/gt/ge/lt/le/in/contains/between -> SQL WHERE/HAVING or DAX CALCULATETABLE |
| 20 | Move / resize visuals | built | useCanvasLayout: drag-reposition (x,y) + resize handle mutating w (span 2-12) / h; Move-left/right + S/M/L/XL keep accessible fallbacks; round-trips through .../definition layout |
| 21 | Copy query (the receipt) | built | /query returns the compiled sql (loom-native) or dax/daxQuery (AAS) so the generated query is inspectable |
| 22 | Publish | built | "Publish" ribbon -> dialog -> POST .../publish. Default = Azure-native Org gallery (Cosmos snapshot, surfaces in /org-reports); Power BI radio enabled only when NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi |
| 23 | Copilot for authoring | built (opt-in) | "Power BI Copilot" right-rail tab — unchanged, additive; see report-powerbi-copilot.md |
| — | Weave: build report from a model | built | Thread build-report-from-model (fromTypes:['semantic-model']) -> report opens pre-bound |
| — | Weave: build report from query/table/notebook | built | Thread build-loom-report (warehouse/synapse-dedicated-sql-pool/lakehouse/notebook) -> POST /api/thread/build-loom-report mints a Loom-native model + a bound report |

Honest gates (warning, never a stub): an unbound report returns a 412 from /fields + /query naming the exact remediation ("pick a data source", or the precise LOOM_AAS_SERVER / LOOM_SYNAPSE_WORKSPACE / LOOM_SYNAPSE_DEDICATED_POOL env var); the designer renders an EmptyState with a **Data source** CTA rather than blank visuals. Publishing an unsaved report, or Power BI selected with no workspace bound, returns a structured { ok:false, gate }. **Zero MISSING.**

## Backend per control

| Control | HTTP | Backend (real, Azure-native default) |
|---------|------|--------------------------------------|
| Data source — read | GET /api/items/report/[id]/data-source | fromLegacyState(state) (explicit state.dataSource, else synthesize {kind:'aas'} from legacy keys, else null) |
| Data source — save | PUT /api/items/report/[id]/data-source | validateDataSource (semantic-model id owner-checked; direct-query sql via readOnlySelect; aas server+db required) -> updateOwnedItem |
| Data source — pick a semantic model | GET /api/items/by-type?type=semantic-model | owned semantic-model items |
| Data source — pick a warehouse/lakehouse table | .../warehouse-tables + scaffold dryRun | catalog discovery + POST .../semantic-model/scaffold {dryRun:true} column preview |
| Direct-query -> mint reusable model | POST /api/items/semantic-model/scaffold | listColumns / SELECT TOP n introspection -> SemanticModelContent -> createOwnedItem (**no api.powerbi.com**) |
| Fields tree | GET /api/items/report/[id]/fields | resolveReportModel -> loom-native (model content / direct-query introspection) **or** aas (readModel XMLA Discover) |
| Visual render (loom-native) | POST /api/items/report/[id]/query | resolveReportModel -> buildSqlFromVisual(visual,filters,sqlSource) -> synapse-sql-client.executeQuery (dedicated pool / serverless) — real aggregated rows |
| Visual render (AAS, advanced) | POST /api/items/report/[id]/query | buildDaxFromVisual + wrapDaxWithFilters (CALCULATETABLE) -> executeAasQuery over XMLA |
| Visual render (Power BI, opt-in) | POST /api/items/report/[id]/query | body {workspaceId,datasetId,dax} -> executeDatasetQueries (executeQueries REST) — only when a workspace+dataset are bound |
| Format pane changes | (client-only) | visual.config.format; LoomChart/VisualBody restyle existing rows — no new query |
| Filters pane changes | POST .../query (recompile) | merged reportFilters + page.filters + visual.filters sent each query -> SQL WHERE/HAVING or DAX predicates |
| Save definition | PUT /api/items/report/[id]/definition | persists pages/visuals/layout + additive format + filters + reportFilters (whitelisted; deriveField/legacy field untouched for the viewer + PBIR provisioner) |
| Move / resize | PUT .../definition layout | useCanvasLayout mutates w/h/x/y already in state |
| Publish — Org gallery (default) | POST /api/items/report/[id]/publish | ReportContent + dataSource snapshot -> coe-templates Cosmos (kind:'loom-report'); read back by GET /api/org-reports (listPublishedLoomReports) |
| Publish — Power BI (opt-in) | POST .../publish {target:'powerbi'} | reuses reportProvisioner (buildReportDefinitionParts -> POST /v1/workspaces/{ws}/reports); honest gate when no workspace |
| Unpublish | DELETE /api/items/report/[id]/publish | flips the snapshot published=false (idempotent) |
| Weave: from semantic model | Thread build-report-from-model | report created with state.dataSource={kind:'semantic-model',itemId:from.id} |
| Weave: from query/table/notebook | POST /api/thread/build-loom-report | listColumns/executeQuery introspection -> Loom-native semantic-model + bound report + recordThreadEdge (**no Power BI/Fabric host**) |
| Copilot pane | (existing) | Power BI agentic Copilot — opt-in, untouched |

## Data-source model (state.dataSource)

Discriminated union (`lib/editors/report/report-data-source.ts`, mirrored in `lib/azure/report-model-resolver.ts`):

| Kind | Default? | Resolves to | Query path |
|------|----------|-------------|------------|
| semantic-model {itemId} | **DEFAULT** | the referenced Loom semantic-model item (its own state.content over a warehouse/lakehouse, or its own AAS binding) | loom-native SQL, or XMLA if the model is AAS-bound |
| direct-query {target,sql,modelItemId?} | Azure-native | a guarded single SELECT; scaffolds a real semantic-model on first save | derived-table SQL over Synapse |
| aas {server,database} | advanced | XMLA binding to Azure Analysis Services | DAX executeAasQuery |

Back-compat: when state.dataSource is absent but legacy state.aasServer exists, the resolver synthesizes {kind:'aas'} so already-saved reports keep working unchanged.

## Rules compliance

- **no-fabric-dependency.md** — DEFAULT source = Loom semantic model over Synapse/lakehouse via compiled SQL; DEFAULT publish = Azure-native Cosmos org gallery. api.powerbi.com / api.fabric.microsoft.com are reached ONLY on the opt-in path (NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi + a bound workspace). The scaffold + Weave routes never call a Power BI/Fabric host. Auto-selected Power BI with no workspace falls back to the org gallery — Fabric is never a hard gate.
- **no-vaporware.md** — real SemanticModelContent + real scaffold introspection, real executeQuery SQL aggregation, real DAX for AAS, real Cosmos publish snapshot + real /query render for the consumer view. Every unconfigured branch is an honest 412/gate naming the exact env/role/resource; no mock arrays, no return [].
- **no-freeform-config.md** — data source = pickers (semantic-model dropdown via by-type, warehouse/lakehouse table dropdowns); Format = structured controls (Input/Switch/swatches/preset Dropdowns); Filters = structured {field, op, value(s)}. The user never types DAX/JSON. The only free text is the advanced AAS XMLA URI and the direct-query SELECT (an allowed ADF/Synapse-style escape hatch, guarded by sql-guard).
- **ui-parity.md** — Format pane, Filters pane (three scopes), data-source switch, move/resize, and Publish match the Power BI authoring model one-for-one; only the theme differs.
- **web3-ui.md** — Fluent UI v9 + Loom tokens, cards/elevation, EmptyState for the unbound state, no hard-coded px/hex.
- **TypeScript** — all new types are additive; ReportContent extras are optional; the resolver returns a typed union. No new tsc errors.

## Verification

Validate with LOOM_AAS_SERVER_URL / LOOM_AAS_SERVER **UNSET**:

1. Create a warehouse -> Weave **Build report** (or build-loom-report).
2. The designer opens **pre-bound** to a scaffolded Loom semantic-model (no AAS, no Fabric).
3. Drop a category + a numeric value -> a column visual renders **real SUM rows** from Synapse (POST .../query returns { ok:true, rows, sql }).
4. Add a page filter (Filters pane) -> the same /query recompiles a parameterized WHERE.
5. **Publish** -> Organization gallery -> confirm the card appears in GET /api/org-reports (kind:'loom-report').

That receipt (endpoint + first 300 chars of the /query body + a screenshot of the rendered visual) goes in the PR per no-vaporware.md. The AAS path is a side-by-side equivalent for deployments that opt into Analysis Services; Power BI publish/render is exercised only with NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi and a bound workspace.
