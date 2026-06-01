# adx-kusto — parity with Azure Data Explorer (Kusto)

> **Brutally-honest 1:1 parity audit (2026-05-31).** Graded conservatively per
> `.claude/rules/no-vaporware.md` + `.claude/rules/ui-parity.md`. A UI with no
> real backend is **not** "built". When in doubt, graded DOWN.
>
> **Scope note.** This doc audits the *whole* Azure Data Explorer (Kusto)
> service surface — the **ADX web UI** (`https://dataexplorer.azure.com`) AND
> the **Azure portal Microsoft.Kusto/clusters blades** (cluster lifecycle,
> scale, permissions, data connections, databases). The pre-existing
> `adx-kql-database.md` covers ONLY the KQL-database object navigator (one
> left-pane tree) and grades itself "Zero ❌" by scoping to that single pane —
> it conveniently omits the entire query editor, results grid, cluster
> lifecycle, scale, and permissions surfaces. This doc is the honest superset.

Source UI (grounded in Microsoft Learn, not memory):

- Web UI query overview: https://learn.microsoft.com/azure/data-explorer/web-ui-query-overview
- Web UI results grid (sort/filter/group/pivot/search/cell-stats): https://learn.microsoft.com/azure/data-explorer/web-results-grid
- Web UI keyboard shortcuts: https://learn.microsoft.com/azure/data-explorer/web-ui-query-keyboard-shortcuts
- Share & export queries (Excel / CSV / Power BI / pin): https://learn.microsoft.com/azure/data-explorer/web-share-queries
- Data profile (quick column insights): https://learn.microsoft.com/azure/data-explorer/data-profile
- ADX dashboards (tiles/pages/params/data-sources/auto-refresh/export): https://learn.microsoft.com/azure/data-explorer/azure-data-explorer-dashboards
- Create cluster & database (portal): https://learn.microsoft.com/azure/data-explorer/create-cluster-and-database
- Stop / start cluster (portal Overview): https://learn.microsoft.com/azure/data-explorer/create-cluster-and-database#stop-and-restart-the-cluster
- Horizontal scaling (scale out): https://learn.microsoft.com/azure/data-explorer/manage-cluster-horizontal-scaling
- Vertical scaling (scale up): https://learn.microsoft.com/azure/data-explorer/manage-cluster-vertical-scaling
- Manage cluster permissions: https://learn.microsoft.com/azure/data-explorer/manage-cluster-permissions
- Manage database permissions: https://learn.microsoft.com/azure/data-explorer/manage-database-permissions
- Fabric RTI — manage/monitor database + ribbon: https://learn.microsoft.com/fabric/real-time-intelligence/manage-monitor-database
- Fabric RTI — edit table schema: https://learn.microsoft.com/fabric/real-time-intelligence/edit-table-schema
- Fabric RTI — data policies (retention/caching): https://learn.microsoft.com/fabric/real-time-intelligence/data-policies

**Loom surfaces audited**

- `lib/editors/phase3-editors.tsx` → `EventhouseEditor`, `KqlDatabaseEditor`, `KqlQuerysetEditor`, `KqlDashboardEditor`
- `lib/components/adx/adx-database-tree.tsx` → KQL-database object navigator
- `lib/azure/kusto-client.ts` → Kusto raw REST client (`/v1/rest/query`, `/v1/rest/mgmt`, ARM)
- BFF: `app/api/adx/{tables,functions,materialized-views,ingestion-mappings,overview}/route.ts`
- BFF: `app/api/items/kql-database/[id]/{route,query,tables}/route.ts`
- BFF: `app/api/items/eventhouse/[id]/{database,ingest,policies}/route.ts`
- BFF: `app/api/items/kql-dashboard/[id]/{route,run,param-values}/route.ts`
- BFF: `app/api/items/kql-queryset/[id]/{route,run}/route.ts`

Data plane: control commands + queries POSTed to `https://<cluster>.kusto.windows.net/v1/rest/{mgmt,query}` with `{db, csl}`; token scope `<cluster-uri>/.default`; auth `ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID), DefaultAzureCredential)`. Cluster/database/data-connection lifecycle is ARM (`Microsoft.Kusto/clusters/...`). The shared cluster `adx-csa-loom-shared.eastus2.kusto.windows.net` is the default; honest 503 gate when `LOOM_KUSTO_CLUSTER_URI` is unset.

