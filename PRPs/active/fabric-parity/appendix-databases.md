# Fabric → CSA Loom Parity Appendix — Databases & Mirroring

**Domain:** Databases & Mirroring (operational databases + near-real-time replication into the lake)
**Author:** Parity Architect (Fabric → Loom)
**Date:** 2026-06-26
**Scope:** Fabric SQL database, Cosmos DB in Fabric, Mirrored databases (Azure SQL DB/MI, SQL Server, PostgreSQL, MySQL, Cosmos DB, Snowflake, Databricks Unity Catalog, BigQuery, Oracle, SAP, Dremio, Open mirroring), and mirroring monitoring/observability.

> **Governing rules:** `no-fabric-dependency.md` (Azure-native default, Fabric opt-in only), `no-vaporware.md` (real backend per control), `ui-parity.md` (1:1 feature parity), `web3-ui.md` + `loom_no_freeform_config` (wizards/dropdowns/canvas/Copilot — no hand-written config), dual-cloud Commercial + Government.

> **Sovereign-cloud headline (the strategic point):** Fabric mirroring — and Cosmos-DB-for-NoSQL mirroring in particular — is **explicitly unavailable in Azure Government and Azure China** ("Mirroring isn't available in sovereign clouds" — Learn). Loom's Azure-native default (ADF CDC / change-tracking / `_ts`-watermark / Debezium-OSS → ADLS Bronze Delta + Synapse Serverless SQL analytics endpoint) is therefore **the only way to get HTAP/mirroring in Gov at all**. Every gap below must ship a Gov path. This domain is where "no hard Fabric dependency" is not just a rule — it is the entire value proposition for sovereign customers.

---

## 1. Fabric capability inventory (grounded in Microsoft Learn)

### 1.A — Fabric SQL database (native OLTP)

Architecture: SQL database in Fabric is **Azure SQL Database engine** wrapped as a Fabric item. Creating one provisions (1) the SQL database (`.mdf`, read/write OLTP) and (2) a **SQL analytics endpoint**. Data is **automatically mirrored** to OneLake as **Delta/Parquet** in near-real-time using the same `changefeed` technology as Azure Synapse Link / Fabric mirroring — **no user action, no settings, all supported tables/columns mirrored on create**. The analytics endpoint is a read-only T-SQL surface over the Delta tables (zero perf impact on OLTP). Entra-ID-only auth. Intelligent perf on by default (automatic tuning/index). Source control (Git) integration. (`/fabric/database/sql/overview`, `/mirroring-overview`, `/sql-analytics-endpoint`)

| # | Capability | How it works |
|---|-----------|--------------|
| 1 | Create operational SQL database | Fabric item = Azure SQL DB engine; OLTP read/write |
| 2 | **Auto-mirror to OneLake (HTAP)** | On create, all tables continuously replicate to Delta/Parquet; near-real-time; landing zone holds snapshot+change data before verti-parquet convert (`/fabric/database/sql/faq`) |
| 3 | SQL analytics endpoint | Auto-generated read-only T-SQL surface over the Delta copy; views, TVFs, stored procs, permissions, cross-warehouse joins |
| 4 | Web query editor | Browser T-SQL editor in portal (`/query-editor`) |
| 5 | Native **vector** type + functions | `vector` data type, `VECTOR_DISTANCE`, `VECTOR_SEARCH` (ANN); embeddings stored in-DB (`/use-case-ai-application`) |
| 6 | RAG patterns | chunk→embed (AOAI)→store(vector col)→`VECTOR_DISTANCE`→augment→generate; `AI_GENERATE_EMBEDDINGS`, `sp_invoke_external_rest_endpoint` |
| 7 | Copilot in SQL database | NL→T-SQL generate/explain/optimize in the editor |
| 8 | API for GraphQL | Expose DB as GraphQL endpoint (`/fabric/database/sql` + Fabric API for GraphQL) |
| 9 | Start/stop mirroring API | `start-stop-mirroring-api`; DMVs `sys.dm_change_feed_log_scan_sessions`, `sys.dm_change_feed_errors` |
| 10 | Source control (Git) | Schema-as-code integration |
| 11 | Translytical/Reverse-ETL/ODS patterns | Same DB serves OLTP + analytics; GraphQL/TDS serving |

### 1.B — Cosmos DB in Fabric (native NoSQL)

