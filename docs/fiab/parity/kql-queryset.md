# kql-queryset — parity with Fabric KQL Queryset

Source UI: https://learn.microsoft.com/fabric/real-time-intelligence/create-query-set
            https://learn.microsoft.com/azure/data-explorer/web-query-data
            https://learn.microsoft.com/azure/data-explorer/web-results-grid
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` → `KqlQuerysetEditor`
Grid:   `apps/fiab-console/lib/components/adx/kusto-results-grid.tsx` → `KustoResultsGrid`
Routes: `apps/fiab-console/app/api/items/kql-queryset/[id]/{route,run/route}.ts`
Backend: `apps/fiab-console/lib/azure/kusto-client.ts` (`executeQuery` / `executeMgmtCommand` → ADX `/v1/rest/query` + `/v1/rest/mgmt` with UAMI bearer token)

A Fabric KQL Queryset is the same surface as the Azure Data Explorer web query
editor: a Monaco KQL editor over a database, Run, a rich results grid, a
render-operator chart picker, multiple saved queries (tabs), Save, and Share.
Azure-native default: an ADX cluster (no Fabric workspace required). Set
`LOOM_KUSTO_CLUSTER_URI` (+ `LOOM_KUSTO_DEFAULT_DB`); the Console UAMI needs the
ADX **Database Viewer** role to query.

## Fabric / ADX feature inventory (grounded in Learn)

| Capability | Fabric / ADX behavior |
| --- | --- |
| KQL editor | Monaco editor with KQL syntax highlighting / keyword tokens |
| Run | Executes the current query against the bound database; renders results |
| Cancel running query | Stop an in-flight query without leaving the tab |
| Results grid — sort | Click a column header to sort, type-aware (numbers/dates by value) |
| Results grid — filter | Per-column filter + search-in-grid; matched cells highlighted |
| Results grid — resize columns | Drag the column edge to set an explicit width; double-click to auto-fit |
| Results grid — column stats | Per-column min/max/sum/avg + distinct / most-common |
| Results grid — copy / export | Copy selection (TSV) + download as CSV |
| Chart / render picker | `render` visuals: table, timechart, linechart, columnchart, barchart, piechart, **stat/card**, anomaly/map; auto-derived from `| render`, user-overridable |
| Multiple queries (tabs) | A queryset holds many named queries; add / delete / switch |
| Save | Persist the queries to the item (Cosmos) |
| Reload preserves queries | Re-opening the item restores the saved queries |
| Pin to dashboard | "Save to Dashboard" adds the query as a Real-Time Dashboard tile |
| Set alert | Create an Activator rule from the query |
| Share | Item-level RBAC; copy the canonical item URL for workspace members |
| Schema-aware IntelliSense | `@kusto/monaco-kusto` table/column completion + error squigglies |

## Loom coverage

| Inventory row | State | Notes |
| --- | --- | --- |
| KQL editor | ✅ | `MonacoTextarea language="kql"` with a registered KQL Monarch tokenizer |
| Run | ✅ | `POST /api/items/kql-queryset/[id]/run` → `executeQuery` (real ADX) |
| Cancel running query | ✅ | `AbortController`; ribbon Cancel |
| Results grid — sort | ✅ | `makeComparator` (type-aware) in `KustoResultsGrid` |
| Results grid — filter | ✅ | `colFilters` + `globalSearch`, highlighted cells |
| Results grid — resize columns | ✅ | Drag handle on each `th`; `columnWidths` state, `clampColumnWidth` 48–900px; double-click clears to auto-fit |
| Results grid — column stats | ✅ | `ColumnStatsPopover` |
| Results grid — copy / export | ✅ | `buildTsv` → clipboard; `buildCsv` → Blob download |
| Chart / render picker | ✅ | 8 viz choices; auto from `result.visualization.Visualization`, user-overridable |
| Multiple queries (tabs) | ✅ | `queries[]` left panel; add / delete / select with dirty-guard |
| Save | ✅ | `PUT /api/items/kql-queryset/[id]` → `saveItemState` (Cosmos) |
| Reload preserves queries | ✅ | `GET` on mount; `sanitizeQueries` server-side |
| Pin to dashboard | ✅ | Reads `kql-dashboard` items, appends tile, PUTs |
| Set alert | ✅ | Reads `activator` items, POSTs rule |
| Share | ✅ | Ribbon **Share → Copy link** dialog; copies `window.location.href`; Loom RBAC note |
| Schema-aware IntelliSense | ⚠️ | Honest gate: the KQL editor ships a Monarch keyword tokenizer today. Full `@kusto/monaco-kusto` schema completion is a separate dependency-add (`@kusto/monaco-kusto` + bridge-asset copy) and is tracked for a follow-up PR; the editor is fully functional without it. |

## Backend per control

- **Run** → `POST .../run` → `kusto-client.executeQuery` (`.`-prefixed → `executeMgmtCommand`) → ADX `/v1/rest/query` | `/v1/rest/mgmt`, UAMI bearer, `parseVisualization` extracts `@ExtendedProperties` Visualization.
- **Save / Load** → `PUT|GET .../route.ts` → Cosmos via `loadKustoItem` / `saveItemState`.
- **Grid sort/filter/resize/stats/export** → pure client-side over the real `{ columns, columnTypes, rows }` already returned by Run (no backend round-trip), per `no-vaporware.md`.
- **Pin to dashboard / Set alert** → real `kql-dashboard` / `activator` item routes.
- **Share** → client-only canonical-URL copy; access is governed by Loom item RBAC.

## Per-cloud

Cluster URI is the only cloud-specific knob (`LOOM_KUSTO_CLUSTER_URI`): Commercial
`*.kusto.windows.net`, GCC `*.kusto.usgovcloudapi.net`, GCC-High `*.kusto.azure.us`,
DoD `*.kusto.core.usgovcloudapi.net`. Token scope derives from the URI, so the
sovereign login endpoint is selected automatically. The results grid and chart
picker are cloud-agnostic (pure client over the REST response, identical shape
across clouds). No Fabric/Power BI workspace is required on any path.
