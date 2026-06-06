# PRP — Data Engineering (Lakehouse + Spark) at full Microsoft-Fabric parity, Azure-native

> **Status:** Implementation-ready.
> **Owner experience:** CSA Loom › Data Engineering (Lakehouse + Spark).
> **Parity target:** Microsoft Fabric "Data Engineering" workload — Lakehouse, SQL
> analytics endpoint, Notebooks, Spark Job Definitions, Environments, Delta
> maintenance, schemas, shortcuts.
> **Hard rule:** Per `.claude/rules/no-fabric-dependency.md`, **every feature in
> this PRP must be 100% functional on Azure-native backends by default, with a
> real Microsoft Fabric capacity / workspace UNSET.** Fabric is opt-in only.
> Per `.claude/rules/no-vaporware.md`, **no stubs, no mock arrays, no
> `return []` placeholders** — each task lands real backend calls or an honest
> infra-gate MessageBar.
> Per `.claude/rules/ui-parity.md`, each surface gets a parity doc and must
> match the source UI one-for-one (theme differs, functionality does not).

---

## 1. Overview + Azure-native + OSS architecture (all 4 cloud types)

### 1.1 What this experience is

Microsoft Fabric's Data Engineering workload centers on the **Lakehouse** — a
Delta-Lake table store with a OneLake folder structure (`Tables/`, `Files/`),
an auto-provisioned **SQL analytics endpoint**, **Spark notebooks**, **Spark
Job Definitions**, and **Environments** (managed Spark runtime + libraries).
CSA Loom rebuilds this 1:1 on Azure + OSS, with **no dependency on a real
Fabric capacity, OneLake, or Power BI workspace**.

### 1.2 Azure-native + OSS backing services

| Concern | Azure-native DEFAULT | OSS component | Loom client / module |
|---|---|---|---|
| Table & file store | **ADLS Gen2 (hierarchical namespace)** + Delta format | Delta Lake OSS (`delta-spark`, `delta-standalone`) | `adls-client` |
| SQL analytics endpoint | **Synapse Serverless SQL pool** (`OPENROWSET`/external tables over Delta) | — | `synapse-sql-client` |
| Spark compute | **Synapse Spark pool** (default) or **Azure Databricks** (opt-in) | Apache Spark 3.5 | `synapse-dev-client`, `databricks-client` |
| Schema / table catalog | Synapse Spark catalog (`spark.catalog.*`) + lake database | **Apache Hive Metastore** or **Unity Catalog OSS** | `synapse-catalog-client` |
| Notebook execution | **Synapse Spark livy sessions** / Databricks jobs | Jupyter/Livy protocol | `synapse-livy-client` |
| Sensitivity labels | **Microsoft Purview Information Protection** (MIP SDK) | — | `purview-mip-client` |
| Governance / scan | **Microsoft Purview** Data Map (classic) | Apache Atlas (concepts) | `purview-client` |
| Orchestration (Get data) | **Synapse pipelines / ADF** | — | `synapse-dev-client`, `adf-client` |
| Identity / RBAC | **Entra ID + Azure RBAC** (Storage Blob Data roles) | — | `arm-client`, `rbac-client` |
| Secrets for shortcuts | **Azure Key Vault** (secretRef) | — | `keyvault-client` |

There is **no OneLake global namespace** in Azure. Loom maintains its own
namespace abstraction over one-or-more ADLS Gen2 accounts (the lakehouse item's
`storageAccount` + `container` + `rootPath`). All "OneLake virtual path"
display strings are translated from real ABFS (`abfss://<container>@<account>.dfs.<suffix>/...`).

### 1.3 Cloud portability matrix (the 4 cloud types)

| Backend | Commercial | GCC | GCC-High | DoD IL5 / IL6 | Endpoint difference |
|---|---|---|---|---|---|
| ADLS Gen2 (HNS) | GA | GA | GA | GA (FedRAMP High) | `dfs.core.windows.net` vs `dfs.core.usgovcloudapi.net`; **21Vianet/China uses Blob+HNS** |
| Synapse Serverless SQL | GA | GA | GA | GA (verify SKU/region in IL6) | `.azuresynapse.net` vs `.sql.azuresynapse.usgovcloudapi.net` |
| Synapse Spark pool | GA | GA | GA | GA | same split |
| Azure Databricks (opt-in) | GA | GA | GA (Gov) | partial — verify region | `azuredatabricks.net` vs `databricks.azure.us` |
| Purview MIP labels | GA | GA (M365 tenant) | tenant-dependent | tenant-dependent | label defs sync from M365 Gov tenant |
| Key Vault | GA | GA | GA | GA | `vault.azure.net` vs `vault.usgovcloudapi.net` |

**Implication for code:** every host must be resolved via the existing
`cloud-endpoints` helper (`getDfsSuffix()`, `getSynapseSqlSuffix()`,
`getKeyVaultSuffix()`), **never hard-coded**. Any new client added by a task
below MUST route through that helper and be covered by a cloud-matrix unit test.

### 1.4 Item-type topology in Loom

