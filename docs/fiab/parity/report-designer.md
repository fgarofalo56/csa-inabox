# report-designer — parity with Power BI report authoring (Desktop + service)

Source UI: Power BI Desktop / Power BI service **report editor** — the
Visualizations pane (visual-type gallery + field wells + Format + Analytics
panes), the canvas/page model, visual interactions, the Filters pane, and the
authoring panes/export. Grounded in Microsoft Learn:

- https://learn.microsoft.com/power-bi/visuals/power-bi-visualizations-overview
- https://learn.microsoft.com/power-bi/create-reports/service-the-report-editor-take-a-tour
- https://learn.microsoft.com/power-bi/transform-model/desktop-analytics-pane
- https://learn.microsoft.com/power-bi/create-reports/service-reports-visual-interactions
- https://learn.microsoft.com/power-bi/create-reports/power-bi-report-display-settings
- https://learn.microsoft.com/power-bi/create-reports/power-bi-report-filter
- https://learn.microsoft.com/power-bi/create-reports/power-bi-report-filter-types
- https://learn.microsoft.com/power-bi/create-reports/desktop-bookmarks
- https://learn.microsoft.com/power-bi/create-reports/desktop-report-themes
- https://learn.microsoft.com/power-bi/create-reports/end-user-export-to-pdf

Loom surface + backend (the **authoring** designer — distinct from the
read-only report viewer and the report-visual-designer Power-BI canvas):

