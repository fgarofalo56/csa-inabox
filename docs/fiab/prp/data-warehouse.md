# PRP — Data Warehouse at full Microsoft-Fabric parity, Azure-native

> **Status:** Implementation-ready.
> **Owner experience:** CSA Loom › Data Warehouse.
> **Parity target:** Microsoft Fabric "Data Warehouse" workload — the Warehouse
> item (full read/write T-SQL DML over Delta on the Polaris engine) and the SQL
> analytics endpoint (read-only T-SQL over auto-generated Delta tables), with
> Explorer, SQL query editor, visual (no-code) query editor, manage-objects,
> CTAS / SELECT INTO / zero-copy clone, statistics, cross-warehouse 3-/4-part
> naming, V-Order, query history / insights, AI functions in T-SQL, and
> permissions / row-level + column-level security.
> **Hard rule:** Per `.claude/rules/no-fabric-dependency.md`, **every feature in
> this PRP must be 100% functional on Azure-native backends by default, with a
> real Microsoft Fabric capacity / workspace / Power BI workspace UNSET.** Fabric
> is opt-in only (`LOOM_WAREHOUSE_BACKEND=fabric` + a bound workspace). A missing
> Fabric workspace is NEVER a blocking remediation.
> Per `.claude/rules/no-vaporware.md`, **no stubs, no mock arrays, no
> `return []` placeholders** — each task lands real backend calls or an honest
> infra-gate MessageBar naming the exact env var / role / resource.
> Per `.claude/rules/ui-parity.md`, each surface gets a parity doc and must match
> the source UI one-for-one (theme differs, functionality does not).
> Per `.claude/rules/loom_no_freeform_config.md`, all config is
> dropdowns/wizards/WYSIWYG/canvas — the only allowed freeform surface is the
> 1:1 T-SQL / expression editor itself.

---

## 1. Overview + Azure-native + OSS architecture (all 4 cloud types)

### 1.1 What this experience is

Microsoft Fabric's **Data Warehouse** is a lake-centric, MPP T-SQL warehouse on
the **Polaris** engine: separate compute and storage, full multi-table ACID
T-SQL DML (`INSERT`/`UPDATE`/`DELETE`/`MERGE`) over **Delta Lake tables in
OneLake**, automatic **V-Order** write optimization, automatic compaction +
checkpointing, and a read-only **SQL analytics endpoint** projected over every
Lakehouse / Mirrored DB / SQL DB. It exposes an Explorer (schemas / tables /
views / stored procs / functions), a **SQL query editor** (Monaco T-SQL,
IntelliSense, Run, Results/Messages), a no-code **visual query editor**
(Power-Query canvas with merge/join), manage-objects (script-out CREATE/ALTER/
DROP), CTAS / `SELECT INTO` / `CREATE TABLE AS CLONE OF` (zero-copy clone),
statistics, **cross-warehouse 3-/4-part-name** queries, **query insights /
history** DMVs, **AI functions** in T-SQL (sentiment / classify / translate /
summarize), and a Model view (relationships + measures) feeding semantic
models / reports.

CSA Loom rebuilds this 1:1 on Azure + OSS, with **no dependency on a real
Fabric capacity, OneLake, or Power BI workspace.**

### 1.2 Azure-native + OSS backing services

| Concern | Azure-native DEFAULT | OSS component | Loom client / module |
|---|---|---|---|
| Full T-SQL DML over Delta (Commercial/GCC) | **Azure Databricks SQL Warehouse** (Serverless/Pro/Classic, Photon) — closest to Polaris's elastic T-SQL DML over Delta | Delta Lake OSS, Unity Catalog OSS | `databricks-client` (Statement Execution + Warehouses + UC) |
| Curated/governed warehouse compute (all clouds) | **Synapse Dedicated SQL pool** (`LOOM_WAREHOUSE_BACKEND` default) — durable star-schema warehouse, CTAS, statistics, columnstore | — | `synapse-sql-client`, `synapse-pool-arm` |
| SQL analytics endpoint (read-only over Delta/Parquet) | **Synapse Serverless SQL pool** (`OPENROWSET` / external tables over ADLS Delta) | — | `synapse-sql-client` |
| Table & file store (Delta) | **ADLS Gen2 (HNS)** + Delta format | Delta Lake OSS (`delta-standalone`) | `adls-client` |
| AI functions in T-SQL | **Databricks `ai_query()`** (Commercial/GCC) | — | `databricks-client` |
| AI functions in Gov | **AOAI direct** (`gpt-4o` in `usgovvirginia`) called from a Databricks/Spark UDF or a BFF post-process | — | `aoai-client` |
| Statistics / query optimization | Synapse `CREATE/UPDATE STATISTICS`; Databricks `ANALYZE TABLE` | — | `synapse-sql-client`, `databricks-client` |
| Query history / insights | Databricks `GET /api/2.0/sql/history/queries`; Synapse `sys.dm_*` DMVs | — | `databricks-client`, `synapse-sql-client` |
| Semantic-model / report (Model view downstream) | **Loom-native tabular layer over the warehouse** (per `no-fabric-dependency`); Power BI strictly opt-in | OSS Superset/Grafana optional | `synapse-sql-client` |
| Identity / RBAC | **Entra ID + Azure RBAC** + SQL `GRANT`/`DENY` + UC grants | — | `arm-client`, `rbac-client` |
| Secrets | **Azure Key Vault** (secretRef) | — | `keyvault-client` |

There is **no OneLake / Polaris in Azure.** Loom presents a single "Warehouse"
experience and routes to the boundary-appropriate engine (Databricks SQL in
Commercial/GCC; Synapse Serverless/Dedicated in Gov). All "OneLake virtual path"
display strings translate from real ABFS (`abfss://<container>@<account>.dfs.<suffix>/...`)
or UC three-level names.

### 1.3 Cloud portability matrix (the 4 cloud types)

