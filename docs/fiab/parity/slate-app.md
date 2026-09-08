<!-- parity-doc-meta
Reviewed-on: 2026-09-07
Validated-against:
  - apps/fiab-console/lib/editors/slate/slate-app-builder.tsx
  - apps/fiab-console/lib/editors/palantir/slate-app-editor.tsx
  - apps/fiab-console/lib/editors/_palantir-codegen.ts
  - apps/fiab-console/app/api/items/slate-app
  - apps/fiab-console/lib/azure/swa-publish.ts
  - apps/fiab-console/lib/azure/maps-client.ts
  - platform/fiab/bicep/modules/admin-plane/swa-publish-rbac.bicep
-->

# slate-app — parity with Palantir Foundry Slate (advanced dashboard/app builder)

Source UI: Palantir Foundry **Slate** — https://www.palantir.com/docs/foundry/slate/overview
- Queries: https://www.palantir.com/docs/foundry/slate/concepts-queries
- Variables: https://www.palantir.com/docs/foundry/slate/concepts-variables
- Widgets / visualization: https://palantirfoundation.org/docs/foundry/slate/widgets-visualization
- Read/write: https://palantirfoundation.org/docs/foundry/slate/read-write-overview

Editor: `apps/fiab-console/lib/editors/palantir-editors.tsx` → `SlateAppEditor`
(delegates to `apps/fiab-console/lib/editors/slate/slate-app-builder.tsx`)
Routes: `app/api/items/slate-app/route.ts`, `app/api/items/slate-app/[id]/route.ts`, `app/api/items/slate-app/[id]/query/run/route.ts` (live query engine), `app/api/items/slate-app/[id]/generate/route.ts`
Codegen: `apps/fiab-console/lib/editors/_palantir-codegen.ts` → `generateSlateBundle`
Catalog: `slate-app` / restType `SlateApp` / category **Fabric IQ** (preview)

**Last verified: 2026-09-07 against current code** (previous pass 2026-07-01).
The sources this pass was read against — and the date the freshness guard
(`scripts/ci/check-parity-doc-freshness.mjs`) measures them from — are declared
in the `parity-doc-meta` block at the top of this file, so a later commit to any
of them makes this doc report itself stale instead of going quietly out of date.
Since the 2026-07-01 pass the builder gained a **variables + events/actions
reactivity layer** (`SlateVariable` / `SlateEventTrigger` / `SlateEventEffect`,
`slate-app-builder.tsx:71-99`, executed by `runInteractions` at `:1091-1129`),
**table row-selection** (`QueryResultTable` `selectable`/`onSelectRow`,
`:420-489`) and a **real Publish to Azure Static Web Apps** with version history
(`app/api/items/slate-app/[id]/publish/route.ts:75-96` — ARM `publishStaticSite`
→ `deployZipToStaticSite` → `waitForContentLive` → `state.versions[]`).

Measured against the previous revision of this file, the delta of this pass is:
row **21 flips ❌ MISSING → ✅ BUILT**, and rows **14, 16, 18, 22, 23 flip
❌ MISSING → ⚠️ partial**. Rows **4 and 29 were already ⚠️ partial** and are
**re-described, not flipped** — 4 gains real row-selection, 29 goes copy-only
bundle → real ARM deploy. Every row still MISSING is now tracked (see **Tracked
gaps** below) — this doc carries **one** grade, at the end of the Loom coverage
table.

Slate is Foundry's **pro-code application builder**: a drag-and-drop widget grid, a first-class
Queries panel (Ontology / Function / SQL / HTTP-JSON), a Variables + Events/Actions reactivity
engine, per-widget HTML/CSS/JS customization, and publish/versioning. Loom's editor now covers the
canvas, the query engine, the reactivity core and real publish; it is still a **single-page** app
builder with a five-kind widget set and no pro-code surface. This doc inventories the full product
and maps every gap to an Azure-native build (no Microsoft Fabric on the default path, per
`.claude/rules/no-fabric-dependency.md`).

## Real feature inventory

