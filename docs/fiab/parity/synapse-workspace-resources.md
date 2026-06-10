# synapse-workspace-resources — parity with Azure Synapse Studio (workspace artifacts navigator)

Source UI: Azure Synapse Studio (`https://web.azuresynapse.net`) → the
**Develop / Integrate / Data / Manage** hubs, collapsed into one typed
"Workspace Resources" navigator in the Loom Synapse pipeline editor's left
pane. This is the Synapse equivalent of the ADF Studio Factory Resources pane
(`docs/fiab/parity/adf-factory-resources.md`). Grounded in Microsoft Learn:

- Synapse terminology (workspace, linked services, SQL/Spark pools, SQL scripts,
  notebooks, Spark job definitions): https://learn.microsoft.com/azure/synapse-analytics/overview-terminology
- Roles required for Synapse Studio tasks (view/edit/publish artifacts):
  https://learn.microsoft.com/azure/synapse-analytics/security/synapse-workspace-understand-what-role-you-need
- Synapse RBAC roles (Synapse Artifact Publisher / Administrator — the write/delete actions per artifact type):
  https://learn.microsoft.com/azure/synapse-analytics/security/synapse-workspace-synapse-rbac-roles
- Synapse Artifacts client (the data-plane artifact collections: pipelines,
  datasets, data flows, notebooks, Spark job definitions, SQL scripts, linked
  services, triggers): https://learn.microsoft.com/dotnet/api/overview/azure/analytics.synapse.artifacts-readme
- Integrate with pipelines (Integrate hub, Add trigger, Trigger now):
  https://learn.microsoft.com/azure/synapse-analytics/get-started-pipelines
- Synapse notebooks (Develop hub → Notebooks): https://learn.microsoft.com/azure/synapse-analytics/spark/apache-spark-development-using-notebooks
- Datasets & linked services (Synapse Studio): https://learn.microsoft.com/azure/data-factory/concepts-datasets-linked-services

Data-plane host: **`https://<workspace>.dev.azuresynapse.net`**, api-version
**2020-12-01** (artifacts). Token scope: **`https://dev.azuresynapse.net/.default`**.
Spark/SQL pools come from ARM (`Microsoft.Synapse/workspaces/{ws}/bigDataPools |
sqlPools`, api-version 2021-06-01), scope `https://management.azure.com/.default`.

## Azure / Synapse Studio feature inventory

The Synapse Studio workspace surface is a set of hubs, each a typed navigator
over a workspace artifact collection. For each artifact type Studio exposes a
**list with count**, a **＋ New** affordance, a **filter** box, and per-item
**open / delete / (lifecycle)** actions:

| # | Studio hub / object | Capabilities in Synapse Studio |
|---|---------------------|--------------------------------|
| 1 | **Integrate → Pipelines** | list w/ count, New (opens blank canvas), open (designer), delete, debug/trigger now |
| 2 | **Data → Integration datasets** | list w/ count, New (connector + format + linked-service wizard), open, delete |
| 3 | **Develop → Data flows** | list w/ count, New (Mapping Data Flow visual designer), open, delete |
| 4 | **Develop → Notebooks** | list w/ count, New / Import IPYNB, open, attach pool, run, delete |
| 5 | **Develop → SQL scripts** | list w/ count, New, open, run on pool, delete |
| 6 | **Develop → KQL scripts** | list w/ count, New, open, run on Data Explorer pool, delete |
| 7 | **Develop → Spark job definitions** | list w/ count, New, open, submit, delete |
| 8 | **Integrate / Manage → Triggers** | list w/ count, New, open, start/stop, delete |
| 9 | **Manage → Linked services** | list w/ count, New, edit, delete, test connection |
| 10 | **Manage → Integration runtimes** | list w/ count, New (Azure/SelfHosted), status, delete |
| 11 | **Manage → Apache Spark pools** | list, New, configure, scale, auto-pause, delete |
| 12 | **Manage → SQL pools (dedicated)** | list, New, scale (DWU), pause/resume, delete |
| — | Top toolbar | **Add new resource** menu, **Filter resources by name** |

## Loom coverage

Built ✅ / honest-gate ⚠️ / MISSING ❌. Surface:
`apps/fiab-console/lib/components/pipeline/synapse-workspace-tree.tsx`, wired
into the Synapse pipeline editor left pane
(`lib/editors/pipeline-editor-core.tsx`, Synapse branch `!isAdf`). Selecting a
pipeline binds + opens it on the existing React Flow canvas (existing bind flow).

