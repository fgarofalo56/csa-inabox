# Parity gap — `databricks-sql-warehouse`

> v2 fabric-parity-loop validator, run 2026-05-26.
> Reference target: Databricks Workspace → SQL → SQL Editor (Unity Catalog-aware T-SQL/Spark-SQL editor).
> Loom route: `https://loom-console-fvbbctd4eehqbkcs.b02.azurefd.net/items/databricks-sql-warehouse/new`.
> Editor source: `apps/fiab-console/lib/editors/databricks-editors.tsx` (lines 174-519).

## Phase 3 — gap matrix vs Databricks SQL editor

| # | Databricks SQL element | Loom present? | Severity |
|---|---|---|---|
| 1 | SQL editor with Monaco + Spark-SQL completion (catalog.schema.table autocomplete, `LATERAL VIEW EXPLODE`, `MERGE INTO`, Delta time travel, etc.), error squiggles | **MISSING** — plain `<textarea>` (lines 498-504). `s.editor` CSS class is just `font-family: Consolas` (line 36-42). | **BLOCKER** |
| 2 | Unity Catalog tree (catalogs → schemas → tables → columns) with lazy expand | Present (lines 347-421) — real `SHOW CATALOGS / SCHEMAS / TABLES` via `/schema` endpoint, lazy load on expand | OK |
| 3 | Click table to insert `SELECT * FROM \`catalog\`.\`schema\`.\`table\` LIMIT 100` | Present (lines 398-410) | OK |
| 4 | Warehouse selector + state badge (RUNNING / STOPPED / STARTING) | Present (lines 434-455) | OK |
| 5 | Start / Stop with state polling | Present (lines 268-300) — real 5s poll until terminal state | OK |
| 6 | Result grid with sortable columns + cell preview + export to CSV / Parquet | Partial — Fluent `<Table>` (lines 104-164) only, no sort / filter / export | MAJOR |
| 7 | Chart View toggle on results | MISSING | MAJOR |
| 8 | Query history pane (with re-run button) | MISSING — ribbon claims "Query history" (line 169) but no handler | MINOR (ribbon vapor) |
| 9 | Saved queries / dashboards | MISSING | MAJOR |
| 10 | Status bar (warehouse / catalog / schema / row count / execution time) | Partial — exec time shown in `resultMeta` (line 136-140), no full status bar | MINOR |
| 11 | Photon / Predictive I/O badges | Present (Serverless badge line 454) | OK partial |

## Phase 4 — functional click probe (source-trace)

| Control | Source impl | Live behavior |
|---|---|---|
| **Run** | `run()` (line 303-333) — real `POST /api/.../query` with warehouseId, catalog, schema | Real |
| **Start** | `start()` (line 280-290) — real `POST .../start`, then poll | Real |
| **Stop** | `stop()` (line 292-300) — real `POST .../state {action: 'stop'}` | Real |
| **Refresh** | `refreshState + refreshCatalogs` | Real |
| Warehouse dropdown | `setWarehouseId(...)` | Real |
| Catalog / schema / table click | `openCatalog` / `openSchema` / insert-SELECT (lines 243-265, 398-410) | Real |
| Ribbon "New SQL query" / "Run" / "Query history" / "Start" / "Stop" / "Scale" | No handlers | **DEAD** — 6 ribbon vapor |

## Grade

**C** — Run + warehouse lifecycle + Unity Catalog browse are all real and quite well-done. But the headline editor surface is a `<textarea>` (BLOCKER per Monaco contract), no chart view (MAJOR), no query history pane, 6 dead ribbon buttons.

Same remediation as the other SQL editors: `@monaco-editor/react language="sql"` + a custom completion provider seeded from the already-loaded catalog/schema/table tree (huge usability win — the data is already in client state).

