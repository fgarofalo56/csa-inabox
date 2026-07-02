# Appendix — Data Warehouse (SQL): Fabric → CSA Loom parity

**Domain:** Data Warehouse (SQL) (`data-warehouse`)
**Fabric surface:** Fabric Warehouse (full T-SQL warehouse compute) + SQL analytics endpoint (read-only over lakehouse / mirrored DB / SQL DB).
**Loom default backend:** Synapse **Dedicated** SQL pool (warehouse compute) + Synapse **Serverless** SQL (read-only endpoint) + **ADLS Gen2 + Delta** (the lake the warehouse/endpoint reads & writes). Fabric Warehouse / Power BI are **opt-in only** (`LOOM_WAREHOUSE_BACKEND=fabric-warehouse`) per `no-fabric-dependency.md`.
**Primary editor:** `WarehouseEditor` in `apps/fiab-console/lib/editors/phase3-editors.tsx` (line ~9663). Copilot bridge: `lib/editors/warehouse-editor.tsx`. Provisioner: `lib/install/provisioners/warehouse.ts`. Routes: `app/api/items/warehouse/[id]/{query,schema,model,iqy,cancel,script-out,query-acceleration}` + `migrate/{scan,import}`; read-only endpoint: `app/api/items/sql-analytics-endpoint/[id]/{query,schema,objects}`.

> **Headline:** the *authoring* surface (explorer, T-SQL editor, visual query canvas, CTAS, save-as-view, Excel, in-Loom visualize, permissions, model/relationships, parameters, cancel, multi-tab, IntelliSense, cross-DB picker, result-set caching, Copilot, migration wizard) is genuinely **A-grade and real**. The gap class is the **data-lifecycle / recovery** family that defines Fabric Warehouse's differentiation: **zero-copy CLONE TABLE, statement-level time travel (FOR TIMESTAMP AS OF), restore points + restore-in-place, a COPY INTO ingestion wizard, warehouse snapshots, and configurable data retention.** These are absent from the warehouse item today (clone/restore exist only on the separate `synapse-dedicated-sql-pool` editor as full-copy/DMV affordances). Overall Loom status: **partial** (strong authoring, weak lifecycle).

---

## 1. Fabric capability inventory (grounded in Microsoft Learn)