| Layer | File |
|---|---|
| Designer (canvas, ribbon, right-rail) | apps/fiab-console/lib/editors/report-designer.tsx |
| Format pane | apps/fiab-console/lib/editors/report/format-pane.tsx |
| Chart renderer | apps/fiab-console/lib/components/charts/loom-chart.tsx |
| Wells to SQL compiler | apps/fiab-console/lib/azure/wells-to-sql.ts |
| Wells to DAX compiler (AAS mirror) | apps/fiab-console/lib/azure/aas-dax.ts |
| Query route (3 backends) | apps/fiab-console/app/api/items/report/[id]/query/route.ts |
| Persist whole definition | apps/fiab-console/app/api/items/report/[id]/definition/route.ts |
| Data-source binding | apps/fiab-console/lib/editors/report/data-source-picker.tsx + .../data-source/route.ts |
| Canvas layout / page model | apps/fiab-console/lib/editors/report/use-canvas-layout.ts |
| Analytics pane (reference lines + Wave-2 error-bars/forecast/symmetry + **Wave-5 anomalies / X-lines / shaded ranges**) | apps/fiab-console/lib/editors/report/analytics-pane.tsx |
| Bookmarks pane (**NEW** Wave 2 — right-rail tab) | apps/fiab-console/lib/editors/report/bookmarks-pane.tsx |
| Selection pane (**NEW** Wave 2 — right-rail tab) | apps/fiab-console/lib/editors/report/selection-pane.tsx |
| AI visuals (**Wave 3** — decomposition tree / key influencers / Q&A / smart narrative) | apps/fiab-console/lib/editors/report/ai-visuals/*.tsx |
| Azure-Maps visual (**NEW** Wave 5) | apps/fiab-console/lib/editors/report/map-visual.tsx |
| Azure-Maps token broker (**NEW** Wave-5 route — the **only** new route Wave 5 adds) | apps/fiab-console/app/api/items/report/[id]/map-token/route.ts |
| Azure-Maps backend resolver (server) | apps/fiab-console/lib/azure/maps-client.ts |
| Azure Maps account (**NEW** Wave-5 bicep) | platform/fiab/bicep/modules/landing-zone/azure-maps.bicep |

## Backend selection (no-fabric-dependency.md)

The designer renders REAL aggregated rows with **no Power BI / Fabric / OneLake
workspace and LOOM_DEFAULT_FABRIC_WORKSPACE UNSET**. `POST .../query` dispatches
three backends; the **default** is path 3:

| # | Backend | When | Compiler to engine |
|---|---|---|---|
| 3 | **Loom-native SQL (DEFAULT)** | any Loom semantic-model / direct-query source | buildSqlFromVisual (wells-to-sql.ts) compiles a parameterized SELECT ... GROUP BY run by synapse-sql-client.executeQuery (dedicated pool for a warehouse source, serverless over a lakehouse) |
| 2 | Azure Analysis Services (advanced) | report bound to an AAS tabular model | buildDaxFromVisual + wrapDaxWithFilters (CALCULATETABLE) run by executeAasQuery (XMLA) |
| 1 | Power BI executeQueries (opt-in) | NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi + bound workspace/dataset | executeDatasetQueries (Power BI REST) |

api.powerbi.com / onelake.dfs.fabric are never reached on the default path (grep
gate clean). Every identifier is whitelisted from the resolved model and
bracket-quoted; every value binds as a TDS parameter (injection-safe).

## Legend (status + wave)

This doc tracks the report-designer parity **program**. The **Status** symbol is
the parity grade; the **Wave** column states which wave delivers it. Nothing is
claimed live that is not.

- **OK shipped** — built and live in the current designer (verified in the files
  above today).
- **OK Wave 1** — the committed Wave-1 build: an Azure-native parity gap that
  needs **no new backend route** (renders real rows through the existing /query +
  wells-to-sql path; Format / Analytics / conditional / interactions apply
  client-side in LoomChart; everything persists through /definition). The row
  names the file + mechanism. Until merged, the visual falls back to the shipped
  7-type LoomChart / table render — never a dead control.
- **OK Wave 2** — the committed Wave-2 build, extending Wave 1. Same constraint:
  **no new BFF route**. Wave 2 adds (a) canvas selection + layout ops
  (multi-select, group / ungroup, lock, match-size, z-order, undo / redo) in
  use-canvas-layout.ts — **align / distribute math also lives here but is NOT
  wired to the canvas (deferred to Wave 3, see §5)**; (b) client-side LoomChart render for the bubble-size
  radius scale, the play-axis frame loop, and the error-bar / forecast /
  symmetry-shading analytics overlays; (c) target-page **drillthrough** reusing
  the shipped applyFilters engine (navigate + seed filters) + **report-page
  tooltip authoring** (the hover-popover render is deferred to Wave 3); (d) the Filters-pane Apply (deferred) button
  + pane formatting + drillthrough scope; (e) the NEW **Bookmarks** and
  **Selection** right-rail panes. Every new shape persists through the existing
  PUT /definition as an **additive, sanitizer-whitelisted** key — the read-only
  viewer and the PBIR provisioner ignore unknowns, so waves 0-1 do not regress.
- **OK Wave 3** — the committed Wave-3 build: the **AI visuals** (decomposition
  tree, key influencers, Q&A, smart narrative) render through
  `lib/editors/report/ai-visuals/*.tsx` over the same Path-3 result rows, with an
  Azure OpenAI / ADX honest-gate (`LOOM_AOAI_*` / `LOOM_ADX_CLUSTER`) when those
  back-ends are unbound — the full visual surface still renders.
- **OK Wave 4** — the committed Wave-4 build: the R / Python **script visuals**,
  backed by a REAL Azure-native sandboxed executor (the `loom-script-runner` ACA
  app) reached through the program's **first new BFF route** (`/script-visual`).
  Unlike waves 1-2 (zero new routes), the script visual needs a real script
  runtime no fold can provide, so this wave adds exactly one route + one ACA
  executor behind an honest `LOOM_SCRIPT_RUNNER_URL` gate, while still reusing
  /query Path-3 verbatim for its data. See **Follow-on Wave 4** for the executor,
  the sandbox threat model, the bicep sync, and the least-privilege-UAMI caveat.
- **OK Wave 5** — the committed Wave-5 build: **true chart geometry** in
  loom-chart.tsx renders REAL geometry from the SAME /query rows (no new route
  except the Azure-Maps token broker), retiring every `APPROX_GEOMETRY` caption as
  its geometry lands. It delivers (a) real stacked / 100%-stacked / stacked-area,
  dual-axis **combo** (line + clustered/stacked column), **ribbon** rank-connectors,
  running-total **waterfall** with a Total bar, **funnel**, squarified **treemap**
  (with a Details sub-partition), radial **gauge** arc + target needle, and **KPI**
  indicator + sparkline + goal delta — all dependency-free SVG over the existing
  parseRows scales (new LoomChart props are optional + default-off, so the
  read-only LoomVisual viewer + waves 0-4 render byte-identical); (b) real
  **Small-multiples trellis** tiling + treemap **Details** sub-grouping via a
  **1-line additive 2nd GROUP BY** in wells-to-sql.ts (read through a narrow local
  cast — no aas-dax.ts edit, no new tsc error) and **Tooltips** surfaced in a new
  **hover popover** (plotted-EXCLUDED, hover-only); (c) a real **multi-style
  slicer** (list / dropdown / between / relative-date) that emits a `ReportFilter`
  into the EXISTING applyFilters engine (no engine change); (d) a real
  **Azure-Maps visual** (bubble + filled/choropleth) behind an honest
  `LOOM_MAPS_BACKEND` gate, with the new `/map-token` broker + `azure-maps.bicep`;
  and (e) **anomaly** (client rolling-mean / z-score, ADX `series_decompose_anomalies`
  opt-in), **X-axis constant lines**, and **shaded ranges** analytics. Every prop
  is additive + default-off so waves 0-4 and the free-form canvas do not regress.
- **GATE** — honest infra-gate: the full UI renders and the query still runs, but
  a styled Fluent MessageBar intent="warning" names the exact env var / resource
  to provision (per no-vaporware.md).
- **MISSING Wave N** — not built; a follow-on wave (2/3/4/5) owns it, with the plan
  + exact files in **Follow-on waves** below. No MISSING exists without a wave +
  plan, and there are **zero disabled "coming soon"** controls (A-grade gate).

Wave-1 key mechanism: the designer queryVisual() **folds the rendered additive
wells into the existing category / values / legend arrays** that /query +
buildSqlFromVisual already compile — secondary-values / target / min / max become
extra value aggregates. So each visual returns REAL aggregated SQL rows. **No new
BFF route.** Two well families were intentionally **NOT** folded in waves 1-2 —
**Tooltips** (hover-only in Power BI; folding them draws extra plotted series) and
**Small multiples / treemap Details** (a 2nd GROUP BY column LoomChart could not
yet tile). **Wave 5 lands both:** buildSqlFromVisual now appends the trellis
group columns as a **1-line additive 2nd GROUP BY** (read via a narrow local cast,
no aas-dax.ts edit) so result order stays `category…, legend…, smallMultiples…,
details…, <aggregates…>` — parseRows still picks category[0] as the axis and the
renderer pulls the facet by its known alias; Tooltips ride as plotted-EXCLUDED
aggregates surfaced in the new **hover popover**. Likewise the distinctive PBI
**chart geometry** for stacked / combo / ribbon / waterfall / funnel / treemap /
gauge / KPI was a deferred build that **Wave 5 delivers as REAL geometry** in
loom-chart.tsx — every former `APPROX_GEOMETRY` closest-shape render is retired
as its true geometry lands (no silent wrong-geometry — the geometry is now real).

### Wave-2 model additions (additive + sanitized through /definition)

Wave 2 introduces structured state that the persistence route's sanitizers
whitelist; the read-only viewer + PBIR provisioner ignore every unknown key, so
waves 0-1 round-trip unchanged. No control accepts typed DAX/JSON — all are
pickers (no-freeform-config.md).

- **DVisual** gains `hidden?: boolean` (Selection pane eye-toggle), `z?: number`
  (z-order), `locked?: boolean` (lock), `groupId?: string` (group / ungroup);
  `x?`/`y?` are already honored by use-canvas-layout packing.
- **DPage.config** gains `drillthrough?: { fields: WellFieldRef[] }` (the
  target-page Drillthrough-filters well) and
  `tooltipPage?: { enabled: boolean; boundField?: WellFieldRef }` (alongside the
  already-present `canvasType: 'tooltip'`).
- **Report state** gains `state.content.bookmarks: ReportBookmark[]` (page +
  filters + selection/visibility + slicer state + sort, with Data / Display /
  Current-page restore toggles) and
  `state.content.filterPaneFormat: FilterPaneFormat` (pane colors + the Apply
  button).
- **Visual types / wells:** a new `map` visual type, a `bubble` (scatter + size)
  variant, and `size` / `playAxis` entries in EXTRA_WELL_NAMES. `map` renders an
  HONEST Azure-Maps gate (not a dead control).
- **Analytics model** gains `error-bar`, `forecast`, and `symmetry-shading`
  entries beside the existing reference lines.
- **Reload round-trip (GET):** the read path
  (`app/api/items/_lib/pbi-content-fallback.ts` →
  `reportDetailFromContent` / `reportPagesFromContent`, served by
  `report/[id]` + `report/[id]/pages`) now surfaces this persisted state back to
  the designer's `loadDetail`: report-level `bookmarks` / `reportFilters` /
  `filterPaneFormat`, and per-page `filters` + canvas `config` (type / size /
  background / hidden / interactions matrix / drillthrough + tooltip target). Each
  is emitted only when persisted, so bookmarks, report- and page-scope filters,
  page background/canvas type, the visual-interactions matrix, and the
  drillthrough/tooltip targets all SURVIVE a reload instead of resetting.

Undo / redo snapshots only the in-memory pages / reportFilters / bookmarks state
— it never re-queries, because `w`/`h`/`x`/`y`/`hidden`/`z` are not part of the
visual query signature (queryVisual() still folds only PLOTTED wells).

### Wave-5 additions (true geometry + slicer + maps + analytics)

Wave 5 owns **report-designer.tsx** and the geometry it routes; every change is
additive + default-off so the read-only viewer, the PBIR provisioner, and waves
0-4 round-trip byte-identical. The other report/* files (data-source-picker,
report-data-source, resolver, storage-mode-pane, transform-data, semantic-model)
are W1-W4 and are **untouched** by this wave.

- **LoomChart geometry props (loom-chart.tsx, all OPTIONAL / default-off):**
  `stackMode` ('none' | 'stacked' | 'stacked100'); the new chart types
  `stackedColumn|stackedBar|stackedArea|combo|ribbon|waterfall|funnel|treemap|gauge|kpi`;
  `comboLineSeries` (secondary-axis line aliases); `target` / `gaugeMin` /
  `gaugeMax` (gauge); `kpiTrend` / `kpiGoal` / `kpiTarget` (KPI);
  `smallMultiples:{ facetColumn, columns?, sharedY? }` (trellis splitter);
  `tooltips` (plotted-EXCLUDED hover-only series); `detailColumn` (treemap nested
  partition); `refLines[].orientation:'h'|'v'` (X-axis constant lines);
  `anomalies:{ points, band?, color }`; `shadedRanges:{ from,to,axis,color }[]`.
  All ride the existing parseRows scales as pure dependency-free SVG; a new
  **HoverPopover** (React-state overlay) replaces the bare `<title>` as the
  primary affordance (a `<title>` stays for a11y / no-JS).
- **Registry (report-designer.tsx):** `CHART_RENDER` is now true-geometry
  (`combo:'combo'`, `ribbon:'ribbon'`, `waterfall:'waterfall'`, `funnel:'funnel'`,
  `treemap:'treemap'` beside bar/column/line/area/pie/donut/scatter);
  `APPROX_GEOMETRY` is emptied entry-by-entry to `{}`; `KPI_TYPES` shrinks to
  `new Set(['card'])` and a new `GAUGE_KPI` routes gauge → `<LoomChart type='gauge'>`
  and kpi → `<LoomChart type='kpi'>` with target / min / max / goal pulled from the
  extra value result columns (cols[1..] in well order). Stacking rides a Format
  field `stacking?: 'none'|'stacked'|'stacked100'` read defensively as
  `(fmt as any).stacking`.
- **Wells re-exposed:** queryVisual() STOPS stripping Small multiples / Tooltips /
  Details. smallMultiples → `wells.smallMultiples`, details → `wells.details`
  (trellis group cols, folded into the 2nd GROUP BY), tooltips → `wells.tooltips`
  (plotted-EXCLUDED, passed to LoomChart `tooltips`). `wellsFor()` re-adds Small
  multiples (charts), Tooltips (charts), Details (treemap).
- **2nd GROUP BY (wells-to-sql.ts, ADDITIVE):** the card/chart/matrix aggregate
  branch appends `trellis = [...smallMultiples, ...details]` group columns AFTER
  `[...category, ...legend]` (read via a narrow local cast — no DaxVisual /
  aas-dax.ts edit, no new tsc error); the existing alias-dedupe + GROUP BY + SELECT
  emit them as trailing `<facet> AS [facet]` columns. table / slicer / card
  branches are UNCHANGED; single-source byte-identical when no smallMultiples /
  details present.
- **Slicer:** a real **multi-style** slicer (list / dropdown / between / relative
  date) emits a `ReportFilter` into the EXISTING applyFilters engine (eq / in /
  between / ge / le / relativeDate already implemented in filters-pane) — **no
  engine change** and **no new route**.
- **Azure Maps:** the `map` visual (map-visual.tsx) — **hosted on the canvas by
  report-designer.tsx's `VisualBody` `visual.type === 'map'` branch as
  `<MapVisual …/>`** (the host passes the resolved latitude / longitude / Location /
  Size / Legend column aliases via `wellResultAlias`, so it is the running
  designer that renders it, not a standalone file) — draws bubbles (point =
  (long,lat), radius ∝ √Size, color ramp by Size; geocodes a Location NAME column
  via Azure Maps Search Fuzzy when no lat/long is bound) or a filled choropleth
  (Location key joined to a **bundled OSS TopoJSON** feature set). The new
  **GET /api/items/report/[id]/map-token** route (session + owner checked, parity
  with /query) brokers a short-lived atlas.microsoft.com credential via
  `resolveMapsBackend()`: 200 `{ ok:true, mode:'aad', token, clientId, expiresOn }`
  (Entra/AAD, preferred — Console UAMI carries `Azure Maps Data Reader`) or
  `{ ok:true, mode:'key', key }` (commercial fallback), else 412
  `{ ok:false, error, envVar:'LOOM_MAPS_BACKEND', bicep:'…/landing-zone/azure-maps.bicep' }`.
  The token is scoped to atlas.microsoft.com **alone** — never api.fabric /
  api.powerbi. `azure-maps.bicep` deploys the account
  (`Microsoft.Maps/accounts`, sku G2 / kind Gen2; `disableLocalAuth` default-true
  at gov; Console UAMI → `Azure Maps Data Reader`; diag → LAW), with
  `LOOM_MAPS_BACKEND` / `LOOM_AZURE_MAPS_CLIENT_ID` / `LOOM_AZURE_MAPS_KEY` wired in
  admin-plane/main.bicep. **ArcGIS / Shape-map stay OUT** (third-party Esri); filled
  maps use the OSS TopoJSON asset, never ArcGIS.
- **Analytics (analytics-pane.tsx):** `AnalyticsLine.axis?:'x'|'y'` (an axis:'x'
  constant computes a VERTICAL line via `orientation:'v'`); `AnalyticsAnomaly`
  (`computeAnomalies` runs a trailing rolling-mean / rolling-std z-score, window =
  clamp(round(n/8),3,24), threshold mapped from a 0-100 `sensitivity` slider —
  ~1.5σ at 100, ~3.5σ at 0 — returning the `{points,band,color}` LoomChart
  consumes; an `useAdx` opt-in posts `series_decompose_anomalies` ONLY when a
  Kusto source is bound, else an honest inline Caption + the client computation —
  no dead control); `AnalyticsShadedRange` (structured numeric from / to / axis /
  color passed straight to LoomChart). All structured inputs (no-freeform-config).

---

## (1) Visualizations pane — visual-type gallery

Source: power-bi-visualizations-overview. Shipped gallery (VISUALS in
report-designer.tsx): table, matrix, card, column, bar, line, area, pie, donut,
scatter, slicer (11). LoomChart renders bar/column/line/area/pie/donut/scatter
as dependency-free SVG; **Wave 5** extends it with true stacked / combo / ribbon /
waterfall / funnel / treemap / gauge / kpi geometry (same dependency-free SVG over
the existing parseRows scales), plus the `map` Azure-Maps visual.

| Visual type | Status | Wave | Backend / render |
|---|---|---|---|
| Clustered bar / column | OK shipped | — | wells to buildSqlFromVisual GROUP BY; LoomChart grouped bars (multi-series already supported) |
| Stacked bar / column | OK Wave 5 | 5 | REAL stacked geometry: LoomChart `stackedColumn`/`stackedBar` (or bar/column + `stackMode='stacked'`) draws per-category cumulative offsets (positive/negative split at zero) over the real GROUP BY rows; the Format **stacking** toggle drives it |
| 100%-stacked bar / column | OK Wave 5 | 5 | REAL geometry: `stackMode='stacked100'` normalizes each category's series to its sum (per-category 100%) over the real rows |
| Line | OK shipped | — | LineAreaChart |
| Area | OK shipped | — | LineAreaChart (areaFill) |
| Stacked area | OK Wave 5 | 5 | REAL geometry: `stackedArea` draws cumulative band paths (lower = prev cumulative, upper = + series) over the real rows |
| Combo — line + clustered column | OK Wave 5 | 5 | REAL dual-axis: `combo` paints the secondary-values aliases (`comboLineSeries`) as a LINE on a SECONDARY right-hand Y axis; every other numeric series as a clustered COLUMN on the primary axis — same /query SELECT |
| Combo — line + stacked column | OK Wave 5 | 5 | REAL: `combo` + `stackMode='stacked'` stacks the primary columns under the secondary-axis line |
| Ribbon | OK Wave 5 | 5 | REAL: `ribbon` draws clustered columns + Bézier ribbons connecting each series' rank between adjacent categories (ribbon width ∝ value, color = series) over the real category+legend+value rows |
| Waterfall | OK Wave 5 | 5 | REAL running-total: `waterfall` floats each bar from prevCumulative → cumulative (increase = Green / decrease = Red tokens) + an explicit **Total** bar (Brand) over the real rows |
| Funnel | OK Wave 5 | 5 | REAL: `funnel` draws horizontally-centered trapezoid bands (width ∝ value) with % of first + % of previous labels over the real rows |
| Scatter | OK shipped | — | ScatterChart (2 numeric cols to x,y) |
| Bubble (scatter + size) | OK Wave 2 | 2 | a 3rd **Size** measure folds into values[] as a real extra aggregate; LoomChart scales each point's radius by `sqrt(size)` (area-proportional, PBI-parity) over the real /query rows |
| Pie | OK shipped | — | PieDonutChart |
| Donut | OK shipped | — | PieDonutChart (donut) |
| Treemap | OK Wave 5 | 5 | REAL squarified (Bruls/Huizing/van Wijk) treemap over the first numeric series; the **Details** well drives a 2nd-level nested partition inside each tile (`detailColumn`, recursive squarify); labels when the tile fits. Details is re-exposed + folded into the 2nd GROUP BY (see Field wells) |
| Map — filled (choropleth) | OK Wave 5 (gate) | 5 | **full UI + real Location/Size aggregate renders**; the Location key joins a **bundled OSS TopoJSON** feature set (country/admin1) colored by a Size ramp. Basemap tiles are an HONEST Azure-Maps gate — `/map-token` returns 412 naming `LOOM_MAPS_BACKEND` + `landing-zone/azure-maps.bicep`; the polygon layer + rows still render (no dead control). NO ArcGIS/Esri, NO Shape-map |
| Map — bubble / Azure Maps | OK Wave 5 (gate) | 5 | **full UI + real Location/Size aggregate renders**; bubbles plot point = (long,lat), radius ∝ √Size, color ramp by Size (a Location NAME column geocodes via Azure Maps Search Fuzzy — REAL data-plane, cached). The atlas.microsoft.com basemap draws once `LOOM_MAPS_BACKEND=azure-maps` + a credential is set (AAD via `/map-token`, preferred); else the honest gate. Token scoped to atlas ALONE — never api.fabric / api.powerbi |
| Map — ArcGIS / Shape map | MISSING by design | — | third-party (Esri ArcGIS / PBI Shape map) — **non-goal**, never Azure-native, never on the default path. Filled maps use the OSS TopoJSON asset instead |
| Gauge | OK Wave 5 | 5 | REAL radial geometry: gauge LEAVES the KPI tile and renders `<LoomChart type='gauge'>` — a 270° SVG arc (gaugeMin..gaugeMax, defaults 0 .. max(value·1.5, target·1.25)) filled by the value, with a **target** needle/marker tick + center value text. Value + Target/Min/Max wells fold into extra value columns read by alias |
| KPI | OK Wave 5 | 5 | REAL indicator: kpi LEAVES the KPI tile and renders `<LoomChart type='kpi'>` — big last-value indicator + a **sparkline** of the category-ordered series + a goal delta vs `kpiGoal` (▲/▼ + % colored good/bad). Target/goal pulled from the extra value result columns |
| Card | OK shipped | — | single aggregate to big-number tile |
| Multi-row card | OK Wave 1 | 1 | real card-list render in VisualBody — one elevated card per result row, field:value pairs (not the table fallback) |
| Table | OK shipped | — | raw projection SELECT TOP N; Fluent table |
| Matrix | OK shipped | — | rows+columns group-by; flat grid (client pivots) |
| Slicer | OK shipped, extended | — / 5 | SELECT DISTINCT of the field (value list) shipped; Wave 5 adds a **multi-style** slicer (list / dropdown / between / relative-date) that emits a `ReportFilter` into the EXISTING applyFilters engine to cross-filter siblings — no engine change, no new route |
| R visual | OK Wave 4 | 4 | REAL sandboxed executor: the Values fields become a `dataset` DataFrame (Python) / data.frame (R); the script plots to the default device; the ACTIVE figure is captured as a PNG. POST /api/items/report/[id]/script-visual resolves rows via the existing Path-3 wells->SQL (resolveReportModel + buildSqlFromVisual + Synapse executeQuery, group+deduped) then forwards to the loom-script-runner ACA app /run. Honest GATE when LOOM_SCRIPT_RUNNER_URL unset (503 naming the env var + script-runner-app.bicep) — full UI still renders |
| Python visual | OK Wave 4 | 4 | REAL sandboxed executor: the Values fields become a `dataset` DataFrame (Python) / data.frame (R); the script plots to the default device; the ACTIVE figure is captured as a PNG. POST /api/items/report/[id]/script-visual resolves rows via the existing Path-3 wells->SQL (resolveReportModel + buildSqlFromVisual + Synapse executeQuery, group+deduped) then forwards to the loom-script-runner ACA app /run. Honest GATE when LOOM_SCRIPT_RUNNER_URL unset (503 naming the env var + script-runner-app.bicep) — full UI still renders |
| Decomposition tree | OK Wave 3 | 3 | AI visual — renders via lib/editors/report/ai-visuals/decomposition-tree.tsx over the Path-3 result rows; AOAI/ADX honest-gate when unbound |
| Key influencers | OK Wave 3 | 3 | AI visual — lib/editors/report/ai-visuals/key-influencers.tsx over the result rows; AOAI honest-gate when unbound |
| Q and A | OK Wave 3 | 3 | NL-to-query — lib/editors/report/ai-visuals/qa.tsx (reuses the Power BI Copilot wiring + AOAI); honest-gate when unbound |
| Smart narrative | OK Wave 3 | 3 | AOAI summary over the page result rows — lib/editors/report/ai-visuals/smart-narrative.tsx; honest-gate when unbound |
| Custom / AppSource visual | MISSING Wave 3 | 3 | third-party marketplace bundle host; not Azure-native by default |

## (2) Field wells

Source: visual-type pages + take-a-tour. Shipped wells (WellName): category,
values, legend; aggregation picker Sum/Avg/Count/Min/Max (AGGS).

| Well | Exposed by | Status | Wave | Mechanism |
|---|---|---|---|---|
| Axis / Category | bar/column/line/area/combo/ribbon/waterfall/funnel | OK shipped | — | category[] to GROUP BY |
| Legend | bar/column/line/pie/donut/treemap/ribbon | OK shipped | — | legend[] to extra GROUP BY column (multi-series) |
| Values | all charts/card/table | OK shipped | — | values[] to aggregate projections (aggProjection) |
| Aggregation (per value) | Sum/Avg/Count/Min/Max | OK shipped | — | SQL_AGG_FN / DAX mirror |
| Secondary values | combo | OK Wave 5 | 5 | folds into values[] as a real extra aggregate in the SAME SELECT; its resolved aliases become `comboLineSeries` so `combo` paints them as the SECONDARY-axis line (every other numeric series = primary-axis column) |
| Small multiples | bar/column/line/area | OK Wave 5 | 5 | re-exposed in wellsFor(); folds into `wells.smallMultiples` and appends to the **2nd GROUP BY** in wells-to-sql (granularity = axis × facet). LoomChart `smallMultiples.facetColumn` splits rows into a responsive **trellis** (one recursive panel per facet value, facet column dropped from panel rows, sharedY for comparability) |
| Tooltips | charts | OK Wave 5 | 5 | re-exposed; rides as a plotted-EXCLUDED aggregate (`wells.tooltips`) — parseRows omits it from the series so it is never an extra bar/line — and is surfaced in the new LoomChart **hover popover** (with the category + each plotted series value). Hover-only, PBI-parity |
| Rows / Columns | matrix | OK shipped | — | category/legend group-bys |
| Target / Min / Max | gauge / KPI | OK Wave 5 | 5 | real extra single-row aggregates folded into values[] (cols[1..] in well order); read back by alias to drive the **real** radial gauge arc bounds + target needle and the KPI goal delta (the geometry is now real, not a caption) |
| Details | treemap | OK Wave 5 | 5 | re-exposed in wellsFor(); folds into `wells.details` and the **2nd GROUP BY** — LoomChart `detailColumn` nests a 2nd-level squarified partition inside each top-level treemap tile (real sub-grouping) |
| Play axis (animation) | scatter / bubble | OK Wave 2 | 2 | a distinct category/time field drives a **client frame loop** — LoomChart steps the play-axis values (play / pause / scrub), re-projecting the already-fetched rows per frame (no per-frame re-query) |
| Size | scatter / bubble | OK Wave 2 | 2 | folds into values[] as a real 3rd aggregate; drives the bubble `sqrt`-area radius (see Bubble) |
| Latitude / Longitude / Location / Size / Legend | map | OK Wave 5 (gate) | 5 | the wells fold to a **real Location+Size aggregate** that renders (bubbles from lat/long or a geocoded Location name; filled choropleth from a Location key + OSS TopoJSON). The atlas.microsoft.com basemap draws once `LOOM_MAPS_BACKEND=azure-maps` + a credential is set (token via `/map-token`); else the honest Azure-Maps gate — full wells UI + aggregate rows present, no dead control |
| Values (R / Python script visual) | R / Python visual | OK Wave 4 | 4 | scriptVisual exposes **Values only**, non-aggregated, **group + deduped** (PBI parity — duplicate rows collapse to one, default "Don't summarize"). The well field names become the `dataset` DataFrame / data.frame column names verbatim (no rename). Language toggle (R / Python) + the code editor are structured/PBI-1:1 (the editor is exempt from no-freeform-config.md exactly like the ADF expression builder) |

## (3) Format pane

Source: each visual Format section + power-bi-report-display-settings. Shipped
(format-pane.tsx, ReportVisualFormat): Title (text + show), Data colors (8
Loom-palette swatches), Axes (X/Y show), Legend (show + position), Number format
(6 presets). Applied client-side in LoomChart / VisualBody; persisted on
visual.config.format via /definition.

| Format section | Status | Wave | Mechanism |
|---|---|---|---|
| Legend (show + position) | OK shipped | — | showLegend / legendPosition |
| X axis (show) | OK shipped | — | showXAxis |
| Y axis (scale / gridlines / title) | OK shipped, extended | 1 / 5 | showYAxis shipped; Wave 1 added the structured scale (min/max), gridline toggle, and axis-title inputs and **persists** them — Wave 5 is where LoomChart actually **consumes** the axis min/max to clamp the value domain (the persisted Wave-1 scale was honest config until the geometry pass) |
| Data colors | OK shipped | — | dataColors lead swatch to resolveDataColors palette |
| Data labels (+ position) | OK Wave 1 | 1 | dataLabels/labelPosition switch+dropdown; LoomChart draws value labels |
| Total labels | OK Wave 5 | 5 | the totalLabels switch persists AND now renders: stacked-column totals and the waterfall **Total** bar label draw off the real Wave-5 stacking / waterfall geometry |
| Plot area | OK Wave 1 | 1 | plotAreaTransparency slider (structured) |
| Title | OK shipped | — | titleText / showTitle |
| Background (palette + transparency) | OK Wave 1 | 1 | background swatch + transparency to card style |
| Border (color / radius) | OK Wave 1 | 1 | border swatch + radius dropdown |
| Shadow | OK Wave 1 | 1 | shadow switch to tokens.shadow* |
| Tooltip (default) | OK Wave 1 | 1 | tooltip values well + SVG title |
| Visual header | GATE | 5 | viewer-chrome (drill/focus icons) — canvas-chrome follow-on (Wave 5 remaining) |
| General — position/size (x/y/w/h) | OK shipped, extended | 1 | shipped w/h grid span; Wave 1 adds numeric w/h tied to the grid + lock-aspect + alt text |
| Zoom (slider) | GATE | 5 | viewer-side zoom; canvas-chrome follow-on (Wave 5 remaining) |
| Styles preset | OK Wave 1 | 1 | structured style dropdown (Minimal/Bold/Loom) seeding the format block |
| Conditional formatting (color scale / rules / data bars / icons) | OK Wave 1 | 1 | structured rules (op/value/color) / color-scale / data-bars / icons — all pickers, never typed format strings; applied client-side to chart fills + table cells (conditional-format module) |

## (4) Analytics pane

Source: desktop-analytics-pane (the line-type table). New right-rail tab
mirroring Power BI; reference lines computed **client-side** over the visual
result series and drawn as overlay lines in LoomChart cartesian charts. Each
line has color / style / label / show-label (structured — a typed constant is a
numeric value, not DAX).

| Analytics line | Status | Wave | Mechanism |
|---|---|---|---|
| Trend line | OK Wave 1 | 1 | least-squares over result rows; overlay |
| Constant line (X / Y) | OK Wave 1 / 5 | 1 / 5 | typed numeric value (structured); the **Y** (horizontal) rule shipped Wave 1, the **X** (vertical) rule renders in Wave 5 via `AnalyticsLine.axis:'x'` → `orientation:'v'` consumed by LoomChart refLines |
| Min line | OK Wave 1 | 1 | Math.min over series |
| Max line | OK Wave 1 | 1 | Math.max over series |
| Average line | OK Wave 1 | 1 | mean over series |
| Median line | OK Wave 1 | 1 | median over series |
| Percentile line | OK Wave 1 (stretch) | 1 | percentile-of-series (stretch goal) |
| Symmetry shading | OK Wave 2 | 2 | scatter-only — shades the upper/lower diagonal half-plane (y vs x) client-side over the result rows |
| Error bars | OK Wave 2 | 2 | structured upper/lower bound pickers (a measure pair, a +/- constant, or a percentage) drawn as whiskers per point — all client-side over the result series |
| Forecast | OK Wave 2 | 2 | client linear / seasonal projection (least-squares trend + optional seasonal period) with a confidence band over the time series. The heavier ADX `series_decompose_forecast` is the OPTIONAL Wave-3 enhancement, not a blocker |
| Anomalies | OK Wave 5 | 5 | `computeAnomalies` runs a REAL client rolling-mean / rolling-std z-score (window = clamp(round(n/8),3,24)) over the result series; a 0-100 **sensitivity** slider maps the z threshold (~1.5σ aggressive → ~3.5σ); flagged points get a ring marker + the rolling expected band shades under the marks (LoomChart `anomalies`). An `useAdx` opt-in posts `series_decompose_anomalies` ONLY when a Kusto source is bound — else an honest inline Caption + the client computation (no dead control) |
| Shaded range | OK Wave 5 | 5 | `AnalyticsShadedRange` — structured numeric from / to / axis ('x'|'y') / color passed straight to LoomChart `shadedRanges`, drawn as a translucent rect under the marks (no-freeform-config: numeric inputs + a swatch) |

## (5) Page + canvas

Source: power-bi-report-display-settings + take-a-tour. Shipped
(report-designer.tsx + use-canvas-layout.ts): add page, rename, move visual,
remove visual, size S/M/L/XL (12-col grid), gridlines + snap (canvas grid).

| Capability | Status | Wave | Mechanism |
|---|---|---|---|
| Add page | OK shipped | — | addPage to DPage |
| Rename page | OK shipped | — | page name input |
| Duplicate page | OK Wave 1 | 1 | clone DPage (visuals+filters) to /definition |
| Hide page | OK Wave 1 | 1 | page.hidden flag persisted |
| Canvas size + type (16:9 / 4:3 / Letter / Tooltip / Custom) | OK Wave 1 | 1 | structured pageType dropdown + W/H; Format-page surface (shown when nothing is selected, PBI-parity) |
| Page background (color + transparency) | OK Wave 1 | 1 | swatch + transparency on the Format-page surface; persisted in page config |
| Wallpaper (outside canvas) | GATE | 5 | canvas-chrome follow-on (Wave 5 remaining) |
| Gridlines + snap-to-grid | OK shipped | — | canvas grid in use-canvas-layout.ts; snap-to-grid is ON by default (the hook's `snapToGrid` option) so a reposition drag reflows cards into the 12-col grid flow. The explicit **user-facing snap toggle in the canvas ribbon is NOT yet surfaced** — the hook already exposes `snapEnabled` for it, so wiring the toggle is the Wave-3 follow-up (§ Follow-on Wave 3) |
| Page navigation (page list) | OK shipped | — | left page tree, setActivePage |
| Group / ungroup visuals | OK Wave 2 | 2 | multi-select model (Ctrl/Shift-click) + group / ungroup sets `groupId` so the group moves/locks/hides as a unit — `groupVisuals` / `ungroupVisuals` in report-designer.tsx, wired from both the Arrange toolbar and the Selection pane. Per-visual **copy / paste / duplicate** (cloning wells/format/filters) is NOT built — the canvas today supports add / remove + duplicate-*page* only, so duplicate-visual is the Wave-3 follow-up (§ Follow-on Wave 3) |
| Align / distribute | MISSING Wave 3 | 3 | `alignVisuals` / `distributeVisuals` exist in use-canvas-layout.ts and mutate the additive grid `x`/`y`, but the canvas today renders by **document-flow grid** (`cardStyle` uses `gridColumn: span w` + a `minHeight`, ignoring `x`/`y`) and the Arrange toolbar exposes only Lock / Hide / Match / Z-order / Group / Ungroup — no Align/Distribute buttons. Wiring buttons now would be a **no-effect** control (no-vaporware.md), so this is deferred: Wave 3 moves the canvas to **explicit grid placement** (`gridColumn`/`gridRow` derived from `x`/`y`, seeding legacy `x=0,y=0` reports via `packGridPositions` on load) so `x`/`y` are honored, then wires Align/Distribute controls in ArrangeBar to `canvas.alignVisuals` / `canvas.distributeVisuals`. |
| Lock visuals | OK Wave 2 | 2 | `locked` flag — the visual ignores drag/resize on the canvas (Selection + canvas honor it); persisted on visual.config |
| Undo / redo | OK Wave 2 | 2 | a **bounded in-memory history** of the pages / reportFilters / bookmarks state (snapshot on each mutation, capped depth); never re-queries — layout/visibility aren't in the query signature |

## (6) Visual interactions

Source: service-reports-visual-interactions. New per-page source-to-target
matrix (Edit interactions). Selecting a slicer value / chart data point
cross-filters or cross-highlights target visuals **client-side** (re-applies the
selection as a filter to target rows / dims non-matching) — no new route.

| Capability | Status | Wave | Mechanism |
|---|---|---|---|
| Edit interactions — Filter | OK Wave 1 | 1 | per-page source-to-target matrix; target re-queried/refiltered with the selection (interactions module) |
| Edit interactions — Highlight | OK Wave 1 | 1 | target dims non-matching rows client-side |
| Edit interactions — None | OK Wave 1 | 1 | target ignores the selection |
| Cross-highlight (select a data point) | OK Wave 1 | 1 | dataSelected re-applies selection to peers |
| Default tooltips | OK Wave 5 | 5 | the Tooltips well is re-exposed and rides as a plotted-EXCLUDED aggregate; LoomChart's new **HoverPopover** (a React-state overlay, Fluent-token styled) surfaces the category + each plotted series value + each tooltip measure on hover (a `<title>` stays for a11y / no-JS) |
| Report-page tooltips | OK Wave 2 (authoring) + Wave 5 (hover popover) | 2 / 5 | **Authoring built (Wave 2):** the Page-format pane exposes a structured **Tooltip page** toggle + a bound-field picker that persists `page.config.tooltipPage = { enabled, boundField }` via /definition (pair with Canvas type = Tooltip) — pickers only. **Hover popover delivered (Wave 5):** the LoomChart HoverPopover affordance now exists on canvas marks; mini-rendering a full tooltip *page* over a mark whose category == `boundField` reuses that hover path and is the remaining follow-on (disclosed honestly in the pane — not a dead control) |
| Drillthrough | OK Wave 2 | 2 | a target page declares a Drillthrough-filters well (`page.config.drillthrough.fields`); right-click a data point on any visual containing that field → **Drillthrough → \<page\>** navigates to the target seeded with the clicked row's value (reusing applyFilters) + an auto **Back** button |
| Drill down / up (hierarchy) | MISSING Wave 3 | 3 | needs hierarchy wells + expand/collapse query |
| Personalize visuals | MISSING Wave 3 | 3 | per-viewer state store |

## (7) Filters pane

Source: power-bi-report-filter + power-bi-report-filter-types. Shipped
(FiltersPane): 3 scopes (visual / page / report) x 9 structured ops (eq, ne, gt,
ge, lt, le, in, contains, between) compiled to SQL WHERE/HAVING (compileFilters)
or DAX FILTER (buildDaxFilterWrapper). No typed predicates.

| Capability | Status | Wave | Mechanism |
|---|---|---|---|
| Visual / Page / Report scope | OK shipped | — | visualFilters / pageFilters / reportFilters |
| Basic + advanced ops (9) | OK shipped | — | FILTER_OPS to scalarPredicate |
| Top N (N + by-measure) | OK Wave 1 | 1 | topN op compiles ORDER BY measure DESC + TOP N in wells-to-sql (+ DAX TOPN mirror) |
| Relative date (last/next N days/months/years) | OK Wave 1 | 1 | relativeDate op compiles a date-range WHERE (+ DAX mirror); structured unit/count pickers |
| Relative time | GATE | 2 | sub-day grain; Wave 2 |
| Lock filter card | OK Wave 1 | 1 | locked flag on the card |
| Hide filter card | OK Wave 1 | 1 | hidden flag on the card |
| Apply button (deferred apply) | OK Wave 2 | 2 | a pane-level **Apply** toggle (`filterPaneFormat.applyButton`) — pending filter edits batch and re-query only on Apply, matching PBI deferred apply |
| Format the filter pane | OK Wave 2 | 2 | structured pane styling (background / border / text / header colors via Loom swatches) persisted on `state.content.filterPaneFormat`; applied to the pane chrome — pickers only, no typed CSS |
| Drillthrough filter scope | OK Wave 2 | 2 | the target page's Drillthrough-filters well (see §6 Drillthrough) shows as a scope row in the Filters pane with the carried value + its own Apply |

## (8) Authoring panes + export

Source: desktop-bookmarks, desktop-report-themes, end-user-export-to-pdf. The
/export BFF route already exists (Power BI ExportTo path) — opt-in only.

| Capability | Status | Wave | Mechanism |
|---|---|---|---|
| Bookmarks (capture / apply / order) | OK Wave 2 | 2 | bookmarks-pane.tsx mounted by report-designer.tsx as the right-rail **Bookmarks** tab (the inline duplicate + flat model were removed; the rich pane is the single source) — a bookmark snapshots active page + filters (report/page/visual) + slicer/selection state + visual visibility + z-order, with Data / Display / Current-page restore toggles; capture / apply / update / rename / delete / reorder all functional in-session; the list is wire-shaped (`wireBookmarks`) and persisted to `state.content.bookmarks` via /definition's `sanitizeBookmark` (the route mirrors this exact shape), and surfaced back on GET via `reportDetailFromContent`. The bookmark list (name / scope / apply toggles) and report-scope filters restore on reload; id-keyed slices (active page / page+visual filters / visibility / z / selection) are skipped on apply when their page/visual id no longer resolves — pages/visuals are re-minted fresh client ids on load today, so durable id persistence is the Wave-3 follow-up (graceful no-op per the pane contract, never a throw) |
| Selection pane (show/hide/z-order) | OK Wave 2 | 2 | selection-pane.tsx mounted by report-designer.tsx as the right-rail **Selection** tab — lists every object on the active page front-most-first, eye-toggle visibility (`visual.config.hidden`), drag-handle / Up-Down z-order (`visual.config.layout.z`), group/ungroup with collapsible group headers (`groupId`); lock stays on the Arrange toolbar (PBI keeps it off the Selection pane); bookmark visibility/z is sourced from here |
| Sync slicers (across pages) | MISSING Wave 3 | 3 | shared slicer state in definition |
| Themes — report built-in | MISSING Wave 3 | 3 | structured theme presets (TS constants, no freeform JSON) |
| Themes — custom | MISSING Wave 3 | 3 | structured theme builder (pickers, not JSON) |
| Export to PDF | GATE | 3 | /export route exists (Power BI ExportTo); Azure-native server render is the Wave-3 plan |
| Export to PPTX | GATE | 3 | same route / plan |
| Export to PNG | GATE | 3 | same route / plan |

---

## Backend per control (matrix)

Every built (OK) control resolves to exactly one of five mechanisms — no mock
arrays, no dead handlers (no-vaporware.md):

| Mechanism | Controls | Where |
|---|---|---|
| **/query to SQL** (buildSqlFromVisual) | every plotted visual data path: category/legend/values/secondary-values/target/min/max wells; Top-N + relative-date filters; **Wave 5** appends small-multiples / details as a trailing **2nd GROUP BY** (axis × facet) and folds tooltips as plotted-EXCLUDED aggregates | wells-to-sql.ts run by synapse-sql-client.executeQuery (Synapse dedicated/serverless) |
| **/query to DAX** (AAS mirror) | the same wells + filters when the report is bound to an AAS tabular model | aas-dax.ts (buildDaxFromVisual) + wrapDaxWithFilters run by executeAasQuery |
| **Client-side LoomChart** | every chart shape — bar/column/line/area/pie/donut/scatter PLUS the **Wave-5 true geometry** (stacked / 100%-stacked / stacked-area, dual-axis combo, ribbon, waterfall + Total, funnel, squarified treemap + Details nest, radial gauge + needle, KPI indicator + sparkline), the multiRowCard card list, the card single-number tile, the Wave-2 bubble `sqrt`-area radius + play-axis frame loop, the **Wave-5 Small-multiples trellis** + **Tooltips hover popover**, Format (colors/labels/axes incl. Wave-5 axis min/max + stacking/legend/background/border/shadow/styles), conditional formatting, Analytics reference lines + the Wave-2 error bars / forecast band / symmetry shading + the **Wave-5 anomalies / X-axis lines / shaded ranges**, the **Wave-5 multi-style slicer** (emits a ReportFilter into applyFilters), and interactions (cross-filter/highlight + the Wave-2 drillthrough navigate). All real geometry over the real /query rows — **every `APPROX_GEOMETRY` closest-shape disclosure is retired** | loom-chart.tsx, format-pane.tsx, conditional-format, analytics-pane.tsx, interactions |
| **/definition persistence** | pages (add/rename/duplicate/hide/size/type/background + Wave-2 drillthrough/tooltipPage config), every visual wells/format/filters/position + the Wave-2 hidden/z/locked/groupId, plus `state.content.bookmarks` (Bookmarks pane), the Selection-pane visibility/z-order, and `state.content.filterPaneFormat` (filter-pane format + Apply button) | definition/route.ts to Cosmos state.content (additive config.* + bookmarks + filterPaneFormat, all sanitizer-whitelisted) |
| **/map-token → Azure Maps** (Wave 5 — the **only** new route Wave 5 adds; the geometry / slicer / analytics need none) | the Azure-Maps visual's basemap only: a session + owner-checked GET that brokers a short-lived atlas.microsoft.com credential via `resolveMapsBackend()` (AAD token minted by the Console UAMI — `Azure Maps Data Reader` — preferred / gov-safe; or a subscription key, commercial). Honest **412 gate** when `LOOM_MAPS_BACKEND` ≠ `azure-maps` or no credential is set (names the env var + azure-maps.bicep); the map panels + real aggregate rows still render. Token scoped to atlas ALONE — never api.fabric / api.powerbi | app/api/items/report/[id]/map-token/route.ts → maps-client.ts; account from platform/fiab/bicep/modules/landing-zone/azure-maps.bicep; env in admin-plane/main.bicep |