```
lakehouse (item)                    ← ADLS Gen2 container + lake DB
 ├─ paired: synapse-serverless-sql-pool (1:1 auto-created)   ← SQL analytics endpoint
 ├─ Tables/  (managed Delta)        ← Synapse Spark catalog + _delta_log
 └─ Files/   (unmanaged)            ← ADLS Gen2 paths
synapse-notebook (item)             ← Livy session on Synapse Spark pool
spark-job-definition (item)         ← Synapse Spark batch job
spark-environment (item)            ← Synapse Spark pool config + library set
```

---

## 2. Feature-by-feature parity table

Legend — **Status:** ✅ built · ⚠️ honest-gate (renders, partial backend, MessageBar) · 🔶 stub · ❌ missing.

| # | Fabric feature | Azure-native backend | Loom UI | Portability | Status today | Work needed |
|---|---|---|---|---|---|---|
| F1 | Lakehouse Creation | ADLS Gen2 HNS container + Synapse lake DB + Serverless SQL endpoint; ARM/Bicep | Creation dialog: name (alnum+`_`, ≤123), RG/location picker, sensitivity-label dropdown (Purview), Schemas toggle → `Tables/`+`Files/` | ADLS+Synapse all clouds | ✅ built | none (verify label dropdown wired to Purview, not static) |
| F2 | Explorer — Tables pane | ADLS data-plane list + Synapse `spark.catalog.listTables` + `_delta_log` reader | Left tree: schema nodes (`dbo`+user), tables, Delta vs non-Delta icons, context menu, sort/filter/search | ADLS all; Synapse Comm+Gov | ⚠️ honest-gate (reads bundle `deltaTables`, no live catalog) | **T2** real catalog scan |
| F3 | Explorer — Table Preview (DataGrid) | Synapse Serverless `SELECT TOP N` / Spark read; column stats via Spark | Canvas DataGrid: sort, filter, resize, multi-select, copy-as-CSV, cell preview, column-summary card; Table/File toggle; deep-link | Synapse Comm+Gov | ⚠️ honest-gate (text-only preview) | **T3** Fluent DataGrid + stats |
| F4 | Explorer — Files pane | ADLS data-plane List Paths / Get Properties | Folder tree; inline preview (img/Monaco/CSV grid); folder context menu; sort/filter/search | ADLS all | ✅ built | CSV inline grid (**T3**), DnD folder upload (**T6**) |
| F5 | Explorer — File Upload/Download | ADLS Put Block/Flush; MIP label stamp on download | Upload dialog (multi + folder), progress, cancel; download stream; RBAC check | ADLS all; MIP Comm+GCC | ✅ built | folder DnD + MIP stamp (**T6**) |
| F6 | Explorer — Load to Table | Synapse Spark `DeltaTable` write (CSV/Parquet→Delta) | "Get data"→Load-to-table wizard; format detect; job tracked in Monitor | Spark Comm+Gov | ❌ missing | **T8** load-to-table wizard + Spark job |
| F7 | Explorer — Ribbon actions | mixed (see per-action) | Refresh; **Get data** dropdown; **Analyze data** dropdown; New semantic model; Settings; Share; gray-out on reference LH | n/a | 🔶 stub (Files/Query/Manage only) | **T7** full ribbon menus |
| F8 | Explorer — Reference Lakehouses | ADLS pass-through RBAC over multiple containers | "Add lakehouse" picker; expand refs (Tables/Files); primary bolded; write disabled on refs | ADLS all | ⚠️ honest-gate (shortcuts only) | **T9** multi-LH federation |
| F9 | Lakehouse Schemas | Spark catalog namespaces / sub-dirs; `ALTER TABLE SET SCHEMA` | Schema nodes; New schema; drag-table-to-schema; 4-part namespace queries; schema shortcuts | Spark Comm+Gov | ❌ missing | **T10** schema CRUD + move |
| F10 | Lakehouse Multitasking | client-only (tab state) | Browser-tab item model; background load continues; per-LH toasts; a11y | n/a | ⚠️ partial (workspace tabs exist) | **T11** background-job continuity + toasts |
| F11 | Shortcuts (internal/external) | shortcut metadata → ADLS/S3/GCS/Dataverse; KV secretRef | Shortcut wizard, CRUD, test, broken-status, retry | ADLS all; S3/GCS cross-cloud | ✅ built | Delta Sharing + broken/retry (**T12**) |
| F12 | Settings (Spark pool, Delta config) | item state + Synapse pool ref | Settings dialog: pool, sparkConfig, timeTravelDays, autoOptimize, liquid clustering | Comm+Gov | ✅ built | liquid clustering UI; V-Order/Autotune as documented Fabric-only gate (**T13**) |
| F13 | Permissions (Azure RBAC + SQL grants) | RBAC role assignments; Synapse SQL `GRANT` | Permissions dialog; +table/column/row-level security | Comm+Gov | ✅ built (RBAC) | table/col/row security (**T14**) |
| F14 | SQL analytics endpoint — T-SQL editor | Synapse Serverless SQL pool (`OPENROWSET`, external tables) | Monaco SQL editor, run, result grid, IntelliSense, view/proc/UDF CRUD | Synapse Comm+Gov | ✅ built (basic) | dedicated paired item + IntelliSense + objects (**T15**) |
| F15 | Spark Notebook — authoring | Synapse notebook artifact | Cell editor (code/markdown), language picker, outline, params | Comm+Gov | ⚠️ partial (no cell exec) | **T16** notebook authoring parity |
| F16 | Spark Notebook — per-cell execution | Synapse Livy session (interactive) / Databricks | Run cell / run all; live output stream; session lifecycle; `%%sql`/`%%pyspark` magics; `display(df)` rich output | Comm+Gov | ❌ missing | **T17** Livy interactive exec |
| F17 | Spark Job Definition | Synapse Spark batch job (main file + args + refs) | SJD editor: main definition, args, ref files, pool, submit, runs history | Comm+Gov | 🔶 stub | **T18** SJD editor + submit |
| F18 | Environments (Spark runtime + libraries) | Synapse Spark pool config + library mgmt (pip/conda/jar) | Environment editor: runtime ver, compute, public/custom libs, Spark props; publish | Comm+Gov | ❌ missing | **T19** environment lifecycle |
| F19 | Delta maintenance (OPTIMIZE/VACUUM/Z-order) | Spark `OPTIMIZE`, `VACUUM`, `ZORDER BY` | Table "Maintenance" dialog: compaction, vacuum retention, z-order cols; job tracked | Comm+Gov | ❌ missing | **T20** maintenance dialog + job |
| F20 | Table history / time travel | Delta `DESCRIBE HISTORY` / `VERSION AS OF` | History tab: versions, ops, restore, preview-as-of | Comm+Gov | ❌ missing | **T21** history + restore |
| F21 | Notebook Copilot / code-assist | Loom Copilot build-assist backend | Inline cell suggest, NL→PySpark/SQL, explain | Comm+Gov | ❌ missing | **T22** notebook copilot edges |
| F22 | V-Order / Fast-Optimize / native exec | n/a (Fabric-only acceleration) | honest-gate toggle w/ MessageBar: "Fabric-only; Azure path uses standard Delta OPTIMIZE" | n/a | ❌ missing | covered by **T13** (documented gate) |