### A. Item model & engine
| # | Capability | How it works | Learn |
|---|---|---|---|
| A1 | **Fabric Warehouse** | Full read/write T-SQL warehouse. Stores data in OneLake as **Delta/parquet**; ANSI-SQL surface on top; dedicated distributed MPP compute; ACID multi-table transactions; auto-scale nodes; transparent in-memory + SSD cache. | [data-warehousing](https://learn.microsoft.com/fabric/data-warehouse/data-warehousing) |
| A2 | **SQL analytics endpoint** | Auto-provisioned **read-only** T-SQL surface over Delta tables of a lakehouse / mirrored DB / SQL DB. Same engine as Warehouse. No DML; views/TVFs/procs + object/row/col security only. Background metadata sync (table discovery, freshness, schema-change). | [lakehouse-sql-analytics-endpoint](https://learn.microsoft.com/fabric/data-engineering/lakehouse-sql-analytics-endpoint), [metadata-sync](https://learn.microsoft.com/fabric/data-engineering/sql-analytics-endpoint-metadata-sync) |
| A3 | **T-SQL surface area** | Tables, views, procs, scalar UDFs (preview), permissions, roles, CTEs (nested = preview), TRUNCATE, MERGE (GA), limited ALTER TABLE (ADD nullable col / DROP COLUMN / ALTER COLUMN preview / NOT ENFORCED PK·UQ·FK), `sp_rename`, session #temp tables, AI functions (preview). No CREATE USER, triggers, synonyms, materialized views, vector type, recursive queries. | [tsql-surface-area](https://learn.microsoft.com/fabric/data-warehouse/tsql-surface-area) |
| A4 | **Collation** | Workspace collation; default `Latin1_General_100_BIN2_UTF8` (CS); CI via REST at create; immutable after. | [tables#collation](https://learn.microsoft.com/fabric/data-warehouse/tables) |

### B. Authoring & query
| # | Capability | How it works | Learn |
|---|---|---|---|
| B1 | **SQL query editor** | T-SQL editor with IntelliSense, code-completion, syntax highlight, client parse/validate; DDL/DML/DCL; SQL templates dropdown; autosave; Results + Messages tabs; status bar (status/duration/rows). Each Run = independent batch/session (TCL caveats). | [sql-query-editor](https://learn.microsoft.com/fabric/data-warehouse/sql-query-editor) |
| B2 | **Visual query editor** | No-code Power-Query canvas: drag tables, merge/join (6 kinds), reduce rows, choose columns, group/aggregate; View SQL; Save as view (CREATE VIEW); Save as table (CTAS); cross-warehouse merge. | [visual-query-editor](https://learn.microsoft.com/fabric/data-warehouse/visual-query-editor) |
| B3 | **Results actions** | Save as view, Save as table (CTAS), Open in Excel (.iqy), Visualize results / Explore data, copy with/without headers, search results grid (10k preview cap). | [query-warehouse](https://learn.microsoft.com/fabric/data-warehouse/query-warehouse) |
| B4 | **Explorer + script-out** | Schemas/tables/views/SP/functions tree; context-menu Script as CREATE/ALTER/DROP, Select top 100, New table. | [sql-query-editor](https://learn.microsoft.com/fabric/data-warehouse/sql-query-editor) |
| B5 | **Cross-warehouse / cross-DB query** | 3-part naming `db.schema.table` across warehouses, lakehouse SQL endpoints, mirrored DBs **in the same workspace**; `OPENROWSET` over ADLS/Blob/OneLake files. | [query-warehouse](https://learn.microsoft.com/fabric/data-warehouse/query-warehouse) |
| B6 | **Data preview** | Quick grid preview of a table without writing SQL. | [data-preview](https://learn.microsoft.com/fabric/data-warehouse/data-preview) |
| B7 | **Warehouse Copilot** | NL→T-SQL generate, explain, fix-error, optimize; grounded in schema. | [copilot](https://learn.microsoft.com/fabric/data-warehouse/copilot) |

### C. Ingestion
| # | Capability | How it works | Learn |
|---|---|---|---|
| C1 | **COPY INTO (T-SQL)** | Primary high-throughput ingest from ADLS Gen2 / Blob; CSV/JSONL/Parquet; FILE_TYPE, FIRSTROW, FIELDQUOTE/TERMINATOR, ROWTERMINATOR, ENCODING, CREDENTIAL, rejected-row location, granular permissions. `BULK INSERT` synonym. | [ingest-data-copy](https://learn.microsoft.com/fabric/data-warehouse/ingest-data-copy) |
| C2 | **T-SQL ingest** | CTAS, `INSERT…SELECT`, `SELECT INTO`, `OPENROWSET` over files; cross-warehouse/lakehouse reads via 3-part names. | [ingest-data-tsql](https://learn.microsoft.com/fabric/data-warehouse/ingest-data-tsql) |
| C3 | **Pipelines / Copy job / Dataflows** | Code-free ingest (full/incremental), column mapping, schedule. | [ingest-data-pipelines](https://learn.microsoft.com/fabric/data-warehouse/ingest-data-pipelines) |

### D. Data lifecycle & recovery (the signature differentiators)
| # | Capability | How it works | Learn |
|---|---|---|---|
| D1 | **Zero-copy CLONE TABLE** | `CREATE TABLE … AS CLONE OF … [AT {point_in_time}]`. Copies **metadata only**, references same OneLake parquet. Near-instant, minimal storage. Independent of source (DML/DDL isolated). Clones inherit RLS/CLS/DDM. Portal no-code clone dialog (current or past). | [clone-table](https://learn.microsoft.com/fabric/data-warehouse/clone-table), [tutorial-clone-table-portal](https://learn.microsoft.com/fabric/data-warehouse/tutorial-clone-table-portal) |
| D2 | **Statement time travel** | `SELECT … OPTION (FOR TIMESTAMP AS OF 'yyyy-MM-ddTHH:mm:ss[.fff]')` (UTC) — whole statement incl. joins reads the historic version. Read-only. | [time-travel](https://learn.microsoft.com/fabric/data-warehouse/time-travel), [how-to-query-using-time-travel](https://learn.microsoft.com/fabric/data-warehouse/how-to-query-using-time-travel) |
| D3 | **Restore points + restore-in-place** | System restore points every 8h (8h RPO) + user-defined; metadata-only; restore **overwrites** the warehouse in place (name kept). Create/rename/delete user points; view all in Settings. | [restore-in-place](https://learn.microsoft.com/fabric/data-warehouse/restore-in-place), [restore-in-place-portal](https://learn.microsoft.com/fabric/data-warehouse/restore-in-place-portal) |
| D4 | **Configurable data retention** | 1–120 days (default 30); governs how far back time-travel/clone/restore/snapshot can reach; backed by Delta log version retention + async GC. | [data-retention](https://learn.microsoft.com/fabric/data-warehouse/data-retention) |
| D5 | **Warehouse snapshot** | Read-only point-in-time view of the warehouse within retention window. | [warehouse-snapshot](https://learn.microsoft.com/fabric/data-warehouse/warehouse-snapshot) |

### E. Performance
| # | Capability | How it works | Learn |
|---|---|---|---|
| E1 | **Automatic statistics** | Engine auto-creates/refreshes histogram + avg-col-length stats at query time for GROUP BY/JOIN/DISTINCT/WHERE/ORDER BY columns; user DDL stats also supported; `DBCC SHOW_STATISTICS`. | [statistics](https://learn.microsoft.com/fabric/data-warehouse/statistics) |
| E2 | **In-memory + SSD cache** | Transparent, always-on columnar transcode cache; cold-start on first access. | [caching](https://learn.microsoft.com/fabric/data-warehouse/caching) |
| E3 | **Result-set caching** | Persists final SELECT result sets; repeat queries bypass compile/scan. | [result-set-caching](https://learn.microsoft.com/fabric/data-warehouse/result-set-caching) |

### F. Modeling / serving / security / governance
| # | Capability | How it works | Learn |
|---|---|---|---|
| F1 | **Model view + relationships + measures** | Define relationships, measures; star-schema modeling layer. | [model-tables](https://learn.microsoft.com/fabric/data-warehouse/model-tables) |
| F2 | **Power BI semantic model (Direct Lake)** | `New semantic model` over warehouse/endpoint; Direct Lake/Import/DirectQuery; web modeling. | [semantic-models](https://learn.microsoft.com/fabric/data-warehouse/semantic-models), [create-semantic-model](https://learn.microsoft.com/fabric/data-warehouse/create-semantic-model) |
| F3 | **Granular security** | Object-, row- (RLS predicate), column-level (CLS) security + dynamic data masking (DDM) via T-SQL; applies to Warehouse + endpoint. | [security](https://learn.microsoft.com/fabric/data-warehouse/security), [row-level-security](https://learn.microsoft.com/fabric/data-warehouse/row-level-security), [dynamic-data-masking](https://learn.microsoft.com/fabric/data-warehouse/dynamic-data-masking) |
| F4 | **Share + manage permissions** | Share item, grant Read/ReadData/Build; SPN support. | [share-warehouse-manage-permissions](https://learn.microsoft.com/fabric/data-warehouse/share-warehouse-manage-permissions) |
| F5 | **Source control (Git)** | Workspace Git integration; warehouse object source control. | [source-control](https://learn.microsoft.com/fabric/data-warehouse/source-control) |
| F6 | **Monitoring / Query insights** | `queryinsights.exec_requests_history`, DMVs, monitor hub; pause/resume. | [monitor](https://learn.microsoft.com/fabric/data-warehouse/monitor) |
| F7 | **Migration assistant** | Synapse dedicated-pool → Fabric Warehouse migration. | [migration-assistant](https://learn.microsoft.com/fabric/data-warehouse/migration-assistant) |

**featureCount ≈ 33** across A–F.

---

## 2. Loom coverage map

| Cap | Loom status | Evidence |
|---|---|---|
| A1 Warehouse engine | **built (Azure-native)** | `warehouse.ts` provisioner runs DDL/seed/dbt-views over Synapse Dedicated pool TDS; ARM resume handling; idempotent DDL rewrites. Fabric Warehouse path = opt-in remediation gate (preview), Azure-native is default. |
| A2 SQL analytics endpoint | **built** | `sql-analytics-endpoint-editor.tsx` + `synapse-serverless-sql-editor.tsx` (read-only Serverless) routes `.../query`, `/schema`, `/objects`. |
| A3 T-SQL surface | **built (engine-bounded)** | Editor runs arbitrary T-SQL on the pool; provisioner rewrites unsupported idioms (CREATE TABLE IF NOT EXISTS→OBJECT_ID guard, CREATE OR ALTER VIEW→drop+create, schema idempotency). Engine differences (no zero-copy clone, MERGE-limited) honestly disclosed. |
| B1 SQL editor | **built (A)** | Monaco T-SQL, run-selection, cancel via TDS ATTENTION (`/cancel`), multi-tab (`useSqlTabs`/`SqlTabBar`), IntelliSense (`registerSqlIntelliSense` ← `/schema`), parameters (`{{name}}`→`@name` `sp_executesql`). |
| B2 Visual query | **built (A)** | `visual-query-canvas.tsx` + `visual-query-compiler.ts` (12 tests) → `/visual-query`. |
| B3 Results actions | **built** | CTAS dialog (`submitCtas`), Save-as-view, `/iqy` Excel, in-Loom Visualize (`result-visualize.tsx`, no Power BI). |
| B4 Explorer/script-out | **built** | `/schema` tree (schemas/tables/views/SP/fn + row counts), `/script-out` real OBJECT_DEFINITION. |
| B5 Cross-DB query | **built** | 3-part names via same TDS; Database picker re-targets connection. |
| B6 Data preview | **partial** | Achievable via Select-top query; no dedicated 1-click preview tab/grid affordance. |
| B7 Copilot | **built** | `useWarehouseCopilot` → generic `/api/items/[type]/[id]/assist` (verified present); generate/explain/fix/optimize (real EXPLAIN). Honest `no_aoai` gate. |
| C1 **COPY INTO wizard** | **missing** | No guided ingest surface in the warehouse editor; user must hand-type COPY INTO. (Engine supports it.) |
| C2 T-SQL ingest | **built** | CTAS/INSERT…SELECT via editor; provisioner seeds. |
| C3 Pipelines/Copy job | **built (sibling)** | `copy-job`, `data-pipeline` items. |
| D1 **Zero-copy CLONE TABLE** | **missing (warehouse item)** | Only `synapse-dedicated-sql-pool` editor has a `/clone` route doing **full-copy SELECT INTO** with an honest "no zero-copy clone on Dedicated" MessageBar. Warehouse item has no clone dialog; no point-in-time clone; no Delta shallow-clone path. |
| D2 **Time travel (FOR TIMESTAMP AS OF)** | **missing** | No timestamp affordance; Dedicated pool can't do statement time travel. No Delta-path time-travel query. |
| D3 **Restore points / restore-in-place** | **missing (warehouse item)** | `synapse` editor surfaces a restore-points **DMV read-only query** only; no create-restore-point, no restore action, no warehouse-item panel. |
| D4 Configurable retention | **missing** | No retention setting surfaced. |
| D5 Warehouse snapshot | **missing** | No snapshot item/affordance. |
| E1 Auto statistics | **built (engine) / partial UI** | Pool auto-creates stats; no stats-management panel. |
| E2 Cache | **built (engine)** | Transparent on pool. |
| E3 Result-set caching | **built** | `/query-acceleration` reads `sys.databases.is_result_set_caching_on`, `ALTER DATABASE … SET RESULT_SET_CACHING ON/OFF`; unit-tested. |
| F1 Model/relationships | **built** | `/model` route; Manage relationships (sys.foreign_keys), New measure (CREATE FUNCTION). |
| F2 Semantic model | **partial** | Model view exists; "New semantic model" item creation = Loom-native tabular/`build-powerbi-model` thread (Azure-native), no auto-create-from-warehouse button. |
| F3 RLS/CLS/DDM | **partial** | Permissions panel reads `sys.database_principals`; no guided RLS/CLS/DDM **builder** (predicate/mask wizards) — must hand-write T-SQL. |
| F4 Share | **partial** | Marketplace Delta-Sharing exists; no warehouse-item Share dialog granting Read/Build to a principal. |
| F5 Source control | **honest-gate** | Opens Fabric Git Learn (Git is workspace-level). Azure-native = ADO/GitHub repo of DDL (not built). |
| F6 Monitoring | **partial** | DMV queries available; no Query-insights dashboard panel. |
| F7 Migration | **built** | `warehouse/migrate/{scan,import}` wizard (`sql-migration-wizard.tsx`). |

---

## 3. Gap build-specs

> Cross-cutting for **all** gaps: Web-5.0 Fluent v9 + Loom tokens; all config via wizard/dropdown/canvas/Copilot (no freeform except the 1:1 T-SQL editor surface); every control → real backend (TDS / ARM / Delta data-plane); **day-one ON** (provisioned + enabled at deploy, user can disable); Commercial + Gov (GCC) both. Gov endpoints: Synapse SQL `*.sql.azuresynapse.usgovcloudapi.net` / `database.usgovcloudapi.net`; ARM `management.usgovcloudapi.net`; AOAI Gov for Copilot. Azure Databricks, Synapse, ADLS Gen2 are all available in Azure Government; Azure Analysis Services is Gov-region-limited → fall back to the Loom-native tabular layer / OSS where absent.

### GAP-1 (P1) — Zero-copy CLONE TABLE (current + point-in-time)
**Architecture.** Two backends behind one "Clone table" UI:
- **Delta path (true zero-copy):** when the warehouse table is a Delta table on ADLS Gen2 (the `adls-client` + lakehouse-warehouse path), run **Delta `SHALLOW CLONE`** (metadata-only) via Synapse Spark or Databricks SQL: `CREATE TABLE gold.dim_customer_clone SHALLOW CLONE gold.dim_customer [VERSION AS OF n | TIMESTAMP AS OF ts]`. Genuine zero-copy + point-in-time, inherits files. This is the 1:1 of Fabric D1.
- **Dedicated-pool path (fallback):** `CREATE TABLE … AS SELECT * FROM src` (CTAS full copy). Honest MessageBar: "Synapse Dedicated has no zero-copy clone; this is a full physical copy. For zero-copy + point-in-time clone, the table must be on the Delta lakehouse-warehouse backend." (reuse the existing `synapse-dedicated-sql-pool/[id]/clone` pattern.)

**UI.** Explorer table context-menu → **Clone table** dialog: source (prefilled), destination schema (dropdown) + name (validated), **State** radio (Current / Past point-in-time → UTC date-time picker bounded by retention), live generated-SQL preview pane (read-only Monaco), Clone button. Multi-select "clone group of tables at same point" (Fabric parity). On Delta path show a "zero-copy" badge; on Dedicated show the full-copy warning.
**BFF.** `POST /api/items/warehouse/[id]/clone` `{source, destSchema, destName, mode:'current'|'past', timestamp?}` → resolves backend (Delta vs Dedicated) → emits + runs SHALLOW CLONE or CTAS → receipt `{ok, statement, backend, rowCountOrZeroCopy}`.
**Azure services.** Synapse Spark (or Databricks SQL) for Delta SHALLOW CLONE; Synapse Dedicated TDS for CTAS fallback; ADLS Gen2.
**Deploy / day-one.** Spark pool (or Databricks SQL warehouse) provisioned day-one (already in DLZ); Delta retention set so point-in-time works. Bicep: ensure `synapse-spark` or `databricks` workspace + ADLS RBAC.
**Gov.** Synapse Spark + Databricks both in Gov; identical. OSS substitute (if neither): OSS Spark on AKS/ACA running Delta Lake OSS `SHALLOW CLONE`.
**Acceptance.** With `LOOM_DEFAULT_FABRIC_WORKSPACE` unset: clone a Delta table at a past timestamp → new table queryable, source unchanged, storage delta ≈ 0; clone a Dedicated table → full copy with disclosed warning.

### GAP-2 (P1) — Statement-level time travel (FOR TIMESTAMP AS OF)
**Architecture.** Fabric `OPTION (FOR TIMESTAMP AS OF …)` ↔ Azure-native **Delta time travel**. On the Delta/lakehouse-warehouse + Serverless path: rewrite the active query to read historic versions via `OPENROWSET(… , FORMAT='DELTA')` with a version, or run on Spark/Databricks `SELECT … FROM tbl TIMESTAMP AS OF ts`. On Dedicated-only tables: not possible → honest gate steering to the Delta backend or to a restore point (GAP-3).
**UI.** Query toolbar **"As of"** toggle → UTC date-time picker (bounded by retention) + a "history" affordance (list Delta versions/commits with timestamps from `DESCRIBE HISTORY`). When set, a pinned chip "Querying as of <ts> UTC" shows; the editor sends the time-travel-rewritten statement. One-click "back to live".
**BFF.** `POST /api/items/warehouse/[id]/query` extended with `asOf?` (ISO UTC) + `GET /api/items/warehouse/[id]/history?table=` → Delta `DESCRIBE HISTORY`. Server rewrites to the Delta time-travel form for the resolved backend.
**Azure services.** Synapse Serverless OPENROWSET-DELTA / Synapse Spark / Databricks SQL over ADLS Delta.
**Day-one.** Delta `delta.logRetentionDuration` / `deletedFileRetentionDuration` aligned to the configured retention (GAP-4) so historic reads don't fail after VACUUM.
**Gov.** Identical (Serverless/Spark/Databricks in Gov).
**Acceptance.** Insert→update a Delta-backed table; query with As-of = pre-update timestamp returns old values; live query returns new.

### GAP-3 (P1) — Restore points + restore-in-place
**Architecture.** Fabric system(8h)+user restore points & in-place restore ↔ Azure-native:
- **Dedicated pool:** automatic restore points (every ~8h) + **user-defined restore point** via ARM `…/restorePoints` (`New-AzSqlDatabaseRestorePoint`-equiv REST); **restore** via ARM create-as-restore (Synapse restores to a *new* pool, then Loom swaps the warehouse binding — disclosed as "restore creates a fresh pool then repoints" since Dedicated has no literal in-place overwrite).
- **Delta path:** `RESTORE TABLE … TO VERSION AS OF n | TIMESTAMP AS OF ts` (true in-place per table) for the lakehouse-warehouse backend.
**UI.** Warehouse **Settings → Restore points** panel: table of system + user points (Time UTC, type, label), **Add restore point** (name+description), **Rename**, **Delete** (user only), **Restore** (confirm dialog, "this overwrites/ repoints the warehouse"), "Details of last restoration" banner. Per-table **Restore to version** from Explorer context-menu (Delta path).
**BFF.** `GET/POST/DELETE /api/items/warehouse/[id]/restore-points`, `POST /api/items/warehouse/[id]/restore` `{restorePointId}`; Delta: `POST …/restore` `{table, version|timestamp}`. Backed by ARM (`synapse-pool-arm`) + Delta SQL.
**Azure services.** Synapse ARM restore-points API; Delta RESTORE on Spark/Databricks.
**Day-one ON.** Automatic restore-point cadence enabled at deploy; Console UAMI granted Synapse Administrator/Contributor for ARM restore (bicep role assignment) so this isn't an honest-gate.
**Gov.** ARM `management.usgovcloudapi.net`; identical capability.
**Acceptance.** Create user restore point → list shows it; make a destructive change → restore → data back to point; Delta per-table RESTORE TO VERSION works with fabric workspace unset.

### GAP-4 (P1) — COPY INTO ingestion wizard
**Architecture.** A guided **Get data / COPY INTO** wizard generating + running `COPY INTO target FROM '<adls/blob/onelake uri>' WITH (FILE_TYPE=…, …)` on the Dedicated pool (or `BULK INSERT` synonym); managed-identity CREDENTIAL by default (no secrets).
**UI.** Wizard steps (all dropdown/picker, no freeform except the URI which is a browse-or-paste field): (1) Source — ADLS Gen2 / Blob / OneLake, container/path browser; (2) Format — CSV/Parquet/JSONL + options (FIRSTROW, FIELDQUOTE, FIELDTERMINATOR, ROWTERMINATOR, ENCODING, COMPRESSION); (3) Target — existing table dropdown or "create new" (infer schema from a `SELECT TOP 0`/sample); (4) Errors — rejected-row location + `MAXERRORS`; (5) Review generated COPY INTO (read-only Monaco) → Run. Progress + rows-loaded receipt.
**BFF.** `POST /api/items/warehouse/[id]/copy-into` `{source, format, options, target, createTable?}` → builds + executes COPY INTO over TDS; returns `{ok, rowsLoaded, statement}`. `GET …/storage-browse?path=` for the source browser (ADLS list via `adls-client`).
**Azure services.** Synapse Dedicated TDS COPY INTO; ADLS Gen2 / Blob; UAMI credential.
**Day-one.** UAMI granted Storage Blob Data Reader on the lake (bicep) so MI-auth COPY INTO works with no user creds.
**Gov.** Storage `*.dfs.core.usgovcloudapi.net`; identical.
**Acceptance.** Point at the public NYC-taxi parquet (or the day-one sample container) → wizard loads rows → `SELECT COUNT_BIG(*)` confirms.

### GAP-5 (P2) — Configurable data retention
**Architecture.** Single retention setting (1–120d) that drives time-travel/clone/restore/snapshot horizons. Dedicated: restore-point retention config; Delta: set `delta.logRetentionDuration` + `delta.deletedFileRetentionDuration` (and align VACUUM) on managed tables.
**UI.** Settings → **Data retention** slider/dropdown (1–120, default 30) + explainer of what it governs. **BFF.** `GET/PUT /api/items/warehouse/[id]/retention`. **Day-one** default 30. **Gov** identical. **Acceptance.** Set 7d → time-travel beyond 7d errors with a clear bound message.

### GAP-6 (P2) — Warehouse snapshot
**Architecture.** Read-only point-in-time view of the whole warehouse = a schema-wide set of Delta time-travel views (or a clone-group) at a chosen timestamp, registered as a sibling read-only item. **UI.** "New snapshot" → timestamp picker → creates a read-only snapshot item listing all tables as-of. **BFF.** `POST …/snapshot {timestamp}`. **Backend** Delta time-travel views over ADLS. **Acceptance.** Snapshot at T; later DML doesn't change snapshot reads.

### GAP-7 (P2) — RLS / CLS / DDM guided builders
**Architecture.** Wizards that emit real T-SQL: RLS = `CREATE FUNCTION` predicate + `CREATE SECURITY POLICY … ADD FILTER PREDICATE`; CLS = `GRANT/DENY SELECT(col)`; DDM = `ALTER TABLE … ALTER COLUMN … ADD MASKED WITH (FUNCTION='…')`. **UI.** Security tab: RLS rule builder (table, predicate column, role/user, value), CLS column grant matrix, DDM mask picker (default/email/partial/random) per column. **BFF.** `POST …/security {kind, spec}` over TDS (works on Dedicated + Serverless + Delta-SQL). **Day-one** on. **Gov** identical. **Acceptance.** Apply RLS predicate → low-priv principal sees filtered rows; DDM mask → non-UNMASK user sees masked values.

### GAP-8 (P2) — Share + manage permissions; semantic-model create; data preview; query-insights panel
- **Share dialog:** grant Read/ReadData/Build to an Entra principal → real `GRANT` + (marketplace) Delta-Share publish. BFF `POST …/share`.
- **New semantic model:** one-click create the Loom-native tabular model (or AAS where available) from selected warehouse tables → reuse `build-powerbi-model` thread; Azure-native, no Power BI workspace.
- **Data preview tab:** 1-click `SELECT TOP 100` grid per table (no SQL typed).
- **Query-insights panel:** surface `queryinsights.exec_requests_history` / DMVs as a styled monitoring panel (duration, rows, cold-start `data_scanned_remote_storage_mb`).

---

## 4. Broken / overclaim found

- **Parity-doc overclaim:** `docs/fiab/parity/warehouse.md` grades itself **A** but its inventory **omits the entire data-lifecycle/recovery class** (clone, time travel, restore points, COPY INTO wizard, snapshot, retention) that defines Fabric Warehouse. *Symptom:* reviewers/operators read "A" and believe parity is complete; the signature recovery features silently don't exist on the warehouse item. *Fix:* extend the inventory with rows D1–D5 + C1, mark them ❌/⚠️, and build GAP-1…4 before re-claiming A.
- **Clone affordance lives on the wrong item:** zero-copy clone parity is only partially addressed on the separate `synapse-dedicated-sql-pool` editor as a **full-copy SELECT INTO** (honest, but not zero-copy and not on the warehouse item). *Fix:* GAP-1 (Delta SHALLOW CLONE on the warehouse item).

*(No functional runtime breakage found in the audited authoring routes: the `/assist` Copilot call resolves through the generic `app/api/items/[type]/[id]/assist` route — verified present — so the Warehouse Copilot is wired, not dead.)*

---

## 5. Roadmap summary
P1: GAP-1 CLONE (Delta shallow + CTAS fallback), GAP-2 time travel, GAP-3 restore points/restore, GAP-4 COPY INTO wizard. P2: GAP-5 retention, GAP-6 snapshot, GAP-7 RLS/CLS/DDM builders, GAP-8 share + semantic-model + preview + query-insights. All Azure-native default, Fabric/Power BI opt-in only, day-one ON, Commercial + Gov.