The Wave-1 **and Wave-2** builds add **zero** new BFF routes, and **Wave 5** adds
exactly **one** (the `/map-token` basemap broker) — the rendered additive wells
fold into the existing category/values/legend arrays the /query compiler already
handles (Wave 5 only appends a **1-line 2nd GROUP BY** for the trellis), and
everything else (the true chart geometry, the slicer, anomalies / X-lines /
shaded ranges, bubble radius, play-axis frames, error-bars/forecast/symmetry,
drillthrough, tooltip pages, bookmarks, selection, lock / z-order / undo-redo,
filter-pane format) is **client render** or **additive** /definition persistence.
The previously-deferred non-rendered wells (tooltips / small-multiples / details)
and the distinctive chart geometry are now **DELIVERED in Wave 5** as REAL
geometry — no `APPROX_GEOMETRY` remains.

**Honest disclosure (Wave 4):** the R / Python script visual is the **first new
BFF route the whole report-designer program has added** — waves 0-3 added
**zero**, deliberately folding into /query + /definition. The script visual needs
a real script runtime, which no fold can provide, so Wave 4 adds exactly one new
route (`/script-visual`) plus one Azure-native ACA executor (loom-script-runner)
behind an honest `LOOM_SCRIPT_RUNNER_URL` gate. The route still **reuses Path-3
verbatim** for its data (resolveReportModel + buildSqlFromVisual + Synapse
executeQuery) — it only adds the runner hop on top.