---

## 3. Azure / OSS services — full feature set + native UI surfaces to rebuild 1:1

For each backing service, the team must **inventory the real UI first**
(per `ui-parity.md`, grounded in Microsoft Learn via `microsoft_docs_search` /
`microsoft_docs_fetch`), then build it one-for-one.

### 3.1 ADLS Gen2 (hierarchical namespace)
- **Capabilities:** filesystem (container) CRUD; directory create/rename/delete
  (atomic with HNS); file Put Block / Flush / Get; List Paths (recursive,
  paged); ACL + Azure RBAC (Storage Blob Data Owner/Contributor/Reader);
  metadata & last-modified; SAS / Entra token auth.
- **Portal surfaces to mirror:** Storage browser (folder tree + file table),
  upload/download, ACL editor, properties panel.
- **Loom mapping:** Files pane (F4/F5), Tables `_delta_log` access (F2/F3).

### 3.2 Synapse Serverless SQL pool
- **Capabilities:** `OPENROWSET` over Delta/Parquet/CSV; external tables &
  data sources; views, procs, UDFs; `INFORMATION_SCHEMA`; `GRANT/DENY`;
  result-set size limits; cost-per-TB.
- **Portal surfaces:** Synapse Studio SQL script editor (Monaco), results grid,
  Messages, "Connect to" dropdown, object explorer.
- **Loom mapping:** SQL analytics endpoint editor (F14), table preview (F3),
  table catalog counts (F2), SQL-level grants (F13).

### 3.3 Synapse Spark pool + Livy
- **Capabilities:** interactive Livy sessions; batch jobs; `spark.catalog.*`;
  Delta read/write; `OPTIMIZE`/`VACUUM`/`ZORDER`; `DESCRIBE HISTORY`;
  pool autoscale + auto-pause; session config (executors, cores, conf).
- **Portal surfaces:** Synapse Studio notebook (cells, run, Spark UI link,
  session manager), Spark job definition editor, Apache Spark applications
  monitor, pool config blade.
- **Loom mapping:** Notebook authoring + exec (F15/F16), SJD (F17),
  Environments (F18), maintenance (F19), history (F20), load-to-table (F6).

### 3.4 Microsoft Purview (Information Protection + Data Map)
- **Capabilities:** sensitivity-label taxonomy; MIP SDK label stamping on file
  bytes (Office/PDF); auto-labeling policy; classic Data Map scan/lineage.
- **Loom mapping:** label dropdown at creation (F1), MIP stamp on download
  (F5), governance lineage (cross-experience).

### 3.5 OSS — Delta Lake / Hive Metastore / Unity Catalog OSS
- **Delta Lake:** transaction log (`_delta_log`) — derive table status
  (`healthy`/`loading`/`broken`), version history, schema, file list.
