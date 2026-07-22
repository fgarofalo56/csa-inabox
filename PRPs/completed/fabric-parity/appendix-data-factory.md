# Appendix — Microsoft Fabric Data Factory → CSA Loom Parity (data-factory domain)

> Parity architect deep-dive. Domain: **Data Factory (integration)**. Generated 2026-06-26.
> Grounded in Microsoft Learn (URLs inline) + a full read of the Loom `fiab-console`
> Data Factory surfaces, provisioners, BFF routes, and bicep. Cross-cutting rules:
> `no-fabric-dependency.md`, `no-vaporware.md`, `ui-parity.md`, `web3-ui.md`,
> `loom_no_freeform_config`. Dual cloud (Commercial + Government/GCC). Day-one ON.
>
> **Headline finding:** Data Factory is Loom's **strongest** domain. The pipeline
> authoring stack (40+ activity catalog, React-Flow canvas, trigger wizard, expression
> builder), Copy job (full/incremental/CDC), Dataflow Gen2 (Power Query → ADF
> WranglingDataFlow), Mapping Data Flow visual designer, Linked services / Integration
> runtimes managers, Mounted ADF, Mirrored database/Databricks, and dbt job are all
> built on **real Azure ARM / Synapse dev / data-plane** backends with no Fabric
> dependency. The remaining gaps are **breadth** (connectors, CDC sources) and **one
> genuinely-stubbed runtime** (Apache Airflow has an editor but no platform-deployed
> backend), plus a handful of polish items (Fast Copy surfacing, unified-editor Copilot,
> template gallery, mirroring source breadth).

---

## 1. Fabric Data Factory capability inventory (grounded in MS Learn)

Fabric Data Factory is the next-gen of Azure Data Factory (ADF) with a SaaS architecture,
built-in AI (Copilot), and a simplified runtime (no integration-runtime management; Fabric
handles compute). It exposes these item types and capabilities:

### 1.1 Data pipelines (orchestration canvas)
- **Item model:** A `DataPipeline` item = JSON activity graph (`properties.activities[]`,
  `parameters`, `variables`). Authored on a low-code canvas. Save (no publish step) + Run.
  Learn: https://learn.microsoft.com/fabric/data-factory/pipeline-overview ,
  https://learn.microsoft.com/fabric/data-factory/activity-overview
- **Activities (40+), three families:**
  - *Data movement:* Copy data, Copy job activity.
  - *Data transformation:* Dataflow Gen2 (Dataflow activity), Notebook, Spark Job Definition,
    Stored procedure, Script, HDInsight (Hive/Pig/MapReduce/Spark/Streaming), Azure Databricks
    (Notebook/Jar/Python), Azure ML (Execute pipeline / Batch), Azure Functions, U-SQL,
    Lakehouse maintenance, Refresh materialized lake view, Refresh SQL endpoint, KQL.
  - *Control flow:* ForEach, If condition, Switch, Until, Filter, Wait, Set variable, Append
    variable, Get metadata, Lookup, Invoke pipeline (incl. **Invoke remote** ADF/Synapse
    pipeline — GA Sep 2025), Web, Webhook, Fail, Validation, Approval (human-in-loop),
    Teams, Office 365 Outlook (email), Deactivate, Azure Batch.
  - Learn (control flow): https://learn.microsoft.com/fabric/data-factory/activity-overview#control-flow-activities
  - Business-workflow / approval: https://learn.microsoft.com/fabric/data-factory/business-workflow-management
- **Parameters & variables:** pipeline parameters (run-time inputs), variables (mutable in-run),
  system variables, expression language (`@pipeline()`, `@activity()`, functions) — nearly
  identical to ADF. Expression builder with **Add dynamic content**.
- **Triggers / scheduling:**
  - On-demand (Run), **Scheduled** (fixed schedule: frequency + start/end + timezone; up to 20
    schedules/pipeline; **interval-based** preview), **Event-based** (storage events via
    Eventstream + Data Activator/Reflex; OneLake events, Azure Blob events; file/folder name
    available as trigger parameters; job events, workspace events).
  - ADF-flavored equivalents: Schedule trigger, Tumbling window trigger, Storage event trigger,
    Custom event trigger (Event Grid). Learn: https://learn.microsoft.com/fabric/data-factory/pipeline-runs