---

## Azure / Fabric feature inventory  (the parity bar)

### A. Web UI — query editor & connection pane

| # | Capability (real ADX web UI) |
|---|------------------------------|
| A1 | Connection pane: browse clusters/databases; expand DB → tables, functions, external tables, materialized views |
| A2 | Connection-pane right-click menu: Ingest data, Create table, …; favorites (star); cluster groups |
| A3 | Add cluster connection (multi-cluster) |
| A4 | KQL query editor with **IntelliSense / autocompletion**, cross-DB lint, optimization hints |
| A5 | Run (Shift+Enter); Run-with-preview (50 rows, Alt+Shift+Enter); Cancel (Esc) |
| A6 | Management-command execution (`.show`/`.create`/`.alter`/`.ingest`) routed to mgmt endpoint |
| A7 | Multiple query tabs, each with own context; rename tab; tabs list |
| A8 | Recall previous queries (last 50 cached, F8) |
| A9 | Keyboard shortcuts (fold/unfold, tab nav, recall, reopen-closed-tab) |

### B. Web UI — results grid

| # | Capability |
|---|-----------|
| B1 | Tabular results grid |
| B2 | Column sort |
| B3 | Column filter (operator builder, multi-condition) |
| B4 | Group by column |
| B5 | Pivot mode (rows / values / column-labels, Excel-like) |
| B6 | Search-in-grid (highlight, next/prev, "show only matching rows") |
| B7 | Cell statistics (select cells → Avg/Count/Min/Max/Sum) |
| B8 | Data-cell selection → insert as query filter (Ctrl+Shift+Space) |
| B9 | Per-column data profile / quick insights (types, stats, top values) |
| B10 | Inline render visualizations (`render` operator → table/bar/line/pie/timechart/etc.) |
| B11 | Query statistics (duration, CPU, memory, data scanned) |
| B12 | Expand/JSON cell viewer |

### C. Web UI — share & export

| # | Capability |
|---|-----------|
| C1 | Pin query → dashboard |
| C2 | Copy query / copy results |
| C3 | Export → CSV |
| C4 | Export → Open in Excel (live-connected workbook) |
| C5 | Export → Query to Power BI |
| C6 | Share query link |

### D. Get data (ingestion wizards)

| # | Capability |
|---|-----------|
| D1 | Get data from local file (CSV/JSON/Parquet) with schema inference + mapping |
| D2 | Get data from Azure Storage (blob/ADLS) |
| D3 | Get data from Event Hub (streaming data connection) |
| D4 | Get data from OneLake / other Fabric sources |
| D5 | One-time vs continuous ingestion; ingestion-mapping authoring with column preview |

### E. KQL database / table management (web UI + Fabric ribbon)

| # | Capability |
|---|-----------|
| E1 | Object tree: Tables / Functions / Materialized views / External tables / Ingestion mappings with counts |
| E2 | Create table (column schema builder) |
| E3 | Edit table schema / rename / drop table; command viewer |
| E4 | Create / drop function (args + body) |
| E5 | Create / drop materialized view |
| E6 | Create / drop ingestion mapping (per kind) |
| E7 | Table update policy (transform-on-ingest) |
| E8 | Retention policy (per table / per DB) |
| E9 | Caching (hot-cache) policy (per table / per DB) |
| E10 | Row-level security policy |
| E11 | External tables (Blob/ADLS/SQL) |
| E12 | OneLake shortcut / one-logical-copy (Fabric) |
| E13 | Continuous export (create/enable/disable/drop) |
| E14 | Database/table details pane (size, row count, last ingestion, URIs, policies) |
| E15 | Entity diagram view (Fabric) |
| E16 | `.show database schema` / clone schema |

### F. Cluster lifecycle & settings (Azure portal — Microsoft.Kusto/clusters)