| # | Capability | Where in Slate |
|---|---|---|
| 1 | Drag-and-drop widget **grid canvas** (place / move / resize widgets) | App builder canvas |
| 2 | **Multi-page** apps (pages, per-page widgets, page navigation) | Manage applications → Pages |
| 3 | **Widget palette** organized by category: Chart, Container, Control, Platform, Text, Time, Visualization, Advanced | Widgets panel |
| 4 | **Table** widget: columns, column order/width/align, sort (client/server), paging, row selection (single/multi/checkbox), tooltips, transpose, click events | Widgets → Visualization |
| 5 | **Chart** widgets: Chart XY, Vega Chart, Pie, Gantt, Metric Card, Pivot Table, Timeline, Time-Series Analysis | Widgets → Chart/Visualization |
| 6 | **Map** widget (Leaflet): Location / Heatmap / Heatgrid / Shape (GeoJSON) / Choropleth / Vector-tile layers, base tiles, drag-selection, bounds/zoom | Widgets → Visualization |
| 7 | **Graph / Tree / Image Gallery** widgets | Widgets → Visualization |
| 8 | **Control / input** widgets: Text Input, Numeric Input, Date-Time Picker, Object Dropdown, String Selector, User Select, Filter List | Widgets → Control |
| 9 | **Action / button** widgets: Button Group, Inline Action Form, Tabs, Media Uploader, Toast, Comments | Widgets → Control/Platform |
| 10 | **Text / Markdown / Iframe / PDF / Video / Audio** display widgets | Widgets → Text/Platform |
| 11 | **Container** widget (nested layout grouping) | Widgets → Container |
| 12 | **Queries panel**: named queries, datasource picker, editor toolbar, Test/Preview, raw-JSON view | Queries |
| 13 | Query types: **Ontology/OSDK object-set**, **Foundry Function**, **API Gateway**, **legacy SQL (Postgres)**, **HTTP-JSON (REST + JSONPath extractors)** | Queries |
| 14 | **Handlebars templating** in queries with security helpers (`schema`/`table`/`column`/`alias`/`param`), server-fetched user vars | Query security |
| 15 | **Query partials** — reusable fragments with args, nestable (`{{>partial a=b}}`) | Queries → Partials |
| 16 | **Triggers & interactions** — conditional run ("all deps non-null" / "handlebar returns true"), auto vs manual | Query → Triggers tab |
| 17 | Server-side **paging / sort** params bound into queries | Table + Query |
| 18 | **Variables**: page-scope vs app-scope, string/number/boolean/struct/object-set types, defaults | Logic → Variables |
| 19 | **Variable transformations**, object-set filter variables, variable-backed layouts | Logic → Variables |
| 20 | **sl_user_storage** — per-user persisted variable across loads | Logic → Variables |
| 21 | **Events & Actions** — per-widget event triggers (click, selection-change, didOpen/didClose) | Logic → Events/Actions |
| 22 | **Action effects** — set variable, run query, navigate page, write-back (Action), open/close toast, run Function | Events/Actions index |
| 23 | **Write-back data** — Actions widget, object create/update/delete, Phonograph writeback, external systems | Read & write data |
| 24 | **Read** — object sets, retrieve individual objects, OSDK in Slate, Foundry Functions in Slate | Read & write data |
| 25 | **Styles** — per-widget CSS, global stylesheet (Experimental), complex layouts, dark theme, colors | Styles |
| 26 | **Custom HTML / Handlebars helpers** + custom widget sets (parameters + events), iframe attribute allow-list | Advanced / Custom widgets |
| 27 | **App parameters / module interface** — declare params for embedding the app in another surface | Manage → Module interface |
| 28 | **Public applications** — host on public internet, accept user uploads with validation | Manage → Enable user interaction |
| 29 | **Publish / versioning** — manage versions, merge changes, import/export/duplicate, kiosk/redact mode | Manage applications |
| 30 | **Marketplace** — add app / widget set to a Marketplace product | Marketplace |
| 31 | **Debug / dependency inspector** — view app dependencies, query/index optimization, performance profiler | Troubleshooting |
| 32 | **Usage metrics / edit history** | Troubleshooting / Manage |

## Loom coverage