- **Templates:** pipeline template gallery (import/export `.zip`) + **Semantic Model Refresh**
  templates. Learn: https://learn.microsoft.com/fabric/data-factory/templates
- **Canvas experience:** updated visual canvas, drag/connect, success/failure/completion/skip
  dependency edges. Learn: https://learn.microsoft.com/fabric/data-factory/pipeline-canvas-experience
- **CI/CD:** Git integration (Azure DevOps / GitHub), deployment pipelines, item-level promotion,
  cherry-pick. Learn: https://learn.microsoft.com/fabric/data-factory/cicd-pipelines
- **VS Code / MCP authoring:** `mcp_datafactory*` tools (list_workspaces, create_pipeline,
  update/get_pipeline_definition). Learn: https://learn.microsoft.com/fabric/data-factory/pipelines-manage-vs-code

### 1.2 Dataflow Gen2 (Power Query at scale)
- **Item model:** Power Query (M / "Mashup") queries + applied steps; runs on the Mashup engine,
  with a **staging Lakehouse + staging Warehouse** for fold-down compute, or **Spark** when
  Mapping-Data-Flow (MDF) transforms are used. Learn: https://learn.microsoft.com/fabric/data-factory/dataflows-gen2-overview
- **Output destinations:** Lakehouse, Warehouse, Azure SQL DB, Azure Data Explorer (Kusto),
  Fabric SQL DB, Snowflake. Learn: https://learn.microsoft.com/fabric/data-factory/dataflow-gen2-data-destinations-and-managed-settings
- **Staging:** enable/disable per query; "Extract previous"; staged-data options (Optimized copy
  to Lakehouse, V-Order). Learn: https://learn.microsoft.com/fabric/data-factory/dataflow-gen2-staged-data-options
- **Fast copy:** copy-activity-backed fast path for ADLS/Blob/SQL/Lakehouse/PostgreSQL/Oracle/
  Snowflake/Warehouse sources → Lakehouse. Learn: https://learn.microsoft.com/fabric/data-factory/dataflows-gen2-fast-copy
- **300+ Power Query transforms**, query folding indicators, incremental refresh, parameters
  (public parameters mode → runtime via pipeline/API), **variable library** integration.
- **CI/CD:** Git + deployment pipelines, just-in-time publishing, public APIs. Learn:
  https://learn.microsoft.com/fabric/data-factory/dataflow-gen2-cicd-and-git-integration
- **Copilot:** NL get-data, NL transforms, sample-data gen, explain query (GA Sep 2025).

### 1.3 Mapping Data Flow (ADF) — Spark visual transform
- Visual Source→transform→Sink graph compiled to Data Flow Script, runs on Spark IR. Distinct
  from Dataflow Gen2. (In Fabric, MDF transforms execute inside Dataflow Gen2 via Spark.)

### 1.4 Copy job (simplified copy + CDC)
- Guided wizard (Source → Destination → Mode → Update → Mapping → Review). Modes: **Full**,
  **Incremental (watermark column)**, **CDC**. Update methods: Append, Overwrite, **Merge**,
  **SCD Type 2**. Auto table creation/truncation, column mapping, subset via DB query,
  schedule. State/checkpoint managed automatically; resume from last success.
  Learn: https://learn.microsoft.com/fabric/data-factory/what-is-copy-job ,
  https://learn.microsoft.com/fabric/data-factory/incremental-copy-job ,
  https://learn.microsoft.com/fabric/data-factory/cdc-copy-job
- **CDC sources (preview):** Azure SQL DB, SQL Server, Oracle, Snowflake, PostgreSQL, MySQL.

### 1.5 Mirroring (entry from Data Factory)
- Near-real-time replication into OneLake Delta. Sources: Azure SQL DB/MI, Cosmos DB, Snowflake,
  Azure Databricks (mirrored catalog), Azure PostgreSQL, **Open Mirroring** (push API).