## Follow-on waves (exact files)

**Wave 2 — DELIVERED** (this wave; still no new route — client render + additive
/definition): bubble `sqrt`-area radius + play-axis frame loop, error bars /
forecast band / symmetry shading, multi-select + group / ungroup + lock +
match-size + z-order + undo-redo (**align / distribute deferred to Wave 3**, §5),
target-page drillthrough + report-page **tooltip authoring** (the hover-popover
render is Wave 3), the
Filters-pane Apply button + pane formatting + drillthrough scope, and the NEW
Bookmarks + Selection right-rail panes. The map wells render a real location/size
aggregate behind an honest Azure-Maps gate.

**Wave 5 — DELIVERED** (true geometry + slicer + maps + analytics; **one** new
route — the `/map-token` basemap broker — the rest is client render + the additive
2nd GROUP BY):
- **Chart geometry (loom-chart.tsx) — DELIVERED as REAL geometry:** stacked /
  100%-stacked (`stackMode`) / stacked-area, dual-axis combo (line +
  clustered/stacked column via `comboLineSeries`), ribbon rank-connectors,
  running-total waterfall + Total bar, funnel, squarified treemap (+ `detailColumn`
  nest), radial gauge arc + target needle, KPI indicator + sparkline + goal delta.
  Each retired its closest-shape render + `APPROX_GEOMETRY` disclosure in
  report-designer.tsx (`CHART_RENDER` is now true-geometry; `KPI_TYPES` shrank to
  `{'card'}`; `GAUGE_KPI` routes gauge/kpi through LoomChart). All new props are
  optional + default-off → the LoomVisual viewer + waves 0-4 render byte-identical.