| # | Status | Notes | Tracked |
|---|---|---|---|
| 1 | ✅ BUILT | Real drag-resize `CanvasWidget` (pointer-drag `startDrag` `:546`, corner `startResize` `:555`, snap-to-grid, persisted `{x,y,w,h}`) — `slate-app-builder.tsx:535-593`. Add is click-from-palette; move/resize are real drag. | — |
| 2 | ❌ MISSING | Only `mode:'design'\|'preview'`; single canvas, no page model/nav. The `navigate` effect goes to a URL, not a page. | #4363 |
| 3 | ⚠️ partial | `WidgetPalette` `:597-609` renders `KIND_META`'s 5 kinds as buttons — a flat list, not Slate's 8 categories. Widens with #4360/#4361/#4362. | #4360 |
| 4 | ⚠️ partial | Real client sort + Prev/Next paging + columns, **single-row selection** (`selectable`/`selectedRow`/`onSelectRow`, `:420-489`) feeding `onSelect` interactions, and widget-level click events. No column order/width/align, no per-cell tooltips, no transpose, no multi/checkbox selection. Server-side paging is #4364. | #4360 |
| 5 | ✅ BUILT | `LoomChart` real SVG renderer (column/bar/line/area/pie/donut/scatter) bound to live results (`:526`). | — |
| 6 | ❌ MISSING | No Map widget (`SlateWidgetKind` `:66` has no map). Must land on **both** map backends (`resolveMapsBackend`: Azure Maps **and** OSS MapLibre) — see **Boundaries** below. | #4361 |
| 7 | ❌ MISSING | No graph/tree/image widgets. | #4362 |
| 8 | ❌ MISSING | No input/control widgets. Variables can only be driven from the Variables panel or a table row-select. | #4360 |
| 9 | ❌ MISSING | No button/action/tabs/toast widgets. | #4360 |
| 10 | ⚠️ partial | `text` kind renders sanitized markdown-lite (`renderMarkdownLite :281`); no iframe/PDF/video. **`{{var}}` is NOT interpolated in widget text**: `interpolate()` is called at exactly two sites in the builder — `:1098` (setVariable literal) and `:1108` (navigate URL) — and `WidgetView :501` hands `widget.text` straight to `renderMarkdownLite(text: string) :281`, which takes no variables. The inspector hint at `:670` ("Use {{variable}} to show a live value") promises behaviour the renderer does not implement; filed as **#4374**. | #4360, #4374 |
| 11 | ❌ MISSING | `container` kind is a decorative dashed frame only (`:503-505`); does not nest child widgets. | #4363 |
| 12 | ✅ BUILT | `QueriesPanel :843` — add/edit/remove named queries, type dropdown (datasource picker), per-query **Run** executes the real route. | — |
| 13 | ⚠️ 3 of 5 | `rest-dab` (HTTP-JSON), `kql`, `sql` wired (`/query/run` dispatch); ontology/function not first-class. | #4364 |
| 14 | ⚠️ partial | `applyVarsToQuery :189-212` substitutes `{{var}}` **injection-safely per type** — bound `@parameters` for SQL, encoded path segments for REST, escaped literals for KQL. No Slate security helpers (`schema`/`table`/`column`/`alias`/`param`), no server-fetched user vars. | #4364 |
| 15 | ❌ MISSING | No query partials. | #4364 |
| 16 | ⚠️ partial | Auto-runs on entering Preview and re-runs on any variable change (`setRuntimeScalar :1148`); manual **Run** in Design. No conditional trigger ("deps non-null" / handlebar) and no per-query auto-vs-manual switch. | #4364 |
| 17 | ❌ MISSING | Paging/sort are in-memory client only; no `$top/$skip/OFFSET` pushed to backend. | #4364 |
| 18 | ⚠️ 3 of 5 | `VariablesPanel :785-837` — add/rename/remove typed variables with defaults, a live runtime editor in Run mode, and `{{name}}` consumption in every query type. The `N of M` counts **inventory row 18's five variable types**: `SlateVarType :71` is `string\|number\|boolean\|date`, so **string / number / boolean are built (3)** and **struct and object-set are absent (#4365)** — `date` is a Loom addition the Slate inventory row does not list, so it does not raise the numerator. `SlateVariable :73-79` carries no scope field: **app-scope only, no page scope (#4363)**. Defaults are built. | #4363, #4365 |
| 19 | ❌ MISSING | No transformations / filter vars. | #4365 |
| 20 | ❌ MISSING | Runtime is in-memory, re-seeded from defaults on each Preview entry (`runtimeFromDefaults :412`); nothing persists per viewer. | #4365 |
| 21 | ✅ BUILT | Per-widget event triggers wired live: `onClick`, `onSelect` (table row-select) and `onChange` — `SlateEventTrigger :81`, dispatched by `runInteractions :1091`, authored in `InteractionsDialog :688`. Narrower than Slate on one axis: **`onChange` fires on Preview entry only** (`:1143`); editing a variable re-runs the bound queries (`setRuntimeScalar :1148` → `runPreview`) but does **not** dispatch `onChange` interactions — tracked in #4360 alongside the control widgets that would drive it. `didOpen`/`didClose` have no analog until containers/dialogs land (#4363). | — |
| 22 | ⚠️ 4 of 6 | `setVariable` (literal or selected-row column), `runQuery` (refresh preview), `navigate` (interpolated URL) and `writeBack` (POST) all execute for real in Preview — `:1097-1128`. No toast effect and no run-Function effect. | #4360 |
| 23 | ⚠️ partial | The `writeBack` effect POSTs the chosen variables as JSON to the app's DAB/APIM REST base and surfaces the real HTTP status (`:1110-1126`). No ontology object create/update/delete, no column-derived action form. | #4367 |
| 24 | ✅ BUILT | `runPreview :1076` executes each bound widget's query against the real backend; `WidgetView :493-531` renders live rows with Spinner / honest-gate / error / empty states. | — |
| 25 | ❌ MISSING | Inspector exposes **seven** fields — title / bound query / chart type / aggregation / **value column** (`metricField`, `:659-664`) / text / interactions (`:613-684`); **none of them style**. No per-widget CSS, no app stylesheet. | #4366 |
| 26 | ❌ MISSING | No custom HTML/CSS/JS authoring surface, no custom widget sets. | #4366 |
| 27 | ❌ MISSING | Only an `apiBaseUrl` data-base field; no app parameters / module interface. | #4367 |
| 28 | ❌ MISSING | No public-app / upload support. | #4367 |
| 29 | ⚠️ partial | **Real** publish: `publish/route.ts:75-96` provisions/updates `Microsoft.Web/staticSites` via ARM, zip-deploys the generated bundle, polls `waitForContentLive`, and appends a version record to Cosmos `state.versions[]`; the editor renders the version table + "Open live app" (`palantir/slate-app-editor.tsx:195-229`). Two limits the word "real" does not carry: **(a) honest gate** — `publish/route.ts:48-52` returns **503 `swa_not_configured`** when `swaConfig()` (`lib/azure/swa-publish.ts:31-40`) finds `LOOM_SWA_SUBSCRIPTION_ID` / `LOOM_SWA_RESOURCE_GROUP` unset; the builder and Preview still work, only Publish is gated. **(b) the published bundle is narrower than the app** — `publish/route.ts:54-65` keeps only widgets whose query resolves to a `rest-dab` path and coerces kind to table/chart/metric, so **KQL and SQL widgets, text and container widgets, variables and interactions run in Preview but are not in the deployed site** (the editor discloses this itself at `slate-app-editor.tsx:187`). No import/export/duplicate, no kiosk/redact mode. | #4367 |
| 30 | n/a | Out of scope for this editor (Loom Marketplace is separate). | — |
| 31 | ❌ MISSING | Only a property inspector; no debug/dependency/perf surface. | #4368 |
| 32 | ❌ MISSING | `state.lastGeneratedAt` / `state.lastPublishedAt` are written, but there is no usage/edit-history UI. | #4368 |