- **HMS / Unity Catalog OSS:** schema/table namespace hierarchy when Synapse
  lake DB is not used (alternative catalog).
- **Loom mapping:** table status & history derivation (F2/F20), schema model
  (F9).

---

## 4. Sequenced TASK LIST

Each task is an independently shippable unit. **No stubs, no mock data, no
`return []`.** Each lands real backend calls or an honest infra-gate MessageBar
naming the exact env var / role / resource. Every task ends with a real-data E2E
receipt (per `no-vaporware.md`) and a parity-doc row update (per `ui-parity.md`).

Common conventions:
- BFF routes return `{ ok: boolean, data?, error? }` with correct HTTP codes.
- New hosts resolved via `cloud-endpoints` helper; covered by cloud-matrix test.
- New env vars added to `apps[]` in `admin-plane/main.bicep`; new role grants
  added to the relevant Bicep module; new clients route through managed identity.

---

### T1 — Foundation: pair `synapse-serverless-sql-pool` item 1:1 with lakehouse
- **Goal:** Every lakehouse auto-creates/links a paired SQL-analytics-endpoint
  item so F3/F14 share one Serverless SQL endpoint.
- **Files:** create `apps/fiab-console/lib/install/provisioners/synapse-serverless-sql-pool.ts`;
  edit lakehouse provisioner to emit the paired item; edit
  `apps/fiab-console/lib/items/registry.ts` to register the type.
- **Backend/REST:** `synapse-sql-client` — create external data source pointing
  at the lakehouse ABFS root; verify endpoint via `SELECT 1`.
- **Bicep/portability:** ensure Synapse workspace + serverless built-in pool in
  `platform/fiab/bicep/modules/landing-zone/synapse.bicep`; endpoint suffix via
  `getSynapseSqlSuffix()`.
- **UI surface:** none new (plumbing); endpoint visible in F14.
- **Acceptance:** with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, creating a
  lakehouse produces a linked SQL endpoint item; `SELECT 1` returns a live row
  in the receipt; cloud-matrix test passes for Commercial + Gov suffixes.

### T2 — Live Tables catalog (`/api/lakehouse/tables`)
- **Goal:** Replace the bundle-only stub with a real Synapse Spark + `_delta_log`
  catalog scan, grouped by schema, with status/row-count/size.
- **Files:** rewrite `apps/fiab-console/app/api/lakehouse/tables/route.ts`;
  edit `lib/editors/lakehouse-editor.tsx` (lines ~951-966) to consume live data;
  add `lib/azure/synapse-catalog-client.ts`.
- **Backend/REST:** `spark.catalog.listTables` (Livy short session) **or**
  Serverless `INFORMATION_SCHEMA`; row counts via `SELECT COUNT(*)`; status via
  `delta-standalone` `_delta_log` read; size via ADLS path aggregate.
- **Bicep/portability:** Synapse Spark pool present; managed identity granted
  Storage Blob Data Reader on the lakehouse container (add to `synapse-storage-rbac.bicep`).
- **UI surface:** left Tables tree — schema nodes + tables + Delta/non-Delta
  icons + loading/broken badges.
- **Acceptance:** against a lakehouse with ≥1 real Delta table and Fabric UNSET,
  endpoint returns real table names + true row counts + status; empty lakehouse
  returns honest `[]` with no fabricated rows; receipt shows live response body.

### T3 — Fluent DataGrid table preview + column-summary stats (F3)
- **Goal:** Replace text preview with a Fluent `DataGrid`: sortable columns,
  filter, resize, multi-select, copy-as-CSV, cell preview, column-summary card;
  Table/File toggle; deep-link.
- **Files:** edit `lib/editors/lakehouse-editor.tsx` (~607-619); add
  `lib/editors/components/delta-preview-grid.tsx`; add
  `app/api/lakehouse/table-stats/route.ts`.
- **Backend/REST:** preview rows from existing `/api/lakehouse/preview`
  (structured `rows[]`/`columns[]`); stats via Spark `summary` job
  (min/max/mean/stddev/distribution) through `synapse-livy-client`.
- **Bicep/portability:** none beyond T2.
- **UI surface:** canvas DataGrid + summary card + Table/File toggle +
  Copy-URL.
- **Acceptance:** real Delta/Parquet/CSV preview renders in DataGrid; Ctrl+C
  copies selection as CSV; column-summary shows real Spark-computed stats (loading
  indicator during async job); deep-link reopens same table.

### T6 — File upload folder DnD + MIP label on download (F5)
- **Goal:** Drag-and-drop folder upload; MIP sensitivity-label stamp on
  supported downloads.
- **Files:** edit `lib/editors/lakehouse-editor.tsx` (Files ribbon/upload);
  edit `app/api/lakehouse/upload/route.ts`; add
  `lib/azure/purview-mip-client.ts`; edit `app/api/lakehouse/download/route.ts`.
- **Backend/REST:** ADLS Put Block/Flush with `webkitdirectory` paths; MIP SDK
  (backend proxy) stamps label for Office/PDF.
