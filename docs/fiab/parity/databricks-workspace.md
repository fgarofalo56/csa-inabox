# databricks-workspace — parity with Azure Databricks workspace (objects navigator)

Source UI: the Azure Databricks workspace (`https://adb-<id>.<n>.azuredatabricks.net`)
left sidebar — **Workspace / Jobs (Workflows) / Compute / SQL Warehouses /
Repos / Catalog** — collapsed into one typed "Workspace" navigator in the Loom
Databricks Job editor's left pane. This is the Databricks equivalent of the ADF
Studio Factory Resources pane (`docs/fiab/parity/adf-factory-resources.md`) and
the Synapse Workspace Resources pane
(`docs/fiab/parity/synapse-workspace-resources.md`). Grounded in Microsoft Learn:

- Databricks Jobs API 2.1 (list/create/delete/run-now):
  https://learn.microsoft.com/azure/databricks/api/workspace/jobs
- Workspace API 2.0 (notebooks/folders list/import/mkdirs/delete):
  https://learn.microsoft.com/azure/databricks/api/workspace/workspace
- Clusters API 2.0 (list/create/start/restart/delete + node-types + spark-versions):
  https://learn.microsoft.com/azure/databricks/api/workspace/clusters
- SQL Warehouses API 2.0 (list/create/start/stop/delete/edit):
  https://learn.microsoft.com/azure/databricks/api/workspace/warehouses
- Repos / Git folders API 2.0 (list/create/get/update/delete):
  https://learn.microsoft.com/azure/databricks/dev-tools/cli/reference/repos-commands
  + https://learn.microsoft.com/azure/databricks/repos/
- Unity Catalog API 2.1 (catalogs/schemas/tables):
  https://learn.microsoft.com/azure/databricks/api/workspace/catalogs

Data-plane host: **`https://<workspace-host>/api/...`** (the workspace URL).
Token scope: the Azure Databricks first-party resource id
**`2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default`**. Auth:
`ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID),
DefaultAzureCredential)` — the exact flow the existing Databricks editors
(`lib/azure/databricks-client.ts`) already use. The workspace host is the
env-pinned default `LOOM_DATABRICKS_HOSTNAME`.

## Azure / Databricks feature inventory

The Databricks workspace surface is a set of left-rail sections, each a typed
navigator over an object collection. For each object type the UI exposes a
**list with count**, a **＋ Create / New** affordance, a **search/filter** box,
and per-item **open / delete / (lifecycle)** actions:

| # | Databricks section / object | Capabilities in the Databricks UI |
|---|------------------------------|-----------------------------------|
| 1 | **Workflows → Jobs** | list w/ count, Create job, open (task graph), Run now, delete |
| 2 | **Workspace → Notebooks / files / folders** | browse tree, Create notebook / folder / file, import, open, delete |
| 3 | **Compute → All-purpose clusters** | list w/ count + state, Create compute, Start / Restart / Terminate, edit, delete |
| 4 | **SQL → SQL Warehouses** | list w/ count + state, Create, Start / Stop, edit (size/scaling), delete |
| 5 | **Repos → Git folders** | list w/ count, Add repo (clone remote), pull/checkout branch, delete |
| 6 | **Catalog → Unity Catalog** | browse catalogs → schemas → tables (metastore-governed) |
| 7 | **Workflows → DLT pipelines** | list, create, start, delete (Delta Live Tables) |
| 8 | **Machine Learning → Experiments / Models** | MLflow experiments + registered models |
| 9 | **SQL → Dashboards / Queries / Alerts** | Databricks SQL authoring objects |
| 10 | **Serving → Endpoints** | real-time model serving endpoints |
| — | Top toolbar | **＋ Add new** menu, **Filter resources by name** |

## Loom coverage

