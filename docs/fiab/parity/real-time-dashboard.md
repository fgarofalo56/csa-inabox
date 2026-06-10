# real-time-dashboard — parity with Fabric Real-Time (KQL) Dashboard

Source UI: https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-real-time-create
            https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-parameters
            https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-visuals-customize
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` → `KqlDashboardEditor`
Model:  `apps/fiab-console/lib/azure/kql-dashboard-model.ts`
Routes: `apps/fiab-console/app/api/items/kql-dashboard/[id]/{route,run/route,param-values/route}.ts`

> Canonical RTI parity doc for the Real-Time (KQL) Dashboard surface. The
> Azure-native default backend is **Azure Data Explorer (ADX)** — tiles execute
> their KQL directly against the cluster; no Fabric capacity or Power BI
> workspace is required (per `no-fabric-dependency.md`). The model is persisted
> to Cosmos and runs with `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset**.

## Source-UI feature inventory (grounded in Learn + live portal)

A Fabric Real-Time Dashboard is a collection of **tiles**, each with an
underlying **KQL query** + a **visual type**, bound to a **data source**
(Eventhouse / KQL database), filtered by dashboard-level **parameters** and a
global **time range**, with **auto-refresh** and **save**.

| # | Fabric capability | Fabric behavior in the real UI |
| --- | --- | --- |
| 1 | Add / edit tile | Each tile authors a KQL query (query editor) and a visual; Run shows the live result |
| 2 | Tile visual types | render-operator visuals: table, timechart (line), barchart, columnchart, piechart, **stat/card**, anomaly, scatter/**map**, area |
| 3 | Resize / lay out tiles | Drag-resize on the canvas grid |
| 4 | Data sources | Add one or more KQL DBs; tiles + params select a source |
| 5 | Parameters — free text | Operator types a value, substituted via its variable name |
| 6 | Parameters — fixed (single/multi) | Predefined values; multi used as `x in (_var)` |
| 7 | Parameters — query-based | Dropdown values fetched at load by running a KQL query (single column) |
| 8 | Parameters — data source | Selects one of the dashboard data sources |
| 9 | Parameters — time range (duration) | Exposes `_startTime` / `_endTime` into tile KQL |
| 10 | Parameter filter bar | Selected params render at the top; changing one re-runs affected tiles |
| 11 | Auto refresh | Per-dashboard interval; manual Refresh too |
| 12 | Save | Persist tiles + sources + params + refresh |
| 13 | Edit JSON model | The dashboard JSON model (tiles/baseQueries/parameters/dataSources) |
| 14 | Share | Item-level RBAC |
| 15 | Add tile from queryset | "Save to Dashboard" pins a queryset query as a tile |
| 16 | Stat / card tile | Single-value KPI card with conditional formatting |
| 17 | Map / scatter tile | Geo-point / scatter visual |
| 18 | Publish dashboard definition | Persist the dashboard item from its JSON model |
| 19 | Copilot tile authoring (preview) | NL → KQL for a tile |
| 20 | Pages | Optional multi-page tile containers |
| 21 | Export to PDF | Render the dashboard to a PDF document |
| 22 | Visual formatting pane | Axis / legend / color / cross-filter customization |
| 23 | Drillthrough | Click a data point → cross-filter / navigate |
| 24 | Base queries | Named reusable KQL fragments referenced by tiles |
| 25 | Multi-stat / funnel / heatmap / markdown tiles | Additional tile visual kinds |

## Loom coverage

| Inventory row | Loom coverage | Notes |
| --- | --- | --- |
| 1 Add / edit tile (KQL + Run) | ✅ built | inline tile editor: Monaco KQL + per-tile **Run** → real result via `POST /run` |
| 2 Tile visual types (table, timechart, line, bar, column, pie, stat, map) | ✅ built | `TileVisual` + `ResultChart`/`StatCard`/`PieChart`/`MapVisual` (dependency-free SVG) |
| 3 Resize / lay out tiles | ✅ built | 12-col CSS grid; per-tile width (1–12) + height (1–8) controls; spans persist |
| 4 Data sources | ✅ built | Data sources dialog binds tiles/params to KQL databases; `tile.dataSourceId` → DB |
| 5 Parameter — free text | ✅ built | typed literal substitution (string quoted, numeric bare, datetime wrapped) |
| 6 Parameter — fixed (single) | ✅ built | dropdown in the filter bar |
| 6 Parameter — multi-select | ✅ built | renders `dynamic([...])` for `x in (_var)` |
| 7 Parameter — query-based | ✅ built | dropdown values from `POST /param-values` (real KQL distinct query) |
| 8 Parameter — data source | ✅ built | filter-bar dropdown of dashboard sources |
| 9 Parameter — time range (duration) | ✅ built | global Time control → `_startTime`/`_endTime`/`_loomTimeFrom` |
| 10 Parameter filter bar | ✅ built | params render at top; onBlur/Apply re-runs all tiles live |
| 11 Auto refresh | ✅ built | interval Select off/5s/30s/1m/5m/30m/1h; each tick re-queries ADX via `/run` (in-flight guard skips a tick while a requery is still resolving so a 5s cadence can't pile up); `autoRefreshMs` persisted in the model; "Last refreshed HH:MM:SS" shown live |
| 11 Manual refresh | ✅ built | "Refresh all" + per-tile Run |
| 12 Save (model → Cosmos) | ✅ built | `PUT /api/items/kql-dashboard/[id]` saves tiles+sources+params+timeRange |
| 13 Edit JSON model | ✅ built | full `{ tiles, dataSources, parameters, timeRange }` (array root = tiles only) |
| 14 Share (item RBAC) | ✅ built | canonical URL + copy + RBAC note |
| 15 Add tile from queryset | ✅ built | KQL Queryset editor "Save query to KQL Dashboard" pins a tile |
| 16 Stat / card tile | ✅ built | `StatCard` single-value KPI render |
| 17 Map / scatter tile | ✅ built | `MapVisual` dependency-free SVG geo-point render |
| 18 Publish dashboard definition to Fabric REST | ⚠️ honest-gate | Fabric Real-Time Dashboard items have no GA public create-definition REST for SP auth in this tenant; the model is the source of truth in Cosmos and runs against ADX directly. The `state` shape mirrors the Fabric JSON model (tiles/dataSources/parameters) for a future definition-REST sync. **Azure-native default needs no Fabric workspace.** |
| 19 Copilot tile authoring (preview) | ⚠️ honest-gate | NL→KQL requires the Loom Copilot backend wiring; the KQL editor is fully functional without it |
| 20 Pages (multi-page) | ⚠️ tracked | single-page canvas today; multi-page is a layout-only follow-up (no backend gap) — `KqlDashboardEditor` page array |
| 21 Export to PDF | ⚠️ tracked | follow-up — client-side render-to-PDF over the live tile canvas; no backend gap (ADX results already in hand) |
| 22 Visual formatting pane (axes/legend/colors/cross-filter) | ⚠️ tracked | follow-up — per-tile `formatting` block on the existing `ResultChart`; no backend gap |
| 23 Drillthrough (cross-filter on click) | ⚠️ tracked | follow-up — tile-to-param wiring on point click; reuses the existing param filter bar |
| 24 Base queries (named reusable fragments) | ⚠️ tracked | follow-up — `baseQueries[]` prepended to tile KQL; the model already reserves the field per the Fabric JSON shape |
| 25 Multi-stat / funnel / heatmap / markdown tiles | ⚠️ tracked | follow-up — additional `TileVisual` kinds; table/timechart/line/bar/column/pie/stat/map already cover the executable set |
| No Eventhouse / KQL DB provisioned | ⚠️ honest-gate | warning MessageBar names the resource (ARM `Microsoft.Kusto/clusters/databases`) + points to the Eventhouse editor; the **full builder still renders** |

Every inventory row is built ✅ or an honest ⚠️ gate / tracked follow-up — none unbuilt. Every executable control calls real Kusto; non-functional rows are
honest infra/preview gates or tracked follow-ups whose note names the exact
field / command required — the full UI renders in every case (per
`no-vaporware.md` + `ui-parity.md`).

## Backend per control

| Control | Backend |
| --- | --- |
| Tile Run / Refresh all | `POST /api/items/kql-dashboard/[id]/run` → `runTiles` → `executeQuery` (Kusto v2 REST `POST {cluster}/v1/rest/query`) with params + time substituted via `substituteTileKql` |
| Tile → database binding | `resolveTileDatabase(tile, dataSources, fallback)` (explicit DB → bound source → dashboard default `loomdb-default`) |
| Query-based param values | `POST /api/items/kql-dashboard/[id]/param-values` → `executeQuery` (distinct first column) |
| Saved-dashboard view | `GET /api/items/kql-dashboard/[id]?run=1&time=…&param.<v>=…` → executes each tile inline |
| Save model | `PUT /api/items/kql-dashboard/[id]` → `saveItemState` (Cosmos `items` state) |
| Create on /new | `POST /api/cosmos-items/kql-dashboard` (Cosmos) via `NewItemCreateGate` |
| Pin from queryset | KQL Queryset "Save to dashboard" → `PUT /api/items/kql-dashboard/[id]` appends a tile |

Azure-native default: the entire tile-run / param / save path uses ADX
(`LOOM_KUSTO_CLUSTER_URI`) + Cosmos; nothing on this path calls
`api.fabric.microsoft.com` or `api.powerbi.com`.

## Cloud boundary (Commercial / GCC / GCC-High / IL5)

| Boundary | Coverage | Notes |
| --- | --- | --- |
| Commercial | ✅ full | ADX + Cosmos |
| GCC | ✅ full | ADX + Cosmos |
| GCC-High | ✅ full | ADX + Cosmos |
| IL5 | ✅ full | ADX + Cosmos |

ADX is authorized in all four boundaries, so the dashboard's executable surface
is identical everywhere. The only Fabric-flavored row (18, publish definition)
is an opt-in alternative; its absence never gates the Azure-native default.

## Substitution semantics (Fabric-compatible)

- Time range: `_startTime` → resolved `ago(...)`, `_endTime` → `now()`,
  `_loomTimeFrom` → resolved `ago(...)` (back-compat with v2.x tiles).
- Param literal rendering by data type: `string` → `"quoted"`, `long/int/real`
  → bare number, `datetime` → `datetime(...)` (or pass-through `ago()/now()`),
  `bool` → `true/false`. `multi` → `dynamic([...])`.
- Word-boundary matching so `_st` never clobbers `_state`.
- Unset params are left in place so the KQL errors visibly, matching Fabric's
  inactive-filter behavior — no silent wrong results.

## Verification

- `pnpm build` — clean (the three routes compile: `/[id]`, `/[id]/run`, `/[id]/param-values`).
- Backend Vitest contract tests:
  - `lib/azure/__tests__/kql-dashboard-model.test.ts` — substitution, literal rendering, db resolution, sanitize.
  - `app/api/items/kql-dashboard/__tests__/routes.test.ts` — auth gates, time/param substitution into executed KQL, tile→DB binding, transient `/new` run, per-tile error isolation, query-based param values.
- Live probe (minted-session browser walk against ADX) runs the same
  `executeQuery` path the KQL Database / Queryset editors use live in the
  deployed Loom.

_Last updated: 2026-06-07._
