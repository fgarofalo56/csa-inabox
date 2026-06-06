# PRP — Databases (SQL Database + Cosmos DB + Mirrored Databases) at full Microsoft-Fabric parity, Azure-native

> **Status:** Implementation-ready.
> **Owner experience:** CSA Loom › Databases (Fabric "Database" workload).
> **Parity target:** Microsoft Fabric "Databases" — the three item families that
> live under the Database workload: **SQL Database in Fabric**, **Cosmos DB in
> Fabric**, and **Mirrored Databases** (every external-source connector + open
> mirroring), plus the shared web query editor, object explorer, performance
> dashboard, and Copilot quick-actions.
> **Hard rule:** Per `.claude/rules/no-fabric-dependency.md`, **every feature in
> this PRP must be 100% functional on Azure-native backends by default, with a
> real Microsoft Fabric / Power BI capacity or workspace UNSET.** Fabric is
> opt-in only (`LOOM_<ITEM>_BACKEND=fabric` + a bound workspace). Per
> `.claude/rules/no-vaporware.md`, **no stubs, no mock arrays, no `return []`
> placeholders** — each task lands real backend calls or an honest infra-gate
> MessageBar naming the exact env var / role / resource. Per
> `.claude/rules/ui-parity.md`, each surface gets a parity doc and matches the
> source UI one-for-one (theme differs, functionality does not). Per
> `.claude/rules/loom_no_freeform_config.md`, all config is wizards / dropdowns /
> WYSIWYG — the only allowed raw text surfaces are the T-SQL / NoSQL / Gremlin
> query editors and the ADF-style expression builders.

---

## 1. Overview + Azure-native + OSS architecture (all 4 cloud types)

### 1.1 What this experience is

Fabric's **Database** workload bundles three distinct OLTP/operational item
types behind one web experience:

1. **SQL database in Fabric** — a fully managed OLTP database on the Azure SQL
   Database engine, with a web T-SQL query editor, object explorer, performance
   dashboard, Copilot, auto-mirroring to OneLake, and a SQL analytics endpoint.
2. **Cosmos DB in Fabric** — a NoSQL document database (NoSQL API) with a Data
   Explorer (container/item browse + NoSQL query), throughput/indexing settings,
   and (Gremlin) graph support.
3. **Mirrored Databases** — near-real-time CDC replication from an external
   source (Azure SQL DB/MI, SQL Server, Snowflake, Cosmos DB, PostgreSQL, etc.)
   or **open mirroring** (push Parquet) into a managed analytical store, with a
   replication monitor.

CSA Loom rebuilds all three 1:1 on Azure + OSS with **no dependency on a real
Fabric capacity, OneLake, or Power BI workspace**. "Mirror to OneLake" becomes
"mirror to ADLS Gen2 Bronze Delta"; the SQL analytics endpoint becomes a Synapse
Serverless SQL pool over that Delta.

### 1.2 Azure-native + OSS backing services

| Concern | Azure-native DEFAULT | OSS component | Loom client / module |
|---|---|---|---|
| Fabric SQL database engine | **Azure SQL Database** (`Microsoft.Sql/servers/databases`) | — | `azure-sql-client`, `sql-objects-client` |
| T-SQL execution (data plane) | Azure SQL **TDS** endpoint via AAD token | `mssql`/`tedious` (npm) | `azure-sql-client.executeQuery` |
| Schema / object catalog | `sys.*` + `INFORMATION_SCHEMA` over TDS | — | `sql-objects-client` |
| Performance dashboard | Azure SQL **Query Store** (`sys.query_store_*`) + DMVs | — | `sql-objects-client` (new perf methods) |
| Cosmos DB in Fabric (NoSQL) | **Azure Cosmos DB** (NoSQL API) data + control plane | — | `cosmos-client`, `cosmos-data-client`, `cosmos-account-client` |
| Cosmos graph (Gremlin) | **Azure Cosmos DB Gremlin API** | Apache TinkerPop Gremlin | `cosmos-account-client` (gremlin), `gremlin` driver |
| Mirrored DB analytical store | **ADLS Gen2 Bronze Delta** (medallion) | Delta Lake OSS | `adls-client`, `mirror-engine` |
| Mirror CDC capture | **ADF CDC / Synapse Link copy** (per `no-fabric-dependency.md`) | Debezium (concept) | `mirror-engine`, `synapse-dev-client`, `adf-client` |
| Mirror SQL analytics endpoint | **Synapse Serverless SQL** over Bronze Delta | — | `synapse-sql-client` |
| Open mirroring landing | **ADLS Gen2 landing zone** (push Parquet → Delta) | Delta Lake OSS | `adls-client`, `mirror-engine` |
| Copilot (Fix/Explain/NL→SQL) | **Azure OpenAI** (`gpt-4o`) via `apps/copilot` | — | `apps/copilot` Function backend |
| Identity / RBAC | **Entra ID + Azure RBAC** + SQL `GRANT` | — | `arm-client`, `rbac-client` |
| Secrets (source conn strings) | **Azure Key Vault** (secretRef) | — | `keyvault-client` |

There is **no OneLake** in Azure. Loom maintains its own namespace abstraction
over ADLS Gen2 (the mirrored-DB item's `storageAccount` + `container` +
`rootPath`); all "OneLake replica" display strings translate from real ABFS
(`abfss://<container>@<account>.dfs.<suffix>/...`). "Power BI semantic model on
the SQL endpoint" is the Loom-native tabular layer (out of scope here, deferred
to the Power-BI PRP), and is NEVER required for the database to function.

### 1.3 Cloud portability matrix (the 4 cloud types)

| Backend | Commercial | GCC | GCC-High | DoD IL5 / IL6 | Endpoint difference |
|---|---|---|---|---|---|
| Azure SQL Database (control) | GA | GA | GA | GA (FedRAMP High) | ARM `management.azure.com` vs `management.usgovcloudapi.net` |
| Azure SQL Database (TDS) | GA | GA | GA | GA | `database.windows.net` vs `database.usgovcloudapi.net`; token scope swaps to `database.usgovcloudapi.net/.default` |
| Azure Cosmos DB (NoSQL) | GA | GA | GA | GA | `documents.azure.com` vs `documents.azure.us` |
| Azure Cosmos DB (Gremlin) | GA | GA | GA | verify region | `gremlin.cosmos.azure.com` vs `gremlin.cosmos.azure.us` |
| ADLS Gen2 (Bronze Delta) | GA | GA | GA | GA | `dfs.core.windows.net` vs `dfs.core.usgovcloudapi.net` |
| Synapse Serverless SQL | GA | GA | GA | GA (verify SKU/region) | `.azuresynapse.net` vs `.sql.azuresynapse.usgovcloudapi.net` |
| ADF / Synapse pipelines (CDC) | GA | GA | GA | GA | regional only |
| Azure OpenAI (Copilot) | GA | GA | GA (FedRAMP High) | IL4/IL5 | `openai.azure.com` vs `openai.azure.us` |
| Key Vault | GA | GA | GA | GA | `vault.azure.net` vs `vault.usgovcloudapi.net` |

