# Feature Mapping — Databricks to Microsoft Fabric (Complete)

**Status:** Authored 2026-04-30
**Audience:** Platform engineers, data architects, and migration leads who need a line-by-line mapping of Databricks capabilities to Fabric equivalents.
**Scope:** 60 features across compute, storage, governance, ML, streaming, orchestration, SQL, DevOps, and security.

---

## How to read this document

Each feature is mapped with:

- **Databricks capability** -- what it does and how it works on Databricks
- **Fabric equivalent** -- the closest Fabric feature or workaround
- **Parity level** -- Full, Partial, Gap, or Better (Fabric exceeds Databricks)
- **Migration notes** -- what to watch for during migration

Parity levels:

| Level | Meaning |
| --- | --- |
| **Full** | Fabric provides equivalent or identical capability |
| **Partial** | Fabric covers most use cases but has specific gaps |
| **Gap** | No direct Fabric equivalent; workaround or external service required |
| **Better** | Fabric provides a materially better experience for this capability |

For features marked Partial or Gap, consult the dedicated migration guide linked in each section for workaround details and code examples.

---

## 1. Compute

Databricks compute is cluster-based: you provision VMs, configure autoscaling, choose a runtime version, and optionally enable Photon. Fabric Spark is fully serverless -- there are no clusters to manage. Sessions start on demand and consume Capacity Units (CU) from a shared pool.

This is the most significant paradigm shift in the migration. Teams accustomed to tuning cluster sizes, spot instance ratios, and init scripts will find Fabric's hands-off model simpler but less configurable.

| # | Databricks feature | Fabric equivalent | Parity | Migration notes |
| --- | --- | --- | --- | --- |
| 1 | **All-Purpose Clusters** (interactive Spark) | Fabric Spark session (notebook-attached) | Partial | No persistent cluster; session starts per notebook. Startup is ~30-60s. No Photon. |
| 2 | **Jobs Clusters** (ephemeral, scheduled) | Fabric Spark job definition | Full | Submit PySpark/Scala jobs via Data Pipeline. CU-based billing replaces DBU + VM. |
| 3 | **Photon** (C++ vectorized engine) | None (OSS Spark only) | Gap | Photon-dependent queries may be 2-5x slower on Fabric Spark. Benchmark before migration. See [benchmarks.md](benchmarks.md) for measurements. |
| 4 | **Serverless Compute** (Databricks-managed VMs) | Fabric Spark (always serverless) | Better | All Fabric Spark is serverless -- zero cluster management. Simpler ops model. |
| 5 | **GPU Clusters** (ML training) | None on Fabric Spark | Gap | Use Azure ML compute for GPU workloads. See [ml-migration.md](ml-migration.md). |
| 6 | **Cluster Policies** (governance guardrails) | Fabric capacity admin settings | Partial | Control max CU consumption and auto-pause behavior, but less granular than per-cluster policies (no VM family restrictions, no tag enforcement). |
| 7 | **Instance Pools** (pre-warmed VMs) | Not applicable | N/A | Fabric Spark is serverless; no VM pool concept needed. Sessions start in 30-60s without pre-warming. |
| 8 | **Init Scripts** (cluster startup customization) | Fabric environment + `%pip install` | Partial | No arbitrary bash init scripts. System-level packages (e.g., apt-get, custom JDK) are not installable. Use Fabric environments for Python/R library management. |

**Key takeaway:** For compute, the main gaps are Photon (performance) and GPU (ML training). If your workloads do not depend on either, Fabric's serverless model is an upgrade.

---

## 2. Notebooks and development

Databricks notebooks and Fabric notebooks are conceptually similar: multi-language, cell-based, Spark-attached. The migration is straightforward for PySpark and SQL cells. The main friction points are Scala (not supported in Fabric), dbutils (replaced by mssparkutils), and Databricks Connect (no direct equivalent).