- **Deferred wells (report-designer.tsx + wells-to-sql.ts) — DELIVERED:**
  Small-multiples trellis tiling (a recursive panel per facet via
  `smallMultiples.facetColumn`), treemap Details sub-grouping (`detailColumn`), and
  Tooltips surfaced in the new **HoverPopover** — each re-added to wellsFor() and
  re-folded in queryVisual(); the trellis facet rides a **1-line additive 2nd
  GROUP BY** (narrow local cast, no aas-dax.ts edit, no new tsc error).
- **Slicer — DELIVERED:** a multi-style slicer (list / dropdown / between /
  relative-date) — **hosted by report-designer.tsx's `VisualBody`
  `visual.type === 'slicer'` branch as `<SlicerVisual …/>`** (slicer-visual.tsx),
  the host merging its emitted `ReportFilter` into the page-filters channel via
  `onPageFilter` — feeds the EXISTING applyFilters engine: no engine change, no
  new route. (The host render path is the parity proof — not the standalone file.)
- **Azure-Maps visual — DELIVERED (honest gate):** map-visual.tsx — **rendered on
  the canvas by report-designer.tsx's `VisualBody` `map` branch as `<MapVisual …/>`**
  (the running designer hosts it, verified in the host render path, not just a
  standalone file) — draws bubbles
  (point=(long,lat), radius ∝ √Size, color ramp; Location-name geocode via Azure
  Maps Search Fuzzy) or a filled choropleth (OSS TopoJSON join). The **new
  `/map-token` route** (maps-client.ts) brokers a short-lived atlas.microsoft.com
  credential (AAD via Console UAMI `Azure Maps Data Reader`, preferred; or a
  subscription key); honest 412 gate when `LOOM_MAPS_BACKEND` ≠ `azure-maps`,
  naming the env var + `landing-zone/azure-maps.bicep`. `azure-maps.bicep` deploys
  the G2 account + role + diag; env wired in admin-plane/main.bicep. **ArcGIS /
  Shape map stay OUT** (third-party) — filled maps use the OSS TopoJSON asset.