Architecture: same engine/infra as **Azure Cosmos DB for NoSQL**, Fabric-integrated. AI-optimized, schemaless JSON, Entra-only (no keys), billed in CUs. **Every Cosmos DB in Fabric DB auto-mirrors to OneLake Delta** (no config) → SQL analytics endpoint (T-SQL, read-only). Native vector indexing (flat/quantized-flat/**DiskANN**) for vector search. Deep Fabric integration: notebooks, UDFs, GraphQL, data agents, Copilot. (`/fabric/database/cosmos-db/overview`, `/mirror-onelake`, `/index-vector-data`)

| # | Capability | How it works |
|---|-----------|--------------|
| 12 | Create native NoSQL DB + containers | Up to 25 containers; partition key; schemaless |
| 13 | NoSQL query editor | `New SQL Query` over containers; results grid |
| 14 | **Auto-mirror to OneLake** | Every DB mirrored to Delta automatically; SQL analytics endpoint exposes containers as warehouse tables; HTAP, no RU cost |
| 15 | Mirroring status pane | Last-sync metadata, replication status |
| 16 | Native vector index + search | DiskANN/quantized-flat/flat; vectors colocated in docs; `WHERE`+vector hybrid |
| 17 | Item-level roles | Read/ReadAll/Write mapped from workspace roles |
| 18 | Reverse-ETL / Spark connector / UDF serving | Low-latency serving layer |

### 1.C — External Mirrored databases (database mirroring)

Architecture: secure connection to source → replicator engine scans landing-zone change files at high frequency (changes published as fast as **every 15s**), merges into target Delta. Creates a Mirrored DB item + auto SQL analytics endpoint. `changefeed` user/schema created in source. Choose all-tables or subset; auto-mirror new tables. Vacuum/retention (`retentionInDays`, default 1 day post-Jun-2025). (`/fabric/mirroring/overview`)

Sources (Learn `Types of mirroring`):

| # | Source | Type | Notes |
|---|--------|------|-------|
| 19 | Azure SQL Database | DB mirroring | tier/purchasing reqs; SQL change-tracking |
| 20 | Azure SQL Managed Instance | DB mirroring | preview→GA |
| 21 | SQL Server 2016–2025 (on-prem/VM) | DB mirroring | txn-log scan (SQL 2025); via gateway |
| 22 | Azure Database for PostgreSQL flex | DB mirroring | `azure_cdc` functions; publication-based |
| 23 | **Azure Database for MySQL** (preview) | DB mirroring | binlog/`azure_cdc` |
| 24 | Azure Cosmos DB for NoSQL | DB mirroring | change-feed; **not in sovereign clouds** |
| 25 | Snowflake | DB mirroring | incl. Snowflake-managed Iceberg tables |
| 26 | **SAP** (Datasphere/HANA) | DB mirroring | partner |
| 27 | Google BigQuery (preview) | DB mirroring | project+dataset |
| 28 | Oracle | DB mirroring | LogMiner; gateway+sync user |
| 29 | **Dremio** (preview) | **metadata/catalog mirroring** | shortcut-based |

### 1.D — Metadata mirroring — Azure Databricks Unity Catalog

Architecture: **no data movement** — only catalog structure mirrored; underlying data via OneLake shortcuts. Item + Lakehouse SQL analytics endpoint. Inclusion/exclusion of catalogs/schemas/tables; auto-sync future catalog changes; OneLake security maps UC privileges. Two flows: Fabric-initiated (`+New > Mirrored Azure Databricks catalog`, GA) and Databricks-initiated (`Publish to OneLake`, preview). (`/fabric/mirroring/azure-databricks`)

| # | Capability |
|---|-----------|
| 30 | Mount UC catalog read-only; pick schemas/tables; auto-sync; OneLake security mapping |

### 1.E — Open mirroring (push model)

Architecture: any app writes change data (Parquet + `_metadata.json` keyColumns + `__rowMarker__` 0/1/2/4) into a per-mirror **landing zone** (OneLake ADLS Gen2 path); CDC-processing engine merges into Delta. 20-digit monotonic file names or `LastUpdateTimeFileDetection`+`isUpsertDefaultRowMarker`. Python SDK + partner ecosystem (e.g. MongoDB Atlas accelerator on App Service). (`/fabric/mirroring/open-mirroring`, `/open-mirroring-landing-zone-format`)

| # | Capability |
|---|-----------|
| 31 | Landing-zone URL + producer creds (MI/SAS/RBAC) |
| 32 | `_metadata.json` keyColumns + `__rowMarker__` upsert/delete semantics; sequential & nonsequential file detection |
| 33 | Replication status (rows/files/errors); Python SDK; partner accelerators |

### 1.F — Mirroring monitoring / observability

Architecture: **Monitor replication** pane (DB-level + per-table status: Running / Running-with-warning / Stopped / Failed / Paused / NotSupported; rows-replicated cumulative; last-completed). **Workspace monitoring** → `MirroredDatabaseTableExecution` KQL table (replication latency `ReplicatorBatchLatency`, failures, table changes) → Power BI / Real-Time Dashboards + alerts. Source-side troubleshooting DMVs/functions per connector. Direct Lake over mirrored data. (`/fabric/mirroring/monitor`, `/monitor-logs`)

| # | Capability |
|---|-----------|
| 34 | Monitor pane (DB+table status/rows/last-sync) |
| 35 | Workspace-monitoring operation logs (latency/failures) → KQL → dashboards + alerts |
| 36 | Delta maintenance / retention (vacuum, `retentionInDays`, time travel) |
| 37 | Direct Lake reporting over mirror |

---

## 2. Loom coverage map (built / stubbed / missing)

Legend: ✅ built & wired to real backend · ⚠️ partial/honest-gate · ❌ missing.

| Fabric capability | Loom surface | Status |
|---|---|---|
| Fabric SQL database — operational CRUD/query/schema/admin | `unified-sql-database-editor.tsx` over real Azure SQL DB/MI/PostgreSQL (ARM+TDS); Connect/Provision/Query/Schema/Server-admin/Catalog tabs | ✅ |
| **SQL DB → auto-mirror to OneLake + SQL analytics endpoint (HTAP)** | *separate manual `mirrored-database` item only*; no one-click "enable analytics" on the SQL editor itself | ❌ **G1** |
| SQL DB native vector type / `VECTOR_DISTANCE`/`VECTOR_SEARCH` + RAG assist | `vector-store.md` parity exists (Cosmos/AI Search angle); not surfaced as an AI/Vector tab on the SQL editor | ⚠️ **G6** |
| Copilot in SQL DB (NL→T-SQL) | `azure-sql-copilot.md` parity doc; cross-item Copilot present | ⚠️ verify-built |
| SQL DB API for GraphQL | `data-api-builder-editor.tsx` (DAB WYSIWYG → REST+GraphQL) + `graphql-api` item | ✅ |
| SQL DB source control (Git schema) | not surfaced for the DB item | ❌ **G10** |
| Cosmos DB native (operational data-explorer studio) | `cosmos-account-editor.tsx` — full Data Explorer studio over real Azure Cosmos DB (data-plane query/CRUD/RU, scale, scripts) | ✅ |
| **Cosmos DB → auto-mirror to OneLake + SQL analytics endpoint (HTAP)** | mirror exists as separate `CosmosDb` source w/ `_ts` watermark; not one-click from the Cosmos editor | ❌ **G2** |
| Cosmos native vector (DiskANN) | partial via Azure Graph+Vector / AI Search | ⚠️ |
| Mirrored DB — source picker (10 sources) | `mirror-source-wizard.tsx`: Azure SQL DB/MI, PostgreSQL, Cosmos, Snowflake, BigQuery, Oracle, SQL Server 2025, Open-mirroring | ✅ |
| Mirrored DB — **MySQL source** | not in picker | ❌ **G3** |
| Mirrored DB — **SAP source** | not in picker | ❌ **G7** |
| Mirrored DB — **Dremio (metadata mirroring)** | not present | ❌ **G7** |
| Mirrored DB — create/connect (KV creds)/test/table-pick/start/monitor/lifecycle | `mirrored-database-editor.tsx` + `mirrored-database.ts` provisioner (ADF CDC→Bronze Delta default; built-in TDS/PG/Cosmos snapshot engine) | ✅ |
| Mirrored DB — paired SQL analytics endpoint | auto Synapse Serverless SQL pairing over Bronze | ✅ |
| Mirrored Databricks Unity Catalog (metadata mirroring) | `mirrored-databricks-editor.tsx` (mount UC, pull metadata, pair SQL endpoint, OneLake security) | ✅ |
| Open mirroring (push) | `open-mirror-config.tsx` + `mirror-engine.runOpenMirrorMerge` (landing→Spark merge→Delta; `__rowMarker__`/keyColumns; schedule) | ✅ |
| Open mirroring — nonsequential `LastUpdateTimeFileDetection`/SDK/accelerators | sequential path built; nonseq option + Python SDK/accelerator missing | ⚠️ **G9** |
| Monitor pane (per-table status/rows/landing/last-sync + ADF run telemetry) | Monitor tab in mirror editor; 30s auto-refresh | ✅ |
| **Workspace-monitoring observability (latency logs → dashboard + alerts)** | no historical latency logs / Log-Analytics+ADX feed / monitoring dashboard / alert rules | ❌ **G4** |
| **Delta maintenance / retention (vacuum, retentionInDays, time travel) on mirror** | `delta-maintenance.md` exists for lakehouse; not surfaced on the mirror's Bronze Delta | ❌ **G5** |
| SQL analytics endpoint authoring depth (views/TVFs/sprocs/perms/visual query/save-as-view) | via paired Synapse Serverless editor (partial) | ⚠️ **G8** |

**Overall loomStatus: PARTIAL.** External database mirroring + open mirroring + Databricks metadata mirroring + the operational Cosmos/SQL surfaces are **strong and real**. The *signature Fabric HTAP behaviors* (SQL-DB and Cosmos auto-mirror as one item), **observability**, **MySQL/SAP/Dremio sources**, **vector/AI tab**, and **Delta maintenance** are gaps.

---

## 3. Gap build specs

Each gap: architecture-in-words · Web-5.0 UI · BFF APIs · Azure services · bicep/day-one · Commercial vs Government · acceptance.

### G1 — Fabric SQL database HTAP: one-click "Analytics (OneLake)" auto-mirror + SQL analytics endpoint  · P0

**Architecture.** Add an **Analytics** tab to `unified-sql-database-editor.tsx`. On enable (default-ON when a DB is bound), Loom auto-provisions the existing Azure-native mirror path **for the bound Azure SQL DB**: ADF CDC (or SQL change-tracking engine) → ADLS Bronze Delta, then the registry pairing rule auto-creates a Synapse Serverless SQL analytics endpoint over the Bronze. Reuses `mirrored-database.ts::provisionAdfCdc` + `synapse-serverless-sql-pool.ts` pairing — no new engine, just a one-item UX that makes the manual mirror automatic (the Fabric experience). Surfaces: replication status badge, last-sync, "Open SQL analytics endpoint", retention control (→G5).

**Web-5.0 UI.** Analytics tab: a styled `MessageBar` "Analytics replication ON" + status `Badge`; a **table include/exclude picker** (reuse wizard grid) defaulting to all tables; a read-only landing/Delta path card; "Open SQL analytics endpoint" button. No free-form config — toggles + dropdowns (sync mode `snapshot|incremental|continuous`, retention days).

**BFF APIs.** `POST /api/items/sql-database/[id]/analytics` `{enabled, tables[], syncMode, retentionDays}` → invokes mirror provisioner bound to the SQL DB; `GET …/analytics` → status (reuse `/monitor` shape); `GET …/sql-endpoint` (already exists for mirror) generalized.

**Azure services.** ADF (CDC/copy), ADLS Gen2 Bronze, Synapse Serverless SQL. Real Azure SQL DB as source. No Fabric.

**Day-one / bicep.** ADF factory + managed VNet + IR (already in `landing-zone`), Bronze container, Synapse Serverless workspace — all deployed day-one. Console UAMI: Data Factory Contributor + Storage Blob Data Contributor (existing). New env: none (reuse `LOOM_ADF_*`, `LOOM_BRONZE_*`). Day-one default: analytics ON for bound DBs; user can disable per item.

**Commercial vs Government.** Identical — ADF/ADLS/Synapse all in Gov (`.us` endpoints; `resolveAbfssRoot` already sovereign-aware). This is the **only** HTAP path in Gov (Fabric SQL DB absent). Gov: private-only (managed VNet IR + private endpoints), IL4/5 storage.

**Acceptance.** With `LOOM_DEFAULT_FABRIC_WORKSPACE` unset: bind an Azure SQL DB → Analytics tab shows replication Running → rows land as Bronze Delta → SQL analytics endpoint returns `SELECT` over a mirrored table. Receipt: ADF run id + ABFS Delta listing + serverless query rows.

### G2 — Cosmos DB HTAP: "Enable analytics (OneLake)" from the Cosmos editor · P0

**Architecture.** Add an **Analytics** action/tab to `cosmos-account-editor.tsx` that provisions a `CosmosDb`-source mirror (existing `_ts`-watermark change-feed engine → Bronze Delta) + paired Synapse Serverless SQL endpoint, scoped to selected containers. Mirrors Fabric Cosmos-DB auto-mirror, **but works in Gov** where Fabric Cosmos mirroring is explicitly unavailable.

**Web-5.0 UI.** Container multi-select (from the existing Cosmos tree) → schedule dropdown (`15min/1h/4h/daily`) → "Enable analytics". Status card with per-container rows/last-sync. "Open SQL analytics endpoint".

**BFF APIs.** `POST /api/items/cosmos-db/[id]/analytics` `{containers[], schedule}` → mirror provisioner (Cosmos source); `GET …/analytics` status (reuse monitor). Uses real Cosmos change-feed (`c._ts > @since`).

**Azure services.** Azure Cosmos DB (continuous backup recommended), ADLS Bronze, Synapse Serverless. No RU-free Fabric trick — disclose RU cost of change-feed reads honestly.

**Day-one / bicep.** Existing Bronze + Synapse + Console UAMI Cosmos Data Reader. Default-ON optional per account.

**Commercial vs Government.** Cosmos + ADLS + Synapse all in Gov. **Gov differentiator:** Fabric Cosmos mirroring is sovereign-cloud-blocked; Loom delivers it natively. Schema-inference (JSON→columnar) handled by Spark merge.

**Acceptance.** Unset Fabric ws: enable analytics on a Cosmos container → docs land as Bronze Delta → serverless `SELECT` returns container rows.

### G3 — Azure Database for MySQL mirroring source · P0

**Architecture.** Add `AzureMySql` source card to `mirror-source-wizard.tsx` + engine branch in `mirror-engine.ts`: **default** = watermark-incremental on a monotonic column (mirrors PG path) via mysql2 wire; **OSS option** = Debezium MySQL connector (binlog CDC) on ACA → landing → Spark merge; **opt-in Fabric** = `azure_cdc`/binlog GenericMirror. Insert/update fidelity; delete via Debezium for full CDC.

**Web-5.0 UI.** Source card (MySQL accent `#00758f`); step-2 host/db fields; table picker; sync-mode dropdown; incremental-column auto-detect with override dropdown.

**BFF APIs.** `/api/items/mirrored-database/verify` + `/source-tables` extended for `AzureMySql` (real mysql2 probe). Start dispatches MySQL engine.

**Azure services.** Azure Database for MySQL Flexible Server, ADLS Bronze, Synapse Serverless; (OSS) ACA-hosted Debezium + Kafka-less file sink.

**Day-one / bicep.** New env `LOOM_MIRROR_MYSQL_LINKED_SERVICE` (ADF copy option). Debezium ACA job module optional, deployed day-one when OSS CDC selected. KV secretRef for creds.

**Commercial vs Government.** MySQL Flexible Server GA in Gov; Debezium OSS runs in Gov on ACA/AKS. Identical wiring.

**Acceptance.** Mirror an Azure MySQL table → rows in Bronze Delta → serverless query returns them.

### G4 — Mirroring observability parity (latency logs → dashboard + alerts) · P1

**Architecture.** Mirror engine + ADF runs emit structured events to **Log Analytics** (custom table `LoomMirrorExecution_CL`: mirrorId, table, status, rowsReplicated, batchLatencyMs, error) and/or **ADX** (`MirroredDatabaseTableExecution`-shaped table) — the Azure-native equivalent of Fabric workspace monitoring. A **Real-Time Dashboard** tile (reuse `kql-dashboard`) queries latency/throughput; **Azure Monitor scheduled-query alert** fires on Failed/latency-breach (reuse `activator`/`monitor-client`).

**Web-5.0 UI.** Monitor tab gains a **latency/throughput chart** (real chart, not table) + "History" sub-tab querying the LA/ADX table; an "Alerts" card → create a scheduled-query alert via dropdown thresholds.

**BFF APIs.** `GET /api/items/mirrored-database/[id]/monitor/history` (KQL over LA/ADX); `POST …/monitor/alerts` (create Monitor alert rule).

**Azure services.** Log Analytics workspace + ADX cluster (both day-one in Loom), Azure Monitor alerts.

**Day-one / bicep.** LA workspace + ADX exist; add DCR/custom-table for mirror events; Console UAMI Monitoring Contributor (already granted per memory). Default-ON logging.

**Commercial vs Government.** LA + ADX + Monitor all in Gov (`.us`). Identical.

**Acceptance.** Run a mirror → latency rows appear in `LoomMirrorExecution_CL` → dashboard tile renders → induce a failure → alert fires.

### G5 — Delta maintenance / retention tab on the mirror (vacuum, retentionInDays, time travel) · P1

**Architecture.** Add a **Maintenance** tab (reuse `delta-maintenance.md` machinery) acting on the mirror's Bronze Delta: scheduled `VACUUM` (retentionInDays), `OPTIMIZE`+V-Order, and time-travel query helper. Runs as a Synapse Spark batch (same Livy path as open-mirror merge).

**Web-5.0 UI.** Retention-days slider/dropdown (default 1 day, Fabric-parity); "Run OPTIMIZE/VACUUM now" buttons; time-travel `VERSION AS OF`/`TIMESTAMP AS OF` picker generating a serverless query.

**BFF APIs.** `POST /api/items/mirrored-database/[id]/maintenance` `{op:'vacuum'|'optimize', retentionDays}`; `GET` last-run.

**Azure services.** Synapse Spark, ADLS Bronze Delta.

**Day-one / bicep.** Existing Synapse + Bronze. Default retention 1 day; user-adjustable.

**Commercial vs Government.** Identical (Synapse + ADLS in Gov).

**Acceptance.** Set retention → run VACUUM → old Parquet removed (file count drops); time-travel query returns a prior version.

### G6 — Native vector / AI tab on SQL database (+ RAG assist) · P1

**Architecture.** **AI / Vector** tab on `unified-sql-database-editor.tsx`: declare `vector(n)` columns (Azure SQL DB vector type, GA/preview), a **RAG-pipeline Copilot builder** (chunk→embed via Azure OpenAI `AI_GENERATE_EMBEDDINGS`/`sp_invoke_external_rest_endpoint`→store→`VECTOR_DISTANCE`/`VECTOR_SEARCH` retrieve), and a similarity-search query helper. Wraps the real TDS path.

**Web-5.0 UI.** Vector-column wizard (table/dim/distance-metric dropdowns); RAG builder canvas (source → chunk size → embed model dropdown → target table); "Generate T-SQL" emitting real `VECTOR_DISTANCE` queries (the one allowed freeform = the SQL expression surface).

**BFF APIs.** `/api/items/azure-sql-database/[id]/query` (exists) for vector DDL/DML; `POST …/vector/embed-config` to wire AOAI external REST endpoint.

**Azure services.** Azure SQL DB (vector type), Azure OpenAI (embeddings), KV for AOAI key.

**Day-one / bicep.** AOAI embeddings deployment (day-one in Loom); `sp_invoke_external_rest_endpoint` external-endpoint allowlist; KV secretRef.

**Commercial vs Government.** Vector type works in Gov Azure SQL; **Gov AOAI** (text-embedding-3) in Gov regions — name the Gov AOAI endpoint/model; if absent, OSS substitute = self-hosted embedding model (e.g. bge) on ACA called via external REST.

**Acceptance.** Create vector column → embed sample rows → `VECTOR_SEARCH` returns ranked neighbors.

### G7 — SAP + Dremio mirroring sources · P2

**Architecture.** **SAP**: source card → ADF SAP CDC connector (SAP HANA / Datasphere) → Bronze Delta (default); Fabric SAP mirroring opt-in. **Dremio**: **metadata/catalog mirroring** — mirror catalog structure via OneLake-shortcut-equivalent: register Dremio catalog as external tables over its underlying storage with no data movement (Loom shortcut model → ADLS Gen2 shortcuts / Synapse external tables).

**Web-5.0 UI.** Two source cards; SAP = host/system/client + gateway fields; Dremio = endpoint + catalog inclusion/exclusion tree (metadata, not data).

**BFF APIs.** verify/source-tables extended; Dremio uses metadata-only path (no Bronze copy) → Synapse external-table registration.

**Azure services.** ADF SAP CDC, self-hosted IR (gateway), ADLS, Synapse Serverless external tables.

**Day-one / bicep.** SHIR scale-to-zero module (exists); env for SAP/Dremio linked services.

**Commercial vs Government.** SAP CDC + SHIR run in Gov; Dremio is customer-hosted (Gov-deployable). Identical.

**Acceptance.** SAP table → Bronze Delta; Dremio catalog → queryable external tables with no data copy.

### G8 — SQL analytics endpoint authoring depth on mirror · P2

**Architecture.** Ensure the paired Synapse Serverless editor exposes the full Fabric SQL-analytics-endpoint surface over the mirror: create **views / inline TVFs / stored procs**, **manage object permissions**, **visual (no-code) query** with **save-as-view**, cross-pool joins. Mostly wiring the existing serverless editor's authoring features onto the mirror's paired DB.

**Web-5.0 UI.** Reuse `synapse-serverless-sql-editor.tsx` object tree + add visual-query builder + save-as-view dialog.

**BFF APIs.** existing serverless `/query` (DDL for views/sprocs/perms over TDS).

**Acceptance.** From the mirror, create a view + a stored proc; visual query → save as view → reappears in tree.

### G9 — Open mirroring: nonsequential detection + Python SDK/accelerator · P2

**Architecture.** Add `_metadata.json` `fileDetectionStrategy: LastUpdateTimeFileDetection` + `isUpsertDefaultRowMarker` options to `OpenMirrorConfig`; ship a downloadable **Loom Open-Mirror producer SDK** (Python, ADLS Gen2 API, 20-digit/timestamp file naming) + a MongoDB-Atlas-style accelerator sample (ACA app).

**Web-5.0 UI.** File-detection dropdown (sequential / last-update-time); upsert-default toggle; "Download producer SDK" button.

**Acceptance.** Drop nonsequential timestamped files → merge applies upserts in timestamp order.

### G10 — SQL database source control (Git schema-as-code) · P2

**Architecture.** Export DB schema (DACPAC/SQL scripts) to the repo + import/apply — mirrors Fabric SQL DB Git integration. Reuse existing Git-integration plumbing.

**Acceptance.** Export schema → commit → modify → apply diff to DB.

---

## 4. Cross-cutting Gov posture (summary)

- **Fabric mirroring + Cosmos mirroring are sovereign-blocked** → Loom's Azure-native default is the only HTAP path in Gov. Lead with this.
- All backing services (Azure SQL DB/MI, PostgreSQL/MySQL Flex, Cosmos NoSQL, ADF + managed VNet IR, ADLS Gen2, Synapse Serverless, Log Analytics, ADX, Azure Monitor) are **GA in Azure Government** with `.us` endpoints; `resolveAbfssRoot`/clients already sovereign-aware.
- OSS substitutes where a managed/Fabric piece is absent in Gov: **Debezium** (MySQL/Postgres binlog CDC) on ACA/AKS; **OSS embedding model** (bge) on ACA for vector when Gov AOAI embeddings model is unavailable; **customer-hosted Dremio**; OSS Unity Catalog metastore on AKS+Postgres if Databricks UC managed metastore is constrained.
- Private-only networking (managed VNet IR + private endpoints), IL4/5 storage, Entra-only auth on all paths.

## 5. Sources (Microsoft Learn)

- /fabric/database/sql/overview · /mirroring-overview · /sql-analytics-endpoint · /faq · /use-case-ai-application · /use-case-reverse-etl · /use-case-translytical-applications · /query-editor · /start-stop-mirroring-api
- /fabric/database/cosmos-db/overview · /mirror-onelake · /quickstart-portal · /faq · /authorization · /how-to-use-spark-notebooks
- /fabric/mirroring/overview · /azure-sql-database(+tutorial) · /azure-sql-managed-instance(+tutorial) · /sql-server · /azure-database-postgresql(+tutorial) · /azure-database-mysql · /azure-cosmos-db(+tutorial) · /snowflake · /google-bigquery · /oracle · /sap · /catalog-mirroring/dremio · /azure-databricks(+tutorial) · /open-mirroring · /open-mirroring-tutorial · /open-mirroring-landing-zone-format · /monitor · /monitor-logs · /troubleshooting · /mirrored-database-rest-api
- /azure/postgresql/integration/concepts-fabric-mirroring · /cosmos-db/index-vector-data · /cosmos-db/modeling-data · /azure/databricks/partners/bi/fabric(-publish/-mirror) · /azure/architecture/example-scenario/analytics/sync-mongodb-atlas-fabric-analytics · /fabric/onelake/onelake-apis-in-action
- /sql/t-sql/data-types/vector-data-type · /functions/vector-distance-transact-sql · /functions/vector-search-transact-sql · /sql/sql-server/fabric-database/fabric-mirrored-databases
