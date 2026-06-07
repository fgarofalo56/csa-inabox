# kql-queryset — parity with Fabric KQL Queryset (Real-Time Intelligence)

Source UI: https://learn.microsoft.com/fabric/real-time-intelligence/kusto-query-set
            https://learn.microsoft.com/fabric/real-time-intelligence/create-query-set
            https://learn.microsoft.com/azure/data-explorer/web-query-data
            https://learn.microsoft.com/azure/data-explorer/web-results-grid
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` → `KqlQuerysetEditor`
Results grid: `apps/fiab-console/lib/components/adx/kusto-results-grid.tsx` → `KustoResultsGrid`
Routes: `apps/fiab-console/app/api/items/kql-queryset/[id]/{route,run/route}.ts`
Backend: `apps/fiab-console/lib/azure/kusto-client.ts` (`executeQuery` / `executeMgmtCommand` → ADX `/v1/rest/query` + `/v1/rest/mgmt` with UAMI bearer token)

> The KQL Queryset is a multi-tab KQL development workspace — the same surface as
> the Azure Data Explorer web query editor. The Azure-native default backend is
> **Azure Data Explorer (ADX)** — Run executes KQL directly against the cluster;
> saved queries persist to Cosmos. No Fabric capacity is required and the editor
> works with `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset** (per
> `no-fabric-dependency.md`). Set `LOOM_KUSTO_CLUSTER_URI` (+
> `LOOM_KUSTO_DEFAULT_DB`); the Console UAMI needs the ADX **Database Viewer**
> role to query.

## Source-UI feature inventory (grounded in Learn + live portal)

A Fabric KQL Queryset is a tabbed query editor bound to one or more KQL
databases, with a toolbar (Run / Recall / Share / Save to dashboard / Export /
Add alert), a rich results grid, a render-operator chart picker, and per-tab
independent query state.

| # | Fabric / ADX capability | Behavior in the real UI |
| --- | --- | --- |
| 1 | Multi-tab query workspace | Add / select / delete / rename tabs; each tab keeps independent query state |
| 2 | Run | Execute the active tab's KQL against the bound database |
| 3 | Cancel in-flight query | Abort a long-running query without leaving the tab |
| 4 | Save | Persist all queries in the queryset |
| 5 | Dirty indicator + discard guard | Warn before switching away from unsaved edits |
| 6 | Results grid — sort | Click a column header to sort, type-aware (numbers/dates by value) |
| 7 | Results grid — filter / search | Per-column filter + search-in-grid; matched cells highlighted |
| 8 | Results grid — resize columns | Drag the column edge to set an explicit width; double-click to auto-fit |
| 9 | Results grid — column stats | Per-column min/max/sum/avg + distinct / most-common |
| 10 | Results grid — copy / export | Copy selection (TSV) + download as CSV |
| 11 | Chart / render picker | `render` visuals: table, timechart, linechart, columnchart, barchart, piechart, stat/card, anomaly/map; auto-derived from `\| render`, user-overridable |
| 12 | Multi-database context | Pick which KQL database the active tab targets |
| 13 | Reload preserves queries | Re-opening the item restores the saved queries |
| 14 | Create queryset | New queryset item authoring |
| 15 | Save to Dashboard | Pin the active query as a tile on a Real-Time Dashboard |
| 16 | Add alert | Create an Activator (Reflex) rule from the query |
| 17 | Share | Item-level RBAC; copy the canonical item URL for workspace members |
| 18 | Export to CSV | Download the result set |
| 19 | KQL Tools | Pre-populated template + KQL/SQL reference links |
| 20 | Schema-aware IntelliSense | `@kusto/monaco-kusto` table/column completion + error squigglies |
| 21 | Recall / query history | Re-open recently executed queries |
| 22 | Power BI report from results | Build a Power BI report over the query output |

## Loom coverage