- **Bicep/portability:** Console UAMI granted Purview IP reader; env
  `LOOM_PURVIEW_ACCOUNT`; MIP only Comm+GCC — IL5/IL6 shows honest-gate
  MessageBar when M365 Gov label defs absent.
- **UI surface:** drop zone + per-file progress; download keeps label.
- **Acceptance:** folder upload preserves tree in ADLS; Office file download is
  stamped with the chosen label (verified by reopening file metadata); where MIP
  unavailable, download still works and a warning MessageBar names the gap.

### T7 — Ribbon: Get data + Analyze data + Settings/Share menus (F7)
- **Goal:** Full ribbon: Refresh; **Get data** (Upload, New shortcut, New
  dataflow, New pipeline, New notebook, Copy activity); **Analyze data**
  (SQL endpoint, New notebook, Existing notebook); New semantic model
  (honest-gate); Settings; Share; gray-out on reference LH.
- **Files:** edit `lib/editors/lakehouse-editor.tsx` (~875-891); add menu
  components.
- **Backend/REST:** menu items deep-link to existing editors (ADF designer,
  notebook, paired SQL endpoint) — each must navigate to a real surface, not a
  toast.
- **Bicep/portability:** none.
- **UI surface:** Fluent `Menu`/`Toolbar` ribbon.
- **Acceptance:** every menu item opens its real target surface; New semantic
  model shows documented honest-gate MessageBar (no Azure-native 1:1); items
  gray out when a non-primary reference lakehouse is selected.

### T8 — Load to Table wizard (F6)
- **Goal:** No-code load of CSV/Parquet/JSON from `Files/` into managed Delta
  tables via Spark.
- **Files:** add `lib/editors/components/load-to-table-wizard.tsx`; add
  `app/api/lakehouse/load-to-table/route.ts`.
- **Backend/REST:** `synapse-livy-client` submits PySpark
  `spark.read.<fmt>().write.format('delta').mode(...).saveAsTable(...)`;
  job tracked in Monitor.
- **Bicep/portability:** Spark pool; Storage Blob Data Contributor for UAMI.
- **UI surface:** wizard (source file → table name/schema → mode
  append/overwrite → run) + job toast linking to Monitor.
- **Acceptance:** loading a real CSV creates a queryable Delta table appearing
  in T2's catalog; job shows in Monitor; receipt includes Livy job id + row
  count.

### T9 — Reference Lakehouses federation (F8)
- **Goal:** Add multiple lakehouses to the explorer; browse/preview across all;
  primary bolded; writes disabled on references.
- **Files:** edit `lib/editors/lakehouse-editor.tsx` (left panel, ~237-379);
  add `app/api/lakehouse/references/route.ts`.
- **Backend/REST:** list in-workspace lakehouses (Cosmos items); read ops via
  pass-through RBAC (UAMI must hold Reader on referenced containers).
- **Bicep/portability:** none (RBAC at runtime).
- **UI surface:** "Add lakehouse" picker; expandable ref nodes (Tables/Files);
  primary visually distinguished; write actions disabled with tooltip.
- **Acceptance:** 3+ lakehouses browsable side-by-side; preview works against a
  referenced LH; write actions disabled on references; primary remains bold.

### T10 — Lakehouse Schemas CRUD + move table (F9)
- **Goal:** Multi-schema support: `dbo` default (immutable), create schema,
  drag-table-to-schema, 4-part namespace queries, schema shortcuts.
- **Files:** edit `lib/editors/lakehouse-editor.tsx` (Tables tree); add
  `app/api/lakehouse/schemas/route.ts`.
- **Backend/REST:** Spark SQL `CREATE SCHEMA`, `ALTER TABLE ... SET SCHEMA`
  (orchestrate via Livy when atomic op absent); namespace
  `workspace.lakehouse.schema.table`.
- **Bicep/portability:** Spark pool; schemas-enabled flag on lakehouse item.
- **UI surface:** schema nodes; "New schema" dialog (name = letters/numbers/`_`);
  drag-drop table → schema; schema shortcut entry.
- **Acceptance:** new schema appears in T2 catalog; moving a table updates its
  namespace and it remains queryable via 4-part name; `dbo` cannot be renamed/
  deleted.

### T11 — Multitasking: background-job continuity + per-LH toasts (F10)
- **Goal:** Switching item tabs does not cancel running uploads/loads; toasts
  identify the source lakehouse; a11y (screen reader, alt text, keyboard nav).
- **Files:** edit `lib/state/jobs-store.ts` (or add); edit
  `lib/editors/lakehouse-editor.tsx`; edit shared toast provider.
- **Backend/REST:** existing upload/load jobs; poll status independent of active
  tab.
- **Bicep/portability:** none.
- **UI surface:** background job tracker; per-LH labeled toasts.
- **Acceptance:** start an upload, switch tabs, return — upload completed without
  interruption; toast names the originating lakehouse; keyboard-only walk of the
  explorer passes.

