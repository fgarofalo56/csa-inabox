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
Since the 2026-07-01 pass the builder gained a **variables + events/actions
reactivity layer** (`SlateVariable` / `SlateEventTrigger` / `SlateEventEffect`,
`slate-app-builder.tsx:71-99`, executed by `runInteractions` at `:1091-1129`),
**table row-selection** (`QueryResultTable` `selectable`/`onSelectRow`,
`:420-491`) and a **real Publish to Azure Static Web Apps** with version history
(`app/api/items/slate-app/[id]/publish/route.ts:75-96` — ARM `publishStaticSite`
→ `deployZipToStaticSite` → `waitForContentLive` → `state.versions[]`). Rows
18/21 flip ❌→✅ and rows 4/14/16/22/23/29 flip ❌→⚠️. Every row still MISSING is
now tracked (see **Tracked gaps** below) — this doc carries **one** grade, at the
end of the Loom coverage table.

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
| 1 | ✅ BUILT | Real drag-resize `CanvasWidget` (pointer-drag `startDrag` `:546`, corner `startResize` `:555`, snap-to-grid, persisted `{x,y,w,h}`) — `slate-app-builder.tsx:535-591`. Add is click-from-palette; move/resize are real drag. | — |
| 2 | ❌ MISSING | Only `mode:'design'\|'preview'`; single canvas, no page model/nav. The `navigate` effect goes to a URL, not a page. | #4363 |
| 3 | ⚠️ partial | `WidgetPalette` `:597-608` renders `KIND_META`'s 5 kinds as buttons — a flat list, not Slate's 8 categories. Widens with #4360/#4361/#4362. | #4360 |
| 4 | ⚠️ partial | Real client sort + Prev/Next paging + columns, **single-row selection** (`selectable`/`selectedRow`/`onSelectRow`, `:420-491`) feeding `onSelect` interactions, and widget-level click events. No column order/width/align, no per-cell tooltips, no transpose, no multi/checkbox selection. Server-side paging is #4364. | #4360 |
| 5 | ✅ BUILT | `LoomChart` real SVG renderer (column/bar/line/area/pie/donut/scatter) bound to live results (`:526`). | — |
| 6 | ❌ MISSING | No Map widget (`SlateWidgetKind` `:65` has no map). | #4361 |
| 7 | ❌ MISSING | No graph/tree/image widgets. | #4362 |
| 8 | ❌ MISSING | No input/control widgets. Variables can only be driven from the Variables panel or a table row-select. | #4360 |
| 9 | ❌ MISSING | No button/action/tabs/toast widgets. | #4360 |
| 10 | ⚠️ partial | `text` kind renders sanitized markdown-lite (`renderMarkdownLite :281`) with `{{var}}` interpolation; no iframe/PDF/video. | #4360 |
| 11 | ❌ MISSING | `container` kind is a decorative dashed frame only (`:503-505`); does not nest child widgets. | #4363 |
| 12 | ✅ BUILT | `QueriesPanel :843` — add/edit/remove named queries, type dropdown (datasource picker), per-query **Run** executes the real route. | — |
| 13 | ⚠️ 3 of 5 | `rest-dab` (HTTP-JSON), `kql`, `sql` wired (`/query/run` dispatch); ontology/function not first-class. | #4364 |
| 14 | ⚠️ partial | `applyVarsToQuery :189-231` substitutes `{{var}}` **injection-safely per type** — bound `@parameters` for SQL, encoded path segments for REST, escaped literals for KQL. No Slate security helpers (`schema`/`table`/`column`/`alias`/`param`), no server-fetched user vars. | #4364 |
| 15 | ❌ MISSING | No query partials. | #4364 |
| 16 | ⚠️ partial | Auto-runs on entering Preview and re-runs on any variable change (`setRuntimeScalar :1148`); manual **Run** in Design. No conditional trigger ("deps non-null" / handlebar) and no per-query auto-vs-manual switch. | #4364 |
| 17 | ❌ MISSING | Paging/sort are in-memory client only; no `$top/$skip/OFFSET` pushed to backend. | #4364 |
| 18 | ✅ BUILT | `VariablesPanel :785-836` — add/rename/remove typed variables (`string\|number\|boolean\|date`) with defaults, a live runtime editor in Run mode, and `{{name}}` consumption in every query type. App-scope only (page scope needs #4363); no struct/object-set type (#4365). | — |
| 19 | ❌ MISSING | No transformations / filter vars. | #4365 |
| 20 | ❌ MISSING | Runtime is in-memory, re-seeded from defaults on each Preview entry (`runtimeFromDefaults :412`); nothing persists per viewer. | #4365 |
| 21 | ✅ BUILT | Per-widget event triggers wired live: `onClick`, `onSelect` (table row-select) and `onChange` (load / variable change) — `SlateEventTrigger :81`, dispatched by `runInteractions :1091`, authored in `InteractionsDialog :688`. `didOpen`/`didClose` have no analog until containers/dialogs land (#4363). | — |
| 22 | ⚠️ 4 of 6 | `setVariable` (literal or selected-row column), `runQuery` (refresh preview), `navigate` (interpolated URL) and `writeBack` (POST) all execute for real in Preview — `:1097-1128`. No toast effect and no run-Function effect. | #4360 |
| 23 | ⚠️ partial | The `writeBack` effect POSTs the chosen variables as JSON to the app's DAB/APIM REST base and surfaces the real HTTP status (`:1110-1126`). No ontology object create/update/delete, no column-derived action form. | #4367 |
| 24 | ✅ BUILT | `runPreview :1074` executes each bound widget's query against the real backend; `WidgetView :493-531` renders live rows with Spinner / honest-gate / error / empty states. | — |
| 25 | ❌ MISSING | Inspector exposes title / bound query / chart type / aggregation / text / interactions only (`:613-686`); no per-widget CSS, no app stylesheet. | #4366 |
| 26 | ❌ MISSING | No custom HTML/CSS/JS authoring surface, no custom widget sets. | #4366 |
| 27 | ❌ MISSING | Only an `apiBaseUrl` data-base field; no app parameters / module interface. | #4367 |
| 28 | ❌ MISSING | No public-app / upload support. | #4367 |
| 29 | ⚠️ partial | **Real** publish: `publish/route.ts:75-96` provisions/updates `Microsoft.Web/staticSites` via ARM, zip-deploys the generated bundle, polls `waitForContentLive`, and appends a version record to Cosmos `state.versions[]`; the editor renders the version table + "Open live app" (`palantir/slate-app-editor.tsx:195-231`). No import/export/duplicate, no kiosk/redact mode. | #4367 |
| 30 | n/a | Out of scope for this editor (Loom Marketplace is separate). | — |
| 31 | ❌ MISSING | Only a property inspector; no debug/dependency/perf surface. | #4368 |
| 32 | ❌ MISSING | `state.lastGeneratedAt` / `state.lastPublishedAt` are written, but there is no usage/edit-history UI. | #4368 |

## Grade

**Grade today: ~C+.** Counting the 31 in-scope rows (30 is n/a): **6 ✅ BUILT**
(1, 5, 12, 18, 21, 24), **9 ⚠️ partial** (3, 4, 10, 13, 14, 16, 22, 23, 29),
**16 ❌ MISSING** (2, 6, 7, 8, 9, 11, 15, 17, 19, 20, 25, 26, 27, 28, 31, 32).
`ui-parity.md` grades a surface **A only at zero ❌**, so slate-app cannot be A
until the sixteen rows below land.

What is genuinely real today, verified against code on 2026-09-07: a drag-resize
canvas; a multi-type query engine (`/query/run` → `kusto-client` ADX /
`synapse-sql-client` Synapse serverless / DAB-APIM REST) with injection-safe
`{{var}}` binding; typed app variables with a live runtime; per-widget
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

| Issue | Rows | Size | Gap |
|---|---|---|---|
| #4360 | 8, 9 (+3, 4, 10, 22) | M | Control / input and action widgets — text, numeric, date, dropdown, button, tabs, toast |
| #4361 | 6 | M | Map widget on Azure Maps (location / heatmap / shape / choropleth) |
| #4362 | 7 | M | Graph / tree / image-gallery widgets |
| #4363 | 2, 11 | M | Multi-page apps and real container nesting |
| #4364 | 14, 15, 16, 17 (+13) | M | Handlebars query helpers, partials, conditional triggers, server-side paging/sort |
| #4365 | 19, 20 | M | Variable transformations, object-set filter variables, per-user persisted storage |
| #4366 | 25, 26 | M | Per-widget styles, global stylesheet, custom HTML/Handlebars widget |
| #4367 | 27, 28, 29 (+23) | M | App parameters / module interface, public apps, import-export-duplicate, kiosk mode |
| #4368 | 31, 32 | M | Dependency/debug inspector and usage metrics / edit history |

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

Boundaries: this doc is a code-vs-Slate comparison and is boundary-independent —
every backend named above (ADX, Synapse serverless, DAB/APIM, Cosmos, ARM Static
Web Apps, Azure Maps) exists in Commercial and Azure Government. It carries **no
per-cloud runtime receipt**; per `cloud-parity.md` the sub-issues above must each
state which boundaries they were verified against.
