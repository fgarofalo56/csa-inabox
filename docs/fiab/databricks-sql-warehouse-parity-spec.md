# Loom Databricks SQL Warehouse Editor — Parity build spec

> Reference: Azure Databricks **SQL → Warehouses** UI (`adb-<id>.azuredatabricks.net/sql/warehouses`). Formerly "SQL endpoints". SQL warehouses are managed Spark+Photon clusters tuned for low-latency BI/SQL workloads — Serverless (Databricks-managed in the control-plane subscription), Pro (Photon, classic compute), or Classic (Photon-optional, classic compute).

## Why this exists

Loom ships `DatabricksSqlWarehouseEditor` plus `/api/items/databricks-sql-warehouse/**`. Today it lists warehouses (`listWarehouses`), reads state (`getWarehouse`), starts (`startWarehouse`), stops (`stopWarehouse`), browses Unity Catalog (catalogs → schemas → tables via `SHOW CATALOGS / SCHEMAS / TABLES`), and executes statements via the **Statement Execution API** (`POST /api/2.0/sql/statements` with INLINE disposition, JSON_ARRAY format, 30s wait + poll). Results render in a real Fluent UI table. That's **A-grade** — real warehouses, real Statement Execution API, real polling, real Unity Catalog browse. No mocks anywhere. Polish gaps are about create/edit/delete of warehouses, query history, alerts, and result-set ergonomics.

## Databricks SQL Warehouse UX inventory (SQL UI)

### Warehouses list page

| Region | Elements |
|---|---|
| **Header** | Create SQL warehouse · Search · Filter (state / type / size / creator) |
| **Table** | Name · State (Running / Starting / Stopping / Stopped / Deleted) · Type (Serverless / Pro / Classic) · Cluster size (2X-Small → 4X-Large) · Auto stop (min) · Photon · Channel (Current / Preview) · Spend per hour · Tags |
| **Row action** | Start · Stop · Edit · Delete · Permissions · Monitor |

### Warehouse create / edit dialog

| Section | Fields |
|---|---|
| **Identity** | Name · Tags |
| **Cluster size** | `2X-Small` (1 DBU/h) · `X-Small` · `Small` · `Medium` · `Large` · `X-Large` · `2X-Large` · `3X-Large` · `4X-Large` (each doubles compute) |
| **Auto stop** | Stop after N minutes idle (default 10) |
| **Scaling** | Min clusters · Max clusters (concurrency scale-out) |
| **Type** | Serverless · Pro · Classic |
| **Photon** | Enabled (always on for Serverless/Pro; toggle for Classic) |
| **Channel** | Current · Preview (newer SQL features) |
| **Advanced — Unity Catalog** | (auto on UC-enabled workspaces) |
| **Advanced — Spark settings** | `spark_conf` overrides |
| **Advanced — Tags** | Cost-allocation tags |
| **Permissions** | Can Use · Can Manage |

### Warehouse detail page tabs

- **Overview** — state, size, type, connection string, JDBC/ODBC config, server hostname, HTTP path
- **Monitoring** — Running clusters chart (with `Activity details` overlay showing query / fetching / ready intervals), live query count, queue depth, peak concurrency
- **Query history** — every statement run against the warehouse: query text, duration, status, user, query ID, source (dashboard / pipeline / notebook / Genie / API), bytes scanned, rows produced, photon-eligible
- **Connection details** — server hostname, HTTP path, JDBC URL, ODBC config, Personal Access Token snippet
- **Permissions** — ACL editor

### Query editor (SQL editor surface, separate page `/sql/editor`)

| Region | Elements |
|---|---|
| **Left panel** | Catalog explorer (catalogs / schemas / tables / views / functions); Recent queries; Saved queries; Query parameters |
| **Toolbar** | Warehouse picker · Catalog/Schema context · Run · Schedule · Share · Visualize · Download CSV/Excel |
| **Editor** | Monaco SQL · Multi-tab queries · Autocomplete · Format · Param widgets (`{{param_name}}`) |
| **Results** | Table (paginated, sortable) · Chart builder (bar/line/pie/area/scatter) · Counter · Pivot · Export · Save as visualization |

