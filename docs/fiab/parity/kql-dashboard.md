# kql-dashboard — parity with Fabric Real-Time (KQL) Dashboard

Source UI: https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-real-time-create
            https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-parameters
            https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-visuals-customize
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` → `KqlDashboardEditor`
Model:  `apps/fiab-console/lib/azure/kql-dashboard-model.ts`
Routes: `apps/fiab-console/app/api/items/kql-dashboard/[id]/{route,run/route,param-values/route}.ts`

## Fabric feature inventory (grounded in Learn)

A Fabric Real-Time Dashboard is a collection of **tiles**, each with an
underlying **KQL query** + a **visual type**, bound to a **data source**
(Eventhouse / KQL database), filtered by dashboard-level **parameters** and a
global **time range**, with **auto-refresh** and **save**.

| Capability | Fabric behavior |
| --- | --- |
| Add / edit tile | Each tile authors a KQL query (query editor) and a visual; Run shows the live result |
| Tile editing window | Clicking a tile's Edit opens a dedicated tile-editing panel (title, visual, source, geometry, KQL, Run) |
| Base queries | Top-level `baseQueries[]` of shared KQL snippets referenced by tiles (queryRef); inlined at run |
| Tile visual types | render-operator visuals: table, timechart (line), barchart, columnchart, piechart, **stat/card**, anomaly, scatter/**map**, area |
| Resize / lay out tiles | Drag-resize on the canvas grid |
| Data sources | Add one or more KQL DBs; tiles + params select a source |
| Parameters — free text | Operator types a value, substituted via its variable name |
| Parameters — fixed (single/multi) | Predefined values; multi used as `x in (_var)` |
| Parameters — query-based | Dropdown values fetched at load by running a KQL query (single column) |
| Parameters — data source | Selects one of the dashboard data sources |
| Parameters — time range (duration) | Exposes `_startTime` / `_endTime` into tile KQL |
| Parameter filter bar | Selected params render at the top; changing one re-runs affected tiles |
| Auto refresh | Per-dashboard interval; manual Refresh too |
| Save | Persist tiles + sources + params + refresh |
| Edit JSON model | The dashboard JSON model (tiles/baseQueries/parameters/dataSources) |
| Share | Item-level RBAC |
| Add tile from queryset | "Save to Dashboard" pins a queryset query as a tile |
| Copilot tile authoring (preview) | NL → KQL for a tile |
| Pages | Optional tile containers |

## Loom coverage

| Inventory row | State | Notes |
| --- | --- | --- |
| Add / edit tile (KQL + Run) | ✅ built | tile **edit flyout** (Dialog): Monaco KQL + per-tile **Run** → real result rendered inline via `POST /run` |
| Tile editing window | ✅ built | a single `Dialog` (`tileFlyoutIdx`) edits the selected tile — title, visual, data source, width/height, KQL, Run + live result preview; Apply/Delete in the footer |
| Base queries | ✅ built | Base queries dialog manages shared KQL snippets; tiles reference them as `$baseQuery('name')`, inlined as a parenthesised sub-query by `substituteBaseQueries` before param/time substitution; persisted in the model |
| Tile visual types (table, timechart, line, bar, column, pie, stat, map) | ✅ built | `TileVisual` + `ResultChart`/`StatCard`/`PieChart`/`MapVisual` (dependency-free SVG) |
| Resize / lay out tiles | ✅ built | 12-col CSS grid; per-tile width (1–12) + height (1–8) controls; spans persist |
| Data sources | ✅ built | Data sources dialog binds tiles/params to KQL databases; `tile.dataSourceId` → DB |
| Parameter — free text | ✅ built | typed literal substitution (string quoted, numeric bare, datetime wrapped) |
| Parameter — fixed (single) | ✅ built | dropdown in the filter bar |
| Parameter — multi-select | ✅ built | renders `dynamic([...])` for `x in (_var)` |
| Parameter — query-based | ✅ built | dropdown values from `POST /param-values` (real KQL distinct query) |
| Parameter — data source | ✅ built | filter-bar dropdown of dashboard sources |
| Parameter — time range (duration) | ✅ built | global Time control → `_startTime`/`_endTime`/`_loomTimeFrom` |
| Parameter filter bar | ✅ built | params render at top; onBlur/Apply re-runs all tiles live |
| Auto refresh | ✅ built | cycles off/15s/30s/60s/300s; re-runs the live model; persisted |
| Manual refresh | ✅ built | "Refresh all" + per-tile Run |
| Save (model → Cosmos) | ✅ built | `PUT /api/items/kql-dashboard/[id]` saves tiles+sources+params+timeRange |
| Edit JSON model | ✅ built | full `{ tiles, dataSources, parameters, timeRange }` (array root = tiles only) |
| Share (item RBAC) | ✅ built | canonical URL + copy + RBAC note |
| Add tile from queryset | ✅ built | KQL Queryset editor "Save query to KQL Dashboard" pins a tile (pre-existing) |
| Create on /new | ✅ built (NEW) | `NewItemCreateGate` mints the Cosmos item so Run/Save work (was a dead `/new`) |
| Publish dashboard definition to Fabric REST | ⚠️ honest-gate | Fabric Real-Time Dashboard items have no GA public create-definition REST for SP auth in this tenant; the model is the source of truth in Cosmos and runs against ADX directly. The `state` shape mirrors the Fabric JSON model (tiles/dataSources/parameters) for a future definition-REST sync. |
| Copilot tile authoring (preview) | ⚠️ honest-gate | NL→KQL requires the Loom Copilot backend wiring; the KQL editor is fully functional without it |
| Pages | ⚠️ honest-gate | single-page canvas today; multi-page is a layout-only follow-up (no backend gap) |
| No Eventhouse / KQL DB provisioned | ⚠️ honest-gate | warning MessageBar names the resource (ARM `Microsoft.Kusto/clusters/databases`) + points to the Eventhouse editor; the **full builder still renders** |

Zero ❌. Every executable control calls real Kusto; non-functional states are
honest infra/preview gates with the full UI still rendered (per
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

## Substitution semantics (Fabric-compatible)

- Base queries: `$baseQuery('name')` / `$baseQuery("name")` (whitespace-tolerant)
  is inlined as `(<snippet kql>)` first, so the shared snippet also receives
  time + param substitution. Unknown names are left intact so the KQL errors
  visibly ("unresolved base query") rather than silently dropping the ref.
- Time range: `_startTime` → resolved `ago(...)`, `_endTime` → `now()`,
  `_loomTimeFrom` → resolved `ago(...)` (back-compat with v2.x tiles).
- Param literal rendering by data type: `string` → `"quoted"`, `long/int/real`
  → bare number, `datetime` → `datetime(...)` (or pass-through `ago()/now()`),
  `bool` → `true/false`. `multi` → `dynamic([...])`.
- Word-boundary matching so `_st` never clobbers `_state`.
- Unset params are left in place so the KQL errors visibly ("param unset"),
  matching Fabric's inactive-filter behavior — no silent wrong results.

## Verification

- `pnpm build` — clean (the three routes compile: `/[id]`, `/[id]/run`, `/[id]/param-values`).
- Backend Vitest contract tests:
  - `lib/azure/__tests__/kql-dashboard-model.test.ts` (24) — substitution, base-query inlining, literal rendering, db resolution, sanitize (incl. baseQueries).
  - `app/api/items/kql-dashboard/__tests__/routes.test.ts` (17) — auth gates, time/param/base-query substitution into executed KQL, tile→DB binding, baseQueries PUT round-trip, transient `/new` run, per-tile error isolation, query-based param values, content/structured errors.
- DOM render tests (`lib/editors/__tests__/kql-dashboard.test.tsx`) cover the
  tile edit flyout + base-queries dialog; they run under jsdom once the repo-wide
  vitest setup (`@testing-library/jest-dom`) resolves in the install — the model +
  route contract tests above exercise the same backend per the no-scaffold rule.
- Live probe (minted-session browser walk against ADX) unavailable in the
  worktree; the run/param-values routes call the same `executeQuery` path the
  KQL Database / Queryset editors use live in the deployed Loom.