## Grade

**Grade today: ~C+.** Counting the 31 in-scope rows (30 is n/a): **5 ✅ BUILT**
(1, 5, 12, 21, 24), **10 ⚠️ partial** (3, 4, 10, 13, 14, 16, 18, 22, 23, 29),
**16 ❌ MISSING** (2, 6, 7, 8, 9, 11, 15, 17, 19, 20, 25, 26, 27, 28, 31, 32).
`ui-parity.md` grades a surface **A only at zero ❌**, so slate-app cannot be A
until the sixteen rows below land.

Where an inventory row bundles several capabilities, this table scores it
`⚠️ N of M` rather than ✅ — rows 13 (3 of 5 query types), 18 (3 of 5 variable
types) and 22 (4 of 6 action effects) follow that rule, so a bundled row's gaps
stay visible to the "every non-BUILT row names its issue" check below. **Two
rows do not follow it yet and are called out rather than quietly left:** row 5
(inventory names 8 chart widgets; Loom has Chart-XY, Pie and Metric Card — Vega,
Gantt, Pivot Table, Timeline and Time-Series Analysis are absent) and row 24
(inventory names object sets / individual objects / OSDK / Foundry Functions;
Loom reads through the generic query engine, and row 13 says in this same table
that ontology and function query types are not first-class). This pass did not
re-score them — re-scoring both would move the counts above, and that re-derivation
is tracked in **#4384** rather than done here on an unmeasured guess.

