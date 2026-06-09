# report — parity with Power BI report (service viewer)

Source UI: Power BI service report viewer — https://learn.microsoft.com/power-bi/consumer/end-user-reading-view ·
REST: https://learn.microsoft.com/rest/api/power-bi/reports
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` → `ReportEditor`
Embed: `apps/fiab-console/lib/components/embed/powerbi-embed.tsx`

## Backend selection (no-fabric-dependency.md)

The Report editor has **two backends**, selected by `NEXT_PUBLIC_LOOM_BI_BACKEND`
(server-side `LOOM_BI_BACKEND`):

| Backend | Selector | Renderer | Dependency |
|---|---|---|---|
| **Loom-native (DEFAULT)** | unset / `''` | `LoomNativeReportEditor` — queries the bound Azure Analysis Services tabular model with DAX (`POST /api/items/report/[id]/query`) and renders rows | **NONE** — no Power BI / Fabric workspace. AAS only. |
| Power BI (opt-in) | `powerbi` | `ReportLikeEditor` — live Power BI embed | Console UAMI registered in a Power BI workspace |

The default path renders real rows from AAS with `LOOM_BI_BACKEND` **unset** and
**no** Power BI / Fabric workspace bound. `api.powerbi.com` is never reached on
the default path (grep gate clean).

## Loom-native renderer feature coverage (DEFAULT path — AAS)

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | Report definition load | built | `GET /api/items/report/[id]` → `{ report, aasServer, aasDatabase, pages }` from Cosmos state.content (no workspaceId needed) |
| 2 | Page navigation | built | Pages panel (left tree) + Home → View ribbon page picker; `setActivePage(i)` |
| 3 | Visual render (card) | built | `card` visual → single DAX `ROW("Value", <field>)` → big-number tile |
| 4 | Visual render (table/chart) | built | `table`/`bar`/`line`/`pie` → DAX `TOPN(100, …)` → Fluent `Table`; chart types show an honest "renders as table; charting lib in follow-up" MessageBar |
| 5 | Refresh | built | Home → Refresh re-loads the definition and re-runs every visual's DAX query |
| 6 | Honest infra gate | built | When no AAS binding resolves, a `MessageBar intent="warning"` names `state.aasServer` + `state.aasDatabase` / `LOOM_AAS_SERVER` + `LOOM_AAS_DATABASE`; the full page/visual surface still renders (config-only preview) |

### Backend per control (Loom-native)
- Definition → `GET /api/items/report/[id]` → `loadModelItem` / `loadContentBackedItem` (Cosmos) + `reportPagesFromContent`.
- Visual rows → `POST /api/items/report/[id]/query` → `executeAasQuery` (AAS data-plane `.../models/{db}/query`, DAX `EVALUATE`).
- Auth → Console UAMI, AAD scope `https://*.asazure.windows.net` (literal `*`; gov: `asazure.usgovcloudapi.net`). UAMI must be an AAS **server admin**.

### Honest gates (Loom-native)
- No AAS binding → 412 `code:'unbound'` from the query route + warning MessageBar in the editor (the only non-functional state).
- UAMI not a server admin → AAS 401/403 surfaces verbatim per visual.

Grade: A — default path queries the real AAS data-plane with DAX; pure helpers
(DAX synth, row-flatten, binding resolve) covered by `lib/azure/__tests__/aas-client.test.ts`
+ cloud split in `cloud-matrix.test.ts`.

---

## Power BI embed feature inventory (OPT-IN path — `LOOM_BI_BACKEND=powerbi`)