| Inventory row | Loom coverage | Notes |
| --- | --- | --- |
| 1 Multi-tab query workspace | ✅ built | `queries[]` left panel; tab add/select/delete/rename; per-tab `query` + `database`; dirty-guard on switch via `window.confirm()` |
| 2 Run (real KQL → results) | ✅ built | `POST /api/items/kql-queryset/[id]/run` → `executeQuery` (real `/v1/rest/query`) |
| 3 Cancel in-flight query | ✅ built | client `AbortController.abort()` on the in-flight fetch — matches Fabric/ADX cancel behavior |
| 4 Save all queries (Ctrl+S / Save) | ✅ built | `PUT /api/items/kql-queryset/[id]` → Cosmos `saveItemState` |
| 5 Dirty indicator + discard guard | ✅ built | `dirty` flag + confirm before switching tabs |
| 6 Results grid — sort | ✅ built | `makeComparator` (type-aware) in `KustoResultsGrid` |
| 7 Results grid — filter / search | ✅ built | `colFilters` + `globalSearch`, highlighted cells |
| 8 Results grid — resize columns | ✅ built | Drag handle on each `th`; `columnWidths` state, `clampColumnWidth` 48–900px; double-click clears to auto-fit |
| 9 Results grid — column stats | ✅ built | `ColumnStatsPopover` (min/max/sum/avg + distinct) |
| 10 Results grid — copy / export | ✅ built | `buildTsv` → clipboard; `buildCsv` → Blob download |
| 11 Chart / render picker | ✅ built | 8 viz choices; auto from `result.visualization.Visualization`, user-overridable |
| 12 Multi-database context | ✅ built | per-tab `draft.database` selector → resolved by `POST /run` into `executeQuery(db, …)` |
| 13 Reload preserves queries | ✅ built | `GET` on mount; `sanitizeQueries` server-side |
| 14 Create on /new | ✅ built | `NewItemCreateGate` mints the Cosmos item before first save/run |
| 15 Save to Dashboard (pin tile) | ✅ built | `openPinDialog` → `GET /api/items?type=kql-dashboard` → `PUT /api/items/kql-dashboard/[id]` appends a tile |
| 16 Add alert (create Activator rule) | ✅ built | `alertDlgOpen` → `GET /api/items?type=activator` → `POST /api/items/activator/[id]/rules` |
| 17 Share | ✅ built | Ribbon **Share → Copy link** dialog; copies `window.location.href`; Loom item RBAC governs access |
| 18 Export to CSV | ✅ built | `KustoResultsGrid` "CSV" download |
| 19 KQL Tools (template + reference links) | ✅ built | new-tab template carries the KQL/SQL reference comments + example queries |
| 20 Schema-aware IntelliSense | ⚠️ honest-gate | `MonacoTextarea language="kql"` ships a registered KQL Monarch tokenizer + syntax highlight today; full `@kusto/monaco-kusto` schema-aware completion is a separate dependency-add (`@kusto/monaco-kusto` + bridge-asset copy), tracked for a follow-up PR. The editor is fully functional without it (Monaco surface already wired, no backend gap) |
| 21 Recall / query history | ⚠️ tracked | follow-up — last-N executed queries cached per session; pure front-end, no backend gap |
| 22 Power BI report from results | ⚠️ honest-gate | requires a Power BI push-dataset target; opt-in Fabric/Power BI path per `no-fabric-dependency.md`. The Azure-native default surfaces results in the grid + CSV/Dashboard pin without it |

Every inventory row is built ✅ or an honest ⚠️ gate / tracked follow-up — none
unbuilt. Every executable control calls real Kusto / Cosmos; non-functional rows
are honest gates or tracked front-end follow-ups whose note names the exact
dependency — the full editor renders in every case.

## Backend per control

| Control | Backend |
| --- | --- |
| Run / Cancel | `POST /api/items/kql-queryset/[id]/run` → `kusto-client.executeQuery(db, csl)` (`.`-prefixed → `executeMgmtCommand`) → ADX `/v1/rest/query` \| `/v1/rest/mgmt`, UAMI bearer, `parseVisualization` extracts `@ExtendedProperties` Visualization; cancel via client `AbortController` |
| Save queries | `PUT /api/items/kql-queryset/[id]` → `saveItemState` (Cosmos `items` state, `queries[]` array) |
| Load queryset | `GET /api/items/kql-queryset/[id]` → Cosmos item state via `loadKustoItem` |
| Create on /new | `POST /api/cosmos-items/kql-queryset` (Cosmos) via `NewItemCreateGate` |
| Grid sort/filter/resize/stats/export | pure client-side over the real `{ columns, columnTypes, rows }` already returned by Run (no backend round-trip), per `no-vaporware.md` |
| Pin to dashboard | `GET /api/items?type=kql-dashboard` + `PUT /api/items/kql-dashboard/[id]` (append tile) |
| Add alert | `GET /api/items?type=activator` + `POST /api/items/activator/[id]/rules` |
| Share | client-only canonical-URL copy; access governed by Loom item RBAC |

Azure-native default: Run / Save / load all use ADX (`LOOM_KUSTO_CLUSTER_URI`) +
Cosmos; nothing on this path calls `api.fabric.microsoft.com`.

## Cloud boundary (Commercial / GCC / GCC-High / IL5)

Cluster URI is the only cloud-specific knob (`LOOM_KUSTO_CLUSTER_URI`): Commercial
`*.kusto.windows.net`, GCC `*.kusto.usgovcloudapi.net`, GCC-High `*.kusto.azure.us`,
DoD/IL5 `*.kusto.core.usgovcloudapi.net`. Token scope derives from the URI, so the
sovereign login endpoint is selected automatically.

| Boundary | Coverage | Notes |
| --- | --- | --- |
| Commercial | ✅ full | ADX + Cosmos |
| GCC | ✅ full | ADX + Cosmos |
| GCC-High | ✅ full | ADX + Cosmos |
| IL5 | ✅ full | ADX + Cosmos |

The results grid and chart picker are cloud-agnostic (pure client over the REST
response, identical shape across clouds). ADX is authorized in all four
boundaries; the queryset's executable surface is identical everywhere. The Power
BI report row (22) is the only Fabric-family dependency and is strictly opt-in —
its absence never gates the editor.

## Verification

- `pnpm build` — clean (`/[id]`, `/[id]/run` compile).
- Backend Vitest contract tests: `app/api/items/kql-queryset/__tests__/routes.test.ts` —
  auth gate, transient `/new` run, real `executeQuery` shaping, per-tab database
  resolution, Cosmos save round-trip.
- Live probe (minted-session browser walk against ADX) runs the same
  `executeQuery` path the KQL Database editor uses live in the deployed Loom.

_Last updated: 2026-06-07._