| # | Capability |
|---|-----------|
| F1 | Create cluster (SKU/tier/region, create wizard) |
| F2 | Overview blade (state, URIs, key metrics) |
| F3 | Stop cluster / Start cluster |
| F4 | Scale up (vertical — change SKU) |
| F5 | Scale out (horizontal — manual / optimized autoscale / custom autoscale rules) |
| F6 | Create / delete database (ARM) |
| F7 | Cluster permissions (AllDatabasesAdmin/Viewer/Monitor principal assignments) |
| F8 | Database permissions (Admin/User/Viewer/Ingestor/UnrestrictedViewer/Monitor) |
| F9 | Data connections (Event Hub / IoT Hub / Event Grid) — list/create/delete |
| F10 | Databases blade (list, navigate, per-DB permissions) |
| F11 | Networking (private endpoints, public access), Diagnostic settings, Managed identity config |
| F12 | Delete cluster |

### G. Dashboards (ADX dashboards / Fabric Real-Time Dashboard)

| # | Capability |
|---|-----------|
| G1 | New dashboard; tiles (add/remove/resize/move) |
| G2 | Tile = KQL + data source + visual type; per-tile run |
| G3 | Data sources panel (add cluster+DB, query-results cache) |
| G4 | Parameters (free-text / fixed / multi / query-based / datasource / time-range) substituted into tiles |
| G5 | Global time-range picker |
| G6 | Auto-refresh (min interval + default rate) + manual refresh |
| G7 | Pages (multi-page dashboards) |
| G8 | Export / import dashboard to JSON file; replace-from-file |
| G9 | Pin-from-query; view-query / edit-tile; legend interaction |
| G10 | Visual formatting pane (axes, legend, colors, cross-filter) |

---

## Loom coverage

Legend: **built ✅** (full 1:1 + real backend) · **partial ⚠️** (exists, incomplete/rough) · **gated ⚠️** (honest infra-gate only, no real function) · **MISSING ❌**.

### A. Query editor & connection pane

| # | Status | Loom location / notes |
|---|--------|----------------------|
| A1 | partial ⚠️ | `adx-database-tree.tsx` — left-pane tree of Tables/Functions/MViews/Mappings + read-only schema + continuous-export rows. Single bound DB per editor; no cluster/multi-DB browser, no external-tables group |
| A2 | partial ⚠️ | New menu (Table/Function/MView/Mapping) + per-row drop; **no** right-click context menu, **no** favorites/groups |
| A3 | MISSING ❌ | No "add cluster connection"; cluster is env-pinned (`LOOM_KUSTO_CLUSTER_URI`) |
| A4 | partial ⚠️ | `MonacoTextarea language="kql"` (Monaco). Real KQL IntelliSense via monaco-kusto NOT confirmed wired; no cross-DB lint / optimization hints |
| A5 | partial ⚠️ | Run button + Shift+Enter; Queryset has Cancel (client-side abort only). **No** Run-with-preview (50-row) variant |
| A6 | built ✅ | `POST /api/items/kql-database/[id]/query` auto-routes `.`-prefixed to `/v1/rest/mgmt`, else `/v1/rest/query` (real) |
| A7 | partial ⚠️ | KQL **Queryset** editor has a saved-queries list (add/select/delete/save to Cosmos) — close but not the web-UI multi-tab-with-context model; KQL Database editor is single-pane |
| A8 | MISSING ❌ | No query recall / history cache |
| A9 | partial ⚠️ | Shift+Enter run, Ctrl+S save (queryset). No fold/tab-nav/recall/reopen shortcuts |

### B. Results grid