| Backend | Commercial | GCC | GCC-High | DoD IL5 / IL6 | Endpoint difference |
|---|---|---|---|---|---|
| Databricks SQL Warehouse (DML + `ai_query`) | GA | GA | **NOT AVAILABLE** | **NOT AVAILABLE** | `adb-<id>.azuredatabricks.net` — Gov falls through to Synapse |
| Synapse Dedicated SQL pool | GA | GA | GA | GA (verify SKU/region in IL6) | `.sql.azuresynapse.net` vs `.sql.azuresynapse.usgovcloudapi.net` |
| Synapse Serverless SQL pool | GA | GA | GA | GA | same split |
| ADLS Gen2 (HNS, Delta) | GA | GA | GA | GA | `dfs.core.windows.net` vs `dfs.core.usgovcloudapi.net`; **21Vianet/China uses Blob+HNS** |
| AOAI (`gpt-4o`, Gov AI fns) | GA | GA | GA (`usgovvirginia`) | partial — verify region | `openai.azure.com` vs `openai.azure.us` |
| Key Vault | GA | GA | GA | GA | `vault.azure.net` vs `vault.usgovcloudapi.net` |

**Boundary routing (the load-bearing decision):**

| Boundary | Primary T-SQL DML engine | SQL analytics endpoint | AI functions |
|---|---|---|---|
| Commercial / GCC | **Databricks SQL Warehouse** (full DML over Delta + UC) | Databricks SQL OR Synapse Serverless | `ai_query()` ✅ |
| GCC-High / IL4 / IL5 | **Synapse Dedicated SQL pool** (curated DML) | **Synapse Serverless** (read-only over Delta; writes via Synapse Spark/Databricks Spark) | AOAI direct (notebook/BFF UDF) |

**Implication for code:** every host must be resolved via the existing
`cloud-endpoints` helper (`getDfsSuffix()`, `getSynapseSqlSuffix()`,
`getDatabricksSuffix()`, `getKeyVaultSuffix()`, `getAoaiSuffix()`), **never
hard-coded**. Boundary→engine selection routes through the existing
`LOOM_WAREHOUSE_BACKEND` + boundary detection; every new client/route carries a
cloud-matrix unit test (Commercial + GCC + GCC-High + IL5 suffixes).

### 1.4 Item-type topology in Loom

```
warehouse (item)                       ← Databricks SQL Warehouse (Comm/GCC) | Synapse Dedicated pool (Gov)
 ├─ Explorer: schemas / tables / views / stored procs / functions
 ├─ SQL query editor (Monaco T-SQL)    ← Statement Execution API | Synapse TDS
 ├─ Visual query editor (canvas)       ← compiles to T-SQL / Spark SQL
 └─ Model view (relationships + measures)
databricks-sql-warehouse (item)        ← Warehouses list + lifecycle + UC browse + editor (Comm/GCC)
synapse-dedicated-sql-pool (item)      ← Resume/Pause + schema tree + TDS editor
synapse-serverless-sql-pool (item)     ← read-only SQL analytics endpoint over Delta/Parquet
```

---

## 2. Feature-by-feature parity table

Legend — **Status today:** ✅ built · ⚠️ honest-gate (renders, partial backend, MessageBar) · 🔶 stub · ❌ missing.
Grounded in the 2026-06-06 parity audit: all four editors already use the real
Monaco SQL editor (`MonacoTextarea language="sql"`); query execution, warehouse
lifecycle, and catalog/UC browse are wired. Remaining work below is the parity
delta, not a rebuild.

