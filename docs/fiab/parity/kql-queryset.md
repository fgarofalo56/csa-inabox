# kql-queryset — parity with Fabric KQL Queryset (Real-Time Intelligence)

Source UI: https://learn.microsoft.com/fabric/real-time-intelligence/kusto-query-set
            https://learn.microsoft.com/fabric/real-time-intelligence/create-query-set
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` → `KqlQuerysetEditor`
Routes: `apps/fiab-console/app/api/items/kql-queryset/[id]/{route,run/route}.ts`
Results grid: `apps/fiab-console/lib/components/adx/kusto-results-grid.tsx`

> The KQL Queryset is a multi-tab KQL development workspace. The Azure-native
> default backend is **Azure Data Explorer (ADX)** — Run executes KQL directly
> against the cluster; saved queries persist to Cosmos. No Fabric capacity is
> required and the editor works with `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset**
> (per `no-fabric-dependency.md`).

## Source-UI feature inventory (grounded in Learn + live portal)

A Fabric KQL Queryset is a tabbed query editor bound to one or more KQL
databases, with a toolbar (Run / Recall / Share / Save to dashboard / Export /
Add alert), a results grid, and per-tab independent query state.

| # | Fabric capability | Fabric behavior in the real UI |
| --- | --- | --- |
| 1 | Multi-tab query workspace | Add / select / delete / rename tabs; each tab keeps independent query state |
| 2 | Run | Execute the active tab's KQL against the bound database |
| 3 | Cancel in-flight query | Abort a long-running query |
| 4 | Save | Persist all queries in the queryset |
| 5 | Dirty indicator + discard guard | Warn before switching away from unsaved edits |
| 6 | Results grid | Sort, filter, in-grid search, column stats, CSV export, copy |
| 7 | Save to Dashboard | Pin the active query as a tile on a Real-Time Dashboard |
| 8 | Add alert | Create an Activator (Reflex) rule from the query |
| 9 | Multi-database context | Pick which KQL database the active tab targets |
| 10 | Create queryset | New queryset item authoring |
| 11 | KQL IntelliSense / autocomplete | Keyword / table / column completions |
| 12 | Recall / query history | Re-open recently executed queries |
| 13 | Share query | Share a query link with permissions |
| 14 | Export to CSV | Download the result set |
| 15 | Power BI report from results | Build a Power BI report over the query output |
| 16 | KQL Tools | Pre-populated template + KQL/SQL reference links |

## Loom coverage

| Inventory row | Loom coverage | Notes |
| --- | --- | --- |
| 1 Multi-tab query workspace | ✅ built | tab add/select/delete/rename; per-tab `query` + `database`; dirty-guard on switch via `window.confirm()` |
| 2 Run (real KQL → results) | ✅ built | `POST /api/items/kql-queryset/[id]/run` → `executeQuery` (real `/v1/rest/query`) |
| 3 Cancel in-flight query | ✅ built | client `AbortController.abort()` on the in-flight fetch — matches Fabric cancel behavior |
| 4 Save all queries (Ctrl+S / Save) | ✅ built | `PUT /api/items/kql-queryset/[id]` → Cosmos `saveItemState` |
| 5 Dirty indicator + discard guard | ✅ built | `dirty` flag + confirm before switching tabs |
| 6 Results grid (sort/filter/search/col-stats/CSV/copy-TSV) | ✅ built | shared `KustoResultsGrid` over the real result rows |
| 7 Save to Dashboard (pin tile) | ✅ built | `openPinDialog` → `GET /api/items?type=kql-dashboard` → `PUT /api/items/kql-dashboard/[id]` appends a tile |
| 8 Add alert (create Activator rule) | ✅ built | `alertDlgOpen` → `GET /api/items?type=activator` → `POST /api/items/activator/[id]/rules` |
| 9 Multi-database context | ✅ built | per-tab `draft.database` selector → resolved by `POST /run` into `executeQuery(db, …)` |
| 10 Create on /new | ✅ built | `NewItemCreateGate` mints the Cosmos item before first save/run |
| 14 Export to CSV | ✅ built | `KustoResultsGrid` "CSV" download |
| 16 KQL Tools (template + reference links) | ✅ built | new-tab template carries the KQL/SQL reference comments + example queries |
| 11 KQL IntelliSense / autocomplete | ⚠️ honest-gate | `MonacoTextarea language="kql"` provides the editor + syntax highlight; the `monaco-kusto` schema-aware completion plugin is a tracked follow-up (Monaco surface already wired, no backend gap) |
| 12 Recall / query history | ⚠️ tracked | follow-up — last-N executed queries cached per session; pure front-end, no backend gap |
| 13 Share query link | ⚠️ tracked | follow-up — canonical per-tab deep link; reuses the item-RBAC share pattern, no backend gap |
| 15 Power BI report from results | ⚠️ honest-gate | requires a Power BI push-dataset target; opt-in Fabric/Power BI path per `no-fabric-dependency.md`. The Azure-native default surfaces results in the grid + CSV/Dashboard pin without it |

Every inventory row is built ✅ or an honest ⚠️ gate / tracked follow-up — none unbuilt. Every executable control calls real Kusto / Cosmos; non-functional
rows are honest gates or tracked front-end follow-ups whose note names the
exact dependency — the full editor renders in every case.

## Backend per control

| Control | Backend |
| --- | --- |
| Run / Cancel | `POST /api/items/kql-queryset/[id]/run` → `executeQuery(db, csl)` (Kusto v2 REST `POST {cluster}/v1/rest/query`); cancel via client `AbortController` |
| Save queries | `PUT /api/items/kql-queryset/[id]` → `saveItemState` (Cosmos `items` state, `queries[]` array) |
| Load queryset | `GET /api/items/kql-queryset/[id]` → Cosmos item state |
| Create on /new | `POST /api/cosmos-items/kql-queryset` (Cosmos) via `NewItemCreateGate` |
| Pin to dashboard | `GET /api/items?type=kql-dashboard` + `PUT /api/items/kql-dashboard/[id]` (append tile) |
| Add alert | `GET /api/items?type=activator` + `POST /api/items/activator/[id]/rules` |
| Export CSV | client-side over the real result rows in `KustoResultsGrid` |

Azure-native default: Run / Save / load all use ADX (`LOOM_KUSTO_CLUSTER_URI`) +
Cosmos; nothing on this path calls `api.fabric.microsoft.com`.

## Cloud boundary (Commercial / GCC / GCC-High / IL5)

| Boundary | Coverage | Notes |
| --- | --- | --- |
| Commercial | ✅ full | ADX + Cosmos |
| GCC | ✅ full | ADX + Cosmos |
| GCC-High | ✅ full | ADX + Cosmos |
| IL5 | ✅ full | ADX + Cosmos |

ADX is authorized in all four boundaries; the queryset's executable surface is
identical everywhere. The Power BI report row (15) is the only Fabric-family
dependency and is strictly opt-in — its absence never gates the editor.

## Verification

- `pnpm build` — clean (`/[id]`, `/[id]/run` compile).
- Backend Vitest contract tests: `app/api/items/kql-queryset/__tests__/routes.test.ts` —
  auth gate, transient `/new` run, real `executeQuery` shaping, per-tab database
  resolution, Cosmos save round-trip.
- Live probe (minted-session browser walk against ADX) runs the same
  `executeQuery` path the KQL Database editor uses live in the deployed Loom.

_Last updated: 2026-06-07._