| # | Databricks feature | Fabric equivalent | Parity | Migration notes |
| --- | --- | --- | --- | --- |
| 9 | **Databricks Notebooks** (multi-language) | Fabric Notebooks (PySpark, Spark SQL, R) | Full | Similar experience. Fabric notebooks support PySpark, SQL, R. No Scala support in Fabric notebooks. |
| 10 | **%sql magic command** | SQL cell type (cell language selector) | Full | Create a SQL cell instead of using the %sql prefix. Syntax is identical. |
| 11 | **%python, %r, %scala** magic commands | Cell language selector (dropdown) | Partial | PySpark and R are supported. Scala is **not** available in Fabric notebooks. Rewrite Scala cells in PySpark before migration. |
| 12 | **dbutils.fs** (file system utilities) | `mssparkutils.fs` | Full | Direct API equivalent. `mssparkutils.fs.ls()`, `.cp()`, `.rm()`, `.head()`, `.mkdirs()`, `.mv()`, `.put()`. |
| 13 | **dbutils.secrets** (secret management) | `mssparkutils.credentials` + Azure Key Vault | Full | `mssparkutils.credentials.getSecret("vault-name", "secret-name")`. Requires Key Vault linked to workspace. |
| 14 | **dbutils.widgets** (parameterized notebooks) | `mssparkutils.notebook.getParam()` + pipeline parameters | Full | Pass parameters from Data Pipeline notebook activity or `mssparkutils.notebook.run()`. |
| 15 | **dbutils.notebook.run()** (notebook orchestration) | `mssparkutils.notebook.run()` | Full | Same pattern: call child notebooks with parameters and receive exit values. Can also use Data Pipelines for multi-notebook orchestration. |
| 16 | **Databricks Connect** (remote Spark from IDE) | Fabric REST API + Lakehouse JDBC/ODBC + VS Code for Fabric (preview) | Partial | No direct Spark Connect equivalent that lets a local Python process submit Spark jobs to a remote cluster. Use Fabric REST API for job submission, JDBC/ODBC for SQL, or VS Code for Fabric for notebook editing. See [notebook-migration.md](notebook-migration.md). |
| 17 | **Repos** (Git integration) | Fabric Git integration (Azure DevOps, GitHub) | Full | Fabric workspaces sync with Git repos. Items are serialized as JSON/definition files in Git. |
| 18 | **Databricks Assistant** (AI code help) | Copilot in Fabric notebooks | Full | Both provide AI-assisted code generation, explanation, and debugging in notebooks. |

**Key takeaway:** Notebooks are the easiest migration surface. 8 of 10 features have Full parity. The two exceptions are Scala (rewrite) and Databricks Connect (use alternatives).

---

## 3. SQL analytics

Databricks SQL (DBSQL) is a SQL-first query service backed by Photon-optimized warehouses. Fabric's equivalent is the Lakehouse SQL endpoint (always-on, read-only SQL over Delta tables) plus Power BI for dashboarding. For most BI query patterns, Fabric with Direct Lake is faster and cheaper than DBSQL.

| # | Databricks feature | Fabric equivalent | Parity | Migration notes |
| --- | --- | --- | --- | --- |
| 19 | **Databricks SQL Warehouse** (DBSQL) | Fabric Lakehouse SQL endpoint | Better | SQL endpoint is always-on within capacity -- no warehouse to start, no cold-start delay. Read-only; writes go through Spark/Pipelines. |
| 20 | **DBSQL Dashboard** | Power BI (native in Fabric) | Better | Power BI is a full BI platform vs DBSQL's simple SQL dashboard. Richer visuals, sharing, RLS, and embedding. |
| 21 | **DBSQL Alerts** | Data Activator (event-driven triggers) | Full | Data Activator monitors data conditions and triggers Teams notifications, pipelines, or emails. Richer trigger types than DBSQL alerts. |
| 22 | **DBSQL Query History** | Fabric monitoring hub + Capacity Metrics app | Full | Query-level monitoring available in the Fabric admin portal. Historical usage tracked in the Capacity Metrics app. |
| 23 | **Parameterized Queries** (DBSQL) | Power BI slicers + Lakehouse SQL parameters | Full | Different mechanism (visual slicers instead of SQL parameters) but achieves the same interactive filtering outcome. |
| 24 | **Query Federation** (DBSQL to external DBs) | Fabric shortcuts + mirroring | Partial | Shortcuts cover ADLS, S3, GCS, Dataverse. Mirroring covers Azure SQL, Cosmos DB, Snowflake. No arbitrary JDBC/ODBC federation to external databases. |

**Key takeaway:** SQL analytics is a Fabric strength. The always-on SQL endpoint and native Power BI integration make this the highest-ROI migration target.

---

## 4. Data engineering and orchestration

