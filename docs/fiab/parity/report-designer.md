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
| Analytics pane (reference lines + Wave-2 error-bars/forecast/symmetry) | apps/fiab-console/lib/editors/report/analytics-pane.tsx |
| Bookmarks pane (**NEW** Wave 2 — right-rail tab) | apps/fiab-console/lib/editors/report/bookmarks-pane.tsx |
| Selection pane (**NEW** Wave 2 — right-rail tab) | apps/fiab-console/lib/editors/report/selection-pane.tsx |

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
- **OK Wave 4** — the committed Wave-4 build: the R / Python **script visuals**,
  backed by a REAL Azure-native sandboxed executor (the `loom-script-runner` ACA
  app) reached through the program's **first new BFF route** (`/script-visual`).
  Unlike waves 1-2 (zero new routes), the script visual needs a real script
  runtime no fold can provide, so this wave adds exactly one route + one ACA
  executor behind an honest `LOOM_SCRIPT_RUNNER_URL` gate, while still reusing
  /query Path-3 verbatim for its data. See **Follow-on Wave 4** for the executor,
  the sandbox threat model, the bicep sync, and the least-privilege-UAMI caveat.
- **GATE** — honest infra-gate: the full UI renders and the query still runs, but
  a styled Fluent MessageBar intent="warning" names the exact env var / resource
  to provision (per no-vaporware.md).
- **MISSING Wave N** — not built; a follow-on wave (2/3/4) owns it, with the plan
  + exact files in **Follow-on waves** below. No MISSING exists without a wave +
  plan, and there are **zero disabled "coming soon"** controls (A-grade gate).

Wave-1 key mechanism: the designer queryVisual() **folds the rendered additive
wells into the existing category / values / legend arrays** that /query +
buildSqlFromVisual already compile — secondary-values / target / min / max become
extra value aggregates. So each visual returns REAL aggregated SQL rows. **No new
BFF route.** Two well families are intentionally **NOT** folded, because LoomChart
can't yet honor them and folding them corrupts the result: **Tooltips** are
hover-only in Power BI and would draw as extra plotted series, and **Small
multiples / treemap Details** would add a 2nd GROUP BY column that LoomChart
ignores (it reads only the first non-numeric column as the axis) while silently
changing the aggregation granularity — no trellis. Both are removed from the
wells UI and the query and return in **Wave 2** (real trellis tiling + detail
sub-grouping + hover surfacing). Likewise the distinctive PBI **chart geometry**
for combo / ribbon / waterfall / funnel / treemap / gauge is a **Wave-2**
LoomChart build: today each renders its REAL rows through the closest shape with
an honest on-canvas disclosure (`APPROX_GEOMETRY`) — never silent wrong-geometry.

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

---

## (1) Visualizations pane — visual-type gallery

Source: power-bi-visualizations-overview. Shipped gallery (VISUALS in
report-designer.tsx): table, matrix, card, column, bar, line, area, pie, donut,
scatter, slicer (11). LoomChart renders bar/column/line/area/pie/donut/scatter
as dependency-free SVG.