What is genuinely real today, verified against code on 2026-09-07: a drag-resize
canvas; a multi-type query engine (`/query/run` → `kusto-client` ADX /
`synapse-sql-client` Synapse serverless / DAB-APIM REST) with injection-safe
`{{var}}` binding; scalar app variables with a live runtime; per-widget
click/row-select/load interactions driving setVariable / runQuery / navigate /
writeBack; and a real ARM Static Web Apps publish with version history. What is
absent is the breadth: one page, five widget kinds, no pro-code surface, no
debug/usage surface.

**This is the only grade in this document.** An earlier revision carried a
second, contradictory grade (a flat **D**) at the end of the build plan; it was
stale on both counts and has been removed (#3720). The invariant this file must
hold: exactly one grade line, in this section. A second one anywhere else is the
defect recurring.

## Tracked gaps

Every ❌ / ⚠️ row above is tracked. No row is left as an untracked aspiration.
The last row is the exception that proves the rule: #4384 covers rows 5 and 24,
which are ✅ BUILT and therefore carry `—` in the Tracked column — so a
row-to-issue bijection derived from that column will not contain it. It is listed
here deliberately, per the Grade section above.

| Issue | Rows | Size | Gap |
|---|---|---|---|
| #4360 | 8, 9 (+3, 4, 10, 22) | M | Control / input and action widgets — text, numeric, date, dropdown, button, tabs, toast |
| #4361 | 6 | M | Map widget — Azure Maps **and** OSS MapLibre backends (location / heatmap / shape / choropleth). Azure-Maps-only would be Commercial-only |
| #4362 | 7 | M | Graph / tree / image-gallery widgets |
| #4363 | 2, 11 (+18) | M | Multi-page apps, real container nesting, and page-scoped variables (row 18's missing scope axis) |
| #4364 | 14, 15, 16, 17 (+13) | M | Handlebars query helpers, partials, conditional triggers, server-side paging/sort |
| #4365 | 19, 20 (+18) | M | Variable transformations, object-set filter variables, per-user persisted storage, struct/object-set variable types (row 18's missing type axis) |
| #4366 | 25, 26 | M | Per-widget styles, global stylesheet, custom HTML/Handlebars widget |
| #4367 | 27, 28, 29 (+23) | M | App parameters / module interface, public apps, import-export-duplicate, kiosk mode |
| #4368 | 31, 32 | M | Dependency/debug inspector and usage metrics / edit history |
| #4374 | 10 | S | **Defect, not a gap:** the inspector hint at `:670` promises `{{variable}}` interpolation in text widgets that `renderMarkdownLite` never performs — implement it, or delete the sentence |
| #4384 | 5, 24 | S | **Doc-scoring debt:** rows 5 and 24 are ✅ BUILT against bundled inventory rows whose sub-capabilities are not all present — re-derive both against code and re-state the grade counts |

## Build plan

Azure-native backends only on the default path. Fabric/Power BI strictly opt-in (none needed here).

Status as of 2026-09-07 — the plan below is the original design; items are
annotated with what has actually landed:

| Item | Status |
|---|---|
| P0-1 live preview · P0-2 query engine · P0-3 drag-resize canvas | **LANDED** (rows 1, 12, 24) |
| P0-4 typed widget set | **PARTIAL** — table / chart / metric / text / container only; controls, buttons, iframe and tabs are #4360 |
| P1-5 variables + events/actions | **LANDED for the scalar/effect core** (rows 18, 21, 22) — helpers, partials and conditional triggers are #4364; transformations and per-user storage are #4365 |
| P1-6 write-back | **PARTIAL** — generic REST POST effect only; ontology object CRUD is #4367 |
| P1-7 multi-page | **NOT STARTED** — #4363 |
| P1-8 publish → Azure Static Web Apps | **LANDED** (real ARM provision + zip deploy + versions); import/export/duplicate and kiosk are #4367 |
| P2-9 custom CSS/HTML | **NOT STARTED** — #4366 |
| P2-10 partials + app parameters | **NOT STARTED** — #4364 / #4367 |
| P2-11 Map on Azure Maps | **NOT STARTED** — #4361 |
| P2-12 debug / dependency inspector | **NOT STARTED** — #4368 |

### P0 — make it an actual app builder (visible parity uplift)

1. **Live in-editor app preview (Run mode).** A `Design | Preview` tab pair. Preview renders the
   real widgets bound to **live query results** inside the editor (today it only emits static
   files). UI: `PageShell` with a Design canvas + a Preview pane; per-widget `Spinner`/`Skeleton`
   while its query runs; `EmptyState` when unbound. Backend: new `POST /api/items/slate-app/[id]/query/run`
   (below) per widget — no mock data.

2. **Multi-type Query engine + Queries panel.** Named queries with a **type dropdown**:
   `rest-dab` (HTTP-JSON: path/method/queryParams/headers/JSONPath extractor — mirrors Slate's
   HTTP-JSON shape), `kql` (ADX), `sql` (Synapse serverless), `ontology` (object-set over a bound
   ontology's DAB/warehouse). Monaco editor for SQL/KQL, structured Fluent `Field` form for REST.
   "Run / Preview" shows a real result `Table`. UI: a Queries side-rail (list + add dialog) reusing
   the editor's section cards. Backend: `POST /api/items/slate-app/[id]/query/run` dispatching to
   `kusto-client` (ADX), `synapse-sql-client` (serverless SQL), or DAB/APIM REST — all already in
   the repo. Persist queries to `state.queries[]` via the existing PATCH.

3. **Drag-resize widget canvas + typed widget palette.** Replace the vertical row list with a
   bounded grid canvas (Loom already ships drag-resizable canvases / `canvas-node-kit.tsx`). Left
   rail = categorized palette (Visualization / Control / Text / Container / Advanced); center =
   grid; right = property inspector. Each widget gets `layout {x,y,w,h}` persisted to
   `state.pages[].widgets[]`. UI: Loom tokens, `TileGrid`-bounded canvas, Fluent property forms
   (never freeform). Backend: Cosmos via existing item PATCH.

4. **Real typed widget set + rendering.** Build the high-value widgets with real renderers bound to
   query outputs: **Table** (columns/sort/paging/row-select), **Chart** (bar/line/area/pie/scatter
   via the repo's charting lib), **Metric card**, **Text/Markdown**, **Input controls** (text /
   numeric / dropdown / date), **Button**, **Iframe**, **Container/Tabs**. UI: per-widget property
   panel (Fluent `Field`/`Dropdown`/`Switch`). Backend: data from `/query/run`; charts client-side.

### P1 — reactivity, write-back, real deploy

5. **Variables + Events/Actions reactivity.** A Variables panel (name / scope page|app / type
   string|number|boolean|object|object-set / default) and a per-widget **Interactions** dialog
   (event `onClick|onSelect|onChange` → effect `setVariable|runQuery|navigatePage|writeBack|showToast`).
   Queries consume `{{var}}` via **server-side, injection-safe substitution** mirroring Slate's
   `param`/`schema`/`table` helpers. UI: dropdown-driven (no JSON). Backend: substitution in
   `/query/run` (parameterized ADX/SQL); effects run in the Preview runtime; persist to `state`.

6. **Write-back / Actions widget (real warehouse write).** Button/inline-action widgets that
   create/update/delete against a bound ontology's warehouse — reuse the proven WorkshopApp
   pattern. Backend: `POST /api/items/slate-app/[id]/run-action` (or share `workshop-app/run-action`)
   → `synapse-sql-client` against the Synapse dedicated/serverless pool. Honest gate if no ontology
   binding. UI: a write-back action form derived from real columns (no freeform SQL).

7. **Multi-page apps.** Page tab strip (add / rename / delete / reorder) with per-page widget
   sets and a `navigatePage` action. UI: Fluent `TabList` page strip. Backend: `state.pages[]`.

8. **Real Publish → Azure Static Web Apps (replace copy-only).** Actually deploy the generated
   bundle and return a **live URL** + version history, instead of emitting copyable text. UI: a
   Publish dialog with deploy status (`Spinner` → success `MessageBar` with URL), version table,
   and Import/Export/Duplicate. Backend: new `POST /api/items/slate-app/[id]/publish` using ARM
   `Microsoft.Web/staticSites` + the SWA deployment API (deployment token), or fall back to ACA
   static hosting; honest `MessageBar` gate naming `LOOM_SWA_*` env if unset. Versions persisted to
   Cosmos.

### P2 — pro-code surface + lifecycle polish

9. **Custom CSS / theme + Custom-HTML (Handlebars) advanced widget.** Per-widget CSS + a global
   stylesheet + an Advanced "Custom HTML" widget with Handlebars templating, rendered in a
   sandboxed iframe in Preview and injected into the SWA bundle. UI: Monaco CSS/HTML editors in the
   property panel. Backend: persisted to `state`; sandboxed render.

10. **Query partials + app parameters / module interface.** Reusable query fragments with args
    (`{{>partial}}`) and declared app-level parameters consumable when the app is embedded
    (querystring binding in Preview + SWA). UI: Partials list + Parameters panel. Backend:
    substitution in `/query/run`; params in `state`.

11. **Map widget — two backends, not one.** Location / heatmap / shape (GeoJSON) / choropleth layers.
    Backend selection goes through the existing `resolveMapsBackend`
    (`lib/azure/maps-client.ts:152`): **Azure Maps Web SDK** (`azure-maps-control`, `mode:'aad'|'key'`)
    via a new `GET /api/items/slate-app/[id]/maps-token`, **and** the OSS **MapLibre** path
    (`LOOM_MAPS_BACKEND=maplibre`, `mode:'maplibre'`) over the in-VNet `tileserver-gl` proxied at
    `/api/maps/tiles/*`. Azure Maps has limited Gov availability (`maps-client.ts:96`), so the
    MapLibre path is what makes this row shippable in GCC-High / sovereign boundaries —
    Azure-Maps-only would be Commercial-only, which `cloud-parity.md` calls INCOMPLETE.
    Honest gate if neither backend is wired. (No Fabric dependency.)

12. **Debug / dependency inspector + usage.** A Dependencies panel rendering the widget→query→variable
    graph (reuse `canvas-node-kit`) plus per-widget load timing/errors from the Preview run, and
    optional usage from Azure Monitor. UI: graph + table. Backend: computed from `state` + preview
    telemetry.

## Backend per control (target)

| Control | Azure-native backend (default) |
|---|---|
| Query: REST/DAB | Data API Builder / APIM REST (`fetch` with session creds) |
| Query: KQL | `kusto-client` → Azure Data Explorer (ADX) |
| Query: SQL | `synapse-sql-client` → Synapse serverless SQL |
| Query: object-set | bound ontology → DAB/warehouse (Synapse pool) |
| Write-back action | `synapse-sql-client` → Synapse SQL pool (shared with WorkshopApp `/run-action`) |
| Variable substitution | server-side parameterized binding (injection-safe helpers) |
| Publish | ARM `Microsoft.Web/staticSites` + SWA deployment token (ACA static fallback) |
| Map | `resolveMapsBackend` → Azure Maps Web SDK + token route (Commercial) **or** OSS MapLibre / `tileserver-gl` proxy (sovereign — Azure Maps has limited Gov availability) |
| Usage/debug | Azure Monitor (optional) + Preview run telemetry |
| Persistence | Cosmos (existing item PATCH/GET) |

None of the above touches `api.fabric.microsoft.com` / `api.powerbi.com` / OneLake on the default
path. A Fabric backend is not required for any row.

## Boundaries (cloud parity)

This doc is a code-vs-Slate comparison **read from source**. **No cloud was
exercised for it — neither Commercial nor Azure Government.** It therefore
carries **no per-cloud runtime receipt**, and nothing here should be read as a
claim that a path has been observed running in a given boundary.

Availability of the backends named above, taken from the repo's own records
rather than assumed. Column labels are the source's own — `GOV_SERVICE_MATRIX.md`
scores **Commercial / Gov FedRAMP High / Gov IL4 / Gov IL5 (/ Gov IL6)**, which
is not the same vocabulary the bicep uses (`Commercial / GCC / GCC-High / IL5`):

| Backend | Boundary availability | Source in this repo |
|---|---|---|
| Azure Synapse Analytics | GA in Commercial, Gov FedRAMP High, IL4, IL5; **N/A at IL6 (Secret)** | `docs/GOV_SERVICE_MATRIX.md:52` |
| Azure Data Explorer (ADX) | GA in Commercial, Gov FedRAMP High, IL4, IL5; **N/A at IL6 (Secret)** | `docs/GOV_SERVICE_MATRIX.md:55` |
| API Management (APIM) | GA in Commercial, Gov FedRAMP High, IL4, IL5; **N/A at IL6 (Secret)** | `docs/GOV_SERVICE_MATRIX.md:62` |
| Static Web Apps (publish) | GA in Commercial, Gov FedRAMP High, IL4, IL5 (that table scores no IL6) | `docs/GOV_SERVICE_MATRIX.md:78` |
| Cosmos DB (persistence) | GA in Commercial, Gov FedRAMP High, IL4, IL5 (that table scores no IL6) | `docs/GOV_SERVICE_MATRIX.md:99` |
| Data API Builder (DAB) | OSS, container-hosted by Loom — boundary-independent | — |
| **Azure Maps** | **NOT parity-clean.** `maps-client.ts:96` records "Azure Maps has limited Gov availability", and `GOV_SERVICE_MATRIX.md` does not score it at all (zero matches for "maps"; positive control: 36 matches for "GA" in the same file). | `maps-client.ts:96` |

The publish path's role grant is boundary-aware in bicep, but in the **opposite**
direction to what a "Gov gets a different role" reading suggests, and the
distinction matters to anyone debugging a Gov publish 403:
`platform/fiab/bicep/modules/admin-plane/swa-publish-rbac.bicep` computes a role
swap at `:99` (`effectiveSwaRoleId` — Contributor instead of Website Contributor
for `GCC-High`/`IL5`), and then **never evaluates it in a sovereign boundary**:
`sovereignRedundant :105` is true for exactly those two values and gates the
single role-assignment resource at `:107`
(`if (!empty(consolePrincipalId) && !skipRoleGrants && !sovereignRedundant)`).
So in `GCC-High`/`IL5` this module emits **zero** role assignments — the core
RBAC grants already cover the permission there, and re-creating it tripped
`RoleAssignmentExists` on a live usgovvirginia deploy on 2026-07-10 (recorded in
that file's header, `:38-44`). That header also records that the earlier
"Website Contributor does not resolve in Azure Government" diagnosis was **wrong**
— the same assignment then failed on Commercial with the same GUID — and states
that whether Gov could use Website Contributor is **unsettled** and needs a real
Gov deploy. Nothing in this doc settles it. Note the file contradicts itself on
this point: the `boundary` param's own `@description` at `:82` still gives the
superseded Gov explanation, which is filed as **#4385**. All of the above is a
**code** receipt read from source — no Gov deploy was run for this doc.

Loom's sovereign answer for maps already exists and is **not** Azure Maps:
`LOOM_MAPS_BACKEND=maplibre` routes every map surface to a self-hosted OSS
`tileserver-gl` Container App on internal ingress, fronted by the
session-guarded proxy `/api/maps/tiles/*` (`maps-client.ts:47-93`,
`isMapLibreConfigured :89`, returned as `mode:'maplibre'` by
`resolveMapsBackend :152`).

**Consequence for row 6:** the Map widget must resolve its backend through
`resolveMapsBackend` — Azure Maps (`aad`/`key`) **and** MapLibre — not Azure
Maps alone. An Azure-Maps-only Map widget would be Commercial-only by
construction, which `cloud-parity.md` calls INCOMPLETE, not "Commercial-first".
#4361's original body specified only the Azure Maps Web SDK; that requirement
is recorded as a comment on the issue.

Per `cloud-parity.md`, each sub-issue above must state which boundaries it was
verified against when it lands. Commercial green proves nothing about Gov.