### 1.6 Apache Airflow job
- Managed Airflow (next-gen of ADF Workflow Orchestration Manager). Python DAGs, Git sync, AKV
  backend, autoscale, HA, deferrable operators, TTL pause/resume. **No private network / VNet
  support** today. Learn: https://learn.microsoft.com/fabric/data-factory/apache-airflow-jobs-concepts ,
  https://learn.microsoft.com/fabric/data-factory/create-apache-airflow-jobs

### 1.7 dbt job
- No-code dbt project build/test/deploy against Fabric Warehouse. Learn:
  https://learn.microsoft.com/fabric/data-factory/dbt-job-overview

### 1.8 Connectors (200+) + gateways + runtimes
- **Connector catalog:** 200+ across Dataflow Gen2, pipeline Copy activity, Copy job. Learn:
  https://learn.microsoft.com/fabric/data-factory/connector-overview
- **On-premises data gateway** (replaces ADF Self-Hosted IR for on-prem access).
- **Virtual network (VNet) data gateway** — Microsoft-managed, private-endpoint/Private-Link
  to Azure sources; supports Dataflow Gen2, pipelines, Copy job, Mirroring, Power BI models.
  Learn: https://learn.microsoft.com/data-integration/vnet/overview . **Gov availability:**
  not in GCC L2; supported in GCC-High L4 (TX/VA) and L5 (DoD East), and air-gapped US Nat/Sec.
- **Integration runtime equivalent:** Fabric hides IR management (compute is managed). ADF/Synapse
  keep Azure / Self-Hosted / Azure-SSIS IRs + **managed VNet + managed private endpoints**.
- **Linked services / connections** — reusable connection + auth definitions.

### 1.9 Copilot for Data Factory (cross-cutting AI)
- Pipelines: NL→pipeline generation, run-from-chat, error-message assistant, summarize pipeline,
  build/explain expressions. Dataflow Gen2: NL transforms / explain / sample-data.
  Learn: https://learn.microsoft.com/fabric/data-factory/copilot-fabric-data-factory

**Feature count (capability rows enumerated above): ~52.**

---

## 2. Loom coverage map (built / stubbed / missing — honest)

Read of `apps/fiab-console`. Status key: ✅ built on real Azure backend · ⚠️ partial/honest-gate ·
🟥 stubbed (present-but-not-functional) · ❌ missing.