| Capability | Status | Notes |
|------------|--------|-------|
| Workspace Resources typed navigator (groups + counts) | ✅ | Fluent `Tree`, one branch per type, live count from real list |
| Filter resources by name | ✅ | top `Input` filters every group client-side |
| Add new resource menu (top) | ✅ | Fluent `Menu` → Pipeline / Data flow / Notebook / SQL script / KQL script / Spark job definition / Dataset / Trigger |
| ＋ New per group | ✅ | per-group `Add` button on the group header (creatable types) |
| **Pipelines** — list / count | ✅ | `GET /api/synapse/pipelines` |
| **Pipelines** — New (creates empty + opens on canvas) | ✅ | `POST /api/synapse/pipelines`; on success binds + opens the React Flow designer |
| **Pipelines** — open / bind | ✅ | click row → `bindTo(name)` → canvas |
| **Pipelines** — delete | ✅ | `DELETE /api/synapse/pipelines?name=` |
| **Datasets** — list / count / create / delete | ✅ | `GET/POST/DELETE /api/synapse/datasets`; create dialog (type + linked service) |
| **Data flows** — list / count | ✅ | `GET /api/synapse/dataflows` |
| **Data flows** — New (empty MappingDataFlow) | ✅ | `POST /api/synapse/dataflows` creates a valid empty Mapping Data Flow |
| **Data flows** — delete | ✅ | `DELETE /api/synapse/dataflows?name=` |
| **Data flows** — visual sources/sinks/transformations designer | ⚠️ | empty data flow created via real REST; the *visual* Spark-backed designer is a follow-up (honest note in create dialog) |
| **Notebooks** — list / count / create / delete | ✅ | `GET/POST/DELETE /api/synapse/notebooks`; New creates an empty PySpark notebook (nbformat 4) |
| **Notebooks** — cell authoring / attach pool / run | ⚠️ | artifact create/delete is real; rich cell editor + Livy run lives in the dedicated Notebook editor (`/api/items/notebook/*`), not in this navigator |
| **SQL scripts** — list / count / create / delete | ✅ | `GET/POST/DELETE /api/synapse/sqlscripts`; New creates an empty serverless-targeted script |
| **SQL scripts** — run on pool / results grid | ⚠️ | artifact create/delete is real; query execution + grid lives in the dedicated serverless/dedicated SQL editors (TDS via `synapse-sql-client`), not in this navigator |
| **Triggers** — list / count / start / stop / delete | ✅ | `GET/POST/DELETE /api/synapse/triggers` (workspace-wide); inline Start/Stop badges |
| **Triggers** — New (daily Schedule, Stopped) | ✅ | `POST /api/synapse/triggers`; wire to a pipeline from that pipeline's Triggers panel |
| **Linked services** — list / count / create / delete | ✅ | `GET/POST/DELETE /api/synapse/linkedservices` |
| **Linked services** — test connection | ⚠️ | list/create/delete is real; "test connection" (CreateLinkedServiceConnectionStatus) not wired |
| **Spark pools** — list (read-only) | ✅ | `GET /api/synapse/pools` → ARM `bigDataPools`; node size / Spark version / state shown |
| **SQL pools (dedicated)** — list (read-only) | ✅ | `GET /api/synapse/pools` → ARM `sqlPools`; SKU + status shown |
| **Spark / SQL pool authoring (create / scale / pause / resume)** | ⚠️ | listed read-only here; authoring lives in the dedicated Synapse scaling editors (`/api/admin/scaling/*`) — honest gate row |
| **KQL scripts** — list / count / create / delete | ✅ | `GET/POST/DELETE /api/synapse/kqlscripts`; New creates an empty KQL script |
| **KQL scripts** — open (Connect to pool + Use database + query) | ✅ | `SynapseKqlEditor` drawer; pools from ARM `kustoPools`, databases from the pool, query persisted via `PUT /api/synapse/kqlscripts/[name]` |
| **KQL scripts** — Run on Data Explorer pool + results grid | ✅ | `POST /api/synapse/kqlscripts/[name]/run` → Synapse Kusto pool v1 query (`<pool>.<ws>.kusto.azuresynapse.net`); honest gate when no pool assigned |
| **Spark job definitions** — list / count / create / delete | ✅ | `GET/POST/DELETE /api/synapse/sparkjobdefinitions`; New targets a chosen Spark pool |
| **Spark job definitions** — open (Definition + Spark compute + Runs) | ✅ | `SynapseSparkEditor` drawer; language/file/class/args + driver/executor sizing persisted via `PUT /api/synapse/sparkjobdefinitions/[name]` |
| **Spark job definitions** — Submit (Livy batch) + Runs history | ✅ | `POST/GET /api/synapse/sparkjobdefinitions/[name]/run` → Synapse Livy batch on the target Spark pool; honest gate when no pool/file |
| **Integration runtimes** | ⚠️ | not surfaced in this navigator (Synapse uses the AutoResolve Azure IR by default; SHIR management is a follow-up) |
| Honest infra-gate when workspace unreachable | ✅ | when the routes 503 `not_configured`, the whole navigator shows one `MessageBar` naming `LOOM_SYNAPSE_WORKSPACE` + the Synapse Artifact Publisher / Synapse Administrator role |

