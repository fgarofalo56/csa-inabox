# sql-database-objects — parity with Azure SQL Database / Fabric SQL database (schema object navigator)

Source UI: the **Azure portal SQL Database → Query editor** object tree and
**SQL Server Management Studio (SSMS) / Azure Data Studio Object Explorer**,
plus the **Microsoft Fabric SQL database** in-portal object explorer. Once a
SQL database is open, its left pane is a typed navigator of the database's
schema objects (Tables → Columns, Views, Stored procedures, Functions, Table
types, Schemas) with per-group counts, a filter, ＋ New, and per-object
open/drop actions. The Loom equivalent
(`apps/fiab-console/lib/components/sqldb/sqldb-tree.tsx`) is wired into the
Fabric SQL database editor's **Tables** tab
(`lib/editors/sql-database-editor.tsx → SqlDatabaseEditor`). This is the
T-SQL/relational sibling of the ADX KQL-database, Synapse Workspace Resources,
and Databricks workspace navigators (parity wave 8). Grounded in Microsoft
Learn:

- System catalog views overview:
  https://learn.microsoft.com/sql/relational-databases/system-catalog-views/catalog-views-transact-sql
- `sys.objects` (base view; type codes U/V/P/FN/IF/TF/…):
  https://learn.microsoft.com/sql/relational-databases/system-catalog-views/sys-objects-transact-sql
- `sys.tables`, `sys.views`, `sys.procedures`, `sys.table_types`, `sys.schemas`, `sys.columns`, `sys.types`:
  https://learn.microsoft.com/sql/relational-databases/system-catalog-views/object-catalog-views-transact-sql
- Connect to a Fabric SQL database (TDS endpoint = same engine as Azure SQL):
  https://learn.microsoft.com/fabric/database/sql/connect
- `DROP TABLE` / `DROP VIEW` / `DROP PROCEDURE` / `DROP FUNCTION` / `DROP TYPE`:
  https://learn.microsoft.com/sql/t-sql/statements/drop-table-transact-sql

Data-plane host: **`<server>.database.windows.net`** (Azure SQL Commercial),
**`.database.usgovcloudapi.net`** (Gov), or **`<id>.database.fabric.microsoft.com`**
(Fabric SQL database). Object enumeration + mutation is via **TDS** (`mssql`/
`tedious`) over an **AAD access token** at scope
**`https://database.windows.net/.default`** — the same pool-backed credential
the existing `azure-sql-client.ts` already uses
(`ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID),
DefaultAzureCredential)`). The Loom UAMI must be a **Microsoft Entra admin** on
the SQL server (or a DB user with `VIEW DEFINITION` + `ALTER`).

The target **connection is item-scoped** (mirrors the ADX navigator): the BFF
resolves `{ server, database }` from the **Fabric SqlDatabase** GET
(`properties.connectionString`/`serverFqdn` + `properties.databaseName`) via
`getFabricSqlDatabaseConnection(workspaceId, id)`, using `?workspaceId=&id=`
from the navigator. When no item connection resolves it falls back to the
`NEXT_PUBLIC_LOOM_AZURE_SQL_DEFAULT_SERVER` / `…_DEFAULT_DB` env defaults
(standalone/dev); when neither yields a server the routes 503 with
`{ code: "not_configured", missing }` and the tree shows one honest MessageBar.

## Azure / SSMS / Fabric feature inventory

For the portal Query-editor object tree / SSMS Object Explorer, each object
type exposes a **list with count**, a **filter**, a **＋ New** path, and
per-object **open (script/query) / drop** actions:

| # | Object | Capabilities in the real UI |
|---|--------|------------------------------|
| 1 | **Tables** | list w/ count + row count, expand → **Columns** (name, type, nullability, identity, computed, PK), New (CREATE TABLE), Select top 1000, DROP TABLE |
| 2 | **Views** | list w/ count, New (CREATE VIEW), Select top 1000, DROP VIEW |
| 3 | **Stored procedures** | list w/ count, New (CREATE PROCEDURE), EXEC template, DROP PROCEDURE |
| 4 | **Functions** | list w/ count (scalar FN / inline-TVF IF / multi-statement-TVF TF / CLR), New (CREATE FUNCTION), DROP FUNCTION |
| 5 | **Table types** | list w/ count (user-defined table types), DROP TYPE |
| 6 | **Schemas** | list user schemas, CREATE/DROP SCHEMA |
| 7 | **Columns (per table)** | type, length/precision/scale, nullability, identity, computed, primary-key flag |
| 8 | **Indexes** | per-table index list (`sys.indexes`), CREATE/DROP INDEX, rebuild/reorganize |
| 9 | **Keys & constraints** | PK/FK/UNIQUE/CHECK/DEFAULT authoring (`sys.key_constraints` / `sys.foreign_keys` / `sys.check_constraints`) |
| 10 | **Data editing** | the portal "Edit data" grid (INSERT/UPDATE/DELETE) |
| 11 | **Query plan** | estimated + actual execution plan visualization |

## Loom coverage

| # | Object | Status | Notes |
|---|--------|--------|-------|
| 1 | Tables (+ Columns expand) | ✅ built | `sys.tables` + row count from `sys.dm_db_partition_stats`; lazy `sys.columns`/`sys.types` on expand; Select top 1000 → query tab; DROP TABLE (catalog-verified) |
| 2 | Views | ✅ built | `sys.views`; Select top 1000; DROP VIEW |
| 3 | Stored procedures | ✅ built | `sys.procedures`; EXEC template; DROP PROCEDURE |
| 4 | Functions | ✅ built | `sys.objects WHERE type IN ('FN','IF','TF','FS','FT','AF')`; type-desc badge; DROP FUNCTION |
| 5 | Table types | ✅ built | `sys.table_types` (user-defined); DROP TYPE |
| 6 | Schemas | ✅ built (list) | `sys.schemas` (user schemas); CREATE/DROP SCHEMA routed to the Query tab (same as the portal Query editor) |
| 7 | Columns | ✅ built | per-table, read-only detail |
| 8 | Indexes | ✅ built | per-table **Indexes** sub-node — `sys.indexes` + `sys.index_columns` (key + INCLUDE columns, type badge, PK/UNIQUE badges, filter); `DROP INDEX` (catalog-verified); `Script as CREATE/DROP INDEX` |
| 9 | Keys & constraints | ✅ built | per-table **Keys & constraints** sub-node — `sys.key_constraints` (PK/UNIQUE) + `sys.foreign_keys`/`sys.foreign_key_columns` (FK) + `sys.check_constraints` (CHECK); inline **designer** (`SqlConstraintBuilder`, 4 tabs) authors `ALTER TABLE … ADD CONSTRAINT`; per-constraint **Script as ADD/DROP**, **Enable/Disable** (FK/CHECK), **Delete**; `not trusted` / `disabled` badges. All catalog-verified (no string injection); the CHECK expression is the only free-text field |
| 10 | Data editing (edit rows) | ⚠️ honest-gate | "coming" row — use the Query tab for DML (read-only **Data preview** grid is built) |
| 11 | Query plan | ⚠️ honest-gate | "coming" row — `SET SHOWPLAN_XML` / `SET STATISTICS` from the Query tab |
| 12 | **Context menus (all node types)** | ✅ built | Fluent `Menu` per node: Select top 1000, Data preview, New query, New query in notebook, Rename, Script as CREATE/ALTER/DROP, Delete, Refresh |
| 13 | **Data preview grid** | ✅ built | Dialog with `LoomDataTable` (sortable + per-column filter + resize); real `SELECT TOP 1000` via `/api/sqldb/preview` (catalog-resolved name, no injection) |
| 14 | **Rename (sp_rename)** | ✅ built | `/api/sqldb/rename` → `sp_rename @objname=[catalog], @newname=@p1, @objtype='OBJECT'`; re-lists to verify; warns for view/proc/fn that `sys.sql_modules.definition` is not updated |
| 15 | **Script as CREATE/ALTER/DROP** | ✅ built | `/api/sqldb/script` → `sys.sql_modules.definition` (view/proc/fn), reconstructed DDL from `sys.columns`+`sys.key_constraints`+`sys.indexes` (table), `CREATE TYPE…AS TABLE` (table-type), `CREATE/DROP INDEX` (index); result loaded into the Query tab |
| 16 | **New query in notebook** | ✅ built | `localStorage` prefill + `router.push('/items/notebook/new?source=sql-db')`; passes the SQL as a pyodbc/pandas cell template |