| # | Fabric capability | Loom surface (file) | Backend (real?) | Status |
|---|---|---|---|---|
| 1 | Data pipeline canvas + activity graph | `lib/editors/data-pipeline-editor.tsx` (1711) + `pipeline-editor-core.tsx` (1288) + `components/pipeline/canvas.tsx`, `pipeline-designer.tsx` | Synapse dev REST / ADF ARM upsert + run-and-poll (`provisioners/data-pipeline.ts`→synapse/adf) | ✅ |
| 2 | 40+ activity catalog (move/transform/control) | `components/pipeline/activity-catalog.ts` (1543) — 38 activity keys incl. ForEach/If/Switch/Until/Filter/Wait/SetVar/AppendVar/Lookup/GetMetadata/Copy/Script/StoredProc/Notebook/SparkJob/ExecutePipeline/Web/Webhook/Fail/Validation/Office365/Approval/HDInsight×5/Databricks×2/AzureFunction/AzureML×2/U-SQL/Delete | ADF/Synapse JSON typeProperties (real) | ✅ |
| 3 | Parameters / variables / expressions | `params-variables-panel.tsx`, `dynamic-content.tsx`, `expression-functions.ts`, `evaluate-expression.ts`, `expression-field.tsx` | Real ADF expression semantics; `/api/adf/.../evaluate` | ✅ |
| 4 | Triggers (schedule/tumbling/blob/custom event) | `components/pipeline/trigger-wizard.tsx` (959) — wizard, no cron text | `/api/adf/triggers` real ARM | ✅ |
| 5 | Pipeline Copilot (NL→pipeline, run, diagnose) | `/api/items/adf-pipeline/[id]/copilot`, `/api/items/synapse-pipeline/[id]/copilot`; parity `pipeline-copilot.md` | AOAI orchestrator (real) | ⚠️ wired for adf/synapse alias editors; **not surfaced in the unified `data-pipeline-editor`** |
| 6 | Dataflow Gen2 (Power Query) | `lib/editors/dataflow-gen2-editor.tsx` (434) + `components/pipeline/dataflow/power-query-host.tsx`, `destination-picker.tsx`, `m-script.ts` | Authored M → ADF **WranglingDataFlow** on ADF Spark; `/api/items/dataflow/**` | ✅ |
| 7 | Dataflow Gen2 Copilot | `dataflow/dataflow-copilot-pane.tsx` (5 capabilities) | `/api/items/dataflow/copilot` AOAI | ✅ |
| 8 | Dataflow Gen2 staging / **Fast copy** / V-Order / incremental refresh | — | — | ⚠️ destination picker built; **Fast Copy / staging toggles / incremental refresh not surfaced** |
| 9 | Mapping Data Flow visual designer | `lib/editors/mapping-dataflow-editor.tsx` + `mounted-adf-editor.tsx` (1114) + `dataflow/mapping-dataflow-designer.tsx` | `Microsoft.DataFactory/factories/dataflows` (MappingDataFlow) real ARM; `/api/adf/dataflows/**` | ✅ |
| 10 | Copy job (full/incremental/CDC, SCD) | `lib/editors/copy-job-editor.tsx` (460) + `components/pipeline/copy-job/wizard.tsx` | ADF pipeline + `dbo.copy_watermark` control table (Azure SQL) + SQL CDC | ✅ (SQL); ⚠️ CDC **source breadth** (Oracle/Snowflake/PostgreSQL/MySQL) |
| 11 | Mirrored database | `lib/editors/mirrored-database-editor.tsx` + `provisioners/mirrored-database.ts`; parity `mirrored-database-wizard.md`, `open-mirroring.md` | ADF CDC / Synapse Link → ADLS Bronze Delta (real) | ✅ |
| 12 | Mirrored Databricks catalog | `lib/editors/mirrored-databricks-editor.tsx` + provisioner | Databricks UC → Delta (real) | ✅ |
| 13 | Mounted Data Factory (invoke remote ADF/Synapse) | `lib/editors/mounted-adf-editor.tsx` | `/api/items/mounted-adf/**` real ARM | ✅ |
| 14 | Linked services (connector gallery + auth forms) | `lib/editors/linked-service-editor.tsx` → `linked-service-gallery.tsx` + `lib/pipeline/connector-catalog.ts` | `/api/adf/linked-services` (+ Synapse) real ARM; Test connection | ✅ ; ⚠️ **72 connectors vs 200+** |
| 15 | Integration runtimes (Azure/Self-Hosted/SSIS) | `lib/editors/integration-runtime-editor.tsx` → `integration-runtime-manager.tsx` | `/api/adf/integration-runtimes` real ARM; auth keys; start/stop | ✅ |
| 16 | Managed VNet + managed private endpoints | `bicep/modules/landing-zone/adf.bicep` (managedVirtualNetwork + managedPrivateEndpoints), synapse.bicep | ARM (day-one) | ✅ |
| 17 | On-prem / VNet data gateway (private source access) | SHIR via IR manager; managed VNet IR; parity `purview-shir-autoscale.md` | real | ⚠️ SHIR/managed-VNet covers it; **no Microsoft-managed "VNet data gateway" object** (N/A off-Fabric) |
| 18 | dbt job (visual project build + run) | `lib/catalog` `dbt-job` + editor; `loom-dbt-runner` Container App | `bicep/main.bicep` dbtRunner (day-one, image-gated); Databricks native dbt_task | ✅ (image-gated honest) |
| 19 | **Apache Airflow job** | `lib/editors/airflow-job-editor.tsx` (647); `/api/items/airflow-job` | Proxies to a **user-supplied** Airflow webserver URL; **NO platform-deployed Airflow, no bicep** | 🟥 stubbed (honest-gate, but no day-one runtime) |
| 20 | Pipeline templates gallery | `components/pipeline/templates/` | partial | ⚠️ template scaffolding present; **gallery import/export + semantic-model-refresh templates not surfaced** |
| 21 | CI/CD (Git + deployment pipelines) | parity `git-integration.md`, `deployment-pipelines.md`, `deployment-pipelines-loom.md`, `variable-library.md` | real | ✅ |
| 22 | Connections / connection details | parity `connections.md`, `connection-details.md`, `azure-connections.md` | real | ✅ |
| 23 | ADF CDC resource (preview) | parity `adf-change-data-capture.md`; `/api/adf/cdc` | `Microsoft.DataFactory/factories/adfcdcs` real ARM | ✅ |