- **Analytics — DELIVERED:** anomalies (client rolling-mean / z-score + a
  sensitivity slider; ADX `series_decompose_anomalies` opt-in only with a Kusto
  source bound), X-axis constant lines (`AnalyticsLine.axis:'x'` → `orientation:'v'`),
  and shaded ranges (structured from/to/axis/color) — all over the same /query rows.

**Wave 5 — remaining follow-on** (canvas chrome, still no new route):
- **Canvas chrome (format-pane.tsx / report-designer.tsx):** Wallpaper (outside canvas), Visual header, Zoom slider.

**Wave 3** (AI + collaboration; new modules / honest infra):
- AI visuals (decomposition tree, key influencers, Q and A, smart narrative) — **DELIVERED** in lib/editors/report/ai-visuals/*.tsx; Q and A + narrative use Azure OpenAI for NL-to-query + narrative — honest-gated on LOOM_AOAI_* / LOOM_ADX_CLUSTER. (Anomalies moved to **Wave 5** — real client z-score with an ADX `series_decompose_anomalies` opt-in.) The **optional** ADX `series_decompose_forecast` upgrade to the Wave-2 client forecast also lands here.
- Sync slicers (shared slicer state across pages) in the definition — the Wave-2 Bookmarks + Selection panes already shipped (bookmarks-pane.tsx / selection-pane.tsx → state.content.bookmarks).
- Themes (built-in + custom, structured) in new lib/editors/report/themes.ts (TS preset constants, picker-built — no freeform JSON).
- Export PDF/PPTX/PNG Azure-native server render: extend app/api/items/report/[id]/export/route.ts.
- Personalize / drill-hierarchy in report-designer.tsx.
- **Canvas precision** (report-designer.tsx + report/use-canvas-layout.ts): move the
  canvas to **explicit grid placement** (`gridColumn`/`gridRow` derived from `x`/`y`,
  seeding legacy `x=0,y=0` reports via `packGridPositions` on load) so `x`/`y` are
  honored, then wire **Align / Distribute** buttons in ArrangeBar to
  `alignVisuals` / `distributeVisuals` (the math already exists); add an explicit
  **snap-to-grid** ribbon toggle bound to the hook's `snapEnabled`; and add
  per-visual **copy / paste / duplicate** (clone wells/format/filters).

**Wave 4 — R / Python script visuals DELIVERED** (Azure-native ACA executor +
the program's first new BFF route; ArcGIS stays a MISSING-by-design non-goal):

- **R / Python visuals — DELIVERED.** A new `map`-style DVisual (`scriptVisual`)
  carries an absolute layout rect and is positioned by **FreeFormCanvas like any
  other visual** (the render-prop `renderVisual`/`renderChrome` contract is
  unchanged — the script visual is just another DVisual). The editor surface:
  a **language toggle (R / Python)**, a **Values-only field well** (non-aggregated,
  group + deduped), and a **code editor** — which is **PBI 1:1 parity** (Power
  BI's R/Python visual *is* a code editor) and therefore **exempt from
  no-freeform-config.md exactly like the ADF expression builder**; the wells and
  the language toggle remain structured. The **Run** button POSTs to the new
  route and renders the returned PNG on the canvas.
  - **New BFF route** `app/api/items/report/[id]/script-visual/route.ts` — the
    **first new route the report program adds** (waves 0-3 added zero, disclosed
    above). It resolves the Values rows through **Path-3 verbatim**
    (resolveReportModel + buildSqlFromVisual + Synapse `executeQuery`, **group +
    deduped**), serializes them to `dataset.csv`, and forwards
    `{ language, script, dataset }` to the runner. Honest **503 gate** when
    `LOOM_SCRIPT_RUNNER_URL` is unset — the MessageBar names the env var **and**
    `platform/fiab/bicep/modules/.../script-runner-app.bicep`; the full editor
    still renders (no dead control).
  - **The executor is REAL** — a dedicated Azure-native **ACA app**
    (`loom-script-runner`), not a stub:
    - **Container** (Dockerfile, pinned base + pinned R/Python + pinned
      matplotlib/ggplot2 versions): a **FastAPI `/run`** endpoint running as a
      **non-root `runner` user**, exposed via **internal ACA ingress only**
      (`external: false`, never public).
    - **`app.py` runs the user script in a resource-limited subprocess** and
      returns a real PNG. The **threat model is documented honestly** (in
      `app.py` + README): the **container is the sandbox boundary — exactly like
      Power BI's locked container, arbitrary user code DOES run inside it**.
      Isolation layers: (1) non-root `runner`; (2) internal-ingress-only;
      (3) per-request **ephemeral `mkdtemp` under /tmp** (`chmod 700`,
      `shutil.rmtree` in `finally`); (4) **scrubbed minimal env** — a fresh dict
      (`PATH` / `HOME=tempdir` / `MPLBACKEND=Agg` / `LANG`), **NO `os.environ`,
      NO inherited secrets**; (5) **POSIX rlimits via `preexec_fn`** —
      `RLIMIT_CPU` ~25s, `RLIMIT_AS` ~1.5 GB, `RLIMIT_FSIZE` ~50 MB,
      `RLIMIT_NPROC`; (6) **`start_new_session=True` + a wall-clock timeout
      (~30s)** that `os.killpg(SIGKILL)`s the whole process group;
      (7) **script-size cap (200 KB)**, row/cell caps, and a PNG size cap.
  - **PBI contract mirrored** (learn.microsoft.com/power-bi/connect-data/desktop-python-visuals):
    the Values fields become a variable named **`dataset`** — a pandas DataFrame
    (Python) / `data.frame` (R) whose **column names are the field names** (no
    rename); rows are **grouped + deduped** (default "Don't summarize"); the
    script plots to the **default device** and the runner captures the **active
    figure** as a static, non-interactive PNG (`out.png`, **96 dpi**). Caps
    mirror PBI: ~150k rows, wall-clock timeout, fixed DPI.
  - **bicep-sync** (no-vaporware.md): new
    `platform/fiab/bicep/modules/.../script-runner-app.bicep` (ACA app, modeled
    on mcp-catalog-app.bicep; `appImageTags` + a `scriptRunnerActive` var like
    the dbt-runner pattern; sibling-module instantiation beside
    setupOrchestrator / dbtRunner) **and** `LOOM_SCRIPT_RUNNER_URL` added to the
    console env array in `admin-plane/main.bicep` (beside `LOOM_DBT_RUNNER_URL`).
  - **Least-privilege-UAMI hardening caveat (carried into bicep + README,
    honest, never silent):** the ACA app exposes its assigned UAMI to in-container
    code via **IMDS**, so the runner MUST use a **dedicated least-privilege
    identity — `uami-loom-script-runner` with AcrPull only and ZERO data-plane
    roles**. Reusing the broadly-permissioned **Console UAMI is a real sandbox
    hole**; the design flags the dedicated UAMI as the correct wiring, and any
    interim Console-UAMI reuse is documented as a **known weakness to tighten**,
    not hidden.
- **ArcGIS maps: MISSING by design (non-goal).** Third-party (Esri); not
  Azure-native — remains the **only** Wave-4 row left MISSING, surfaced as an
  explicit non-goal, never on the default path.

## A-grade gate

A-grade only when every inventory row is OK (shipped or Wave-1 / Wave-2 / Wave-3 /
Wave-4 / Wave-5 committed) or a GATE (honest infra-gate), with **zero MISSING that
lacks a wave + plan** and **zero disabled "coming soon"** controls. Every MISSING
above names its wave and the exact file/plan; every GATE names the env var /
resource to provision and still renders its full UI surface. Constraints honored:
real backend per ui-parity.md (/query + /definition + wells-to-sql, the Wave-4
/script-visual → loom-script-runner ACA executor that really runs the script and
returns a real PNG, and the Wave-5 **/map-token** broker + **REAL chart geometry**
drawn from the same /query rows); no dead controls per no-vaporware.md (every
Wave-5 visual draws real geometry — **no `APPROX_GEOMETRY` remains**; the map row
is an honest Azure-Maps gate, not a disabled button; the slicer really filters;
anomaly is a real computation; the script visual's full editor renders behind an
honest LOOM_SCRIPT_RUNNER_URL 503 gate); all-structured per no-freeform-config.md
(conditional rules, analytics-line + error-bar + forecast + the Wave-5 anomaly
sensitivity slider + shaded-range numeric inputs, filter types, the Wave-5
multi-style slicer, drillthrough fields, and bookmark/selection toggles are
pickers — never typed DAX/JSON; align / distribute, when wired in Wave 5's canvas
follow-on, will be structured pickers too; **the only typed surface is the
R/Python script visual's code editor, which is PBI 1:1 parity — PBI's R/Python
visual IS a code editor — and is therefore exempt exactly like the ADF expression
builder**, while its wells + language toggle stay structured); Azure-native default
+ Power BI embed opt-in per no-fabric-dependency.md (the script runner is
Azure-native ACA, the map is Azure Maps / OSS TopoJSON, anomalies are client /
ADX, all over the existing Synapse /query Path-3 — no Power BI / Fabric service,
no ArcGIS); Fluent v9 + Loom tokens + PBI pane layout (right-rail
Bookmarks/Selection tabs match the PBI panes; the geometry is dark-legible via
theme.foreground/gridline/background; the hover popover + panels are token-styled)
per web3-ui.md.