Databricks data engineering centers on notebooks, DLT pipelines, Workflows, and Auto Loader. Fabric's equivalent is a combination of Data Pipelines (ADF v2), Spark notebooks, and dbt-fabric. The paradigm shifts from "declarative DLT" to "dbt + pipeline orchestration" -- a well-understood pattern in the analytics engineering community.

| # | Databricks feature | Fabric equivalent | Parity | Migration notes |
| --- | --- | --- | --- | --- |
| 25 | **Delta Live Tables (DLT)** | Fabric Data Pipelines + dbt-fabric | Partial | No declarative DLT equivalent in Fabric. Use Data Pipelines for orchestration and dbt for SQL transformations. See [dlt-migration.md](dlt-migration.md) for detailed conversion patterns. |
| 26 | **DLT Expectations** (data quality rules) | dbt tests + Great Expectations | Partial | dbt tests provide `warn`, `error`, and `store_failures` behaviors matching DLT's `expect`, `expect_or_drop`, and `expect_or_fail`. Setup is manual rather than declarative. |
| 27 | **DLT Materialized Views** | Lakehouse tables refreshed by dbt or notebook | Full | Write results to Lakehouse tables on a schedule. dbt `materialized='table'` provides the same outcome. |
| 28 | **Databricks Workflows** (multi-task job orchestration) | Fabric Data Pipelines | Full | ADF-based orchestration with Fabric-specific activities (notebook, Spark job, copy, dataflow). Richer DAG support than Workflows, with visual designer. |
| 29 | **Auto Loader** (incremental file ingestion with schema evolution) | Fabric Data Pipelines (copy activity + event trigger) or Spark file streaming | Partial | Data Pipelines can trigger on new files via Storage Events. Spark readStream on files also works. Neither provides Auto Loader's automatic schema inference and evolution. See [streaming-migration.md](streaming-migration.md). |
| 30 | **Delta table OPTIMIZE / VACUUM** | Fabric auto-optimization (V-Order compaction) | Better | Fabric Lakehouse auto-compacts files and applies V-Order during write. No manual OPTIMIZE needed. VACUUM is available for explicit cleanup. |
| 31 | **Delta table CLONE** (shallow/deep copy) | Fabric shortcut (shallow) or table copy (deep) | Partial | Shortcuts provide zero-copy reference (similar to shallow clone). No direct CLONE SQL command; use `CREATE TABLE AS SELECT` for deep copy. |
| 32 | **Unity Catalog volumes** (managed file storage) | OneLake Files section in Lakehouse | Full | Lakehouse Files section stores unstructured files (CSV, JSON, images, etc.) alongside managed Delta tables. Accessible via mssparkutils.fs. |

**Key takeaway:** DLT migration is the most complex area. Plan 2-10 days per DLT pipeline to convert to dbt + Data Pipeline. Auto Loader replacement requires careful evaluation of your file ingestion patterns.

---

## 5. Storage and data lake

This is an area where Fabric has a structural advantage. OneLake is a tenant-wide, unified data lake that every Fabric workspace writes to automatically. Databricks storage is more fragmented across DBFS, external locations, Unity Catalog volumes, and cloud storage mounts.

| # | Databricks feature | Fabric equivalent | Parity | Migration notes |
| --- | --- | --- | --- | --- |
| 33 | **DBFS** (Databricks File System) | OneLake | Better | OneLake is tenant-wide (not workspace-scoped), with a single hierarchical namespace. All Fabric items (Lakehouses, Warehouses, etc.) write to OneLake automatically. |
| 34 | **External Locations** (UC-registered cloud storage) | OneLake shortcuts | Better | Shortcuts present external data (ADLS Gen2, S3, GCS, Dataverse) as native Lakehouse tables/files without copying. No `CREATE EXTERNAL LOCATION` ceremony or storage credentials to manage. |
| 35 | **Delta Lake** (open table format) | Delta Lake (same format) | Full | Fabric reads and writes Delta natively. Same Parquet files + `_delta_log` transaction log. Tables are interoperable between Databricks and Fabric. |
| 36 | **Delta Sharing** (cross-organization data sharing) | OneLake shortcuts + Fabric data sharing (preview) | Partial | Internal sharing uses shortcuts (zero-copy). Cross-tenant sharing is evolving in Fabric. Delta Sharing protocol is supported for external consumers but requires manual setup. |