**Loom status for the domain: STRONG (partial only on breadth + Airflow runtime).**

---

## 3. Gap build specs (Azure-native default + OSS; Commercial + Gov; day-one ON; Web-5.0 UX)

### G1 — Apache Airflow runtime: deploy OSS Airflow day-one (P0)
**Symptom today:** the Airflow editor renders DAGs/Runs/Connections/Settings tabs but proxies to a
webserver URL the user must paste; nothing is deployed by the platform → the surface is dark on a
clean deploy. Violates *day-one ON* + *no-vaporware* (functional runtime, not a config gate).

**Architecture (words):** Deploy **OSS Apache Airflow** as the Azure-native default backend, no
Fabric. Commercial + Gov both run the same OSS image, so there is zero managed-service Gov gap.
- *Compute:* Airflow webserver + scheduler + (optional) triggerer as **Azure Container Apps** in the
  admin-plane managed environment (`cae-csa-loom-*`), scale-to-min-1 for the scheduler, scale-to-zero
  acceptable for a KEDA-driven worker on CeleryExecutor — or use **LocalExecutor** in a single ACA
  for the day-one default to minimize cost. For heavy estates, an **AKS + official Airflow Helm
  chart** profile (KubernetesExecutor) is the opt-in scale tier.
- *Metadata DB:* **Azure Database for PostgreSQL Flexible Server** (private, VNet-injected), the
  Airflow metadata store. (Available in Commercial and Gov.)
- *DAG storage / Git sync:* **Azure Files** share mounted into the ACA (DAGs folder) + a **git-sync**
  sidecar pulling from the Loom Git repo (Azure DevOps / GitHub). Matches Fabric "Git sync".
- *Secrets backend:* **Azure Key Vault** as the Airflow secrets backend (connections + variables),
  via the Console UAMI + KV reference. Matches Fabric "AKV backend".
- *Auth:* Airflow webserver behind the same Front Door + Entra auth as the console; the BFF mints a
  short-lived bearer (`LOOM_AIRFLOW_BEARER` replaced by AAD-ingress token).
- *Networking:* VNet-injected ACA env + private PostgreSQL → fully private; this also closes the
  Fabric gap (Fabric Airflow has **no** private-network support).

**Web-5.0 UI (extend `airflow-job-editor.tsx`, no freeform config):**
- **DAGs** tab: tree of synced DAGs with pause/resume toggles, last-run badge, schedule chip.
- **New DAG** = a **Copilot DAG builder** + a guided form (name → schedule via the same
  recurrence wizard used by `trigger-wizard.tsx` → operators picked from a typed gallery:
  Spark/dbt/Databricks/HTTP/Copy-Job/ADF-pipeline) → generates the `.py` DAG into the Git repo
  (the only freeform surface allowed = the generated Python preview, a 1:1 source-product code view).
- **Runs** tab: grid + Gantt of task instances (poll Airflow REST `/api/v1/dags/{id}/dagRuns`).
- **Connections / Variables** tabs: structured forms writing to the KV-backed secrets backend.
- **Settings:** environment requirements (provider packages), autoscale tier (LocalExecutor ACA ↔
  KubernetesExecutor AKS), TTL pause/resume.

**BFF APIs (real):** `GET/POST /api/items/airflow-job/[id]/dags`, `/dagRuns`, `/connections`,
`/variables`, `/trigger`, `/pause` — each proxies the Airflow stable REST API with the AAD bearer.

**Azure services:** ACA (or AKS), PostgreSQL Flexible Server, Azure Files, Key Vault, git-sync.