**New (create)** is intentionally routed to the editor's T-SQL **Query** tab
with a CREATE TABLE/VIEW/PROCEDURE/FUNCTION template (the portal Query editor
and SSMS author objects the same way — there is no separate create form). This
is honest, not a stub: the template is real, editable T-SQL the user runs.

Zero ❌, zero fake/stub banners. The remaining honest-gate rows (9–11) name the
exact T-SQL path and render as `Badge color="warning"` "coming" rows with a
tooltip, per `ui-parity.md`.

## Backend per control

| Control | Route | Backend call |
|---------|-------|--------------|
| List tables | `GET /api/sqldb/tables` | `listTables` → `SELECT … FROM sys.tables JOIN sys.schemas` over TDS |
| List views | `GET /api/sqldb/views` | `listViews` → `sys.views` |
| List procedures | `GET /api/sqldb/procedures` | `listProcedures` → `sys.procedures` |
| List functions | `GET /api/sqldb/functions` | `listFunctions` → `sys.objects` type-filtered |
| List table types | `GET /api/sqldb/table-types` | `listTableTypes` → `sys.table_types` |
| List schemas | `GET /api/sqldb/schemas` | `listSchemas` → `sys.schemas` |
| List columns | `GET /api/sqldb/columns?objectId=` | `listColumns` → `sys.columns` + `sys.types` (parameterized `@p0`) |
| List indexes | `GET /api/sqldb/indexes?objectId=` | `listIndexes` → `sys.indexes` + `sys.index_columns` (key + INCLUDE via `STRING_AGG`, parameterized `@p0`) |
| Drop index | `DELETE /api/sqldb/indexes?objectId=&indexId=` | `dropIndex` → resolve names from `sys.indexes`/`sys.tables`, then `DROP INDEX [ix] ON [schema].[table]` |
| Data preview | `GET /api/sqldb/preview?objectId=[&top]` | `previewObject` → resolve `schema.name` from `sys.objects` (`U`/`V`), then real `SELECT TOP <n> *` |
| Rename | `POST /api/sqldb/rename` (group, objectId, newName) | `renameObject` → `sp_rename @objname=[catalog], @newname=@p1, @objtype='OBJECT'`; `warningDefinitionStale` for view/proc/fn |
| Script as | `GET /api/sqldb/script?objectId=&group=&variant=[&indexId]` | `scriptObject` → `sys.sql_modules.definition` (view/proc/fn), reconstructed CREATE TABLE/TYPE from catalog, CREATE/DROP INDEX |
| Drop table | `DELETE /api/sqldb/tables?objectId=` | `dropObject('table')` → resolve `schema.name` from `sys.objects` by id, then `DROP TABLE [schema].[name]` |
| Drop view | `DELETE /api/sqldb/views?objectId=` | `dropObject('view')` → `DROP VIEW` |
| Drop procedure | `DELETE /api/sqldb/procedures?objectId=` | `dropObject('procedure')` → `DROP PROCEDURE` |
| Drop function | `DELETE /api/sqldb/functions?objectId=` | `dropObject('function')` → `DROP FUNCTION` |
| Drop table type | `DELETE /api/sqldb/table-types?objectId=` | `dropObject('table-type')` → `DROP TYPE` |
| List constraints | `GET /api/sqldb/constraints?objectId=` | `listConstraints` → `sys.key_constraints` ∪ `sys.foreign_keys`/`sys.foreign_key_columns` ∪ `sys.check_constraints` (parameterized `@p0`) |
| Add constraint | `POST /api/sqldb/constraints` (tableObjectId, spec) | `addConstraint` → resolve table + columns by id from `sys.tables`/`sys.columns`, then `ALTER TABLE … ADD CONSTRAINT …` (PK/UQ `PRIMARY KEY`/`UNIQUE … (cols)`, FK `FOREIGN KEY … REFERENCES … ON DELETE/UPDATE …` with optional `WITH NOCHECK`, CK `CHECK(expr)`) |
| Drop constraint | `DELETE /api/sqldb/constraints?objectId=&constraintId=` | `dropConstraint` → resolve name from `sys.objects` by id, then `ALTER TABLE [schema].[table] DROP CONSTRAINT [name]` |
| Enable/disable constraint | `PATCH /api/sqldb/constraints?objectId=&constraintId=` (enable) | `toggleConstraint` (FK/CHECK) → `ALTER TABLE … WITH CHECK CHECK CONSTRAINT [name]` (enable) / `… NOCHECK CONSTRAINT [name]` (disable) |
| New (template) | (client) | loads a CREATE template into the editor's Query tab |
| New query in notebook | (client) | `localStorage` prefill + `router.push('/items/notebook/new?source=sql-db')` |