**Key takeaway:** OneLake shortcuts are the foundation of the hybrid architecture. Create shortcuts to existing ADLS paths and both Databricks and Fabric can read the same Delta tables with zero data duplication.

---

## 6. Governance and security

Unity Catalog is Databricks' centralized governance layer with a mature three-level namespace, fine-grained access control, and integrated lineage. Fabric distributes governance across workspace roles, OneLake permissions, Purview, and Entra ID. The total capability is comparable, but the mapping requires careful planning. See [unity-catalog-migration.md](unity-catalog-migration.md) for the complete mapping guide.

| # | Databricks feature | Fabric equivalent | Parity | Migration notes |
| --- | --- | --- | --- | --- |
| 37 | **Unity Catalog** (3-level namespace: catalog.schema.table) | OneLake + Workspace + Lakehouse metadata | Partial | No direct 3-level namespace. Workspace = catalog analog, Lakehouse = schema analog. Cross-referencing requires shortcuts. See [unity-catalog-migration.md](unity-catalog-migration.md). |
| 38 | **Column-level security** (UC column masks) | Fabric Warehouse column-level DENY | Partial | Available only in Fabric Warehouse, not in Lakehouse SQL endpoint. Route sensitive tables to Warehouse if column-level security is required. |
| 39 | **Row-level security** (UC row filters) | Fabric Warehouse RLS + Power BI RLS | Full | Warehouse supports SQL-based RLS. Power BI adds report-level RLS. Combined, they cover the same use cases as UC row filters. |
| 40 | **Data lineage** (UC table and column lineage) | Microsoft Purview lineage | Full | Purview tracks lineage across Fabric items, Azure SQL, Synapse, and external sources. Requires Purview setup and scanning. |
| 41 | **Data classification** (UC tags and metadata) | Purview sensitivity labels + classifications | Full | Purview provides richer classification with Microsoft Information Protection (MIP) integration. Auto-classification supported. |
| 42 | **Service principal authentication** | Fabric service principal (Entra ID) | Full | Same Entra ID (Azure AD) service principals work for both Databricks and Fabric on Azure. No credential migration needed. |
| 43 | **IP access lists** (network restrictions) | Fabric Private Links + Entra ID Conditional Access | Full | Use Azure Private Link for network isolation. Entra ID Conditional Access provides policy-based access control (device, location, risk). |
| 44 | **Audit logs** (account-level audit) | Azure Monitor + Microsoft 365 Unified Audit Log + Fabric admin monitoring | Full | Multiple audit surfaces: Azure Monitor for infrastructure, M365 audit for user actions, Fabric admin for workspace-level events. |

**Key takeaway:** Governance migration is complex but achievable. The main risk is losing column-level security if tables stay in Lakehouse (route to Warehouse instead). Connect Purview to Fabric early so lineage builds from day one.

---

## 7. Machine learning and AI

This is Databricks' strongest advantage. MLflow is the industry standard, Model Serving is production-ready, Feature Store is mature, and GPU clusters are available for training. Fabric's ML surface is functional but less mature. For heavy ML workloads, the recommendation is to keep them on Databricks. See [ml-migration.md](ml-migration.md) for the detailed migration guide.

| # | Databricks feature | Fabric equivalent | Parity | Migration notes |
| --- | --- | --- | --- | --- |
| 45 | **MLflow** (experiment tracking) | Fabric ML experiments (MLflow API compatible) | Partial | Fabric supports the MLflow API for logging experiments. The experiment viewer is less feature-rich than Databricks. UC model lineage is not replicated. |
| 46 | **Model Registry** (UC-integrated model catalog) | Fabric ML model registry | Partial | Basic model registry with versioning. No Unity Catalog integration or model lineage graph. |
| 47 | **Model Serving** (real-time inference endpoints) | Azure ML managed online endpoints | Gap | No native Fabric model serving. Deploy models to Azure ML managed endpoints or Azure Container Apps. Adds a second service to manage. |
| 48 | **Feature Store** (feature engineering + serving) | Fabric feature engineering (preview, April 2026) | Partial | Preview feature with basic functionality. No online feature serving. Evaluate maturity before migrating. |
| 49 | **AutoML** (automated model selection) | Fabric AutoML (FLAML-based) | Full | Both provide automated model selection and hyperparameter tuning for tabular data. Fabric uses FLAML under the hood. |
| 50 | **Vector Search** (embedding similarity search) | Azure AI Search (vector index) | Gap | No native Fabric vector search. Azure AI Search provides vector, hybrid, and keyword search. Requires separate Azure service. |
| 51 | **Databricks Apps** (hosted ML/data apps) | Azure ML + Azure Container Apps | Gap | No equivalent app hosting in Fabric. Deploy Streamlit/Gradio/Flask apps via Azure Container Apps or Azure App Service. |