| # | Fabric DW feature | Azure-native backend | Loom UI | Portability | Status today | Work needed |
|---|---|---|---|---|---|---|
| W1 | Warehouse list + state badge (Running/Stopped/Starting) | Databricks `GET /api/2.0/sql/warehouses` + `/<id>` | Dropdown picker + state Badge | Comm/GCC; Gov = pool list | ✅ built | none (verify Gov pool-list parity) |
| W2 | Create / edit / delete warehouse (size, type, auto-stop, min/max clusters, Photon, channel, tags, UC, $/hr) | Databricks `POST /warehouses`, `/edit`, `DELETE`; Synapse pool ARM | Create + Edit + Delete dialogs (all fields) | Comm/GCC full; Gov = pool SKU/scale | ✅ built (create + edit/scale + delete; running-state guard; $/hr estimate; Gov = Synapse Dedicated pool create/delete) | none (T1 done — PR adds create/delete BFF routes + dialogs) |
| W3 | Start / Stop / Resume / Pause | Databricks `/start`,`/stop`; Synapse `/resume`,`/pause` (ARM) | Toolbar + poll-to-ready | all | ✅ built | none |
| W4 | Explorer — schemas/tables/views/SPs/functions tree | Databricks UC `SHOW CATALOGS/SCHEMAS/TABLES`; Synapse `sys.*` | Lazy tree, Delta/non-Delta icons, search/filter/sort | all | ✅ built (catalog/schema/table) | **T6** views/SPs/functions nodes + row counts |
| W5 | Script-out objects (CREATE/ALTER/DROP) via context menu | DDL generation from `sp_describe*` / UC metadata | Tree `...` context menu → editor | all | ⚠️ partial (SELECT-template only) | **T6** full script-out (CREATE/ALTER/DROP) |
| W6 | SQL query editor — Monaco T-SQL, IntelliSense, Run, Run-selection, Cancel, Results/Messages | Databricks Statement Execution (INLINE, poll, cancel); Synapse TDS | MonacoTextarea + Run/Run-selection/Cancel + tabs | all | ✅ built (Run + results); **selection/cancel/multi-tab/IntelliSense partial** | **T2** run-selection + cancel + multi-tab + schema IntelliSense |
| W7 | Visual (no-code) query editor — Power-Query canvas, merge/join, transforms | Compile canvas → T-SQL (Synapse) / Spark SQL (Databricks); React Flow | Drag-drop canvas (steps, joins, applied-steps) → generated SQL preview → Run | all | ❌ missing | **T3** visual query canvas + compiler |
| W8 | CTAS — Save as table | `CREATE TABLE AS SELECT` (Synapse); `CREATE TABLE ... AS` (Databricks) | Results toolbar → CTAS dialog (name/schema/dist) | all | ✅ built (Synapse warehouse) | **T7** wire CTAS on Databricks path |
| W9 | Save as view (`CREATE VIEW`) | T-SQL / Spark SQL `CREATE VIEW` | Results toolbar → view dialog | all | ✅ built | none |
| W10 | `SELECT INTO` + `CREATE TABLE AS CLONE OF` (zero-copy clone) | Synapse `SELECT INTO`; Databricks `CREATE TABLE ... DEEP/SHALLOW CLONE` | Object menu → clone dialog | all | ❌ missing | **T7** clone + SELECT INTO actions |
| W11 | Open in Excel (.iqy) | BFF emits real `.iqy` web-query | Results toolbar → download | all | ✅ built (warehouse) | **T8** wire for Databricks/Synapse-serverless |
| W12 | Export results (CSV / JSON) | client iterate over real result rows | Download button | all | ⚠️ partial | **T8** CSV+JSON export all engines |
| W13 | Visualize results (chart) | Recharts over real result set | Visualize toggle (bar/line/pie/area/scatter) | all | ⚠️ honest-gate (Power BI) | **T9** in-Loom Recharts visualize (no Power BI dep) |
| W14 | Copy results (with/without headers) | client selection → clipboard | Results context menu | all | ✅ built | none |
| W15 | Query parameters (`{{name}}`) | Databricks `parameters[]`; Synapse `sp_executesql` | Param widgets above editor | all | ❌ missing | **T9** param widgets + substitution |
| W16 | Query history / insights (text, status, duration, profile) | Databricks `GET /sql/history/queries[/id]`; Synapse `sys.dm_exec_*` DMVs | History pane + profile drawer | all | ✅ built (Databricks list); **profile + Synapse DMVs missing** | **T10** query profile drawer + Synapse DMV history |
| W17 | Statistics — CREATE/UPDATE/DROP STATISTICS | Synapse `CREATE STATISTICS`; Databricks `ANALYZE TABLE` | Table menu → statistics dialog | all | ❌ missing | **T11** statistics manager |
| W18 | Cross-warehouse 3-/4-part-name queries | Synapse cross-DB; UC 3-level names | Same editor path; honest cross-workspace note in Gov | all | ✅ built (3-part TDS / UC) | **T2** verify 4-part + cross-DB picker |
| W19 | Model view — relationships + measures | Synapse `sys.foreign_keys`; `CREATE FUNCTION` measure templates; Loom-native tabular | Model canvas (tables, relationship lines, measures) | all | ⚠️ partial (relationships + measure template) | **T12** Model view canvas + measure editor |
| W20 | Permissions — object / column / row-level security | SQL `GRANT`/`DENY`; `CREATE SECURITY POLICY`; UC grants; Azure RBAC | Permissions dialog (Object/Column/Row/RBAC tabs) | all | ✅ built (object RBAC + principals) | **T13** column + row-level security |
| W21 | AI functions in T-SQL (sentiment/classify/translate/summarize) | Databricks `ai_query()`; Gov = AOAI direct via UDF/BFF | Function insert helper + result render | Comm/GCC native; Gov AOAI | ❌ missing | **T14** AI-functions helper + Gov AOAI path |
| W22 | V-Order / auto-compaction / checkpointing | n/a (Fabric/Polaris-only); Databricks `OPTIMIZE`/Photon; Synapse columnstore | honest-gate toggle + MessageBar; real `OPTIMIZE`/`ANALYZE` button | n/a (accel) | ❌ missing | **T11** OPTIMIZE/ANALYZE action + Fabric-only V-Order gate |
| W23 | Connection details (server, HTTP path, JDBC, CLI) | from `warehouse.odbc_params` / Synapse endpoint | Connection-details panel + copy | all | ❌ missing | **T15** connection-details panel |
| W24 | Source control (Git) | workspace-level | honest-gate (Git is workspace-level) | n/a | ⚠️ honest-gate | keep honest-gate (documented) |
| W25 | Warehouse Copilot (NL→SQL) | Loom Data Agents / Copilot build-assist (no Fabric Copilot) | NL→SQL inline + explain in editor | all | ❌ missing | **T16** warehouse Copilot edge |
| W26 | Activity / monitoring (running clusters, query load) | Databricks `/warehouses/<id>/events` or `system.compute`; Synapse DMVs | Monitoring tab chart (Recharts) | all | ❌ missing | **T17** monitoring tab |
| W27 | Alerts (query + condition + schedule + destinations) | Databricks `/api/2.0/alerts`; Gov = Azure Monitor scheduled-query alert | Alerts editor + list | Comm/GCC native; Gov Monitor | ❌ missing | **T18** alerts editor |

---

## 3. Azure / OSS services — full feature set + native UI surfaces to rebuild 1:1

For each backing service, the team must **inventory the real UI first** (per
`ui-parity.md`, grounded in Microsoft Learn via `microsoft_docs_search` /
`microsoft_docs_fetch` and the live portal), then build it one-for-one.

### 3.1 Azure Databricks SQL Warehouse (Commercial / GCC — primary DML engine)
- **Capabilities to surface:** list warehouses; state (Running/Starting/Stopping/
  Stopped); create (name, size 2X-Small→4X-Large, type Serverless/Pro/Classic,
  auto-stop, min/max clusters, Photon, channel, tags, Spark conf, UC); edit;
  delete; start/stop; browse Unity Catalog (catalogs→schemas→tables→views→
  functions); execute statement (INLINE disposition, JSON_ARRAY, poll, cancel);
  query history + query profile (Spark plan, IO, Photon coverage); param widgets
  (`{{name}}` → `parameters[]`); export CSV/JSON; chart visualization; connection
  details (server hostname, HTTP path, JDBC, CLI); alerts; activity monitoring;
  permissions ACL; full DML `INSERT/UPDATE/DELETE/MERGE`; cross-catalog UC
  3-level naming; SQL materialized views; `ai_query()` (sentiment/classify/
  translate/summarize/extract).
