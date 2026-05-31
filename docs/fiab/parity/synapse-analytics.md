# synapse-analytics — parity with Azure Synapse Analytics (Synapse Studio)

**Source UI:** Azure Synapse Studio (`https://web.azuresynapse.net`) + the Azure portal
Synapse workspace blade. Grounded in Microsoft Learn:

- Explore Azure Synapse Studio (hubs tour): https://learn.microsoft.com/training/modules/explore-azure-synapse-studio/
- Synapse terminology (workspace, SQL/Spark pools, linked services): https://learn.microsoft.com/azure/synapse-analytics/overview-terminology
- Author SQL scripts: https://learn.microsoft.com/azure/synapse-analytics/sql/author-sql-script
- Develop notebooks: https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-development-using-notebooks
- Create Spark pool (Studio): https://learn.microsoft.com/azure/synapse-analytics/quickstart-create-apache-spark-pool-studio
- Manage Spark pool packages: https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-manage-pool-packages
- Monitor hub: https://learn.microsoft.com/azure/synapse-analytics/get-started-monitor
- Access control / Manage hub: https://learn.microsoft.com/azure/synapse-analytics/security/how-to-set-up-access-control

**Loom reality:** "Synapse" in Loom is NOT a single unified Synapse Studio. It is **four
separate item-type editors** plus one shared navigator, surfaced through the Fabric-item
catalog:

| Loom item type | Editor file | Registry key |
| --- | --- | --- |
| Dedicated SQL pool | `apps/fiab-console/lib/editors/synapse-sql-editors.tsx` → `SynapseDedicatedSqlPoolEditor` | `synapse-dedicated-sql-pool` |
| Serverless SQL pool | `apps/fiab-console/lib/editors/synapse-sql-editors.tsx` → `SynapseServerlessSqlPoolEditor` | `synapse-serverless-sql-pool` |
| Spark (Big Data) pool | `apps/fiab-console/lib/editors/azure-services-editors.tsx` → `SynapseSparkPoolEditor` | `synapse-spark-pool` |
| Synapse pipeline | `apps/fiab-console/lib/editors/azure-services-editors.tsx` → `SynapsePipelineEditor` (delegates to `pipeline-editor-core.tsx`) | `synapse-pipeline` |
| Workspace Resources navigator | `apps/fiab-console/lib/components/pipeline/synapse-workspace-tree.tsx` | (left pane of the pipeline editor) |

Backends (all real, no mocks):
- `lib/azure/synapse-dev-client.ts` — ARM (`Microsoft.Synapse/workspaces/{ws}/bigDataPools|sqlPools`) + dev plane (`{ws}.dev.azuresynapse.net`: pipelines, triggers) + Livy (`/livyApi/.../sparkPools/{p}/batches|sessions`).
- `lib/azure/synapse-artifacts-client.ts` — dev plane artifacts: linked services, datasets, dataflows, notebooks, sql scripts.
- `lib/azure/synapse-sql-client.ts` — TDS via `mssql` to `{ws}.sql.azuresynapse.net` (dedicated) and `{ws}-ondemand.sql.azuresynapse.net` (serverless).
- `lib/azure/synapse-pool-arm.ts` — ARM pause/resume/state for the dedicated pool.
- Env: `LOOM_SYNAPSE_WORKSPACE` + `LOOM_SYNAPSE_DEDICATED_POOL` (both wired in `platform/fiab/bicep/modules/admin-plane/main.bicep:556-557`). Honest 503 gate when unset.
- Auth: `ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID), DefaultAzureCredential)`; UAMI holds Synapse Administrator + Contributor.

---

## Azure / Synapse Studio feature inventory → Loom coverage

Legend: built ✅ (full 1:1 + real backend) · partial ⚠️ · honest-gate ⚠️ · MISSING ❌

### Studio shell (web.azuresynapse.net)

| Capability (Azure) | Loom | Backend per control |
| --- | --- | --- |
| Single web IDE with left hub rail (Home/Data/Develop/Integrate/Monitor/Manage), workspace picker, top command bar, Publish/Discard, Git branch picker | MISSING ❌ — Loom has no unified Studio shell; each artifact is a separate catalog item editor | n/a |
| **Publish / Publish all** (live mode → service) | MISSING ❌ — each Loom create/edit PUTs directly to the live dev plane (no draft→publish workflow) | dev plane PUT (immediate) |
| **Git integration** (connect repo, branch, commit, PR, override-live) | MISSING ❌ | none |
| Workspace overview / Knowledge center / Home cards | MISSING ❌ | none |

### Data hub