### T12 — Shortcuts: Delta Sharing + broken-status + retry (F11)
- **Goal:** Cross-tenant Delta Sharing; broken-shortcut indicator; retry UI.
- **Files:** edit `app/api/lakehouse/shortcuts/route.ts`; edit
  `lib/editors/lakehouse-editor.tsx` (shortcut list).
- **Backend/REST:** Delta Sharing protocol client; auth-failure detection on
  test; KV secretRef resolve.
- **Bicep/portability:** KV access for UAMI; S3/GCS cross-cloud creds via KV.
- **UI surface:** "Broken" badge; "Retry" action; Delta Sharing source type in
  wizard.
- **Acceptance:** a shortcut to a Delta Sharing endpoint resolves real data; an
  auth-broken shortcut shows the badge and retry restores it after fixing the KV
  secret; tested against a real external source.

### T13 — Settings: liquid clustering + Fabric-only acceleration gates (F12/F22)
- **Goal:** Liquid clustering column config; V-Order/Autotune/native-exec shown
  as honest-gate (Fabric-only) with explanatory MessageBar.
- **Files:** edit `lib/editors/lakehouse-editor.tsx` (Settings dialog);
  edit `app/api/lakehouse/settings/route.ts`.
- **Backend/REST:** liquid clustering via Spark `ALTER TABLE ... CLUSTER BY`;
  V-Order toggle persists but displays Fabric-only note.
- **Bicep/portability:** none.
- **UI surface:** clustering column picker; warning MessageBars for Fabric-only
  toggles.
- **Acceptance:** setting clustering columns issues a real `CLUSTER BY`;
  V-Order/Autotune render with `intent="warning"` MessageBar stating Azure path
  uses standard Delta OPTIMIZE; sparkConfig validates common typos with hints.

### T14 — Permissions: table/column/row-level security (F13)
- **Goal:** Beyond container RBAC — Synapse SQL `GRANT SELECT` on tables/columns
  and row-level security via security predicate/view.
- **Files:** edit `lib/editors/lakehouse-editor.tsx` (Permissions dialog);
  edit `app/api/lakehouse/permissions/route.ts`.
- **Backend/REST:** `synapse-sql-client` `GRANT`/`DENY`; RLS via
  `CREATE SECURITY POLICY` or filtering view.
- **Bicep/portability:** none.
- **UI surface:** tabs — Object (RBAC) | Table | Column | Row; principal
  resolves to UPN (not OID).
- **Acceptance:** granting column-level SELECT restricts a real test query;
  RLS hides rows for the constrained principal; principals display UPN.

### T15 — SQL analytics endpoint editor: IntelliSense + view/proc/UDF CRUD (F14)
- **Goal:** Promote SQL tab to the paired item (T1); add column IntelliSense
  from `INFORMATION_SCHEMA`; create/alter views, stored procs, UDFs.
- **Files:** add `lib/editors/synapse-serverless-sql-editor.tsx`; edit
  `app/api/items/synapse-serverless-sql-pool/[id]/query/route.ts`;
  add object-explorer component.
- **Backend/REST:** Serverless SQL execute; `INFORMATION_SCHEMA` completion
  source; DDL for views/procs/UDFs.
- **Bicep/portability:** Serverless built-in pool; suffix via helper.
- **UI surface:** Monaco SQL + object explorer + Messages + result grid +
  Connect-to.
- **Acceptance:** IntelliSense suggests real columns; creating a view persists
  and is queryable; T-SQL error surfaces in Messages; result-size limit handled.

### T16 — Spark Notebook authoring parity (F15)
- **Goal:** Full cell-based authoring: code/markdown cells, language picker
  (`pyspark`/`sql`/`scala`/`sparkr`), cell reorder, outline, parameters cell,
  attach environment/pool.
- **Files:** edit `lib/editors/synapse-notebook-editor.tsx`; add cell components;
  edit notebook item schema.
- **Backend/REST:** persist notebook artifact (Cosmos + ADLS); pool/env binding
  from `/api/loom/compute-targets`.
- **Bicep/portability:** none.
- **UI surface:** cell list, toolbar, outline panel, attach dropdown.
- **Acceptance:** author multi-cell notebook with mixed languages; save/reload
  preserves cells & order; parameters cell recognized; attaches to a real pool.

### T17 — Notebook per-cell interactive execution via Livy (F16)
- **Goal:** Run cell / run all against a live Synapse Spark Livy session with
  streamed output, magics (`%%sql`, `%%pyspark`, `%%configure`), and rich
  `display(df)` output.
- **Files:** add `lib/azure/synapse-livy-client.ts`; add
  `app/api/notebook/[id]/session/route.ts` + `.../execute/route.ts`;
  edit `lib/editors/synapse-notebook-editor.tsx`.
- **Backend/REST:** Livy create session, submit statement, poll, stream stdout/
  result; session lifecycle (idle timeout, kill).
- **Bicep/portability:** Spark pool; UAMI granted Synapse Spark submit role;
  env `LOOM_SYNAPSE_WORKSPACE`; suffix via helper. Databricks opt-in via
  `LOOM_NOTEBOOK_BACKEND=databricks`.