## Verification

- **Default-path receipt (no Fabric):** with LOOM_DEFAULT_FABRIC_WORKSPACE UNSET
  and a Loom semantic-model source, each built visual Show-SQL disclosure renders
  the exact buildSqlFromVisual query and the canvas renders the executeQuery rows
  — REAL Synapse aggregates, no Power BI / Fabric.
- **Wave-1 fold mechanism:** unit-test that secondary-values / target / min / max
  / tooltips / small-multiples / details wells extend the SELECT aggregate list /
  GROUP BY in wells-to-sql.test.ts, and that Top-N / relative-date compile to
  TOP N ... ORDER BY / a date-range WHERE (SQL) and TOPN / date filter (DAX).
- **Wave-2 receipts (no Fabric, Loom semantic-model source):**
  - **Bubble + play axis:** bubble renders `sqrt`-area radii from the Size well's
    real 3rd aggregate; the play axis animates frames over a real distinct
    category/time field (play / pause / scrub) with no per-frame re-query.
  - **Map gate:** the map wells run a real location/size aggregate and the canvas
    shows the Azure-Maps MessageBar naming `LOOM_MAPS_BACKEND` + the Azure Maps
    key + the bicep module — the gate renders, the wells UI is present, no dead
    control.
  - **Canvas ops:** multi-select + Group / Ungroup / Lock / Match-size /
    Z-order / Undo / Redo mutate the persisted layout (groupId / locked / z /
    w / h) and round-trip through /definition; undo never re-queries. **Align /
    Distribute is NOT yet wired** — the math exists in use-canvas-layout.ts but
    the canvas renders by document-flow grid (`gridColumn: span w`, ignoring
    x/y) and the Arrange toolbar exposes no Align/Distribute buttons (Wave 3, §5).
  - **Drillthrough + tooltip page:** right-click a data point → Drillthrough →
    the target page opens filtered to the clicked value with an auto Back button;
    a tooltip-typed page shows on hover over a mark of its bound field.
  - **Analytics:** error bars, forecast (linear/seasonal + confidence band), and
    symmetry shading compute client-side over the result series.
  - **Filters pane:** the Apply (deferred) button batches edits, pane-format
    colors apply, and the drillthrough scope row + its Apply work.
  - **Bookmarks + Selection:** a bookmark captures + restores page / filters /
    selection / visibility / sort; the Selection pane eye-toggles visibility
    (`config.hidden`) and reorders z-order (`config.z`); both persist to
    state.content via /definition.