**Implication for code:** every host must resolve via the existing
`cloud-endpoints` helper (`getSqlHostSuffix()`, ARM endpoint, `getDfsSuffix()`,
`getSynapseSqlSuffix()`, `getCosmosSuffix()`, `getKeyVaultSuffix()`,
`getOpenAiSuffix()`) — **never hard-coded**. Any new client a task adds MUST
route through that helper and ship a cloud-matrix unit test (Commercial + at
least one Gov suffix).

### 1.4 Item-type topology in Loom

```
azure-sql-database (item)               ← Microsoft.Sql/servers/databases
 ├─ data plane: TDS (AAD token)         ← query editor, object explorer, perf
 └─ opt-in mirror → mirrored-database   ← when "Replicate to analytics" enabled
sql-database (item, Fabric-flavored)    ← shares editor + TDS with azure-sql-database
cosmos-db (item) / cosmos-account       ← Microsoft.DocumentDB (NoSQL + Gremlin)
 └─ data plane: Cosmos SDK / Gremlin    ← Data Explorer, NoSQL query, graph
mirrored-database (item)                ← ADLS Gen2 Bronze Delta
 ├─ source connector (SQL/Snowflake/PG/Cosmos/open) ← ADF CDC / Synapse Link
 ├─ paired: synapse-serverless-sql-pool (1:1)       ← SQL analytics endpoint
 └─ replication monitor                 ← per-table CDC status
mirrored-databricks (item)              ← Unity Catalog mirror (existing editor)
```

---

## 2. Feature-by-feature parity table

Legend — **Status:** ✅ built · ⚠️ honest-gate (renders, partial backend, MessageBar) · 🔶 stub · ❌ missing.
Grounded in: `apps/fiab-console/lib/editors/{unified-sql-database,sql-database,cosmos-account,mirrored-database,mirrored-databricks,azure-sql,synapse-sql}-editor(s).tsx`, `lib/azure/{azure-sql,sql-objects,cosmos,cosmos-data,cosmos-account,mirror-engine,synapse-sql}-client.ts`, and `docs/fiab/parity/{sql-database,sql-database-objects,azure-sql-database,cosmos-db,cosmos-account}.md`, `docs/fiab/mirrored-database-parity-spec.md`.

### 2.1 SQL Database (Fabric SQL + Azure SQL — shared editor)

| # | Fabric feature | Azure-native backend | Loom UI | Portability | Status today | Work needed |
|---|---|---|---|---|---|---|
| S1 | Create SQL database (name, ws, Create) | ARM PUT `Microsoft.Sql/servers/databases` | Provision tab: name + SKU + sample seed | all clouds | ✅ built | advanced create options (S3) |
| S2 | Create options: collation / ZR / backup-redundancy / maintenance window | ARM `collation`, `zoneRedundant`, `requestedBackupStorageRedundancy`, `maintenanceConfigurationId` | Provision form fields | all clouds | ⚠️ honest-gate (backend ready, no fields) | **T1** |
| S3 | Scale: vCore / DTU / serverless auto-pause | ARM PATCH SKU / `autoPauseDelay`/`minCapacity` | "Compute & Storage" tab | all clouds | ❌ missing | **T2** |
| S4 | Web T-SQL editor (Monaco, IntelliSense, snippets, templates) | Monaco (OSS) + TDS | Query tab MonacoTextarea `tsql` | n/a / TDS | ⚠️ partial (no IntelliSense feed, no snippet catalog) | **T3** |
| S5 | Run / Run-selection | TDS `executeQuery` | Run button + Ctrl+Enter | TDS | ✅ built | selection-run (T3) |
| S6 | Cancel running query + background continuation + toast | TDS cancel token + SSE/poll | Cancel button; bg toast | TDS | ❌ missing | **T4** |
| S7 | Results grid (10k rows), Messages tab, status bar | TDS response/messages | ResultsPanel | TDS | ✅ built (5k cap) | raise to 10k + Messages tab + multi-result-set (T5) |
| S8 | Results: search, copy (names/results), download CSV/JSON/XLSX | client | Copy dropdown + downloads | n/a | ⚠️ partial (CSV/JSON only) | **T5** |
| S9 | Object Explorer tree (tables/views/procs/funcs/schemas/indexes) | `sys.*`/`INFORMATION_SCHEMA` over TDS | `SqlDbTree` | TDS | ✅ built | indexes + context menus (T6) |
| S10 | Data Preview (top 1000, sort/search/show-hide cols) | TDS `SELECT TOP 1000` | preview grid | TDS | ⚠️ partial | **T6** |
| S11 | Object context menus (SELECT TOP, New query, query-in-notebook, rename, delete, script) | TDS DDL + deep-link | tree context `Menu` | TDS | 🔶 stub | **T6** |
| S12 | My Queries / Shared Queries folders + multi-select bulk delete | item state (Cosmos) | Queries panel | n/a | ❌ missing | **T7** |
| S13 | Performance dashboard / summary | Query Store `sys.query_store_*` + DMVs | Performance tab (charts) | TDS | ❌ missing | **T8** |
| S14 | Copilot: chat, Fix, Explain, inline completion, NL-comment→T-SQL | Azure OpenAI via `apps/copilot` | Copilot pane + ribbon quick-actions | Comm+Gov OpenAI | ❌ missing (per-editor) | **T9** |
| S15 | Get Data (Dataflow/pipeline/copy) | ADF Copy Activity | "Get data" ribbon → ADF designer deep-link | all clouds | ❌ missing | **T10** |
| S16 | Connection strings panel (ADO.NET/JDBC/ODBC/PHP/Go) | ARM props + templated | Connect tab strings card | all clouds | ⚠️ partial (FQDN only) | **T11** |
| S17 | Restore points / PITR | ARM `restorableDroppedDatabases` + restore | Settings → Restore | all clouds | ❌ missing | **T12** |
| S18 | Sharing dialog (item-level) | Azure RBAC + Entra | Share button | Entra all | ⚠️ partial (workspace-level) | **T13** |
| S19 | Source control (Git) for queries/schema | ADO/GitHub Git | Source-control panel | all clouds | ⚠️ partial (ws-level) | documented gate (T13) |
| S20 | Auto-mirror to analytics (OneLake → ADLS Bronze Delta) | `mirror-engine` ADF CDC → Delta | Mirroring tab toggle | all clouds | ✅ built | verify Azure-native default (T14) |
| S21 | Firewall / network rules | ARM firewall rules | Connect → Firewall | all clouds | ✅ built | — |
| S22 | AAD admin / SQL2025 features (vector) | ARM aad-admin + TDS | dedicated routes | all clouds | ✅ built | — |

