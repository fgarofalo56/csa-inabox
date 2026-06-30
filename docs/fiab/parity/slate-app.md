# slate-app — parity with Palantir Foundry Slate (advanced dashboard/app builder)

Source UI: Palantir Foundry **Slate** — https://www.palantir.com/docs/foundry/slate/overview
- Queries: https://www.palantir.com/docs/foundry/slate/concepts-queries
- Variables: https://www.palantir.com/docs/foundry/slate/concepts-variables
- Widgets / visualization: https://palantirfoundation.org/docs/foundry/slate/widgets-visualization
- Read/write: https://palantirfoundation.org/docs/foundry/slate/read-write-overview

Editor: `apps/fiab-console/lib/editors/palantir-editors.tsx` → `SlateAppEditor`
Routes: `app/api/items/slate-app/route.ts`, `app/api/items/slate-app/[id]/route.ts`, `app/api/items/slate-app/[id]/generate/route.ts`
Codegen: `apps/fiab-console/lib/editors/_palantir-codegen.ts` → `generateSlateBundle`
Catalog: `slate-app` / restType `SlateApp` / category **Fabric IQ** (preview)

Slate is Foundry's **pro-code application builder**: a drag-and-drop widget grid, a first-class
Queries panel (Ontology / Function / SQL / HTTP-JSON), a Variables + Events/Actions reactivity
engine, per-widget HTML/CSS/JS customization, and publish/versioning. Loom's current editor is a
**single-page widget list + static-code generator** — roughly 10% of the real surface. This doc
inventories the full product and maps every gap to an Azure-native build (no Microsoft Fabric on
the default path, per `.claude/rules/no-fabric-dependency.md`).

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

| # | Status | Notes |
|---|---|---|
| 1 | ❌ MISSING | No canvas. Widgets render as a flat vertical list of rows; no place/move/resize. |
| 2 | ❌ MISSING | Single implicit page only. |
| 3 | ❌ MISSING | No palette. One "Add widget" add-bar with a 3-value Kind dropdown. |
| 4 | ⚠️ partial | "table" kind exists but is just a title + REST path; no columns/sort/paging/selection config, no in-editor render. |
| 5 | ⚠️ partial | "chart" + "metric" kinds exist as labels only; the generated bundle renders chart as a plain HTML table (no real chart); no subtypes. |
| 6 | ❌ MISSING | No Map widget. |
| 7 | ❌ MISSING | No graph/tree/image widgets. |
| 8 | ❌ MISSING | No input/control widgets. |
| 9 | ❌ MISSING | No button/action/tabs/toast widgets. |
| 10 | ❌ MISSING | No text/markdown/iframe/media widgets. |
| 11 | ❌ MISSING | No container/layout nesting. |
| 12 | ❌ MISSING | No Queries panel. Each widget carries a single freeform "Query path" string appended to `apiBaseUrl`. |
| 13 | ❌ MISSING | Only "REST path concat" — no SQL/KQL/Function/object-set query types, no editor. |
| 14 | ❌ MISSING | No templating / variable substitution / security helpers. |
| 15 | ❌ MISSING | No query partials. |
| 16 | ❌ MISSING | No conditional run / triggers. |
| 17 | ❌ MISSING | No paging/sort wiring. |
| 18 | ❌ MISSING | No variables system. |
| 19 | ❌ MISSING | No transformations / filter vars. |
| 20 | ❌ MISSING | No per-user persistence. |
| 21 | ❌ MISSING | No events. |
| 22 | ❌ MISSING | No actions/effects. |
| 23 | ❌ MISSING | No write-back from the Slate editor (WorkshopApp has it; Slate does not). |
| 24 | ⚠️ partial | Generated bundle does `fetch(apiBase/query)` at runtime, but the editor never reads live data; no object-set/OSDK/Function integration in-editor. |
| 25 | ❌ MISSING | No style controls; the generated bundle has one hard-coded inline stylesheet. |
| 26 | ❌ MISSING | No custom HTML/CSS/JS authoring surface. |
| 27 | ❌ MISSING | No app parameters / module interface. |
| 28 | ❌ MISSING | No public-app / upload support. |
| 29 | ⚠️ partial | "Generate bundle" emits index.html/app.js/staticwebapp.config.json as **copyable text** — no actual deploy, no versions, no import/export. |
| 30 | n/a | Out of scope for this editor (Loom Marketplace is separate). |
| 31 | ❌ MISSING | No debug/dependency/perf surface. |
| 32 | ❌ MISSING | No usage/edit history. |

Honest summary: the surface is a **D (stubbed-but-real-codegen)** — it persists a widget list to
Cosmos and deterministically emits a real, deployable SWA bundle (no mocks), but it is not an app
*builder*: no canvas, no live data, no query engine, no reactivity, no deploy. ~3 of 32 inventory
rows are even partially present.

## Build plan

Azure-native backends only on the default path. Fabric/Power BI strictly opt-in (none needed here).

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

11. **Map widget on Azure Maps.** Location / heatmap / shape (GeoJSON) / choropleth layers via the
    **Azure Maps Web SDK** (`azure-maps-control`). Backend: new `GET /api/items/slate-app/[id]/maps-token`
    issuing an Azure Maps token from an Azure Maps account (`AZURE_MAPS_*`); honest gate if unset.
    (Parity for the Map page in Fabric IQ; no Fabric dependency.)

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
| Map | Azure Maps Web SDK + Azure Maps token route |
| Usage/debug | Azure Monitor (optional) + Preview run telemetry |
| Persistence | Cosmos (existing item PATCH/GET) |

None of the above touches `api.fabric.microsoft.com` / `api.powerbi.com` / OneLake on the default
path. A Fabric backend is not required for any row.

Grade today: **D**. Target: **A** once P0+P1 land (canvas + live query engine + reactivity +
real deploy), with P2 closing the pro-code (custom HTML/CSS, partials, Map, debug) rows.