- **Wave-5 receipts (no Fabric, Loom semantic-model source):**
  - **True geometry from real rows:** drop a measure + axis + a **Small-multiples**
    field on a column chart → a real **trellis** of columns (one panel per facet,
    sharedY); flip **stacking** to Stacked then **100%**; add a **secondary value**
    → a **combo** dual-axis (line on the right axis + columns on the left); build a
    **waterfall** with a running total + an explicit **Total** bar; a **funnel**;
    a **ribbon**; a squarified **treemap** with a **Details** nest; a **gauge** with
    a target needle; a **KPI** with a sparkline + goal delta. Each Show-SQL renders
    the exact buildSqlFromVisual query (the trellis adds one trailing GROUP BY
    column) and the canvas draws REAL geometry — **no `APPROX_GEOMETRY` caption
    anywhere**.
  - **Slicer:** a **between** slicer (or list / dropdown / relative-date) filters
    its sibling visuals via the applyFilters engine (no new route).
  - **Map gate → real bubbles:** with `LOOM_MAPS_BACKEND` UNSET the map shows the
    honest MessageBar naming `LOOM_MAPS_BACKEND` + `landing-zone/azure-maps.bicep`
    while the panels + the real Location/Size aggregate rows still render; set
    `LOOM_MAPS_BACKEND=azure-maps` (+ AAD client id or key) → `/map-token` returns
    a token and the basemap draws real bubbles (radius ∝ √Size) / a filled
    choropleth. Token scoped to atlas.microsoft.com only; ArcGIS / Shape map absent.
  - **Analytics:** an **anomaly** overlay flags out-of-band points (client rolling
    z-score; the sensitivity slider changes the flagged set; the ADX opt-in shows
    the honest Caption absent a Kusto source), an **X-axis** constant line draws
    vertical, and a **shaded range** paints a translucent band — all over the real
    result series.
- **Wave-4 script-visual receipt (no Fabric):** with
  LOOM_DEFAULT_FABRIC_WORKSPACE UNSET and a Loom semantic-model source, a Python
  `dataset.plot()` and an R `ggplot(dataset, ...)` each render a **real PNG on the
  canvas** — the route resolves the Values rows via Path-3 (group + deduped),
  POSTs `dataset.csv` to the loom-script-runner ACA `/run`, and the subprocess
  returns the active figure as a 96-dpi PNG. With **`LOOM_SCRIPT_RUNNER_URL`
  UNSET** the honest **503 MessageBar** shows (naming the env var +
  script-runner-app.bicep) while the full editor — language toggle, Values well,
  code editor — still renders. The **code editor is PBI-parity-exempt** from
  no-freeform-config.md (PBI's R/Python visual is itself a code editor, like the
  ADF expression builder); the wells + language toggle stay structured. The
  script visual is just another DVisual positioned by **FreeFormCanvas** — waves
  0-3, the data E2E, and the Copilot are extended, not regressed.
- **No-regression:** the shipped 11-type gallery, Format / Filters / Analytics /
  Interactions / Copilot tabs, the cross-filter engine, /query + wells-to-sql, the
  free-form canvas, waves 0-4, and the read-only viewer / PBIR provisioner ignore
  every additive key (Wave-2 config.hidden/z/locked/groupId,
  page.config.drillthrough/tooltipPage, state.content.bookmarks/filterPaneFormat;
  the Wave-5 wells.smallMultiples/tooltips/details + analytics.anomalies/shadedRanges
  + format.stacking) unchanged — sanitizers whitelist them; every new LoomChart prop
  is optional + default-off so the LoomVisual viewer renders byte-identical, and the
  trellis 2nd GROUP BY is read via a narrow local cast (no aas-dax.ts edit).
  TypeScript stays at its ~184 pre-existing unrelated errors (Wave 5 adds none).
- **Live side-by-side** (per ui-parity.md / no-scaffold): click every control
  against the real Power BI report editor and confirm the same outcome — DOM
  strings are not parity.
