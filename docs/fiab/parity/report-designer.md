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
| Bubble (scatter + size) | GATE | 2 | needs a 3rd Size measure aggregate; query runs, renders as scatter until Wave 2 adds the bubble radius scale |
| Pie | OK shipped | — | PieDonutChart |
| Donut | OK shipped | — | PieDonutChart (donut) |
| Treemap | GATE | 2 | group + value rows are real; squarified treemap geometry is a Wave-2 LoomChart build (drawn as bars today, APPROX_GEOMETRY disclosed). The Details sub-group well is removed until Wave 2 (see Field wells) |
| Map — filled (choropleth) | GATE | 2 | location + size aggregate query runs (rows shown as grid); drawing on a basemap needs LOOM_MAPS_BACKEND + Azure Maps key (MessageBar) |
| Map — bubble / Azure Maps | GATE | 2 | as above; Azure Maps Web SDK behind the same env gate |
| Map — ArcGIS | MISSING Wave 4 | 4 | third-party (Esri), not Azure-native — listed for completeness, never on the default path |
| Gauge | GATE | 2 | value + Target/Min/Max wells run a real single-row aggregate, shown as a numeric KPI tile (value + target/min/max captions); the radial arc + target marker are a Wave-2 LoomChart build (APPROX_GEOMETRY disclosed) |
| KPI | GATE | 2 | value + Target run a real aggregate, shown as a numeric KPI tile; the indicator + trend axis are a Wave-2 build |
| Card | OK shipped | — | single aggregate to big-number tile |
| Multi-row card | OK Wave 1 | 1 | real card-list render in VisualBody — one elevated card per result row, field:value pairs (not the table fallback) |
| Table | OK shipped | — | raw projection SELECT TOP N; Fluent table |
| Matrix | OK shipped | — | rows+columns group-by; flat grid (client pivots) |
| Slicer | OK shipped | — | SELECT DISTINCT of the field; value list |
| R visual | MISSING Wave 4 | 4 | needs a container script runtime (no R engine in the console) — see Follow-on |
| Python visual | MISSING Wave 4 | 4 | same container-runtime dependency |
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
| Play axis (animation) | scatter | MISSING Wave 3 | 3 | needs a frame-sequenced query loop + animation state |
| Latitude / Longitude / Size | map | MISSING Wave 2 | 2 | lands with the map gate (Azure Maps) |

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
| Symmetry shading | MISSING Wave 2 | 2 | scatter-only diagonal shade |
| Error bars | MISSING Wave 2 | 2 | needs upper/lower measure pairs |
| Forecast | MISSING Wave 3 | 3 | time-series forecast — ADX series_decompose_forecast plan |
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
| Gridlines + snap-to-grid | OK shipped | — | canvas grid in use-canvas-layout.ts |
| Page navigation (page list) | OK shipped | — | left page tree, setActivePage |
| Copy / group visuals | GATE | 2 | Wave 2 (selection model) |
| Align / distribute | GATE | 2 | Wave 2 (use-canvas-layout.ts) |
| Lock visuals | GATE | 2 | Wave 2 |
| Undo / redo | MISSING Wave 2 | 2 | needs a designer history stack |

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
| Report-page tooltips | GATE | 2 | needs a tooltip-typed page bound to the hover |
| Drillthrough | GATE | 2 | needs a drillthrough target page + carried filter context |
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
| Apply button (deferred apply) | GATE | 2 | Wave 2 |
| Format the filter pane | GATE | 2 | pane styling; Wave 2 |
| Drillthrough filter scope | GATE | 2 | lands with drillthrough |

## (8) Authoring panes + export

Source: desktop-bookmarks, desktop-report-themes, end-user-export-to-pdf. The
/export BFF route already exists (Power BI ExportTo path) — opt-in only.

| Capability | Status | Wave | Mechanism |
|---|---|---|---|
| Bookmarks (capture / apply / order) | MISSING Wave 3 | 3 | Cosmos snapshot of page+filter+selection state |
| Selection pane (show/hide/z-order) | MISSING Wave 3 | 3 | visual visibility model |
| Sync slicers (across pages) | MISSING Wave 3 | 3 | shared slicer state in definition |
| Themes — report built-in | MISSING Wave 3 | 3 | structured theme presets (TS constants, no freeform JSON) |
| Themes — custom | MISSING Wave 3 | 3 | structured theme builder (pickers, not JSON) |
| Export to PDF | GATE | 3 | /export route exists (Power BI ExportTo); Azure-native server render is the Wave-3 plan |
| Export to PPTX | GATE | 3 | same route / plan |
| Export to PNG | GATE | 3 | same route / plan |

---

## Backend per control (matrix)

Every built (OK) control resolves to exactly one of four mechanisms — no mock
arrays, no dead handlers (no-vaporware.md):

| Mechanism | Controls | Where |
|---|---|---|
| **/query to SQL** (buildSqlFromVisual) | every plotted visual data path: category/legend/values/secondary-values/target/min/max wells; Top-N + relative-date filters (tooltips / small-multiples / details are NOT plotted — Wave 2) | wells-to-sql.ts run by synapse-sql-client.executeQuery (Synapse dedicated/serverless) |
| **/query to DAX** (AAS mirror) | the same wells + filters when the report is bound to an AAS tabular model | aas-dax.ts (buildDaxFromVisual) + wrapDaxWithFilters run by executeAasQuery |
| **Client-side LoomChart** | the shipped chart shapes (bar/column/line/area/pie/donut/scatter), the multiRowCard card list, the numeric KPI tile (card/kpi/gauge), Format (colors/labels/axes/legend/background/border/shadow/styles), conditional formatting, Analytics reference lines, interactions (cross-filter/highlight). The distinctive geometry for combo/waterfall/funnel/gauge/KPI/treemap/ribbon/stacking is **Wave 2** (rendered as the closest shape today with an APPROX_GEOMETRY disclosure) | loom-chart.tsx, format-pane.tsx, conditional-format, analytics-pane.tsx, interactions |
| **/definition persistence** | pages (add/rename/duplicate/hide/size/type/background), every visual wells/format/filters/position | definition/route.ts to Cosmos state.content (additive config.format/config.filters) |