- **Native UI to mirror:** `/sql/warehouses` (list), `/sql/editor` (query editor
  + catalog explorer + results grid + visualize), `/sql/history` (history +
  profile drawer), `/sql/alerts`.
- **Loom mapping:** W1–W3, W4 (UC browse), W6, W8/W10 (CTAS/clone), W12/W13/W15,
  W16, W20 (UC grants), W21 (`ai_query`), W23, W26, W27.
- **Loom current state:** `DatabricksSqlWarehouseEditor` (`databricks-editors.tsx:610`)
  is A-grade — list/state/start-stop/UC browse/execute/history/edit/scale all
  real; gaps = create/delete, run-selection/cancel/multi-tab, profile drawer,
  param widgets, export, chart, connection details, alerts, monitoring.

### 3.2 Synapse Dedicated SQL pool (Gov primary + curated warehouse all clouds)
- **Capabilities:** durable warehouse tables (HASH/ROUND_ROBIN/REPLICATE
  distribution); `CREATE TABLE AS SELECT`; `SELECT INTO`; columnstore; `CREATE/
  UPDATE STATISTICS`; views/procs/functions; `sys.*` catalog + `sys.dm_exec_*`
  query DMVs; `GRANT/DENY`; security policies (RLS); resume/pause (ARM); scale
  (DWU). TDS via `mssql`, AAD token scope `https://database.windows.net/.default`.
- **Native UI to mirror:** Synapse Studio Develop hub SQL script (Monaco +
  IntelliSense + Run/Run-selection + Connect-to + Results/Messages), Data hub
  object explorer, monitoring (SQL requests).
- **Loom mapping:** W1–W3 (Resume/Pause), W4/W5/W6, W8 (CTAS), W10 (SELECT INTO),
  W16 (DMV history), W17 (statistics), W18 (cross-DB), W20 (RLS/CLS), W22 (OPTIMIZE
  ~ `ALTER INDEX REBUILD` / `UPDATE STATISTICS`), W26.
- **Loom current state:** `SynapseDedicatedSqlPoolEditor` (`synapse-sql-editors.tsx:386`)
  is A-grade — Monaco SQL, TDS query, schema tree, Resume/Pause wired
  (`/schema`,`/query`,`/state`,`/resume`,`/pause`). Also backs `WarehouseEditor`
  (`phase3-editors.tsx:3336`, routes `/api/items/warehouse/[id]/{schema,query,iqy}`).

### 3.3 Synapse Serverless SQL pool (SQL analytics endpoint over Delta)
- **Capabilities:** `OPENROWSET` over Delta/Parquet/CSV; external tables + data
  sources + file formats; views/procs/UDFs; database-scoped credentials;
  `INFORMATION_SCHEMA`; `sys.dm_external_data_processed` (MB scanned);
  `sp_set_data_processed_limit` (cost control); read-only over auto-generated
  Delta tables.
- **Native UI to mirror:** Synapse Studio SQL script (Built-in connection),
  data-processed footer badge, external-table catalog tree, ADLS file browser →
  Create external table wizard.
- **Loom mapping:** W4/W6 (read-only endpoint), W11/W12 (export), W18 (cross-DB
  via OPENROWSET), data-processed indicator.
- **Loom current state:** `SynapseServerlessSqlPoolEditor` (`synapse-sql-editors.tsx:179`)
  is A-grade — Monaco SQL + TDS execute + database/lake schema (`/schema`,`/query`).

### 3.4 ADLS Gen2 (Delta store)
- **Capabilities:** `_delta_log` read (table status/version/schema/file list);
  List Paths; Get Properties; RBAC (Storage Blob Data Owner/Contributor/Reader).
- **Loom mapping:** table status/icons (W4), `OPTIMIZE`/`VACUUM` file-count
  verification (W22), external-table sources (Serverless).

### 3.5 AOAI (Gov AI-functions substitute) + Databricks `ai_query`
- **Capabilities:** `ai_query()` built-in (Commercial/GCC) for sentiment/classify/
  translate/summarize/extract; in Gov, AOAI `gpt-4o` chat-completions called from
  a Databricks/Spark UDF or a BFF post-process over the result set.
- **Loom mapping:** W21 — function-insert helper + boundary-aware execution.

### 3.6 OSS — Delta Lake / Unity Catalog OSS
- **Delta Lake:** transaction log → table health (`healthy`/`loading`/`broken`),
  version history, schema, file list; `OPTIMIZE`/`VACUUM`/`ZORDER`; clone
  (`DEEP`/`SHALLOW CLONE`).
- **Unity Catalog OSS:** catalog→schema→table namespace + grants when UC is the
  catalog (W4, W20).

---

## 4. Sequenced TASK LIST

Each task is an independently shippable unit. **No stubs, no mock data, no
`return []`.** Each lands real backend calls or an honest infra-gate MessageBar
naming the exact env var / role / resource. Every task ends with a real-data E2E
receipt (per `no-vaporware.md`) and a parity-doc row update (per `ui-parity.md`).

Common conventions:
- BFF routes return `{ ok: boolean, data?, error? }` with correct HTTP codes.
- New hosts resolved via `cloud-endpoints` helper; covered by cloud-matrix test
  (Commercial + GCC + GCC-High + IL5 suffixes).
- New env vars added to `apps[]` in `admin-plane/main.bicep`; new role grants
  added to the relevant Bicep module; new clients route through managed identity.
- Boundary→engine selection routes through `LOOM_WAREHOUSE_BACKEND` + boundary
  detection; with all Fabric env UNSET, the Azure-native path is the default.

---

### T1 — Warehouse create + delete + $/hr estimate (W2)
- **Goal:** Add Create and Delete to the warehouse list, completing the lifecycle
  (edit/scale already exist).
- **Files:** edit `apps/fiab-console/lib/editors/databricks-editors.tsx`
  (`DatabricksSqlWarehouseEditor`, ~610); add
  `apps/fiab-console/app/api/items/databricks-sql-warehouse/[id]/create/route.ts`
  + `.../delete/route.ts`; for Gov, edit `synapse-pool-arm` create/scale path.