### 2.2 Cosmos DB in Fabric

| # | Fabric feature | Azure-native backend | Loom UI | Portability | Status today | Work needed |
|---|---|---|---|---|---|---|
| C1 | Create Cosmos DB item (NoSQL) | ARM `Microsoft.DocumentDB/databaseAccounts` + DB | Create dialog | all clouds | ✅ built | verify advanced (C7) |
| C2 | Data Explorer — DB/container tree | Cosmos data-plane list | `cosmos-account-editor` tree | Cosmos all | ✅ built | — |
| C3 | Container CRUD (partition key, throughput) | Cosmos control plane | container wizard | all clouds | ⚠️ partial | **T15** |
| C4 | Item browse + edit (document JSON) | Cosmos data-plane read/upsert | item grid + JSON editor | Cosmos all | ✅ built | — |
| C5 | NoSQL query editor + results | Cosmos `queryItems` | Monaco `sql` + grid | Cosmos all | ✅ built | — |
| C6 | Throughput / autoscale / indexing policy / TTL | Cosmos control plane | Settings tab (forms) | all clouds | ❌ missing | **T15** |
| C7 | Keys / connection strings panel | ARM `listKeys` | Connect card | all clouds | ⚠️ partial | **T16** |
| C8 | Graph (Gremlin) explorer + query | Cosmos Gremlin API | graph canvas + Gremlin editor | Gremlin all | 🔶 stub | **T17** |
| C9 | Metrics (RU/s, storage, throttling) | Azure Monitor metrics | Metrics tab charts | all clouds | ❌ missing | **T18** |

### 2.3 Mirrored Databases

| # | Fabric feature | Azure-native backend | Loom UI | Portability | Status today | Work needed |
|---|---|---|---|---|---|---|
| M1 | New mirrored DB wizard (source picker) | `mirror-engine` + source connector | Source-picker wizard | all clouds | ⚠️ partial | **T19** |
| M2 | Source connectors: Azure SQL DB/MI, SQL Server, Snowflake, Cosmos, PostgreSQL | ADF CDC / Synapse Link copy → Bronze Delta | per-source config forms (KV secretRef) | all clouds | 🔶 stub (SQL only) | **T19** |
| M3 | Open mirroring (push Parquet → managed) | ADLS landing zone → Delta merge | landing-zone config + monitor | all clouds | ❌ missing | **T20** |
| M4 | Table selection (include/exclude, all/subset) | mirror config metadata | table-picker grid | all clouds | ⚠️ partial | **T19** |
| M5 | Replication monitor (per-table status, rows, last-sync, errors) | `mirror-engine` status + ADF run telemetry | Monitor tab DataGrid | all clouds | ⚠️ honest-gate | **T21** |
| M6 | Stop / start / restart replication | `mirror-engine` lifecycle | ribbon actions | all clouds | 🔶 stub | **T21** |
| M7 | SQL analytics endpoint over mirror | Synapse Serverless SQL over Bronze Delta | paired SQL endpoint editor | Synapse Comm+Gov | ❌ missing | **T22** |
| M8 | Mirrored Databricks (Unity Catalog) | existing `mirrored-databricks-editor` | UC catalog browse | all clouds | ✅ built | — |

---

## 3. Azure / OSS services — full feature set + native UI surfaces to rebuild 1:1

Per `ui-parity.md`, **inventory the real UI first** (grounded in Microsoft Learn
via `microsoft_docs_search`/`microsoft_docs_fetch` and the live portal), write
the inventory into the per-surface parity doc, then build it one-for-one.

### 3.1 Azure SQL Database
- **Control plane:** create/scale (vCore/DTU/serverless), collation, zone
  redundancy, backup-storage redundancy, maintenance window, PITR/restore,
  firewall + private endpoint, AAD admin, geo-replication, elastic pools.
- **Data plane (TDS):** T-SQL DDL/DML/DCL; `sys.*`/`INFORMATION_SCHEMA`;
  Query Store DMVs (`sys.query_store_query`, `_query_text`, `_runtime_stats`,
  `_plan`); cancel; multiple result sets.
- **Portal surfaces to mirror:** Query editor (preview) — toolbar, Monaco
  editor, Results/Messages tabs, object tree, Save/Open query; Query Performance
  Insight blade (top-resource queries, CPU/duration/IO charts, query detail);
  Compute+Storage scale blade; Connection strings blade (ADO.NET/JDBC/ODBC/PHP/Go);
  Restore blade.
- **Loom mapping:** S1–S22.

### 3.2 Azure SQL — Query Store / Query Performance Insight
- **Capabilities:** top N queries by CPU/duration/logical-reads/execution-count
  over a time window; per-query runtime-stats time series; query text + plan;
  drill from chart to query detail; custom time range.
- **Portal surfaces:** QPI overview chart (stacked by query), Long-running
  queries tab, Custom tab with metric + aggregation + time pickers, per-query
  detail pane.
- **Loom mapping:** S13 (Performance tab) — **T8**.

### 3.3 Azure Cosmos DB (NoSQL + Gremlin)
- **Control plane:** account/db/container CRUD; manual vs autoscale throughput;
  indexing policy (included/excluded paths, composite, spatial); default TTL;
  unique keys; partition key; `listKeys`/`listConnectionStrings`; consistency.
- **Data plane:** `queryItems` (NoSQL), read/upsert/delete item, partition-key
  routing; Gremlin traversals (`g.V()`, `addV/addE`, `make-graph`-style).
- **Portal surfaces (Data Explorer):** db/container tree, Items grid + JSON
  editor, New SQL Query tab + results + query stats (RU charge, exec time),
  Scale & Settings (throughput, indexing policy JSON, TTL), Keys blade, Metrics.
- **Loom mapping:** C1–C9.

### 3.4 Mirroring (ADF CDC / Synapse Link → ADLS Bronze Delta)
- **Capabilities:** initial snapshot + incremental CDC; table include/exclude;
  schema mapping; landing as Delta (medallion Bronze); per-table sync state,
  row counts, last-sync timestamp, error surfacing; stop/start/restart.
- **Open mirroring:** external producer pushes Parquet to a landing path; Loom
  merges to managed Delta on a schedule.