**Key takeaway:** For teams with significant ML workloads, keep ML training and serving on Databricks. Migrate experiment tracking and AutoML for simple models only. The hybrid pattern (Databricks for ML, Fabric for BI) is the recommended approach.

---

## 8. Streaming and real-time

Fabric Real-Time Intelligence (RTI) is genuinely better than Databricks for sub-second streaming analytics. Eventhouse + Eventstream provide purpose-built event ingestion and KQL-based querying that outperforms Structured Streaming + DLT for real-time dashboards. For complex streaming ETL (joins, windows, UDFs), Spark Structured Streaming on Fabric is equivalent to Databricks (without Photon). See [streaming-migration.md](streaming-migration.md) for the complete guide.

| # | Databricks feature | Fabric equivalent | Parity | Migration notes |
| --- | --- | --- | --- | --- |
| 52 | **Structured Streaming** (Spark micro-batch/continuous) | Fabric Spark Structured Streaming | Full | Same Spark Structured Streaming API runs in Fabric notebooks. Same `readStream` / `writeStream` / `trigger` patterns. |
| 53 | **Structured Streaming + Auto Loader** (file-based streaming) | Fabric Spark file streaming + Data Pipeline event triggers | Partial | Auto Loader's glob-based file detection with automatic schema evolution has no exact equivalent. Use Spark `readStream.format("json/csv")` with `maxFilesPerTrigger` or Data Pipeline storage event triggers. |
| 54 | **Delta Live Tables (streaming mode)** | Fabric Real-Time Intelligence (Eventhouse + Eventstream) | Better | Eventhouse provides sub-second ingestion and KQL querying optimized for time-series data. RTI dashboards refresh in real-time. DLT streaming is micro-batch (seconds-minutes). |
| 55 | **Kafka / Event Hubs integration** | Fabric Eventstream + Eventhouse | Better | Eventstream provides no-code routing from Event Hubs and Kafka to Eventhouse, Lakehouse, or Data Activator. Built-in monitoring. No cluster to manage. |

**Key takeaway:** Streaming is a Fabric strength for analytics use cases (dashboards, alerts, KQL queries). For complex streaming ETL that writes to Delta tables, Fabric Spark Structured Streaming works but consider whether the ETL belongs on Databricks (Photon advantage) with results shortcutted to Fabric for BI.

---

## 9. DevOps and CI/CD

Databricks Asset Bundles (DABs) and the Databricks CLI provide IaC-style deployment. Fabric uses Git integration (workspace-to-repo sync) and deployment pipelines (dev/test/prod promotion). The Fabric approach is more opinionated (built-in dev/test/prod stages) but less flexible for custom IaC patterns.

| # | Databricks feature | Fabric equivalent | Parity | Migration notes |
| --- | --- | --- | --- | --- |
| 56 | **Repos** (workspace Git sync) | Fabric Git integration (Azure DevOps, GitHub) | Full | Connect a Fabric workspace to a Git repo. Items are serialized as definition files. Commit, pull, branch workflows supported. |
| 57 | **Databricks Asset Bundles** (IaC deployment) | Fabric deployment pipelines | Partial | Deployment pipelines support dev -> test -> prod promotion with built-in UI. Less flexible than DABs for custom CI/CD (no Terraform-style IaC). |
| 58 | **REST API** (workspace and job management) | Fabric REST API | Full | Comprehensive REST API covering workspaces, items, jobs, shortcuts, and admin operations. |
| 59 | **Terraform provider** (IaC) | Fabric Terraform provider (preview) | Partial | The Fabric Terraform provider is newer and covers fewer resources than the Databricks provider. Evaluate coverage for your specific IaC needs. |
| 60 | **Databricks CLI** (command-line tool) | Fabric CLI (preview) + Azure CLI (`az` commands) | Partial | Azure CLI covers some Fabric operations. The Fabric-specific CLI is evolving and not yet feature-complete. Use the REST API for full coverage. |