- **Backend/REST:** Databricks `POST /api/2.0/sql/warehouses` (all create fields)
  + `DELETE /api/2.0/sql/warehouses/<id>`; Gov = Synapse Dedicated pool ARM
  create/scale (DWU). $/hr from `system.compute.warehouses` or a static DBU table.
- **Bicep/portability:** Databricks workspace + UAMI token; `getDatabricksSuffix()`;
  Gov path uses `synapse-pool-arm` (already deployed). Cloud-matrix test.
- **UI surface:** Create dialog (name, size, type, auto-stop, min/max clusters,
  Photon, channel, tags, UC, est. $/hr); Delete confirm with running-state guard.
- **Acceptance:** with Fabric UNSET, Create produces a real warehouse appearing in
  W1's list with the chosen size; Delete removes it; Gov path creates/scales a real
  dedicated pool; receipt shows live create response + the new warehouse id.

### T2 — SQL editor parity: run-selection + cancel + multi-tab + schema IntelliSense + cross-DB picker (W6/W18)
- **Goal:** Bring the T-SQL editor to full Fabric parity across all three engines.
- **Files:** edit `databricks-editors.tsx` (editor pane) + `synapse-sql-editors.tsx`
  (both editors) + `phase3-editors.tsx` (`WarehouseEditor`); add
  `.../[id]/cancel/route.ts` for Databricks + Synapse; add IntelliSense provider
  `apps/fiab-console/lib/components/editor/sql-intellisense.ts`.
- **Backend/REST:** Databricks `POST /sql/statements/<id>/cancel`; Synapse TDS
  cancel; IntelliSense source = UC `SHOW`/`INFORMATION_SCHEMA` (cached per
  warehouse); cross-DB picker = Databricks `SHOW CATALOGS`/Synapse `sys.databases`.
- **Bicep/portability:** none beyond existing; cloud-matrix test for cancel host.
- **UI surface:** Monaco "Run selection" (run highlighted text), Cancel button
  while running, multi-tab tabbar, IntelliSense dropdown (catalogs/schemas/tables/
  columns), database/catalog dropdown in toolbar.
- **Acceptance:** running a selected subset executes only that text; Cancel aborts
  a long query (verified by status); IntelliSense suggests a real column from a
  real table; a 3-part and a 4-part cross-DB query both return live rows; receipt
  shows cancel + cross-DB responses.

### T3 — Visual (no-code) query editor — Power-Query canvas + SQL compiler (W7)
- **Goal:** Replace the single MISSING row with a real drag-drop visual query
  canvas (the one genuine gap recorded in `parity/warehouse.md`).
- **Files:** add `apps/fiab-console/lib/editors/components/visual-query-canvas.tsx`
  (React Flow, reuse `pipeline-editor-core` patterns); add
  `apps/fiab-console/lib/editors/visual-query-compiler.ts`; add
  `.../[id]/visual-query/route.ts`; wire a "New visual query" ribbon action into
  all three editors.
- **Backend/REST:** compiler emits T-SQL (Synapse) / Spark SQL (Databricks) from
  the canvas graph; preview executes via the existing `/query` route; applied-steps
  model (source → filter → select columns → group/aggregate → merge/join → sort).
- **Bicep/portability:** none.
- **UI surface:** canvas (source nodes from Explorer, transform steps, join nodes),
  applied-steps panel, generated-SQL preview pane (read-only Monaco), Run.
- **Acceptance:** building source→filter→group-by→join on the canvas generates
  valid SQL that returns the same rows as the hand-written equivalent against a
  real table; merge/join produces a correct joined result; receipt shows the
  generated SQL + live result.

### T6 — Explorer: views/SPs/functions nodes + row counts + full script-out (W4/W5)
- **Goal:** Complete the Explorer tree (views, stored procedures, functions) with
  row counts, and full script-out (CREATE/ALTER/DROP) via context menu.
- **Files:** edit `databricks-editors.tsx` + `synapse-sql-editors.tsx` +
  `phase3-editors.tsx` Explorer trees; extend `.../[id]/schema/route.ts` for each
  engine; add `.../[id]/script-out/route.ts`.
- **Backend/REST:** Synapse `sys.views`/`sys.procedures`/`sys.objects` +
  `sp_helptext`/`OBJECT_DEFINITION`; Databricks `SHOW VIEWS`/`SHOW FUNCTIONS` +
  `SHOW CREATE TABLE`; row counts via `SELECT COUNT(*)` (lazy, on expand).
- **Bicep/portability:** none.
- **UI surface:** typed tree nodes (table/view/SP/function icons), row-count
  badges, `...` context menu → Script CREATE / ALTER / DROP into a new editor tab.
- **Acceptance:** views/SPs/functions appear with correct icons; row counts are
  real; "Script as CREATE" loads the real object definition; "Script as DROP"
  loads a runnable DROP; empty schema returns honest empty tree (no fabricated
  nodes); receipt shows a real `OBJECT_DEFINITION` body.

### T7 — Save-as-table (CTAS) on Databricks + clone + SELECT INTO (W8/W10)
- **Goal:** CTAS on the Databricks path; zero-copy clone and SELECT INTO on all
  engines.
- **Files:** edit `databricks-editors.tsx` (results toolbar) +
  `synapse-sql-editors.tsx`; add `.../[id]/ctas/route.ts` (Databricks) +
  `.../[id]/clone/route.ts`.
- **Backend/REST:** Databricks `CREATE TABLE <name> AS SELECT ...`; clone =
  Databricks `CREATE TABLE <t> SHALLOW|DEEP CLONE <src>` / Synapse `SELECT INTO`
  (no Synapse zero-copy → honest note: deep copy on dedicated pool); SELECT INTO
  = Synapse `SELECT ... INTO <t>`.
- **Bicep/portability:** none.
- **UI surface:** Results "Save as table" CTAS dialog (name/schema/distribution
  for Synapse); object-menu "Clone" dialog (shallow/deep) + "Select into".