- **Portal surfaces (Fabric):** New mirrored DB wizard (source → connection →
  table selection), replication status page (table grid + status + monitoring
  metrics), SQL analytics endpoint, settings.
- **Loom mapping:** M1–M8.

### 3.5 OSS — Monaco, mssql/tedious, Delta Lake, TinkerPop Gremlin
- **Monaco Editor (MIT):** T-SQL/NoSQL editing, IntelliSense provider hook,
  snippet provider, find/replace, command palette, keybindings.
- **mssql/tedious (npm):** TDS connection pooling, AAD token auth, cancel,
  streamed result sets.
- **Delta Lake OSS:** `_delta_log` reader → table status/version for mirror
  Bronze tables; Serverless `OPENROWSET` over Delta for the SQL endpoint.
- **Apache TinkerPop Gremlin (`gremlin` npm):** graph traversal client for
  Cosmos Gremlin API.

---

## 4. Sequenced TASK LIST

Each task is an independently shippable unit. **No stubs, no mock data, no
`return []`.** Each lands real backend calls or an honest infra-gate MessageBar
naming the exact env var / role / resource. Every task ends with a real-data E2E
receipt (per `no-vaporware.md`) and a parity-doc row update (per `ui-parity.md`).

Common conventions:
- BFF routes return `{ ok: boolean, data?, error? }` with correct HTTP codes.
- New hosts resolved via `cloud-endpoints`; covered by a cloud-matrix test.
- New env vars added to `apps[]` in `platform/fiab/bicep/admin-plane/main.bicep`;
  new role grants added to the relevant Bicep module; new clients use the Console
  managed identity (`LOOM_UAMI_CLIENT_ID`) via `ChainedTokenCredential`.
- All config UI uses dropdowns/wizards/WYSIWYG (per `loom_no_freeform_config.md`);
  only the T-SQL/NoSQL/Gremlin editors and ADF expression builders are raw text.
- "Fabric UNSET" means `LOOM_DEFAULT_FABRIC_WORKSPACE` is empty for the receipt.

---

### T1 — SQL DB advanced create options (collation / ZR / backup-redundancy / maintenance window) (S2)
- **Goal:** Surface the create-time ARM options that the backend already accepts
  but the Provision form omits.
- **Files:** edit `apps/fiab-console/lib/editors/unified-sql-database-editor.tsx`
  (Provision tab form); edit `apps/fiab-console/lib/azure/azure-sql-client.ts`
  (`createDatabase` payload — confirm `collation`, `zoneRedundant`,
  `requestedBackupStorageRedundancy`, `maintenanceConfigurationId`); edit
  `app/api/items/azure-sql-database/[id]/create-db/route.ts` to pass them.
- **Backend/REST:** ARM PUT `Microsoft.Sql/servers/databases` (api-version
  ≥2022-05-01-preview) with the new properties.
- **Bicep/portability:** none new; ARM endpoint via existing helper. Cloud-matrix
  test asserts Commercial + Gov ARM hosts.
- **UI surface:** Provision form — collation dropdown (enumerated, default
  `SQL_Latin1_General_CP1_CI_AS`), zone-redundant toggle, backup-redundancy
  dropdown (Local/Zone/Geo/GeoZone), maintenance-window dropdown.
- **Acceptance:** with Fabric UNSET, creating a DB with a non-default collation +
  ZR on produces a real DB whose ARM GET reflects those properties (in the
  receipt); invalid collation rejected client-side before submit.

### T2 — Compute & Storage scale tab (vCore / DTU / serverless auto-pause) (S3)
- **Goal:** Post-create scaling — change SKU tier/family/capacity, switch to
  serverless with auto-pause + min/max vCores.
- **Files:** add `lib/editors/components/sql-scale-panel.tsx`; edit
  `unified-sql-database-editor.tsx` (new "Compute & Storage" tab); add
  `app/api/items/azure-sql-database/[id]/scale/route.ts`; add
  `azure-sql-client.scaleDatabase`.
- **Backend/REST:** ARM PATCH database SKU (`sku.name/tier/family/capacity`),
  serverless `autoPauseDelay`/`minCapacity`/`maxSizeBytes`; poll the LRO to done.
- **Bicep/portability:** UAMI needs SQL DB Contributor on the server RG (add to
  `platform/fiab/bicep/modules/.../sql-rbac.bicep`); ARM host via helper.
- **UI surface:** tier radio (DTU/vCore/serverless), family + capacity dropdowns,
  max-size slider, auto-pause-delay control; cost estimate hint; Apply with LRO
  progress.
- **Acceptance:** scaling a real DB from S0 → S1 (or provisioned → serverless)
  reflects in ARM GET; LRO completion shown; receipt has before/after SKU.

### T3 — Query editor parity: templates, snippets, selection-run, IntelliSense feed (S4/S5)
- **Goal:** Bring the Monaco T-SQL editor to Fabric parity — New-Query template
  dropdown (CREATE TABLE/PROC/VIEW/INDEX/FUNCTION), `sql` snippet catalog,
  run-selection, schema-aware IntelliSense (completion provider fed from the
  object catalog), find/replace, command palette.
- **Files:** edit `unified-sql-database-editor.tsx` + `sql-database-editor.tsx`
  (Query tab); add `lib/editors/components/tsql-monaco.tsx` (snippet + completion
  provider); reuse `SqlDbTree`'s catalog for completion items.
- **Backend/REST:** completion items from existing `sql-objects-client`
  (tables/columns/procs); run-selection posts highlighted text to the existing
  query route.
- **Bicep/portability:** none (client + TDS).
- **UI surface:** New-Query split-button with template menu; snippet picker on
  typing `sql`; Ctrl+F/Ctrl+H; F1 command palette; run highlighted selection.
- **Acceptance:** typing `sql` offers real templates; IntelliSense suggests real
  table/column names from the connected DB; running a highlighted `SELECT`
  executes only the selection (receipt shows the selection result, not the whole
  script).

### T4 — Cancel query + background continuation + toast (S6)
- **Goal:** A running query can be cancelled; closing the tab offers
  "keep running in background"; a toast fires when a background query completes.
- **Files:** edit `azure-sql-client.executeQuery` (accept cancel token / request
  id); add `app/api/items/azure-sql-database/[id]/query/cancel/route.ts`; edit
  query route to register cancellable requests; edit editor Query tab +
  shared toast/jobs store.
- **Backend/REST:** `mssql` request `cancel()`; server tracks request id; status
  poll or SSE for background completion.
- **Bicep/portability:** none.
- **UI surface:** Cancel button (enabled while running); close-tab prompt
  (Keep running / Cancel); completion toast naming the DB + query.