| Capability (Azure) | Loom | Backend per control |
| --- | --- | --- |
| **Workspace** tab: SQL database tree (dedicated + serverless DBs → schemas → tables/views/stored procs/external tables) | partial ⚠️ — Dedicated editor left tree lists schemas→tables (with row counts); Serverless lists databases + lake roots. No views/SP/external-table/function nodes; no per-object expand | TDS `executeQuery` (schema introspection) |
| **Linked** tab: linked storage accounts → ADLS containers → folder/file browser | MISSING ❌ — no lake/file browser; serverless tree shows static bronze/silver/gold/landing labels only | none |
| **Datasets** (integration datasets) listing | built ✅ — in the Workspace Resources navigator (count + create + delete) | `/api/synapse/datasets` → dev plane |
| Right-click table → New SQL script (Select TOP 100 / CREATE / DROP / DROP+CREATE) | partial ⚠️ — clicking a table inserts `SELECT TOP 100`; no CREATE/DROP/DROP+CREATE context menu | TDS |
| Right-click → New notebook (load to DataFrame) | MISSING ❌ | none |
| Right-click file/folder → New SQL script / notebook / dataset / data flow | MISSING ❌ | none |
| Database designer (Lake database, create/edit tables, ER model) | MISSING ❌ | none |

### Develop hub

| Capability (Azure) | Loom | Backend per control |
| --- | --- | --- |
| **SQL scripts** list (+ New / Import / rename / delete / folders) | partial ⚠️ — navigator lists + creates (empty serverless script) + deletes; no Import, no rename, no folders | `/api/synapse/sqlscripts` → dev plane PUT/DELETE |
| SQL script authoring surface: connect-to pool dropdown, Use-database, Run, IntelliSense | partial ⚠️ — the SQL editors (dedicated/serverless) provide Monaco T-SQL + Run + DB picker, but are bound to the env pool, not the artifact's saved `currentConnection`; no IntelliSense | TDS `executeQuery` |
| Run results: table grid, row count, exec time | built ✅ — results grid + row badge + ms + 5,000-row truncation badge | TDS |
| Results → **Export** (CSV/Excel/JSON/XML) | MISSING ❌ | none |
| Results → **Chart** view (chart type, category column, save-as-image) | MISSING ❌ | none |
| **Notebooks** list (+ New / Import IPYNB / clone / delete) | partial ⚠️ — navigator lists + creates (empty PySpark) + deletes; no Import/clone | `/api/synapse/notebooks` → dev plane PUT/DELETE |
| Notebook authoring: cells, %% magics (pyspark/spark/sql/csharp/sparkr), attach pool, Run/Run all, variable explorer, charts, markdown toolbar, snippets, undo/redo | MISSING ❌ — there is no Synapse notebook editor; the `notebook` registry key maps to the Fabric notebook editor, NOT a Synapse-pool notebook. Spark code is authored as a "batch job" textbox only | n/a |
| **Data flows** list (+ New / delete) | partial ⚠️ — navigator lists + creates (empty MappingDataFlow) + deletes | `/api/synapse/dataflows` → dev plane |
| Data flow **visual designer** (source/transform/sink canvas, data preview, debug, expression builder) | MISSING ❌ — only an empty-JSON create; UI Caption explicitly says "full visual data-flow designer is a follow-up" | none |
| **KQL scripts** (Data Explorer) | gate ⚠️ — explicit "Not yet wired" row in navigator naming the missing kqlScripts data plane | none |
| **Apache Spark job definitions** (+ create/edit/submit JAR/.py) | gate ⚠️ — explicit "Not yet wired" navigator row; pool editor's "Submit batch job" form partially overlaps (Livy batch) but no saved job-definition artifact | partial: Livy `submit` works, no artifact CRUD |
| Browse gallery / templates | MISSING ❌ | none |

### Integrate hub (pipelines)

| Capability (Azure) | Loom | Backend per control |
| --- | --- | --- |
| **Pipelines** list (+ New / clone / delete / folders) | partial ⚠️ — navigator lists + creates + deletes; no clone/folders | `/api/synapse/pipelines` → dev plane |
| Pipeline **canvas designer** (activity palette, drag-drop, connections, properties) | partial ⚠️ — delegated to `PipelineEditorCore` (React Flow canvas, palette: Copy/Notebook/Stored proc/Mapping data flow) — fewer activity types than the ~30+ Azure offers | dev plane upsert |
| **Debug** run | built ✅ — `/api/items/synapse-pipeline/[id]/debug` → `isDebugRun=true` createRun | dev plane |
| **Add trigger** (trigger now / new+edit trigger) | partial ⚠️ — triggers CRUD + start/stop in navigator and per-pipeline route; "trigger now" via run | dev plane triggers + createRun |
| **Triggers** (Schedule/Tumbling/Storage event/Custom event) list + start/stop | partial ⚠️ — navigator lists + creates daily ScheduleTrigger only + start/stop/delete; no tumbling/event trigger authoring UI | `/api/synapse/triggers` → dev plane start/stop |
| **Validate all** | MISSING ❌ — config sets `supportsValidate: false` | none |
| Copy Data tool (wizard) | MISSING ❌ | none |
| Browse gallery (pipeline templates) | MISSING ❌ | none |

### Monitor hub