- **Acceptance:** CTAS on Databricks creates a queryable Delta table in UC;
  SHALLOW CLONE creates a zero-copy clone (verified — no data files duplicated);
  Synapse SELECT INTO materializes a new table; receipt shows the created objects.

### T8 — Export results: CSV / JSON / Open-in-Excel across all engines (W11/W12)
- **Goal:** Real CSV + JSON export and `.iqy` Open-in-Excel for Databricks +
  Synapse Serverless (warehouse path already has `.iqy`).
- **Files:** edit results toolbars in `databricks-editors.tsx` +
  `synapse-sql-editors.tsx`; add `.../[id]/iqy/route.ts` for those two; add a
  shared client CSV/JSON serializer.
- **Backend/REST:** CSV/JSON serialized from the real result set (no mock);
  `.iqy` BFF emits a real web-query connection string (engine-appropriate).
- **Bicep/portability:** none.
- **UI surface:** Download menu (CSV / JSON) + Open-in-Excel button.
- **Acceptance:** CSV/JSON downloads contain the exact live result rows; the
  `.iqy` opens in Excel and refreshes against the real endpoint; receipt shows the
  first 300 chars of each artifact.

### T9 — Visualize results (Recharts) + query parameters (W13/W15)
- **Goal:** In-Loom chart visualization (no Power BI dependency) + `{{param}}`
  widgets — removing the W13 honest-gate where it stood only because of Power BI.
- **Files:** add `apps/fiab-console/lib/editors/components/result-visualize.tsx`
  (Recharts) + `apps/fiab-console/lib/editors/components/query-params.tsx`; wire
  into all three editors; extend `/query` routes to accept `parameters[]`.
- **Backend/REST:** chart is client-side over the real result set; params =
  Databricks `parameters[]` / Synapse `sp_executesql`/named-param substitution
  (parameterized, not string-concat — SQL-injection-safe).
- **Bicep/portability:** none.
- **UI surface:** Visualize toggle (bar/line/pie/area/scatter, axis pickers);
  param widgets above editor auto-detected from `{{name}}`.
- **Acceptance:** a `GROUP BY` result renders a correct bar chart from live data;
  `{{region}}` produces an input that re-runs the query parameterized (verified
  injection-safe); receipt shows the parameterized statement + result.

### T10 — Query history: profile drawer + Synapse DMV history (W16)
- **Goal:** Add the query-profile drawer (Databricks) and Synapse DMV-based
  history so all engines have history parity.
- **Files:** edit `databricks-editors.tsx` (history pane) + `synapse-sql-editors.tsx`;
  add `.../databricks-sql-warehouse/[id]/query-profile/route.ts`; add
  `.../synapse-dedicated-sql-pool/[id]/query-history/route.ts` (+ serverless).
- **Backend/REST:** Databricks `GET /sql/history/queries/<id>` (Spark plan, IO,
  Photon); Synapse `sys.dm_exec_requests`/`sys.dm_exec_query_stats` +
  `sys.dm_pdw_exec_requests` (dedicated) / `sys.dm_external_data_processed`
  (serverless).
- **Bicep/portability:** none.
- **UI surface:** history grid (status/text/duration/error) + side drawer
  (plan/IO/duration breakdown).
- **Acceptance:** Databricks profile drawer shows a real Spark plan + IO stats for
  a past query; Synapse history lists real recent requests with durations; receipt
  shows a live profile payload.

### T11 — Statistics manager + OPTIMIZE/ANALYZE + V-Order honest-gate (W17/W22)
- **Goal:** CREATE/UPDATE/DROP statistics; OPTIMIZE/ANALYZE maintenance; V-Order
  shown as documented Fabric-only honest-gate.
- **Files:** add `apps/fiab-console/lib/editors/components/stats-maintenance-dialog.tsx`;
  add `.../[id]/statistics/route.ts` + `.../[id]/optimize/route.ts`.
- **Backend/REST:** Synapse `CREATE/UPDATE/DROP STATISTICS`, `UPDATE STATISTICS`;
  Databricks `ANALYZE TABLE ... COMPUTE STATISTICS`, `OPTIMIZE`/`OPTIMIZE ZORDER BY`;
  V-Order toggle persists with a Fabric-only note (no Azure 1:1).
- **Bicep/portability:** Storage Blob Data Contributor for OPTIMIZE (Databricks);
  cloud-matrix test.
- **UI surface:** table menu → Statistics tab (list + create/update/drop) +
  Maintenance tab (OPTIMIZE / ANALYZE / ZORDER cols); V-Order toggle with
  `intent="warning"` MessageBar.
- **Acceptance:** CREATE STATISTICS persists and appears in catalog; OPTIMIZE
  compacts a real table (file count drops, verified via ADLS); V-Order shows the
  honest MessageBar; receipt shows the OPTIMIZE result + new file count.

### T12 — Model view canvas (relationships + measures) (W19)
- **Goal:** A real Model view — table cards, relationship lines, measure editor —
  feeding a Loom-native tabular layer (no Power BI / Fabric model dependency).
- **Files:** add `apps/fiab-console/lib/editors/components/model-view-canvas.tsx`
  (React Flow); add `.../[id]/model/route.ts` (read/write relationships +
  measures); wire a Model mode switcher into `WarehouseEditor` + the SQL editors.
- **Backend/REST:** relationships from `sys.foreign_keys` (Synapse) / UC
  constraints (Databricks); measures persisted as `CREATE FUNCTION` (scalar/TVF)
  or Loom tabular metadata in Cosmos; cardinality/cross-filter stored on the item.
- **Bicep/portability:** none (Power BI strictly opt-in — never required).
- **UI surface:** canvas (draggable table cards, relationship lines with
  cardinality, create-relationship dialog), measures panel (DAX-like measure
  editor → persisted definition).
- **Acceptance:** dragging between two table keys creates a real relationship
  (persisted + readable back); adding a measure persists and is usable in a query;
  with Power BI UNSET the Model view fully renders; receipt shows the saved model.

### T13 — Permissions: column-level + row-level security (W20)
- **Goal:** Beyond object RBAC — column-level GRANT and row-level security.
- **Files:** edit the Permissions dialog in `phase3-editors.tsx` /
  `synapse-sql-editors.tsx`; add `.../[id]/security/route.ts`.