### Query history (separate page `/sql/history`)

- Full warehouse query log with filters: warehouse · user · status (FINISHED/FAILED/CANCELED) · time range · statement type · duration
- Click row → **Query Profile**: per-stage Spark plan, photon coverage, IO stats, runtime warnings

### Alerts (`/sql/alerts`)

- Define a query + condition (e.g. `result.value > 1000`) + schedule + notification destinations
- Alert history, current state (TRIGGERED / OK), pause/unpause

---

## What Loom has today (wired)

| Capability | Backend | UI |
|---|---|---|
| List warehouses | `GET /api/items/databricks-sql-warehouse/[id]/warehouses` → `listWarehouses()` → `/api/2.0/sql/warehouses` | Dropdown in toolbar |
| Read state | `GET /[id]/state?warehouseId=` → `getWarehouse()` → `/api/2.0/sql/warehouses/<id>` | State badge + size + serverless chip |
| Start | `POST /[id]/start?warehouseId=` → `startWarehouse()` → `/start` | Start button with starting-state poll (5s) |
| Stop | `POST /[id]/state` body `{action:'stop'}` → `stopWarehouse()` → `/stop` | Stop button |
| Browse Unity Catalog | `GET /[id]/schema?warehouseId=[&catalog=[&schema=]]` runs `SHOW CATALOGS` / `SHOW SCHEMAS IN` / `SHOW TABLES IN` via `executeStatement` | Left-panel Tree (lazy-expand) |
| Execute SQL | `POST /[id]/query` body `{sql, warehouseId, catalog?, schema?}` → `executeStatement()` → `/api/2.0/sql/statements` (INLINE, JSON_ARRAY, 5000-row cap, 30s wait + 1s poll up to 120s) | Run button + Fluent Table render with rowCount + executionMs + truncated badge |
| Click-to-template | Click table in tree → `SELECT * FROM \`<c>\`.\`<s>\`.\`<t>\` LIMIT 100;` injected into editor | Tree click handler |
| Honest gates | `STOPPED` state → MessageBar "Click Start"; query while non-RUNNING → 409 + state echo | MessageBar |

Status: **A-grade**. Real `/api/2.0/sql/statements` with proper polling and result-set marshalling. The wiring matches what `synapse-sql-editors.tsx` (Dedicated) does — that's a deliberate quality bar.

## Gaps for parity (polish)