Zero ❌. Every un-built Studio group is rendered as an honest ⚠️ "coming" row
(tooltip names the exact artifact collection / REST gap) or routed to its
existing dedicated editor — never a fake list.

## Backend per control

Every count and action hits real Synapse REST. Artifact collections go through
the Synapse data plane (`<ws>.dev.azuresynapse.net`, api-version 2020-12-01) via
`lib/azure/synapse-artifacts-client.ts` + the existing `synapse-dev-client.ts`
(pipelines/triggers). Pools go through ARM via `synapse-dev-client.ts`. Auth:
`ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID),
DefaultAzureCredential)`, data-plane scope `https://dev.azuresynapse.net/.default`.
Workspace is the env-pinned default (`LOOM_SYNAPSE_WORKSPACE`).

| Control | BFF route | client fn | data-plane / ARM endpoint |
|---------|-----------|-----------|---------------------------|
| Pipelines list/create/delete | `/api/synapse/pipelines` | `listPipelines` / `upsertPipeline` / `deletePipeline` (synapse-dev-client) | `<ws>.dev/pipelines[/{name}]` |
| Datasets list/create/delete | `/api/synapse/datasets` | `listDatasets` / `upsertDataset` / `deleteDataset` | `<ws>.dev/datasets[/{name}]` |
| Data flows list/create/delete | `/api/synapse/dataflows` | `listDataFlows` / `upsertDataFlow` / `deleteDataFlow` | `<ws>.dev/dataflows[/{name}]` |
| Notebooks list/create/delete | `/api/synapse/notebooks` | `listNotebooks` / `upsertNotebook` / `deleteNotebook` | `<ws>.dev/notebooks[/{name}]` |
| SQL scripts list/create/delete | `/api/synapse/sqlscripts` | `listSqlScripts` / `upsertSqlScript` / `deleteSqlScript` | `<ws>.dev/sqlScripts[/{name}]` |
| Triggers list/create/lifecycle/delete | `/api/synapse/triggers` | `listTriggers` / `upsertTrigger` / `startTrigger` / `stopTrigger` / `deleteTrigger` | `<ws>.dev/triggers[/{name}][/start|/stop]` |
| Linked services list/create/delete | `/api/synapse/linkedservices` | `listLinkedServices` / `upsertLinkedService` / `deleteLinkedService` | `<ws>.dev/linkedservices[/{name}]` |
| Spark / SQL pools (read-only) | `/api/synapse/pools` | `listSparkPools` / `listDedicatedSqlPools` | ARM `…/bigDataPools`, `…/sqlPools` |
| KQL scripts list/create/delete | `/api/synapse/kqlscripts` | `listKqlScripts` / `upsertKqlScript` / `deleteKqlScript` | `<ws>.dev/kqlScripts[/{name}]` |
| KQL script load + pools/databases | `/api/synapse/kqlscripts/[name]` | `getKqlScript` + `listKustoPools` / `listKustoPoolDatabases` | `<ws>.dev/kqlScripts/{name}` + ARM `…/kustoPools[/{pool}/databases]` |
| KQL script Run | `/api/synapse/kqlscripts/[name]/run` | `runKqlOnPool` | `<pool>.<ws>.kusto.azuresynapse.net/v1/rest/query` |
| Spark job defs list/create/delete | `/api/synapse/sparkjobdefinitions` | `listSparkJobDefinitions` / `upsertSparkJobDefinition` / `deleteSparkJobDefinition` | `<ws>.dev/sparkJobDefinitions[/{name}]` (PUT = 202 LRO) |
| Spark job def load + pools | `/api/synapse/sparkjobdefinitions/[name]` | `getSparkJobDefinition` + `listSparkPools` | `<ws>.dev/sparkJobDefinitions/{name}` + ARM `…/bigDataPools` |
| Spark job def Submit + Runs | `/api/synapse/sparkjobdefinitions/[name]/run` | `submitSparkBatchJob` / `listSparkBatchJobs` / `getSparkBatchJob` | `<ws>.dev/livyApi/.../sparkPools/{pool}/batches` |
| Pipeline open/bind | `/api/items/synapse-pipeline/[id]/bind` | `listPipelines` / `upsertPipeline` | (binding persisted to Cosmos item) |