- **UI surface:** Run/Run-all, per-cell spinner + streamed output, session
  status pill, DataFrame rich table.
- **Acceptance:** with Fabric UNSET, running a `display(spark.range(5))` cell
  returns a live rendered table from a real Livy session; `%%sql` executes
  against the lakehouse; session reused across cells; receipt shows Livy
  statement output.

### T18 — Spark Job Definition editor + submit (F17)
- **Goal:** Replace stub with full SJD: main definition file, command-line args,
  reference files/py/jar, pool/env, submit + runs-history.
- **Files:** add `lib/editors/spark-job-definition-editor.tsx`; add
  `app/api/spark-job-definition/[id]/submit/route.ts` + `.../runs/route.ts`;
  register item type.
- **Backend/REST:** Synapse Spark batch job submit (`/livy/batches` or Synapse
  REST `sparkJobDefinitions`); runs list + logs.
- **Bicep/portability:** Spark pool; submit role for UAMI.
- **UI surface:** definition form, args, ref-file picker (from `Files/`), pool/
  env dropdown, Submit, runs grid with status/logs.
- **Acceptance:** submitting a real PySpark main file produces a running batch
  job; runs grid shows live status transitioning to Succeeded; logs viewable.

### T19 — Environments lifecycle (F18)
- **Goal:** New item type `spark-environment`: runtime version, compute config,
  public libraries (pip/conda), custom libraries (whl/jar upload), Spark
  properties; publish; attach to notebooks/SJDs.
- **Files:** add `lib/editors/spark-environment-editor.tsx`; add
  `app/api/spark-environment/[id]/{libraries,publish}/route.ts`; register type.
- **Backend/REST:** Synapse pool config + library management (upload to ADLS,
  apply to pool); publish = bake into pool/session config.
- **Bicep/portability:** Spark pool; ADLS path for custom libs.
- **UI surface:** tabs — Runtime | Compute | Public libraries | Custom libraries
  | Spark properties; Publish button + status.
- **Acceptance:** create env, add a pip package + a custom whl, publish; a
  notebook attached to the env imports the package successfully in a live cell
  (ties to T17); receipt shows the package importable.

### T20 — Delta maintenance dialog (OPTIMIZE/VACUUM/Z-order) (F19)
- **Goal:** Table-level "Maintenance" action: compaction, vacuum retention,
  z-order columns; job tracked in Monitor.
- **Files:** add `lib/editors/components/delta-maintenance-dialog.tsx`; add
  `app/api/lakehouse/maintenance/route.ts`.
- **Backend/REST:** Livy submits `OPTIMIZE`/`VACUUM`/`ZORDER BY`.
- **Bicep/portability:** Spark pool; UAMI Storage Blob Data Contributor.
- **UI surface:** dialog (compaction toggle, vacuum retention hours, z-order col
  picker) + Run + job toast.
- **Acceptance:** running OPTIMIZE compacts a real table (file count drops,
  verified via T3 File view); VACUUM honors retention; job in Monitor; receipt
  shows job result.

### T21 — Table history / time travel (F20)
- **Goal:** History tab per table: versions, operations, restore, preview
  `VERSION AS OF`.
- **Files:** edit `lib/editors/lakehouse-editor.tsx` (table view tabs); add
  `app/api/lakehouse/history/route.ts`.
- **Backend/REST:** Delta `DESCRIBE HISTORY`; `RESTORE TABLE ... TO VERSION`;
  preview via `SELECT ... VERSION AS OF`.
- **Bicep/portability:** Spark pool.
- **UI surface:** history grid (version, timestamp, operation, metrics),
  Restore, Preview-as-of.
- **Acceptance:** history lists real Delta versions; preview-as-of returns the
  historical row set; restore reverts the table (verified by row count change);
  receipt shows version list.

### T22 — Notebook Copilot edges (F21)
- **Goal:** Inline cell code-assist: NL→PySpark/SQL, explain-cell,
  fix-error, all via Loom Copilot build-assist backend (no Fabric Copilot).
- **Files:** edit `lib/editors/synapse-notebook-editor.tsx`; add
  `app/api/notebook/[id]/assist/route.ts`.
- **Backend/REST:** Loom Copilot agent (existing build-assist) grounded in the
  lakehouse schema (from T2) + cell context.
- **Bicep/portability:** AI Foundry project env already provisioned; no new
  Fabric dep.
- **UI surface:** inline suggest, "Explain", "Fix" affordances per cell.
- **Acceptance:** NL prompt "count rows in bronze.orders" yields runnable
  PySpark that executes via T17 and returns the real count; explain returns a
  real grounded description.

---

## 5. Claude Code DEV-LOOP per task

Run this loop **per task**, iterating until acceptance criteria pass with **zero
stubs/placeholders/mocks**. Use an isolated worktree (`EnterWorktree`) per task
so parallel tasks don't corrupt `node_modules` (per the pnpm-worktree memory).