**Bicep / deploy:** new `platform/fiab/bicep/modules/admin-plane/airflow.bicep` (ACA app +
PostgreSQL + Azure Files + KV role assignment), wired into `main.bicep` behind
`airflowEnabled bool = true` + `airflowImageReady bool = false` (same image-gate pattern as
dbtRunner so a clean first deploy doesn't fail on an unresolvable image ref). Build script
`scripts/csa-loom/build-airflow-runtime.sh` (`az acr build`).

**Commercial vs Gov:** identical OSS stack. Gov endpoints `.us` (ACR `*.azurecr.us`, KV
`*.vault.usgovcloudapi.net`, PostgreSQL `*.postgres.database.usgovcloudapi.net`). IL4/5: private
ingress only, no public DAG endpoint, customer-managed keys on PostgreSQL + Files. No managed-service
substitution needed (it is OSS end to end).

**Day-one config:** `airflowEnabled=true`; provisions an empty DAGs folder + a sample
"hello_loom" DAG so the surface is live, not empty. User can disable via the admin toggle.

**Acceptance:** with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset and a clean deploy, the Airflow editor
lists the sample DAG, triggers it, and shows a Succeeded dagRun from the real OSS Airflow REST API.

---

### G2 — Connector catalog breadth: 72 → 200+ (P1)
**Today:** `lib/pipeline/connector-catalog.ts` has ~72 connector type entries (azure×11, database×9,
file×4, generic-protocol×3, nosql×2, services-and-apps×3 categories) wired into the linked-service
gallery on real ADF/Synapse ARM. Fabric exposes 200+ (mostly Dataflow Gen2 Power-Query connectors).

**Design:** the architecture is already correct (typed gallery + per-connector auth/field forms →
real ARM linkedservices). The gap is **catalog data**, not plumbing. Expand `connector-catalog.ts`
in waves toward ADF/Synapse parity (the ~100 pipeline-copyable stores: SAP BW/HANA/Table,
ServiceNow, Salesforce, Google BigQuery/Cloud Storage, Amazon S3/Redshift/Athena, Greenplum,
Presto, Impala, Hive LLAP, Teradata, Vertica, Db2, Informix, Netezza, MongoDB/Atlas, Cassandra,
Dynamics 365/CRM, SharePoint Online list, REST/OData/ODBC/HTTP/FTP/SFTP, Oracle Cloud Storage,
FHIR, etc.). For Power-Query-only sources (Adobe Analytics, Google Analytics, Smartsheet…), surface
them in the **Dataflow Gen2 Get-data** gallery (Power Query connector ids) rather than ADF
linkedservices. Ground each connector's auth kinds + fields in the Learn connector page.

**Web-5.0 UI:** the existing gallery already groups by category with icons + search; only data rows
are added. Add a **category facet rail** + a "show all 200" expander.

**Commercial vs Gov:** some SaaS connectors (Google/Adobe/Salesforce public clouds) are reachable
from Gov only via the VNet/managed-VNet path or are policy-blocked; tag each connector with a
`clouds: ['commercial','gov']` field and hide/disable Gov-unavailable rows with a precise tooltip.

**Backend per control:** unchanged — `/api/adf/linked-services` (+ `/test`) real ARM; Power-Query
ones bind in the Dataflow Gen2 M source step.

**Day-one:** all wired connectors are immediately usable (no per-connector gate). **Acceptance:**
gallery lists ≥150 connectors; creating + Test-connection on 5 net-new (e.g. ServiceNow, BigQuery,
S3, SAP HANA, Salesforce) returns a real ARM linkedservice + a real test result.

---

### G3 — Dataflow Gen2 Fast Copy + staging + incremental refresh surfacing (P1)
**Today:** Dataflow Gen2 editor compiles M → ADF WranglingDataFlow + a DestinationPicker, but the
Fabric **Scale/Staging** controls (Enable staging per query, Optimized copy, V-Order, **Fast copy**,
incremental refresh) are not surfaced.

**Design (Azure-native):**
- **Fast copy** → when the source/sink pair is in the fast-copy set (ADLS/Blob/Azure SQL/Lakehouse-
  equivalent ADLS-Delta/PostgreSQL/Oracle/Snowflake/Synapse), compile to an ADF **Copy activity**
  instead of a WranglingDataFlow (DW compute), exactly mirroring Fabric's fast path. A per-query
  **Fast copy** toggle in the query context menu.
- **Staging** → a per-query "Enable staging" toggle that lands intermediate results in the staging
  ADLS/Synapse area before the sink (fold-down compute), matching Fabric staging Lakehouse/Warehouse.
- **Incremental refresh** → a wizard (date/datetime column → range → bucket → detect-changes column)
  generating an incremental WranglingDataFlow/Copy with a watermark (reuse the Copy-job
  `dbo.copy_watermark` control-table pattern).
- **Scale options** dialog (Options → Scale) with the staged-data toggles (Optimized copy, V-Order)
  applied to the staging writer.

**Web-5.0 UI:** query context-menu toggles (Enable staging / Fast copy) with folding-style
indicators; an **Options → Scale** dialog; an **Incremental refresh** wizard. No freeform config.

**Backend:** `/api/items/dataflow/compile` chooses WranglingDataFlow vs Copy activity vs incremental;
`/api/items/dataflow/run` dispatches on ADF. Watermark in Azure SQL control table.

**Commercial vs Gov:** identical (ADF managed-VNet IR in both). **Day-one:** staging area is the
deployment ADLS (already provisioned). **Acceptance:** a fast-copy-eligible dataflow runs as an ADF
Copy activity (receipt shows Copy, not WranglingDataFlow); an incremental refresh second run moves
only the delta.

---

### G4 — Copy job CDC / incremental source breadth + SCD Type 2 (P1)
**Today:** Copy-job editor supports Full / Incremental (watermark) / CDC, but CDC is wired for SQL.
Fabric supports CDC for Azure SQL DB, SQL Server, **Oracle, Snowflake, PostgreSQL, MySQL** and
SCD Type 2 history.

**Design (Azure-native):** extend the CopyJobWizard source step to detect CDC-enabled tables per
connector and drive the right read method:
- *Azure SQL / SQL Server* → native CT/CDC (already).
- *Oracle* → archived-redo-log / LogMiner CDC via the ADF Oracle CDC connector.
- *PostgreSQL* → logical replication slots / `wal2json`.
- *MySQL* → binlog.
- *Snowflake* → Streams (change tracking).
Each subsequent run merges inserts/updates/**deletes** into the sink. Add **SCD Type 2** write
behavior (effective-dating + soft-delete) alongside Append/Overwrite/Merge, reusing the watermark/
LSN control table (store per-source change cursor: LSN / SCN / slot LSN / binlog pos / stream offset).

**Web-5.0 UI:** the wizard already shows CDC-enabled table icons; add the SCD-Type-2 update-method
option + key-column picker + effective-date column config (all dropdowns).

**Backend:** ADF Copy/Mapping-Data-Flow with the connector-specific CDC read; control table in
Azure SQL. **Commercial vs Gov:** all source DBs reachable via managed-VNet IR in both clouds.
**Day-one:** no gate; CDC offered when the source reports change tracking. **Acceptance:** a
PostgreSQL-CDC copy job replicates an insert+update+delete to the sink with Merge, and an SCD-Type-2
job preserves a versioned history row.

---

### G5 — Pipeline Copilot in the unified data-pipeline editor (P2)
**Today:** the Copilot route exists for the `adf-pipeline` / `synapse-pipeline` alias editors but the
flagship `data-pipeline-editor` does not dock the Copilot pane.

**Design:** dock the same `PipelineCopilotPane` into `data-pipeline-editor.tsx` with NL→pipeline
(adds activities to the canvas graph), run-from-chat, error-message assistant (parse the run-and-poll
failure), summarize-pipeline, and expression build/explain inside the dynamic-content builder.

**Backend:** reuse `/api/items/adf-pipeline/[id]/copilot` generalized to the unified item id; AOAI
(Gov AOAI in Gov). **Day-one:** on when AOAI is wired (already the deployment default).
**Acceptance:** "copy SalesLT.Customer from Azure SQL to the lakehouse nightly" yields a Copy
activity + a schedule trigger on the real canvas, and Run executes it.

---

### G6 — Pipeline template gallery + Semantic-Model-Refresh templates (P2)
**Design:** surface a template gallery (import/export `.zip`, parameter mapping on import) in the
new-pipeline flow, seeded with Loom-authored templates (medallion ingest, S3→lake, CDC→warehouse)
**and** Semantic-Model-Refresh templates (event-driven / after-dataflow / scheduled / sequenced)
that target the Loom-native semantic layer (no Power BI dependency). Backend writes the activity
graph via the existing pipeline provisioner. **Day-one:** gallery seeded. **Acceptance:** importing
a template instantiates a runnable pipeline.

---

### G7 — VNet/managed networking + SHIR autoscale day-one (P2)
**Design:** the managed-VNet + managed-PE are already in `adf.bicep`/`synapse.bicep`; ensure they are
**default-on** and that the IR manager surfaces a one-click **managed PE approval** flow + **SHIR
autoscale** (the `purview-shir-autoscale.md` pattern) so private on-prem/Azure source access is a
day-one capability, not a manual portal step. This is the off-Fabric 1:1 of the Fabric VNet data
gateway (Microsoft-managed) — Loom uses the ADF managed VNet, which is private-endpoint capable in
both Commercial and Gov. **Acceptance:** a pipeline reads a PE-only Azure SQL source through the
managed-VNet IR with no public exposure.

---

### G8 — Open Mirroring landing zone + mirroring source breadth (P2)
**Design:** ensure the Mirrored-database wizard offers Azure SQL DB/MI, Cosmos DB, Snowflake,
Azure PostgreSQL, Databricks (built) **and Open Mirroring** (a push API landing into ADLS Bronze
Delta — provision the open-mirroring storage + SAS/Entra push endpoint day-one). Backend: ADF CDC /
Synapse Link copy → Delta (built); open-mirroring = a Loom push endpoint writing change batches to
Delta. **Acceptance:** an open-mirroring push lands a change batch as Delta and shows in the monitor.

---

## 4. Cross-cutting: Commercial vs Government summary

| Concern | Commercial | Government (GCC / GCC-High / DoD) |
|---|---|---|
| Pipelines / Copy job / Dataflow Gen2 / Mapping DF | ADF + Synapse ARM (real) | Same; Gov ARM endpoints `management.usgovcloudapi.net`, ADF available in Gov | 
| Apache Airflow (G1) | OSS Airflow on ACA + PostgreSQL Flex + KV | **Identical OSS stack**, `.us` endpoints, private ingress, CMK; closes Fabric's no-private-network gap |
| dbt runner | `loom-dbt-runner` ACA (image-gated) | Same OSS image, `*.azurecr.us` |
| Copilot (pipeline + dataflow) | Azure OpenAI | **Gov Azure OpenAI** (region-limited models); honest model-availability note |
| Connectors (G2) | full SaaS reach | tag Gov-unavailable SaaS; reach private/Azure sources via managed-VNet |
| Managed VNet / PE (G7) | ADF managed VNet | ADF managed VNet supported in Gov; private-only |
| Networking | public + private | private-only, IL4/5, CMK on PostgreSQL/Files |

No capability in this domain requires a managed service that is absent in Gov — Airflow and dbt are
OSS, and the rest are ADF/Synapse/ADLS/Azure SQL primitives available in both clouds. Fabric itself
and Power BI service stay **opt-in only** and are never on the default path.

---

## 5. Suggested build order
1. **G1 Apache Airflow runtime (P0)** — only genuinely-stubbed runtime; biggest day-one gap.
2. **G2 connectors / G3 Dataflow Fast Copy / G4 Copy-job CDC breadth (P1)** — breadth + depth.
3. **G5 unified-editor Copilot / G6 templates / G7 networking / G8 open mirroring (P2)** — polish.

A surface is A-grade only when its parity doc shows every inventory row built ✅ or honest-gate ⚠️
(zero ❌, zero stub banners) and a clean-deploy E2E receipt is attached with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