## Deferred (explicit follow-ups, not half-built)

- **Mapping Data Flow visual designer** — Spark-backed source/transform/sink
  canvas with schema projection, expression builder, and data preview (the
  empty data flow is created via real REST today).
- **Notebook cell authoring / Livy run inside the navigator** — rich editor +
  Spark run already exist in the dedicated Notebook editor (`/api/items/notebook/*`).
- **SQL script execution / results grid inside the navigator** — TDS execution +
  grid already exist in the serverless/dedicated SQL editors (`synapse-sql-client`).
- **Linked-service "test connection"** (CreateLinkedServiceConnectionStatus).
- **Spark / dedicated-SQL-pool authoring** — create/scale/pause/resume; listed
  read-only here, authoring lives in the Synapse scaling editors.
- **Integration runtimes** management surface.

## Bicep / env sync

- New env var consumed: **`LOOM_SYNAPSE_WORKSPACE`** (already used by the
  Synapse SQL + scaling editors; no new bicep app-env entry needed).
- Role: the Loom UAMI needs the **Synapse Artifact Publisher** (write/delete) or
  **Synapse Administrator** Synapse-RBAC role on the workspace — the same role
  the existing `synapse-dev-client` already documents. This covers `kqlScripts`
  and `sparkJobDefinitions` artifact write/delete.
- **KQL-script Run** queries a Synapse Data Explorer (Kusto) pool's data plane
  (`<pool>.<ws>.kusto.azuresynapse.net`). For Run to succeed the UAMI needs the
  Kusto **AllDatabasesViewer** (or AllDatabasesAdmin) role on that pool. The
  pool itself is an optional feature of an existing workspace
  (`Microsoft.Synapse/workspaces/{ws}/kustoPools`) — no new bicep module is
  required, and the Run route honest-gates (`code:'no_pool'`) when no pool is
  assigned, so the surface is 100% functional without a Kusto pool present.
- **Spark-job-definition Submit** runs a Livy batch on the definition's target
  Spark Big Data pool — the same compute the Notebook + SJD-item editors already
  use; no new role beyond the existing Spark-pool access.
- Azure-native by default: no Fabric / Power BI dependency; works with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- No new Azure resource or Cosmos container.
- Sovereign-cloud aware: GCC-High / DoD use `<ws>.dev.azuresynapse.usgovcloudapi.net`
  (dev plane) and `<pool>.<ws>.kusto.azuresynapse.us` (Kusto pool data plane),
  resolved automatically from `detectLoomCloud()` in `synapse-artifacts-client.ts`.

## Verification

- `npx tsc --noEmit` → clean on every touched file (the only remaining
  diagnostics are the repo-wide makeStyles/griffel numeric-value backlog).
- `npx vitest run lib/editors/__tests__/synapse-kql-sjd-bff.test.ts` → 10/10
  green (route existence + realness + session/gate checks + client-shape units).
- The `/api/synapse/kqlscripts[/...]` (3) + `/api/synapse/sparkjobdefinitions[/...]`
  (3) routes register in the build route table alongside the existing eight.
- Per `no-vaporware.md`: every list/create/delete/run/submit call hits real
  Synapse dev-plane / ARM / Kusto / Livy REST; the honest infra-gate renders when
  `LOOM_SYNAPSE_WORKSPACE` is unset, and the Run/Submit buttons honest-gate when
  no pool/file is assigned. Live `pnpm uat` side-by-side against Synapse Studio:
  pending (no minted session in this worktree).