### Injection-safety

All list queries are static catalog SELECTs with **no user input** in the SQL
text (server/database are resolved per-item, never interpolated). `listColumns`
and `listIndexes` bind `objectId` as `@p0`. **DROP / DROP INDEX / preview /
Script-as** never interpolate the caller's name: the route receives an integer
`object_id` (+ integer `index_id`), the client looks up the matching
`schema.name` (and index name) in `sys.objects`/`sys.tables`/`sys.indexes`, and
emits DDL/SELECT built only from the **catalog-returned, bracket-quoted**
identifier (`]` doubled). A bad/non-matching id yields a 404, not an operation.
**Rename** resolves the old name from the catalog and binds the new bare name as
`@p1`; the route rejects any new name containing `.`, `[` or `]` so a rename can
never be coerced into a cross-schema move. The `group`/`variant` route params are
whitelisted enums.

**Keys & constraints** authoring is held to the same standard: the table and
every key column are resolved from `sys.tables` / `sys.columns` by integer
`object_id` / `column_id` (a column id that does not belong to the table → 400),
the referenced FK table + columns are resolved on the referenced table's id, and
the constraint name is validated (1–128 chars, no `.`/`[`/`]`, no leading `#`).
The **only** verbatim free-text is a CHECK constraint's boolean expression — the
same arbitrary-T-SQL field SSMS and the portal table designer expose — and it is
placed only inside the `CHECK(…)` clause (never an identifier position),
length-clamped to ≤4000 chars. Drop/enable/disable resolve the constraint from
`sys.objects` by id before emitting bracket-quoted DDL.

### Per-cloud behavior (keys & constraints)

The designer auto-detects the bound connection's TDS backend from its server
FQDN (`detectSqlBackendKind()` in `sql-objects-client.ts`) and emits the correct
DDL dialect, so the **same** inline designer is safe against every connection
type:

| Constraint | Azure SQL Database / Fabric SQL database (`sqldb`, default) | Fabric Warehouse / SQL analytics endpoint (`warehouse`) | Synapse dedicated SQL pool (`synapse-dedicated`) |
|---|---|---|---|
| PRIMARY KEY | Fully enforced; CLUSTERED or NONCLUSTERED | `NONCLUSTERED NOT ENFORCED` (forced) | `NONCLUSTERED NOT ENFORCED` (forced) |
| UNIQUE | Fully enforced; NONCLUSTERED | `NONCLUSTERED NOT ENFORCED` (forced) | `NONCLUSTERED NOT ENFORCED` (forced) |
| FOREIGN KEY | Fully enforced; `WITH NOCHECK`; ON DELETE/UPDATE CASCADE/SET NULL/SET DEFAULT | `NOT ENFORCED` (no actions, no `WITH (NO)CHECK`) | **Not supported** (honest 400) |
| CHECK | Fully enforced; `WITH NOCHECK` | **Not supported** (honest 400) | **Not supported** (honest 400) |