Built ✅ / honest-gate ⚠️ / MISSING ❌. Surface:
`apps/fiab-console/lib/components/databricks/databricks-workspace-tree.tsx`,
wired into the Databricks Job editor left pane
(`lib/editors/databricks-editors.tsx`, `DatabricksJobEditor`). Selecting a Job
opens it in that editor (existing `selectJob` flow); **New job** opens the
new-job form (Databricks jobs require ≥1 task, authored in the editor — never
blind-created with an invalid empty task graph).

| Capability | Status | Notes |
|------------|--------|-------|
| Workspace typed navigator (groups + counts) | ✅ | Fluent `Tree`, one branch per type, live count from real list |
| Filter resources by name | ✅ | top `Input` filters every group client-side |
| Add new menu (top) | ✅ | Fluent `Menu` → Job / Notebook / Cluster / SQL Warehouse / Repo |
| ＋ New per group | ✅ | per-group `Add` button on the group header |
| **Jobs** — list / count | ✅ | `GET /api/databricks/jobs` → `listJobs` (api 2.1) |
| **Jobs** — open | ✅ | click row → host `selectJob(job_id)` → full Job editor (tasks/schedule/runs) |
| **Jobs** — Run now | ✅ | `POST /api/databricks/jobs {jobId, action:'run'}` → `runJob` (`/jobs/run-now`) |
| **Jobs** — New (≥1 task) | ✅ | opens the editor's new-job form; `POST /api/databricks/jobs {name}` (`/jobs/create`) is available for callers that supply tasks |
| **Jobs** — delete | ✅ | `DELETE /api/databricks/jobs?jobId=` → `deleteJob` (`/jobs/delete`) |
| **Notebooks / files** — list / count | ✅ | `GET /api/databricks/notebooks?path=/Workspace` → `listWorkspace` (`/workspace/list`) |
| **Notebooks** — New (empty notebook) | ✅ | `POST /api/databricks/notebooks {name,language}` → `importNotebook` (`/workspace/import`, SOURCE) |
| **Folders** — New | ✅ | `POST /api/databricks/notebooks {mkdirs:true,path}` → `mkdirsWorkspace` (`/workspace/mkdirs`) |
| **Notebooks / folders** — delete | ✅ | `DELETE /api/databricks/notebooks?path=[&recursive=true]` → `deleteWorkspaceObject` (`/workspace/delete`) |
| **Notebooks** — cell authoring / run | ⚠️ | create/delete is real; rich cell editor + Command-Execution run lives in the dedicated Databricks Notebook editor, not in this navigator |
| **Clusters** — list / count / state | ✅ | `GET /api/databricks/clusters` → `listClusters` (`/clusters/list`) |
| **Clusters** — New (autoscaling) | ✅ | `POST /api/databricks/clusters {name}` → `createCluster`; default node type + latest LTS runtime resolved server-side |
| **Clusters** — Start / Restart | ✅ | `POST /api/databricks/clusters {clusterId, action}` → `startCluster` / `restartCluster` |
| **Clusters** — Terminate / delete | ✅ | `DELETE /api/databricks/clusters?clusterId=` → `terminateCluster` (`/clusters/delete`) |
| **Clusters** — full edit (node type, libraries, init scripts, events) | ⚠️ | quick-create + lifecycle here; full config + Libraries/Events tabs live in the dedicated Databricks Cluster editor |
| **SQL Warehouses** — list / count / state | ✅ | `GET /api/databricks/warehouses` → `listWarehouses` (`/sql/warehouses`) |
| **SQL Warehouses** — New (size picker) | ✅ | `POST /api/databricks/warehouses {name,cluster_size}` → `createWarehouse` |
| **SQL Warehouses** — Start / Stop | ✅ | `POST /api/databricks/warehouses {id, action}` → `startWarehouse` / `stopWarehouse` |
| **SQL Warehouses** — delete | ✅ | `DELETE /api/databricks/warehouses?id=` → `deleteWarehouse` |
| **Repos (Git folders)** — list / count | ✅ | `GET /api/databricks/repos` → `listRepos` (`/repos`, paginated) |
| **Repos** — Add (clone remote) | ✅ | `POST /api/databricks/repos {url,provider}` → `createRepo`; provider dropdown (gitHub/gitLab/azureDevOpsServices/…) |
| **Repos** — delete (unlink) | ✅ | `DELETE /api/databricks/repos?id=` → `deleteRepo` |
| **Repos** — branch checkout / pull | ⚠️ | list/create/delete is real; `update` (checkout branch/tag, pull) not surfaced in this navigator yet |
| **Unity Catalog** — catalogs list | ✅ | `GET /api/databricks/catalogs` → `listUcCatalogs` (`/unity-catalog/catalogs`) |
| **Unity Catalog** — schemas / tables drill-down | ⚠️ | route supports `?catalog=` → `listUcSchemas`; the full catalog→schema→table tree lives in the Mirrored Databricks editor (`listUcTables`) |
| **DLT pipelines** | ⚠️ | honest "coming" gate row — `/api/2.0/pipelines` not wired |
| **MLflow experiments & models** | ⚠️ | honest "coming" gate row — `/api/2.0/mlflow/*` not wired |
| **Dashboards / Queries / Alerts** | ⚠️ | honest "coming" gate row — `/api/2.0/lakeview`, `/api/2.0/sql/queries|alerts` not wired |
| **Model serving endpoints** | ⚠️ | honest "coming" gate row — `/api/2.0/serving-endpoints` not wired |
| Honest infra-gate when workspace unreachable | ✅ | when the routes 503 `not_configured`, the whole navigator shows one `MessageBar` naming `LOOM_DATABRICKS_HOSTNAME` + the workspace-admin / Contributor requirement |