| # | Status | Loom location / notes |
|---|--------|----------------------|
| B1 | built ✅ | `KustoResultsGrid` (`lib/components/adx/kusto-results-grid.tsx`) over real `{columns, columnTypes, rows}` from `/v1/rest/query`, wired into `phase3-editors.tsx:384`; sticky header, render cap with honest "capped at N" badge, "Showing N of M · total" readout |
| B2 | built ✅ | **Column sort now built.** Header click cycles asc → desc → none; type-aware via `makeComparator` — numeric/datetime columns sort by value (epoch for datetime), strings case-insensitively, empties last (`kusto-results-grid.tsx:131-161`) |
| B3 | built ✅ | **Per-column filter now built.** Filter-toggle reveals a per-column substring (case-insensitive) input row (`:625-635`); `activeColFilters` AND-combined |
| B4 | MISSING ❌ | No group-by |
| B5 | MISSING ❌ | No pivot mode |
| B6 | built ✅ | **In-grid search now built.** Global "Search in grid" box filters rows + `HighlightedText` highlights matched substrings in cells (`:553-562`, `:346-363`) |
| B7 | built ✅ | **Cell/column statistics now built.** Per-column stats popover (`ColumnStatsPopover`): count / nulls / distinct, and for numeric columns min / max / sum / avg; non-numeric → most-common value (`computeColumnStats`, `:368-434`) over the current (sorted+filtered) view |
| B8 | MISSING ❌ | No cell-selection → filter insertion (Ctrl+Shift+Space) |
| B9 | partial ⚠️ | Per-column stats popover (B7) doubles as quick column insights (distinct/nulls/most-common/numeric aggregates); not the full ADX per-column data-profile pane (type histogram / top-values bars) |
| B10 | partial ⚠️ | Dependency-free SVG charts: table/bar/line in query panel; dashboard tiles add column/pie/stat/map/timechart. **Not** the KQL `render`-operator-driven viz; hand-rolled |
| B11 | partial ⚠️ | Shows row count + execution ms only; no CPU/memory/data-scanned stats |
| B12 | partial ⚠️ | Objects stringified via `JSON.stringify` in cell; no expandable JSON cell viewer |

### C. Share & export

| # | Status | Loom location / notes |
|---|--------|----------------------|
| C1 | built ✅ | Queryset "Save to dashboard" → lists kql-dashboards, appends a tile, `PUT /api/items/kql-dashboard/[id]` (real Cosmos) |
| C2 | partial ⚠️ | **Copy results now built** — grid toolbar "Copy" writes the visible (sorted+filtered) rows as TSV to the clipboard, with a hidden-textarea fallback (`kusto-results-grid.tsx:524-540`). No separate copy-*query*-text affordance |
| C3 | built ✅ | **Export-to-CSV now built** — grid toolbar "CSV" downloads the visible rows as an RFC-4180 CSV Blob (`buildCsv` + `downloadCsv`, `:214-222`, `:513-522`) |
| C4 | MISSING ❌ | No Open-in-Excel |
| C5 | MISSING ❌ | No Query-to-Power-BI export |
| C6 | MISSING ❌ | No share-link |
| — | bonus | Queryset "Set alert" → creates an Activator rule (`POST /api/items/activator/[id]/rules`) — not an ADX web-UI feature but a real Fabric-RTI flow |

### D. Get data

| # | Status | Loom location / notes |
|---|--------|----------------------|
| D1 | built ✅ | Eventhouse "Get data → Upload file" parses CSV/JSON ≤5 MB / 50k rows server-side → `.ingest inline` (real). KQL-DB ribbon also has inline CSV ingest. **Does not** auto-create table or infer schema/mapping |
| D2 | MISSING ❌ | No blob/ADLS get-data wizard (only the raw OneLake path mode below) |
| D3 | gated ⚠️ | Eventhouse "Get data → Event Hub" PUTs a `Microsoft.Kusto/.../dataConnections` via ARM — real, but gated on `LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID` + `LOOM_SUBSCRIPTION_ID` (honest 503 otherwise) |
| D4 | partial ⚠️ | Eventhouse "Get data → OneLake path" runs `.ingest into table (h'<path>')` (real); a single text path, no Fabric OneLake browser / shortcut wizard |
| D5 | partial ⚠️ | Ingestion-mapping create dialog takes a validated JSON mapping array (real `.create-or-alter … mapping`); no column-preview builder; no one-time-vs-continuous toggle in the wizard |

### E. KQL database / table management