| # | Capability | Where in Power BI |
|---|---|---|
| 1 | Workspace + report list, open report | Workspace content list |
| 2 | Live report render | Report canvas |
| 3 | Page navigation (tabs) | Page tabs / pages pane |
| 4 | Bookmarks — view, apply, capture personal | View ribbon -> Bookmarks |
| 5 | Refresh visuals | Report toolbar -> Refresh |
| 6 | Edit / Reading view toggle | Report toolbar -> Edit |
| 7 | Export to PDF / PPTX / PNG | Export menu |
| 8 | Refresh underlying data (semantic model) | Dataset -> Refresh now |
| 9 | Open in Power BI / copy link | More options |
| 10 | Filter pane | Right pane |
| 11 | Bookmark slideshow (View) | View -> Bookmarks -> View (play) |
| 12 | Drill-through to target page (carries filter context) | Right-click visual -> Drill through -> target page |
| 13 | Drill-down / drill-up on hierarchy axes | Visual header drill chevrons |
| 14 | Cross-highlight (select a data point) | Click data point -> other visuals highlight |
| 15 | Report theme — apply built-in / custom JSON, reset | View ribbon -> Themes |
| 16 | Formatting pane (visualizations + fields panes) | Edit mode -> Visualizations / Fields panes |
| 17 | Native bookmarks + Selection panes (in-canvas) | View -> Bookmarks pane / Selection pane |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | built | usePowerBiWorkspaces() (groupIds) + /api/items/report list, auto-select first |
| 2 | built | PowerBIEmbedFrame (embedType=report) via /api/items/report/[id]/embed-token |
| 3 | built | Pages panel from GET /api/items/report/[id]/pages; click -> embed setPage(name); pageChanged event syncs |
| 4 | built | Bookmarks panel — report.bookmarksManager getBookmarks/apply/capture (embed JS API) |
| 5 | built | Refresh visuals -> report.refresh() (embed JS API) |
| 6 | built | View/Edit Switch — re-mints embed token at Edit access level + report.switchMode() |
| 7 | built | Export PDF/PPTX/PNG -> POST /api/items/report/[id]/export (async ExportTo + poll + download) |
| 8 | built | Refresh data -> POST /api/items/report/[id]/refresh (resolves datasetId, queues dataset refresh) |
| 9 | built | Open in Power BI + Copy link from report.webUrl |
| 10 | built | Filter pane visible in the embed config |
| 11 | built (NEW) | Play/Stop bookmarks slideshow -> report.bookmarksManager.play(On/Off) (embed JS API); ribbon View group + bookmarks panel button |
| 12 | built (NEW) | Drill-through is engine-native (authored in Power BI Desktop; iframe handles right-click -> Drill through + carries the source-page filter context). Loom detects the navigation via the `pageChanged` event, then reads the target page's `getFilters()` and surfaces the carried context in a "Drill-through context" MessageBar above the canvas. |
| 13 | built (NEW) | Drill-down / drill-up on hierarchy axes is engine-native (visual header chevrons render inside the iframe). Loom subscribes to `dataSelected` so the drill node selection is surfaced in the Selection panel; the native chevrons remain the interaction. |
| 14 | built (NEW) | Cross-highlight is engine-native; Loom listens to `dataSelected` (visual, page, filters, dataPoints) and shows the active selection (visual name + point/filter count) in the Selection panel with a Clear action. |
| 15 | built (NEW) | Apply theme / Reset theme — `report.applyTheme({ themeJson })` / `report.resetTheme()` (embed JS API). Theme dialog ships 3 built-in presets (Loom Light/Dark, High Contrast) as TS constants + an editable JSON textarea for custom themes; embed config seeds the load-time theme too. |
| 16 | built (NEW) | Show/Hide format pane (Edit mode only) -> `report.updateSettings({ panes: { visualizations, fields, filters } })` (embed JS API); ribbon View group toggle. |
| 17 | built (NEW) | Native in-canvas Bookmarks + Selection panes surfaced via `paneOverrides={{ bookmarks:{visible:true}, selection:{visible:true} }}` on PowerBIEmbedFrame. |

## Backend per control
- Pages -> Power BI REST GET /groups/{ws}/reports/{id}/pages (getReportPages).
- Export -> POST /groups/{ws}/reports/{id}/ExportTo -> poll exports/{id} -> exports/{id}/file.
- Refresh data -> GET report for datasetId -> POST /datasets/{id}/refreshes.
- Embed token (View/Edit) -> POST /groups/{ws}/reports/{id}/GenerateToken.
- Pages / bookmarks / refresh-visuals / view-mode -> powerbi-client embed JS API (client-side, against the live embed session).
- Drill-through / drill-down-up / cross-highlight -> Power BI engine-native (authored in Power BI Desktop; no host REST call). Loom observes via the embed JS events `pageChanged`, `bookmarkApplied`, `dataSelected` and reads `getActivePage().getFilters()` to surface the carried context — there is no host-side `drillThrough()` / `visual.drillDown()` API to call.
- Theme / format pane -> powerbi-client embed JS API: `report.applyTheme`, `report.resetTheme`, `report.updateSettings({ panes })`. Built-in theme presets are TS constants (no freeform JSON config file); the dialog also accepts a custom theme JSON.

## Honest gates
- Edit mode requires the embed token minted with accessLevel: Edit, which requires the UAMI to have Member/Contributor on the workspace; a 401/403 surfaces verbatim in the embed MessageBar.

Grade: A — every inventory row built against the real Power BI REST API + embed JS API; backend contract tests in lib/azure/__tests__/powerbi-client-parity.test.ts + app/api/items/__tests__/powerbi-parity-routes.test.ts.