- **Backend/REST:** Synapse `GRANT SELECT(col) ON ...`, RLS via
  `CREATE SECURITY POLICY` + predicate function; Databricks UC column masks + row
  filters (`ALTER TABLE ... SET ROW FILTER` / `SET MASK`).
- **Bicep/portability:** none.
- **UI surface:** Permissions dialog tabs — Object (RBAC) | Column | Row;
  principal resolves to UPN.
- **Acceptance:** column-level grant restricts a real test query to the allowed
  columns; RLS hides rows for the constrained principal; receipt shows the
  before/after query results for the constrained principal.

### T14 — AI functions in T-SQL (sentiment/classify/translate/summarize) (W21)
- **Goal:** AI functions via Databricks `ai_query()` (Comm/GCC) and an AOAI-direct
  substitute in Gov.
- **Files:** add `apps/fiab-console/lib/editors/components/ai-functions-helper.tsx`;
  add `.../[id]/ai-function/route.ts`; add `apps/fiab-console/lib/azure/aoai-client.ts`
  if absent.
- **Backend/REST:** Comm/GCC → inject `ai_query(...)` into the statement;
  Gov → BFF post-processes the result set through AOAI `gpt-4o`
  chat-completions (or a Databricks Spark UDF), boundary-detected.
- **Bicep/portability:** AOAI env (`LOOM_AOAI_ENDPOINT`/deployment) added to
  `admin-plane/main.bicep`; UAMI granted Cognitive Services OpenAI User;
  `getAoaiSuffix()`; honest-gate MessageBar in IL6 if AOAI region absent.
- **UI surface:** function helper (pick sentiment/classify/translate/summarize,
  pick column) → inserts the call (Comm) or runs the augmented pipeline (Gov);
  result column renders inline.
- **Acceptance:** Comm/GCC `ai_query` returns real sentiment on a text column;
  Gov path returns the same enrichment via AOAI; where AOAI is absent the helper
  shows the honest-gate MessageBar; receipt shows a real enriched result row.

### T15 — Connection details panel (W23)
- **Goal:** Surface server hostname, HTTP path, JDBC URL, and CLI snippet per
  engine, with copy buttons.
- **Files:** add `apps/fiab-console/lib/editors/components/connection-details.tsx`;
  add `.../[id]/connection/route.ts`.
- **Backend/REST:** Databricks from `warehouse.odbc_params`; Synapse from the
  resolved endpoint host (via `cloud-endpoints`), DB name, AAD auth mode.
- **Bicep/portability:** hosts resolved via helper; cloud-matrix test.
- **UI surface:** details panel (server, HTTP path, JDBC, CLI) + Copy per field.
- **Acceptance:** the JDBC URL connects from an external client (sanity-tested);
  Gov endpoints show the Gov suffix; receipt shows the real connection strings.

### T16 — Warehouse Copilot (NL→SQL + explain) (W25)
- **Goal:** Inline NL→SQL and explain-query via Loom Copilot build-assist /
  Data Agents (no Fabric Copilot).
- **Files:** edit the SQL editors; add `.../[id]/assist/route.ts`.
- **Backend/REST:** Loom Copilot agent grounded in the warehouse schema (from T6)
  + selected text/result context; returns runnable T-SQL/Spark SQL.
- **Bicep/portability:** AI Foundry project env already provisioned; no Fabric dep.
- **UI surface:** NL prompt box above editor → inserts generated SQL; "Explain
  query" → grounded explanation drawer.
- **Acceptance:** "top 10 customers by revenue last quarter" yields runnable SQL
  that executes via the editor and returns real rows; Explain returns a grounded
  description; receipt shows the generated SQL + result.

### T17 — Monitoring tab (activity + query load chart) (W26)
- **Goal:** A monitoring tab with running-clusters / query-load over time.
- **Files:** add `apps/fiab-console/lib/editors/components/warehouse-monitoring.tsx`
  (Recharts); add `.../[id]/monitoring/route.ts`.
- **Backend/REST:** Databricks `/api/2.0/sql/warehouses/<id>/events` or
  `system.compute.warehouse_events`; Synapse `sys.dm_pdw_exec_requests` /
  resource DMVs aggregated over time.
- **Bicep/portability:** none.
- **UI surface:** monitoring tab — running-clusters line chart + recent-query
  table.
- **Acceptance:** the chart plots real warehouse events over the last hour; the
  query table lists real recent requests; receipt shows a live events payload.

### T18 — Alerts editor (query + condition + schedule + destination) (W27)
- **Goal:** Query-result alerts — Databricks Alerts (Comm/GCC) and Azure Monitor
  scheduled-query alert (Gov), matching the no-fabric-dependency activator mapping.
- **Files:** add `apps/fiab-console/lib/editors/components/warehouse-alerts.tsx`;
  add `.../[id]/alerts/route.ts`.
- **Backend/REST:** Databricks `GET/POST/PATCH/DELETE /api/2.0/alerts`; Gov =
  `monitor-client` scheduled-query alert rule over the Synapse query.
- **Bicep/portability:** Gov path → UAMI Monitoring Contributor (add to module);
  env for the Monitor workspace; cloud-matrix test.
- **UI surface:** alerts list + editor (query, condition, schedule, notification
  destination).
- **Acceptance:** creating an alert (Comm) persists and lists via the real API;
  Gov path creates a real Azure Monitor alert rule; receipt shows the created
  alert id from the live response.

---

## 5. Claude Code DEV-LOOP per task

Run this loop **per task**, iterating until acceptance criteria pass with **zero
stubs/placeholders/mocks**. Use an isolated worktree (`EnterWorktree`) per task
so parallel tasks don't corrupt `node_modules` (per the pnpm-worktree memory).