| # | Status | Loom location / notes |
|---|--------|----------------------|
| E1 | partial ⚠️ | Tree has Tables/Functions/MViews/Mappings + counts; **External tables group MISSING** (only a "coming" row); no entity-diagram |
| E2 | built ✅ | New table (schema textarea) → `POST /api/adx/tables` → `.create table` (real) |
| E3 | partial ⚠️ | Drop table (real). **No edit-schema / rename / command-viewer** |
| E4 | built ✅ | New/drop function → `/api/adx/functions` → `.create-or-alter function` / `.drop function` (real) |
| E5 | built ✅ | New/drop MView → `/api/adx/materialized-views` → `.create materialized-view` / `.drop` (real) |
| E6 | built ✅ | New/drop ingestion mapping → `/api/adx/ingestion-mappings` (real) |
| E7 | partial ⚠️ | KQL-DB ribbon "New → Update policy" builds `.alter table T policy update @'[…]'` and POSTs via the query route (real). Navigator shows it as a "coming" row; no list/edit of existing update policies |
| E8 | partial ⚠️ | **Read now built too.** Navigator has a real **Policies group** listing db-level retention/caching/sharding/mergepolicy/streamingingestion via `GET /api/adx/policies` → `showDatabasePolicies()` → real `.show database <db> policy <kind>` (`kusto-client.ts:342`, tree `:423-440`). Authoring remains Eventhouse "Data policies" dialog → real `.alter database policy retention` (db-level). Still no per-table policy, and navigator policies are read-only (no inline `.alter`) |
| E9 | partial ⚠️ | Same as E8 for caching: navigator now **lists** db caching policy read-only (real `.show … policy caching`); Eventhouse dialog **writes** it (real `.alter database policy caching`). Db-level only, no per-table |
| E10 | MISSING ❌ | Row-level security — still only a "coming" tooltip row (`adx-database-tree.tsx:476`), no `.alter table policy row_level_security` backend wired |
| E11 | MISSING ❌ | External tables — only a "coming" tooltip row, no list/create backend |
| E12 | gated ⚠️ | OneLake availability toggle in Eventhouse policies → `.alter database policy OneLakeAvailability` only when `LOOM_KUSTO_FABRIC_MANAGED=true`; else honest skip-note. No OneLake-shortcut wizard |
| E13 | partial ⚠️ | Continuous export **list** is real (`.show continuous-exports` via `/api/adx/overview`); create/enable/disable/drop are "coming" rows (no backend) |
| E14 | partial ⚠️ | `GET /api/items/kql-database/[id]` returns real `.show database details` + table/fn/mview counts; KQL-DB editor shows db name + cluster badge but **no rich details pane** (size/last-ingestion/URIs/policy values) like the Fabric right pane |
| E15 | MISSING ❌ | No entity diagram view |
| E16 | built ✅ | "Show full schema" loads `.show database schema`; `/api/adx/overview` returns `.show database schema as json` (real) |

### F. Cluster lifecycle & settings (Azure portal blades)

| # | Status | Loom location / notes |
|---|--------|----------------------|
| F1 | MISSING ❌ | No cluster-create wizard (cluster is pre-provisioned + env-pinned) |
| F2 | MISSING ❌ | No cluster Overview blade (state/metrics/URIs grid) |
| F3 | MISSING ❌ | **No Stop / Start cluster** |
| F4 | MISSING ❌ | **No scale-up (vertical / SKU change)** in this surface |
| F5 | MISSING ❌ | **No scale-out / autoscale rules** in this surface. (NOTE: a separate admin-scaling surface + `kusto-arm-client.ts` exists repo-wide, but is not part of the ADX/KQL editor parity here) |
| F6 | built ✅ | Create DB → Eventhouse "New KQL database" → `POST /api/items/eventhouse/[id]/database` → ARM `PUT Microsoft.Kusto/clusters/{c}/databases/{d}` (real). **No delete-DB** in UI |
| F7 | MISSING ❌ | No cluster-permission (AllDatabasesAdmin/Viewer/Monitor) management UI |
| F8 | MISSING ❌ | No database-permission (Admin/User/Viewer/Ingestor/Monitor `.add database … `) management UI |
| F9 | partial ⚠️ | Event Hub data-connection **create** exists (D3, ARM, gated). **No list/delete** of data connections; no IoT Hub / Event Grid |
| F10 | partial ⚠️ | Eventhouse editor lists databases as cards (real `.show databases`) with select/query/get-data; not the portal Databases blade with per-DB permissions |
| F11 | MISSING ❌ | No networking / private-endpoint / diagnostic-settings / managed-identity blades |
| F12 | MISSING ❌ | No delete-cluster |