| Visual type | Status | Wave | Backend / render |
|---|---|---|---|
| Clustered bar / column | OK shipped | — | wells to buildSqlFromVisual GROUP BY; LoomChart grouped bars (multi-series already supported) |
| Stacked bar / column | GATE | 2 | SQL rows are real; LoomChart draws GROUPED (clustered) bars today — true stacking + the Format stacking toggle ship in Wave 2 |
| 100%-stacked bar / column | GATE | 2 | SQL rows are real; per-category 100% normalization is a Wave-2 LoomChart build (drawn clustered today) |
| Line | OK shipped | — | LineAreaChart |
| Area | OK shipped | — | LineAreaChart (areaFill) |
| Stacked area | GATE | 2 | SQL rows are real; cumulative area stacking is a Wave-2 LoomChart build (drawn as overlaid area today) |
| Combo — line + clustered column | GATE | 2 | Secondary-values well adds a real extra aggregate in the SAME SELECT; LoomChart draws it as another clustered column today — the dual-axis line render is Wave 2 (APPROX_GEOMETRY disclosed) |
| Combo — line + stacked column | GATE | 2 | as above; dual-axis line + stacked columns are Wave 2 |
| Ribbon | GATE | 2 | category+legend+value rows are real; ribbon rank-connectors are a Wave-2 LoomChart build (drawn as clustered columns today, APPROX_GEOMETRY disclosed) |
| Waterfall | GATE | 2 | category + value rows are real; running-total rise/fall/total geometry is a Wave-2 LoomChart build (drawn as columns today, APPROX_GEOMETRY disclosed) |
| Funnel | GATE | 2 | category + value rows are real; funnel geometry is a Wave-2 LoomChart build (drawn as bars today, APPROX_GEOMETRY disclosed) |
| Scatter | OK shipped | — | ScatterChart (2 numeric cols to x,y) |
| Bubble (scatter + size) | OK Wave 2 | 2 | a 3rd **Size** measure folds into values[] as a real extra aggregate; LoomChart scales each point's radius by `sqrt(size)` (area-proportional, PBI-parity) over the real /query rows |
| Pie | OK shipped | — | PieDonutChart |
| Donut | OK shipped | — | PieDonutChart (donut) |
| Treemap | GATE | 2 | group + value rows are real; squarified treemap geometry is a Wave-2 LoomChart build (drawn as bars today, APPROX_GEOMETRY disclosed). The Details sub-group well is removed until Wave 2 (see Field wells) |
| Map — filled (choropleth) | GATE | 2 | **full UI + real location/size aggregate query renders** (rows shown as a location grid with the size measure); drawing on a basemap is an HONEST Azure-Maps gate — a styled MessageBar names `LOOM_MAPS_BACKEND` + the Azure Maps key + the bicep module link. The gate renders, not a dead control |
| Map — bubble / Azure Maps | GATE | 2 | as above — real location/size aggregate renders; the Azure Maps Web SDK basemap draw is behind the same honest `LOOM_MAPS_BACKEND` gate (gate renders, full UI present) |
| Map — ArcGIS | MISSING Wave 4 | 4 | third-party (Esri), not Azure-native — listed for completeness, never on the default path |
| Gauge | GATE | 2 | value + Target/Min/Max wells run a real single-row aggregate, shown as a numeric KPI tile (value + target/min/max captions); the radial arc + target marker are a Wave-2 LoomChart build (APPROX_GEOMETRY disclosed) |
| KPI | GATE | 2 | value + Target run a real aggregate, shown as a numeric KPI tile; the indicator + trend axis are a Wave-2 build |
| Card | OK shipped | — | single aggregate to big-number tile |
| Multi-row card | OK Wave 1 | 1 | real card-list render in VisualBody — one elevated card per result row, field:value pairs (not the table fallback) |
| Table | OK shipped | — | raw projection SELECT TOP N; Fluent table |
| Matrix | OK shipped | — | rows+columns group-by; flat grid (client pivots) |
| Slicer | OK shipped | — | SELECT DISTINCT of the field; value list |
| R visual | OK Wave 4 | 4 | REAL sandboxed executor: the Values fields become a `dataset` DataFrame (Python) / data.frame (R); the script plots to the default device; the ACTIVE figure is captured as a PNG. POST /api/items/report/[id]/script-visual resolves rows via the existing Path-3 wells->SQL (resolveReportModel + buildSqlFromVisual + Synapse executeQuery, group+deduped) then forwards to the loom-script-runner ACA app /run. Honest GATE when LOOM_SCRIPT_RUNNER_URL unset (503 naming the env var + script-runner-app.bicep) — full UI still renders |
| Python visual | OK Wave 4 | 4 | REAL sandboxed executor: the Values fields become a `dataset` DataFrame (Python) / data.frame (R); the script plots to the default device; the ACTIVE figure is captured as a PNG. POST /api/items/report/[id]/script-visual resolves rows via the existing Path-3 wells->SQL (resolveReportModel + buildSqlFromVisual + Synapse executeQuery, group+deduped) then forwards to the loom-script-runner ACA app /run. Honest GATE when LOOM_SCRIPT_RUNNER_URL unset (503 naming the env var + script-runner-app.bicep) — full UI still renders |
| Decomposition tree | MISSING Wave 3 | 3 | AI visual — ADX/AOAI plan in Follow-on |
| Key influencers | MISSING Wave 3 | 3 | AI visual — ADX/AOAI plan |
| Q and A | MISSING Wave 3 | 3 | NL-to-query — reuses the Power BI Copilot wiring; ADX/AOAI plan |
| Smart narrative | MISSING Wave 3 | 3 | AOAI summary over the page result rows |
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
| Secondary values | combo | GATE | 2 | folded into values[] as a real extra aggregate (plotted as another clustered column today); the line / 2nd-axis split is Wave 2 |
| Small multiples | (removed until Wave 2) | MISSING Wave 2 | 2 | the well is removed and NOT folded into the query — LoomChart ignores a 2nd group column while it silently changes granularity (no trellis). Wave 2 adds real trellis tiling (a panel per group value) |
| Tooltips | (removed until Wave 2) | MISSING Wave 2 | 2 | the well is removed and excluded from the plotted series — tooltip measures are hover-only in PBI and LoomChart would draw them as extra bars/lines. Wave 2 adds per-point tooltip columns surfaced in the SVG title hover |
| Rows / Columns | matrix | OK shipped | — | category/legend group-bys |
| Target / Min / Max | gauge / KPI | OK Wave 1 | 1 | real extra single-row aggregates folded into values[], shown as captions on the KPI tile (the gauge arc itself is Wave 2) |
| Details | (removed until Wave 2) | MISSING Wave 2 | 2 | the treemap Details well is removed and NOT folded — a 2nd group column changes granularity without a sub-group render. Wave 2 adds real detail sub-grouping |
| Play axis (animation) | scatter / bubble | OK Wave 2 | 2 | a distinct category/time field drives a **client frame loop** — LoomChart steps the play-axis values (play / pause / scrub), re-projecting the already-fetched rows per frame (no per-frame re-query) |
| Size | scatter / bubble | OK Wave 2 | 2 | folds into values[] as a real 3rd aggregate; drives the bubble `sqrt`-area radius (see Bubble) |
| Latitude / Longitude / Size | map | GATE | 2 | the lat/long/size wells run a **real location+size aggregate** that renders; the basemap draw is the honest Azure-Maps gate (`LOOM_MAPS_BACKEND` + Azure Maps key + bicep link) — full wells UI present, gate renders |
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
| Y axis (scale / gridlines / title) | OK shipped, extended | 1 | showYAxis shipped; Wave 1 adds scale (min/max), gridline toggle, axis title — structured inputs |
| Data colors | OK shipped | — | dataColors lead swatch to resolveDataColors palette |
| Data labels (+ position) | OK Wave 1 | 1 | dataLabels/labelPosition switch+dropdown; LoomChart draws value labels |
| Total labels | GATE | 2 | the totalLabels switch persists; stacked/waterfall total rendering depends on the Wave-2 stacking/waterfall geometry |
| Plot area | OK Wave 1 | 1 | plotAreaTransparency slider (structured) |
| Title | OK shipped | — | titleText / showTitle |
| Background (palette + transparency) | OK Wave 1 | 1 | background swatch + transparency to card style |
| Border (color / radius) | OK Wave 1 | 1 | border swatch + radius dropdown |
| Shadow | OK Wave 1 | 1 | shadow switch to tokens.shadow* |
| Tooltip (default) | OK Wave 1 | 1 | tooltip values well + SVG title |
| Visual header | GATE | 2 | viewer-chrome (drill/focus icons) — surfaced in Wave 2 with interactions |
| General — position/size (x/y/w/h) | OK shipped, extended | 1 | shipped w/h grid span; Wave 1 adds numeric w/h tied to the grid + lock-aspect + alt text |
| Zoom (slider) | GATE | 2 | viewer-side zoom; Wave 2 |
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
| Constant line (X / Y) | OK Wave 1 | 1 | typed numeric value (structured), horizontal/vertical rule |
| Min line | OK Wave 1 | 1 | Math.min over series |
| Max line | OK Wave 1 | 1 | Math.max over series |
| Average line | OK Wave 1 | 1 | mean over series |
| Median line | OK Wave 1 | 1 | median over series |
| Percentile line | OK Wave 1 (stretch) | 1 | percentile-of-series (stretch goal) |
| Symmetry shading | OK Wave 2 | 2 | scatter-only — shades the upper/lower diagonal half-plane (y vs x) client-side over the result rows |
| Error bars | OK Wave 2 | 2 | structured upper/lower bound pickers (a measure pair, a +/- constant, or a percentage) drawn as whiskers per point — all client-side over the result series |
| Forecast | OK Wave 2 | 2 | client linear / seasonal projection (least-squares trend + optional seasonal period) with a confidence band over the time series. The heavier ADX `series_decompose_forecast` is the OPTIONAL Wave-3 enhancement, not a blocker |
| Anomalies | MISSING Wave 3 | 3 | ADX series_decompose_anomalies plan |

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
| Wallpaper (outside canvas) | GATE | 2 | Wave 2 |
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
| Default tooltips | MISSING Wave 2 | 2 | the Tooltips well is removed (hover-only measures aren't plotted); per-point SVG-title tooltip surfacing is a Wave-2 build |
| Report-page tooltips | OK Wave 2 (authoring) / MISSING Wave 3 (render) | 2 / 3 | **Authoring built:** the Page-format pane (PageFormatPanel, shown when no visual is selected) exposes a structured **Tooltip page** toggle + a bound-field picker that persists `page.config.tooltipPage = { enabled, boundField }` via /definition (pair with Canvas type = Tooltip) — pickers only, no typed config. **Render deferred:** the hover popover that mini-renders this page over a mark whose category == `boundField` is the Wave-3 build (a hover path on canvas marks in report-designer.tsx / loom-chart.tsx); disclosed honestly in the pane (not a dead control). |
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
| **/query to SQL** (buildSqlFromVisual) | every plotted visual data path: category/legend/values/secondary-values/target/min/max wells; Top-N + relative-date filters (tooltips / small-multiples / details are NOT plotted — Wave 2) | wells-to-sql.ts run by synapse-sql-client.executeQuery (Synapse dedicated/serverless) |
| **/query to DAX** (AAS mirror) | the same wells + filters when the report is bound to an AAS tabular model | aas-dax.ts (buildDaxFromVisual) + wrapDaxWithFilters run by executeAasQuery |
| **Client-side LoomChart** | the shipped chart shapes (bar/column/line/area/pie/donut/scatter), the multiRowCard card list, the numeric KPI tile (card/kpi/gauge), the Wave-2 **bubble `sqrt`-area radius** + **play-axis frame loop**, Format (colors/labels/axes/legend/background/border/shadow/styles), conditional formatting, Analytics reference lines + the Wave-2 **error bars / forecast band / symmetry shading**, interactions (cross-filter/highlight + the Wave-2 drillthrough navigate + report-page-tooltip popover). The distinctive geometry for combo/waterfall/funnel/gauge/KPI/treemap/ribbon/stacking remains **Wave 2** (rendered as the closest shape today with an APPROX_GEOMETRY disclosure) | loom-chart.tsx, format-pane.tsx, conditional-format, analytics-pane.tsx, interactions |
| **/definition persistence** | pages (add/rename/duplicate/hide/size/type/background + Wave-2 drillthrough/tooltipPage config), every visual wells/format/filters/position + the Wave-2 hidden/z/locked/groupId, plus `state.content.bookmarks` (Bookmarks pane), the Selection-pane visibility/z-order, and `state.content.filterPaneFormat` (filter-pane format + Apply button) | definition/route.ts to Cosmos state.content (additive config.* + bookmarks + filterPaneFormat, all sanitizer-whitelisted) |
| **/script-visual → loom-script-runner ACA** (Wave 4 — the **FIRST new BFF route the program adds**; waves 0-3 added **zero**) | the R / Python script visuals only: the route resolves the scriptVisual's Values rows through Path-3 (resolveReportModel + buildSqlFromVisual + Synapse executeQuery, group+deduped), writes them to `dataset.csv`, and forwards `{ language, script, dataset }` to the loom-script-runner ACA app `/run`, which executes the script in a resource-limited subprocess and returns a PNG of the active figure. Honest 503 GATE when `LOOM_SCRIPT_RUNNER_URL` is unset (names the env var + script-runner-app.bicep); the full editor still renders | app/api/items/report/[id]/script-visual/route.ts → the loom-script-runner ACA app (Dockerfile + app.py); env `LOOM_SCRIPT_RUNNER_URL` wired in platform/fiab/bicep |

The Wave-1 **and Wave-2** builds add **zero** new BFF routes: the rendered
additive wells fold into the existing category/values/legend arrays the /query
compiler already handles, and everything else (bubble radius, play-axis frames,
error-bars/forecast/symmetry, drillthrough, tooltip pages, bookmarks, selection,
lock / z-order / undo-redo, filter-pane format) is client render or
**additive** /definition persistence. Non-rendered wells (tooltips /
small-multiples / details) and the distinctive chart geometry remain deferred to
the **Wave-2 follow-on** (below) — disclosed honestly today, not silently
mis-rendered.

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

**Wave 2 — remaining follow-on** (chart geometry + deferred wells + canvas chrome,
still no new route):
- **Chart geometry (loom-chart.tsx):** true stacked / 100%-stacked / stacked-area, combo dual-axis (line + column), ribbon rank-connectors, running-total waterfall, funnel, squarified treemap, radial gauge arc + target marker, KPI indicator/trend. Each replaces the current closest-shape render + APPROX_GEOMETRY disclosure in report-designer.tsx (CHART_RENDER / the KPI branch).
- **Deferred wells (report-designer.tsx + loom-chart.tsx):** Small-multiples trellis tiling (a panel per group value), treemap Details sub-grouping, and per-point Tooltips surfaced in the SVG title hover — each re-adds its well to wellsFor() and re-folds into queryVisual() once LoomChart can honor it without changing aggregation granularity.
- **Map basemap render:** the Azure Maps Web SDK draw behind the shipped `LOOM_MAPS_BACKEND` gate (loom-chart.tsx); env wired in platform/fiab/bicep/modules/admin-plane/main.bicep.
- **Canvas chrome (format-pane.tsx / report-designer.tsx):** Wallpaper (outside canvas), Visual header, Zoom slider.

**Wave 3** (AI + collaboration; new modules / honest infra):
- AI visuals (decomposition tree, key influencers, Q and A, smart narrative) in new lib/editors/report/ai-visuals.tsx; Q and A / anomaly query ADX (series_decompose_anomalies) and Azure OpenAI for NL-to-query + narrative — honest-gated on LOOM_ADX_CLUSTER / LOOM_AOAI_*. The **optional** ADX `series_decompose_forecast` upgrade to the Wave-2 client forecast also lands here.
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

A-grade only when every inventory row is OK (shipped or Wave-1 / Wave-2 / Wave-4
committed) or a GATE (honest infra-gate), with **zero MISSING that lacks a wave +
plan** and **zero disabled "coming soon"** controls. Every MISSING above names its
wave and the exact file/plan; every GATE names the env var / resource to provision
and still renders its full UI surface. Constraints honored: real backend per
ui-parity.md (/query + /definition + wells-to-sql, plus the Wave-4 /script-visual →
loom-script-runner ACA executor that really runs the script and returns a real
PNG); no dead controls per no-vaporware.md (the map row is an honest Azure-Maps
gate, not a disabled button; the script visual's full editor renders behind an
honest LOOM_SCRIPT_RUNNER_URL 503 gate); all-structured per no-freeform-config.md
(conditional rules, analytics-line + error-bar + forecast config, filter types,
drillthrough fields, and bookmark/selection toggles are pickers — never typed
DAX/JSON; align / distribute, when wired in Wave 3, will be structured pickers too;
**the only typed surface is the R/Python script visual's code editor, which is PBI
1:1 parity — PBI's R/Python visual IS a code editor — and is therefore exempt
exactly like the ADF expression builder**, while its wells + language toggle stay
structured); Azure-native default + Power BI embed opt-in per
no-fabric-dependency.md (the script runner is Azure-native ACA + the existing
Synapse /query Path-3 — no Power BI / Fabric service); Fluent
v9 + Loom tokens + PBI pane layout (right-rail Bookmarks/Selection tabs match the
PBI panes) per web3-ui.md.

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
  Interactions / Copilot tabs, the cross-filter engine, /query + wells-to-sql,
  and the read-only viewer / PBIR provisioner ignore every additive Wave-2 key
  (config.hidden/z/locked/groupId, page.config.drillthrough/tooltipPage,
  state.content.bookmarks/filterPaneFormat) unchanged — sanitizers whitelist
  them; TypeScript stays at its ~181 pre-existing unrelated errors (adds none).
- **Live side-by-side** (per ui-parity.md / no-scaffold): click every control
  against the real Power BI report editor and confirm the same outcome — DOM
  strings are not parity.