```
┌── 1. CODING AGENT ────────────────────────────────────────────────┐
│ - Read parity rules + the task's files. Inventory the real Azure / │
│   Synapse / Fabric UI via microsoft_docs_search/fetch FIRST.       │
│ - Implement BFF route (real backend call) + client + UI surface.   │
│ - Add env var to admin-plane/main.bicep + role grant to the module │
│   + cloud-endpoints suffix usage. No return []/mock/useState(MOCK).│
│ - Commit on a task branch.                                         │
└────────────────────────────────────────────────────────────────────┘
            │  hand off
┌── 2. VALIDATION / TEST AGENT ─────────────────────────────────────┐
│ - tsc:  pnpm --filter fiab-console exec tsc --noEmit               │
│ - build: pnpm --filter fiab-console build  (CI never ran this —    │
│          it is REQUIRED here per csa_loom_ci_gaps memory)          │
│ - unit: pnpm --filter fiab-console vitest run <task spec>          │
│         (gate render tests on build per vitest-harness memory)     │
│ - cloud-matrix test for any new host (Comm + Gov suffixes).        │
│ - REAL-DATA E2E: mint session cookie, hit the new /api/... route   │
│   with Fabric UNSET, capture first 300 chars of the live response. │
│ - grep guard: no (return \[\]|return \{\}|MOCK_|SAMPLE_|TODO|      │
│   useState\(\[\{) in touched files.                                │
│ - On FAIL → revert task to coding agent with the failing output.   │
└────────────────────────────────────────────────────────────────────┘
            │  pass
┌── 3. DOCS AGENT ──────────────────────────────────────────────────┐
│ - Update docs/fiab/parity/<slug>.md: inventory row → built ✅ /    │
│   honest-gate ⚠️ + backend-per-control column.                    │
│ - Update this PRP's status column for the feature row.            │
│ - Update relevant docs site page (docs = source of truth, BLOCKING)│
│ - No clarifying questions / side-convo baked into product docs.   │
└────────────────────────────────────────────────────────────────────┘
            │
┌── 4. UAT AGENT ───────────────────────────────────────────────────┐
│ - pnpm uat (deep-functional spec) for the surface.                │
│ - Playwright (or claude-in-chrome): click EVERY control on the    │
│   surface; confirm each does what its label says (DOM strings ≠    │
│   parity). Side-by-side vs the real Azure/Fabric UI.              │
│ - Capture screenshot/trace into the PR receipt.                   │
│ - On any ❌ or stub banner → back to coding agent.                 │
└────────────────────────────────────────────────────────────────────┘
            │  all green
        OPEN PR (with real-data E2E receipt + bicep diff + screenshot)
```

**Iteration rule:** a task is not "done" until agents 2 + 4 both pass with the
acceptance criteria verbatim, Fabric workspace UNSET, and the PR carries the
no-vaporware receipt. Reviewers reject any PR missing the receipt.

---

## 6. Definition of Done (whole experience)

The Data Engineering (Lakehouse + Spark) experience is **done** when:

1. **Every parity row (F1–F22)** in §2 is **built ✅ or honest-gate ⚠️** —
   **zero 🔶 stubs, zero ❌ missing, zero empty tabs, zero disabled-with-tooltip
   shortcuts.**
2. **Fabric-free:** with `LOOM_DEFAULT_FABRIC_WORKSPACE` and all
   `LOOM_<ITEM>_BACKEND=fabric` UNSET, the entire experience installs and every
   editor executes its primary action against real Azure backends (ADLS Gen2,
   Synapse Serverless SQL, Synapse Spark/Livy, Purview). No call to
   `api.fabric.microsoft.com` / `api.powerbi.com` / `onelake.dfs.fabric` on any
   default path.
3. **No vaporware:** `grep -rE "(return \[\]|return \{\}|useState\(\[\{|MOCK_|SAMPLE_|TODO|FIXME)"`
   over the touched editors + API routes returns no candidate violations; every
   BFF route calls a real backend or returns an honest-gate MessageBar naming
   the exact env var / role / resource.
4. **All 4 clouds:** every new host resolves via `cloud-endpoints`; cloud-matrix
   tests pass for Commercial + GCC + GCC-High + DoD IL5/IL6 suffixes; honest
   MessageBars cover services not yet in a given sovereign cloud (e.g. MIP in
   IL6, ADLS→Blob+HNS in 21Vianet).
5. **Bicep-synced:** `az deployment sub create -f platform/fiab/bicep/main.bicep
   -p params/commercial-full.bicepparam` + the bootstrap workflow deploys every
   resource, env var, role grant, and Cosmos container these tasks add — running
   feature set == deployed feature set (no drift).
6. **Parity docs:** every surface has a `docs/fiab/parity/<slug>.md` with zero ❌
   rows and a backend-per-control column; the docs site reflects the feature set.
7. **Tested:** each task carries vitest + real-data E2E + Playwright UAT
   evidence; `pnpm uat` green for the experience; quarterly teardown +
   one-button redeploy in a clean Commercial **and** Gov sub renders + executes
   every editor's primary action — target grade **A / A+** per the rubric.