Zero ❌. Every un-built Databricks section is rendered as an honest ⚠️ "coming"
row (tooltip names the exact REST gap) or routed to its existing dedicated
editor — never a fake list.

## Backend per control

Every count and action hits real Databricks REST through
`lib/azure/databricks-client.ts`. Auth:
`ChainedTokenCredential(ManagedIdentityCredential(LOOM_UAMI_CLIENT_ID),
DefaultAzureCredential)`, scope `2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default`;
host `https://${LOOM_DATABRICKS_HOSTNAME}`.

| Control | BFF route | client fn | Databricks endpoint |
|---------|-----------|-----------|---------------------|
| Jobs list | `/api/databricks/jobs` (GET) | `listJobs` | `GET /api/2.1/jobs/list` |
| Job create | `/api/databricks/jobs` (POST `{name}`) | `createJob` | `POST /api/2.1/jobs/create` |
| Job run-now | `/api/databricks/jobs` (POST `{jobId,action:'run'}`) | `runJob` | `POST /api/2.1/jobs/run-now` |
| Job delete | `/api/databricks/jobs` (DELETE `?jobId=`) | `deleteJob` | `POST /api/2.1/jobs/delete` |
| Workspace list | `/api/databricks/notebooks` (GET `?path=`) | `listWorkspace` | `GET /api/2.0/workspace/list` |
| Notebook import | `/api/databricks/notebooks` (POST `{name,language}`) | `importNotebook` | `POST /api/2.0/workspace/import` |
| Folder mkdirs | `/api/databricks/notebooks` (POST `{mkdirs,path}`) | `mkdirsWorkspace` | `POST /api/2.0/workspace/mkdirs` |
| Workspace delete | `/api/databricks/notebooks` (DELETE `?path=`) | `deleteWorkspaceObject` | `POST /api/2.0/workspace/delete` |
| Clusters list | `/api/databricks/clusters` (GET) | `listClusters` | `GET /api/2.0/clusters/list` |
| Cluster create | `/api/databricks/clusters` (POST `{name}`) | `createCluster` (+ `listNodeTypes`/`listSparkVersions`) | `POST /api/2.0/clusters/create` |
| Cluster start/restart | `/api/databricks/clusters` (POST `{clusterId,action}`) | `startCluster` / `restartCluster` | `POST /api/2.0/clusters/start|restart` |
| Cluster terminate/delete | `/api/databricks/clusters` (DELETE `?clusterId=`) | `terminateCluster` | `POST /api/2.0/clusters/delete` |
| Warehouses list | `/api/databricks/warehouses` (GET) | `listWarehouses` | `GET /api/2.0/sql/warehouses` |
| Warehouse create | `/api/databricks/warehouses` (POST `{name,cluster_size}`) | `createWarehouse` | `POST /api/2.0/sql/warehouses` |
| Warehouse start/stop | `/api/databricks/warehouses` (POST `{id,action}`) | `startWarehouse` / `stopWarehouse` | `POST /api/2.0/sql/warehouses/{id}/start|stop` |
| Warehouse delete | `/api/databricks/warehouses` (DELETE `?id=`) | `deleteWarehouse` | `DELETE /api/2.0/sql/warehouses/{id}` |
| Repos list | `/api/databricks/repos` (GET) | `listRepos` | `GET /api/2.0/repos` (paginated) |
| Repo create | `/api/databricks/repos` (POST `{url,provider}`) | `createRepo` | `POST /api/2.0/repos` |
| Repo delete | `/api/databricks/repos` (DELETE `?id=`) | `deleteRepo` | `DELETE /api/2.0/repos/{id}` |
| UC catalogs / schemas | `/api/databricks/catalogs` (GET `[?catalog=]`) | `listUcCatalogs` / `listUcSchemas` | `GET /api/2.1/unity-catalog/catalogs|schemas` |