**Key takeaway:** DevOps migration is straightforward for teams using Git integration. Teams with heavy DABs or Terraform usage should evaluate the Fabric Terraform provider's coverage before migrating CI/CD pipelines.

---

## 10. Summary parity scorecard

| Category | Full | Partial | Gap | Better | Total |
| --- | --- | --- | --- | --- | --- |
| Compute (8) | 2 | 3 | 2 | 1 | 8 |
| Notebooks & Dev (10) | 8 | 2 | 0 | 0 | 10 |
| SQL Analytics (6) | 4 | 1 | 0 | 2 | 7 |
| Data Engineering (8) | 3 | 3 | 0 | 1 | 7 |
| Storage (4) | 1 | 1 | 0 | 2 | 4 |
| Governance (8) | 6 | 2 | 0 | 0 | 8 |
| ML & AI (7) | 1 | 3 | 3 | 0 | 7 |
| Streaming (4) | 1 | 1 | 0 | 2 | 4 |
| DevOps (5) | 2 | 3 | 0 | 0 | 5 |
| **Total (60)** | **28** | **19** | **5** | **8** | **60** |

**47% Full parity. 13% Better than Databricks. 32% Partial (workable with adjustments). 8% Gap (needs external service).**

### Reading the scorecard

- **60% Full + Better (36 features):** These migrate cleanly or improve with Fabric.
- **32% Partial (19 features):** These work but require workarounds, configuration changes, or different tooling. Each is addressed in the dedicated migration guide.
- **8% Gap (5 features):** Photon, GPU clusters, Model Serving, Vector Search, Databricks Apps. All five are in ML/AI and compute. They require external Azure services (Azure ML, Azure AI Search, Azure Container Apps) or staying on Databricks.

### Migration priority by parity

| Priority | Category | Parity | Action |
| --- | --- | --- | --- |
| **1 -- Migrate first** | SQL Analytics, Storage | Mostly Better/Full | Highest ROI, lowest risk |
| **2 -- Migrate next** | Notebooks, Governance, DevOps | Mostly Full | Straightforward conversion |
| **3 -- Evaluate carefully** | Data Engineering, Streaming | Mixed Full/Partial/Better | DLT and Auto Loader require significant work |
| **4 -- Keep on Databricks** | ML & AI, Compute (Photon/GPU) | Mostly Gap/Partial | Hybrid pattern recommended |

---

## 11. Gap closure roadmap

Microsoft is actively closing Fabric gaps. The following items are on the public roadmap or in preview as of April 2026. Monitor Microsoft Fabric release notes for GA announcements.

| Gap | Current status | Expected timeline | Interim workaround |
| --- | --- | --- | --- |
| Column-level security on Lakehouse | Not available | Roadmap (no date) | Use Fabric Warehouse for sensitive tables |
| Fabric Terraform provider (full coverage) | Preview (partial) | H2 2026 (estimated) | Use Fabric REST API + Azure CLI |
| Feature Store (GA) | Preview | H2 2026 (estimated) | Keep on Databricks or use manual feature tables |
| Fabric CLI (full coverage) | Preview (limited) | 2026 | Use REST API for full operations |
| Native vector search | Not planned | Unknown | Use Azure AI Search |
| Native model serving | Not planned | Unknown | Use Azure ML managed endpoints |
| Photon-equivalent engine | Not planned | Unknown | Accept perf gap or keep Photon workloads on Databricks |

**Recommendation:** Do not delay migration waiting for gap closure. Use the hybrid pattern for Gap items today, and re-evaluate quarterly as Fabric matures.

---

## Related

- [Notebook Migration](notebook-migration.md) -- detailed notebook conversion guide
- [Unity Catalog Migration](unity-catalog-migration.md) -- governance mapping
- [DLT Migration](dlt-migration.md) -- pipeline migration
- [ML Migration](ml-migration.md) -- ML/AI workload migration
- [Streaming Migration](streaming-migration.md) -- real-time workload migration
- [Benchmarks](benchmarks.md) -- performance comparisons for Partial/Gap items
- [Why Fabric over Databricks](why-fabric-over-databricks.md) -- strategic context
- [Parent guide: 5-phase migration](../databricks-to-fabric.md)

---

**Maintainers:** csa-inabox core team
**Source finding:** CSA-0083 (HIGH, XL) -- approved via AQ-0010 ballot B6
**Last updated:** 2026-04-30