The Wave-1 build adds **zero** new BFF routes: the rendered additive wells fold
into the existing category/values/legend arrays the /query compiler already
handles, and everything else is client render or /definition persistence.
Non-rendered wells (tooltips / small-multiples / details) and the distinctive
chart geometry are deferred to **Wave 2** (below) — disclosed honestly today, not
silently mis-rendered.

## Follow-on waves (exact files)

**Wave 2** (canvas + interactions polish + chart geometry, still no new route):
- **Chart geometry (loom-chart.tsx):** true stacked / 100%-stacked / stacked-area, combo dual-axis (line + column), ribbon rank-connectors, running-total waterfall, funnel, squarified treemap, radial gauge arc + target marker, KPI indicator/trend. Each replaces the current closest-shape render + APPROX_GEOMETRY disclosure in report-designer.tsx (CHART_RENDER / the KPI branch).
- **Deferred wells (report-designer.tsx + loom-chart.tsx):** Small-multiples trellis tiling (a panel per group value), treemap Details sub-grouping, and per-point Tooltips surfaced in the SVG title hover — each re-adds its well to wellsFor() and re-folds into queryVisual() once LoomChart can honor it without changing aggregation granularity.
- Bubble size scale, map gate (Azure Maps) in loom-chart.tsx; env LOOM_MAPS_BACKEND wired in platform/fiab/bicep/modules/admin-plane/main.bicep.
- Align / distribute / group / lock, undo-redo history in lib/editors/report/use-canvas-layout.ts.
- Drillthrough + report-page tooltips in report-designer.tsx + interactions.
- Error bars / symmetry shading in analytics-pane.tsx.
- Wallpaper, Visual header, Zoom, Apply button, Format-the-filter-pane in format-pane.tsx / report-designer.tsx.

**Wave 3** (AI + collaboration; new modules / honest infra):
- AI visuals (decomposition tree, key influencers, Q and A, smart narrative) in new lib/editors/report/ai-visuals.tsx; Q and A / forecast / anomaly query ADX (series_decompose_forecast / series_decompose_anomalies) and Azure OpenAI for NL-to-query + narrative — honest-gated on LOOM_ADX_CLUSTER / LOOM_AOAI_*.
- Bookmarks + Selection + sync slicers in new lib/editors/report/bookmarks-pane.tsx, persisted to Cosmos state.content.bookmarks.
- Themes (built-in + custom, structured) in new lib/editors/report/themes.ts (TS preset constants, picker-built — no freeform JSON).
- Export PDF/PPTX/PNG Azure-native server render: extend app/api/items/report/[id]/export/route.ts.
- Personalize / drill-hierarchy in report-designer.tsx.

**Wave 4** (runtime-dependent / third-party):
- R / Python visuals: script-runtime container (ACA job or AML compute); honest-gated on the runtime env. Files: new lib/editors/report/script-visual.tsx + a runner route.
- ArcGIS maps: third-party (Esri); not Azure-native — remains MISSING by design, surfaced as an explicit non-goal.

## A-grade gate

A-grade only when every inventory row is OK (shipped or Wave-1 committed) or a
GATE (honest infra-gate), with **zero MISSING that lacks a wave + plan** and
**zero disabled "coming soon"** controls. Every MISSING above names its wave and
the exact file/plan; every GATE names the env var / resource to provision and
still renders its full UI surface. Constraints honored: real backend per
ui-parity.md (/query + /definition + wells-to-sql); no dead controls per
no-vaporware.md; all-structured per no-freeform-config.md (conditional rules,
analytics-line config, filter types are pickers — never typed DAX/JSON);
Azure-native default + Power BI embed opt-in per no-fabric-dependency.md; Fluent
v9 + Loom tokens + PBI pane layout per web3-ui.md.

## Verification

- **Default-path receipt (no Fabric):** with LOOM_DEFAULT_FABRIC_WORKSPACE UNSET
  and a Loom semantic-model source, each built visual Show-SQL disclosure renders
  the exact buildSqlFromVisual query and the canvas renders the executeQuery rows
  — REAL Synapse aggregates, no Power BI / Fabric.
- **Wave-1 fold mechanism:** unit-test that secondary-values / target / min / max
  / tooltips / small-multiples / details wells extend the SELECT aggregate list /
  GROUP BY in wells-to-sql.test.ts, and that Top-N / relative-date compile to
  TOP N ... ORDER BY / a date-range WHERE (SQL) and TOPN / date filter (DAX).
- **No-regression:** the shipped 11-type gallery, Format pane, 3-scope Filters
  pane, Power BI Copilot tab, and the read-only viewer / PBIR provisioner ignore
  the additive config.format / config.filters extras unchanged.
- **Live side-by-side** (per ui-parity.md / no-scaffold): click every control
  against the real Power BI report editor and confirm the same outcome — DOM
  strings are not parity.