| Capability (Azure) | Loom | Backend per control |
| --- | --- | --- |
| **Pipeline runs** / **Trigger runs** (filter, drill to activity runs, rerun, cancel, Gantt) | partial ⚠️ — pipeline editor has `/runs` (queryPipelineRuns, 7-day window); no trigger-run grid, no activity-level drill, no rerun/cancel from a Monitor grid | dev plane queryPipelineRuns |
| **Apache Spark applications** (running/history, vCores, drill, Spark history server link) | partial ⚠️ — Spark pool editor "Recent batches" tab lists Livy batches (id/name/state/result/app/submitter); no app-level drill, no Spark history server link | Livy `listSparkBatchJobs` |
| **SQL requests** (per-pool, full request text) | partial ⚠️ — surfaced only as DMV T-SQL templates (`sys.dm_pdw_exec_requests`) loaded into the editor; no dedicated Monitor grid | TDS |
| **KQL requests** | MISSING ❌ | none |
| **Integration runtimes** monitor | MISSING ❌ | none |
| **SQL pools** / **Apache Spark pools** monitor lists (status) | partial ⚠️ — read-only status badges in the navigator pools groups | ARM list |

### Manage hub

| Capability (Azure) | Loom | Backend per control |
| --- | --- | --- |
| **SQL pools**: create / pause / resume / scale (DWU) / delete / geo-backup / restore points | partial ⚠️ — Dedicated editor: pause ✅ + resume ✅ + state poll ✅ (ARM); scale (`updateDedicatedPoolSku`) exists in client + admin-scaling editor but NOT exposed on this editor's ribbon; create/delete NOT here (navigator marks "authoring lives in scaling editor"); geo-backup/permissions/workload-mgmt are DMV T-SQL templates, not managed UI | ARM pause/resume/state + TDS DMVs |
| **Apache Spark pools**: create / scale (fixed+autoscale) / auto-pause / delete / packages / Spark config / version | partial ⚠️ — Spark editor: Scale dialog ✅ (fixed+autoscale, ARM PATCH), Auto-pause dialog ✅ (ARM PATCH), Force-pause ✅. No create/delete; **Packages**/**Spark configurations** MISSING; config tab is read-only ("v2.2 wires inline PUT") | ARM PATCH (`scaleSparkPool`, `setSparkPoolAutoPause`) |
| **Linked services** (+ New from connector gallery / test connection / edit / delete) | partial ⚠️ — navigator lists + deletes; create requires raw `properties` (no connector-gallery wizard, no Test connection) | `/api/synapse/linkedservices` → dev plane |
| **Integration runtimes** (Auto-resolve / Azure / Self-hosted / SSIS — create/edit/status) | MISSING ❌ | none |
| **Managed private endpoints** | MISSING ❌ | none |
| **Triggers** management | partial ⚠️ — see Integrate | dev plane |
| **Access control** (Synapse RBAC role assignments) | MISSING ❌ | none |
| **Credentials** / **Managed identities** | MISSING ❌ | none |
| **Workspace packages** (workspace-level jars/wheels) | MISSING ❌ | none |
| **Git configuration** | MISSING ❌ | none |
| **Workspace settings** (properties, encryption, networking) | MISSING ❌ | none |

### Portal-blade lifecycle (Microsoft.Synapse/workspaces)

| Capability (Azure) | Loom | Backend per control |
| --- | --- | --- |
| Create / delete the Synapse **workspace** | MISSING ❌ — workspace is env-pinned, single deployment-default | n/a |
| Workspace firewall / private endpoint / Microsoft Entra admin config | MISSING ❌ | none |
| Diagnostic settings / Metrics / Alerts / Activity log | MISSING ❌ | none |

---

## Honest summary

**Backend is genuinely real** across everything that is wired — ARM REST, Synapse dev-plane
REST (api-version 2020-12-01), Livy, and TDS via `mssql`, with a correct ChainedToken
credential and an honest 503 infra-gate. Both env vars are bicep-synced. This is not
vaporware: the SQL pools execute T-SQL, the Spark pool scales/pauses for real, pipelines
debug for real, and the navigator's CRUD hits the live workspace.

**But it is NOT 1:1 with Synapse Studio.** The single biggest gaps:

1. **No unified Synapse Studio shell** — no Home/Data/Develop/Integrate/Monitor/Manage hub
   layout, no Publish/Discard live-mode workflow, no Git. Loom fragments Synapse into 4
   disconnected catalog-item editors.
2. **No Synapse notebook editor at all** — the marquee Synapse Develop experience (cells,
   %% magics, attach-pool, Run-all, charts, variable explorer) is absent. Spark is reduced
   to a single "batch job" textbox.
3. **No data-flow visual designer**, **no Data-hub lake/file browser**, **no SQL results
   export/chart**, **no Monitor hub grids** (only DMV templates + a batches table), and
   most **Manage-hub** surfaces (integration runtimes, access control, packages, linked-
   service connector gallery + Test connection) are missing.
4. SQL editors are **bound to the env pool**, not the artifact's saved connection; several
   ribbon actions load DMV T-SQL templates rather than rendering managed UI.

Net: solid functional plumbing for SQL pools, Spark pools, pipelines, and a real
Workspace-Resources navigator (≈ ADF Factory Resources parity), but well short of
Synapse Studio feature completeness.