- **Acceptance:** a long query (`WAITFOR DELAY '00:00:30'`) is cancelled and
  TDS reports cancellation (receipt); a backgrounded query completes after tab
  switch and raises the toast.

### T5 — Results pane parity: 10k rows, Messages tab, multi-result-set, copy/download XLSX (S7/S8)
- **Goal:** Raise preview cap to 10,000; add a Messages tab (errors/warnings/
  row-count/duration); multiple-result-set dropdown; copy (with/without column
  names), download XLSX (in addition to CSV/JSON), in-grid search.
- **Files:** edit query route to return `recordsets[]` (all sets) + `messages[]`;
  edit `ResultsPanel` / editor results area; add XLSX export util.
- **Backend/REST:** `mssql` multiple recordsets + info messages; cap rows at
  10,000 server-side with an honest "showing first 10,000" note.
- **Bicep/portability:** none.
- **UI surface:** Results/Messages tabs; result-set dropdown; Copy dropdown
  (names+results / results / names only); Download CSV/JSON/XLSX; grid search.
- **Acceptance:** a multi-statement batch shows ≥2 selectable result sets; the
  Messages tab shows real row counts + duration; XLSX downloads open in Excel
  with correct columns; receipt shows multi-recordset response shape.

### T6 — Object Explorer parity: indexes, data preview controls, full context menus (S9/S10/S11)
- **Goal:** Complete `SqlDbTree` — add Indexes node; Data Preview top-1000 with
  sort/search/show-hide columns; per-object context menu (SELECT TOP 1000, New
  query, New query in notebook, Rename, Delete, Script as CREATE/ALTER/DROP,
  Refresh).
- **Files:** edit `lib/components/sql-db-tree.tsx` (or current path); extend
  `sql-objects-client` (indexes via `sys.indexes`; scripting via catalog views);
  add context-menu actions wired to TDS DDL + deep-links.
- **Backend/REST:** `sys.indexes`/`sys.index_columns`; `SELECT TOP 1000`;
  `sp_rename`/`DROP`/`ALTER` for rename/delete; generated CREATE script.
- **Bicep/portability:** none.
- **UI surface:** index nodes with icons; preview grid controls; Fluent `Menu`
  context menu per node type.
- **Acceptance:** indexes list real index names; "SELECT TOP 1000" opens a query
  with live rows; Rename actually renames the object (verified by re-listing);
  "Script as CREATE" emits valid runnable DDL (receipt includes the script).

### T7 — My Queries / Shared Queries folders + bulk delete (S12)
- **Goal:** Persisted saved queries — personal "My Queries" and workspace
  "Shared Queries", with rename/duplicate/delete and Ctrl/Shift multi-select
  bulk delete.
- **Files:** add `app/api/items/azure-sql-database/[id]/queries/route.ts` (CRUD);
  edit editor (Queries panel); store queries in the item-state Cosmos container.
