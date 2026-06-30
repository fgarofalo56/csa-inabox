# workshop-app (Atelier) — parity with Palantir Foundry Workshop (low-code operational app builder)

Source UI:
- **Palantir Foundry Workshop** — ontology-bound, low-code operational app
  builder. A visual page/layout designer + widget library; widgets bind to
  object sets, read/write **variables**, fire **events** that run **actions**
  (write-back) and navigate. Build → Preview → Publish.
  - Concepts: <https://www.palantir.com/docs/foundry/workshop/concepts-widgets>,
    <https://www.palantir.com/docs/foundry/workshop/concepts-layouts>,
    <https://www.palantir.com/docs/foundry/workshop/concepts-variables>,
    <https://www.palantir.com/docs/foundry/workshop/concepts-events>,
    <https://www.palantir.com/docs/foundry/workshop/actions-use>
- Microsoft **Fabric Apps** (a.k.a. internal "Rayfin") is the secondary
  reference — real CRUD via GraphQL over "SQL database in Fabric". Tracked
  separately under `rayfin-app`.

> **No hard Fabric dependency.** Per `no-fabric-dependency.md` the default
> backend is **Azure-native**: layout/variables/events persist in **Cosmos**
> (item `state`); object-set reads + write-back run real **T-SQL against the
> Synapse dedicated SQL pool** (`lib/azure/synapse-sql-client.ts`); charts/KPIs
> run aggregate T-SQL; maps use **Azure Maps** (`lib/azure/maps-client.ts`);
> the AIP-equivalent copilot uses **Azure OpenAI** (`aoai-chat-client`);
> publish targets **Azure Container Apps + Data API Builder + APIM**. Fabric /
> Power BI are strictly opt-in. Everything works with
> `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

---

## Real feature inventory (Palantir Workshop — exhaustive)

### A. Build experience / app shell
1. **Pages** — a module has one or more named pages; top page nav; variable-based page selection.
2. **Layout designer** — drag widgets from a palette onto a WYSIWYG canvas; arrange in **sections**; resize.
3. **Sections** — split layouts (rows/columns), collapsible sections, section **toolbar**, section header, drop zones.
4. **Tabs** — section-level tab strips; variable-based tab selection.
5. **Overlays** — **drawers** and **modals** opened/closed by events.
6. **Loop / Flow layouts** — repeat a section template per object in a set.
7. **Header** — module header bar.
8. **Preview mode** — live-run the app against real data (filters/events active), distinct from edit mode.
9. **Publish / share** — publish the module; control audience/permissions; deep-link with variable mapping.

### B. Widget library
- **Core display:** Object Table, Object List, Object View, Property List, Links, Object Set Title.
- **Visualization:** Chart XY, Pie Chart, Vega Chart, Map (+ legacy), Gantt Chart, Pivot Table, Metric Card, Timeline, Stepper, Markdown, Resource List, Media Preview, Spreadsheet Display, Video/Audio/Transcription Display, PDF Viewer, Image Annotation, Free-form Analysis, Time Series Analysis, Data Freshness, Edit History, Action Log Timeline.
- **Filtering / input:** Filter List, Object Dropdown, String Selector, Date & Time Picker, Text Input, Numeric Input, Exploration Filter Pills, Exploration Search Bar, Prominent Term, User Select.
- **Event-trigger & navigation:** Button Group, Tabs, Inline Action, Media Uploader, Audio Recorder, Comments.
- **AIP:** AIP Analyst, AIP Chatbot, AIP Generated Content.
- **Embed / custom:** Iframe, Custom (iframe-OSDK) widgets, Embedded modules.
- **Scenario:** Scenario Manager, Scenario Selector, Scenario Summary.
- **Mobile:** Mobile Navigation Bar, QR Code Reader, Current Location Manager.

### C. Variables + state
10. **Variables panel** — typed variables: object set, object-set filter, string, number, boolean, date/time, array, scenario.
11. **Defaults, recompute modes, lineage graph** — variables read/written by widgets; recompute (Automatic / on-event); reset; set-value; stream-LLM-into-variable.
12. **Object-set filter variables** — filter widgets emit them; tables/charts consume them as the displayed object set.

### D. Events + actions (wiring)
13. **Event triggers** — button click, table **row selection**, dropdown select/deselect, tab switch, page load.
14. **Event effects** — Set/Reset/Recompute variable, Run **Action** (ontology write-back create/edit/delete/link), Open/Close overlay, Switch page/tab, Expand/collapse section, Open another module/object view (with variable mapping), Refresh module data, Toggle theme, Send to AIP Assist, Stream LLM into variable, Export.
15. **Actions** — typed ontology actions (create / modify / delete / link objects) with parameter forms, validation, and write-back; submission rules.
16. **Conditional visibility** — show/hide widgets & sections by variable predicate; conditional formatting.

---

## Loom coverage

| # | Capability | Loom coverage | Backend / route |
|---|------------|---------------|-----------------|
| – | Bind a Loom Ontology | ✅ built | `bind-ontology` → Cosmos + Thread edge |
| – | Pick entity types → "object views" (list toggle) | ✅ built | editor state |
| – | Object Table **read** (list rows) | ✅ built | `run-action` `op:list` → `SELECT TOP` (Synapse) |
| – | Read single row (get) | ✅ built | `run-action` `op:get` |
| – | Write-back **create/update/delete** via column-derived form | ✅ built | `run-action` `op:create/update/delete` (parameterised T-SQL) |
| – | Writes constrained to ontology shape; SQL-injection-safe | ✅ built | `safeSqlIdent` + `writableColumns`/`keyColumns` |
| – | Lineage on write-back | ✅ built | `recordThreadEdge` |
| A1 | Multi-page app | ❌ MISSING | — |
| A2/A3 | Visual layout designer + sections (rows/cols, drop zones) | ❌ MISSING | — |
| A4/A5 | Tabs + overlays (drawer/modal) | ❌ MISSING | — |
| A6 | Loop/flow layouts | ❌ MISSING | — |
| A8 | **Preview / run mode** (live app distinct from editor) | ❌ MISSING | — |
| A9 | **Publish / share** the app | ⚠️ partial (Data-API-Builder wiring banner only) | needs ACA/DAB/APIM publish |
| B | **Widget library** (table/form already real; chart/KPI/map/filter/markdown/object-view/links/tabs/button) | ❌ MISSING (only an implicit table + action form) | — |
| C10–C12 | **Variables + state**; object-set filter variables | ❌ MISSING | — |
| D13/D14 | **Event → effect wiring** (row-select, page-load, set-var, navigate, open overlay) | ❌ MISSING | — |
| D15 | Typed Actions w/ parameter form + validation | ⚠️ partial (free column form, no typed params/validation rules) | `run-action` |
| D16 | Conditional visibility / formatting | ❌ MISSING | — |
| B-AIP | AIP-equivalent copilot widget | ❌ MISSING | (Azure OpenAI available) |
| B-scenario | Scenario / what-if | ❌ MISSING | — |

**Honest assessment:** the current editor is a single scrolling config form
(bind ontology → toggle which entities list → add CRUD actions → run a dialog).
The write path is genuinely real (parameterised T-SQL on Synapse, injection-safe,
ontology-bound) — that is its strength. But it is **not an app builder**: there
is no canvas, no widget palette, no variables, no event wiring, no preview, no
charts/maps/filters, no multi-page layout, no publish. Against Workshop it is
roughly **15% of the surface** — a CRUD console, not a low-code operational app.

---

## Build plan (prioritized, Azure-native, web5)

### P0 — turn the CRUD console into an app builder
1. **Builder shell + visual layout designer** — three-pane `PageShell`: left widget
   palette (`TileGrid` of widget cards by category), center WYSIWYG canvas
   (sections w/ drop zones via `@dnd-kit`, reusing `canvas-node-kit` styling +
   `--loom-*` tokens), right properties panel for the selected widget; top page
   tab-strip; ribbon `Save / Preview / Publish`. Persist layout tree as
   `state.pages[]` JSON in **Cosmos** via existing PATCH route.
2. **Widget library (core set)** — Object Table, Property-List **Form**, **Button**,
   **Filter**, **Chart**, **Metric/KPI Card**, **Markdown**, **Object View**, **Tabs/Section**.
   Reads run on existing `run-action op:list/get` (Synapse); aggregates on a new
   `op:'aggregate'` (GROUP BY) op; charts reuse `lib/components/charts/loom-chart.tsx` +
   `foundry-charts.tsx`; KPI = single-value aggregate.
3. **Variables + state** — typed Variables panel (object-set / string / number /
   boolean / date) with default-value typed controls (no JSON). Object-set-filter
   variables resolve to a parameterised `WHERE` applied server-side in `run-action`.
   Persist `state.variables[]` in Cosmos.
4. **Event → effect wiring** — per-widget structured event builder (trigger
   dropdown → effect dropdown → target dropdown): button-click / row-select /
   page-load → set-variable / run-action / navigate-page-tab / open-overlay /
   refresh. Persist `state` config; execute client-side in Preview; "run action"
   calls existing `run-action`.
5. **Preview / run mode** — ribbon toggle renders the page tree interactive
   (widgets fetch real data, filters & events live). All reads real (Synapse);
   no mock.

### P1 — depth
6. **Filter widgets → object-set variables** — Filter List, Object Dropdown,
   String Selector, Date picker, Numeric/Text input (Fluent `Dropdown`/`DatePicker`/
   `SpinButton`/`SearchBox`) emit object-set-filter variables. New server filter
   predicates (column/op/value) on `run-action`, validated via `safeSqlIdent` + TDS params.
7. **Charts & visualizations** — Chart XY, Pie, Pivot Table, Metric Card, Gantt,
   Timeline via `op:'aggregate'` GROUP BY on Synapse; reuse `loom-chart`.
8. **Map widget** — Azure Maps Web SDK via `lib/azure/maps-client.ts` + `map-token`
   route; pins from lat/long columns; honest gate on `LOOM_AZURE_MAPS_*`.
9. **Object View + Links** — detail panel (`op:get`) + Links widget traversing the
   ontology's link bindings via a new join op `op:'list-links'` (Synapse).
10. **Sections / tabs / overlays / multi-page** — page manager, collapsible
    sections, drawer/modal overlays; layout JSON in Cosmos.
11. **Conditional visibility / formatting** — per-widget "Visible when" + cell
    format rule builder (variable / operator / value); client-side eval.
12. **Publish** — Publish dialog (audience, RBAC); writes a published snapshot to
    Cosmos and optionally deploys the app to **ACA + Data API Builder + APIM**
    (reuse the rayfin/data-app deploy path); honest gate when ACA env unset.

### P2 — advanced
13. **AIP-equivalent copilot widget** — ask-over-object-set + generate-into-variable
    via **Azure OpenAI** (`aoai-chat-client`, SSE), grounded on the bound object set.
14. **Iframe / custom / embedded-module widgets** — CSP-safe iframe + postMessage
    variable bridge; embed another Loom item.
15. **Scenario / what-if manager** — staged edits buffered in a Cosmos scenario doc,
    commit applies the batch to Synapse.
16. **Media/document widgets + Comments + Uploader** — PDF/Media/Image-annotation/
    Spreadsheet over **ADLS Gen2 / Blob SAS**; comments in Cosmos.

---

## Verification per surface (per `no-vaporware.md` / `ui-parity.md`)
- Builder works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset (Azure-native default).
- Every widget renders real Synapse/Azure-Maps/AOAI data or a styled honest gate.
- Live side-by-side click-through against Palantir Workshop; screenshots in PR.
- Existing tests retained: `run-action/__tests__/route.test.ts`,
  `_family-utils.test.ts`; add layout-persist + aggregate-op + event-exec tests.