1. **Create / Edit / Delete warehouse** — today Loom only **starts** and **stops** existing warehouses. Add Create dialog (name, size, type, photon, auto-stop, min/max clusters). Backend: `POST /api/2.0/sql/warehouses`, `POST /api/2.0/sql/warehouses/<id>/edit`, `DELETE /api/2.0/sql/warehouses/<id>`.
2. **Cluster size + scaling editor** — the size dropdown maps to DBU/hr cost. Show estimated $/hr alongside (pulled from `system.compute.warehouse_events` or a static table).
3. **Monaco SQL editor** — replace textarea with `@monaco-editor/react` configured for SQL syntax + autocomplete. Reuse what notebook spec uses.
4. **Query history** — `GET /api/2.0/sql/history/queries?filter_by={warehouse_ids:[...],statuses:[FINISHED|FAILED|CANCELED],query_start_time_range:{start_time_ms,end_time_ms}}`. Render a paginated table with click-to-Query-Profile.
5. **Query profile drilldown** — `GET /api/2.0/sql/history/queries/<query_id>` includes Spark plan + metrics. Surface a side drawer.
6. **Cancel running query** — `POST /api/2.0/sql/statements/<statement_id>/cancel` while loading. Today the editor waits up to 120s with no cancel.
7. **Export results** — Download CSV / JSON button (just iterate `rows`).
8. **Param widgets** — parse `{{name}}` placeholders in SQL, render input fields, substitute on Run with `parameters` array on the statements API.
9. **Multi-tab queries** — Fluent Tabs above the editor, each tab holds its own SQL + results.
10. **Save as Visualization** — chart builder picking columns for x/y/series. Requires no backend — render with Recharts.
11. **Connection details panel** — show server hostname + HTTP path (from the warehouse object's `odbc_params`), plus JDBC URL template and `databricks` CLI profile snippet.
12. **Alerts editor** — `POST /api/2.0/sql/alerts` (legacy) or `POST /api/2.0/alerts` (new): query_id, condition, schedule, notification destinations. Plus an alert list view.
13. **Activity details monitoring** — query the warehouse_events system table (or `/api/2.0/sql/warehouses/<id>/events` if exposed) and chart running clusters over the last hour.
14. **Permissions** — `GET /api/2.0/permissions/sql/warehouses/<id>` + PATCH.
15. **Tags** — editable in create/edit dialog; today only readable via `getWarehouse`.

## Backend mapping

- List warehouses: `GET /api/2.0/sql/warehouses` (wired)
- Get warehouse: `GET /api/2.0/sql/warehouses/<id>` (wired)
- Start: `POST /api/2.0/sql/warehouses/<id>/start` (wired)
- Stop: `POST /api/2.0/sql/warehouses/<id>/stop` (wired)
- **NEW** Create: `POST /api/2.0/sql/warehouses`
- **NEW** Edit: `POST /api/2.0/sql/warehouses/<id>/edit`
- **NEW** Delete: `DELETE /api/2.0/sql/warehouses/<id>`
- Execute statement: `POST /api/2.0/sql/statements` (wired — INLINE/JSON_ARRAY/5000-row cap)
- **NEW** Cancel statement: `POST /api/2.0/sql/statements/<id>/cancel`
- **NEW** Query history list: `GET /api/2.0/sql/history/queries` (with `filter_by`)
- **NEW** Query profile: `GET /api/2.0/sql/history/queries/<query_id>`
- **NEW** Alerts: `GET / POST / PATCH / DELETE /api/2.0/alerts`
- **NEW** Permissions: `GET / PATCH /api/2.0/permissions/sql/warehouses/<id>`
- System tables (optional, via SQL): `system.compute.warehouse_events`, `system.query.history`, `system.compute.warehouses`

## Required Azure resources

- **Azure Databricks workspace with Unity Catalog enabled** (existing — Loom already assumes UC for the catalog browser).
- **UAMI as workspace user with `CAN_USE` on warehouses** (already granted via SCIM bootstrap). For Create/Edit/Delete, the principal needs `CAN_MANAGE` on workspace SQL or be a workspace admin — verify in deployment.
- **For Serverless warehouse creation**: workspace must be in a region where Serverless is GA and the account must have Serverless enabled (account-level toggle). Surface as a MessageBar when create returns `FEATURE_DISABLED`.
- **No new Bicep needed**, but Bicep deployment should consider creating a default Pro warehouse at deploy time (`Microsoft.Databricks/workspaces/...` doesn't expose this — needs a deploymentScript that calls the SQL warehouses API post-deploy, or document as a manual step in `docs/fiab/v3-tenant-bootstrap.md`).

## Estimated effort

| Gap | Hours |
|---|---|
| Create / Edit / Delete dialog + API routes | 3 |
| Monaco SQL editor replacement | 1.5 |
| Query history table + filters | 2 |
| Query profile drawer (plan + metrics) | 2.5 |
| Cancel running statement | 1 |
| Export CSV / JSON | 0.5 |
| Param widgets (`{{name}}`) | 1.5 |
| Multi-tab queries | 1.5 |
| Save as Visualization (chart builder) | 3 |
| Connection details panel | 1 |
| Alerts editor + list | 3 |
| Activity monitoring chart | 2 |
| Permissions panel | 1.5 |
| Tags + cost estimate per size | 1 |
| **Total** | **~24.5 hrs** (3-4 focused sessions) |