### G. Dashboards (KqlDashboardEditor — strongest surface)

| # | Status | Loom location / notes |
|---|--------|----------------------|
| G1 | built ✅ | Add/delete tiles, grid w/h spans; `PUT /api/items/kql-dashboard/[id]` persists model to Cosmos |
| G2 | built ✅ | Tile = KQL + viz + data source; per-tile run via `POST /run` (real `/v1/rest/query`) |
| G3 | built ✅ | Data sources panel (id/name/database/clusterUri) consumed by `/run` resolution |
| G4 | built ✅ | Parameters (freetext/fixed/multi/query/datasource/duration) substituted via `substituteTileKql`; query-based values via `/param-values` (real) |
| G5 | built ✅ | Global time-range picker (`last-15m`…`all`) injected as `_startTime/_endTime` |
| G6 | partial ⚠️ | Auto-refresh interval persisted; manual refresh works. Min-interval/default-rate split + viewer-adjustable range not modeled |
| G7 | MISSING ❌ | No multi-page support (ADX/Fabric `pages[]`) |
| G8 | partial ⚠️ | A JSON view/edit dialog exists (`jsonOpen/jsonText`); not the ADX dashboard-file schema export/import/replace |
| G9 | built ✅ | Pin-from-query (from Queryset) + per-tile edit run; legend interaction n/a (hand-rolled SVG) |
| G10 | MISSING ❌ | No visual-formatting pane (axes/legend/colors/cross-filter) |

---

## Backend per control (real wiring)

| Control | BFF route | Backend |
|---------|-----------|---------|
| KQL query / mgmt | `POST /api/items/kql-database/[id]/query` | real `/v1/rest/query` or `/v1/rest/mgmt` |
| Tables list/create/drop | `/api/adx/tables` | `.show tables details` / `.create table` / `.drop table` |
| Functions | `/api/adx/functions` | `.show functions` / `.create-or-alter function` / `.drop function` |
| Materialized views | `/api/adx/materialized-views` | `.show materialized-views` / `.create materialized-view` / `.drop` |
| Ingestion mappings | `/api/adx/ingestion-mappings` | `.show ingestion mappings` / `.create-or-alter … mapping` / `.drop … mapping` |
| Schema + continuous-export (read) | `/api/adx/overview` | `.show database … schema as json` / `.show continuous-exports` |
| DB policies (read-only list) | `GET /api/adx/policies` | `.show database <db> policy <kind>` × {retention, caching, sharding, mergepolicy, streamingingestion} (`showDatabasePolicies`) |
| DB details + object counts | `GET /api/items/kql-database/[id]` | `.show database details` + `.show tables/functions/materialized-views` |
| Create database | `POST /api/items/eventhouse/[id]/database` | ARM `PUT Microsoft.Kusto/clusters/{c}/databases/{d}` |
| Ingest file | `POST /api/items/eventhouse/[id]/ingest` (multipart) | `.ingest inline` |
| Ingest Event Hub | `POST …/ingest` (kind=eventhub) | ARM `PUT …/dataConnections/{n}` (gated env) |
| Ingest OneLake path | `POST …/ingest` (kind=onelake) | `.ingest into table (h'<path>')` |
| Data policies | `POST /api/items/eventhouse/[id]/policies` | `.alter database policy caching/retention` (+ OneLakeAvailability gated) |
| Dashboard model + run | `/api/items/kql-dashboard/[id]` (GET/PUT/?run), `/run`, `/param-values` | Cosmos persist + real `/v1/rest/query` per tile |
| Queryset save/run | `/api/items/kql-queryset/[id]`, `/run` | Cosmos persist + real `/v1/rest/query` |