Backend detection: `*.datawarehouse.fabric.microsoft.com/.us` → `warehouse`;
`*.sql.azuresynapse.net/.usgovcloudapi.net` → `synapse-dedicated`; everything
else (Azure SQL `*.database.windows.net`, Fabric SQL DB
`*.database.fabric.microsoft.com`) → `sqldb`.

Loom's **default** target is Azure SQL Database **and** Fabric SQL database,
which share the same TDS engine and enforce all four types identically — so the
designer emits standard **enforced** DDL with **no Fabric workspace dependency**
(works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset). On a metadata-only backend
the builder honestly disables the controls that backend rejects (the CHECK tab,
the CLUSTERED checkbox, `WITH NOCHECK`, ON DELETE/UPDATE, and the FK tab on a
dedicated pool) and surfaces an info MessageBar explaining the `NOT ENFORCED`
semantics; the server-side `addConstraint()` is the authority and rejects
unsupported types with a 400 regardless of the client. Grounded in
`learn.microsoft.com/fabric/data-warehouse/table-constraints` and
`learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/sql-data-warehouse-table-constraints`.

## Files

- `apps/fiab-console/lib/azure/sql-objects-client.ts` — catalog enumeration + `sqlConfigGate()` + `dropObject()` + `listIndexes()`/`dropIndex()` + `renameObject()` + `previewObject()` + `scriptObject()` + **`listConstraints()`/`addConstraint()`/`dropConstraint()`/`toggleConstraint()`**
- `apps/fiab-console/lib/azure/azure-sql-client.ts` — `executeParameterized()` + `executeQuery()` (reuse the existing TDS+AAD pool)
- `apps/fiab-console/lib/azure/fabric-client.ts` — `getFabricSqlDatabaseConnection()`
- `apps/fiab-console/app/api/sqldb/_shared.ts` — session guard + item-scoped connection resolution + honest gate
- `apps/fiab-console/app/api/sqldb/{tables,views,procedures,functions,table-types,schemas,columns,indexes,preview,rename,script,constraints}/route.ts`
- `apps/fiab-console/lib/components/sqldb/sqldb-tree.tsx` — the navigator (context menus, Indexes + Keys & constraints sub-nodes, Data preview + Rename + Constraint-designer dialogs)
- `apps/fiab-console/lib/components/sqldb/sqldb-table-designer.tsx` — `SqlConstraintsNode`: the per-table Keys & constraints list + per-constraint menu (Script as ADD/DROP, Enable/Disable, Delete)
- `apps/fiab-console/lib/components/sqldb/sqldb-constraint-builder.tsx` — `SqlConstraintBuilder`: the 4-tab (PK/UQ/FK/CHECK) inline designer dialog
- `apps/fiab-console/lib/editors/sql-database-editor.tsx` — wires the tree into the Tables tab + the `New query in notebook` deep-link
- `apps/fiab-console/lib/azure/__tests__/sql-objects-script.test.ts` — unit coverage for indexes/rename/preview/script generation + injection-safety guards
- `apps/fiab-console/lib/azure/__tests__/sql-constraints.test.ts` — unit coverage for list/add/drop/toggle constraint DDL generation + name + column injection-safety guards

## Verification

`pnpm build` exit 0 (all 12 `/api/sqldb/*` routes registered, incl. `constraints`) +
`npx vitest run lib/azure/__tests__/sql-objects-script.test.ts lib/azure/__tests__/sql-constraints.test.ts` green. Live
functional verification requires a deployment with a reachable SQL server (UAMI
as Entra admin) bound to a Fabric SQL database item, or
`NEXT_PUBLIC_LOOM_AZURE_SQL_DEFAULT_SERVER` + `…_DEFAULT_DB` set; without one,
the navigator renders the honest infra-gate MessageBar (verified by the gate
path returning `503 { code: "not_configured" }`). With a reachable DB: the
Indexes node lists real `sys.indexes` names; `Select top 1000` opens a query
with live rows; `Rename` renames the object (re-listing shows the new name);
`Script as CREATE` emits runnable DDL (the `OBJECT_DEFINITION`/`sys.sql_modules`
body for view/proc/fn, reconstructed CREATE TABLE for tables) into the Query tab.