- **Backend/REST:** Cosmos upsert/list/delete keyed by item + scope (private vs
  shared, scoped by caller's Entra oid); shared visible to workspace
  Admin/Member/Contributor (RBAC check on the route).
- **Bicep/portability:** uses the existing Loom item-state Cosmos container
  (`createIfNotExists`); no new infra.
- **UI surface:** Queries panel with My/Shared folders, save-query dialog,
  context menu (rename/duplicate/delete), multi-select + bulk delete.
- **Acceptance:** a saved query persists across reload; a shared query is visible
  to a second workspace member (or honest RBAC denial for a non-member);
  multi-select deletes exactly the selected queries (receipt shows Cosmos docs
  before/after).

### T8 — Performance dashboard (Query Store / QPI) (S13)
- **Goal:** Build the Performance tab over Query Store: top-N queries by
  CPU/duration/logical-reads/execution-count for a time window, per-query
  runtime-stats time series, query text + plan, drill-through; custom time range.
- **Files:** add `lib/editors/components/sql-performance-dashboard.tsx`; add
  `app/api/items/azure-sql-database/[id]/performance/route.ts`; extend
  `sql-objects-client` with Query Store queries.
- **Backend/REST:** `sys.query_store_query` + `_query_text` + `_runtime_stats` +
  `_runtime_stats_interval` + `_plan` over TDS; if Query Store is OFF, run
  `ALTER DATABASE CURRENT SET QUERY_STORE = ON` (with consent) or show an
  honest-gate MessageBar offering to enable it.
- **Bicep/portability:** none beyond TDS.
- **UI surface:** metric dropdown + aggregation + time-range pickers; top-queries
  bar/stacked chart; per-query detail with text + plan; click-through.
- **Acceptance:** against a DB with real workload, the dashboard lists real
  top-resource queries with true metrics; selecting one shows its real text +
  runtime series; when Query Store is off, the gate explains the one-click
  enable (receipt shows the `sys.query_store_*` response).

### T9 — Copilot quick-actions in the SQL editor (Fix / Explain / inline / NL→T-SQL) (S14)
- **Goal:** Wire the SQL editor to the Azure OpenAI Copilot backend — chat pane,
  Fix (repair highlighted error), Explain (NL comments), inline completion
  (Tab-to-accept), NL-comment→T-SQL.
- **Files:** edit `unified-sql-database-editor.tsx` (Copilot pane + ribbon
  quick-actions); add `app/api/items/azure-sql-database/[id]/copilot/route.ts`
  proxying to `apps/copilot` (Azure OpenAI Function backend); add Monaco inline
  completion provider.
- **Backend/REST:** Azure OpenAI `gpt-4o` chat completions via the existing
  `apps/copilot` Function; prompt includes the schema catalog + selection.
- **Bicep/portability:** env `LOOM_AZURE_OPENAI_ENDPOINT` (resolved via
  `getOpenAiSuffix()` — `openai.azure.com` vs `openai.azure.us`), UAMI granted
  `Cognitive Services OpenAI User` (add to Bicep). If endpoint unset → honest-gate
  MessageBar naming the env var + role.
- **UI surface:** Copilot side pane; Fix/Explain ribbon buttons (act on
  selection); inline ghost-text completion; NL comment → Tab generates T-SQL.
- **Acceptance:** "Explain" annotates a real query with correct NL comments;
  "Fix" repairs a deliberately broken query so it then runs (receipt: broken →
  fixed → successful run); when OpenAI is unprovisioned, the gate names the env
  var + role and the rest of the editor still works.

### T10 — "Get data" ribbon → ADF Copy / pipeline / dataflow deep-links (S15)
- **Goal:** Get-data dropdown that opens real ingestion surfaces (ADF Copy
  activity, pipeline, dataflow) targeting this database — no toasts, real nav.
- **Files:** edit editor ribbon; add deep-link helpers to the ADF designer
  editor with the DB pre-selected as sink.
- **Backend/REST:** navigation to existing ADF designer (real Synapse/ADF
  pipeline backend); the created pipeline writes to this DB via TDS sink.
- **Bicep/portability:** ADF/Synapse already provisioned; no new infra.
- **UI surface:** Get-data `Menu` (Copy data, New pipeline, New dataflow);
  each opens its real editor.
- **Acceptance:** "Copy data" opens the ADF designer with this DB as the sink;
  running the resulting pipeline lands rows in the DB (receipt: pipeline run id +
  `SELECT COUNT(*)` delta).

### T11 — Connection strings panel (ADO.NET / JDBC / ODBC / PHP / Go) (S16)
- **Goal:** Connect tab "Connection strings" card with copy-ready templates for
  each driver, using the real server FQDN + DB + AAD-auth guidance.
- **Files:** edit `unified-sql-database-editor.tsx` Connect tab; add a
  connection-string builder util (pure, cloud-aware).
- **Backend/REST:** ARM GET server/database properties for FQDN; strings built
  client-side with the correct Gov suffix.
- **Bicep/portability:** FQDN suffix via `getSqlHostSuffix()`; Gov shows
  `database.usgovcloudapi.net`.
- **UI surface:** driver tabs (ADO.NET/JDBC/ODBC/PHP/Go) each with a copy button.
- **Acceptance:** each string contains the real FQDN + DB name + correct cloud
  suffix; a copied ADO.NET string connects successfully out-of-band (or the doc
  notes the verification); receipt shows the generated strings for Comm + Gov.

### T12 — Restore points / PITR (S17)
- **Goal:** Settings → Restore: list restore points (PITR window + deleted DBs)
  and trigger a point-in-time restore to a new DB.
- **Files:** add `lib/editors/components/sql-restore-panel.tsx`; add
  `app/api/items/azure-sql-database/[id]/restore/route.ts`; extend
  `azure-sql-client` (restorable points + restore).
- **Backend/REST:** ARM `restorableDroppedDatabases` + database `restore`
  (`createMode: PointInTimeRestore`, `restorePointInTime`, `sourceDatabaseId`);
  poll the LRO.
- **Bicep/portability:** UAMI SQL DB Contributor (shared with T2); ARM via helper.
- **UI surface:** earliest-restore-time display; time picker within window; new
  DB name; Restore with LRO progress.
- **Acceptance:** a PITR to a new DB name produces a real restored DB (ARM GET +
  TDS `SELECT 1`); the picker enforces the real restorable window (receipt shows
  the new DB id).

### T13 — Item-level sharing + Git source-control gates (S18/S19)
- **Goal:** Per-database Share dialog (Azure RBAC role assignment + Entra
  principal picker); document Git source-control as a workspace-level honest gate.
- **Files:** add `lib/editors/components/share-dialog.tsx` (reusable); add
  `app/api/items/azure-sql-database/[id]/share/route.ts`; reference existing
  RBAC/Graph clients.
- **Backend/REST:** Entra user/group search (Graph) + ARM role assignment on the
  database scope; the route requires the caller to hold Owner/RBAC-Admin (honest
  403 otherwise).
- **Bicep/portability:** UAMI already has constrained RBAC-Admin (per memory
  `csa_loom_governance_buildassist`); Graph read grant present.
- **UI surface:** principal search + role dropdown (Reader/Contributor/etc.) +
  Assign; current-assignments list; Git tab shows honest-gate MessageBar naming
  the ADO/GitHub connection requirement.
- **Acceptance:** assigning Reader to a real principal creates a live ARM role
  assignment (receipt: assignment id); revocation removes it; Git gate names the
  exact connection setting.

### T14 — Verify auto-mirror is Azure-native by DEFAULT (S20, no-fabric audit)
- **Goal:** Prove the SQL DB "Replicate to analytics" path uses `mirror-engine` →
  ADLS Bronze Delta by default with Fabric UNSET (no OneLake/Power BI gate).
- **Files:** audit `lib/editors/unified-sql-database-editor.tsx` mirroring tab +
  `app/api/items/azure-sql-database/[id]/mirroring/route.ts` +
  `lib/azure/mirror-engine.ts`; remove/branch any `fabricWorkspaceId` read that
  lacks an Azure fallback in the same function.
- **Backend/REST:** ADF CDC / Synapse Link copy → ADLS Bronze Delta; Serverless
  SQL endpoint over the Delta.
- **Bicep/portability:** ADLS + Synapse already provisioned; suffixes via helper.
- **UI surface:** Mirroring tab toggle defaults to the Azure-native target; no
  "bind a Fabric workspace" message on the default path.
- **Acceptance:** with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, enabling mirroring
  lands real Delta files in ADLS Bronze and the Serverless endpoint queries them
  (receipt: ABFS path listing + `SELECT COUNT(*)` over the external table); the
  no-fabric grep (`grep -rn "fabricWorkspaceId"` in provisioners) shows an Azure
  fallback in every hit.

### T15 — Cosmos container CRUD + throughput / indexing / TTL settings (C3/C6)
- **Goal:** Full container lifecycle + Settings tab: partition key, manual vs
  autoscale throughput, indexing policy (included/excluded/composite via a
  builder, not raw JSON), default TTL, unique keys.
- **Files:** add `lib/editors/components/cosmos-container-wizard.tsx` +
  `cosmos-settings-panel.tsx`; edit `cosmos-account-editor.tsx`; extend
  `cosmos-account-client` (control-plane container ops) +
  `cosmos-client`/`cosmos-data-client`.
- **Backend/REST:** Cosmos control plane (ARM `Microsoft.DocumentDB/.../containers`
  PUT) for partition key/throughput/indexing/TTL/unique keys.
- **Bicep/portability:** Cosmos account provisioned; UAMI Cosmos DB Operator;
  data-plane via account keys/AAD; suffix via `getCosmosSuffix()`.
- **UI surface:** create-container wizard (id, partition key, throughput mode +
  RU/s, autoscale max); Settings tab with indexing-policy builder (path rows,
  include/exclude, composite), TTL toggle + seconds, unique-keys editor.
- **Acceptance:** creating a container with autoscale + a composite index + TTL
  produces a real container whose control-plane GET reflects all settings
  (receipt); editing throughput changes RU/s live.

### T16 — Cosmos keys / connection strings panel (C7)
- **Goal:** Connect card showing endpoint + primary/secondary keys (masked,
  reveal/copy) + connection strings (NoSQL SDK / Mongo / Gremlin where enabled).
- **Files:** edit `cosmos-account-editor.tsx` Connect tab; add
  `app/api/items/cosmos-db/[id]/keys/route.ts`.
- **Backend/REST:** ARM `listKeys` / `listConnectionStrings` on the account
  (requires Cosmos DB Account Reader / key-list permission).
- **Bicep/portability:** UAMI granted `listKeys` action via a custom/built-in
  role (add to Bicep); honest-gate if absent. Suffix via helper.
- **UI surface:** endpoint URI; masked keys with reveal + copy + (optional)
  regenerate; connection-string list per API.
- **Acceptance:** real keys returned and copyable; reveal works; when the UAMI
  lacks `listKeys`, the gate names the exact role (receipt shows the keys
  response or the gate).

### T17 — Cosmos Gremlin graph explorer + query editor (C8)
- **Goal:** Replace the Gremlin stub with a real graph canvas + Gremlin query
  editor over Cosmos Gremlin API (per `cosmos-gremlin-graph-parity-spec.md`).
- **Files:** add `lib/editors/components/gremlin-graph-canvas.tsx`; edit
  `cosmos-account-editor.tsx` (Graph tab); add
  `app/api/items/cosmos-db/[id]/gremlin/route.ts`; add `lib/azure/gremlin-client.ts`.
- **Backend/REST:** `gremlin` (TinkerPop) driver to the Gremlin endpoint; run
  `g.V()/g.E()/addV/addE` traversals; map results to nodes/edges.
- **Bicep/portability:** Gremlin endpoint suffix (`gremlin.cosmos.azure.com` vs
  `.azure.us`); account must have Gremlin API enabled → honest-gate otherwise.
- **UI surface:** Gremlin Monaco editor + Run; force-directed graph canvas
  (zoom/pan, node/edge detail, add-vertex/edge actions); results-as-JSON toggle.
- **Acceptance:** a real `g.V().limit(25)` renders live vertices/edges on the
  canvas; adding a vertex persists (re-query confirms); non-Gremlin account shows
  the honest gate (receipt: traversal response).

### T18 — Cosmos metrics tab (RU/s, storage, throttling) (C9)
- **Goal:** Metrics tab charting account/container RU consumption, provisioned
  vs consumed, storage, and 429 throttling over a time range.
- **Files:** add `lib/editors/components/cosmos-metrics.tsx`; add
  `app/api/items/cosmos-db/[id]/metrics/route.ts`; reuse `monitor-client`.
- **Backend/REST:** Azure Monitor metrics (`TotalRequestUnits`, `DataUsage`,
  `TotalRequests` filtered by `StatusCode 429`) for the account/container.
- **Bicep/portability:** UAMI Monitoring Reader (likely already granted); ARM via
  helper.
- **UI surface:** time-range picker; RU consumed vs provisioned chart; storage
  chart; throttled-requests chart.
- **Acceptance:** real metric series render for a container with traffic; the
  429 chart reflects real throttling (receipt: Monitor response with non-empty
  timeseries).

### T19 — Mirrored DB wizard + multi-source connectors + table selection (M1/M2/M4)
- **Goal:** New-mirrored-DB wizard with a source picker (Azure SQL DB/MI, SQL
  Server, Snowflake, Cosmos DB, PostgreSQL), per-source connection forms (KV
  secretRef, no plaintext), and a table include/exclude picker — all wired to
  `mirror-engine` → ADF CDC → ADLS Bronze Delta.
- **Files:** add `lib/editors/components/mirror-source-wizard.tsx`; edit
  `mirrored-database-editor.tsx`; add
  `app/api/items/mirrored-database/[id]/sources/route.ts` +
  `.../tables/route.ts`; extend `mirror-engine.ts` per source.
- **Backend/REST:** for each source, enumerate tables (source-native catalog
  query) and configure an ADF CDC / Synapse Link copy job → Bronze Delta;
  secrets resolved from Key Vault secretRef.
- **Bicep/portability:** ADF/Synapse + ADLS provisioned; UAMI granted KV get-
  secret + Storage Blob Data Contributor; suffixes via helper. Source-cloud creds
  (Snowflake/PG) via KV.
- **UI surface:** wizard (source type → connection [KV secret] → test → table
  picker [all/subset, include/exclude] → review/create).
- **Acceptance:** creating a mirror from a real Azure SQL source enumerates real
  tables; selecting a subset configures a real ADF CDC job; initial snapshot
  lands Delta in ADLS Bronze (receipt: ADF run id + ABFS Delta listing).

### T20 — Open mirroring (push Parquet → managed Delta) (M3)
- **Goal:** Open-mirroring landing zone — an external producer pushes Parquet to
  an ADLS landing path; Loom merges to managed Delta on a schedule + monitors it.
- **Files:** add `lib/editors/components/open-mirror-config.tsx`; edit
  `mirrored-database-editor.tsx`; add
  `app/api/items/mirrored-database/[id]/open-mirror/route.ts`; extend
  `mirror-engine` (landing-zone watch + merge job).
- **Backend/REST:** ADLS landing path (SAS/RBAC for producer); a scheduled
  Synapse/Spark or ADF merge job folds new Parquet into managed Delta.
- **Bicep/portability:** ADLS landing container; UAMI Storage Blob Data
  Contributor; merge job on Synapse Spark. Suffixes via helper.
- **UI surface:** landing-path display + producer creds card; merge schedule
  dropdown; status panel.
- **Acceptance:** dropping a real Parquet file in the landing path triggers a
  merge that appears as queryable Delta (receipt: Parquet drop → merge job id →
  `SELECT COUNT(*)` over the managed table).

### T21 — Replication monitor + lifecycle (status / rows / last-sync / stop-start-restart) (M5/M6)
- **Goal:** Monitor tab: per-table replication status, rows replicated,
  last-sync timestamp, and errors; ribbon Stop/Start/Restart replication.
- **Files:** edit `mirrored-database-editor.tsx` (Monitor tab + ribbon); add
  `app/api/items/mirrored-database/[id]/monitor/route.ts` +
  `.../lifecycle/route.ts`; extend `mirror-engine` (status + lifecycle).
- **Backend/REST:** ADF pipeline-run telemetry + `_delta_log`/row-count probes
  per table; lifecycle calls pause/resume/restart the CDC job.
- **Bicep/portability:** ADF + ADLS provisioned; Monitoring Reader for run
  telemetry.
- **UI surface:** Fluent DataGrid (table, status badge, rows, last-sync, error);
  Stop/Start/Restart buttons with confirm; auto-refresh.
- **Acceptance:** the monitor shows real per-table status + true row counts +
  real last-sync; Stop actually pauses the CDC job (subsequent source changes do
  not replicate); Restart resumes (receipt: status before/after + ADF run state).

### T22 — Paired SQL analytics endpoint over the mirror (M7)
- **Goal:** Each mirrored DB auto-pairs a `synapse-serverless-sql-pool` item that
  exposes the Bronze Delta as external tables for T-SQL querying.
- **Files:** edit the mirrored-database provisioner to emit the paired item;
  register the type in `lib/items/registry.ts`; reuse `synapse-sql-client`.
- **Backend/REST:** Serverless `OPENROWSET`/external tables over the mirror's
  ABFS Bronze root; verify with `SELECT 1` + a real table query.
- **Bicep/portability:** Synapse serverless built-in pool present; UAMI Storage
  Blob Data Reader on the mirror container; suffix via `getSynapseSqlSuffix()`.
- **UI surface:** "SQL analytics endpoint" link on the mirror that opens the
  paired Serverless editor; tables visible.
- **Acceptance:** with Fabric UNSET, a mirror produces a queryable SQL endpoint;
  `SELECT TOP 10 *` over a mirrored table returns live rows from Delta (receipt:
  endpoint query result); cloud-matrix test passes for Comm + Gov suffixes.

---

## 5. Per-task Claude Code dev-loop

Run this loop **per task**. Do not open a PR until every gate is green for that
task. Iterate (code → validate → fix) until all pass.

1. **Plan / branch.** Read the source UI inventory (Learn + portal) and write/
   update `docs/fiab/parity/<surface>.md` with the feature rows this task covers.
   Branch off `main` (`feat/databases-T<n>-<slug>`).
2. **Code.** Implement backend client method(s) → BFF route (`{ok,data,error}` +
   HTTP codes) → UI surface. Resolve all hosts via `cloud-endpoints`. No mock
   arrays, no `return []`, no `useState(MOCK_*)`. Config via dropdowns/wizards
   only (raw text only in the SQL/NoSQL/Gremlin editors).
3. **Validate — typecheck + lint.** `pnpm -C apps/fiab-console tsc --noEmit` and
   `pnpm -C apps/fiab-console lint`. Zero errors.
4. **Validate — build.** `pnpm -C apps/fiab-console build` (the CI gap fixed in
   PR #656 — a build break must never reach deploy). Must succeed.
5. **Validate — unit/vitest.** Add/extend vitest for the new client + route +
   the cloud-matrix test (Commercial + ≥1 Gov suffix). `pnpm -C apps/fiab-console
   vitest run <files>`. Green. (Heed `fiab_console_vitest_harness_broken` —
   render tests may need `environment: jsdom` + setupFiles; if the harness can't
   render, fall back to logic/route tests and gate UI on the build.)
6. **Validate — real-data E2E.** With a minted session cookie and
   `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, hit the new endpoint against the live
   Commercial deployment. Capture the endpoint, the first ~300 chars of the real
   response body, and a Playwright screenshot/trace of the surface doing its
   primary action. This is the `no-vaporware.md` receipt.
7. **No-fabric audit.** Run the `no-fabric-dependency.md` greps; confirm zero
   default-path Fabric/Power BI gates and that every `fabricWorkspaceId` read has
   an Azure fallback in the same function.
8. **Docs.** Update `docs/fiab/parity/<surface>.md` (rows → ✅ or ⚠️ honest-gate,
   zero ❌ for the rows this task owns) and any affected `docs/fiab/prp/`
   scorecard / experience doc. Docs are source-of-truth per
   `docs_source_of_truth.md`; never bake clarifying questions into the product
   (`no_questions_in_product.md`).
9. **UAT.** `pnpm uat` (deep-functional spec) for the touched surface; add a spec
   if missing. Per `no_scaffold_claims.md`, do a side-by-side vs the real
   Azure/Fabric UI and click every control — DOM strings are not parity.
10. **PR.** Open the PR with the E2E receipt + bicep diff (if infra changed) in
    the body. Reviewers reject any PR without a receipt. Address review, re-run
    gates, merge. Live-verify on the deployed Console (admin RG) after roll.

If any gate fails, return to step 2 for that task. Tasks are independent; ship
them one at a time, each fully green.

---

## 6. Experience definition-of-done

The Databases experience is **done** only when ALL of the following hold:

1. **No-fabric default.** Every item type (SQL DB, Cosmos DB, mirrored DB) and
   every editor surface installs and functions with `LOOM_DEFAULT_FABRIC_WORKSPACE`
   UNSET. A missing Fabric/Power BI workspace is never a blocking remediation; the
   Azure-native backend is the silent default. The no-fabric greps return zero
   default-path hits.
2. **Parity tables clean.** Every row in §2 (S1–S22, C1–C9, M1–M8) is ✅ built or
   ⚠️ honest-gate — zero 🔶 stubs and zero ❌ missing. Each honest gate is a
   Fluent MessageBar `intent="warning"` naming the exact env var / role /
   resource and the editor still renders fully around it.
3. **Real backends everywhere.** Every control calls a real Azure backend — ARM
   for control plane, TDS for SQL data plane, Cosmos/Gremlin SDK for Cosmos, ADF
   CDC + ADLS Delta + Synapse Serverless for mirroring, Azure OpenAI for Copilot.
   No mock arrays, no `return []`, no `useState(MOCK_*)`.
4. **Cloud portability proven.** Every new host resolves through `cloud-endpoints`
   and has a passing cloud-matrix test for Commercial + at least one Gov suffix.
   SQL TDS, ARM, Cosmos, Gremlin, ADLS, Synapse, OpenAI, and Key Vault all switch
   correctly between `*.windows.net`/`*.azure.com` and `*.usgovcloudapi.net`/
   `*.azure.us`.
5. **UI one-for-one.** Each surface has a `docs/fiab/parity/<surface>.md` whose
   inventory rows are all built ✅ or honest-gate ⚠️ — zero ❌, zero stub banners.
   Layout/panels/tabs/workflow match the source Azure/Fabric UI; only the Fluent
   v9 + Loom theme differs. A side-by-side click-through confirms every control
   does what the source UI does.
6. **Bicep-synced.** Every new env var is in `apps[]` in `admin-plane/main.bicep`;
   every new role grant (SQL DB Contributor, Cosmos key-list, OpenAI User,
   Storage Blob Data Contributor/Reader, Monitoring Reader, KV get-secret) is in
   the relevant Bicep module; a clean
   `az deployment sub create -f platform/fiab/bicep/main.bicep` + bootstrap yields
   the same Databases feature set as the live deployment.
7. **Tested + documented.** tsc + lint + build + vitest (incl. cloud-matrix) green;
   `pnpm uat` green for every surface; each merged task carried a real-data E2E
   receipt; the parity docs, the prp scorecard, and the experience docs are
   updated. Target grade per `no-vaporware.md` rubric: **every surface A or A+**.