## Deferred (explicit follow-ups, not half-built)

- **Notebook cell authoring / run inside the navigator** — rich editor +
  Command-Execution run already exist in the dedicated Databricks Notebook editor.
- **Full cluster config (node type / libraries / init scripts / events)** —
  lives in the dedicated Databricks Cluster editor; the navigator does
  quick-create + lifecycle.
- **Repo branch checkout / pull** (`PATCH /api/2.0/repos/{id}` `branch`/`tag`).
- **Unity Catalog schema→table drill-down inside the navigator** — full tree
  exists in the Mirrored Databricks editor (`listUcTables`).
- **DLT pipelines** (`/api/2.0/pipelines`) — Delta Live Tables list/create/start.
- **MLflow experiments & registered models** (`/api/2.0/mlflow/*`).
- **Databricks SQL dashboards / queries / alerts** (`/api/2.0/lakeview`,
  `/api/2.0/sql/queries|alerts`).
- **Model serving endpoints** (`/api/2.0/serving-endpoints`).

## Bicep / env sync

- Env var consumed: **`LOOM_DATABRICKS_HOSTNAME`** (already consumed by the
  existing Databricks SQL Warehouse / Notebook / Job / Cluster editors and the
  `/api/databricks/workspace` gate route — no new bicep app-env entry needed).
- Role: the Loom UAMI must be a **workspace user/admin** (granted via the SCIM
  bootstrap) and hold **Contributor** on the workspace resource — the same
  requirement the existing `databricks-client` already documents. Provisioned by
  `platform/fiab/bicep/modules/landing-zone/databricks*.bicep`.
- No new Azure resource or Cosmos container.

## Verification

- `cd apps/fiab-console && pnpm build` → exit 0 (only a pre-existing
  third-party `@protobufjs/inquire` critical-dependency warning, unrelated).
- The six `/api/databricks/{jobs,notebooks,clusters,warehouses,repos,catalogs}`
  routes register in the build route table.
- Per `no-vaporware.md`: every list/create/delete/lifecycle call hits real
  Databricks REST; the honest infra-gate renders when `LOOM_DATABRICKS_HOSTNAME`
  is unset. Live `pnpm uat` side-by-side against the Databricks workspace UI:
  pending (no minted session / reachable workspace in this worktree).