```
┌── 1. CODING AGENT ────────────────────────────────────────────────┐
│ - Read parity rules + the task's files. Inventory the real Fabric  │
│   DW / Databricks SQL / Synapse Studio UI via                      │
│   microsoft_docs_search/fetch + live portal FIRST.                 │
│ - Implement BFF route (real backend call) + client + UI surface,   │
│   boundary-routed (Databricks Comm/GCC, Synapse Gov).              │
│ - Add env var to admin-plane/main.bicep + role grant to the module │
│   + cloud-endpoints suffix usage. No return []/mock/useState(MOCK).│
│ - Commit on a task branch.                                         │
└────────────────────────────────────────────────────────────────────┘
            │  hand off
┌── 2. VALIDATION / TEST AGENT ─────────────────────────────────────┐
│ - tsc:  pnpm --filter fiab-console exec tsc --noEmit               │
│ - build: pnpm --filter fiab-console build  (CI historically never  │
│          ran this — it is REQUIRED here per csa_loom_ci_gaps memory)│
│ - unit: pnpm --filter fiab-console vitest run <task spec>          │
│         (gate render tests on build per vitest-harness memory)     │
│ - cloud-matrix test for any new host (Comm + GCC + GCC-High + IL5).│
│ - REAL-DATA E2E: mint session cookie, hit the new /api/... route   │
│   with Fabric UNSET, capture first 300 chars of the live response. │
│   Run once per boundary that the route serves (Databricks + Synapse│
│   where applicable).                                               │
│ - grep guard: no (return \[\]|return \{\}|MOCK_|SAMPLE_|TODO|      │
│   useState\(\[\{) in touched files.                                │
│ - On FAIL → revert task to coding agent with the failing output.   │
└────────────────────────────────────────────────────────────────────┘
            │  pass
┌── 3. DOCS AGENT ──────────────────────────────────────────────────┐
│ - Update docs/fiab/parity/{warehouse,databricks-sql-warehouse,     │
│   synapse-dedicated-sql-pool,synapse-serverless-sql-pool}.md:      │
│   inventory row → built ✅ / honest-gate ⚠️ + backend-per-control. │
│ - Update this PRP's Status-today column for the W-row.            │
│ - Update docs/fiab/workloads/data-warehouse.md + the docs site     │
│   page (docs = source of truth, BLOCKING).                        │
│ - No clarifying questions / side-convo baked into product docs.   │
└────────────────────────────────────────────────────────────────────┘
            │
┌── 4. UAT AGENT ───────────────────────────────────────────────────┐
│ - pnpm uat (deep-functional spec) for the surface.                │
│ - Playwright (or claude-in-chrome): click EVERY control on the    │
│   surface; confirm each does what its label says (DOM strings ≠    │
│   parity). Side-by-side vs real Fabric DW / Databricks SQL /       │
│   Synapse Studio.                                                 │
│ - Capture screenshot/trace into the PR receipt.                   │
│ - On any ❌ or stub banner → back to coding agent.                 │
└────────────────────────────────────────────────────────────────────┘
            │  all green
        OPEN PR (with real-data E2E receipt + bicep diff + screenshot)
```

**Iteration rule:** a task is not "done" until agents 2 + 4 both pass with the
acceptance criteria verbatim, Fabric workspace UNSET, and the PR carries the
no-vaporware receipt (per boundary). Reviewers reject any PR missing the receipt.

---

## 6. Definition of Done (whole experience)

The Data Warehouse experience is **done** when:

1. **Every parity row (W1–W27)** in §2 is **built ✅ or honest-gate ⚠️** — **zero
   🔶 stubs, zero ❌ missing, zero empty tabs, zero disabled-with-tooltip
   shortcuts.** The single historical MISSING (visual query canvas) is built
   (T3); the W13/W24 honest-gates that existed only because of Power BI / Git are
   resolved (T9 in-Loom visualize) or documented (W24 workspace-Git).
2. **Fabric-free:** with `LOOM_DEFAULT_FABRIC_WORKSPACE` and `LOOM_WAREHOUSE_BACKEND=fabric`
   UNSET, the entire experience installs and every editor executes its primary
   action against real Azure backends (Databricks SQL in Comm/GCC; Synapse
   Dedicated/Serverless in Gov; ADLS Delta; AOAI). No call to
   `api.fabric.microsoft.com` / `api.powerbi.com` / `onelake.dfs.fabric` on any
   default path.
3. **No vaporware:** `grep -rE "(return \[\]|return \{\}|useState\(\[\{|MOCK_|SAMPLE_|TODO|FIXME)"`
   over the touched editors + API routes returns no candidate violations; every
   BFF route calls a real backend or returns an honest-gate MessageBar naming the
   exact env var / role / resource.
4. **All 4 clouds:** every new host resolves via `cloud-endpoints`; cloud-matrix
   tests pass for Commercial + GCC + GCC-High + DoD IL5/IL6 suffixes; honest
   MessageBars cover services not in a given sovereign cloud (Databricks SQL +
   `ai_query` absent in GCC-High/IL → Synapse + AOAI substitute; AOAI absent in
   IL6; ADLS→Blob+HNS in 21Vianet).
5. **Bicep-synced:** `az deployment sub create -f platform/fiab/bicep/main.bicep
   -p params/commercial-full.bicepparam` + the bootstrap workflow deploys every
   resource, env var, role grant, and Cosmos container these tasks add (Databricks
   workspace + UAMI token, Synapse pools, AOAI deployment, Monitor workspace,
   role grants) — running feature set == deployed feature set (no drift).
6. **Parity docs:** `warehouse`, `databricks-sql-warehouse`,
   `synapse-dedicated-sql-pool`, and `synapse-serverless-sql-pool` parity docs all
   show zero ❌ rows with a backend-per-control column; the outdated parity-gap
   docs are reconciled (MonacoTextarea-is-wired correction landed); the docs site
   reflects the feature set.
7. **Tested:** each task carries vitest + real-data E2E (per boundary) +
   Playwright UAT evidence; `pnpm uat` green for the experience; quarterly
   teardown + one-button redeploy in a clean Commercial **and** Gov sub renders +
   executes every editor's primary action against the freshly-deployed Azure
   backing — target grade **A / A+** per the rubric.