All routes session-guard, apply the `LOOM_KUSTO_CLUSTER_URI` config gate (honest 503 `not_configured`), and return `{ ok, … }` JSON. No mock arrays found in the audited ADX surfaces.

---

## Honest gaps summary (highest value first)

1. **Cluster lifecycle entirely absent in this surface** — no Stop/Start (F3), no scale-up (F4), no scale-out/autoscale (F5), no Overview/metrics (F2), no create/delete cluster (F1/F12). These are core portal verbs and are the biggest parity hole. (A separate `kusto-arm-client.ts` + admin-scaling surface exists in the repo but is not surfaced in the ADX editor.)
2. **Permissions management missing** — no cluster (F7) or database (F8) RBAC principal assignment UI; the live UAMI runs as AllDatabasesAdmin and there's no way to grant/revoke from Loom.
3. ~~Results grid is a static table~~ — **largely RESOLVED (PR #545).** `KustoResultsGrid` now does sort (B2), per-column filter (B3), in-grid search+highlight (B6), and column statistics (B7). Still missing: group-by (B4), pivot (B5), cell-selection→filter (B8), full data-profile pane (B9).
4. **Export/share partly built** — CSV download (C3) + copy-as-TSV (C2) now built in the grid; still no Open-in-Excel (C4) / Query-to-Power-BI (C5) / share-link (C6).
5. **Table schema editing** — drop only; no edit-schema/rename/command-viewer (E3); RLS (E10) and external tables (E11) are tooltip-only "coming" rows with no backend.
6. **Get-data wizards thin** — file inline + Event Hub (gated) + OneLake path only; no blob/ADLS wizard, no schema inference / mapping preview, no continuous-vs-one-time toggle (D2, D5).
7. **No query tabs / recall / IntelliSense confirmation** (A3, A7, A8; A4 unverified).
8. **Dashboards lack pages, file import/export, visual-formatting pane** (G7, G8, G10) — though tiles/params/data-sources/time-range/run are genuinely built ✅.

## Grade: **C+ (functional, rough in places; results grid now strong)**

> **rev.2 — corrected against current code (PRs #536 / #545).** Two pillars the
> rev.1 audit graded as essentially unbuilt are now real: (1) the **rich results
> grid** — `KustoResultsGrid` adds sort (B2), per-column filter (B3), in-grid
> search+highlight (B6), column statistics (B7), CSV export (C3) and copy-TSV
> (C2), all client-side over the real query rows and wired into the KQL editors;
> (2) **database policies read** — a real navigator Policies group lists
> retention/caching/sharding/mergepolicy/streamingingestion via
> `.show database <db> policy <kind>` (`/api/adx/policies`). RLS (E10) is still
> tooltip-only. Grade raised C → C+.

Justification: The **dashboard builder (G)**, the **KQL-database object navigator CRUD (E2/E4/E5/E6/E16) + query/mgmt execution (A6, B1)**, and now the **rich results grid (B2/B3/B6/B7 + CSV/copy C2/C3)** plus **read-only db policies (E8/E9 list)** are genuinely production-grade with real Kusto/ARM backends — no mocks, honest gates. That is solidly above D and the grid lift moves it past a flat C. But measured against the *full* Azure Data Explorer service the operator named, the surface is still missing entire pillars: **cluster lifecycle/scale/start-stop (F1–F5, F12), RBAC permissions (F7/F8), RLS (E10), and the heavier grid features (group-by B4 / pivot B5 / data-profile B9)** remain MISSING ❌, and Open-in-Excel / Power-BI / share-link (C4–C6) are absent. That ceiling is still below B (production parity) and far below A. The pre-existing `adx-kql-database.md`'s "Zero ❌ / A-grade" claim remains only defensible by scoping to one left-pane tree; for the service as a whole it is over-stated.

## Verification status

- Code-grounded (every status above traced to a file/route in `apps/fiab-console`).
- Live `pnpm uat` side-by-side vs `dataexplorer.azure.com` + the Kusto portal blades: **NOT performed in this audit** (no minted session in this worktree) — so even the ✅ rows are "code-confirmed real backend," not "click-verified against live Azure." Per the no-scaffold rule, treat ✅ as provisional until a browser walk confirms.
